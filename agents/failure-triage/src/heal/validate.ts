import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onlyTestIdLiteralChanged } from './locators';
import { verifyRepairPatch } from './patch';
import { isEditablePath } from './repo';
import type { HealResult, PhaseResult } from './result';

export interface ValidateOptions {
  repoRoot: string;
  outDir: string;
  env: NodeJS.ProcessEnv;
  phaseTimeoutMs?: number;
  /** Override the test command (tests). Receives the worktree's automation dir and the args. */
  runner?: (automationDir: string, args: string[], env: NodeJS.ProcessEnv, jsonOut: string) => number | null;
  /** Override dependency installation in the worktree (tests). Returns true on success. */
  install?: (automationDir: string, env: NodeJS.ProcessEnv) => boolean;
  log?: (line: string) => void;
}

/** Environment for the test run: no API keys, tokens or secrets; never the deliberate-failure project. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/(TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i.test(k)) continue;
    out[k] = v;
  }
  out.AQA_DELIBERATE_FAILURE = 'off';
  out.AQA_RUN_ID = `heal-${Date.now().toString(36)}`;
  return out;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Clean install inside the worktree. Never link to the checkout's node_modules: removing a worktree
 * that contains a link (a junction on Windows) can delete the link target's contents.
 */
function defaultInstall(automationDir: string, env: NodeJS.ProcessEnv): boolean {
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: automationDir,
    env,
    stdio: 'inherit',
    timeout: 10 * 60_000,
    // npm is a .cmd shim on Windows; the arguments are fixed strings, nothing is interpolated.
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

function defaultRunner(automationDir: string, args: string[], env: NodeJS.ProcessEnv, jsonOut: string): number | null {
  const cli = path.join(automationDir, 'node_modules', '@playwright', 'test', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'test', ...args], {
    cwd: automationDir,
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut },
    stdio: 'inherit',
    timeout: Number(env.HEAL_VALIDATION_TIMEOUT_MS) || 20 * 60_000,
  });
  return r.status;
}

interface RunTest {
  title: string;
  file: string;
  status: string;
  error: string;
}

/** Flatten a Playwright JSON report (every test, not just failures). */
export function readRunTests(raw: string): RunTest[] {
  const data = JSON.parse(raw) as { suites?: unknown[] };
  const out: RunTest[] = [];
  const walk = (s: Record<string, unknown>, trail: string[]) => {
    for (const spec of (s.specs as Array<Record<string, unknown>>) ?? []) {
      for (const t of (spec.tests as Array<Record<string, unknown>>) ?? []) {
        const results = (t.results as Array<Record<string, unknown>>) ?? [];
        const last = results[results.length - 1];
        const err = ((last?.errors as Array<{ message?: string }>) ?? [])[0]?.message ?? '';
        out.push({
          title: [...trail, String(spec.title)].filter(Boolean).join(' › '),
          file: String(spec.file ?? s.file ?? ''),
          // eslint-disable-next-line no-control-regex
          status: String(t.status), error: err.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]!.slice(0, 300),
        });
      }
    }
    for (const c of (s.suites as Array<Record<string, unknown>>) ?? []) walk(c, [...trail, String(c.title)]);
  };
  for (const f of (data.suites as Array<Record<string, unknown>>) ?? []) walk(f, []);
  return out;
}

function phase(name: string, targets: string[], requiredTitles: string[], o: { automationDir: string; env: NodeJS.ProcessEnv; outDir: string; runner: NonNullable<ValidateOptions['runner']> }): PhaseResult {
  const jsonOut = path.join(o.outDir, `validation-${name}.json`);
  fs.rmSync(jsonOut, { force: true });
  const started = Date.now();
  const exitCode = o.runner(o.automationDir, [...targets, '--project=regression', '--retries=0', '--reporter=list,json'], o.env, jsonOut);
  const res: PhaseResult = { name, targets, expected: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, missing: [], exitCode, durationMs: Date.now() - started, failures: [] };
  if (!fs.existsSync(jsonOut)) {
    res.missing = requiredTitles;
    res.failures.push({ title: '(run)', error: 'no Playwright JSON report was produced' });
    return res;
  }
  const tests = readRunTests(fs.readFileSync(jsonOut, 'utf8'));
  res.expected = tests.length;
  for (const t of tests) {
    if (t.status === 'expected') res.passed++;
    else if (t.status === 'flaky') res.flaky++;
    else if (t.status === 'skipped') res.skipped++;
    else {
      res.failed++;
      res.failures.push({ title: t.title, error: t.error });
    }
  }
  res.missing = requiredTitles.filter((title) => !tests.some((t) => t.title === title && t.status === 'expected'));
  return res;
}

const phaseOk = (p: PhaseResult) => p.exitCode === 0 && p.failed === 0 && p.flaky === 0 && p.missing.length === 0 && p.passed > 0;

/**
 * Apply the checked edit in a throwaway git worktree of HEAD and rerun (1) the originally failing
 * tests and (2) every spec that uses the changed page-object property, against the AUT that is
 * already running. The repository's own checkout is never modified.
 */
export function validateRepair(input: HealResult, o: ValidateOptions): HealResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const result: HealResult = JSON.parse(JSON.stringify(input));
  const fail = (reason: string) => {
    result.status = 'failed_validation';
    result.reason = reason;
    return result;
  };
  if (result.status !== 'proposed' || !result.edit || !result.plan) return result;
  const edit = result.edit;
  fs.mkdirSync(o.outDir, { recursive: true });
  if (!isEditablePath(edit.file) || !onlyTestIdLiteralChanged(edit.before, edit.after)) return fail('edit is outside the allowed scope');

  const base = o.env.RUNNER_TEMP || os.tmpdir();
  const worktree = fs.mkdtempSync(path.join(base, 'aqa-heal-'));
  fs.rmSync(worktree, { recursive: true, force: true });
  const add = git(o.repoRoot, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  if (!add.ok) return fail(`could not create a worktree: ${add.stderr.trim().slice(0, 300)}`);
  log(`self-heal: worktree ${worktree}`);

  try {
    const target = path.join(worktree, ...edit.file.split('/'));
    const lines = fs.readFileSync(target, 'utf8').split('\n');
    const current = lines[edit.line - 1]?.replace(/\r$/, '');
    if (current !== edit.before) return fail(`HEAD no longer contains the analysed line at ${edit.file}:${edit.line}`);
    lines[edit.line - 1] = lines[edit.line - 1]!.endsWith('\r') ? `${edit.after}\r` : edit.after;
    fs.writeFileSync(target, lines.join('\n'));

    // Local, untracked runtime config the tests need (generated per environment, never committed).
    for (const rel of ['aut/.env', 'automation/.env']) {
      const src = path.join(o.repoRoot, rel);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(worktree, rel));
    }
    const automationDir = path.join(worktree, 'automation');

    const patch = git(worktree, ['diff', '--no-color', '--', edit.file]).stdout;
    const patchErrors = verifyRepairPatch(patch, edit);
    if (patchErrors.length) return fail(`patch failed verification: ${patchErrors.join('; ')}`);
    result.validation = { phases: [], patch };

    const env = childEnv(o.env);
    log('self-heal: installing test dependencies in the worktree');
    if (!(o.install ?? defaultInstall)(automationDir, env)) return fail('npm ci failed in the worktree');
    const run = { automationDir, env, outDir: o.outDir, runner: o.runner ?? defaultRunner };
    const failing = result.plan.tests.map((t) => (t.line ? `${t.file}:${t.line}` : t.file));
    log(`self-heal: phase 1 — rerun ${failing.length} originally failing test(s)`);
    const p1 = phase('failing-tests', failing, result.plan.tests.map((t) => t.title), run);
    result.validation.phases.push(p1);
    if (!phaseOk(p1)) return fail(`originally failing tests did not pass with the repair (${p1.failed} failed, ${p1.missing.length} missing)`);

    const related = result.plan.usage.relatedSpecs.map((s) => s.replace(/^automation\//, ''));
    const specs = related.length ? related : [...new Set(result.plan.tests.map((t) => `tests/${t.file}`))];
    log(`self-heal: phase 2 — run ${specs.length} related spec file(s)`);
    const p2 = phase('related-specs', specs, [], run);
    result.validation.phases.push(p2);
    if (!phaseOk(p2)) return fail(`related specs failed with the repair (${p2.failed} failed)`);

    result.status = 'validated';
    result.reason = `${edit.oldLocator} → ${edit.newLocator}: ${p1.passed} failing test(s) and ${p2.passed} related test(s) passed`;
    return result;
  } finally {
    const guard = path.join(o.repoRoot, 'automation', 'node_modules');
    const hadModules = fs.existsSync(guard) && fs.readdirSync(guard).length > 0;
    const rm = git(o.repoRoot, ['worktree', 'remove', '--force', worktree]);
    if (!rm.ok) fs.rmSync(worktree, { recursive: true, force: true });
    git(o.repoRoot, ['worktree', 'prune']);
    if (hadModules && !(fs.existsSync(guard) && fs.readdirSync(guard).length > 0)) {
      // Must never happen (no links are created); fail loudly rather than leave a broken checkout.
      throw new Error('worktree cleanup affected the checkout: automation/node_modules is gone (run npm ci in automation/)');
    }
  }
}
