/** Parses Playwright's JSON reporter output into the failure model the agent works with. */

export interface AttachmentRef {
  name: string;
  contentType: string;
  /** Path as written by the reporter (absolute on the machine that ran the tests). */
  path: string | null;
}

export interface AttemptError {
  message: string;
  stack: string | null;
  location: string | null;
}

export interface Attempt {
  retry: number;
  status: string;
  durationMs: number;
  startTime: string | null;
  errors: AttemptError[];
  attachments: AttachmentRef[];
  stdout: string;
  stderr: string;
}

export interface FailedTest {
  /** Short stable id handed to the model (T1, T2, ...). */
  id: string;
  title: string;
  file: string;
  line: number | null;
  project: string;
  tags: string[];
  /** Playwright outcome: 'unexpected' (failed) or 'flaky' (failed, then passed on retry). */
  outcome: 'unexpected' | 'flaky';
  attempts: Attempt[];
}

export interface RunStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  startTime: string | null;
}

export interface ParsedResults {
  stats: RunStats;
  failures: FailedTest[];
  /** Errors outside any test (global setup failure, config error...). */
  runErrors: string[];
  projects: string[];
}

export class ResultsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultsFormatError';
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function outputText(chunks: unknown): string {
  return arr(chunks)
    .map((c) => (isObj(c) ? str(c.text) : typeof c === 'string' ? c : ''))
    .join('')
    .slice(-4000);
}

function parseError(e: unknown): AttemptError {
  if (!isObj(e)) return { message: String(e), stack: null, location: null };
  const loc = isObj(e.location) ? `${str(e.location.file)}:${num(e.location.line)}:${num(e.location.column)}` : null;
  return {
    message: stripAnsi(str(e.message, str(e.value, 'unknown error'))),
    stack: typeof e.stack === 'string' ? stripAnsi(e.stack) : null,
    location: loc,
  };
}

function parseAttempt(r: Json): Attempt {
  const errors = arr(r.errors).map(parseError);
  if (errors.length === 0 && isObj(r.error)) errors.push(parseError(r.error));
  return {
    retry: num(r.retry),
    status: str(r.status, 'unknown'),
    durationMs: num(r.duration),
    startTime: typeof r.startTime === 'string' ? r.startTime : null,
    errors,
    attachments: arr(r.attachments)
      .filter(isObj)
      .map((a) => ({ name: str(a.name), contentType: str(a.contentType), path: typeof a.path === 'string' ? a.path : null })),
    stdout: stripAnsi(outputText(r.stdout)),
    stderr: stripAnsi(outputText(r.stderr)),
  };
}

export function parseResults(raw: string): ParsedResults {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ResultsFormatError(`results.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObj(data) || !Array.isArray(data.suites)) throw new ResultsFormatError('results.json has no "suites" array');

  const s = isObj(data.stats) ? data.stats : {};
  const stats: RunStats = {
    expected: num(s.expected),
    unexpected: num(s.unexpected),
    flaky: num(s.flaky),
    skipped: num(s.skipped),
    durationMs: num(s.duration),
    startTime: typeof s.startTime === 'string' ? s.startTime : null,
  };

  const collected: Omit<FailedTest, 'id'>[] = [];
  const projects = new Set<string>();

  const walk = (suite: Json, trail: string[]): void => {
    for (const spec of arr(suite.specs).filter(isObj)) {
      for (const t of arr(spec.tests).filter(isObj)) {
        const project = str(t.projectName, 'default');
        projects.add(project);
        const status = str(t.status);
        if (status !== 'unexpected' && status !== 'flaky') continue;
        collected.push({
          title: [...trail, str(spec.title)].filter(Boolean).join(' › '),
          file: str(spec.file, str(suite.file)),
          line: typeof spec.line === 'number' ? spec.line : null,
          project,
          tags: arr(spec.tags).map((x) => str(x)).filter(Boolean),
          outcome: status,
          attempts: arr(t.results).filter(isObj).map(parseAttempt),
        });
      }
    }
    for (const child of arr(suite.suites).filter(isObj)) {
      walk(child, [...trail, str(child.title)]);
    }
  };
  // Top-level suites are files; their title is the file path, which `file` already carries.
  for (const fileSuite of arr(data.suites).filter(isObj)) walk(fileSuite, []);

  // Hard failures first, then flaky.
  collected.sort((a, b) => (a.outcome === b.outcome ? 0 : a.outcome === 'unexpected' ? -1 : 1));

  // Errors outside any test (e.g. global setup could not reach the AUT) are triaged like failures.
  const runErrors = arr(data.errors).map(parseError);
  if (runErrors.length) {
    collected.unshift({
      title: 'Run-level error (outside any test, e.g. global setup)',
      file: '',
      line: null,
      project: '(run)',
      tags: [],
      outcome: 'unexpected',
      attempts: [{ retry: 0, status: 'failed', durationMs: stats.durationMs, startTime: stats.startTime, errors: runErrors, attachments: [], stdout: '', stderr: '' }],
    });
  }

  return {
    stats,
    failures: collected.map((f, i) => ({ id: `T${i + 1}`, ...f })),
    runErrors: runErrors.map((e) => e.message),
    projects: [...projects].sort(),
  };
}

/** First line of the final attempt's first error — the "headline" of a failure. */
export function headline(test: FailedTest): string {
  const last = test.attempts[test.attempts.length - 1];
  const msg = last?.errors[0]?.message ?? 'no error message recorded';
  return msg.split('\n').find((l) => l.trim().length > 0)?.trim() ?? msg;
}

export function allErrorText(test: FailedTest): string {
  return test.attempts.flatMap((a) => a.errors.map((e) => `${e.message}\n${e.stack ?? ''}`)).join('\n');
}
