// Actions that run off the pass (act-off.ts, v2 SPEC 13.2, 13.7.5): the pass starts the command with its
// running entry saved and does not wait; the completion applies what the inline run would have recorded,
// only to the attempt it began, and a command past its bound is timed out.
import { describe, expect, test } from 'claude-code/testing'

import { actOne } from '../hooks/act'
import type { ActEnv, Live } from '../hooks/act'
import { CLI_TIMEOUT_MS } from '../hooks/act-cli'
import { OFF_PASS, OFF_PASS_MARGIN_MS, completeOff, isOffPass, offPassExpired } from '../hooks/act-off'
import type { OffDone } from '../hooks/act-off'
import type { ActIo, RunResult } from '../hooks/exec'
import { loopEvent } from '../hooks/ledger'
import { emptyV2State } from '../hooks/v2/observe'
import { madeRecord } from '../hooks/v2/table'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const RATE = 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)'

const runtime = (): Runtime => ({
  mode: 'act',
  repo: REPO,
  device: DEVICE,
  runSource: 'local',
  poolSize: 16,
  cwd: '/work',
  loopDir: LOOP_DIR,
  sink: null,
  env: { CALLUM_FLOW_REPO: REPO },
  toolsDir: TOOLS,
  pluginRoot: PLUGIN_ROOT,
  config: config({ mode: 'act' }),
  configProblems: [],
})

const sweep: Action = { kind: 'sweep', key: 'sweep:0', class: 'free', rule: 'H2', reason: 'test', issue: null }
const heartbeat: Action = { kind: 'heartbeat', key: 'heartbeat:0', class: 'free', rule: 'H1', reason: 'test', issue: null }

// world: an act step over a fake ActIo whose commands answer when the test releases them (the clock is the test's).
function world(opts: { off: boolean; exit?: number; stderr?: string }) {
  const clock = { now: NOW }
  const live: Live = { ledger: [] }
  const finished: OffDone[] = []
  const saves: LedgerEntry[][] = []
  const argvs: string[][] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  const io = (wait: boolean): ActIo => ({
    now: async () => clock.now,
    run: async (argv): Promise<RunResult> => {
      argvs.push([...argv])
      if (wait) await gate
      return { exitCode: opts.exit ?? 0, stdout: '', stderr: opts.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } as RunResult
    },
    spawnAgent: async () => ({ agentId: 'a' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: null, sevenDay: null }),
    readFile: async () => null,
    writeFile: async () => undefined,
  })
  const env: ActEnv = {
    io: io(false),
    rt: runtime(),
    live,
    commands: [],
    wakeId: () => 'w1',
    session: 's',
    save: async () => {
      saves.push(live.ledger)
      return true
    },
    holds: async () => true,
    killed: async () => false,
    problems: [],
    ...(opts.off ? { offPass: { io: io(true), done: (d: OffDone) => void finished.push(d) } } : {}),
  }
  return { env, live, finished, saves, argvs, clock, release: () => release() }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('OFF_PASS', () => {
  test('lists heartbeat and sweep, and neither logs a loop event (the completion logs none)', () => {
    expect([...OFF_PASS]).toEqual(['heartbeat', 'sweep'])
    expect(isOffPass('sweep')).toBe(true)
    expect(isOffPass('claim')).toBe(false)
    for (const kind of OFF_PASS) expect(loopEvent(entry('k', kind, { status: 'done' }))).toBeNull()
  })
})

describe('an off-pass action', () => {
  test('starts without waiting: its running entry is saved, the outcome says running and off, the command is still out', async () => {
    const w = world({ off: true })
    const { outcome, exec } = await actOne(w.env, state(), sweep)
    expect(exec.status).toBe('running')
    expect(outcome).toMatchObject({ key: 'sweep:0', kind: 'sweep', status: 'running', off: true, ms: 0 })
    expect(w.saves).toHaveLength(1)
    expect(w.live.ledger).toMatchObject([{ key: 'sweep:0', status: 'running', attempts: 1 }])
    await settle()
    expect(w.finished).toEqual([])
  })

  test('without an offPass callback it runs inline, as before, and the outcome carries no off', async () => {
    const w = world({ off: false })
    const { outcome } = await actOne(w.env, state(), sweep)
    expect(outcome).toMatchObject({ status: 'done', summary: 'swept' })
    expect(outcome.off).toBeUndefined()
  })

  for (const [name, action, exit, stderr] of [
    ['a sweep that exits 0', sweep, 0, ''],
    ['a heartbeat that exits 0', heartbeat, 0, ''],
    ['a sweep that exits 1', sweep, 1, 'boom'],
    ['a sweep that exits 2 (a usage error)', sweep, 2, 'usage'],
    ['a sweep that meets a rate limit', sweep, 1, RATE],
  ] as const) {
    test(`${name}: the completion records what the inline run records`, async () => {
      const inline = world({ off: false, exit, stderr })
      await actOne(inline.env, state(), action)
      const off = world({ off: true, exit, stderr })
      await actOne(off.env, state(), action)
      off.clock.now = NOW + 40_000
      off.release()
      await settle()
      expect(off.finished).toHaveLength(1)
      const done = off.finished[0] as OffDone
      // (a heartbeat with no record to renew runs no command, so it ends at once: only the sweep's time is the command's)
      if (action.kind === 'sweep') {
        expect(done.ms).toBe(40_000)
        expect(done.endedAt).toBe(NOW + 40_000)
      }
      expect(await completeOff(off.env, done)).toBe(true)
      // the inline run ended at NOW, the off-pass one when its command did; everything else is equal
      const got = off.live.ledger[0] as LedgerEntry
      const want = inline.live.ledger[0] as LedgerEntry
      expect({ ...got, endedAt: 0 }).toEqual({ ...want, endedAt: 0 })
      expect(got.endedAt).toBe(done.endedAt)
      expect(done.exec.status === 'failed' ? done.exec.rateLimited === true : false).toBe(stderr === RATE)
    })
  }

  // a state with v2 records, so the heartbeat executor really runs `callum-flow-claim --heartbeat`
  const withRecords = (): State => ({ ...state(), v2: emptyV2State(NOW, [140, 141].map(n => madeRecord({ issue: n, life: 'l', branch: `issue-${n}`, pr: null, others: [] }, NOW))) })

  test('a heartbeat with records to renew runs its command off the pass: the entry stays running for 14 s, the completion records what the inline run records', async () => {
    const inline = world({ off: false })
    await actOne(inline.env, withRecords(), heartbeat)
    expect(inline.argvs).toEqual([['callum-flow-claim', '--heartbeat', '140', '141']])
    const w = world({ off: true })
    const { outcome } = await actOne(w.env, withRecords(), heartbeat)
    // started without awaiting: the command is out, the entry saved running, nothing finished
    expect(outcome).toMatchObject({ key: 'heartbeat:0', kind: 'heartbeat', status: 'running', off: true, ms: 0 })
    expect(w.argvs).toEqual([['callum-flow-claim', '--heartbeat', '140', '141']])
    expect(w.live.ledger).toMatchObject([{ key: 'heartbeat:0', status: 'running', attempts: 1 }])
    w.clock.now = NOW + 14_000
    await settle()
    expect(w.finished).toEqual([])
    expect(w.live.ledger[0]?.status).toBe('running')
    w.release()
    await settle()
    expect(w.finished).toHaveLength(1)
    const done = w.finished[0] as OffDone
    expect(done.ms).toBe(14_000)
    expect(done.endedAt).toBe(NOW + 14_000)
    expect(await completeOff(w.env, done)).toBe(true)
    const got = w.live.ledger[0] as LedgerEntry
    const want = inline.live.ledger[0] as LedgerEntry
    expect(got).toMatchObject({ status: 'done', summary: 'leases renewed: #140 #141', endedAt: NOW + 14_000 })
    expect({ ...got, endedAt: 0 }).toEqual({ ...want, endedAt: 0 })
  })

  test('a completion finds its own attempt only: a retry, a timeout or a pruned entry drops it', async () => {
    const cases: [string, (l: LedgerEntry[]) => LedgerEntry[]][] = [
      ['a newer attempt', l => l.map(e => ({ ...e, startedAt: e.startedAt + 1, attempts: 2 }))],
      ['a timeout', l => l.map(e => ({ ...e, status: 'timed-out' as const, endedAt: NOW + 1, summary: 'timed out' }))],
      ['a pruned entry', () => []],
    ]
    for (const [, change] of cases) {
      const w = world({ off: true })
      await actOne(w.env, state(), sweep)
      w.release()
      await settle()
      w.live.ledger = change(w.live.ledger)
      const before = w.live.ledger
      const saved = w.saves.length
      expect(await completeOff(w.env, w.finished[0] as OffDone)).toBe(false)
      expect(w.live.ledger).toBe(before)
      expect(w.saves).toHaveLength(saved)
    }
  })

  test('a ledger that cannot be saved starts nothing, off the pass too', async () => {
    const w = world({ off: true })
    w.env.save = async () => false
    const { outcome } = await actOne(w.env, state(), sweep)
    expect(outcome).toMatchObject({ status: 'skipped', summary: 'held: the ledger was not saved, so nothing starts' })
    expect(outcome.off).toBeUndefined()
    w.release()
    await settle()
    expect(w.finished).toEqual([])
  })
})

describe('offPassExpired', () => {
  const running = (kind: 'sweep' | 'heartbeat', age: number) => entry(`${kind}:0`, kind, { status: 'running', startedAt: NOW - age, endedAt: null })

  test('a running off-pass entry is timed out once past its command timeout plus the margin, and not before', () => {
    const limit = CLI_TIMEOUT_MS.sweep + OFF_PASS_MARGIN_MS
    expect(OFF_PASS_MARGIN_MS).toBe(60_000)
    expect(offPassExpired([running('sweep', limit)], NOW)).toEqual([])
    expect(offPassExpired([running('sweep', limit + 1)], NOW)).toEqual([{ key: 'sweep:0', status: 'timed-out', summary: 'timed out: no completion within 360 s' }])
    const hb = CLI_TIMEOUT_MS.heartbeat + OFF_PASS_MARGIN_MS
    expect(offPassExpired([running('heartbeat', hb + 1)], NOW)).toMatchObject([{ key: 'heartbeat:0', summary: 'timed out: no completion within 180 s' }])
  })

  test('only running off-pass entries: a done sweep, a running claim and a running wake are left', () => {
    const old = 30 * MIN
    expect(
      offPassExpired(
        [entry('sweep:1', 'sweep', { status: 'done', startedAt: NOW - old }), entry('c', 'claim', { status: 'running', startedAt: NOW - old, endedAt: null }), entry('j', 'judge', { status: 'running', startedAt: NOW - old, endedAt: null })],
        NOW,
      ),
    ).toEqual([])
  })
})
