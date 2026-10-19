import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { BUDGET_NUDGE, NO_SUBMIT_NUDGE } from '../src/prompts';
import { renderMarkdown } from '../src/render';
import { triage } from '../src/triage';
import { evidenceIdsIn, message, ScriptedModel, testConfig, text, toolResultsIn, toolUse, writeFixture } from './helpers';

const LOCATOR_ERROR = "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByTestId('add-to-bag-button')";

function submit(testId: string, evidenceIds: string[], classification = 'automation_defect', confidence = 0.85) {
  return toolUse('submit_triage_report', {
    summary: 'The add-to-cart locator is stale.',
    uncertainty: ['Could also be a renamed test id in the app.'],
    failures: [
      {
        test_id: testId,
        classification,
        confidence,
        rationale: 'The trace shows the click waiting for a test id that is not on the page.',
        evidence: evidenceIds.map((id) => ({ evidence_id: id, observation: 'supports the conclusion' })),
        recommended_actions: ['Update the locator to add-product-button.'],
      },
    ],
  });
}

const fixture = (env: Record<string, string> = {}) => {
  const fx = writeFixture([{ title: 'add to cart', status: 'unexpected', errors: [LOCATOR_ERROR] }], {
    logs: { medusa: `medusa-1  | 2026-10-19T10:00:00.500000000Z info: started with key ${env.ANTHROPIC_API_KEY ?? 'none'}` },
  });
  return fx;
};

describe('agent loop (scripted model)', () => {
  it('investigates iteratively, chooses evidence from earlier results, and submits a grounded report', async () => {
    const fx = fixture();
    const model = new ScriptedModel([
      message([text('Looking at the failure first.'), toolUse('get_failure_details', { test_id: 'T1' })]),
      // Second turn reacts to the first result: it only asks for the trace if the details mention a locator.
      (req) => {
        const results = toolResultsIn(req).join('\n');
        assert.match(results, /add-to-bag-button/);
        return message([toolUse('get_trace_summary', { test_id: 'T1', section: 'actions' }), toolUse('read_page_snapshot', { test_id: 'T1' })]);
      },
      (req) => message([submit('T1', evidenceIdsIn(req))], 'tool_use'),
    ]);

    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-123456' }, createClient: () => model });

    assert.equal(report.mode, 'agent');
    assert.equal(model.requests.length, 3, 'three model turns');
    assert.deepEqual(report.agent!.toolCalls.map((c) => c.name), ['get_failure_details', 'get_trace_summary', 'read_page_snapshot', 'submit_triage_report']);
    const f = report.failures[0]!;
    assert.equal(f.classification, 'automation_defect');
    assert.equal(f.source, 'agent');
    assert.equal(f.evidence.length, 3);
    assert.equal(f.confidenceLabel, 'high');
    assert.deepEqual(f.issues, []);
    assert.equal(report.regressionStatus, 'failed', 'triage never changes the regression status');
    // Tool results of one turn go back in one user message.
    const lastUser = model.requests[2]!.messages.at(-1)!;
    assert.equal(Array.isArray(lastUser.content) && lastUser.content.filter((b) => b.type === 'tool_result').length, 2);
  });

  it('stops at the iteration limit, nudges to submit first, then falls back to heuristics', async () => {
    const fx = fixture();
    const model = new ScriptedModel([message([toolUse('list_failed_tests', {})])], true);
    const report = await triage(testConfig(fx, { maxIterations: 3 }), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });

    assert.equal(model.requests.length, 3);
    assert.ok(JSON.stringify(model.requests[2]!.messages).includes(BUDGET_NUDGE), 'last turn carries the budget nudge');
    assert.ok(!JSON.stringify(model.requests[1]!.messages).includes(BUDGET_NUDGE));
    assert.equal(report.mode, 'heuristic');
    assert.match(report.modeReason!, /max iterations/);
    assert.equal(report.failures[0]!.classification, 'automation_defect');
    assert.equal(report.failures[0]!.source, 'heuristic');
  });

  it('enforces the cumulative token budget', async () => {
    const fx = fixture();
    const model = new ScriptedModel([message([toolUse('list_failed_tests', {})], 'tool_use', { input_tokens: 9_000, output_tokens: 10 })], true);
    const report = await triage(testConfig(fx, { maxInputTokens: 20_000 }), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(model.requests.length, 3);
    assert.ok(report.agent!.limitsHit.some((l) => l.startsWith('token budget')));
    assert.equal(report.mode, 'heuristic');
  });

  it('enforces the wall-clock budget', async () => {
    const fx = fixture();
    let t = 0;
    const model = new ScriptedModel([(_) => ((t += 40_000), message([toolUse('list_failed_tests', {})]))], true);
    const report = await triage(testConfig(fx, { timeoutMs: 60_000 }), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model, now: () => t });
    assert.ok(report.agent!.limitsHit.some((l) => l.startsWith('time budget')));
    assert.equal(model.requests.length, 2);
  });

  it('returns validation errors for an invalid report and accepts the corrected one', async () => {
    const fx = fixture();
    const model = new ScriptedModel([
      message([toolUse('get_failure_details', { test_id: 'T1' })]),
      message([toolUse('submit_triage_report', { summary: 's', uncertainty: [], failures: [{ test_id: 'T7', classification: 'broken', confidence: 3, rationale: 'r', evidence: [], recommended_actions: [] }] })]),
      (req) => {
        const results = toolResultsIn(req).join('\n');
        assert.match(results, /Report rejected/);
        assert.match(results, /T7/);
        return message([submit('T1', ['E1'])]);
      },
    ]);
    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(report.mode, 'agent');
    assert.equal(report.agent!.toolCalls.filter((c) => c.name === 'submit_triage_report' && !c.ok).length, 1);
  });

  it('gives up after repeated invalid reports', async () => {
    const fx = fixture();
    const bad = message([toolUse('submit_triage_report', { summary: '', uncertainty: [], failures: [] })]);
    const model = new ScriptedModel([bad], true);
    const report = await triage(testConfig(fx, { maxReportCorrections: 2 }), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(report.mode, 'heuristic');
    assert.match(report.modeReason!, /could not produce a valid report/);
    assert.equal(model.requests.length, 3);
  });

  it('nudges a model that answers in prose instead of calling the submit tool', async () => {
    const fx = fixture();
    const model = new ScriptedModel([
      message([toolUse('get_failure_details', { test_id: 'T1' })]),
      message([text('It is a stale locator.')], 'end_turn'),
      (req) => {
        assert.ok(JSON.stringify(req.messages.at(-1)).includes(NO_SUBMIT_NUDGE));
        return message([submit('T1', ['E1'])]);
      },
    ]);
    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(report.mode, 'agent');
  });

  it('downgrades invented evidence ids instead of trusting them', async () => {
    const fx = fixture();
    const model = new ScriptedModel([message([submit('T1', ['E99'], 'application_defect', 0.95)])]);
    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    const f = report.failures[0]!;
    assert.equal(f.confidence, 0.3);
    assert.ok(f.issues.some((i) => i.includes('E99')));
    assert.ok(f.issues.some((i) => i.includes('Heuristic signals point to automation_defect')));
  });

  it('handles API errors, refusals, truncation and malformed responses with a heuristic report', async () => {
    const cases: Array<[string, ConstructorParameters<typeof ScriptedModel>[0], RegExp]> = [
      ['connection error', [new Anthropic.APIConnectionError({ message: 'ECONNRESET' })], /could not connect/],
      ['unexpected error', [new Error('boom')], /unexpected error: boom/],
      ['refusal', [message([], 'refusal')], /declined/],
      ['max_tokens', [message([toolUse('get_failure_details', { test_id: 'T1' })], 'max_tokens')], /max_tokens/],
      ['malformed', [{ ...message([]), content: null } as never], /malformed/],
    ];
    for (const [name, script, reason] of cases) {
      const fx = fixture();
      const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => new ScriptedModel(script) });
      assert.equal(report.mode, 'heuristic', name);
      assert.match(report.modeReason!, reason, name);
      assert.equal(report.failures.length, 1, name);
      assert.equal(report.regressionStatus, 'failed', name);
    }
  });

  it('does not run a truncated tool call', async () => {
    const fx = fixture();
    const model = new ScriptedModel([message([toolUse('get_failure_details', { test_id: 'T1' })], 'max_tokens')]);
    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(report.agent!.toolCalls.length, 0);
  });
});

describe('triage modes and graceful degradation', () => {
  it('runs heuristic triage without an API key and never builds a client', async () => {
    const fx = fixture();
    const report = await triage(testConfig(fx), {
      env: {},
      createClient: () => {
        throw new Error('must not be called');
      },
    });
    assert.equal(report.mode, 'heuristic');
    assert.match(report.modeReason!, /ANTHROPIC_API_KEY is not set/);
    assert.equal(report.agent, null);
  });

  it('reports missing and malformed results without throwing', async () => {
    const fx = fixture();
    fs.rmSync(path.join(fx.reportsDir, 'results.json'));
    const missing = await triage(testConfig(fx), { env: {} });
    assert.equal(missing.mode, 'no_results');
    assert.equal(missing.regressionStatus, 'unknown');

    fs.writeFileSync(path.join(fx.reportsDir, 'results.json'), '{ not json');
    const malformed = await triage(testConfig(fx), { env: {} });
    assert.equal(malformed.mode, 'no_results');
    assert.match(malformed.modeReason!, /not valid JSON/);
  });

  it('handles missing artifacts (no trace/screenshot) with tool errors, not crashes', async () => {
    const fx = writeFixture([{ title: 'no artifacts', status: 'unexpected', errors: ['Error: x'], artifacts: false }]);
    const model = new ScriptedModel([
      message([toolUse('get_trace_summary', { test_id: 'T1', section: 'network' }), toolUse('view_screenshot', { test_id: 'T1' }), toolUse('search_aut_logs', { service: 'medusa', query: 'error', around_test_id: '' })]),
      (req) => {
        const results = toolResultsIn(req);
        assert.equal(results.filter((r) => r.startsWith('Error:')).length, 3);
        return message([submit('T1', [], 'unknown', 0.2)]);
      },
    ]);
    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(report.mode, 'agent');
    assert.equal(report.failures[0]!.classification, 'unknown');
  });

  it('triages run-level errors (e.g. AUT not reachable in global setup)', async () => {
    const fx = writeFixture([], { runErrors: ['Error: Storefront not ready at http://localhost:8000/dk after 180s (last: connect ECONNREFUSED 127.0.0.1:8000)'] });
    const report = await triage(testConfig(fx), { env: {} });
    assert.equal(report.mode, 'heuristic');
    assert.equal(report.failures[0]!.classification, 'environment_issue');
    assert.equal(report.regressionStatus, 'failed');
  });

  it('caps the number of failures handed to the agent', async () => {
    const fx = writeFixture(Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, status: 'unexpected' as const, errors: [LOCATOR_ERROR] })));
    const model = new ScriptedModel([
      (req) => {
        assert.ok(!JSON.stringify(req.messages).includes('"test_id":"T3"'));
        return message([toolUse('get_failure_details', { test_id: 'T3' })]);
      },
      (req) => {
        assert.match(toolResultsIn(req).join(''), /beyond the analysis cap/);
        return message([submit('T1', [])]);
      },
    ]);
    const report = await triage(testConfig(fx, { maxFailures: 2 }), { env: { ANTHROPIC_API_KEY: 'k-123456' }, createClient: () => model });
    assert.equal(report.failures.length, 4);
    assert.deepEqual(report.failures.map((f) => f.source), ['agent', 'heuristic', 'heuristic', 'heuristic']);
    assert.ok(report.notes.some((n) => n.includes('analysis cap')));
  });

  it('never leaks the API key into tool results, the JSON report or the markdown', async () => {
    const key = 'sk-ant-api03-SUPERSECRETVALUE-xyz';
    const fx = fixture({ ANTHROPIC_API_KEY: key });
    const model = new ScriptedModel([
      message([toolUse('search_aut_logs', { service: 'medusa', query: 'started', around_test_id: '' })]),
      (req) => {
        assert.ok(!JSON.stringify(req.messages).includes('SUPERSECRETVALUE'), 'tool result redacted');
        return message([submit('T1', ['E1'])]);
      },
    ]);
    const report = await triage(testConfig(fx), { env: { ANTHROPIC_API_KEY: key }, createClient: () => model });
    const json = JSON.stringify(report);
    assert.ok(!json.includes('SUPERSECRETVALUE'));
    assert.ok(!renderMarkdown(report).includes('SUPERSECRETVALUE'));
  });
});
