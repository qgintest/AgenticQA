import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HealBaselineModel } from '../evals/heal-baseline';
import { runHealEval } from '../evals/heal-eval';
import { tmpDir } from './helpers';

describe('self-heal evaluation (recorded scenarios, deterministic baseline)', () => {
  it('repairs the broken shared locator and makes no false repair on any negative case', async () => {
    const { scores } = await runHealEval({
      evalsDir: path.resolve(__dirname, '..', '..', 'evals'),
      outDir: tmpDir('heal-eval-'),
      repeat: 1,
      only: [],
      env: { ANTHROPIC_API_KEY: 'dry-run-no-api-calls' },
      createClient: () => new HealBaselineModel(),
      log: () => {},
    });
    assert.ok(scores.length >= 8);
    assert.deepEqual(scores.filter((s) => s.invalid).map((s) => s.name), [], 'every trial must evaluate its case');
    assert.deepEqual(scores.filter((s) => s.falseRepair).map((s) => s.name), [], 'no false repairs');
    assert.deepEqual(scores.filter((s) => !s.correct).map((s) => s.name), []);
    const positive = scores.find((s) => s.name === 'repair-broken-shared-locator')!;
    assert.equal(positive.status, 'proposed');
    // Most negatives never reach the model: the deterministic gate stops them.
    assert.ok(scores.filter((s) => s.expect === 'no_repair' && !s.reachedModel).length >= 6);
  });
});
