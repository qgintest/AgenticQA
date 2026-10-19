import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyHeuristically } from '../src/heuristics';
import type { FailedTest } from '../src/playwright-results';

function failed(errors: string[], outcome: FailedTest['outcome'] = 'unexpected', statuses = ['failed']): FailedTest {
  return {
    id: 'T1',
    title: 't',
    file: 'f.spec.ts',
    line: 1,
    project: 'regression',
    tags: [],
    outcome,
    attempts: statuses.map((status, retry) => ({
      retry,
      status,
      durationMs: 1,
      startTime: null,
      errors: status === 'passed' ? [] : errors.map((m) => ({ message: m, stack: null, location: null })),
      attachments: [],
      stdout: '',
      stderr: '',
    })),
  };
}

describe('heuristic classification', () => {
  it('stale locator timeout → automation_defect', () => {
    const v = classifyHeuristically(failed(["TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByTestId('add-to-bag-button')"]));
    assert.equal(v.classification, 'automation_defect');
    assert.ok(v.confidence > 0.4 && v.confidence <= 0.7);
  });

  it('strict mode violation → automation_defect', () => {
    assert.equal(classifyHeuristically(failed(["Error: strict mode violation: getByTestId('product-title') resolved to 13 elements"])).classification, 'automation_defect');
  });

  it('value mismatch on backend data → application_defect', () => {
    const v = classifyHeuristically(failed(['Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "captured"\nReceived: "authorized"']));
    assert.equal(v.classification, 'application_defect');
  });

  it('backend 5xx in API error → application_defect', () => {
    assert.equal(classifyHeuristically(failed(['ApiError: POST http://localhost:9000/store/carts → 500: {"message":"boom"}'])).classification, 'application_defect');
  });

  it('connection reset / AUT not ready → environment_issue', () => {
    assert.equal(classifyHeuristically(failed(['page.goto: net::ERR_CONNECTION_RESET at http://localhost:8000/dk'])).classification, 'environment_issue');
    const v = classifyHeuristically(failed(['Error: Medusa backend not ready at http://localhost:9000/health after 180s (last: ECONNREFUSED)']));
    assert.equal(v.classification, 'environment_issue');
  });

  it('passed on retry → flaky, even with an automation-looking error', () => {
    const v = classifyHeuristically(failed(["locator.click: Timeout 5000ms exceeded.\n  - waiting for getByTestId('x')"], 'flaky', ['failed', 'passed']));
    assert.equal(v.classification, 'flaky');
  });

  it('no known pattern → unknown with low confidence', () => {
    const v = classifyHeuristically(failed(['Error: something odd happened']));
    assert.equal(v.classification, 'unknown');
    assert.ok(v.confidence <= 0.25);
  });

  it('equal conflicting scores → unknown', () => {
    // element(s) not found (automation 2) + 4xx (application 2)
    const v = classifyHeuristically(failed(['expect(locator).toBeVisible() failed\nelement(s) not found\nApiError: GET /x → 404']));
    assert.equal(v.classification, 'unknown');
  });

  it('heuristic confidence never reaches "high"', () => {
    const v = classifyHeuristically(failed(['net::ERR_CONNECTION_RESET', 'ECONNREFUSED', 'browserType.launch: Executable doesn\'t exist', 'Medusa backend not ready at http://x after 10s']));
    assert.ok(v.confidence <= 0.7);
  });
});
