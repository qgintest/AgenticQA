/** USD per million tokens. Anthropic list prices (first-party API) as of 2026-10. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'fake-model': { input: 0, output: 0, cacheRead: 0 },
};

export function priceFor(model: string, override?: Partial<Price>): Price {
  const known = PRICES[model];
  if (override?.input !== undefined && override.output !== undefined) {
    return { input: override.input, output: override.output, cacheRead: override.cacheRead ?? override.input * 0.1 };
  }
  if (!known) throw new Error(`no price known for model "${model}": pass --price-in and --price-out (USD per million tokens)`);
  return known;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Estimated cost of the tokens a run used. `inputTokens` from the agent's telemetry already includes
 * cache reads and writes; cache writes are billed here at the plain input price (a slight underestimate).
 */
export function costOf(usage: Usage, price: Price): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadInputTokens);
  return (uncached * price.input + usage.cacheReadInputTokens * price.cacheRead + usage.outputTokens * price.output) / 1_000_000;
}
