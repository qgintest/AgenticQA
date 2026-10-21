import fs from 'node:fs';
import path from 'node:path';
import type { ModelClient } from '../src/agent';
import type { Classification } from '../src/heuristics';
import { loadHealConfig, proposeRepair } from '../src/heal/propose';
import type { HealResult } from '../src/heal/result';
import { mdInline } from '../src/render';
import type { FailureTriage, TriageReport } from '../src/report';
import { HealBaselineModel } from './heal-baseline';
import { loadScenario } from './scenario';

export interface HealCase {
  name: string;
  purpose: string;
  scenario: string;
  verdict: Classification;
  expect: 'repair' | 'no_repair';
  file?: string;
  newTestId?: string;
}

export interface HealCaseScore {
  name: string;
  expect: HealCase['expect'];
  trial: number;
  status: HealResult['status'];
  correct: boolean;
  /** A repair was proposed where none should be (the critical error). */
  falseRepair: boolean;
  /** No (or a wrong) repair where one was expected. */
  missedRepair: boolean;
  reachedModel: boolean;
  /** The trial never evaluated the case (inputs unreadable): it counts as neither correct nor a refusal. */
  invalid: boolean;
  reason: string;
  costUsd: number;
}

export function loadHealCases(file: string): { source: string; cases: HealCase[] } {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { source: string; cases: HealCase[] };
  for (const c of raw.cases) {
    if (!c.name || !c.scenario || !['repair', 'no_repair'].includes(c.expect)) throw new Error(`invalid heal case: ${JSON.stringify(c)}`);
    if (c.expect === 'repair' && (!c.file || !c.newTestId)) throw new Error(`${c.name}: repair cases need file and newTestId`);
  }
  return raw;
}

/** The triage verdict the case hands to self-heal (agent mode, confidence 0.85, every failure). */
export function caseTriageReport(c: HealCase, scenarioDir: string): TriageReport {
  const s = loadScenario(scenarioDir);
  const failures: FailureTriage[] = s.failures.map((t) => ({
    testId: t.id,
    title: t.title,
    file: t.file,
    project: t.project,
    outcome: t.outcome,
    headline: '',
    classification: c.verdict,
    confidence: 0.85,
    confidenceLabel: 'high',
    source: 'agent',
    rationale: `eval verdict for ${c.name}`,
    evidence: [],
    recommendedActions: [],
    heuristic: { classification: 'unknown', confidence: 0, signals: [] },
    issues: [],
  }));
  return {
    schemaVersion: '1.0',
    generatedAt: '',
    mode: 'agent',
    modeReason: null,
    run: { url: null, commit: null, stats: null, projects: [], runErrors: [] },
    regressionStatus: 'failed',
    overall: { classification: c.verdict, summary: '' },
    failures,
    uncertainty: [],
    agent: null,
    notes: [],
  };
}

export function scoreHealCase(c: HealCase, trial: number, r: HealResult): HealCaseScore {
  const repaired = r.edit !== null && (r.status === 'proposed' || r.status === 'validated');
  const right = repaired && r.edit!.file === c.file && r.edit!.newLocator.includes(`'${c.newTestId}'`);
  // A refusal caused by the harness (unreadable inputs) says nothing about self-heal: never "correct".
  const invalid = r.status === 'not_eligible' && /^(could not read triage inputs|no triage report)/.test(r.reason);
  const correct = !invalid && (c.expect === 'repair' ? right : !repaired);
  return {
    name: c.name,
    expect: c.expect,
    trial,
    status: r.status,
    correct,
    falseRepair: c.expect === 'no_repair' && repaired,
    missedRepair: c.expect === 'repair' && !right,
    reachedModel: r.agent !== null,
    invalid,
    reason: r.reason.slice(0, 300),
    costUsd: r.agent?.costUsd ?? 0,
  };
}

export interface HealEvalOptions {
  evalsDir: string;
  outDir: string;
  repeat: number;
  only: string[];
  env: NodeJS.ProcessEnv;
  /** Defaults to the real Anthropic client (via proposeRepair). */
  createClient?: () => ModelClient;
  log?: (l: string) => void;
}

export async function runHealEval(o: HealEvalOptions): Promise<{ scores: HealCaseScore[]; markdown: string }> {
  const log = o.log ?? console.log;
  const { source, cases } = loadHealCases(path.join(o.evalsDir, 'heal-cases.json'));
  const selected = cases.filter((c) => !o.only.length || o.only.includes(c.name));
  const scores: HealCaseScore[] = [];
  // No CI context: results must not point at whatever workflow runs the eval.
  const { GITHUB_SERVER_URL: _a, GITHUB_REPOSITORY: _b, GITHUB_RUN_ID: _c, GITHUB_EVENT_NAME: _d, GITHUB_HEAD_REF: _e, GITHUB_REF_NAME: _f, ...env } = o.env;
  for (const c of selected) {
    const scenarioDir = path.join(o.evalsDir, 'scenarios', c.scenario);
    for (let trial = 1; trial <= o.repeat; trial++) {
      const out = path.join(o.outDir, 'heal', c.name, String(trial));
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      const triagePath = path.join(out, 'triage-report.json');
      fs.writeFileSync(triagePath, JSON.stringify(caseTriageReport(c, scenarioDir)));
      const config = loadHealConfig({ ...env, HEAL_BRANCH: 'eval' }, {
        repoRoot: path.join(o.evalsDir, source),
        reports: path.join(scenarioDir, 'reports'),
        testResults: path.join(scenarioDir, 'test-results'),
        triage: triagePath,
        out,
      });
      const result = await proposeRepair(config, { env, createClient: o.createClient ? () => o.createClient!() : undefined });
      fs.writeFileSync(path.join(out, 'heal-result.json'), JSON.stringify(result, null, 2));
      const s = scoreHealCase(c, trial, result);
      scores.push(s);
      log(`${s.invalid ? 'INVALID' : s.correct ? 'PASS' : 'FAIL'} ${c.name} #${trial}: ${s.status}${s.falseRepair ? ' (FALSE REPAIR)' : ''} — ${s.reason.slice(0, 140)}`);
    }
  }
  const markdown = renderHealEval(scores, selected);
  fs.mkdirSync(o.outDir, { recursive: true });
  fs.writeFileSync(path.join(o.outDir, 'heal-results.json'), JSON.stringify(scores, null, 2));
  fs.writeFileSync(path.join(o.outDir, 'heal-summary.md'), markdown);
  return { scores, markdown };
}

export function renderHealEval(scores: HealCaseScore[], cases: HealCase[]): string {
  const pos = scores.filter((s) => s.expect === 'repair');
  const neg = scores.filter((s) => s.expect === 'no_repair');
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : 'n/a');
  const out = [
    '## 🩹 Self-heal evaluation',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Correct repairs (positive cases) | ${pct(pos.filter((s) => s.correct).length, pos.length)} |`,
    `| Correct refusals (negative cases) | ${pct(neg.filter((s) => s.correct).length, neg.length)} |`,
    `| **False repairs** (repair proposed where none is allowed) | **${pct(neg.filter((s) => s.falseRepair).length, neg.length)}** |`,
    `| Invalid trials (harness could not evaluate) | ${scores.filter((s) => s.invalid).length} |`,
    `| Negative cases stopped before any model call | ${pct(neg.filter((s) => !s.reachedModel).length, neg.length)} |`,
    `| Estimated cost | $${scores.reduce((a, s) => a + s.costUsd, 0).toFixed(2)} |`,
    '',
    '| Case | Expect | Trial | Result | Status | Reason |',
    '|---|---|---|---|---|---|',
    ...scores.map((s) => `| ${mdInline(s.name)} | ${s.expect} | ${s.trial} | ${s.invalid ? '⚠️ invalid' : s.correct ? '✅' : s.falseRepair ? '❌ false repair' : '❌'} | ${s.status} | ${mdInline(s.reason, 160)} |`),
    '',
    '<sub>Validation (rerunning tests in a worktree) is not part of this replay; it needs a running AUT and is covered by the regression workflow.</sub>',
    '',
    ...cases.map((c) => `- **${mdInline(c.name)}**: ${mdInline(c.purpose, 200)}`),
    '',
  ];
  return out.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const yes = argv.includes('--yes');
  const repeat = Math.max(1, Math.min(10, Number(argv[argv.indexOf('--repeat') + 1]) || 1));
  const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : [];
  const evalsDir = path.resolve(__dirname, '..', '..', 'evals');
  const outDir = path.join(evalsDir, 'out');
  const { cases } = loadHealCases(path.join(evalsDir, 'heal-cases.json'));
  const config = loadHealConfig(process.env, {});
  const reaching = cases.filter((c) => (!only.length || only.includes(c.name)) && c.expect === 'repair').length;

  if (!dryRun) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required (or use --dry-run for the deterministic baseline)');
    const ceiling = reaching * repeat * config.costCapUsd;
    console.log(`Self-heal eval: ${cases.length} case(s) × ${repeat}; cases expected to reach the model: ${reaching}. Cost ceiling ≈ $${ceiling.toFixed(2)} (HEAL_MAX_COST_USD=${config.costCapUsd} each; negative cases normally stop at the gate).`);
    if (!yes) {
      console.log('Re-run with --yes to spend this.');
      return;
    }
  }
  const { scores, markdown } = await runHealEval({
    evalsDir,
    outDir,
    repeat,
    only,
    env: dryRun ? { ...process.env, ANTHROPIC_API_KEY: 'dry-run-no-api-calls' } : process.env,
    createClient: dryRun ? () => new HealBaselineModel() : undefined,
  });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  const falseRepairs = scores.filter((s) => s.falseRepair).length;
  console.log(`\n${scores.filter((s) => s.correct).length}/${scores.length} correct, ${falseRepairs} false repair(s). Results: ${outDir}`);
  if (falseRepairs || scores.some((s) => s.invalid)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
