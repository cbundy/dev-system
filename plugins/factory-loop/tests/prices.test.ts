// The what-if price table (v2/prices.ts, #1334): each model prices a turn to a hand-computed figure.
import { describe, expect, test } from 'claude-code/testing'

import { PRICES, priceOf } from '../hooks/v2/prices'

const near = (a: number | null, b: number) => expect(Math.abs((a ?? NaN) - b) < 1e-9).toBe(true)
const million = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }

describe('priceOf', () => {
  test('a million of every kind of token costs the sum of the model rates', () => {
    expect(priceOf('claude-opus-5-5', million)).toBe(5 + 25 + 0.5 + 6.25 + 10)
    near(priceOf('claude-sonnet-5-5', million), 3 + 15 + 0.3 + 3.75 + 6)
    near(priceOf('claude-haiku-5-5', million), 1 + 5 + 0.1 + 1.25 + 2)
  })

  test('a single request is hand-computed', () => {
    near(priceOf('claude-opus-5-1', { input: 1000, output: 2000, cacheRead: 10000, cacheWrite5m: 1000, cacheWrite1h: 2000 }), 0.08625)
  })

  test('the longest matching prefix wins', () => {
    const rates = { ...PRICES['claude-opus-5']! }
    PRICES['claude-opus-5-9'] = { ...rates, input: 100 }
    try {
      expect(priceOf('claude-opus-5-9-x', { ...million, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBe(100)
      expect(priceOf('claude-opus-5-5', { ...million, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBe(5)
    } finally {
      delete PRICES['claude-opus-5-9']
    }
  })

  test('an unknown or null model is null, never a guess', () => {
    expect(priceOf('claude-future-9', million)).toBeNull()
    expect(priceOf(null, million)).toBeNull()
  })
})
