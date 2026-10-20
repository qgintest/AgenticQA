import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest } from '../src/agent';
import { loadConfig } from '../src/config';
import { loadHealConfig, proposeRepair } from '../src/heal/propose';
import { renderHealSummary, renderPrBody } from '../src/heal/render';
import { validateRepair } from '../src/heal/validate';
import { parseResults } from '../src/playwright-results';
import { triage } from '../src/triage';
import { HealBaselineModel } from './heal-baseline';
import { HeuristicBaselineModel } from './fake-model';

/**
 * Local end-to-end check of the self-heal pipeline WITHOUT the Claude API:
 *   triage (heuristic baseline, verdict confidence raised to 0.85 — TEST ONLY) → gate → heal agent
 *   (deterministic baseline model) → deterministic checks → worktree validation (real Playwright
 *   against the running AUT) → PR body.
 * Usage (after a failing regression run in automation/): node dist/evals/heal-dry-run.js [--no-validate]
 * Output: automation/reports/heal-dry-run/. Nothing is pushed, nothing in the checkout is modified.
 */

/** Wraps the triage baseline and raises automation-defect confidence so the gate can be exercised. */
class ConfidentTriageBaseline implements ModelClient {
  readonly model = 'fake-model';
  constructor(private readonly inner: HeuristicBaselineModel) {}
  async create(request: ModelRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<Anthropic.Beta.BetaMessage> {
    const msg = await this.inner.create(request);
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.name === 'submit_triage_report') {
        const input = b.input as { failures: Array<{ classification: string; confidence: number }> };
        for (const f of input.failures) if (f.classification === 'automation_defect') f.confidence = 0.85;
      }
    }
    void options;
    return msg;
  }
}

async function main(): Promise<void> {
  const validate = !process.argv.includes('--no-validate');
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  const reports = path.join(root, 'automation', 'reports');
  const out = path.join(reports, 'heal-dry-run');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, ANTHROPIC_API_KEY: 'dry-run-no-api-calls' };

  const tconf = loadConfig(env, { reports, testResults: path.join(root, 'automation', 'test-results'), out });
  const parsed = parseResults(fs.readFileSync(path.join(reports, 'results.json'), 'utf8'));
  const report = await triage(tconf, { env, createClient: () => new ConfidentTriageBaseline(new HeuristicBaselineModel(parsed.failures, tconf.limits.maxFailures)) });
  fs.writeFileSync(path.join(out, 'triage-report.json'), JSON.stringify(report, null, 2));
  console.log(`triage (baseline): mode=${report.mode} ${report.failures.map((f) => `${f.testId}=${f.classification}(${f.confidence})`).join(' ')}`);

  const hconf = loadHealConfig({ ...env, HEAL_BRANCH: 'local-dry-run' }, { repoRoot: root, reports, triage: path.join(out, 'triage-report.json'), out });
  let result = await proposeRepair(hconf, { env, createClient: () => new HealBaselineModel() });
  console.log(`propose: status=${result.status} — ${result.reason}`);
  for (const c of result.checks) console.log(`  ${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);

  if (validate && result.status === 'proposed') {
    result = validateRepair(result, { repoRoot: root, outDir: out, env: process.env });
    console.log(`validate: status=${result.status} — ${result.reason}`);
  }
  fs.writeFileSync(path.join(out, 'heal-result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, 'heal-summary.md'), renderHealSummary(result));
  if (result.status === 'validated') {
    fs.writeFileSync(path.join(out, 'pr-body.md'), renderPrBody(result));
    fs.writeFileSync(path.join(out, 'repair.patch'), result.validation?.patch ?? '');
  }
  console.log(`outputs: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
