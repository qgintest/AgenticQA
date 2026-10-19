import path from 'node:path';

/** Hard limits for one triage run. Every value is clamped so a bad env var cannot remove a limit. */
export interface Limits {
  /** Model round-trips (one request + its tool executions). */
  maxIterations: number;
  /** Cumulative input tokens billed across all requests (each request resends history). */
  maxInputTokens: number;
  /** Cumulative output tokens (incl. thinking) across all requests. */
  maxOutputTokens: number;
  /** max_tokens for a single response. */
  maxTokensPerResponse: number;
  /** Wall-clock budget for the whole agent run. */
  timeoutMs: number;
  /** Failed tests handed to the agent (the rest are triaged heuristically). */
  maxFailures: number;
  /** Characters returned to the model by one tool call. */
  maxToolResultChars: number;
  /** Largest single file a tool may read. */
  maxFileBytes: number;
  /** Largest uncompressed entry read out of a zip (trace) — zip-bomb guard. */
  maxZipEntryBytes: number;
  /** Total bytes all tools may read in one run. */
  maxTotalReadBytes: number;
  /** Largest screenshot sent to the model. */
  maxImageBytes: number;
  /** Invalid `submit_triage_report` attempts tolerated before falling back. */
  maxReportCorrections: number;
}

export interface TriageConfig {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Server-side refusal fallback (`fallbacks: "default"`); TRIAGE_FALLBACKS=off disables it. */
  refusalFallbacks: boolean;
  limits: Limits;
  paths: {
    resultsJson: string;
    testResultsDir: string;
    reportsDir: string;
    outDir: string;
  };
  /** Free-form context shown in the report (CI run URL etc.). Never contains secrets. */
  runUrl: string | null;
}

export const DEFAULT_LIMITS: Limits = {
  maxIterations: 12,
  maxInputTokens: 600_000,
  maxOutputTokens: 60_000,
  maxTokensPerResponse: 16_000,
  timeoutMs: 6 * 60_000,
  maxFailures: 10,
  maxToolResultChars: 12_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxZipEntryBytes: 40 * 1024 * 1024,
  maxTotalReadBytes: 150 * 1024 * 1024,
  maxImageBytes: 3 * 1024 * 1024,
  maxReportCorrections: 2,
};

/** Upper bounds an env override may not exceed. */
const CEILINGS: Limits = {
  maxIterations: 30,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 200_000,
  maxTokensPerResponse: 32_000,
  timeoutMs: 20 * 60_000,
  maxFailures: 25,
  maxToolResultChars: 40_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxZipEntryBytes: 100 * 1024 * 1024,
  maxTotalReadBytes: 500 * 1024 * 1024,
  maxImageBytes: 3_700_000,
  maxReportCorrections: 4,
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, ceiling: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), ceiling);
}

export function loadLimits(env: NodeJS.ProcessEnv): Limits {
  const keys: Array<[keyof Limits, string]> = [
    ['maxIterations', 'TRIAGE_MAX_ITERATIONS'],
    ['maxInputTokens', 'TRIAGE_MAX_INPUT_TOKENS'],
    ['maxOutputTokens', 'TRIAGE_MAX_OUTPUT_TOKENS'],
    ['timeoutMs', 'TRIAGE_TIMEOUT_MS'],
    ['maxFailures', 'TRIAGE_MAX_FAILURES'],
  ];
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, name] of keys) limits[key] = intFromEnv(env, name, DEFAULT_LIMITS[key], CEILINGS[key]);
  return limits;
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  args: Partial<Record<'results' | 'testResults' | 'reports' | 'out', string>>,
  cwd = process.cwd(),
): TriageConfig {
  const effort = (env.TRIAGE_EFFORT ?? 'high').toLowerCase();
  const reportsDir = path.resolve(cwd, args.reports ?? '../../automation/reports');
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  return {
    model: env.TRIAGE_MODEL?.trim() || 'claude-opus-5-5',
    effort: (EFFORTS as readonly string[]).includes(effort) ? (effort as TriageConfig['effort']) : 'high',
    refusalFallbacks: (env.TRIAGE_FALLBACKS ?? 'on').toLowerCase() !== 'off',
    limits: loadLimits(env),
    paths: {
      resultsJson: path.resolve(cwd, args.results ?? path.join(reportsDir, 'results.json')),
      testResultsDir: path.resolve(cwd, args.testResults ?? '../../automation/test-results'),
      reportsDir,
      outDir: path.resolve(cwd, args.out ?? path.join(reportsDir, 'triage')),
    },
    runUrl: server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
  };
}
