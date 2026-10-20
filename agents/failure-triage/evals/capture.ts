#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseResults } from '../src/playwright-results';
import { Redactor, sensitiveValuesFromEnv } from '../src/redact';
import { captureScenario, SCENARIO_NAME } from './capture-lib';

/**
 * Usage: npm run eval:capture -- --name <scenario> [--reports <dir>] [--test-results <dir>]
 *                                [--no-changes] [--force] [--log-margin-sec 120] [--log-max-kb 256]
 *
 * Freezes a regression run into evals/scenarios/<name>/. Defaults to the last local run
 * (automation/reports and automation/test-results); for a CI run, point --reports and
 * --test-results at the downloaded playwright-reports-* and playwright-test-results-* artifacts.
 * Writes a starter expected.json when there is none; label it before running the eval.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** Secret values from the local AUT env files, used only to redact them from the copies. */
function localSecretValues(): string[] {
  const files = [path.join(REPO_ROOT, 'aut', '.env'), path.join(REPO_ROOT, 'aut', 'apps', 'backend', '.env'), path.join(REPO_ROOT, 'aut', 'apps', 'storefront', '.env.local'), path.join(REPO_ROOT, 'automation', '.env')];
  const values: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*['"]?([^'"\s#]+)/.exec(line);
      if (m && /PASSWORD|SECRET|TOKEN|KEY/.test(m[1]!) && m[2]!.length >= 6) values.push(m[2]!);
    }
  }
  return values;
}

function parseArgs(argv: string[]) {
  const args = {
    name: '',
    reports: path.join(REPO_ROOT, 'automation', 'reports'),
    testResults: path.join(REPO_ROOT, 'automation', 'test-results'),
    changes: true,
    force: false,
    logMarginSec: 120,
    logMaxKb: 256,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === '--no-changes') args.changes = false;
    else if (flag === '--force') args.force = true;
    else if (value === undefined) throw new Error(`missing value for ${flag}`);
    else {
      if (flag === '--name') args.name = value;
      else if (flag === '--reports') args.reports = path.resolve(value);
      else if (flag === '--test-results') args.testResults = path.resolve(value);
      else if (flag === '--log-margin-sec') args.logMarginSec = Number(value);
      else if (flag === '--log-max-kb') args.logMaxKb = Number(value);
      else throw new Error(`unknown argument: ${flag}`);
      i++;
    }
  }
  if (!SCENARIO_NAME.test(args.name)) throw new Error('--name must be lowercase letters, digits and dashes (2-61 characters)');
  if (!(args.logMarginSec >= 0 && args.logMarginSec <= 3600)) throw new Error('--log-margin-sec must be 0-3600');
  if (!(args.logMaxKb >= 1 && args.logMaxKb <= 4096)) throw new Error('--log-max-kb must be 1-4096');
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const scenarioDir = path.join(PACKAGE_ROOT, 'evals', 'scenarios', args.name);
  const expectedFile = path.join(scenarioDir, 'expected.json');
  if (fs.existsSync(scenarioDir)) {
    if (!args.force) throw new Error(`scenario ${args.name} exists; pass --force to replace its artifacts (expected.json is kept)`);
    for (const sub of ['reports', 'test-results']) fs.rmSync(path.join(scenarioDir, sub), { recursive: true, force: true });
  }
  fs.mkdirSync(scenarioDir, { recursive: true });

  const redactor = new Redactor([...sensitiveValuesFromEnv(process.env), ...localSecretValues()]);
  const files = captureScenario({
    reportsDir: args.reports,
    testResultsDir: args.testResults,
    outDir: scenarioDir,
    redactor,
    includeChanges: args.changes,
    logMarginMs: args.logMarginSec * 1000,
    logMaxBytes: args.logMaxKb * 1024,
  });

  if (!fs.existsSync(expectedFile)) {
    const parsed = parseResults(fs.readFileSync(path.join(scenarioDir, 'reports', 'results.json'), 'utf8'));
    const starter = {
      description: 'TODO: what failed and why (the ground truth)',
      source: `captured ${new Date().toISOString()} from ${path.basename(args.reports)} / ${path.basename(args.testResults)}`,
      diff: files.some((f) => f.path === 'reports/changes.diff') ? 'relevant' : 'none',
      injection: null,
      tests: parsed.failures.map((f) => ({ title: f.title, expected: 'unknown', acceptable: [], evidenceKinds: [] })),
    };
    fs.writeFileSync(expectedFile, `${JSON.stringify(starter, null, 2)}\n`);
    console.log(`capture: wrote a starter expected.json; label every test before running the eval`);
  }

  const total = files.reduce((s, f) => s + f.bytes, 0);
  for (const f of files) console.log(`capture: ${f.path} ${(f.bytes / 1024).toFixed(1)} KiB`);
  console.log(`capture: ${files.length} files, ${(total / 1024).toFixed(1)} KiB in evals/scenarios/${args.name}`);
  if (total > 2 * 1024 * 1024) console.warn('capture: over 2 MiB; check for large screenshots or logs before committing');
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`capture: ${(e as Error).message}`);
  process.exit(2);
}
