#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Redactor, sensitiveValuesFromEnv } from '../redact';
import { verifyRepairPatch } from './patch';
import { loadHealConfig, proposeRepair } from './propose';
import { renderHealSummary, renderPrBody } from './render';
import type { HealResult } from './result';
import { validateRepair } from './validate';

/**
 * self-heal propose  [--repo-root d] [--reports d] [--test-results d] [--triage f] [--out d]
 * self-heal validate [--repo-root d] [--out d]
 * self-heal verify-patch --patch f --result f
 *
 * propose/validate exit 0 whenever they wrote a result: self-heal is advisory and never decides the
 * pipeline status. verify-patch exits 1 on any violation (it gates the PR job).
 */

type Args = Partial<Record<'repoRoot' | 'reports' | 'testResults' | 'triage' | 'out' | 'patch' | 'result' | 'summary', string>>;
const FLAGS: Record<string, keyof Args> = {
  '--repo-root': 'repoRoot',
  '--reports': 'reports',
  '--test-results': 'testResults',
  '--triage': 'triage',
  '--out': 'out',
  '--patch': 'patch',
  '--result': 'result',
  '--summary': 'summary',
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]!];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  return args;
}

function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value.replace(/[\r\n]/g, ' ')}\n`);
}

function write(outDir: string, result: HealResult, redactor: Redactor, summaryFile: string | undefined, final: boolean): void {
  const safe = redactor.redactValue(result);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'heal-result.json'), `${JSON.stringify(safe, null, 2)}\n`);
  if (safe.validation?.patch && safe.status === 'validated') fs.writeFileSync(path.join(outDir, 'repair.patch'), safe.validation.patch);
  if (safe.status === 'validated') fs.writeFileSync(path.join(outDir, 'pr-body.md'), renderPrBody(safe));
  if (final) {
    const md = renderHealSummary(safe);
    fs.writeFileSync(path.join(outDir, 'heal-summary.md'), md);
    if (summaryFile) fs.appendFileSync(summaryFile, `${md}\n`);
  }
  console.log(`self-heal: status=${safe.status} ${safe.reason}`);
  output('status', safe.status);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const redactor = new Redactor(sensitiveValuesFromEnv(process.env));
  const summaryFile = args.summary ?? process.env.GITHUB_STEP_SUMMARY;

  if (command === 'propose') {
    const config = loadHealConfig(process.env, args);
    const result = await proposeRepair(config, { env: process.env });
    // A proposal is only final after validation; every other outcome is reported now.
    write(config.paths.outDir, result, redactor, summaryFile, result.status !== 'proposed');
    return 0;
  }
  if (command === 'validate') {
    const config = loadHealConfig(process.env, args);
    const file = path.join(config.paths.outDir, 'heal-result.json');
    if (!fs.existsSync(file)) {
      console.log('self-heal: nothing to validate');
      output('status', 'none');
      return 0;
    }
    const proposed = JSON.parse(fs.readFileSync(file, 'utf8')) as HealResult;
    if (proposed.status !== 'proposed') {
      output('status', proposed.status);
      return 0;
    }
    const result = validateRepair(proposed, { repoRoot: config.paths.repoRoot, outDir: config.paths.outDir, env: process.env });
    write(config.paths.outDir, result, redactor, summaryFile, true);
    return 0;
  }
  if (command === 'verify-patch') {
    if (!args.patch || !args.result) throw new Error('verify-patch needs --patch and --result');
    const result = JSON.parse(fs.readFileSync(args.result, 'utf8')) as HealResult;
    const errors = result.status !== 'validated' ? ['result is not validated'] : verifyRepairPatch(fs.readFileSync(args.patch, 'utf8'), result.edit);
    if (errors.length) {
      console.error(`self-heal: patch rejected: ${errors.join('; ')}`);
      return 1;
    }
    console.log(`self-heal: patch verified (${result.edit!.file}:${result.edit!.line})`);
    return 0;
  }
  throw new Error('usage: self-heal propose|validate|verify-patch [options]');
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`self-heal: ${new Redactor(sensitiveValuesFromEnv(process.env)).redact((e as Error)?.message ?? String(e))}`);
    process.exit(1);
  },
);
