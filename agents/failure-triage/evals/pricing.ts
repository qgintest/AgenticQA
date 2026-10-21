import type { Limits } from '../src/config';
import type { Price } from '../src/pricing';

// The price table lives in src/ (the self-heal cost cap uses it too); re-exported for the eval code.
export { PRICES, priceFor, costOf, type Price, type Usage } from '../src/pricing';

export interface SpendPlan {
  runs: number;
  maxModelCalls: number;
  ceilingUsd: number;
  ceilingPerRunUsd: number;
}

/**
 * Worst case from the configured limits: every run uses all its turns and its whole token budget at
 * full input price. A refusal fallback may answer on another model; its price is not included.
 */
export function spendPlan(runs: number, limits: Pick<Limits, 'maxIterations' | 'maxInputTokens' | 'maxOutputTokens'>, price: Price): SpendPlan {
  const perRun = (limits.maxInputTokens * price.input + limits.maxOutputTokens * price.output) / 1_000_000;
  return { runs, maxModelCalls: runs * limits.maxIterations, ceilingPerRunUsd: perRun, ceilingUsd: perRun * runs };
}
