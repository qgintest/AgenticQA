import { CLASSIFICATIONS, classifyHeuristically, type Classification, type Signal } from './heuristics';
import type { EvidenceStore } from './evidence';
import { headline, type FailedTest, type ParsedResults } from './playwright-results';
import type { Redactor } from './redact';

export const REPORT_SCHEMA_VERSION = '1.0';

export type ReportMode = 'agent' | 'heuristic' | 'no_results' | 'no_failures';
export type ConfidenceLabel = 'high' | 'medium' | 'low';

export interface ReportEvidence {
  evidenceId: string;
  source: string;
  observation: string;
  excerpt: string;
}

export interface FailureTriage {
  testId: string;
  title: string;
  file: string;
  project: string;
  outcome: 'unexpected' | 'flaky';
  headline: string;
  classification: Classification;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  /** Who produced the classification. */
  source: 'agent' | 'heuristic';
  rationale: string;
  evidence: ReportEvidence[];
  recommendedActions: string[];
  heuristic: { classification: Classification; confidence: number; signals: Array<Pick<Signal, 'classification' | 'weight' | 'description'>> };
  /** Grounding / consistency problems detected in post-validation. */
  issues: string[];
}

export interface ToolCallRecord {
  iteration: number;
  name: string;
  input: string;
  ok: boolean;
  evidenceId: string | null;
  error: string | null;
}

export interface AgentTelemetry {
  model: string;
  effort: string;
  iterations: number;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
  stopReason: string | null;
  limitsHit: string[];
  errors: string[];
  durationMs: number;
  bytesRead: number;
}

export interface TriageReport {
  schemaVersion: string;
  generatedAt: string;
  mode: ReportMode;
  /** Why the run fell back from agent mode (missing key, API error...). */
  modeReason: string | null;
  run: {
    url: string | null;
    commit: string | null;
    stats: ParsedResults['stats'] | null;
    projects: string[];
    runErrors: string[];
  };
  regressionStatus: 'failed' | 'flaky_only' | 'passed' | 'unknown';
  overall: { classification: Classification | 'mixed'; summary: string };
  failures: FailureTriage[];
  uncertainty: string[];
  agent: AgentTelemetry | null;
  notes: string[];
}

// ---------------------------------------------------------------------------------------------
// Validation of the model's `submit_triage_report` input
// ---------------------------------------------------------------------------------------------

export interface SubmittedFailure {
  test_id: string;
  classification: Classification;
  confidence: number;
  rationale: string;
  evidence: Array<{ evidence_id: string; observation: string }>;
  recommended_actions: string[];
}

export interface Submission {
  summary: string;
  failures: SubmittedFailure[];
  uncertainty: string[];
}

export type ValidationResult = { ok: true; value: Submission } | { ok: false; errors: string[] };

const LIMITS = { summary: 1500, rationale: 1500, observation: 400, action: 300, uncertainty: 400, listItems: 8, evidenceItems: 10 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural validation (types, enums, known test ids, sizes). Strict tool schemas already make
 * this unlikely to fail, but the input is still untrusted model output and is checked again here.
 */
export function validateSubmission(input: unknown, knownTestIds: Set<string>): ValidationResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['input must be an object'] };

  const summary = input.summary;
  if (typeof summary !== 'string' || !summary.trim()) errors.push('summary must be a non-empty string');

  const uncertainty = input.uncertainty;
  if (!Array.isArray(uncertainty) || uncertainty.some((u) => typeof u !== 'string')) errors.push('uncertainty must be an array of strings');

  const failures = input.failures;
  if (!Array.isArray(failures)) {
    errors.push('failures must be an array');
  } else {
    const seen = new Set<string>();
    failures.forEach((f, i) => {
      const at = `failures[${i}]`;
      if (!isObj(f)) return void errors.push(`${at} must be an object`);
      if (typeof f.test_id !== 'string' || !knownTestIds.has(f.test_id)) {
        errors.push(`${at}.test_id "${String(f.test_id)}" is not one of: ${[...knownTestIds].join(', ')}`);
      } else if (seen.has(f.test_id)) {
        errors.push(`${at}.test_id ${f.test_id} appears more than once`);
      } else seen.add(f.test_id);
      if (!(CLASSIFICATIONS as readonly unknown[]).includes(f.classification)) errors.push(`${at}.classification must be one of ${CLASSIFICATIONS.join(', ')}`);
      if (typeof f.confidence !== 'number' || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) errors.push(`${at}.confidence must be a number between 0 and 1`);
      if (typeof f.rationale !== 'string' || !f.rationale.trim()) errors.push(`${at}.rationale must be a non-empty string`);
      if (!Array.isArray(f.evidence) || f.evidence.some((e) => !isObj(e) || typeof e.evidence_id !== 'string' || typeof e.observation !== 'string')) {
        errors.push(`${at}.evidence must be an array of {evidence_id, observation}`);
      }
      if (!Array.isArray(f.recommended_actions) || f.recommended_actions.some((a) => typeof a !== 'string')) {
        errors.push(`${at}.recommended_actions must be an array of strings`);
      }
    });
  }
  if (errors.length) return { ok: false, errors };

  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const value: Submission = {
    summary: clip((summary as string).trim(), LIMITS.summary),
    uncertainty: (uncertainty as string[]).slice(0, LIMITS.listItems).map((u) => clip(u, LIMITS.uncertainty)),
    failures: (failures as Record<string, unknown>[]).map((f) => ({
      test_id: f.test_id as string,
      classification: f.classification as Classification,
      confidence: f.confidence as number,
      rationale: clip((f.rationale as string).trim(), LIMITS.rationale),
      evidence: (f.evidence as Array<{ evidence_id: string; observation: string }>)
        .slice(0, LIMITS.evidenceItems)
        .map((e) => ({ evidence_id: e.evidence_id.trim(), observation: clip(e.observation, LIMITS.observation) })),
      recommended_actions: (f.recommended_actions as string[]).slice(0, LIMITS.listItems).map((a) => clip(a, LIMITS.action)),
    })),
  };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------------------------

/** Ungrounded claims can never be reported with more confidence than this. */
export const UNGROUNDED_CONFIDENCE_CAP = 0.3;

/**
 * "High" confidence must be corroborated: above this cap, the cited evidence has to cover at least
 * HIGH_CONFIDENCE_MIN_KINDS kinds of artifact besides the error message itself.
 */
export const UNCORROBORATED_CONFIDENCE_CAP = 0.7;
export const HIGH_CONFIDENCE_MIN_KINDS = 2;

/** Which kind of artifact each tool reads. `error` (results.json) does not count as corroboration. */
const EVIDENCE_KIND: Record<string, string> = {
  list_failed_tests: 'error',
  get_failure_details: 'error',
  read_page_snapshot: 'page_state',
  view_screenshot: 'page_state',
  find_in_dom_snapshot: 'page_state',
  get_trace_summary: 'trace',
  search_aut_logs: 'logs',
  get_run_environment: 'environment',
  get_change_summary: 'changes',
};

/** The kind of artifact a tool reads (`error`, `page_state`, `trace`, `logs`, `environment`, `changes`). */
export function evidenceKind(tool: string): string {
  return EVIDENCE_KIND[tool] ?? 'other';
}

export function corroboratingKinds(tools: string[]): string[] {
  return [...new Set(tools.map(evidenceKind))].filter((k) => k !== 'error').sort();
}

export function confidenceLabel(c: number): ConfidenceLabel {
  return c >= 0.75 ? 'high' : c >= 0.45 ? 'medium' : 'low';
}

const HEURISTIC_ACTIONS: Record<Classification, string[]> = {
  application_defect: ['Reproduce the failing behaviour against the AUT manually or via the API.', 'Compare with the last passing run and recent application changes; file a defect if confirmed.'],
  automation_defect: ['Open the trace and page snapshot to compare the locator/expectation with the current UI.', 'Fix the test or page object; do not change the application to match the test.'],
  environment_issue: ['Check AUT container logs and health around the failure time.', 'Re-run the job; if it persists, investigate the environment (resources, startup, network).'],
  flaky: ['Re-run the test several times (--repeat-each) to measure the failure rate.', 'Look for timing assumptions or shared state; quarantine only with a tracking issue.'],
  unknown: ['Inspect the HTML report, trace and screenshots manually.', 'Add assertions or logging that would make this failure diagnosable next time.'],
};

function baseFailure(test: FailedTest): Omit<FailureTriage, 'classification' | 'confidence' | 'confidenceLabel' | 'source' | 'rationale' | 'evidence' | 'recommendedActions' | 'issues'> {
  const h = classifyHeuristically(test);
  return {
    testId: test.id,
    title: test.title,
    file: test.file,
    project: test.project,
    outcome: test.outcome,
    headline: headline(test),
    heuristic: {
      classification: h.classification,
      confidence: h.confidence,
      signals: h.signals.map(({ classification, weight, description }) => ({ classification, weight, description })),
    },
  };
}

export function heuristicFailure(test: FailedTest, note?: string): FailureTriage {
  const h = classifyHeuristically(test);
  return {
    ...baseFailure(test),
    classification: h.classification,
    confidence: h.confidence,
    confidenceLabel: confidenceLabel(h.confidence),
    source: 'heuristic',
    rationale: h.rationale,
    evidence: h.signals
      .filter((s) => s.match)
      .slice(0, 4)
      .map((s, i) => ({ evidenceId: `H${i + 1}`, source: 'error message (results.json)', observation: s.description, excerpt: s.match ?? '' })),
    recommendedActions: HEURISTIC_ACTIONS[h.classification],
    issues: note ? [note] : [],
  };
}

/** Merge the model's validated submission with deterministic facts and grounding checks. */
export function groundedFailures(submission: Submission, tests: FailedTest[], evidence: EvidenceStore): FailureTriage[] {
  const byId = new Map(submission.failures.map((f) => [f.test_id, f]));
  return tests.map((test) => {
    const sub = byId.get(test.id);
    if (!sub) return heuristicFailure(test, 'The agent did not classify this failure; heuristic result shown.');

    const issues: string[] = [];
    const grounded: ReportEvidence[] = [];
    const citedTools: string[] = [];
    for (const e of sub.evidence) {
      const rec = evidence.get(e.evidence_id);
      if (!rec) {
        issues.push(`Dropped evidence citing unknown id "${e.evidence_id}".`);
        continue;
      }
      citedTools.push(rec.tool);
      grounded.push({ evidenceId: rec.id, source: rec.source, observation: e.observation, excerpt: rec.excerpt });
    }

    let confidence = sub.confidence;
    const kinds = corroboratingKinds(citedTools);
    if (grounded.length === 0) {
      confidence = Math.min(confidence, UNGROUNDED_CONFIDENCE_CAP);
      issues.push(`No grounded evidence cited; confidence capped at ${UNGROUNDED_CONFIDENCE_CAP}.`);
    } else if (confidence > UNCORROBORATED_CONFIDENCE_CAP && kinds.length < HIGH_CONFIDENCE_MIN_KINDS) {
      issues.push(
        `Confidence ${confidence.toFixed(2)} lowered to ${UNCORROBORATED_CONFIDENCE_CAP}: cited evidence covers ` +
          `${kinds.length ? kinds.join(', ') : 'only the error message'}; high confidence needs ${HIGH_CONFIDENCE_MIN_KINDS} kinds besides the error message.`,
      );
      confidence = UNCORROBORATED_CONFIDENCE_CAP;
    }
    const base = baseFailure(test);
    if (test.outcome === 'flaky' && sub.classification !== 'flaky') {
      issues.push('Playwright recorded this test as flaky (passed on retry), but the agent classified it differently.');
    }
    if (base.heuristic.classification !== 'unknown' && base.heuristic.classification !== sub.classification) {
      issues.push(`Heuristic signals point to ${base.heuristic.classification}; review the evidence.`);
    }
    return {
      ...base,
      classification: sub.classification,
      confidence: Number(confidence.toFixed(2)),
      confidenceLabel: confidenceLabel(confidence),
      source: 'agent',
      rationale: sub.rationale,
      evidence: grounded,
      recommendedActions: sub.recommended_actions.length ? sub.recommended_actions : HEURISTIC_ACTIONS[sub.classification],
      issues,
    };
  });
}

export function overallClassification(failures: FailureTriage[]): Classification | 'mixed' {
  const hard = failures.filter((f) => f.outcome === 'unexpected');
  const pool = hard.length ? hard : failures;
  const classes = new Set(pool.map((f) => f.classification));
  if (classes.size === 0) return 'unknown';
  return classes.size === 1 ? [...classes][0]! : 'mixed';
}

export function regressionStatus(parsed: ParsedResults | null): TriageReport['regressionStatus'] {
  if (!parsed) return 'unknown';
  if (parsed.stats.unexpected > 0 || parsed.runErrors.length > 0) return 'failed';
  if (parsed.stats.flaky > 0) return 'flaky_only';
  return 'passed';
}

export function finalizeReport(report: TriageReport, redactor: Redactor): TriageReport {
  return redactor.redactValue(report);
}
