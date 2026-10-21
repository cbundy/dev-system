// The pass summary (passes.ts, #680): pure aggregation, the note and its argv.
import { describe, expect, test } from 'claude-code/testing'

import { entryFromLoop } from '../hooks/derive'
import { MINUTE_MS, closeMinute, notePass, passesEventArgv, passesNote } from '../hooks/passes'
import type { PassBook } from '../hooks/passes'
import { NOW } from './fixtures'

const SET = { mode: 'act', passEveryMs: 60_000 }
const M = Math.floor(NOW / MINUTE_MS) * MINUTE_MS
const tokens = (note: string) => Object.fromEntries(note.split(' ').map(t => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]))

describe('closeMinute', () => {
  test('a minute of known passes gives the expected numbers', () => {
    const book: PassBook = new Map()
    // acting 100, 300; idle 200, 400; error 1000
    notePass(book, M + 1_000, 100, true, false)
    notePass(book, M + 2_000, 200, false, false)
    notePass(book, M + 3_000, 300, true, false)
    notePass(book, M + 4_000, 400, false, false)
    notePass(book, M + 59_999, 1000, false, true)
    const s = closeMinute(book, M, SET)
    expect(s).toMatchObject({ from: M, to: M + MINUTE_MS, passes: 5, mean: 400, p50: 300, p90: 1000, max: 1000, acting: 2, actingMean: 200, idleMean: 533, errors: 1 })
    const t = tokens(passesNote(s))
    expect(t).toMatchObject({
      kind: 'passes',
      key: `passes:${M}`,
      status: 'done',
      from: new Date(M).toISOString(),
      to: new Date(M + MINUTE_MS).toISOString(),
      passes: '5',
      mean_ms: '400',
      p50_ms: '300',
      p90_ms: '1000',
      max_ms: '1000',
      acting: '2',
      acting_mean_ms: '200',
      idle_mean_ms: '533',
      errors: '1',
      mode: 'act',
      planner: 'v2',
      pass_every_ms: '60000',
    })
  })

  test('a pass is in the minute it ended, also when it started in the one before', () => {
    const book: PassBook = new Map()
    // ended at M + 1 s after 5 s: started in the previous minute
    notePass(book, M + 1_000, 5_000, false, false)
    notePass(book, M + MINUTE_MS, 10, false, false)
    expect(closeMinute(book, M - MINUTE_MS, SET).passes).toBe(0)
    expect(closeMinute(book, M, SET).passes).toBe(1)
    expect(closeMinute(book, M + MINUTE_MS, SET).passes).toBe(1)
  })

  test('a minute with no passes gives passes=0 and none', () => {
    const s = closeMinute(new Map(), M, SET)
    const t = tokens(passesNote(s))
    expect(t).toMatchObject({ passes: '0', mean_ms: 'none', p50_ms: 'none', p90_ms: 'none', max_ms: 'none', acting: '0', acting_mean_ms: 'none', idle_mean_ms: 'none', errors: '0' })
  })

  test('one pass, or none acting, gives none where it should', () => {
    const book: PassBook = new Map()
    notePass(book, M + 1, 250, false, false)
    const t = tokens(passesNote(closeMinute(book, M, SET)))
    expect(t).toMatchObject({ passes: '1', mean_ms: '250', p50_ms: '250', p90_ms: '250', max_ms: '250', acting: '0', acting_mean_ms: 'none', idle_mean_ms: '250' })
  })

  test('closing a minute drops it and every older bucket', () => {
    const book: PassBook = new Map()
    notePass(book, M - 2 * MINUTE_MS, 1, false, false)
    notePass(book, M + 1, 1, false, false)
    notePass(book, M + MINUTE_MS, 1, false, false)
    closeMinute(book, M, SET)
    expect([...book.keys()]).toEqual([M + MINUTE_MS])
  })

  test('the summary is a native loop_passes call with the translator\'s field names, and no ledger entry', () => {
    const summary = closeMinute(new Map(), M, SET)
    const argv = passesEventArgv(summary)
    expect(argv.slice(0, 4)).toEqual(['callum-flow-event', '--type', 'loop_passes', '--data'])
    expect(argv).toHaveLength(5)
    const data = JSON.parse(argv[4] as string)
    expect(Object.keys(data).sort()).toEqual(['acting', 'acting_mean_ms', 'errors', 'from_at', 'idle_mean_ms', 'max_ms', 'mean_ms', 'mode', 'p50_ms', 'p90_ms', 'pass_every_ms', 'passes', 'planner', 'to_at'])
    expect(data).toMatchObject({ from_at: new Date(summary.from).toISOString(), planner: 'v2', mode: SET.mode, pass_every_ms: SET.passEveryMs })
    // the note stays what the old-source reader parses, and gives no entry
    expect(entryFromLoop({ state: 'loop', note: passesNote(summary) } as never)).toBeNull()
  })
})
