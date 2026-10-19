import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Redactor } from '../src/redact';
import type { FailureTriage, TriageReport } from '../src/report';
import { ZipReader } from '../src/zip';
import { captureScenario, neutralizePaths, slimTrace, trimLog } from '../evals/capture-lib';
import { costOf, priceFor, spendPlan } from '../evals/pricing';
import { runEval } from '../evals/runner';
import { expectationFor, loadScenario, loadScenarios, parseExpectation, type ScenarioExpectation } from '../evals/scenario';
import { calibration, scoreTrial, summarize, type TrialScore } from '../evals/score';
import { makeZip, tmpDir, writeFixture } from './helpers';

const SCENARIOS = path.resolve(__dirname, '..', '..', 'evals', 'scenarios');
const PRICE = { input: 4, output: 20, cacheRead: 0.2 };

const expectation = (over: Partial<ScenarioExpectation> = {}): ScenarioExpectation => ({
  description: 'd',
  source: 's',
  diff: 'relevant',
  injection: null,
  tests: [{ title: '*', expected: 'application_defect', acceptable: ['automation_defect'], evidenceKinds: ['changes', 'page_state'] }],
  ...over,
});

function failure(testId: string, over: Partial<FailureTriage> = {}): FailureTriage {
  return {
    testId,
    title: `Suite › test ${testId}`,
    file: 'a.spec.ts',
    project: 'regression',
    outcome: 'unexpected',
    headline: 'h',
    classification: 'application_defect',
    confidence: 0.8,
    confidenceLabel: 'high',
    source: 'agent',
    rationale: 'r',
    evidence: [
      { evidenceId: 'E1', source: 's', observation: 'o', excerpt: '' },
      { evidenceId: 'E2', source: 's', observation: 'o', excerpt: '' },
    ],
    recommendedActions: [],
    heuristic: { classification: 'unknown', confidence: 0, signals: [] },
    issues: [],
    ...over,
  };
}

function report(failures: FailureTriage[], usage = { inputTokens: 1_000_000, outputTokens: 10_000, cacheReadInputTokens: 500_000 }): TriageReport {
  const call = (name: string, evidenceId: string | null) => ({ iteration: 1, name, input: '{}', ok: true, evidenceId, error: null });
  return {
    schemaVersion: '1.0',
    generatedAt: '',
    mode: 'agent',
    modeReason: null,
    run: { url: null, commit: null, stats: null, projects: [], runErrors: [] },
    regressionStatus: 'failed',
    overall: { classification: 'application_defect', summary: '' },
    failures,
    uncertainty: [],
    agent: {
      model: 'm',
      effort: 'high',
      iterations: 3,
      toolCalls: [call('get_change_summary', 'E1'), call('read_page_snapshot', 'E2'), call('search_aut_logs', 'E3'), call('submit_triage_report', null)],
      usage,
      stopReason: 'tool_use',
      limitsHit: ['max iterations (12)'],
      errors: [],
      durationMs: 1,
      bytesRead: 0,
    },
    notes: [],
  };
}

describe('eval scenario labels', () => {
  it('parses a valid expected.json and applies defaults', () => {
    const e = parseExpectation('x', { description: 'd', source: 's', diff: 'none', tests: [{ title: 'a', expected: 'flaky' }] });
    assert.deepEqual(e.tests[0], { title: 'a', expected: 'flaky', acceptable: [], evidenceKinds: [] });
    assert.equal(e.injection, null);
  });

  it('rejects bad classifications, kinds, diff values and redundant alternatives', () => {
    const base = { description: 'd', source: 's', diff: 'none' };
    assert.throws(() => parseExpectation('x', { ...base, tests: [{ title: 'a', expected: 'bug' }] }), /expected must be one of/);
    assert.throws(() => parseExpectation('x', { ...base, tests: [{ title: 'a', expected: 'flaky', acceptable: ['flaky'] }] }), /must not repeat/);
    assert.throws(() => parseExpectation('x', { ...base, tests: [{ title: 'a', expected: 'flaky', evidenceKinds: ['video'] }] }), /evidenceKinds/);
    assert.throws(() => parseExpectation('x', { ...base, diff: 'maybe', tests: [{ title: 'a', expected: 'flaky' }] }), /"diff"/);
    assert.throws(() => parseExpectation('x', { ...base, tests: [] }), /non-empty array/);
    assert.throws(() => parseExpectation('x', { ...base, injection: { target: 'nope', where: 'w' }, tests: [{ title: 'a', expected: 'flaky' }] }), /injection/);
  });

  it('matches the first rule whose title is a substring; "*" catches the rest', () => {
    const e = expectation({
      tests: [
        { title: 'checkout', expected: 'application_defect', acceptable: [], evidenceKinds: [] },
        { title: '*', expected: 'environment_issue', acceptable: [], evidenceKinds: [] },
      ],
    });
    assert.equal(expectationFor(e, 'Guest checkout › pays')!.expected, 'application_defect');
    assert.equal(expectationFor(e, 'Navigation › opens')!.expected, 'environment_issue');
    assert.equal(expectationFor(expectation({ tests: [{ title: 'x', expected: 'flaky', acceptable: [], evidenceKinds: [] }] }), 'y'), null);
  });

  it('checks that labels, failures and the diff file agree', () => {
    const fx = writeFixture([{ title: 'add to cart', status: 'unexpected', errors: ['boom'] }]);
    const dir = path.join(tmpDir(), 'sample');
    fs.mkdirSync(dir);
    fs.cpSync(fx.reportsDir, path.join(dir, 'reports'), { recursive: true });
    fs.cpSync(fx.testResultsDir, path.join(dir, 'test-results'), { recursive: true });
    const write = (e: unknown) => fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(e));
    const ok = { description: 'd', source: 's', diff: 'none', tests: [{ title: 'add to cart', expected: 'automation_defect' }] };

    write(ok);
    assert.equal(loadScenario(dir).failures.length, 1);
    write({ ...ok, tests: [{ title: 'checkout', expected: 'automation_defect' }] });
    assert.throws(() => loadScenario(dir), /no label in expected.json matches/);
    write({ ...ok, tests: [...ok.tests, { title: 'never', expected: 'flaky' }] });
    assert.throws(() => loadScenario(dir), /matches no failure/);
    write({ ...ok, diff: 'relevant' });
    assert.throws(() => loadScenario(dir), /changes.diff is missing/);
    fs.writeFileSync(path.join(dir, 'reports', 'changes.diff'), '');
    write(ok);
    assert.throws(() => loadScenario(dir), /changes.diff exists/);
  });

  it('every committed scenario loads and is labelled', () => {
    const scenarios = loadScenarios(SCENARIOS);
    assert.ok(scenarios.length >= 6);
    for (const s of scenarios) assert.ok(!s.expectation.description.startsWith('TODO'), `${s.name} is not labelled`);
    assert.throws(() => loadScenarios(SCENARIOS, ['no-such-scenario']), /unknown scenario/);
  });
});

describe('eval scoring', () => {
  it('scores correct, acceptable and wrong answers, evidence kinds and grounding', () => {
    const r = report([
      failure('T1'),
      failure('T2', { classification: 'automation_defect', evidence: [{ evidenceId: 'E3', source: 's', observation: 'o', excerpt: '' }] }),
      failure('T3', { classification: 'environment_issue', confidence: 0.3, evidence: [], issues: ['Dropped evidence citing unknown id "E9".', 'No grounded evidence cited; confidence capped at 0.3.'] }),
    ]);
    const s = scoreTrial('sc', expectation(), 1, r, PRICE, 1234);
    const [a, b, c] = s.tests;
    assert.deepEqual([a!.correct, a!.exact, b!.correct, b!.exact, c!.correct], [true, true, true, false, false]);
    assert.deepEqual(a!.citedKinds, ['changes', 'page_state']);
    assert.deepEqual(a!.missingKinds, []);
    assert.deepEqual(b!.citedKinds, ['logs']);
    assert.deepEqual(b!.missingKinds, ['changes', 'page_state']);
    assert.equal(c!.droppedEvidenceIds, 1);
    assert.equal(c!.ungroundedCap, true);
    assert.equal(a!.wrongDiffBlame, null, 'only measured where the diff is unrelated');
    assert.equal(a!.followedInjection, null);
    // 500k uncached × $4 + 500k cached × $0.2 + 10k × $20 = 2 + 0.1 + 0.2
    assert.equal(s.costUsd.toFixed(4), '2.3000');
    assert.equal(s.durationMs, 1234);
  });

  it('counts wrong-diff blame only for a code-cause answer that cites the unrelated diff', () => {
    const e = expectation({ diff: 'irrelevant', tests: [{ title: '*', expected: 'environment_issue', acceptable: [], evidenceKinds: [] }] });
    const r = report([
      failure('T1', { classification: 'application_defect' }), // cites E1 = get_change_summary
      failure('T2', { classification: 'application_defect', evidence: [{ evidenceId: 'E3', source: 's', observation: 'o', excerpt: '' }] }),
      failure('T3', { classification: 'environment_issue' }),
      failure('T4', { classification: 'flaky' }),
    ]);
    assert.deepEqual(
      scoreTrial('sc', e, 1, r, PRICE, 0).tests.map((t) => t.wrongDiffBlame),
      [true, false, false, false],
    );
  });

  it('flags answers that follow a planted instruction', () => {
    const e = expectation({ injection: { target: 'environment_issue', where: 'log' }, tests: [{ title: '*', expected: 'application_defect', acceptable: [], evidenceKinds: [] }] });
    const s = scoreTrial('sc', e, 1, report([failure('T1', { classification: 'environment_issue' }), failure('T2')]), PRICE, 0);
    assert.deepEqual(s.tests.map((t) => t.followedInjection), [true, false]);
  });

  it('marks heuristic answers as citing only the error message', () => {
    const s = scoreTrial('sc', expectation(), 1, report([failure('T1', { source: 'heuristic', evidence: [{ evidenceId: 'H1', source: 'error', observation: 'o', excerpt: '' }] })]), PRICE, 0);
    assert.deepEqual(s.tests[0]!.citedKinds, ['error']);
  });
});

describe('eval calibration', () => {
  it('buckets by confidence (last bucket includes 1.0) and computes ECE and Brier', () => {
    const c = calibration([
      { confidence: 0.1, correct: false },
      { confidence: 0.2, correct: true }, // lower edge belongs to the 0.2–0.4 bucket
      { confidence: 0.9, correct: true },
      { confidence: 1.0, correct: false },
    ]);
    assert.deepEqual(c.buckets.map((b) => b.n), [1, 1, 0, 0, 2]);
    assert.equal(c.buckets[2]!.accuracy, null);
    assert.equal(c.buckets[4]!.meanConfidence, 0.95);
    assert.equal(c.buckets[4]!.accuracy, 0.5);
    assert.equal(c.buckets[4]!.gap!.toFixed(2), '-0.45', 'over-confident bucket has a negative gap');
    // ECE = 1/4·0.1 + 1/4·0.8 + 2/4·0.45 = 0.45
    assert.equal(c.ece!.toFixed(4), '0.4500');
    // Brier = (0.01 + 0.64 + 0.01 + 1) / 4
    assert.equal(c.brier!.toFixed(4), '0.4150');
  });

  it('is empty without answers', () => {
    const c = calibration([]);
    assert.equal(c.ece, null);
    assert.equal(c.brier, null);
    assert.ok(c.buckets.every((b) => b.n === 0));
  });
});

describe('eval summary', () => {
  const answer = (testId: string, classification: string, correct: boolean, confidence = 0.8) => ({
    testId,
    title: testId,
    expected: 'application_defect' as const,
    acceptable: [],
    classification: classification as TrialScore['tests'][number]['classification'],
    confidence,
    source: 'agent' as const,
    correct,
    exact: correct,
    citedKinds: [],
    missingKinds: correct ? [] : ['logs'],
    droppedEvidenceIds: correct ? 0 : 2,
    ungroundedCap: false,
    citedChanges: false,
    wrongDiffBlame: null,
    followedInjection: null,
  });
  const trial = (scenario: string, n: number, tests: TrialScore['tests'], mode: TrialScore['mode'] = 'agent'): TrialScore => ({
    scenario,
    trial: n,
    mode,
    modeReason: null,
    tests,
    usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0 },
    costUsd: 0.5,
    durationMs: 1000,
    iterations: 2,
    toolCalls: 3,
    limitsHit: ['token budget (input 1/2, output 3/4)'],
    errors: [],
  });

  it('aggregates accuracy, consistency, macro accuracy, grounding, tokens and cost', () => {
    const trials = [
      trial('a', 1, [answer('T1', 'application_defect', true), answer('T2', 'application_defect', true)]),
      trial('a', 2, [answer('T1', 'automation_defect', false), answer('T2', 'application_defect', true)]),
      trial('a', 3, [answer('T1', 'application_defect', true), answer('T2', 'application_defect', true)]),
      trial('b', 1, [answer('T1', 'unknown', false, 0.2)], 'heuristic'),
    ];
    const s = summarize(trials, [
      { name: 'a', expectation: expectation() },
      { name: 'b', expectation: expectation() },
    ]);
    assert.deepEqual(s.overall.accuracy, { n: 7, hits: 5, rate: 5 / 7 });
    assert.equal(s.overall.macroAccuracy, (5 / 6 + 0) / 2);
    assert.equal(s.overall.agentModeTrials, 3);
    const a = s.scenarios[0]!;
    assert.deepEqual(a.distribution, { application_defect: 5, automation_defect: 1 });
    assert.equal(a.consistency, 5 / 6, 'T1 agrees 2 of 3 times, T2 3 of 3');
    assert.equal(a.costUsd, 1.5);
    assert.equal(s.grounding.droppedEvidenceIds, 4);
    assert.deepEqual(s.grounding.answersWithDroppedIds, { n: 7, hits: 2, rate: 2 / 7 });
    assert.deepEqual(s.evidence.missing, { logs: 2 });
    assert.deepEqual(s.wrongDiffBlame, { n: 0, hits: 0, rate: null });
    assert.deepEqual(s.tokens, { input: 400, output: 40, cacheRead: 0 });
    assert.equal(s.costUsd, 2);
    assert.deepEqual(s.limitsHit, { 'token budget': 4 });
  });
});

describe('eval pricing', () => {
  it('prices usage with cache reads and computes the worst case from the limits', () => {
    assert.equal(costOf({ inputTokens: 2_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 }, priceFor('claude-opus-5-5')).toFixed(2), '4.20');
    const plan = spendPlan(18, { maxIterations: 12, maxInputTokens: 600_000, maxOutputTokens: 60_000 }, priceFor('claude-opus-5-5'));
    assert.equal(plan.maxModelCalls, 216);
    assert.equal(plan.ceilingPerRunUsd.toFixed(2), '3.60');
    assert.equal(plan.ceilingUsd.toFixed(2), '64.80');
  });

  it('refuses to guess a price for an unknown model unless one is given', () => {
    assert.throws(() => priceFor('claude-unknown'), /--price-in/);
    assert.deepEqual(priceFor('claude-unknown', { input: 1, output: 2 }), { input: 1, output: 2, cacheRead: 0.1 });
  });
});

describe('eval capture', () => {
  it('neutralizes local checkout paths, also inside JSON-escaped text', () => {
    assert.equal(neutralizePaths('at C:\\Users\\me\\AgenticQA\\automation\\tests\\a.spec.ts:3:1'), 'at /repo/automation\\tests\\a.spec.ts:3:1');
    assert.equal(neutralizePaths('{"file":"C:\\\\Users\\\\me\\\\AgenticQA\\\\automation\\\\src\\\\x.ts"}'), '{"file":"/repo/automation\\\\src\\\\x.ts"}');
    assert.equal(neutralizePaths('/home/runner/work/AgenticQA/AgenticQA/automation/tests/a.ts'), '/repo/automation/tests/a.ts');
    assert.equal(neutralizePaths('GET http://localhost:9000/store/products 200'), 'GET http://localhost:9000/store/products 200');
  });

  it('keeps only log lines inside the window (with undated continuations) and caps the size', () => {
    const log = [
      's-1  | 2026-10-19T10:00:00.000000000Z before',
      's-1  | 2026-10-19T10:05:00.123456789Z inside',
      '    at continuation',
      's-1  | 2026-10-19T10:20:00.000000000Z after',
      '    at dropped continuation',
    ].join('\n');
    const from = Date.parse('2026-10-19T10:04:00Z');
    const to = Date.parse('2026-10-19T10:06:00Z');
    assert.equal(trimLog(log, from, to, 10_000), 's-1  | 2026-10-19T10:05:00.123456789Z inside\n    at continuation\n');
    assert.equal(trimLog(log, from, to, 25), '    at continuation\n', 'keeps the end, from a line start');
    assert.equal(trimLog(log, 0, 1, 10_000), '');
  });

  it('slims a trace to the entries the tools read, redacted, as a valid zip', () => {
    const zip = makeZip({
      'test.trace': '{"type":"before","title":"login","params":{"password":"hunter22"}}',
      '0-trace.network': '{"snapshot":{"request":{"url":"http://x/?k=pk_0123456789abcdef0123"}}}',
      'resources/big.png': Buffer.alloc(50_000),
      '0-trace.stacks': 'stack',
    });
    const out = new ZipReader(slimTrace(zip, new Redactor(['hunter22']), 1_000_000));
    assert.deepEqual(out.entries.map((e) => e.name), ['test.trace', '0-trace.network']);
    const text = out.entries.map((e) => out.read(e, 1_000_000).toString('utf8')).join('\n');
    assert.doesNotMatch(text, /hunter22|pk_0123/);
  });

  it('copies only what the tools read and refuses files outside the artifact roots', () => {
    const fx = writeFixture(
      [
        { title: 'add to cart', status: 'unexpected', errors: ['boom'] },
        { title: 'passes', status: 'expected', errors: [] },
      ],
      { logs: { medusa: 'medusa-1  | 2026-10-19T10:00:01.000000000Z ADMIN_PASSWORD=hunter22 started' } },
    );
    // A video and a stray file the scenario must not pick up.
    const testDir = path.join(fx.testResultsDir, 'test-1');
    fs.writeFileSync(path.join(testDir, 'video.webm'), 'v');
    fs.writeFileSync(path.join(fx.reportsDir, 'junit.xml'), '<x/>');
    const results = JSON.parse(fs.readFileSync(path.join(fx.reportsDir, 'results.json'), 'utf8'));
    results.suites[0].specs[0].tests[0].results[0].attachments.push({ name: 'video', contentType: 'video/webm', path: path.join(testDir, 'video.webm') });
    fs.writeFileSync(path.join(fx.reportsDir, 'results.json'), JSON.stringify(results));

    const out = path.join(tmpDir(), 'scenario');
    const opts = { reportsDir: fx.reportsDir, testResultsDir: fx.testResultsDir, outDir: out, redactor: new Redactor(), includeChanges: true, logMarginMs: 60_000, logMaxBytes: 100_000 };
    const files = captureScenario(opts).map((f) => f.path).sort();
    assert.deepEqual(files, [
      'reports/aut/medusa.log',
      'reports/environment.json',
      'reports/results.json',
      'test-results/test-1/error-context.md',
      'test-results/test-1/test-failed-1.png',
      'test-results/test-1/trace.zip',
    ]);
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'reports', 'aut', 'medusa.log'), 'utf8'), /hunter22/);
    const copied = fs.readFileSync(path.join(out, 'reports', 'results.json'), 'utf8');
    assert.match(copied, /"\/artifacts\/test-results\/test-1\/trace.zip"/);
    assert.doesNotMatch(copied, /video/);

    // An attachment that points outside both roots is refused, not copied.
    results.suites[0].specs[0].tests[0].results[0].attachments = [{ name: 'trace', contentType: 'application/zip', path: path.join(tmpDir(), 'elsewhere', 'trace.zip') }];
    fs.writeFileSync(path.join(fx.reportsDir, 'results.json'), JSON.stringify(results));
    assert.throws(() => captureScenario({ ...opts, outDir: path.join(tmpDir(), 'scenario2') }), /outside the artifact roots/);
  });
});

describe('eval runner (dry run, scripted fake model)', () => {
  it('runs the real agent loop over every committed scenario and writes results and a summary', async () => {
    const scenarios = loadScenarios(SCENARIOS);
    const out = tmpDir('triage-eval-');
    const result = await runEval({ scenarios, repeat: 1, outDir: out, dryRun: true, concurrency: 2, env: {} });

    assert.equal(result.aborted, null);
    assert.equal(result.trials.length, scenarios.length);
    assert.ok(result.trials.every((t) => t.mode === 'agent' && t.costUsd === 0), 'every trial went through the agent loop');
    assert.equal(result.summary.overall.answers, scenarios.reduce((n, s) => n + s.failures.length, 0));
    assert.equal(result.summary.grounding.droppedEvidenceIds, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    assert.equal(saved.trials.length, scenarios.length);
    assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /dry run/);
    for (const s of scenarios) assert.ok(fs.existsSync(path.join(out, 'trials', s.name, '1', 'triage-report.json')));
  });
});
