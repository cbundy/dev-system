// The gate runs (docs/factory-loop/v2/SPEC.md 10.6): one free `gate_run` event for each stop gate
// line of the companion's log, written once per run, with the v0.51.0 companion's lines (no
// `startedAt`, no `queuedBehind`) derived and anything the schema would refuse left out.
import { describe, expect, mock, test } from 'claude-code/testing'

import { GITHUB_V2, newCtx } from '../hooks/foundation'
import type { Action, State } from '../hooks/types'
import { eventArgv } from '../hooks/v2/events'
import { gateRunKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { gateRunRules } from '../hooks/v2/rules-gates'
import { COMPANION_WINDOW_MS, companionLines, gateLines } from '../hooks/v2/sources-interventions'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { V2Ctx, V2State } from '../hooks/v2/types'
import { MIN, NOW, config, control, entry, state } from './fixtures'
import { LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host, ENGINE_TEST } from './host'

const N = 571
const LIFE = 'ss1x2k'
const HEAD = '4c2d8aa0000000000000000000000000000000ff'
const REF = { issue: N, life: LIFE, seq: 7 }

// line: a gate line of the current companion; over replaces or (undefined) drops a field
function line(over: Record<string, unknown> = {}): Record<string, unknown> {
  const startedAt = NOW - 10 * MIN
  const l: Record<string, unknown> = {
    at: startedAt + 7_000 + 12_000,
    issue: N,
    life: LIFE,
    seq: 7,
    cause: 'gate-pass',
    reason: 'the stop gate passed',
    head: HEAD,
    ms: 12_000,
    waitMs: 7_000,
    concurrency: 1,
    startedAt: new Date(startedAt).toISOString(),
    queuedBehind: 1,
    ...over,
  }
  for (const k of Object.keys(l)) if (l[k] === undefined) delete l[k]
  return l
}

// old: the same line as v0.51.0's companion wrote it
const old = (over: Record<string, unknown> = {}) => line({ startedAt: undefined, queuedBehind: undefined, ...over })
const text = (...lines: Record<string, unknown>[]) => `${lines.map(l => JSON.stringify(l)).join('\n')}\n`

function stateOf(companion: string, ledger: State['ledger'] = []): State {
  const s = state({ control: control() })
  const v2: V2State = { ...emptyV2State(NOW), interventions: { companion: companionLines(companion, NOW), gates: gateLines(companion, NOW), controlDigest: null, configDigest: null } }
  return { ...s, ledger: [...s.ledger, ...ledger], v2 }
}

function ctxOf(companion: string): V2Ctx {
  const s = stateOf(companion)
  return Object.assign(newCtx(s, config({ mode: 'act' }), { tier: 'normal', overridden: false }, V2_OWNER_TELLS, GITHUB_V2), { v2: s.v2 as V2State })
}

type EventAction = Extract<Action, { kind: 'event' }>
const runs = (actions: Action[]) => actions.filter((a): a is EventAction => a.kind === 'event' && a.event.state === 'gate_run')
const plan = (s: State) => planV2(s, config({ mode: 'act' })).actions
const dataOf = (companion: string) => runs(plan(stateOf(companion))).map(a => (a.event.state === 'gate_run' ? a.event.data : null))

describe('one gate line, one gate_run', () => {
  test('every field is mapped, the key is gateRunKey, and the argv is the new-format write', () => {
    const l = line()
    const [a, ...rest] = runs(plan(stateOf(text(l))))
    expect(rest).toEqual([])
    expect(a).toMatchObject({ class: 'free', issue: N, key: gateRunKey(REF, NOW - 10 * MIN) })
    expect(a?.key).toBe(`i${N}/l${LIFE}/s7/gate/${(NOW - 10 * MIN).toString(36)}`)
    expect(a?.event).toEqual({
      state: 'gate_run',
      issue: N,
      data: { life: LIFE, seq: 7, head: HEAD, result: 'pass', wait_ms: 7_000, run_ms: 12_000, concurrency: 1, queued_behind: 1, started_at: new Date(NOW - 10 * MIN).toISOString() },
    })
    expect(eventArgv((a as EventAction).event)).toEqual([
      'callum-flow-event',
      '--type',
      'gate_run',
      '--data',
      JSON.stringify((a?.event as { data: unknown }).data),
      '--issue',
      String(N),
    ])
  })

  test('the result follows the cause; no limit is a null concurrency and a null head is kept', () => {
    const got = dataOf(text(line({ cause: 'gate-fail', startedAt: new Date(NOW - 30 * MIN).toISOString() }), line({ cause: 'gate-unknown', head: null, concurrency: null, waitMs: 0, queuedBehind: 0 })))
    expect(got.map(d => d?.result).sort()).toEqual(['fail', 'unknown'])
    expect(got.find(d => d?.result === 'unknown')).toMatchObject({ head: null, concurrency: null, wait_ms: 0, queued_behind: 0 })
  })

  test('the same line on the next pass, once its key is done, gives none; a failed key is tried again', () => {
    const companion = text(line())
    const [first] = runs(plan(stateOf(companion)))
    const done = entry((first as EventAction).key, 'event', { issue: N, startedAt: NOW - MIN, endedAt: NOW - MIN + 100 })
    expect(runs(plan(stateOf(companion, [done])))).toEqual([])
    expect(runs(plan(stateOf(companion, [{ ...done, status: 'failed', endedAt: NOW - 10 * 60 * MIN }])))).toHaveLength(1)
  })

  test('two lines of one run (the file read twice) are one event', () => {
    expect(runs(plan(stateOf(text(line(), line()))))).toHaveLength(1)
  })
})

describe('the v0.51.0 companion: no startedAt, no queuedBehind', () => {
  const wait = (over: Record<string, unknown> = {}) => ({ at: NOW - 10 * MIN + 7_000, issue: N, life: LIFE, seq: 7, cause: 'gate-wait', reason: 'waited', waitMs: 7_000, queuedBehind: 2, concurrency: 1, ...over })

  test('started_at is the line less its run and wait, and queued_behind is that of the gate-wait line in the interval', () => {
    const [d] = dataOf(text(wait(), old()))
    expect(d).toMatchObject({ started_at: new Date(NOW - 10 * MIN).toISOString(), queued_behind: 2, wait_ms: 7_000, run_ms: 12_000 })
  })

  test('the interval is inclusive; a wait just outside it, or of another seq, is not the run\'s', () => {
    const start = NOW - 10 * MIN
    const end = start + 19_000
    expect(dataOf(text(wait({ at: start }), old()))[0]?.queued_behind).toBe(2)
    expect(dataOf(text(wait({ at: end }), old()))[0]?.queued_behind).toBe(2)
    expect(dataOf(text(wait({ at: start - 1 }), old()))).toEqual([])
    expect(dataOf(text(wait({ at: end + 1 }), old()))).toEqual([])
    expect(dataOf(text(wait({ seq: 8 }), old()))).toEqual([])
  })

  test('two runs in one seq each pair with their own gate-wait; the latest in an interval wins', () => {
    const t2 = NOW - 5 * MIN
    const second = old({ at: t2 + 3_000 + 4_000, ms: 4_000, waitMs: 3_000, cause: 'gate-fail' })
    const got = dataOf(text(wait(), old(), wait({ at: t2 + 3_000, waitMs: 3_000, queuedBehind: 5 }), second))
    expect(got.map(d => [d?.result, d?.queued_behind])).toEqual(expect.arrayContaining([['pass', 2], ['fail', 5]]))
    expect(got).toHaveLength(2)
    const twice = dataOf(text(wait({ queuedBehind: 1, at: NOW - 10 * MIN + 1_000 }), wait({ queuedBehind: 4, at: NOW - 10 * MIN + 7_000 }), old()))
    expect(twice[0]?.queued_behind).toBe(4)
  })

  test('waitMs above 0 with no gate-wait is skipped (a wait that ran out writes none); waitMs 0 gives queued_behind 0', () => {
    expect(dataOf(text(old()))).toEqual([])
    expect(dataOf(text(old({ cause: 'gate-unknown', ms: 0, waitMs: 60_000 })))).toEqual([])
    const [d] = dataOf(text(old({ waitMs: 0, at: NOW - 2 * MIN })))
    expect(d).toMatchObject({ queued_behind: 0, wait_ms: 0, started_at: new Date(NOW - 2 * MIN - 12_000).toISOString() })
  })

  test('a line with only one of the two new fields is skipped', () => {
    expect(dataOf(text(line({ queuedBehind: undefined })))).toEqual([])
    expect(dataOf(text(line({ startedAt: undefined })))).toEqual([])
  })
})

describe('what writes none', () => {
  test('a line with no numeric waitMs: a companion from before the waits, and the hook\'s bare gate-unknown', () => {
    expect(dataOf(text(line({ waitMs: undefined, startedAt: undefined, queuedBehind: undefined })))).toEqual([])
    expect(dataOf(text(line({ waitMs: '7', startedAt: undefined, queuedBehind: undefined })))).toEqual([])
    expect(dataOf(text({ at: NOW - MIN, issue: N, life: LIFE, seq: 7, cause: 'gate-unknown', reason: 'the stop gate hook failed' }))).toEqual([])
  })

  test('values the schema refuses give no event, where a refused payload would be a loop bug', () => {
    const bad = [
      line({ head: 'not-hex' }),
      line({ head: 'abc' }),
      line({ head: undefined }),
      line({ ms: -1 }),
      line({ ms: 1.5 }),
      line({ waitMs: -5 }),
      line({ waitMs: 2.5 }),
      line({ concurrency: 0 }),
      line({ concurrency: undefined }),
      line({ queuedBehind: -1 }),
      line({ startedAt: 'yesterday' }),
      line({ life: 'Bad Life' }),
      line({ seq: -1 }),
      line({ issue: 0 }),
    ]
    for (const b of bad) expect(dataOf(text(b)), JSON.stringify(b)).toEqual([])
    // the same lines unspoiled give one each, so the fixture reaches the guard
    expect(dataOf(text(line()))).toHaveLength(1)
  })

  test('a line outside COMPANION_WINDOW_MS', () => {
    const at = NOW - COMPANION_WINDOW_MS - MIN
    expect(dataOf(text(line({ at, startedAt: new Date(at - 19_000).toISOString() })))).toEqual([])
    expect(dataOf(text(line({ at: NOW - COMPANION_WINDOW_MS + MIN })))).toHaveLength(1)
  })

  test('an exhausted key is skipped with its reason', () => {
    const key = gateRunKey(REF, NOW - 10 * MIN)
    const failed = entry(key, 'event', { issue: N, status: 'failed', attempts: 3, startedAt: NOW - 90 * MIN, endedAt: NOW - 80 * MIN })
    const ctx = Object.assign(ctxOf(text(line())), {})
    ctx.byKey.set(key, failed)
    gateRunRules(ctx)
    expect(ctx.out).toEqual([])
    expect(ctx.skipped.map(s => s.why)).toEqual([expect.stringContaining('exhausted')])
  })
})

describe('gate lines and interventions', () => {
  const causes = (companion: string) => planV2(stateOf(companion), config({ mode: 'act' })).actions.filter((a): a is EventAction => a.kind === 'event' && a.key.startsWith('iv/')).map(a => (a.event.state === 'intervention' ? a.event.cause : ''))

  test('gate-unknown gives its intervention and its gate_run; gate-pass and gate-fail give no intervention', () => {
    const unknown = line({ cause: 'gate-unknown', reason: 'the stop gate could not run' })
    const companion = text(unknown, line({ startedAt: new Date(NOW - 20 * MIN).toISOString() }), line({ cause: 'gate-fail', startedAt: new Date(NOW - 30 * MIN).toISOString() }), { at: NOW - MIN, issue: N, life: LIFE, seq: 7, cause: 'gate-wait', waitMs: 1, queuedBehind: 1 })
    expect(causes(companion)).toEqual(['gate-unknown'])
    expect(dataOf(companion).map(d => d?.result).sort()).toEqual(['fail', 'pass', 'unknown'])
  })

  test('gateLines and companionLines read the same text apart: the gate lines of both kinds, the interventions of one', () => {
    const companion = text(line(), line({ cause: 'guard:write' }), line({ cause: 'gate-wait' }), line({ cause: 'gate-unknown' }))
    expect(companionLines(companion, NOW).map(l => l.cause)).toEqual(['guard:write', 'gate-unknown'])
    expect(gateLines(companion, NOW).map(l => l.cause)).toEqual(['gate-pass', 'gate-wait', 'gate-unknown'])
  })
})

describe('the recovery\'s lines (10.6)', () => {
  test('gate-rerun and gate-cut are interventions of the loop, gate-start is neither an intervention nor a gate line; rerun is read, false when absent', () => {
    const companion = text(
      line({ cause: 'gate-start' }),
      line({ cause: 'gate-rerun', reason: 'the gate cut at 13:21 runs again' }),
      line({ cause: 'gate-cut', reason: 'the marker moved on' }),
      line({ rerun: true }),
      line({ cause: 'gate-fail', rerun: true, startedAt: new Date(NOW - 30 * MIN).toISOString() }),
    )
    expect(companionLines(companion, NOW).map(l => l.cause)).toEqual(['gate-rerun', 'gate-cut'])
    expect(gateLines(companion, NOW).map(l => [l.cause, l.rerun])).toEqual([['gate-pass', true], ['gate-fail', true]])
    expect(gateLines(text(line()), NOW).map(l => l.rerun)).toEqual([false])
  })

  test('a re-run\'s settling line is one gate_run, as any run is', () => {
    const rerun = line({ rerun: true })
    expect(dataOf(text(line({ cause: 'gate-start' }), rerun)).map(d => d?.result)).toEqual(['pass'])
  })
})

describe('flakes: a pass after a fail on the same head, in a clean slot', () => {
  const HEAD2 = '5d3e9bb0000000000000000000000000000000ee'
  const iso = (ms: number) => new Date(ms).toISOString()
  // a run of the current companion, started at NOW - startMin minutes and 12 s long
  const run = (startMin: number, over: Record<string, unknown> = {}) =>
    line({ at: NOW - startMin * MIN + 12_000, startedAt: iso(NOW - startMin * MIN), waitMs: 0, queuedBehind: 0, clean: true, ...over })
  const fail = (over: Record<string, unknown> = {}) => run(30, { cause: 'gate-fail', failedTests: ['a > b', 'c'], ...over })
  const pass = (over: Record<string, unknown> = {}) => run(20, over)
  const passData = (...lines: Record<string, unknown>[]) => dataOf(text(...lines)).find(d => d?.result === 'pass')
  const reasons = (...lines: Record<string, unknown>[]) => runs(plan(stateOf(text(...lines)))).map(a => a.reason)

  test('a fail then a pass on one head, both clean, is a flake with the names and the fail\'s start', () => {
    const d = passData(fail(), pass())
    expect(d).toMatchObject({ flaky: true, failed_tests: ['a > b', 'c'], failed_at: iso(NOW - 30 * MIN) })
    expect(reasons(fail(), pass()).join('\n')).toContain(`pass in 12000 ms after 0 ms, flaky after the fail at ${iso(NOW - 30 * MIN)} on 4c2d8aa`)
  })

  test('a fail row carries its own names and no flake fields', () => {
    const d = dataOf(text(fail(), pass())).find(x => x?.result === 'fail')
    expect(d).toMatchObject({ failed_tests: ['a > b', 'c'] })
    expect(d).not.toHaveProperty('flaky')
  })

  test('a flake whose fail parsed no names has failed_tests null', () => {
    expect(passData(fail({ failedTests: undefined }), pass())).toMatchObject({ flaky: true, failed_tests: null })
  })

  const cases: [string, Record<string, unknown>[], string][] = [
    ['a new head', [fail({ head: HEAD2 }), pass()], 'the head moved'],
    ['a null head on the fail', [fail({ head: null }), pass()], 'the head is unknown'],
    ['a dirty slot on the pass', [fail(), pass({ clean: false })], 'the slot was dirty'],
    ['a dirty slot on the fail', [fail({ clean: false }), pass()], 'the slot was dirty'],
    ['an unknown slot on the fail', [fail({ clean: null }), pass()], 'the slot was dirty'],
    ['a pass as the run before', [run(30), pass()], 'the run before was a pass'],
    ['an unknown run between', [fail(), run(25, { cause: 'gate-unknown' }), pass()], 'the run before did not finish'],
    ['no run before', [pass()], 'no run before it in this life'],
    ['a fail in another life', [fail({ life: 'zzz' }), pass()], 'no run before it in this life'],
    ['a fail of another issue', [fail({ issue: N + 1 }), pass()], 'no run before it in this life'],
  ]
  for (const [name, lines, why] of cases) {
    test(`${name} is not a flake`, () => {
      expect(passData(...lines)).toMatchObject({ flaky: false })
      expect(passData(...lines)).not.toHaveProperty('failed_tests')
      expect(reasons(...lines).join('\n')).toContain(`not a flake: ${why}`)
    })
  }

  test('a bare gate-unknown of the hook\'s catch between the two refuses', () => {
    const bare = { at: NOW - 25 * MIN, issue: N, life: LIFE, seq: 7, cause: 'gate-unknown', reason: 'the stop gate hook failed (x)' }
    expect(passData(fail(), bare, pass())).toMatchObject({ flaky: false })
    // outside the two runs it does not matter
    expect(passData(fail(), { ...bare, at: NOW - 40 * MIN }, pass())).toMatchObject({ flaky: true })
  })

  test('the run before is the latest start before the pass, whatever the order of the lines', () => {
    expect(passData(pass(), fail(), run(40, { cause: 'gate-fail', head: HEAD2 }))).toMatchObject({ flaky: true })
  })

  test('a pass from a companion before clean has no flaky key; one with a null clean has flaky false', () => {
    expect(passData(fail(), pass({ clean: undefined }))).not.toHaveProperty('flaky')
    expect(passData(fail(), pass({ clean: null }))).toMatchObject({ flaky: false })
  })

  test('names the schema refuses write nothing', () => {
    expect(dataOf(text(fail({ failedTests: ['x'.repeat(201)] })))).toEqual([])
    expect(dataOf(text(fail({ failedTests: Array.from({ length: 21 }, (_, i) => `t${i}`) })))).toEqual([])
    expect(dataOf(text(fail({ failedTests: [1] })))[0]).not.toHaveProperty('failed_tests')
  })

  test('the same lines read twice give one event each', () => {
    expect(runs(plan(stateOf(text(fail(), pass(), fail(), pass()))))).toHaveLength(2)
  })
})

describe('a pass reads companion.jsonl and writes the gate_run once', () => {
  const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
  const quiet = (argv: string[], s: { stdin?: string }) => {
    switch (argv[0]) {
      case 'callum-flow-factory-state':
        return { stdout: factoryDoc([]) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: 'queue known=none now=none\n' }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth' }
      case 'callum-flow-issue-read':
        return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: '[]' }
    }
    return undefined
  }

  test('the argv the pass ran is callum-flow-event --type gate_run --data .. --issue N, and a second pass runs none', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work' },
      run: quiet,
      files: { [`${LOOP_DIR}/companion.jsonl`]: text(old({ waitMs: 0 }), line({ startedAt: new Date(NOW - 20 * MIN).toISOString() })) },
    })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true })
    const writes = () => h.events().filter(e => e[1] === '--type')
    expect(writes()).toHaveLength(2)
    const argv = writes().find(e => (JSON.parse(e[4] ?? '{}') as { queued_behind: number }).queued_behind === 1) as string[]
    expect(argv.slice(0, 4)).toEqual(['callum-flow-event', '--type', 'gate_run', '--data'])
    expect(argv.slice(5)).toEqual(['--issue', String(N)])
    expect(JSON.parse(argv[4] as string)).toEqual({ life: LIFE, seq: 7, head: HEAD, result: 'pass', wait_ms: 7_000, run_ms: 12_000, concurrency: 1, queued_behind: 1, started_at: new Date(NOW - 20 * MIN).toISOString() })
    await clock.advance(60_000)
    await clock.advance(60_000)
    expect(writes()).toHaveLength(2)
    expect(h.entry(`i${N}/l${LIFE}/s7/gate/${(NOW - 20 * MIN).toString(36)}`)).toMatchObject({ status: 'done' })
  })

  const verdicts: [string, Record<string, unknown>[], boolean][] = [
    ['a fail then a pass on one head, both clean', [{ head: HEAD }, { head: HEAD }], true],
    ['a fail, a new commit, then a pass', [{ head: HEAD }, { head: '5d3e9bb0000000000000000000000000000000ee' }], false],
    ['a fail then a pass in a dirty slot', [{ head: HEAD }, { head: HEAD, clean: false }], false],
  ]
  for (const [name, [f, p], flaky] of verdicts) test(`${name} writes the flake verdict once`, ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const failLine = line({ at: NOW - 30 * MIN + 12_000, cause: 'gate-fail', startedAt: new Date(NOW - 30 * MIN).toISOString(), waitMs: 0, queuedBehind: 0, clean: true, failedTests: ['a > b'], ...f })
    const passLine = line({ at: NOW - 20 * MIN + 12_000, startedAt: new Date(NOW - 20 * MIN).toISOString(), waitMs: 0, queuedBehind: 0, clean: true, ...p })
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: quiet, files: { [`${LOOP_DIR}/companion.jsonl`]: text(failLine, passLine) } })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    await clock.advance(60_000)
    await clock.advance(60_000)
    const writes = h.events().filter(e => e[1] === '--type').map(e => JSON.parse(e[4] ?? '{}') as Record<string, unknown>)
    expect(writes).toHaveLength(2)
    const got = writes.find(d => d.result === 'pass')
    expect(got?.flaky).toBe(flaky)
    if (flaky) expect(got).toMatchObject({ failed_tests: ['a > b'], failed_at: new Date(NOW - 30 * MIN).toISOString() })
    expect(writes.find(d => d.result === 'fail')).toMatchObject({ failed_tests: ['a > b'] })
  })
})
