import { classifyHeuristically } from '../heuristics';
import { allErrorText, type FailedTest, type ParsedResults } from '../playwright-results';
import type { TriageReport } from '../report';
import {
  extractFailingLocator,
  findTestIdInSource,
  isLocatorNotFound,
  isStrictModeViolation,
  scopeTestIdFor,
  usageOf,
  type FailingLocator,
  type LocatorUsage,
  type SourceLocation,
} from './locators';
import type { RepoSandbox } from './repo';

/** Minimum triage confidence for a failure to be considered for repair. */
export const HEAL_MIN_TRIAGE_CONFIDENCE = 0.7;

export interface HealEnvironment {
  eventName: string | null;
  /** owner/name of the repository the workflow runs in. */
  repository: string | null;
  /** owner/name of the PR head repository (pull_request events). */
  headRepository: string | null;
  /** Branch that failed (PR head ref, or the pushed branch). */
  branch: string | null;
}

export interface HealPlan {
  failing: FailingLocator;
  location: SourceLocation;
  /** Test id of the container the locator is scoped to, if any. */
  scope: string | null;
  usage: LocatorUsage;
  /** Failures caused by this locator (same ids as the triage report). */
  tests: FailedTest[];
  /** Other locator failures left for a later run (one repair per run). */
  deferred: Array<{ testId: string; tests: string[] }>;
}

export type GateResult = { eligible: true; plan: HealPlan; notes: string[] } | { eligible: false; reason: string; notes: string[] };

const no = (reason: string, notes: string[] = []): GateResult => ({ eligible: false, reason, notes });

/**
 * Deterministic pre-conditions for self-heal. Nothing here calls a model; every refusal carries a
 * reason that ends up in the job summary.
 */
export function evaluateGate(
  report: TriageReport,
  parsed: ParsedResults,
  repo: RepoSandbox,
  env: HealEnvironment,
  hasDomSnapshot: (test: FailedTest) => boolean,
): GateResult {
  const notes: string[] = [];
  if (report.mode !== 'agent') return no(`triage ran in "${report.mode}" mode; self-heal acts only on an AI triage verdict (${report.modeReason ?? 'no reason given'})`);
  if (env.branch?.startsWith('aqa-heal/')) return no('this run is on a self-heal branch; healing a heal branch is not allowed (loop prevention)');
  if (env.eventName === 'pull_request' && env.headRepository && env.repository && env.headRepository !== env.repository) {
    return no('pull request from a fork: self-heal never runs with write access for fork code');
  }
  if (report.failures.some((f) => f.classification === 'environment_issue')) {
    return no('triage found an environment issue in this run; validation results would not be trustworthy');
  }

  const byId = new Map(parsed.failures.map((t) => [t.id, t]));
  const groups = new Map<string, { locator: FailingLocator; tests: FailedTest[] }>();
  for (const f of report.failures) {
    if (f.classification !== 'automation_defect') continue;
    if (f.source !== 'agent' || f.confidence < HEAL_MIN_TRIAGE_CONFIDENCE) {
      notes.push(`${f.testId}: automation defect but confidence ${f.confidence.toFixed(2)} (${f.source}) is below ${HEAL_MIN_TRIAGE_CONFIDENCE}`);
      continue;
    }
    const test = byId.get(f.testId);
    if (!test || test.title !== f.title) {
      notes.push(`${f.testId}: not found in results.json`);
      continue;
    }
    if (test.outcome !== 'unexpected' || test.attempts.some((a) => a.status === 'passed')) {
      notes.push(`${f.testId}: passed on a retry (flaky); not a stable locator failure`);
      continue;
    }
    const text = allErrorText(test);
    if (isStrictModeViolation(text)) {
      notes.push(`${f.testId}: strict-mode violation (locator matches several elements); needs scoping, which self-heal does not do`);
      continue;
    }
    if (!isLocatorNotFound(text)) {
      notes.push(`${f.testId}: error is not a "locator not found" failure`);
      continue;
    }
    const locator = extractFailingLocator(text);
    if (!locator) {
      notes.push(`${f.testId}: failing locator is not a getByTestId locator (only test-id repairs are supported)`);
      continue;
    }
    const g = groups.get(locator.testId) ?? { locator, tests: [] };
    g.tests.push(test);
    groups.set(locator.testId, g);
  }
  if (groups.size === 0) return no('no failure qualifies: self-heal needs an AI-classified automation defect (confidence ≥ 0.7) caused by a missing getByTestId locator', notes);

  // One repair per run: the locator behind the most failures.
  const ranked = [...groups.values()].sort((a, b) => b.tests.length - a.tests.length);
  const chosen = ranked[0]!;
  const deferred = ranked.slice(1).map((g) => ({ testId: g.locator.testId, tests: g.tests.map((t) => t.id) }));

  // A "missing element" can be a symptom of an unhealthy app (e.g. a backend outage leaves a list
  // empty). If any other failure in the run points to the application or environment, do not heal.
  const grouped = new Set([...groups.values()].flatMap((g) => g.tests.map((t) => t.id)));
  const unhealthy = parsed.failures
    .filter((t) => !grouped.has(t.id))
    .map((t) => {
      const verdict = report.failures.find((f) => f.testId === t.id)?.classification;
      const h = classifyHeuristically(t);
      const bad = (c: string | undefined) => c === 'application_defect' || c === 'environment_issue';
      return bad(verdict) ? `${t.id} classified ${verdict}` : bad(h.classification) ? `${t.id} shows ${h.classification} signals (${h.signals.map((s) => s.description).join('; ')})` : null;
    })
    .filter((x): x is string => x !== null);
  if (unhealthy.length) {
    return no(`other failures in this run point to an unhealthy application or environment, so a missing element may be a symptom, not a stale locator: ${unhealthy.join('; ')}`, notes);
  }

  const locations = findTestIdInSource(repo, chosen.locator.testId);
  const editable = locations.filter((l) => l.editable);
  if (locations.length > 0 && editable.length === 0) {
    return no(`getByTestId('${chosen.locator.testId}') appears only in intentionally broken diagnostics scenarios, which are never repaired`, notes);
  }
  if (editable.length === 0) return no(`getByTestId('${chosen.locator.testId}') was not found in automation/src/pages or automation/tests`, notes);
  if (locations.length > 1) {
    return no(`getByTestId('${chosen.locator.testId}') is defined in ${locations.length} places; a one-line repair would leave the others broken (consolidate it into a page object first)`, notes);
  }
  const location = editable[0]!;

  const withSnapshot = chosen.tests.filter(hasDomSnapshot);
  if (withSnapshot.length === 0) return no('none of the affected tests has a DOM snapshot in its trace; the replacement could not be verified', notes);

  return {
    eligible: true,
    plan: { failing: chosen.locator, location, scope: scopeTestIdFor(repo, location), usage: usageOf(repo, location), tests: chosen.tests, deferred },
    notes,
  };
}
