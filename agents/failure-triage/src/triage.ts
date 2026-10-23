import fs from 'node:fs';
import { AnthropicModelClient, runAgent, type ModelClient } from './agent';
import type { TriageConfig } from './config';
import { EvidenceStore } from './evidence';
import { parseResults, ResultsFormatError, type ParsedResults } from './playwright-results';
import { Redactor, sensitiveValuesFromEnv } from './redact';
import {
  finalizeReport,
  groundedFailures,
  heuristicFailure,
  overallClassification,
  regressionStatus,
  REPORT_SCHEMA_VERSION,
  type FailureTriage,
  type TriageReport,
} from './report';
import { ArtifactSandbox, SandboxError } from './sandbox';

export interface TriageDeps {
  env: NodeJS.ProcessEnv;
  /** Override for tests; defaults to the real Anthropic client when an API key is present. */
  createClient?: (apiKey: string, config: TriageConfig) => ModelClient;
  now?: () => number;
}

function emptyReport(config: TriageConfig, env: NodeJS.ProcessEnv): TriageReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'no_results',
    modeReason: null,
    run: { url: config.runUrl, commit: env.GITHUB_SHA ?? null, stats: null, projects: [], runErrors: [] },
    regressionStatus: 'unknown',
    overall: { classification: 'unknown', summary: '' },
    failures: [],
    uncertainty: [],
    agent: null,
    notes: [],
  };
}

function heuristicSummary(failures: FailureTriage[]): string {
  const counts = failures.reduce<Record<string, number>>((m, f) => ((m[f.classification] = (m[f.classification] ?? 0) + 1), m), {});
  return `${failures.length} failure(s) triaged by deterministic rules: ${Object.entries(counts).map(([c, n]) => `${n} ${c}`).join(', ')}.`;
}

export async function triage(config: TriageConfig, deps: TriageDeps): Promise<TriageReport> {
  const { env } = deps;
  const redactor = new Redactor(sensitiveValuesFromEnv(env));
  const report = emptyReport(config, env);
  const sandbox = new ArtifactSandbox([config.paths.reportsDir, config.paths.testResultsDir], config.limits, config.paths.testResultsDir);

  // 1. Load results (missing or malformed results are reported, never thrown).
  let parsed: ParsedResults;
  try {
    if (!fs.existsSync(config.paths.resultsJson)) throw new SandboxError('results.json not found');
    parsed = parseResults(sandbox.readText(config.paths.resultsJson, 50 * 1024 * 1024));
  } catch (e) {
    if (e instanceof SandboxError || e instanceof ResultsFormatError) {
      report.modeReason = `${e.message}: the regression suite probably did not run to completion (check earlier workflow steps).`;
      return finalizeReport(report, redactor);
    }
    throw e;
  }

  report.run.stats = parsed.stats;
  report.run.projects = parsed.projects;
  report.run.runErrors = parsed.runErrors;
  report.regressionStatus = regressionStatus(parsed);

  if (parsed.failures.length === 0) {
    report.mode = 'no_failures';
    report.overall.summary = 'No failed or flaky tests.';
    return finalizeReport(report, redactor);
  }

  const tests = parsed.failures.slice(0, config.limits.maxFailures);
  const notAnalyzed = parsed.failures.slice(config.limits.maxFailures);
  if (notAnalyzed.length) {
    report.notes.push(`${notAnalyzed.length} additional failure(s) exceeded the analysis cap (${config.limits.maxFailures}) and were triaged heuristically.`);
  }

  // 2. Agent mode when credentials exist; otherwise (or on any agent failure) heuristic mode.
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  let agentFailures: FailureTriage[] | null = null;
  if (!apiKey) {
    report.modeReason = 'ANTHROPIC_API_KEY is not set (export it locally, or add it as a repository secret in CI, to enable the AI agent)';
  } else {
    const evidence = new EvidenceStore();
    const client = deps.createClient
      ? deps.createClient(apiKey, config)
      : new AnthropicModelClient(config.model, config.effort, config.refusalFallbacks, apiKey);
    const result = await runAgent(
      client,
      config,
      { parsed, tests, notAnalyzed, sandbox, evidence, redactor, limits: config.limits, reportsDir: config.paths.reportsDir },
      redactor,
      deps.now,
    );
    report.agent = result.telemetry;
    if (result.submission) {
      agentFailures = groundedFailures(result.submission, tests, evidence);
      report.overall.summary = result.submission.summary;
      report.uncertainty = result.submission.uncertainty;
    } else {
      report.modeReason = `AI agent did not complete: ${result.failure ?? 'unknown reason'}`;
    }
  }

  const failures = [...(agentFailures ?? tests.map((t) => heuristicFailure(t))), ...notAnalyzed.map((t) => heuristicFailure(t, 'Beyond the analysis cap; heuristic result.'))];
  report.mode = agentFailures ? 'agent' : 'heuristic';
  report.failures = failures;
  report.overall.classification = overallClassification(failures);
  if (!agentFailures) report.overall.summary = heuristicSummary(failures);
  return finalizeReport(report, redactor);
}
