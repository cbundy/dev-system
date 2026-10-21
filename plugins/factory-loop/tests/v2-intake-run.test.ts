// The intake stamp's real run (issue #1152, epic #995; docs/factory-loop/v2/SPEC.md 13.4): rule I1
// (v2/rules-intake.ts) plans one reader per issue and body version, the executor (v2/act-intake.ts) records
// the try before it spawns, stores the outcome, sets the labels with the owner's precedence and writes one
// intake_stamp event, and the store (v2/stamps.ts, store.ts) keeps what it needs.
import { describe, expect, test } from 'claude-code/testing'

import { intakeAnswered } from '../hooks/act-between'
import type { ActEnv } from '../hooks/act'
import type { ActIo, ExecCtx, RunInit, RunResult } from '../hooks/exec'
import { finish, loopEvent, start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import { parseIssuesRead } from '../hooks/parse'
import type { Action, Config, LedgerEntry, State } from '../hooks/types'
import { intakeExecutor, intakeFinish } from '../hooks/v2/act-intake'
import { INTAKE_AGENT, STAMP_TIMEOUT_MS } from '../hooks/v2/intake'
import { planLabels } from '../hooks/v2/intake-labels'
import { intakeKey, intakeSettleKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { score } from '../hooks/v2/score'
import { STAMP_RUNNING } from '../hooks/v2/rules-intake'
import { EMPTY_STAMP_STORE, stampStoreFromStore, stampsKey, withOwned, withStamp, withTry } from '../hooks/v2/stamps'
import type { Stamp } from '../hooks/v2/stamps'
import { loadV2, newV2Live, v2IoOf } from '../hooks/v2/store'
import type { V2StoreIo } from '../hooks/v2/store'
import type { V2State } from '../hooks/v2/types'
import { MIN, NOW, config, entry, issue, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const V1 = '1111111111111111'
const V2 = '2222222222222222'
const vOf = (n: number) => `${String(n).padStart(2, '0')}`.repeat(8)

const ANSWER = JSON.stringify({ area: 'factory', needs_owner: false, reason: 'The brief is complete.', touches: ['plugins', 'docs'] })
const ANSWER_OWNER = JSON.stringify({ area: 'product', needs_owner: true, reason: 'The brief asks for a choice.', touches: ['images'] })

// --- the planner: I1 --------------------------------------------------------------------------------------

type Plan = { issues: ReturnType<typeof issue>[]; queue: number[]; v2: Partial<V2State>; cfg: Partial<Config>; ledger: LedgerEntry[]; backoff: number | null; storeOk: boolean }

function planOf(over: Partial<Plan> = {}) {
  const p: Plan = { issues: [], queue: [], v2: {}, cfg: {}, ledger: [], backoff: null, storeOk: true, ...over }
  const v2: V2State = { ...emptyV2State(NOW), ...p.v2 }
  if (!p.storeOk) v2.sources = { ...v2.sources, store: { ok: false, at: null, error: 'down' } }
  const s = baseState({ issues: p.issues, queue: p.queue, v2, githubBackoffUntil: p.backoff })
  s.ledger = [...s.ledger, ...p.ledger]
  const cfg = config({ mode: 'act', intakeStamp: 'on', ...p.cfg })
  return { state: s, cfg, result: planV2(s, cfg) }
}

const ready = (n: number, over: Partial<ReturnType<typeof issue>> = {}) => issue(n, { labels: ['ready'], bodyVersion: vOf(n), ...over })
const intakeActions = (r: ReturnType<typeof planOf>['result']) => r.actions.filter((a): a is Extract<Action, { kind: 'intake-stamp' }> => a.kind === 'intake-stamp')
const claimsOf = (r: ReturnType<typeof planOf>['result']) => r.actions.filter(a => a.kind === 'claim').map(a => ({ key: a.key, issue: a.issue }))
const skipsOf = (r: ReturnType<typeof planOf>['result']) => r.skipped.filter(s => s.rule === 'I1').map(s => `${s.issue}:${s.why}`)
const tries = (m: Record<number, { version: string; outcome: 'running' | 'ok' | 'dropped' | 'failed' }>) => Object.fromEntries(Object.entries(m).map(([n, t]) => [n, { ...t, at: NOW - 5 * MIN }]))

describe('I1: the runs it plans (v2 SPEC 13.4)', () => {
  test('on: one run for each ready, trusted issue whose body version has no try, in ascending issue order', () => {
    const { result } = planOf({ issues: [ready(9), ready(3), ready(5)], queue: [9, 3, 5] })
    const runs = intakeActions(result)
    expect(runs.map(a => [a.issue, a.op, a.version, a.key, a.class, a.rule])).toEqual([
      [3, 'run', vOf(3), intakeKey(3, vOf(3)), 'develop', 'I1'],
      [5, 'run', vOf(5), intakeKey(5, vOf(5)), 'develop', 'I1'],
    ])
    // the cap holds the third
    expect(skipsOf(result)).toEqual([`9:cap`])
  })

  test('off (the default): no action, no skip line and no ledger entry of the kind, whatever the queue holds', () => {
    const { result } = planOf({ issues: [ready(3), ready(5)], queue: [3, 5], cfg: { intakeStamp: 'off' } })
    expect(intakeActions(result)).toEqual([])
    expect(skipsOf(result)).toEqual([])
    expect(result.actions.some(a => a.rule === 'I1')).toBe(false)
  })

  test('a version tried is not tried again, whatever its outcome, and says tried; an edited body plans once', () => {
    for (const outcome of ['running', 'ok', 'dropped', 'failed'] as const) {
      // a running try has its run going
      const ledger = outcome === 'running' ? [entry(intakeKey(3, vOf(3)), 'intake-stamp', { issue: 3, status: 'running', endedAt: null, startedAt: NOW - MIN, agentId: 'a3', class: 'develop' })] : []
      const { result } = planOf({ issues: [ready(3)], queue: [3], ledger, v2: { stampTries: tries({ 3: { version: vOf(3), outcome } }) } })
      expect(intakeActions(result)).toEqual([])
      expect(skipsOf(result)).toContain('3:tried')
    }
    const edited = planOf({ issues: [ready(3, { bodyVersion: V2 })], queue: [3], v2: { stampTries: tries({ 3: { version: V1, outcome: 'ok' } }) } })
    expect(intakeActions(edited.result).map(a => [a.issue, a.version])).toEqual([[3, V2]])
  })

  test('the cap counts the running runs of the ledger and the ones planned in the same pass', () => {
    const run = (n: number) => entry(intakeKey(n, vOf(n)), 'intake-stamp', { issue: n, status: 'running', endedAt: null, startedAt: NOW - MIN, agentId: `a${n}`, class: 'develop' })
    const one = planOf({ issues: [ready(3), ready(5), ready(7)], queue: [3, 5, 7], ledger: [run(1)] })
    expect(intakeActions(one.result).map(a => a.issue)).toEqual([3])
    expect(skipsOf(one.result)).toEqual(['5:cap', '7:cap'])
    const two = planOf({ issues: [ready(3)], queue: [3], ledger: [run(1), run(2)] })
    expect(STAMP_RUNNING).toBe(2)
    expect(intakeActions(two.result)).toEqual([])
    expect(skipsOf(two.result)).toEqual(['3:cap'])
    // a finished run, and a settle, do not count
    const done = planOf({ issues: [ready(3)], queue: [3], ledger: [entry(intakeKey(1, vOf(1)), 'intake-stamp', { issue: 1, status: 'done' }), entry(intakeSettleKey(2, vOf(2)), 'intake-stamp', { issue: 2, status: 'running', endedAt: null })] })
    expect(intakeActions(done.result).map(a => a.issue)).toEqual([3])
  })

  test('nothing is planned while the store is not read or GitHub is in backoff', () => {
    const base = { issues: [ready(3)], queue: [3] }
    expect(intakeActions(planOf({ ...base, storeOk: false }).result)).toEqual([])
    expect(intakeActions(planOf({ ...base, backoff: NOW + MIN }).result)).toEqual([])
    expect(intakeActions(planOf({ ...base, backoff: NOW - MIN }).result).map(a => a.issue)).toEqual([3])
  })

  test('a missing body version (an older image) is skipped with no-body-version, never stamped', () => {
    const { result } = planOf({ issues: [ready(3, { bodyVersion: null })], queue: [3] })
    expect(intakeActions(result)).toEqual([])
    expect(skipsOf(result)).toEqual(['3:no-body-version'])
  })

  test('issues S1 would not look at are never planned: not ready, untrusted, closed, skip-labelled, rejected or not in the queue', () => {
    const issues = [
      ready(1, { labels: ['bug'] }),
      ready(2, { trusted: false }),
      ready(3, { open: false }),
      ready(4, { labels: ['ready', 'wontfix'] }),
      ready(5, { labels: ['ready', 'factory:rejected'] }),
      ready(6),
      ready(7, { labels: null }),
    ]
    const { result } = planOf({ issues, queue: [1, 2, 3, 4, 5, 7], cfg: { skipLabels: ['wontfix'] } })
    expect(intakeActions(result)).toEqual([])
    expect(skipsOf(result)).toEqual([])
    // blocked and tracker issues are still stamped: the stamp does not claim them
    const blocked = planOf({ issues: [ready(8, { blockedBy: 2 })], queue: [8] })
    expect(intakeActions(blocked.result).map(a => a.issue)).toEqual([8])
  })

  test('S1\'s choice is the same with and without I1: the same claims, in the same order, and none for I1', () => {
    const issues = [ready(9, { labels: ['ready', 'priority'] }), ready(3), ready(5, { blockedBy: null })]
    const on = planOf({ issues, queue: [9, 3, 5], cfg: { maxInFlightIssues: 5 } })
    const off = planOf({ issues, queue: [9, 3, 5], cfg: { maxInFlightIssues: 5, intakeStamp: 'off' } })
    expect(claimsOf(on.result)).toEqual(claimsOf(off.result))
    expect(claimsOf(on.result).length).toBeGreaterThan(0)
    // the claim is planned before any intake run
    const kinds = on.result.actions.map(a => a.kind)
    expect(kinds.indexOf('claim')).toBeLessThan(kinds.indexOf('intake-stamp'))
    expect(on.result.skipped.filter(s => s.rule === 'S1')).toEqual(off.result.skipped.filter(s => s.rule === 'S1'))
  })
})

describe('I1: settling a run that never ended', () => {
  const runEntry = (over: Partial<LedgerEntry> = {}) => entry(intakeKey(3, vOf(3)), 'intake-stamp', { issue: 3, status: 'running', endedAt: null, startedAt: NOW - MIN, agentId: 'a3', class: 'develop', ...over })
  const running = { stampTries: tries({ 3: { version: vOf(3), outcome: 'running' } }) }
  const settles = (r: ReturnType<typeof planOf>['result']) => intakeActions(r).filter(a => a.op === 'settle').map(a => [a.issue, a.version, a.why, a.key, a.class])

  test('a run past STAMP_TIMEOUT_MS settles as timeout; a younger one is left running', () => {
    const old = planOf({ issues: [ready(3)], queue: [3], v2: running, ledger: [runEntry({ startedAt: NOW - STAMP_TIMEOUT_MS - 1 })] })
    expect(settles(old.result)).toEqual([[3, vOf(3), 'timeout', intakeSettleKey(3, vOf(3)), 'free']])
    const young = planOf({ issues: [ready(3)], queue: [3], v2: running, ledger: [runEntry({ startedAt: NOW - STAMP_TIMEOUT_MS + MIN })] })
    expect(settles(young.result)).toEqual([])
    // and no new run for that version meanwhile
    expect(intakeActions(young.result)).toEqual([])
  })

  test('an entry that ended lost or failed, or is gone, with its try still running: settled lost, spawn-failed, lost', () => {
    for (const [ledger, why] of [
      [[runEntry({ status: 'lost', endedAt: NOW - MIN })], 'lost'],
      [[runEntry({ status: 'failed', endedAt: NOW - MIN })], 'spawn-failed'],
      [[runEntry({ status: 'timed-out', endedAt: NOW - MIN })], 'timeout'],
      [[], 'lost'],
    ] as const) {
      const r = planOf({ issues: [ready(3)], queue: [3], v2: running, ledger: [...ledger] })
      expect(settles(r.result).map(s => s[2])).toEqual([why])
    }
  })

  test('a settled try (failed) plans no second settle and no new run for that version', () => {
    const r = planOf({ issues: [ready(3)], queue: [3], v2: { stampTries: tries({ 3: { version: vOf(3), outcome: 'failed' } }) }, ledger: [runEntry({ status: 'lost', endedAt: NOW - MIN })] })
    expect(intakeActions(r.result)).toEqual([])
  })

  test('a settle that is done ends the run\'s own running entry, so it no longer counts against the cap', () => {
    const settleAction = intakeActions(planOf({ issues: [ready(3)], queue: [3], v2: running, ledger: [runEntry({ startedAt: NOW - STAMP_TIMEOUT_MS - 1 })] }).result)[0] as Action
    const ledger = [runEntry({ startedAt: NOW - STAMP_TIMEOUT_MS - 1 })]
    const started = start(ledger, settleAction, NOW)
    const ended = finish(started.ledger, settleAction.key, { status: 'done', summary: 'x' }, NOW)
    expect(ended.find(e => e.key === intakeKey(3, vOf(3)))).toMatchObject({ status: 'timed-out', endedAt: NOW })
    expect(ended.find(e => e.key === settleAction.key)?.status).toBe('done')
  })
})

describe('the ledger entry of an intake run', () => {
  test('it records its session (for the token totals) and writes no loop_entry', () => {
    const action = intakeActions(planOf({ issues: [ready(3)], queue: [3] }).result)[0] as Action
    const { entry: e } = start([], action, NOW, 'session-9')
    expect(e).toMatchObject({ kind: 'intake-stamp', issue: 3, session: 'session-9', status: 'running' })
    expect(loopEvent({ ...e, status: 'done' })).toBeNull()
    expect(loopEvent(e)).toBeNull()
  })
})

// --- the labels ---------------------------------------------------------------------------------------------

const prevStamp = (over: Partial<Stamp> = {}): Stamp => ({ version: V1, area: 'factory', needsOwner: true, touches: [], at: NOW - 60 * MIN, labels: ['area:factory', 'needs-decision'], ...over })

describe('the label rules (owner precedence)', () => {
  const plan = (current: string[], prev: Stamp | null, over: Partial<Parameters<typeof planLabels>[0]> = {}) => planLabels({ current, prev, owned: [], area: 'factory', needsOwner: false, ...over })

  test('a first stamp on a bare issue sets area:<area>, and needs-decision when needs_owner', () => {
    expect(plan(['ready'], null)).toEqual({ add: ['area:factory'], remove: [], stored: ['area:factory'], kept: [], owned: [] })
    expect(plan(['ready'], null, { needsOwner: true })).toMatchObject({ add: ['area:factory', 'needs-decision'], stored: ['area:factory', 'needs-decision'] })
  })

  test('a first stamp keeps an area:* or needs-decision the issue already carries, and owns that group', () => {
    expect(plan(['ready', 'area:product'], null)).toEqual({ add: [], remove: [], stored: [], kept: ['area:product'], owned: ['area'] })
    expect(plan(['ready', 'Needs-Decision'], null, { needsOwner: false })).toMatchObject({ add: ['area:factory'], kept: ['Needs-Decision'], owned: ['needs-decision'] })
  })

  test('an owner who changed a group since the last stamp keeps it, and a group owned stays so', () => {
    // the owner swapped area:factory for area:product
    expect(plan(['area:product', 'needs-decision'], prevStamp(), { area: 'factory', needsOwner: true })).toMatchObject({ add: [], remove: [], kept: ['area:product'], owned: ['area'], stored: ['needs-decision'] })
    // the owner removed needs-decision
    expect(plan(['area:factory'], prevStamp(), { needsOwner: true })).toMatchObject({ kept: [], owned: ['needs-decision'], add: [], stored: ['area:factory'] })
    // owned before: never touched again, even when the labels match what the loop would set
    expect(plan(['area:factory'], prevStamp({ labels: [] }), { owned: ['area'], area: 'product' })).toMatchObject({ add: [], remove: [], kept: ['area:factory'], owned: ['area'] })
  })

  test('the loop removes only labels it set: a changed area, needs_owner turning false', () => {
    expect(plan(['area:factory', 'needs-decision', 'bug'], prevStamp(), { area: 'product', needsOwner: false })).toEqual({
      add: ['area:product'],
      remove: ['area:factory', 'needs-decision'],
      stored: ['area:product'],
      kept: [],
      owned: [],
    })
    // a label the loop never set is not removed, whatever the answer
    expect(plan(['area:factory', 'needs-decision'], prevStamp({ labels: ['area:factory'] }), { needsOwner: false })).toMatchObject({ remove: [], owned: ['needs-decision'], kept: ['needs-decision'] })
  })
})

// --- the executor ---------------------------------------------------------------------------------------------

type World = {
  store: { value: unknown }
  argvs: string[][]
  spawns: Parameters<ActIo['spawnAgent']>[0][]
  stops: string[]
  events: { type: string; data: Record<string, unknown>; at: { issue: number } }[]
  stoppedAfterSpawn: unknown[]
  labels: { current: string[] }
  failures: { read: boolean; spawn: 'deny' | 'throw' | null; set: boolean; labelAdd: boolean; labelsRead: boolean; labelMake: 'exists' | 'fail' | null }
  files: Record<string, string>
  ctx: (action: Action | null, entry: LedgerEntry, over?: Partial<State>) => ExecCtx
  rt: Runtime
}

const SESSION_DIR = '/cfg/projects/-work/s1/subagents'
const transcript = (...lines: object[]) => lines.map(l => JSON.stringify(l)).join('\n')
const assistant = (requestId: string, u: { in: number; out: number; read: number; create: number }) => ({
  type: 'assistant',
  requestId,
  message: { model: 'claude-haiku-4-5', usage: { input_tokens: u.in, output_tokens: u.out, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.create } },
})

function world(over: { cfg?: Partial<Config>; store?: unknown; labels?: string[]; transcript?: boolean } = {}): World {
  const w = {
    store: { value: over.store ?? null },
    argvs: [] as string[][],
    spawns: [] as World['spawns'],
    stops: [] as string[],
    events: [] as World['events'],
    stoppedAfterSpawn: [] as unknown[],
    labels: { current: over.labels ?? ['ready'] },
    failures: { read: false, spawn: null, set: false, labelAdd: false, labelsRead: false, labelMake: null } as World['failures'],
    files: (over.transcript === false ? {} : { [`${SESSION_DIR}/agent-a3.jsonl`]: transcript(assistant('r1', { in: 100, out: 20, read: 900, create: 50 }), assistant('r2', { in: 10, out: 5, read: 90, create: 0 })) }) as Record<string, string>,
  }
  const rt: Runtime = {
    mode: 'act',
    repo: REPO,
    device: 'd',
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP_DIR,
    configDir: '/cfg',
    sessionCwd: '/work',
    sink: null,
    env: {},
    toolsDir: TOOLS,
    pluginRoot: '/plugins/factory-loop',
    config: config({ mode: 'act', intakeStamp: 'on', ...over.cfg }),
    configProblems: [],
  }
  const reply = (argv: string[]): Partial<RunResult> => {
    const [cmd, ...args] = argv
    if (cmd === 'callum-flow-issue-read') {
      if (args.includes('--comments')) return w.failures.read ? { exitCode: 1, stderr: 'boom' } : { stdout: `issue: #${args[0]}\nstate: open\ntitle: T\nbody:\nDo the thing\nstripped: 0\n` }
      if (w.failures.labelsRead) return { exitCode: 1, stderr: 'nope' }
      return { stdout: JSON.stringify({ issue: { state: 'open', title: 'T', labels: w.labels.current.map(name => ({ name })) }, stripped: 0 }) }
    }
    if (cmd === 'git' && args[0] === 'ls-tree') return { stdout: 'docs\nplugins\n' }
    if (cmd === 'gh' && args[0] === 'label' && w.failures.labelMake === 'exists') return { exitCode: 1, stderr: 'label "area:factory" already exists' }
    if (cmd === 'gh' && args[0] === 'label' && w.failures.labelMake === 'fail') return { exitCode: 1, stderr: 'HTTP 500' }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label') && w.failures.labelAdd) return { exitCode: 1, stderr: 'cannot label' }
    if (cmd === 'find' || cmd === 'grep') return { exitCode: 1 }
    return {}
  }
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv: string[], _init: RunInit & { cwd: string; env: Record<string, string> }) => {
      w.argvs.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    spawnAgent: async input => {
      w.spawns.push(input)
      // the try is in the store before the reader exists
      w.stoppedAfterSpawn.push(JSON.parse(JSON.stringify(w.store.value)))
      if (w.failures.spawn === 'throw') throw new Error('engine gone')
      if (w.failures.spawn === 'deny') return { deny: 'not offered' }
      return { agentId: 'a3' }
    },
    stopAgent: async id => {
      w.stops.push(id)
      return { stopped: true }
    },
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async p => w.files[p] ?? null,
    writeFile: async () => undefined,
    v2: {
      records: () => [],
      updateRecords: async () => ({ changed: false, saved: false }),
      updateStamps: async fn => {
        const before = w.store.value
        const next = fn(before)
        if (next === null || next === undefined) return { changed: false, saved: true }
        if (w.failures.set) return { changed: false, saved: false }
        w.store.value = JSON.parse(JSON.stringify(next))
        return { changed: true, saved: true }
      },
      ping: () => undefined,
    },
  }
  w.ctx = (action, e, st = {}) => {
    const cmd: ExecCtx['cmd'] = (argv, init) => io.run(argv, { cwd: '/work', env: {}, timeoutMs: init.timeoutMs })
    void action
    return { io, rt, state: { ...baseState(), ...st }, entry: e, cmd, event: async (type, data, at) => void w.events.push({ type, data, at }), wakeId: () => 'w' }
  }
  return Object.assign(w, { rt }) as unknown as World
}

const runAction = (n: number, version: string): Action => ({ kind: 'intake-stamp', op: 'run', key: intakeKey(n, version), class: 'develop', rule: 'I1', reason: 'x', issue: n, version, maxAttempts: 2 })
const settleAction = (n: number, version: string, why = 'timeout'): Action => ({ kind: 'intake-stamp', op: 'settle', key: intakeSettleKey(n, version), class: 'free', rule: 'I1', reason: 'x', issue: n, version, why })
const runEntry = (n: number, version: string, over: Partial<LedgerEntry> = {}): LedgerEntry => entry(intakeKey(n, version), 'intake-stamp', { issue: n, status: 'running', endedAt: null, class: 'develop', startedAt: NOW - MIN, agentId: 'a3', session: 's1', ...over })
const storeOf = (w: World) => stampStoreFromStore(w.store.value)
const labelArgvs = (w: World) => w.argvs.filter(a => a[0] === 'gh')
const tokenFields = { input_tokens: 110, output_tokens: 25, cache_read_tokens: 990, cache_creation_tokens: 50 }

describe('the run: the try first, then the reader', () => {
  test('it reads the issue and the listing, records the try, then spawns the reader named intake-<N>-<version> on intakeModel', async () => {
    const w = world()
    const e = runEntry(3, V1, { agentId: undefined })
    const r = await intakeExecutor(w.ctx(null, e), runAction(3, V1))
    expect(r).toMatchObject({ status: 'running', agentId: 'a3' })
    expect(w.argvs.slice(0, 2)).toEqual([['callum-flow-issue-read', '3', '--comments'], ['git', 'ls-tree', '--name-only', 'origin/main']])
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0]).toMatchObject({ subagentType: INTAKE_AGENT, model: 'haiku', name: `intake-3-${V1}` })
    expect(w.spawns[0]?.prompt).toContain('Do the thing')
    expect(w.spawns[0]?.prompt).toContain('plugins')
    // the try was in the store when the reader was spawned
    expect(stampStoreFromStore(w.stoppedAfterSpawn[0]).tries).toEqual({ '3': { version: V1, outcome: 'running', at: NOW } })
    // nothing is written to GitHub and no event yet
    expect(labelArgvs(w)).toEqual([])
    expect(w.events).toEqual([])
  })

  test('the same version is never spawned twice, whatever became of the first try', async () => {
    for (const outcome of ['running', 'ok', 'dropped', 'failed'] as const) {
      const w = world({ store: withTry(null, 3, { version: V1, outcome, at: NOW - MIN }) })
      const r = await intakeExecutor(w.ctx(null, runEntry(3, V1)), runAction(3, V1))
      expect(r.status).toBe('done')
      expect(w.spawns).toEqual([])
      expect(w.events).toEqual([])
    }
    // an edited body is a new version and runs
    const w = world({ store: withTry(null, 3, { version: V1, outcome: 'ok', at: NOW - MIN }) })
    expect((await intakeExecutor(w.ctx(null, runEntry(3, V2)), runAction(3, V2))).status).toBe('running')
    expect(storeOf(w).tries['3']).toMatchObject({ version: V2, outcome: 'running' })
  })

  test('a spawn that is denied or throws fails the try (spawn-failed), writes one event and is never tried again', async () => {
    for (const spawn of ['deny', 'throw'] as const) {
      const w = world()
      w.failures.spawn = spawn
      const r = await intakeExecutor(w.ctx(null, runEntry(3, V1, { agentId: undefined })), runAction(3, V1))
      expect(r.status).toBe('failed')
      expect(storeOf(w).tries['3']).toMatchObject({ version: V1, outcome: 'failed', reason: 'spawn-failed' })
      expect(w.events).toHaveLength(1)
      expect(w.events[0]).toMatchObject({ type: 'intake_stamp', at: { issue: 3 }, data: { mode: 'run', outcome: 'failed', reason: 'spawn-failed', version: V1, model: 'haiku', area: null, labels_set: [], input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null } })
    }
  })

  test('an issue that cannot be read records no try and starts no reader; a store that refuses the try starts none either', async () => {
    const unread = world()
    unread.failures.read = true
    expect((await intakeExecutor(unread.ctx(null, runEntry(3, V1)), runAction(3, V1))).status).toBe('failed')
    expect(unread.store.value).toBeNull()
    expect(unread.spawns).toEqual([])
    const full = world()
    full.failures.set = true
    const r = await intakeExecutor(full.ctx(null, runEntry(3, V1)), runAction(3, V1))
    expect(r).toMatchObject({ status: 'failed' })
    expect(full.spawns).toEqual([])
  })

  test('off: the executor refuses before it reads, records or spawns anything', async () => {
    const w = world({ cfg: { intakeStamp: 'off' } })
    const r = await intakeExecutor(w.ctx(null, runEntry(3, V1)), runAction(3, V1))
    expect(r).toMatchObject({ status: 'failed', noRetry: true })
    expect(w.argvs).toEqual([])
    expect(w.spawns).toEqual([])
    expect(w.store.value).toBeNull()
    expect(w.events).toEqual([])
  })
})

describe('the end of a run: the outcome, the stamp, the labels, one event', () => {
  const running = (extra: Record<string, unknown> = {}) => ({ ...(withTry(null, 3, { version: V1, outcome: 'running', at: NOW - 2 * MIN }) as Record<string, unknown>), ...extra })

  test('ok: area:<area> is set (the missing label made without --force), the stamp and try are stored, one event carries the tokens', async () => {
    const w = world({ store: running() })
    const r = await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(r.status).toBe('done')
    expect(labelArgvs(w)).toEqual([
      ['gh', 'label', 'create', 'area:factory', '--repo', REPO, '--color', expect.stringMatching(/^[0-9a-f]{6}$/), '--description', expect.any(String)],
      ['gh', 'issue', 'edit', '3', '--repo', REPO, '--add-label', 'area:factory'],
    ])
    expect(w.argvs.flat()).not.toContain('--force')
    expect(storeOf(w)).toMatchObject({
      stamps: { '3': { version: V1, area: 'factory', needsOwner: false, touches: ['plugins', 'docs'], at: NOW, labels: ['area:factory'] } },
      tries: { '3': { version: V1, outcome: 'ok', at: NOW } },
      owned: {},
    })
    expect(w.events).toEqual([
      {
        type: 'intake_stamp',
        at: { issue: 3 },
        data: { version: V1, mode: 'run', outcome: 'ok', area: 'factory', needs_owner: false, reason: 'The brief is complete.', touches: ['plugins', 'docs'], dropped: [], labels_set: ['area:factory'], labels_kept: [], model: 'haiku', ...tokenFields },
      },
    ])
  })

  test('needs_owner adds needs-decision too; a label that exists already (the create says so) is no problem', async () => {
    const w = world({ store: running() })
    w.failures.labelMake = 'exists'
    const r = await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER_OWNER, reason: 'answer' })
    expect(r.status).toBe('done')
    expect(labelArgvs(w).filter(a => a[1] === 'label').map(a => a[3])).toEqual(['area:product', 'needs-decision'])
    expect(labelArgvs(w).at(-1)).toEqual(['gh', 'issue', 'edit', '3', '--repo', REPO, '--add-label', 'area:product,needs-decision'])
    expect(storeOf(w).stamps['3']).toMatchObject({ area: 'product', needsOwner: true, labels: ['area:product', 'needs-decision'] })
    expect(w.events[0]?.data).toMatchObject({ labels_set: ['area:product', 'needs-decision'], labels_kept: [] })
  })

  test('a pre-existing area:* on the first stamp is kept and owned, and nothing is added for it', async () => {
    const w = world({ store: running(), labels: ['ready', 'area:product'] })
    await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(labelArgvs(w)).toEqual([])
    expect(storeOf(w).owned).toEqual({ '3': ['area'] })
    expect(storeOf(w).stamps['3']?.labels).toEqual([])
    expect(w.events[0]?.data).toMatchObject({ outcome: 'ok', labels_set: [], labels_kept: ['area:product'] })
  })

  test('an owner-changed area label is kept (labels_kept) and a later version does not touch it', async () => {
    // stamped before: area:factory, which the owner then changed to area:product
    const earlier = withStamp(running(), 3, prevStamp({ labels: ['area:factory'] }))
    const w = world({ store: earlier, labels: ['ready', 'area:product'] })
    await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(labelArgvs(w)).toEqual([])
    expect(w.events[0]?.data).toMatchObject({ labels_set: [], labels_kept: ['area:product'] })
    expect(storeOf(w).owned).toEqual({ '3': ['area'] })
    // the next version: the group is the owner's, whatever the labels say now
    w.store.value = withTry(w.store.value, 3, { version: V2, outcome: 'running', at: NOW })
    w.labels.current = ['ready']
    w.argvs.length = 0
    await intakeFinish(w.ctx(null, runEntry(3, V2)), runEntry(3, V2), { answer: ANSWER_OWNER, reason: 'answer' })
    expect(labelArgvs(w).flat().join(' ')).not.toContain('area:')
    expect(storeOf(w).owned).toEqual({ '3': ['area'] })
  })

  test('a new version removes only what the loop set: the old area, and needs-decision once needs_owner is false', async () => {
    const earlier = withStamp(running(), 3, prevStamp({ labels: ['area:product', 'needs-decision'] }))
    const w = world({ store: earlier, labels: ['ready', 'area:product', 'needs-decision', 'bug'] })
    await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(labelArgvs(w).filter(a => a[1] === 'issue')).toEqual([
      ['gh', 'issue', 'edit', '3', '--repo', REPO, '--add-label', 'area:factory'],
      ['gh', 'issue', 'edit', '3', '--repo', REPO, '--remove-label', 'area:product,needs-decision'],
    ])
    expect(storeOf(w).stamps['3']).toMatchObject({ area: 'factory', labels: ['area:factory'] })
  })

  test('a dropped answer stores only the try, sets no label, leaves the stamp factors at 0 and writes one event', async () => {
    const w = world({ store: running() })
    const dropped = JSON.stringify({ area: 'factory', needs_owner: 'maybe', reason: 'x', touches: ['plugins'] })
    const r = await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: dropped, reason: 'answer' })
    expect(r.status).toBe('done')
    expect(labelArgvs(w)).toEqual([])
    expect(storeOf(w).stamps).toEqual({})
    expect(storeOf(w).tries['3']).toMatchObject({ version: V1, outcome: 'dropped' })
    expect(w.events).toHaveLength(1)
    expect(w.events[0]?.data).toMatchObject({ outcome: 'dropped', area: 'factory', needs_owner: null, dropped: ['needs_owner'], labels_set: [], labels_kept: [], mode: 'run', ...tokenFields })
  })

  test('a failed answer (no object, or a turn that ended in error) stores only the failed try; the score factors stay at 0', async () => {
    for (const [answer, reason, why] of [['no json here', 'answer', 'the answer holds no JSON object'], ['', 'error', 'ended without an answer (error)']] as const) {
      const w = world({ store: running() })
      await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer, reason })
      expect(labelArgvs(w)).toEqual([])
      const kept = storeOf(w)
      expect(kept.stamps).toEqual({})
      expect(kept.tries['3']).toMatchObject({ version: V1, outcome: 'failed', reason: why })
      expect(w.events).toHaveLength(1)
      expect(w.events[0]?.data).toMatchObject({ outcome: 'failed', area: null, needs_owner: null, reason: why, touches: [], dropped: [], labels_set: [] })
      // no stamp: the stamp factors are null, and every other factor is what it was without the switch
      const i = issue(3, { labels: ['ready', 'area:factory'] })
      const base = { now: NOW, weights: config().queueScore, priorityLabel: 'priority', held: new Set<number>(), blocking: () => null, failedLives: () => 0 }
      const off = score(i, base)
      const on = score(i, { ...base, intake: { stamp: n => kept.stamps[String(n)] ?? null, inFlightPaths: { 5: ['plugins'] } } })
      expect(on.score).toBe(off.score)
    }
  })

  test('the tokens are null when the transcript cannot be read', async () => {
    const w = world({ store: running(), transcript: false })
    await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(w.events).toHaveLength(1)
    expect(w.events[0]?.data).toMatchObject({ input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null })
  })

  test('labels that cannot be read are not guessed: the stamp is stored with none set; a failed add is not the loop\'s label', async () => {
    const unread = world({ store: running() })
    unread.failures.labelsRead = true
    const r = await intakeFinish(unread.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(r.status).toBe('done')
    expect(labelArgvs(unread)).toEqual([])
    expect(storeOf(unread).stamps['3']).toMatchObject({ area: 'factory', labels: [] })
    expect(storeOf(unread).owned).toEqual({})
    const refused = world({ store: running() })
    refused.failures.labelAdd = true
    await intakeFinish(refused.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(storeOf(refused).stamps['3']?.labels).toEqual([])
    expect(refused.events[0]?.data).toMatchObject({ outcome: 'ok', labels_set: [] })
  })

  test('an answer after the try ended (settled, or another version) writes nothing: no label, no store change, no event', async () => {
    const settled = world({ store: withTry(null, 3, { version: V1, outcome: 'failed', at: NOW - MIN, reason: 'timeout' }) })
    const r = await intakeFinish(settled.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER, reason: 'answer' })
    expect(r.status).toBe('done')
    expect(labelArgvs(settled)).toEqual([])
    expect(settled.events).toEqual([])
    expect(storeOf(settled).stamps).toEqual({})
    expect(storeOf(settled).tries['3']).toMatchObject({ outcome: 'failed', reason: 'timeout' })
  })

  test('a store that will not take the outcome fails the entry and writes no event (the try stays running, so I1 settles it)', async () => {
    const w = world({ store: running() })
    w.failures.set = true
    const r = await intakeFinish(w.ctx(null, runEntry(3, V1)), runEntry(3, V1), { answer: ANSWER_OWNER.replace('product', 'factory'), reason: 'answer' })
    expect(r.status).toBe('failed')
    expect(w.events).toEqual([])
  })
})

describe('settle', () => {
  test('a run past its time: the agent is stopped, the try is recorded failed (timeout) and exactly one event is written', async () => {
    const w = world({ store: withTry(null, 3, { version: V1, outcome: 'running', at: NOW - 20 * MIN }) })
    const e = runEntry(3, V1, { startedAt: NOW - 20 * MIN })
    const state: Partial<State> = { ledger: [e] }
    const r = await intakeExecutor(w.ctx(null, entry(intakeSettleKey(3, V1), 'intake-stamp', { issue: 3, status: 'running', endedAt: null }), state), settleAction(3, V1))
    expect(r.status).toBe('done')
    expect(w.stops).toEqual(['a3'])
    expect(storeOf(w).tries['3']).toEqual({ version: V1, outcome: 'failed', at: NOW, reason: 'timeout' })
    expect(w.events).toHaveLength(1)
    expect(w.events[0]?.data).toMatchObject({ outcome: 'failed', reason: 'timeout', mode: 'run', version: V1, ...tokenFields })
    // settled again: nothing more is written
    const again = await intakeExecutor(w.ctx(null, entry(intakeSettleKey(3, V1), 'intake-stamp', { issue: 3 }), state), settleAction(3, V1))
    expect(again.status).toBe('done')
    expect(w.events).toHaveLength(1)
    // and no new run for that version
    const run = await intakeExecutor(w.ctx(null, runEntry(3, V1)), runAction(3, V1))
    expect(run.status).toBe('done')
    expect(w.spawns).toEqual([])
  })

  test('a lost run has no agent to stop, and its try is failed lost; a store that refuses fails the settle without an event', async () => {
    const w = world({ store: withTry(null, 3, { version: V1, outcome: 'running', at: NOW - 20 * MIN }) })
    await intakeExecutor(w.ctx(null, entry(intakeSettleKey(3, V1), 'intake-stamp', { issue: 3 }), { ledger: [runEntry(3, V1, { status: 'lost', endedAt: NOW - MIN, agentId: undefined })] }), settleAction(3, V1, 'lost'))
    expect(w.stops).toEqual([])
    expect(storeOf(w).tries['3']).toMatchObject({ outcome: 'failed', reason: 'lost' })
    expect(w.events).toHaveLength(1)
    const refused = world({ store: withTry(null, 3, { version: V1, outcome: 'running', at: NOW - 20 * MIN }) })
    refused.failures.set = true
    expect((await intakeExecutor(refused.ctx(null, entry(intakeSettleKey(3, V1), 'intake-stamp', { issue: 3 })), settleAction(3, V1))).status).toBe('failed')
    expect(refused.events).toEqual([])
  })
})

describe('the turn that ends a run (act-between.ts intakeAnswered)', () => {
  function envOf(w: World, ledger: LedgerEntry[]): ActEnv {
    const io = w.ctx(null, ledger[0] as LedgerEntry).io
    return { io, rt: w.rt, live: { ledger }, commands: [], wakeId: () => 'w1', session: 's1', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  }

  test('a running intake entry with that agent takes the turn: its answer is the stamp and its entry is done', async () => {
    const w = world({ store: withTry(null, 3, { version: V1, outcome: 'running', at: NOW - MIN }) })
    const env = envOf(w, [runEntry(3, V1)])
    const r = await intakeAnswered(env, baseState(), { agentId: 'a3', answer: ANSWER, reason: 'answer' })
    expect(r).toEqual({ result: 'applied', key: intakeKey(3, V1) })
    expect(env.live.ledger[0]).toMatchObject({ status: 'done', endedAt: NOW })
    expect(storeOf(w).stamps['3']).toMatchObject({ version: V1, area: 'factory' })
    // the executor's own event, through the event tool
    const events = w.argvs.filter(a => a[0] === 'callum-flow-event')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.arrayContaining(['--type', 'intake_stamp', '--issue', '3']))
    // a second turn of the same agent is not ours any more
    expect(await intakeAnswered(env, baseState(), { agentId: 'a3', answer: ANSWER, reason: 'answer' })).toBeNull()
  })

  test('another agent, and an agent step, are not taken', async () => {
    const w = world({ store: withTry(null, 3, { version: V1, outcome: 'running', at: NOW - MIN }) })
    const step = entry('i3/l1/s2/build/a1', 'agent-step', { issue: 3, status: 'running', endedAt: null, agentId: 'b1', step: 'build' })
    const env = envOf(w, [runEntry(3, V1), step])
    expect(await intakeAnswered(env, baseState(), { agentId: 'zzz', answer: ANSWER, reason: 'answer' })).toBeNull()
    expect(await intakeAnswered(env, baseState(), { agentId: 'b1', answer: ANSWER, reason: 'answer' })).toBeNull()
    expect(w.argvs.filter(a => a[0] === 'callum-flow-event')).toEqual([])
    expect(env.live.ledger.map(e => e.status)).toEqual(['running', 'running'])
  })
})

// --- the store ---------------------------------------------------------------------------------------------------

describe('stamps:<repo>: tries and owned groups', () => {
  const GOOD: Stamp = prevStamp()

  test('tries and owned round-trip through the writers; a malformed entry is dropped field by field', () => {
    let raw: unknown = withTry(null, 5, { version: V1, outcome: 'failed', at: NOW, reason: 'timeout' })
    raw = withStamp(raw, 5, GOOD)
    raw = withOwned(raw, 5, ['area'])
    raw = withOwned(raw, 5, ['needs-decision'])
    expect(stampStoreFromStore(raw)).toEqual({ stamps: { '5': GOOD }, tries: { '5': { version: V1, outcome: 'failed', at: NOW, reason: 'timeout' } }, owned: { '5': ['area', 'needs-decision'] } })
    const dirty = {
      v: 1,
      stamps: { '1': GOOD },
      tries: { '1': { version: V1, outcome: 'running', at: NOW }, '2': { version: '', outcome: 'ok', at: NOW }, '3': { version: V1, outcome: 'done', at: NOW }, '4': { version: V1, outcome: 'ok', at: 'now' }, '6': { version: V1, outcome: 'ok', at: NOW, reason: 7 }, x: { version: V1, outcome: 'ok', at: NOW }, '7': null },
      owned: { '1': ['area', 'bogus'], '2': ['bogus'], '3': 'area', x: ['area'] },
    }
    expect(stampStoreFromStore(dirty)).toEqual({ stamps: { '1': GOOD }, tries: { '1': { version: V1, outcome: 'running', at: NOW } }, owned: { '1': ['area'] } })
    for (const raw of [undefined, null, 'x', [], { v: 2, tries: dirty.tries }]) expect(stampStoreFromStore(raw)).toEqual(EMPTY_STAMP_STORE)
  })

  test('an old-shape value (only stamps) still reads; the writers keep a key they do not know and never mutate', () => {
    const old = Object.freeze({ v: 1, stamps: { '5': GOOD }, future: { keep: true } })
    expect(stampStoreFromStore(old)).toEqual({ stamps: { '5': GOOD }, tries: {}, owned: {} })
    const next = withTry(old, 6, { version: V1, outcome: 'running', at: NOW }) as Record<string, unknown>
    expect(next.future).toEqual({ keep: true })
    expect(next.stamps).toEqual({ '5': GOOD })
    expect(old).toEqual({ v: 1, stamps: { '5': GOOD }, future: { keep: true } })
    // another version, or no value at all, starts a new one
    expect(withTry({ v: 3, tries: {} }, 6, { version: V1, outcome: 'running', at: NOW })).toEqual({ v: 1, stamps: {}, tries: { '6': { version: V1, outcome: 'running', at: NOW } } })
  })

  test('updateStamps (V2Io) is a read-modify-write of the key that keeps unknown keys, refuses when not ready, and updates the live copy', async () => {
    const values = new Map<string, unknown>([[stampsKey(REPO), { v: 1, stamps: { '5': GOOD }, future: 1 }]])
    let fail = false
    const io: V2StoreIo = {
      get: async k => values.get(k),
      set: async (k, v) => {
        if (fail) throw new Error('full')
        values.set(k, JSON.parse(JSON.stringify(v)))
      },
      now: async () => NOW,
    }
    const live = newV2Live()
    await loadV2(live, io, REPO)
    const write = async (save: () => Promise<void>) => {
      try {
        await save()
        return true
      } catch {
        return false
      }
    }
    const v2 = v2IoOf(live, io, { ready: () => true, write, ping: () => undefined })
    expect(await v2.updateStamps?.(raw => withTry(raw, 6, { version: V1, outcome: 'running', at: NOW }))).toEqual({ changed: true, saved: true })
    expect(values.get(stampsKey(REPO))).toMatchObject({ future: 1, stamps: { '5': GOOD }, tries: { '6': { version: V1 } } })
    expect(live.stampTries['6']?.outcome).toBe('running')
    expect(live.stamps['5']).toEqual(GOOD)
    // null is no change
    expect(await v2.updateStamps?.(() => null)).toEqual({ changed: false, saved: false })
    // a write the store refuses changes nothing in memory
    fail = true
    expect(await v2.updateStamps?.(raw => withTry(raw, 7, { version: V2, outcome: 'running', at: NOW }))).toEqual({ changed: false, saved: false })
    expect(live.stampTries['7']).toBeUndefined()
    fail = false
    expect(await v2IoOf(live, io, { ready: () => false, write, ping: () => undefined }).updateStamps?.(raw => raw)).toEqual({ changed: false, saved: false })
  })
})

describe('the body version the reader gives (parseIssuesRead)', () => {
  const item = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `T${n}`, state: 'open', labels: [{ name: 'ready' }], issue_dependencies_summary: { blocked_by: 0, blocking: 0 }, sub_issues_summary: { total: 0, completed: 0 }, ...extra })

  test('body_sha becomes bodyVersion when it is 16 hex; an older image, or any other value, gives none', () => {
    const read = parseIssuesRead(JSON.stringify({ issues: [item(1, { body_sha: 'abcdef0123456789' }), item(2), item(3, { body_sha: 'ABCDEF0123456789' }), item(4, { body_sha: 'abc' }), item(5, { body_sha: 7 })], refused: [], missing: [] }))
    expect(read?.facts.get(1)?.bodyVersion).toBe('abcdef0123456789')
    for (const n of [2, 3, 4, 5]) expect(read?.facts.get(n)).not.toHaveProperty('bodyVersion')
  })
})
