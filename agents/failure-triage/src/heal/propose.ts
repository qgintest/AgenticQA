import fs from 'node:fs';
import path from 'node:path';
import { AnthropicModelClient, type ModelClient } from '../agent';
import { loadLimits, type Limits, type TriageConfig } from '../config';
import { readDomSnapshot, type DomIndex } from '../dom';
import { EvidenceStore } from '../evidence';
import { runToolLoop } from '../loop';
import { parseResults, type FailedTest } from '../playwright-results';
import { PRICES, priceFor } from '../pricing';
import { Redactor, sensitiveValuesFromEnv } from '../redact';
import type { TriageReport } from '../report';
import { ArtifactSandbox } from '../sandbox';
import { findTrace, ToolRunner } from '../tools';
import { evaluateGate, type HealEnvironment, type HealPlan } from './gate';
import { HEAL_BUDGET_NUDGE, HEAL_NO_SUBMIT_NUDGE, HEAL_SYSTEM_PROMPT, healInitialMessage } from './prompts';
import { checkProposal, parseRefusal, PROPOSE_TOOL, REFUSE_TOOL, type CheckedProposal, type Check, type Refusal } from './proposal';
import { RepoSandbox } from './repo';
import { HEAL_SCHEMA_VERSION, type HealResult } from './result';
import { HealToolRunner } from './tools';

export interface HealConfig {
  model: string;
  effort: TriageConfig['effort'];
  refusalFallbacks: boolean;
  limits: Limits;
  costCapUsd: number;
  paths: { repoRoot: string; reportsDir: string; testResultsDir: string; triageReport: string; outDir: string };
  env: HealEnvironment;
  runUrl: string | null;
  commit: string | null;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, ceiling: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, ceiling) : fallback;
}

/** Self-heal limits: the triage defaults, tightened, with their own env overrides (clamped). */
export function loadHealConfig(env: NodeJS.ProcessEnv, args: Partial<Record<'repoRoot' | 'reports' | 'testResults' | 'triage' | 'out', string>>, cwd = process.cwd()): HealConfig {
  const base = loadLimits({});
  const limits: Limits = {
    ...base,
    maxIterations: Math.floor(num(env, 'HEAL_MAX_ITERATIONS', 10, 20)),
    maxInputTokens: Math.floor(num(env, 'HEAL_MAX_INPUT_TOKENS', 400_000, 1_000_000)),
    maxOutputTokens: Math.floor(num(env, 'HEAL_MAX_OUTPUT_TOKENS', 40_000, 100_000)),
    timeoutMs: Math.floor(num(env, 'HEAL_TIMEOUT_MS', 5 * 60_000, 15 * 60_000)),
  };
  const repoRoot = path.resolve(cwd, args.repoRoot ?? '../..');
  const reportsDir = path.resolve(cwd, args.reports ?? path.join(repoRoot, 'automation/reports'));
  const effort = (env.HEAL_EFFORT ?? env.TRIAGE_EFFORT ?? 'high').toLowerCase();
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  return {
    model: env.HEAL_MODEL?.trim() || env.TRIAGE_MODEL?.trim() || 'claude-opus-5-5',
    effort: (EFFORTS as readonly string[]).includes(effort) ? (effort as TriageConfig['effort']) : 'high',
    refusalFallbacks: (env.TRIAGE_FALLBACKS ?? 'on').toLowerCase() !== 'off',
    limits,
    costCapUsd: num(env, 'HEAL_MAX_COST_USD', 2, 10),
    paths: {
      repoRoot,
      reportsDir,
      testResultsDir: path.resolve(cwd, args.testResults ?? path.join(repoRoot, 'automation/test-results')),
      triageReport: path.resolve(cwd, args.triage ?? path.join(reportsDir, 'triage', 'triage-report.json')),
      outDir: path.resolve(cwd, args.out ?? path.join(reportsDir, 'heal')),
    },
    env: {
      eventName: env.GITHUB_EVENT_NAME ?? null,
      repository: env.GITHUB_REPOSITORY ?? null,
      headRepository: env.HEAD_REPOSITORY || null,
      branch: env.HEAL_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
    },
    runUrl: server && repo && env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    commit: env.HEAL_HEAD_SHA || env.GITHUB_SHA || null,
  };
}

export function emptyResult(config: HealConfig): HealResult {
  return {
    schemaVersion: HEAL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: 'not_eligible',
    reason: '',
    notes: [],
    run: { url: config.runUrl, commit: config.commit, branch: config.env.branch, eventName: config.env.eventName },
    plan: null,
    proposal: null,
    refusal: null,
    checks: [],
    edit: null,
    target: null,
    evidence: [],
    agent: null,
    validation: null,
  };
}

function planSummary(plan: HealPlan): NonNullable<HealResult['plan']> {
  return {
    failingLocator: plan.failing.chain,
    failingTestId: plan.failing.testId,
    file: plan.location.file,
    line: plan.location.line,
    property: plan.location.property,
    scope: plan.scope,
    usage: plan.usage,
    tests: plan.tests.map((t) => ({ id: t.id, title: t.title, file: t.file, line: t.line })),
    deferred: plan.deferred,
  };
}

export interface HealDeps {
  env: NodeJS.ProcessEnv;
  createClient?: (apiKey: string, config: HealConfig) => ModelClient;
  now?: () => number;
}

/** Gate → (optional) agent → deterministic checks. Never throws for expected conditions. */
export async function proposeRepair(config: HealConfig, deps: HealDeps): Promise<HealResult> {
  const redactor = new Redactor(sensitiveValuesFromEnv(deps.env));
  const result = emptyResult(config);
  const done = (status: HealResult['status'], reason: string) => {
    result.status = status;
    result.reason = reason;
    return redactor.redactValue(result);
  };

  // The triage report normally lives under reports/triage; evals keep it next to their own output.
  const artifacts = new ArtifactSandbox(
    [config.paths.reportsDir, config.paths.testResultsDir, path.dirname(config.paths.triageReport)],
    config.limits,
    config.paths.testResultsDir,
  );
  let report: TriageReport;
  let parsed;
  try {
    if (!fs.existsSync(config.paths.triageReport)) return done('not_eligible', 'no triage report (triage did not run)');
    report = JSON.parse(artifacts.readText(config.paths.triageReport, 10 * 1024 * 1024)) as TriageReport;
    parsed = parseResults(artifacts.readText(path.join(config.paths.reportsDir, 'results.json'), 50 * 1024 * 1024));
  } catch (e) {
    return done('not_eligible', `could not read triage inputs: ${(e as Error).message}`);
  }

  const repo = new RepoSandbox(config.paths.repoRoot, (n) => artifacts.charge(n));
  const snapshots = new Map<string, DomIndex | null>();
  const snapshotFor = (t: FailedTest): DomIndex | null => {
    if (!snapshots.has(t.id)) {
      let index: DomIndex | null = null;
      try {
        const p = findTrace(t);
        if (p) index = readDomSnapshot(artifacts.readTrace(p), config.limits.maxZipEntryBytes, (n) => artifacts.charge(n));
      } catch {
        index = null;
      }
      snapshots.set(t.id, index);
    }
    return snapshots.get(t.id) ?? null;
  };

  const gate = evaluateGate(report, parsed, repo, config.env, (t) => snapshotFor(t) !== null);
  result.notes = gate.notes;
  if (!gate.eligible) return done('not_eligible', gate.reason);
  const plan = gate.plan;
  result.plan = planSummary(plan);
  for (const t of plan.tests) snapshotFor(t);

  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return done('not_eligible', 'ANTHROPIC_API_KEY is not set');

  const evidence = new EvidenceStore();
  const checkedCandidates = new Map<string, string>();
  const triageTools = new ToolRunner({
    parsed,
    tests: plan.tests,
    notAnalyzed: [],
    sandbox: artifacts,
    evidence,
    redactor,
    limits: config.limits,
    reportsDir: config.paths.reportsDir,
  });
  const verdicts = report.failures
    .filter((f) => plan.tests.some((t) => t.id === f.testId))
    .map((f) => ({ test_id: f.testId, classification: f.classification, confidence: f.confidence, rationale: f.rationale.slice(0, 600) }));
  const tools = new HealToolRunner({ plan, repo, triageTools, snapshots, evidence, checkedCandidates, redactor, limits: config.limits, triageVerdict: verdicts });

  let lastChecks: Check[] = [];
  const proposalCtx = { plan, snapshots: plan.tests.map((t) => ({ testId: t.id, index: snapshots.get(t.id) ?? null })), evidence, checkedCandidates };
  const client = deps.createClient ? deps.createClient(apiKey, config) : new AnthropicModelClient(config.model, config.effort, config.refusalFallbacks, apiKey);

  const loop = await runToolLoop<CheckedProposal | Refusal>({
    client,
    system: HEAL_SYSTEM_PROMPT,
    initialText: healInitialMessage(plan),
    tools: tools.definitions,
    execute: (name, input) => tools.run(name, input),
    terminals: [
      {
        name: PROPOSE_TOOL,
        accept: (input) => {
          const r = checkProposal(input, proposalCtx);
          lastChecks = r.ok ? r.value.checks : r.checks;
          return r.ok ? { ok: true, value: r.value, reply: 'Proposal accepted for validation.' } : { ok: false, errors: r.errors };
        },
      },
      { name: REFUSE_TOOL, accept: (input) => { const r = parseRefusal(input); return r.ok ? { ...r, reply: 'Refusal recorded.' } : r; } },
    ],
    limits: config.limits,
    effort: config.effort,
    redactor,
    bytesRead: () => artifacts.totalBytesRead,
    noSubmitNudge: HEAL_NO_SUBMIT_NUDGE,
    budgetNudge: HEAL_BUDGET_NUDGE,
    // Unknown model ids are capped at the most expensive known price, so the cap errs on the safe side.
    cost: { capUsd: config.costCapUsd, price: PRICES[client.model] ?? priceFor('claude-fable-5-1') },
    now: deps.now,
  });
  result.agent = loop.telemetry;
  result.checks = lastChecks;

  const cite = (items: Array<{ evidence_id: string; observation: string }>) =>
    items
      .map((e) => ({ e, rec: evidence.get(e.evidence_id) }))
      .filter((x) => x.rec)
      .map(({ e, rec }) => ({ evidenceId: rec!.id, source: rec!.source, observation: e.observation, excerpt: rec!.excerpt }));

  if (loop.terminal === PROPOSE_TOOL && loop.value && 'edit' in loop.value) {
    const v = loop.value;
    result.proposal = v.proposal;
    result.edit = v.edit;
    result.target = v.target;
    result.evidence = cite(v.proposal.evidence);
    return done('proposed', `replace ${v.edit.oldLocator} with ${v.edit.newLocator} at ${v.edit.file}:${v.edit.line}`);
  }
  if (loop.terminal === REFUSE_TOOL && loop.value && 'category' in loop.value) {
    result.refusal = loop.value;
    result.evidence = cite(loop.value.evidence);
    return done('refused', `${loop.value.category}: ${loop.value.reason}`);
  }
  if (lastChecks.some((c) => !c.passed)) return done('rejected', `proposal failed deterministic checks: ${lastChecks.filter((c) => !c.passed).map((c) => c.name).join(', ')}`);
  return done('error', `self-heal agent did not finish: ${loop.failure ?? 'unknown reason'}`);
}
