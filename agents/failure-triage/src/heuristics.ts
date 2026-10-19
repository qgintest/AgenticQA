import { allErrorText, headline, type FailedTest } from './playwright-results';

export const CLASSIFICATIONS = [
  'application_defect',
  'automation_defect',
  'environment_issue',
  'flaky',
  'unknown',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export interface Signal {
  classification: Exclude<Classification, 'unknown'>;
  weight: number;
  description: string;
  /** Short excerpt of the text that matched. */
  match: string | null;
}

interface Rule {
  classification: Signal['classification'];
  weight: number;
  description: string;
  pattern: RegExp;
}

/**
 * Deterministic signals from the failure text. They are the fallback classification when the
 * model is unavailable and a cross-check on the model's answer — never the final word on their own
 * (heuristic confidence is capped below "high").
 */
const RULES: Rule[] = [
  // Environment / infrastructure
  { classification: 'environment_issue', weight: 5, description: 'AUT was not reachable when the run started', pattern: /not ready at \S+ after \d+s/i },
  { classification: 'environment_issue', weight: 4, description: 'Network-level connection failure', pattern: /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE)\b|socket hang up|net::ERR_[A-Z_]+/ },
  { classification: 'environment_issue', weight: 3, description: 'Gateway / service unavailable response', pattern: /\b(502|503|504)\b[^\n]{0,40}(Bad Gateway|Service Unavailable|Gateway Time-?out)/i },
  { classification: 'environment_issue', weight: 4, description: 'Runner / browser resource problem', pattern: /browserType\.launch|Executable doesn't exist|\bENOSPC\b|out of memory|Target page, context or browser has been closed/i },
  { classification: 'environment_issue', weight: 1, description: 'Overall test timeout (slow environment is one possible cause)', pattern: /Test timeout of \d+ms exceeded/ },
  // Automation (test code / locators)
  { classification: 'automation_defect', weight: 3, description: 'Locator matched multiple elements (strict mode violation)', pattern: /strict mode violation/i },
  { classification: 'automation_defect', weight: 3, description: 'Action timed out waiting for a locator that never appeared', pattern: /(locator\.\w+|page\.\w+): Timeout \d+ms exceeded[\s\S]{0,300}waiting for (getBy\w+|locator)\(/ },
  { classification: 'automation_defect', weight: 2, description: 'Element(s) not found for an expectation (stale locator or removed UI)', pattern: /element\(s\) not found/i },
  { classification: 'automation_defect', weight: 2, description: 'Programming error raised from test code', pattern: /\b(TypeError|ReferenceError|SyntaxError)\b[^\n]*\n(\s+at [^\n]*\n){0,3}\s+at [^\n]*(\/|\\)(tests|src)(\/|\\)(?![^\n]*node_modules)/ },
  // Application
  { classification: 'application_defect', weight: 4, description: 'Backend returned a 5xx error', pattern: /→ 5\d\d\b|status(Code)?["']?\s*[:=]\s*5\d\d\b|HTTP 5\d\d\b/ },
  { classification: 'application_defect', weight: 3, description: 'Value assertion failed: the app returned a different value than expected', pattern: /expect\((received|locator|page)\)\.(toBe|toEqual|toStrictEqual|toMatchObject|toHaveText|toHaveAttribute|toContainText|toHaveValue|toHaveURL|toHaveCount)\b[\s\S]{0,400}\bReceived\b(?![^\n]*element\(s\) not found)/ },
  { classification: 'application_defect', weight: 2, description: 'Backend rejected a request with a 4xx error', pattern: /→ 4\d\d\b/ },
];

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, Math.min(text.length, index + length + 80)).replace(/\s+/g, ' ').trim();
}

export function signalsFor(test: FailedTest): Signal[] {
  const signals: Signal[] = [];
  if (test.outcome === 'flaky') {
    signals.push({ classification: 'flaky', weight: 6, description: 'Playwright marked the test flaky: it failed, then passed on retry', match: null });
  }
  const failedAttempts = test.attempts.filter((a) => a.status !== 'passed' && a.status !== 'skipped');
  const distinct = new Set(failedAttempts.map((a) => (a.errors[0]?.message ?? '').split('\n')[0]));
  if (failedAttempts.length > 1 && distinct.size > 1) {
    signals.push({ classification: 'flaky', weight: 2, description: 'Retries failed with different errors', match: null });
  }

  const text = allErrorText(test);
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) {
      signals.push({ classification: rule.classification, weight: rule.weight, description: rule.description, match: excerptAround(text, m.index, m[0].length) });
    }
  }
  return signals;
}

export interface HeuristicVerdict {
  classification: Classification;
  confidence: number;
  rationale: string;
  signals: Signal[];
}

/** Highest-scoring class wins; confidence reflects the margin and never exceeds 0.7. */
export function classifyHeuristically(test: FailedTest): HeuristicVerdict {
  const signals = signalsFor(test);
  if (signals.length === 0) {
    return { classification: 'unknown', confidence: 0.2, rationale: `No known failure pattern matched "${headline(test)}".`, signals };
  }
  const scores = new Map<Signal['classification'], number>();
  for (const s of signals) scores.set(s.classification, (scores.get(s.classification) ?? 0) + s.weight);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestClass, best] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  if (best === second) {
    return {
      classification: 'unknown',
      confidence: 0.25,
      rationale: `Conflicting signals (${ranked.map(([c, s]) => `${c}=${s}`).join(', ')}).`,
      signals,
    };
  }
  const confidence = Math.max(0.25, Math.min(0.7, 0.3 + 0.08 * best - 0.06 * second));
  const top = signals.filter((s) => s.classification === bestClass).map((s) => s.description);
  return { classification: bestClass, confidence: Number(confidence.toFixed(2)), rationale: `Heuristic: ${top.join('; ')}.`, signals };
}
