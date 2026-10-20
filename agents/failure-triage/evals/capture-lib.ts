import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseResults } from '../src/playwright-results';
import type { Redactor } from '../src/redact';
import { ArtifactSandbox } from '../src/sandbox';
import { LOG_SERVICES } from '../src/tools';
import { ZipReader } from '../src/zip';

/**
 * Freezes the artifacts of one regression run into a scenario folder. Every source file is read
 * through the agent's own ArtifactSandbox, so only files inside the given reports/ and
 * test-results/ roots can be copied (no symlinks, no .env, diagnostic file types only). Only what the
 * triage tools read is kept: no videos, no HTML report, and trace.zip is cut down to its
 * `*.trace` / `*.network` entries.
 */

export const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Attachments the triage tools read; everything else (video, stdout dumps...) is left behind. */
const KEPT_ATTACHMENTS = (name: string, contentType: string, p: string): boolean =>
  name === 'trace' || p.endsWith('trace.zip') || name === 'screenshot' || contentType === 'image/png' || name === 'error-context' || p.endsWith('error-context.md');

/** Trace entries the tools read (see src/trace.ts and src/dom.ts). Screencast frames and resources are dropped. */
export const KEPT_TRACE_ENTRY = /\.(trace|network)$/;

export interface CaptureOptions {
  reportsDir: string;
  testResultsDir: string;
  outDir: string;
  redactor: Redactor;
  includeChanges: boolean;
  /** Log lines kept around the run window. */
  logMarginMs: number;
  /** Per-log cap; the end of the window is kept. */
  logMaxBytes: number;
}

export interface CapturedFile {
  path: string;
  bytes: number;
}

/**
 * Replace machine-specific absolute paths (checkout location, user name) with a neutral prefix.
 * Attachment paths are rewritten separately; this catches stacks, config and error messages.
 */
export function neutralizePaths(text: string): string {
  // Separators may be doubled when the path sits inside JSON text (trace entries).
  return text.replace(/(?:file:\/\/\/?)?(?:[A-Za-z]:)?(?:[\\/]+[^\\/\s"'`:()<>|*?]+)+?[\\/]+(?=(?:automation|agents|aut)[\\/])/g, '/repo/');
}

/** Keeps log lines whose docker timestamp lies in [from, to], plus undated continuation lines after a kept line. */
export function trimLog(text: string, from: number, to: number, maxBytes: number): string {
  const kept: string[] = [];
  let keeping = false;
  for (const line of text.split('\n')) {
    const ts = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line)?.[1];
    if (ts) {
      const at = Date.parse(ts.replace(/(\.\d{3})\d+Z$/, '$1Z'));
      keeping = at >= from && at <= to;
    }
    if (keeping && line.length) kept.push(line);
  }
  let out = kept.join('\n');
  if (Buffer.byteLength(out) > maxBytes) {
    const buf = Buffer.from(out);
    out = buf.subarray(buf.length - maxBytes).toString('utf8');
    out = out.slice(out.indexOf('\n') + 1);
  }
  return out ? `${out}\n` : '';
}

/** Minimal ZIP writer (deflate, with CRCs so Playwright's trace viewer still opens the result). */
export function writeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Keeps only the trace entries the tools read, redacted line by line. */
export function slimTrace(zip: Buffer, redactor: Redactor, maxEntryBytes: number): Buffer {
  const reader = new ZipReader(zip);
  const entries = reader
    .find((n) => KEPT_TRACE_ENTRY.test(n))
    .map((e) => ({ name: e.name, data: Buffer.from(neutralizePaths(redactor.redact(reader.read(e, maxEntryBytes).toString('utf8')))) }));
  return writeZip(entries);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** Walks results.json and visits every result (attempt) object. */
function forEachResult(data: Record<string, unknown>, fn: (result: Record<string, unknown>) => void): void {
  const walk = (suite: Record<string, unknown>) => {
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      for (const t of isObj(spec) && Array.isArray(spec.tests) ? spec.tests : []) {
        for (const r of isObj(t) && Array.isArray(t.results) ? t.results : []) if (isObj(r)) fn(r);
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) if (isObj(child)) walk(child);
  };
  for (const s of Array.isArray(data.suites) ? data.suites : []) if (isObj(s)) walk(s);
}

export function captureScenario(opts: CaptureOptions): CapturedFile[] {
  const limits = { maxFileBytes: 50 * 1024 * 1024, maxTotalReadBytes: 2 * 1024 * 1024 * 1024 };
  for (const dir of [opts.reportsDir, opts.testResultsDir]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  }
  const sandbox = new ArtifactSandbox([opts.reportsDir, opts.testResultsDir], limits, opts.testResultsDir);
  const testResultsReal = fs.realpathSync(opts.testResultsDir);
  const written: CapturedFile[] = [];
  const write = (rel: string, data: Buffer | string) => {
    const target = path.join(opts.outDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push({ path: rel.split(path.sep).join('/'), bytes: Buffer.byteLength(data) });
  };
  const clean = (s: string) => neutralizePaths(opts.redactor.redact(s));

  // results.json: keep only attachments the tools read, point them at the frozen copies.
  const resultsRaw = sandbox.readText(path.join(opts.reportsDir, 'results.json'));
  const data = JSON.parse(resultsRaw) as Record<string, unknown>;
  const toCopy = new Map<string, string>();
  forEachResult(data, (r) => {
    if (r.status === 'passed' || r.status === 'skipped' || !Array.isArray(r.attachments)) {
      if (Array.isArray(r.attachments)) r.attachments = [];
      return;
    }
    r.attachments = r.attachments.filter(isObj).flatMap((a) => {
      const p = typeof a.path === 'string' ? a.path : null;
      if (!p || !KEPT_ATTACHMENTS(String(a.name ?? ''), String(a.contentType ?? ''), p)) return [];
      const real = sandbox.resolve(p);
      const rel = path.relative(testResultsReal, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`attachment outside test-results: ${path.basename(p)}`);
      toCopy.set(rel, real);
      return [{ ...a, path: `/artifacts/test-results/${rel.split(path.sep).join('/')}` }];
    });
  });
  const cleaned = mapStrings(data, (s) => (s.startsWith('/artifacts/test-results/') ? s : clean(s))) as Record<string, unknown>;
  const parsed = parseResults(JSON.stringify(cleaned));
  if (parsed.failures.length === 0) throw new Error('results.json has no failed or flaky tests: nothing to triage');
  write(path.join('reports', 'results.json'), `${JSON.stringify(cleaned, null, 2)}\n`);

  const envFile = path.join(opts.reportsDir, 'environment.json');
  if (sandbox.exists(envFile)) write(path.join('reports', 'environment.json'), clean(sandbox.readText(envFile)));

  const changes = path.join(opts.reportsDir, 'changes.diff');
  if (opts.includeChanges && sandbox.exists(changes)) write(path.join('reports', 'changes.diff'), clean(sandbox.readText(changes)));

  // Logs: only the run's time window (attempt times from results.json), redacted and capped.
  const times = parsed.failures.flatMap((f) => f.attempts.filter((a) => a.startTime).map((a) => [Date.parse(a.startTime!), Date.parse(a.startTime!) + a.durationMs]));
  const runStart = parsed.stats.startTime ? Date.parse(parsed.stats.startTime) : Math.min(...times.map((t) => t[0]!));
  const runEnd = Math.max(runStart + parsed.stats.durationMs, ...times.map((t) => t[1]!));
  for (const service of LOG_SERVICES) {
    const name = service === 'compose-ps' ? 'compose-ps.txt' : `${service}.log`;
    const file = path.join(opts.reportsDir, 'aut', name);
    if (!sandbox.exists(file)) continue;
    const text = clean(sandbox.readText(file));
    write(path.join('reports', 'aut', name), service === 'compose-ps' ? text : trimLog(text, runStart - opts.logMarginMs, runEnd + opts.logMarginMs, opts.logMaxBytes));
  }

  for (const [rel, real] of [...toCopy.entries()].sort()) {
    const target = path.join('test-results', rel);
    if (real.endsWith('.zip')) write(target, slimTrace(sandbox.readBytes(real), opts.redactor, 40 * 1024 * 1024));
    else if (real.endsWith('.md')) write(target, clean(sandbox.readText(real)));
    else write(target, sandbox.readBytes(real));
  }
  return written;
}
