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
      observe_mean_ms: 'none',
      observe_in_process_max_ms: 'none',
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

  test('observe split: means over measured passes, max in-process, null and none without a measure', () => {
    const book: PassBook = new Map()
    notePass(book, M + 1, 100, true, false, { ms: 10.4, commandsMs: 6.2, inProcessMs: 4.2 })
    notePass(book, M + 2, 100, false, false, { ms: 20.4, commandsMs: 10.2, inProcessMs: 10.2 })
    notePass(book, M + 3, 100, false, false, { ms: 30.4, commandsMs: 20.2, inProcessMs: 8.2 })
    notePass(book, M + 4, 100, false, false)
    notePass(book, M + 5, 100, false, true, null)
    const s = closeMinute(book, M, SET)
    // rounded per pass: observe 10, 20, 30; commands 6, 10, 20; in-process 4, 10, 8
    expect(s).toMatchObject({ observeMean: 20, observeCommandsMean: 12, observeInProcessMean: 7, observeInProcessMax: 10 })
    expect(tokens(passesNote(s))).toMatchObject({ observe_mean_ms: '20', observe_commands_mean_ms: '12', observe_in_process_mean_ms: '7', observe_in_process_max_ms: '10' })
    const data = JSON.parse(passesEventArgv(s)[4] as string)
    expect(data).toMatchObject({ observe_mean_ms: 20, observe_commands_mean_ms: 12, observe_in_process_mean_ms: 7, observe_in_process_max_ms: 10 })
  })

  test('only unmeasured passes, or none, give null for the observe fields', () => {
    const book: PassBook = new Map()
    notePass(book, M + 1, 100, false, false)
    notePass(book, M + 2, 100, false, true)
    for (const s of [closeMinute(book, M, SET), closeMinute(new Map(), M, SET)]) {
      expect(s).toMatchObject({ observeMean: null, observeCommandsMean: null, observeInProcessMean: null, observeInProcessMax: null })
      expect(tokens(passesNote(s))).toMatchObject({ observe_mean_ms: 'none', observe_commands_mean_ms: 'none', observe_in_process_mean_ms: 'none', observe_in_process_max_ms: 'none' })
      expect(JSON.parse(passesEventArgv(s)[4] as string)).toMatchObject({ observe_mean_ms: null, observe_in_process_max_ms: null })
    }
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
    expect(Object.keys(data).sort()).toEqual(['acting', 'acting_mean_ms', 'cache_creation_tokens', 'cache_read_tokens', 'errors', 'from_at', 'idle_mean_ms', 'input_tokens', 'max_ms', 'mean_ms', 'mode', 'observe_commands_mean_ms', 'observe_in_process_max_ms', 'observe_in_process_mean_ms', 'observe_mean_ms', 'output_tokens', 'p50_ms', 'p90_ms', 'pass_every_ms', 'passes', 'planner', 'to_at', 'usage_tier', 'usage_tier_overridden'])
    expect([data.usage_tier, data.usage_tier_overridden]).toEqual([null, null])
    expect([data.input_tokens, data.output_tokens, data.cache_read_tokens, data.cache_creation_tokens]).toEqual([null, null, null, null])
    const withTokens = JSON.parse(passesEventArgv({ ...summary, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })[4] as string)
    expect([withTokens.input_tokens, withTokens.output_tokens, withTokens.cache_read_tokens, withTokens.cache_creation_tokens]).toEqual([1, 2, 3, 4])
    expect(data).toMatchObject({ from_at: new Date(summary.from).toISOString(), planner: 'v2', mode: SET.mode, pass_every_ms: SET.passEveryMs })
    // the note stays what the old-source reader parses, and gives no entry
    expect(entryFromLoop({ state: 'loop', note: passesNote(summary) } as never)).toBeNull()
  })

  describe('the usage tier', () => {
    const tierOf = (book: PassBook) => {
      const summary = closeMinute(book, M, SET)
      const data = JSON.parse(passesEventArgv(summary)[4] as string)
      return { summary, data }
    }

    test('the last pass with a plan gives the minute its tier', () => {
      const book: PassBook = new Map()
      notePass(book, M + 1_000, 10, false, false, null, 'slow', false)
      notePass(book, M + 2_000, 10, false, false, null, 'stop-new', false)
      const { summary, data } = tierOf(book)
      expect([summary.usageTier, summary.usageTierOverridden]).toEqual(['stop-new', false])
      expect([data.usage_tier, data.usage_tier_overridden]).toEqual(['stop-new', false])
    })

    test('a trailing error pass with no tier does not hide the earlier tiered pass', () => {
      const book: PassBook = new Map()
      notePass(book, M + 1_000, 10, false, false, null, 'slow', false)
      notePass(book, M + 2_000, 10, false, true)
      expect(tierOf(book).data).toMatchObject({ usage_tier: 'slow', usage_tier_overridden: false })
    })

    test('no passes, or only passes without a plan, give null', () => {
      expect(tierOf(new Map()).data).toMatchObject({ usage_tier: null, usage_tier_overridden: null })
      const book: PassBook = new Map()
      notePass(book, M + 1_000, 10, false, true)
      notePass(book, M + 2_000, 10, false, false)
      expect(tierOf(book).data).toMatchObject({ usage_tier: null, usage_tier_overridden: null })
    })

    test('an overridden pass gives normal and overridden true', () => {
      const book: PassBook = new Map()
      notePass(book, M + 1_000, 10, false, false, null, 'normal', true)
      expect(tierOf(book).data).toMatchObject({ usage_tier: 'normal', usage_tier_overridden: true })
    })

    test('the note does not carry the tier', () => {
      const book: PassBook = new Map()
      notePass(book, M + 1_000, 10, false, false, null, 'slow', false)
      expect(passesNote(tierOf(book).summary)).not.toContain('tier')
    })
  })
})
