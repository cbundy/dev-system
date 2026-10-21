// API-key mode's spend tally (hooks/spend.ts; v2 SPEC 13.5.2 G3, 13.13): the budget period, the counter
// rules, the missing-reading reasons, a restart through the store's JSON, and the usage event's data.
import { describe, expect, test } from 'claude-code/testing'

import { budgetOf, periodOf, spendEventData, spendPct, tallyStep } from '../hooks/spend'
import type { ApiKeySettings, Reading, Tally } from '../hooks/spend'
import { validateStrict } from '../hooks/v2/event-reader'

const at = (iso: string) => Date.parse(iso)
const OK: ApiKeySettings = { budgetUsd: '100', resetDay: '1' }
const NOW = at('2026-10-21T12:00:00Z')
const read = (costUsd: number | null, process = 'p1', session = 's1'): Reading => ({ costUsd, process, session })
const tallyOf = (o: Partial<Tally> = {}): Tally => ({ v: 1, periodStart: at('2026-10-01T00:00:00Z'), spentUsd: 10, counter: { process: 'p1', session: 's1', lastUsd: 4 }, at: NOW - 60_000, ...o })

describe('periodOf', () => {
  test('a period starts at 00:00 UTC on the reset day and resets on the next one', () => {
    expect(periodOf(1, NOW)).toEqual({ start: at('2026-10-01T00:00:00Z'), resetsAt: at('2026-11-01T00:00:00Z') })
    expect(periodOf(15, NOW)).toEqual({ start: at('2026-10-15T00:00:00Z'), resetsAt: at('2026-11-15T00:00:00Z') })
    expect(periodOf(25, NOW)).toEqual({ start: at('2026-09-25T00:00:00Z'), resetsAt: at('2026-10-25T00:00:00Z') })
  })

  test('a day past the month end means its last day: 31 in a 30-day month and in February, leap and not', () => {
    expect(periodOf(31, at('2026-11-15T00:00:00Z'))).toEqual({ start: at('2026-10-31T00:00:00Z'), resetsAt: at('2026-11-30T00:00:00Z') })
    expect(periodOf(31, at('2026-11-30T00:00:00Z'))).toEqual({ start: at('2026-11-30T00:00:00Z'), resetsAt: at('2026-12-31T00:00:00Z') })
    expect(periodOf(31, at('2026-02-10T00:00:00Z'))).toEqual({ start: at('2026-01-31T00:00:00Z'), resetsAt: at('2026-02-28T00:00:00Z') })
    expect(periodOf(31, at('2028-02-10T00:00:00Z'))).toEqual({ start: at('2028-01-31T00:00:00Z'), resetsAt: at('2028-02-29T00:00:00Z') })
    expect(periodOf(15, at('2027-01-10T00:00:00Z'))).toEqual({ start: at('2026-12-15T00:00:00Z'), resetsAt: at('2027-01-15T00:00:00Z') })
  })

  test('a reading exactly at the reset instant is in the new period; one a millisecond before is in the old', () => {
    const edge = at('2026-11-01T00:00:00Z')
    expect(periodOf(1, edge).start).toBe(edge)
    expect(periodOf(1, edge - 1).resetsAt).toBe(edge)
  })
})

describe('budgetOf and spendPct', () => {
  test('a budget and a reset day, or the reason', () => {
    expect(budgetOf(OK)).toEqual({ budgetUsd: 100, resetDay: 1 })
    expect(budgetOf({ budgetUsd: '12.5', resetDay: '31' })).toEqual({ budgetUsd: 12.5, resetDay: 31 })
    for (const b of ['', '0', '-1', 'abc']) expect(budgetOf({ ...OK, budgetUsd: b })).toEqual({ reason: 'spend:no-budget' })
    for (const d of ['', '0', '32', '1.5', 'x']) expect(budgetOf({ ...OK, resetDay: d })).toEqual({ reason: 'spend:bad-reset-day' })
  })

  test('the percent rounds up', () => {
    expect(spendPct(84.1, 100)).toBe(85)
    expect(spendPct(90, 100)).toBe(90)
    expect(spendPct(0, 100)).toBe(0)
  })
})

describe('tallyStep: the counter rules', () => {
  const step = (prev: unknown, r: Reading, now = NOW) => tallyStep(prev, r, now, OK)

  test('the first reading adds the whole counter', () => {
    const s = step(undefined, read(3))
    expect(s.tally).toMatchObject({ spentUsd: 3, periodStart: at('2026-10-01T00:00:00Z'), counter: { process: 'p1', session: 's1', lastUsd: 3 }, at: NOW })
    expect(s.usage).toMatchObject({ unavailable: false, auth: 'api-key', spend: { usd: 3, budgetUsd: 100, resetsAt: at('2026-11-01T00:00:00Z') } })
    expect(step(null, read(3)).tally?.spentUsd).toBe(3)
  })

  test('the same process adds the growth only', () => {
    expect(step(tallyOf(), read(6.5)).tally).toMatchObject({ spentUsd: 12.5, counter: { lastUsd: 6.5 } })
    expect(step(tallyOf(), read(4)).tally?.spentUsd).toBe(10)
  })

  test('a drop in the same process is a counter reset: it adds the whole counter', () => {
    expect(step(tallyOf(), read(1)).tally).toMatchObject({ spentUsd: 11, counter: { lastUsd: 1 } })
  })

  test('another process with a fresh counter adds the whole counter', () => {
    expect(step(tallyOf(), read(2, 'p2', 's2')).tally?.spentUsd).toBe(12)
    expect(step(tallyOf(), read(2, 'p2', 's1')).tally?.spentUsd).toBe(12)
  })

  test('another process of the same session with a restored counter adds only the delta', () => {
    expect(step(tallyOf(), read(5, 'p2', 's1')).tally).toMatchObject({ spentUsd: 11, counter: { process: 'p2', lastUsd: 5 } })
  })

  test('a new session in a new process adds its cost whatever the old counter was; in the same process the counter is process-wide', () => {
    expect(step(tallyOf(), read(9, 'p2', 's2')).tally?.spentUsd).toBe(19)
    expect(step(tallyOf(), read(9, 'p1', 's2')).tally?.spentUsd).toBe(15)
  })

  test('a new period starts again at 0 and keeps the counter, so only the growth since counts', () => {
    const later = at('2026-11-01T00:00:00Z')
    const s = step(tallyOf(), read(6), later)
    expect(s.tally).toMatchObject({ spentUsd: 2, periodStart: later, counter: { lastUsd: 6 } })
    expect(s.usage.spend).toMatchObject({ usd: 2, resetsAt: at('2026-12-01T00:00:00Z') })
    expect(step(tallyOf(), read(6), later - 1).tally?.spentUsd).toBe(12)
  })

  test('a clock that ran backwards does not drop the spend', () => {
    expect(step(tallyOf({ periodStart: at('2026-11-01T00:00:00Z') }), read(5)).tally).toMatchObject({ spentUsd: 11, periodStart: at('2026-11-01T00:00:00Z') })
  })
})

describe('tallyStep: a missing reading gives its reason and leaves the store alone', () => {
  test('no budget, a bad reset day and no session cost', () => {
    const gone = (usage: { unavailable: boolean; spend?: unknown; reason?: string }, reason: string) => expect(usage).toMatchObject({ unavailable: true, spend: null, auth: 'api-key', reason })
    const a = tallyStep(tallyOf(), read(5), NOW, { ...OK, budgetUsd: '0' })
    gone(a.usage, 'spend:no-budget')
    expect(a.tally).toBeNull()
    const b = tallyStep(tallyOf(), read(5), NOW, { ...OK, resetDay: '40' })
    gone(b.usage, 'spend:bad-reset-day')
    expect(b.tally).toBeNull()
    const c = tallyStep(tallyOf(), read(null), NOW, OK)
    gone(c.usage, 'spend:no-session-cost')
    expect(c.tally).toBeNull()
    gone(tallyStep(tallyOf(), read(Number.NaN), NOW, OK).usage, 'spend:no-session-cost')
  })

  test('a stored tally that does not parse is reported, and a fresh one counts the whole counter', () => {
    for (const bad of ['x', 7, { v: 2 }, { ...tallyOf(), spentUsd: -1 }, { ...tallyOf(), counter: { process: 1 } }, { ...tallyOf(), periodStart: 'now' }]) {
      const s = tallyStep(bad, read(5), NOW, OK)
      expect(s.usage).toMatchObject({ unavailable: true, reason: 'spend:bad-tally' })
      expect(s.tally).toMatchObject({ v: 1, spentUsd: 5, counter: { lastUsd: 5 } })
      // the next reading, from the fresh tally, is available again
      expect(tallyStep(s.tally, read(6), NOW + 1000, OK).usage).toMatchObject({ unavailable: false, spend: { usd: 6 } })
    }
  })
})

describe('the tally across restarts', () => {
  test('through the store\'s JSON: a restart, a resume and a new session never count a dollar twice', () => {
    let store: string | undefined
    const take = (r: Reading, now: number) => {
      const s = tallyStep(store === undefined ? undefined : JSON.parse(store), r, now, OK)
      if (s.tally !== null) store = JSON.stringify(s.tally)
      return s.usage.spend?.usd
    }
    expect(take(read(2, 'p1', 's1'), NOW)).toBe(2)
    expect(take(read(5, 'p1', 's1'), NOW + 1000)).toBe(5)
    // the module reloads in the same process: same counter
    expect(take(read(6, 'p1', 's1'), NOW + 2000)).toBe(6)
    // the container restarts and the session resumes with its counter restored
    expect(take(read(6, 'p2', 's1'), NOW + 3000)).toBe(6)
    expect(take(read(8, 'p2', 's1'), NOW + 4000)).toBe(8)
    // a new session starts its own counter at 0.5
    expect(take(read(0.5, 'p3', 's2'), NOW + 5000)).toBe(8.5)
    expect(take(read(1.5, 'p3', 's2'), NOW + 6000)).toBe(9.5)
  })
})

describe('spendEventData', () => {
  test('a reading and a missing one both validate strictly against usage.v1', () => {
    const reading = tallyStep(undefined, read(42.5), NOW, OK).usage
    const data = spendEventData(reading)
    expect(data).toMatchObject({ available: true, source: 'spend', auth: 'api-key', spend_usd: 42.5, budget_usd: 100, budget_resets_at: '2026-11-01T00:00:00.000Z', reasons: [] })
    expect(validateStrict('usage', 1, data)).toEqual([])
    const gone = spendEventData(tallyStep(undefined, read(null), NOW, OK).usage)
    expect(gone).toMatchObject({ available: false, source: null, auth: 'api-key', reasons: ['spend:no-session-cost'] })
    expect(validateStrict('usage', 1, gone)).toEqual([])
  })
})
