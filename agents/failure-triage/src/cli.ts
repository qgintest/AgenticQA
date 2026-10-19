#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { Redactor, sensitiveValuesFromEnv } from './redact';
import { renderMarkdown } from './render';
import { triage } from './triage';

/**
 * Usage: failure-triage [--results <file>] [--test-results <dir>] [--reports <dir>] [--out <dir>] [--summary <file>]
 *
 * Writes <out>/triage-report.json and <out>/triage-report.md and appends the Markdown to the job
 * summary ($GITHUB_STEP_SUMMARY or --summary). Exits 0 whenever a report was written: triage is
 * advisory and must never decide the pipeline's status.
 */

const FLAGS: Record<string, 'results' | 'testResults' | 'reports' | 'out' | 'summary'> = {
  '--results': 'results',
  '--test-results': 'testResults',
  '--reports': 'reports',
  '--out': 'out',
  '--summary': 'summary',
};

function parseArgs(argv: string[]): Partial<Record<'results' | 'testResults' | 'reports' | 'out' | 'summary', string>> {
  const args: Partial<Record<'results' | 'testResults' | 'reports' | 'out' | 'summary', string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]!];
    const value = argv[i + 1];
    if (!key || value === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    args[key] = value;
    i++;
  }
  return args;
}

async function main(): Promise<number> {
  const redactor = new Redactor(sensitiveValuesFromEnv(process.env));
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, args);
  fs.mkdirSync(config.paths.outDir, { recursive: true });
  const summaryFile = args.summary ?? process.env.GITHUB_STEP_SUMMARY;

  let markdown: string;
  try {
    const report = await triage(config, { env: process.env });
    markdown = renderMarkdown(report);
    fs.writeFileSync(path.join(config.paths.outDir, 'triage-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(config.paths.outDir, 'triage-report.md'), markdown);
    const counts = report.failures.map((f) => `${f.testId}=${f.classification}(${f.confidence.toFixed(2)})`).join(' ');
    console.log(`triage: mode=${report.mode} overall=${report.overall.classification} ${counts}`);
    if (report.modeReason) console.log(`triage: ${report.modeReason}`);
    if (report.agent) {
      const a = report.agent;
      console.log(`triage: agent turns=${a.iterations} tools=${a.toolCalls.length} tokens=${a.usage.inputTokens}/${a.usage.outputTokens} ${(a.durationMs / 1000).toFixed(1)}s`);
    }
  } catch (e) {
    // Unexpected bug: still leave a trace in the summary, without stack traces or paths.
    const msg = redactor.redact((e as Error)?.message ?? String(e));
    console.error(`triage: failed unexpectedly: ${msg}`);
    markdown = `## 🤖 Failure triage\n\n> ⚠️ Triage failed unexpectedly (${msg.replace(/[<>&`|]/g, ' ')}). The regression result is unchanged.\n`;
    fs.writeFileSync(path.join(config.paths.outDir, 'triage-report.md'), markdown);
    if (summaryFile) fs.appendFileSync(summaryFile, `${markdown}\n`);
    return 1;
  }
  if (summaryFile) fs.appendFileSync(summaryFile, `${markdown}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`triage: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  },
);
