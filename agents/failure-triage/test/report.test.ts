import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvidenceStore } from '../src/evidence';
import type { FailedTest } from '../src/playwright-results';
import { parseResults } from '../src/playwright-results';
import { groundedFailures, overallClassification, regressionStatus, UNGROUNDED_CONFIDENCE_CAP, validateSubmission, type Submission } from '../src/report';
import { mdEscape, mdInline, renderMarkdown, fence } from '../src/render';

const ids = new Set(['T1', 'T2']);
const good = {
  summary: 'One locator is stale.',
  uncertainty: [],
  failures: [{ test_id: 'T1', classification: 'automation_defect', confidence: 0.8, rationale: 'r', evidence: [{ evidence_id: 'E1', observation: 'o' }], recommended_actions: ['fix'] }],
};

function test(id: string, outcome: FailedTest['outcome'] = 'unexpected', message = "locator.click: Timeout 10000ms exceeded.\n  - waiting for getByTestId('x')"): FailedTest {
  return {
    id,
    title: `title ${id}`,
    file: 'a.spec.ts',
    line: 1,
    project: 'regression',
    tags: [],
    outcome,
    attempts: [{ retry: 0, status: 'failed', durationMs: 1, startTime: null, errors: [{ message, stack: null, location: null }], attachments: [], stdout: '', stderr: '' }],
  };
}

describe('validateSubmission', () => {
  it('accepts a well-formed report', () => {
    assert.equal(validateSubmission(good, ids).ok, true);
  });

  it('rejects unknown test ids, bad enums, out-of-range confidence and duplicates', () => {
    const bad = {
      ...good,
      failures: [
        { ...good.failures[0], test_id: 'T9' },
        { ...good.failures[0], test_id: 'T1', classification: 'passed' },
        { ...good.failures[0], test_id: 'T1', confidence: 1.5 },
      ],
    };
    const r = validateSubmission(bad, ids);
    assert.equal(r.ok, false);
    const errors = r.ok ? '' : r.errors.join('\n');
    assert.match(errors, /T9/);
    assert.match(errors, /classification must be one of/);
    assert.match(errors, /confidence must be a number between 0 and 1/);
    assert.match(errors, /more than once/);
  });

  it('rejects non-object and missing fields', () => {
    assert.equal(validateSubmission('nope', ids).ok, false);
    assert.equal(validateSubmission({ failures: [] }, ids).ok, false);
  });

  it('clips oversized text fields', () => {
    const r = validateSubmission({ ...good, summary: 'x'.repeat(10_000) }, ids);
    assert.ok(r.ok && r.value.summary.length <= 1500);
  });
});

describe('grounding', () => {
  const sub = (evidenceId: string, classification = 'automation_defect' as const, confidence = 0.9): Submission => ({
    summary: 's',
    uncertainty: [],
    failures: [{ test_id: 'T1', classification, confidence, rationale: 'r', evidence: [{ evidence_id: evidenceId, observation: 'o' }], recommended_actions: [] }],
  });

  it('keeps cited evidence that the tools actually returned', () => {
    const store = new EvidenceStore();
    store.add('get_failure_details', 'T1', 'results.json: attempts of T1', 'excerpt');
    const [f] = groundedFailures(sub('E1'), [test('T1')], store);
    assert.equal(f!.source, 'agent');
    assert.equal(f!.evidence.length, 1);
    assert.equal(f!.confidence, 0.9);
    assert.equal(f!.confidenceLabel, 'high');
    assert.equal(f!.recommendedActions.length > 0, true, 'falls back to default actions when none given');
  });

  it('drops invented evidence ids and caps confidence', () => {
    const [f] = groundedFailures(sub('E42'), [test('T1')], new EvidenceStore());
    assert.equal(f!.evidence.length, 0);
    assert.equal(f!.confidence, UNGROUNDED_CONFIDENCE_CAP);
    assert.equal(f!.confidenceLabel, 'low');
    assert.ok(f!.issues.some((i) => /unknown id "E42"/.test(i)));
  });

  it('falls back to heuristics for failures the agent skipped', () => {
    const store = new EvidenceStore();
    store.add('x', 'T1', 's', 'e');
    const out = groundedFailures(sub('E1'), [test('T1'), test('T2')], store);
    assert.equal(out[1]!.source, 'heuristic');
    assert.ok(out[1]!.issues[0]!.includes('did not classify'));
  });

  it('flags disagreement with Playwright flaky status and with heuristics', () => {
    const store = new EvidenceStore();
    store.add('x', 'T1', 's', 'e');
    const [f] = groundedFailures(sub('E1', 'application_defect' as never), [test('T1', 'flaky')], store);
    assert.ok(f!.issues.some((i) => i.includes('flaky')));
    assert.ok(f!.issues.some((i) => i.includes('Heuristic signals point to')));
  });
});

describe('overall + regression status', () => {
  it('computes overall classification from hard failures', () => {
    const store = new EvidenceStore();
    const a = groundedFailures(sub2('automation_defect'), [test('T1')], store);
    assert.equal(overallClassification(a), 'automation_defect');
    assert.equal(overallClassification([...a, { ...a[0]!, testId: 'T2', classification: 'environment_issue' }]), 'mixed');
  });

  it('derives regression status from stats, never from triage', () => {
    const base = { config: {}, suites: [], errors: [] };
    assert.equal(regressionStatus(parseResults(JSON.stringify({ ...base, stats: { expected: 3, unexpected: 1, flaky: 0 } }))), 'failed');
    assert.equal(regressionStatus(parseResults(JSON.stringify({ ...base, stats: { expected: 3, unexpected: 0, flaky: 1 } }))), 'flaky_only');
    assert.equal(regressionStatus(parseResults(JSON.stringify({ ...base, errors: [{ message: 'global setup' }], stats: { expected: 0, unexpected: 0 } }))), 'failed');
    assert.equal(regressionStatus(null), 'unknown');
  });
});

function sub2(classification: 'automation_defect'): Submission {
  return { summary: 's', uncertainty: [], failures: [{ test_id: 'T1', classification, confidence: 0.6, rationale: 'r', evidence: [], recommended_actions: [] }] };
}

describe('markdown rendering', () => {
  it('escapes HTML, markdown, links and mentions', () => {
    const s = mdEscape('<script>alert(1)</script> [click](https://evil.example) **bold** @org/team | pipe');
    assert.ok(!s.includes('<script>'));
    assert.ok(!/\]\(/.test(s));
    assert.ok(!s.includes('https://'));
    assert.ok(!s.includes('@org'));
    assert.ok(!/(^|[^\\])\|/.test(s));
  });

  it('flattens newlines in inline text and truncates', () => {
    const s = mdInline('a\n\n## heading\nb'.repeat(50), 50);
    assert.ok(!s.includes('\n'));
    assert.ok(s.length < 120);
  });

  it('uses a fence longer than any backtick run in the content', () => {
    const f = fence('```\nbreak out\n```');
    assert.ok(f.startsWith('````text'));
    assert.ok(f.endsWith('````'));
  });

  it('renders a heuristic report with escaped model/artifact strings', () => {
    const md = renderMarkdown({
      schemaVersion: '1.0',
      generatedAt: '',
      mode: 'agent',
      modeReason: null,
      run: { url: null, commit: null, stats: null, projects: [], runErrors: [] },
      regressionStatus: 'failed',
      overall: { classification: 'automation_defect', summary: '<img src=x onerror=alert(1)> see [here](http://x)' },
      failures: groundedFailures(sub2('automation_defect'), [test('T1')], new EvidenceStore()),
      uncertainty: ['<b>unsure</b>'],
      agent: null,
      notes: [],
    });
    assert.ok(!md.includes('<img'));
    assert.ok(!md.includes('<b>unsure'));
    assert.ok(md.includes('regression result is unchanged'));
  });
});
