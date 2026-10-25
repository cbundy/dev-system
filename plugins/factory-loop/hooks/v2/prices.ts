// What-if prices (cbundy/dev-system#1334, v2 SPEC 13.7.4): USD per million tokens at Anthropic's
// public API list prices (https://www.anthropic.com/pricing), the rates last taken 2026-10-25. The
// loop runs on a subscription, so these are not a bill: they say what a step would have cost at list
// price. Keep this table current: a stale rate skews every figure, and a model missing from it prices
// to null (never a guess) and shows as `unpriced model <id>` in the decision log.
// Keys are model id prefixes; the longest matching prefix wins.

export type Rates = { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

export const PRICES: Record<string, Rates> = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-haiku-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
}

export type PricedTurn = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

// priceOf: the USD cost of one request at its model's rates, null for an unknown or null model.
export function priceOf(model: string | null, turn: PricedTurn): number | null {
  if (model === null) return null
  let best: string | null = null
  for (const prefix of Object.keys(PRICES)) if (model.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix
  if (best === null) return null
  const r = PRICES[best] as Rates
  return (turn.input * r.input + turn.output * r.output + turn.cacheWrite5m * r.cacheWrite5m + turn.cacheWrite1h * r.cacheWrite1h + turn.cacheRead * r.cacheRead) / 1_000_000
}
