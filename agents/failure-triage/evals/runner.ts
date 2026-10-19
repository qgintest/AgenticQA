import fs from 'node:fs';
import path from 'node:path';
import type { ModelClient } from '../src/agent';
import { loadConfig, type TriageConfig } from '../src/config';
import { renderMarkdown } from '../src/render';
import { triage } from '../src/triage';
import { HeuristicBaselineModel } from './fake-model';
import { renderSummary, type RunInfo } from './markdown';
import { priceFor, spendPlan, type Price, type SpendPlan } from './pricing';
import type { Scenario } from './scenario';
import { scoreTrial, summarize, type EvalSummary, type TrialScore } from './score';

export interface EvalOptions {
  scenarios: Scenario[];
  repeat: number;
  outDir: string;
  dryRun: boolean;
  concurrency: number;
  env: NodeJS.ProcessEnv;
  priceOverride?: Partial<Price>;
  log?: (line: string) => void;
  now?: () => number;
}

export interface EvalResult {
  summary: EvalSummary;
  trials: TrialScore[];
  markdown: string;
  plan: SpendPlan;
  aborted: string | null;
}

/** Triage config for one trial: the agent's normal config, with every path pointed into the scenario. */
export function scenarioConfig(scenario: Scenario, env: NodeJS.ProcessEnv, outDir: string): TriageConfig {
  // No CI context: the report must not link to whatever workflow happens to run the eval.
  const { GITHUB_SERVER_URL: _s, GITHUB_REPOSITORY: _r, GITHUB_RUN_ID: _i, ...rest } = env;
  return loadConfig(rest, { reports: scenario.reportsDir, testResults: scenario.testResultsDir, out: outDir });
}

export function planFor(options: Pick<EvalOptions, 'scenarios' | 'repeat' | 'env' | 'dryRun' | 'priceOverride'>): { plan: SpendPlan; model: string; effort: string; price: Price } {
  const config = loadConfig(options.env, {});
  const model = options.dryRun ? 'fake-model' : config.model;
  const price = priceFor(model, options.priceOverride);
  return { plan: spendPlan(options.scenarios.length * options.repeat, config.limits, price), model, effort: config.effort, price };
}

/** Errors after which further trials would only fail the same way (and, with a real key, waste nothing but time). */
const FATAL = /authentication failed|permission denied|model or endpoint not found/;

export async function runEval(options: EvalOptions): Promise<EvalResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const { plan, model, effort, price } = planFor(options);
  const startedAt = new Date(now()).toISOString();
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.rmSync(path.join(options.outDir, 'trials'), { recursive: true, force: true });

  const jobs = options.scenarios.flatMap((scenario) => Array.from({ length: options.repeat }, (_, i) => ({ scenario, trial: i + 1 })));
  const trials: TrialScore[] = [];
  let aborted: string | null = null;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!aborted && next < jobs.length) {
      const { scenario, trial } = jobs[next++]!;
      const trialDir = path.join(options.outDir, 'trials', scenario.name, String(trial));
      fs.mkdirSync(trialDir, { recursive: true });
      const config = scenarioConfig(scenario, options.env, trialDir);
      const env = options.dryRun ? { ...options.env, ANTHROPIC_API_KEY: 'dry-run' } : options.env;
      const createClient = options.dryRun ? (): ModelClient => new HeuristicBaselineModel(scenario.failures, config.limits.maxFailures) : undefined;
      const started = now();
      const report = await triage(config, { env, createClient });
      const durationMs = now() - started;
      fs.writeFileSync(path.join(trialDir, 'triage-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      fs.writeFileSync(path.join(trialDir, 'triage-report.md'), renderMarkdown(report));
      const score = scoreTrial(scenario.name, scenario.expectation, trial, report, price, durationMs);
      trials.push(score);
      const answers = score.tests.map((t) => `${t.testId}=${t.classification}(${t.confidence.toFixed(2)})${t.correct ? '' : '✗'}`).join(' ');
      log(`eval: ${scenario.name} #${trial} mode=${report.mode} ${answers} ${(durationMs / 1000).toFixed(1)}s $${score.costUsd.toFixed(3)}`);
      if (!options.dryRun && report.mode !== 'agent' && FATAL.test(report.modeReason ?? '')) {
        aborted = `stopped after ${scenario.name} #${trial}: ${report.modeReason}`;
        log(`eval: ${aborted}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, jobs.length)) }, worker));

  trials.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.trial - b.trial);
  const summary = summarize(
    trials,
    options.scenarios.map((s) => ({ name: s.name, expectation: s.expectation })),
  );
  const info: RunInfo = { model, effort, dryRun: options.dryRun, repeat: options.repeat, startedAt, ceilingUsd: plan.ceilingUsd };
  let markdown = renderSummary(summary, trials, info);
  if (aborted) markdown += `\n> ⚠️ Eval ${aborted}\n`;

  fs.writeFileSync(
    path.join(options.outDir, 'results.json'),
    `${JSON.stringify({ schemaVersion: '1.0', run: { ...info, plan, aborted }, summary, trials }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(options.outDir, 'summary.md'), markdown);
  return { summary, trials, markdown, plan, aborted };
}
