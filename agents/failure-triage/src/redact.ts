/**
 * Secret redaction applied to everything that leaves a tool (to the model) and everything written
 * to disk or the job summary. Defence in depth: the agent never reads env vars or .env files, but
 * logs and traces can still contain tokens.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:anthropic-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bpk_[A-Za-z0-9]{16,}\b/g, '[REDACTED:publishable-key]'],
  [/\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED:secret-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/([^:@\s/]+):([^@\s]+)@/gi, '$1://$2:[REDACTED]@'],
  [
    /\b((?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY))\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1[REDACTED]',
  ],
  [/("(?:password|secret|token|api_key|apiKey|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
];

/** Exact values that must never appear (e.g. the API key itself, if present in this process). */
export function sensitiveValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'ADMIN_PASSWORD', 'POSTGRES_PASSWORD', 'AQA_ADMIN_PASSWORD'];
  return names.map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length >= 6);
}

export class Redactor {
  constructor(private readonly exactValues: string[] = []) {}

  redact(text: string): string {
    let out = text;
    for (const value of this.exactValues) out = out.split(value).join('[REDACTED]');
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  /** Deep-redact all strings in a JSON-like value. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactValue(v);
      return out as T;
    }
    return value;
  }
}
