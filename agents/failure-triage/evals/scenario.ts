import fs from 'node:fs';
import path from 'node:path';
import { CLASSIFICATIONS, type Classification } from '../src/heuristics';
import { parseResults, type FailedTest } from '../src/playwright-results';

/**
 * A scenario is a frozen copy of the artifacts one regression run left behind, laid out the way the
 * agent reads them, plus the labels the eval scores against:
 *
 *   evals/scenarios/<name>/
 *     expected.json
 *     reports/results.json, environment.json, changes.diff (optional), aut/*.log, aut/compose-ps.txt
 *     test-results/<test>/trace.zip, error-context.md, test-failed-1.png
 */

/** Evidence kinds as reported by `evidenceKind()` in src/report.ts. */
export const EVIDENCE_KINDS = ['error', 'page_state', 'trace', 'logs', 'environment', 'changes'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ExpectedTest {
  /** Substring of the full test title ("Describe › test"), or "*" for every failure not matched earlier. */
  title: string;
  expected: Classification;
  /** Other answers that also count as correct (scored as correct, not as exact). */
  acceptable: Classification[];
  /** Evidence kinds a good answer should cite. Reported as coverage, not used for correctness. */
  evidenceKinds: EvidenceKind[];
}

export interface ScenarioExpectation {
  description: string;
  /** How the artifacts were produced (run, commit, what was changed temporarily). */
  source: string;
  /**
   * Whether reports/changes.diff exists and is related to the failure. "irrelevant" scenarios
   * measure wrong-diff-blame: blaming an unrelated change for the failure.
   */
  diff: 'relevant' | 'irrelevant' | 'none';
  /** Set when an artifact carries a planted instruction; `target` is the classification it asks for. */
  injection: { target: Classification; where: string } | null;
  tests: ExpectedTest[];
}

export interface Scenario {
  name: string;
  dir: string;
  reportsDir: string;
  testResultsDir: string;
  expectation: ScenarioExpectation;
  /** Failures as the agent will see them (same parser, same ids). */
  failures: FailedTest[];
}

export class ScenarioError extends Error {
  constructor(scenario: string, message: string) {
    super(`scenario "${scenario}": ${message}`);
    this.name = 'ScenarioError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isClassification = (v: unknown): v is Classification => (CLASSIFICATIONS as readonly unknown[]).includes(v);

export function parseExpectation(name: string, raw: unknown): ScenarioExpectation {
  const fail = (m: string): never => {
    throw new ScenarioError(name, `expected.json: ${m}`);
  };
  if (!isObj(raw)) fail('must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.description !== 'string' || !r.description.trim()) fail('"description" must be a non-empty string');
  if (typeof r.source !== 'string' || !r.source.trim()) fail('"source" must be a non-empty string');
  if (r.diff !== 'relevant' && r.diff !== 'irrelevant' && r.diff !== 'none') fail('"diff" must be "relevant", "irrelevant" or "none"');

  let injection: ScenarioExpectation['injection'] = null;
  if (r.injection !== undefined && r.injection !== null) {
    if (!isObj(r.injection) || !isClassification(r.injection.target) || typeof r.injection.where !== 'string') {
      fail('"injection" must be {target: <classification>, where: <string>}');
    }
    const inj = r.injection as Record<string, unknown>;
    injection = { target: inj.target as Classification, where: inj.where as string };
  }

  if (!Array.isArray(r.tests) || r.tests.length === 0) fail('"tests" must be a non-empty array');
  const tests = (r.tests as unknown[]).map((t, i): ExpectedTest => {
    const at = `tests[${i}]`;
    if (!isObj(t)) return fail(`${at} must be an object`);
    if (typeof t.title !== 'string' || !t.title.trim()) fail(`${at}.title must be a non-empty string`);
    if (!isClassification(t.expected)) fail(`${at}.expected must be one of ${CLASSIFICATIONS.join(', ')}`);
    const acceptable = t.acceptable ?? [];
    if (!Array.isArray(acceptable) || !acceptable.every(isClassification)) fail(`${at}.acceptable must be an array of classifications`);
    if ((acceptable as Classification[]).includes(t.expected as Classification)) fail(`${at}.acceptable must not repeat the expected classification`);
    const kinds = t.evidenceKinds ?? [];
    if (!Array.isArray(kinds) || !kinds.every((k) => (EVIDENCE_KINDS as readonly unknown[]).includes(k))) {
      fail(`${at}.evidenceKinds must be an array of ${EVIDENCE_KINDS.join(', ')}`);
    }
    return { title: t.title as string, expected: t.expected as Classification, acceptable: acceptable as Classification[], evidenceKinds: kinds as EvidenceKind[] };
  });
  return { description: r.description as string, source: r.source as string, diff: r.diff as ScenarioExpectation['diff'], injection, tests };
}

/** The label for a failure: the first rule whose title is a substring of the test title ("*" matches anything). */
export function expectationFor(expectation: ScenarioExpectation, title: string): ExpectedTest | null {
  return expectation.tests.find((t) => t.title === '*' || title.includes(t.title)) ?? null;
}

/** Loads one scenario and checks that the labels and the artifacts agree. */
export function loadScenario(dir: string): Scenario {
  const name = path.basename(dir);
  const expectedFile = path.join(dir, 'expected.json');
  if (!fs.existsSync(expectedFile)) throw new ScenarioError(name, 'expected.json is missing');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  } catch (e) {
    throw new ScenarioError(name, `expected.json is not valid JSON: ${(e as Error).message}`);
  }
  const expectation = parseExpectation(name, raw);

  const reportsDir = path.join(dir, 'reports');
  const testResultsDir = path.join(dir, 'test-results');
  const resultsFile = path.join(reportsDir, 'results.json');
  if (!fs.existsSync(resultsFile)) throw new ScenarioError(name, 'reports/results.json is missing');
  const parsed = parseResults(fs.readFileSync(resultsFile, 'utf8'));
  if (parsed.failures.length === 0) throw new ScenarioError(name, 'results.json has no failed or flaky tests');

  const hasDiff = fs.existsSync(path.join(reportsDir, 'changes.diff'));
  if (expectation.diff === 'none' && hasDiff) throw new ScenarioError(name, 'diff is "none" but reports/changes.diff exists');
  if (expectation.diff !== 'none' && !hasDiff) throw new ScenarioError(name, `diff is "${expectation.diff}" but reports/changes.diff is missing`);

  for (const f of parsed.failures) {
    if (!expectationFor(expectation, f.title)) throw new ScenarioError(name, `no label in expected.json matches failure "${f.title}"`);
  }
  for (const rule of expectation.tests) {
    if (!parsed.failures.some((f) => expectationFor(expectation, f.title) === rule)) {
      throw new ScenarioError(name, `label "${rule.title}" matches no failure in results.json`);
    }
  }
  return { name, dir, reportsDir, testResultsDir, expectation, failures: parsed.failures };
}

/** All scenarios under `root` (sorted by name), optionally only the named ones. */
export function loadScenarios(root: string, only: string[] = []): Scenario[] {
  if (!fs.existsSync(root)) throw new Error(`scenario folder not found: ${root}`);
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const unknown = only.filter((n) => !names.includes(n));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')} (available: ${names.join(', ')})`);
  return names.filter((n) => only.length === 0 || only.includes(n)).map((n) => loadScenario(path.join(root, n)));
}
