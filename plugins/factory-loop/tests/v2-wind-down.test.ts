// Wind-down (docs/factory-loop/v2/SPEC.md 10.11): a request file makes the planner drop every
// action that starts work, keep everything that finishes it, and the pass writes a status file the
// stopper reads. The guard is driven through planV2 (each start kind, with its skip line), the files
// through whole passes of the test host.
import { describe, expect, mock, test } from 'claude-code/testing'

import { GITHUB_V2, newCtx } from '../hooks/foundation'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { claimKey, lifeOf, prepareKey, stepKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import type { CheckRun, PrView } from '../hooks/v2/sources-prs'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES, V2_OWNER_TELLS } from '../hooks/v2/types'
import type { IssueRecord, Lease, StepResult, V2State } from '../hooks/v2/types'
import { windDownGuard, windDownOf, windDownPaths } from '../hooks/v2/wind-down'
import { WIND_DOWN_WRITE_SCRIPT, previousOf, requestOf, windDownStatus } from '../hooks/v2/wind-down-files'
import type { WindDownRead } from '../hooks/v2/wind-down'
import { MIN, NOW, config, control, entry, issue, state as baseState } from './fixtures'
import { LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host } from './host'

const HOUR = 60 * MIN
const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 2 * HOUR)
const OK = { ok: true, at: NOW }
const sha = (c: string) => c.repeat(40)
const HEAD = sha('a')
const MAIN = sha('d')
const PATCH = sha('c')
const FILES = windDownPaths(LOOP_DIR)

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, since: NOW - 20 * MIN, ...over }
}
const queued = (n: number) => rec(n, { state: 'merge-queue', step: 'queue', pr: 600 + n, head: HEAD, approvedPatch: PATCH, round: 1 })
const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })
const check = (): CheckRun => ({ name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: NOW - 5 * MIN, completedAt: NOW - 2 * MIN, runId: '9001', link: `https://github.com/${REPO}/actions/runs/9001/job/1` })
const view = (r: IssueRecord, over: Partial<PrView> = {}): PrView => ({ pr: r.pr ?? 0, issue: r.issue, state: 'open', head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: MAIN, baseRef: 'main', checks: [check()], patch: PATCH, readAt: NOW, ...over })

// the request a stopper wrote `ago` ms before NOW
const requested = (ago: number, over: Partial<NonNullable<WindDownRead['request']>> = {}): WindDownRead => ({ request: { requestedAt: NOW - ago, iso: new Date(NOW - ago).toISOString(), trigger: 'restart-self', problem: null, ...over }, stopNow: false, previous: null })

// world: these records holding their slots (unless leases are given), every v2 source read, and the wind-down read as given.
function world(records: IssueRecord[], windDown: WindDownRead | undefined, over: Partial<State> = {}, v2: Partial<V2State> = {}): State {
  const base = emptyV2State(NOW, records)
  const heads = Object.fromEntries(records.flatMap(r => (r.pr === null ? [] : [[HEAD, { pr: r.pr, at: NOW - 15 * MIN }]])))
  const prs = records.filter(r => r.pr !== null).map(r => view(r, { mergeable: 'behind' as const }))
  return {
    ...baseState(over),
    v2: {
      ...base,
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK },
      leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor),
      prs: { prs, main: { branch: 'main', sha: MAIN } },
      heads,
      ...(windDown === undefined ? {} : { windDown }),
      ...v2,
    },
  }
}
const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })
const withCompanion = (s: State): State => ({ ...s, v2: { ...(s.v2 as V2State), workspace: { session: 's', process: 'p', ok: true, version: '1' } } })
const plan = (s: State, cfg = CFG): PlanResult => planV2(withCompanion(s), cfg)
const kindsOf = (r: PlanResult) => r.actions.filter(a => a.kind !== 'title').map(a => (a.kind === 'slot' ? `slot ${a.op}` : a.kind))
const said = (r: PlanResult) => r.skipped.filter(s => s.why.startsWith('wind-down')).map(s => `${s.rule} ${s.issue} ${s.why}`)
const prepared = (r: IssueRecord): LedgerEntry => entry(prepareKey(r, r.attempt), 'slot', { issue: r.issue, maxAttempts: 1, startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN })
const stepRunning = (r: IssueRecord, step: 'design' | 'build'): LedgerEntry =>
  entry(stepKey(r, step, r.attempt), 'agent-step', { issue: r.issue, class: 'develop', step, agentId: 'agent-1', status: 'running', startedAt: NOW - 5 * MIN, endedAt: null })

describe('windDownOf (config windDownMinutes, the request)', () => {
  test('off without a request, and with windDownMinutes 0; active inside the cap; stale past the cap and the 5-minute margin', () => {
    expect(windDownOf(world([], undefined), CFG)).toEqual({ mode: 'off' })
    expect(windDownOf(world([], requested(MIN)), { windDownMinutes: 0 })).toEqual({ mode: 'off' })
    expect(windDownOf(world([], requested(MIN)), CFG)).toEqual({ mode: 'active', requestedAt: NOW - MIN, startedAt: NOW, capMs: 10 * MIN })
    expect(windDownOf(world([], requested(15 * MIN)), CFG).mode).toBe('active')
    expect(windDownOf(world([], requested(15 * MIN + 1)), CFG)).toEqual({ mode: 'stale', requestedAt: NOW - 15 * MIN - 1, capMs: 10 * MIN })
    expect(windDownOf(world([], requested(9 * MIN)), { windDownMinutes: 3 }).mode).toBe('stale')
  })

  test('started_at is the first pass that saw this request: kept while the status file names it, new for another request', () => {
    const wd = { ...requested(4 * MIN), previous: { requestedAt: NOW - 4 * MIN, startedAt: NOW - 3 * MIN } }
    expect(windDownOf(world([], wd), CFG)).toMatchObject({ mode: 'active', startedAt: NOW - 3 * MIN })
    const other = { ...requested(2 * MIN), previous: { requestedAt: NOW - 4 * MIN, startedAt: NOW - 3 * MIN } }
    expect(windDownOf(world([], other), CFG)).toMatchObject({ startedAt: NOW })
  })

  test('a request that is not a request is one at the file\'s mtime, with a problem; the trigger is one of the two names or null', () => {
    const iso = new Date(NOW - MIN).toISOString()
    expect(requestOf(JSON.stringify({ requested_at: iso, trigger: 'coder-stop' }), 5)).toEqual({ requestedAt: NOW - MIN, iso: new Date(NOW - MIN).toISOString(), trigger: 'coder-stop', problem: null })
    expect(requestOf(JSON.stringify({ requested_at: iso, trigger: null }), 5)).toEqual({ requestedAt: NOW - MIN, iso: new Date(NOW - MIN).toISOString(), trigger: null, problem: null })
    expect(requestOf(JSON.stringify({ requested_at: iso, trigger: 'nope' }), 5)).toMatchObject({ requestedAt: NOW - MIN, trigger: null, problem: expect.stringContaining('trigger') })
    for (const bad of ['', '{', '[]', 'null', '{"requested_at":"soon"}', '{"requested_at":7}']) {
      expect(requestOf(bad, NOW - 2 * MIN)).toMatchObject({ requestedAt: NOW - 2 * MIN, trigger: null, problem: expect.stringContaining('treated as a request at its modification time') })
    }
    expect(previousOf(JSON.stringify({ requested_at: iso, started_at: iso }))).toEqual({ requestedAt: NOW - MIN, startedAt: NOW - MIN })
    expect(previousOf('{')).toBeNull()
    expect(previousOf(null)).toBeNull()
    expect(previousOf(JSON.stringify({ requested_at: iso }))).toBeNull()
  })
})

describe('the guard drops every start before admission', () => {
  test('S1 and H1 claims: a ready issue is not claimed, with its skip line', () => {
    const open = world([], undefined, { queue: [5], issues: [issue(5)] })
    expect(kindsOf(plan(open))).toContain('claim')
    const r = plan({ ...open, v2: { ...(open.v2 as V2State), windDown: requested(MIN) } })
    expect(kindsOf(r)).not.toContain('claim')
    expect(said(r)).toEqual(['S1 5 wind-down: no new start (claim)'])
  })

  test('an agent step is dropped, and a slot lease with it', () => {
    const designing = rec(91, { state: 'designing', step: 'design' })
    const ready = withLedger(world([designing], undefined), [prepared(designing)])
    expect(kindsOf(plan(ready))).toEqual(['agent-step'])
    const r = plan({ ...ready, v2: { ...(ready.v2 as V2State), windDown: requested(MIN) } })
    expect(kindsOf(r)).toEqual([])
    expect(said(r)).toEqual([expect.stringMatching(/^S2 91 wind-down: no new start \(agent-step\)$/)])
    // no slot yet: W1's lease is a start
    const leaseless = world([designing], undefined, {}, { leases: [] })
    expect(kindsOf(plan(leaseless))).toContain('slot lease')
    const l = plan({ ...leaseless, v2: { ...(leaseless.v2 as V2State), windDown: requested(MIN) } })
    expect(kindsOf(l)).toEqual([])
    expect(said(l)).toEqual([expect.stringMatching(/^W1 91 wind-down: no new start \(slot\)$/)])
  })

  test('Q1 and Q2: the queue head is neither updated nor merged', () => {
    const behind = queued(10)
    const open = world([behind], undefined)
    expect(kindsOf(plan(open))).toEqual(['queue-update'])
    const u = plan(world([behind], requested(MIN)))
    expect(kindsOf(u)).toEqual([])
    expect(said(u)).toEqual(['Q1 10 wind-down: no new start (queue-update)'])
    const clean = world([behind], undefined, {}, { prs: { prs: [view(behind)], main: { branch: 'main', sha: MAIN } } })
    expect(kindsOf(plan(clean))).toEqual(['queue-merge'])
    const m = plan({ ...clean, v2: { ...(clean.v2 as V2State), windDown: requested(MIN) } })
    expect(kindsOf(m)).toEqual([])
    expect(said(m)).toEqual(['Q2 10 wind-down: no new start (queue-merge)'])
  })

  test('a queue-merge running when the request lands is left alone: nothing new starts and its entry stays running', () => {
    const r = queued(11)
    const mergeKey = plan(world([r], undefined, {}, { prs: { prs: [view(r)], main: { branch: 'main', sha: MAIN } } })).actions.find(a => a.kind === 'queue-merge')?.key as string
    const runningMerge = entry(mergeKey, 'queue-merge', { issue: 11, pr: 611, head: HEAD, status: 'running', endedAt: null, startedAt: NOW - MIN, maxAttempts: 1 })
    const s = withLedger(world([r], requested(2 * MIN), {}, { prs: { prs: [view(r)], main: { branch: 'main', sha: MAIN } } }), [runningMerge])
    const p = plan(s)
    expect(kindsOf(p)).toEqual([])
    // and the merge's result, once in, is read on a later pass: T13 closes the record
    const merged = { ...runningMerge, status: 'done' as const, endedAt: NOW, outcome: { kind: 'queue' as const, op: 'merge' as const, merged: true, head: HEAD, failClass: null, lines: [] } }
    const later = plan(withLedger(world([r], requested(2 * MIN), {}, { prs: { prs: [view(r)], main: { branch: 'main', sha: MAIN } } }), [merged]))
    expect(later.actions.filter(a => a.kind === 'transition')).toEqual([expect.objectContaining({ row: 'T13' })])
  })

  test('R2: an update that is due gives no restart-self, with a skip line', () => {
    const s = world([], undefined, { control: control({ updateDue: { at: NOW - 5 * MIN, reason: 'new release' } }) })
    expect(kindsOf(plan(s))).toContain('restart-self')
    const r = plan({ ...s, v2: { ...(s.v2 as V2State), windDown: requested(MIN) } })
    expect(kindsOf(r)).not.toContain('restart-self')
    expect(r.skipped).toContainEqual({ rule: 'R2', issue: null, why: 'wind-down' })
  })

  test('ci-rerun, judge, task (the release task included) and the other starts of a closed list, by kind', () => {
    const at = (a: Partial<Action> & { kind: Action['kind'] }) => ({ key: `k:${a.kind}`, class: 'free', rule: 'X', reason: '', issue: null, ...a }) as Action
    const wd = world([], requested(MIN))
    const ctx = newCtx(wd, CFG, { tier: 'normal', overridden: false }, V2_OWNER_TELLS, GITHUB_V2)
    ctx.out.push(
      at({ kind: 'ci-rerun', pr: 1, runId: '1', round: 1 } as never),
      at({ kind: 'judge', wake: 'review', fields: {}, context: [] } as never),
      at({ kind: 'task', wake: 'release', fields: {}, context: [] } as never),
      at({ kind: 'slot', op: 'lease' } as never),
      at({ kind: 'queue-update' } as never),
      // what finishes work or is housekeeping stays
      at({ kind: 'slot', op: 'free' } as never),
      at({ kind: 'slot', op: 'kill' } as never),
      at({ kind: 'slot', op: 'prepare' } as never),
      at({ kind: 'transition' } as never),
      at({ kind: 'pr' } as never),
      at({ kind: 'label' } as never),
      at({ kind: 'comment' } as never),
      at({ kind: 'event' } as never),
      at({ kind: 'split' } as never),
      at({ kind: 'stop-agent' } as never),
      at({ kind: 'tell', wake: 'parked', fields: {}, context: [] } as never),
      at({ kind: 'heartbeat' } as never),
      at({ kind: 'sweep' } as never),
    )
    windDownGuard(ctx, windDownOf(wd, CFG))
    expect(ctx.out.map(a => (a.kind === 'slot' ? `slot ${a.op}` : a.kind))).toEqual(['slot free', 'slot kill', 'slot prepare', 'transition', 'pr', 'label', 'comment', 'event', 'split', 'stop-agent', 'tell', 'heartbeat', 'sweep'])
    expect(ctx.skipped.map(s => s.why)).toEqual(['ci-rerun', 'judge', 'task', 'slot', 'queue-update'].map(k => `wind-down: no new start (${k})`))
  })

  test('the guard is off with no request, with windDownMinutes 0, and for a stale request', () => {
    const open = world([], undefined, { queue: [5], issues: [issue(5)] })
    const asks = (wd: WindDownRead, cfg = CFG) => kindsOf(plan({ ...open, v2: { ...(open.v2 as V2State), windDown: wd } }, cfg))
    expect(asks(requested(MIN), config({ ...CFG, windDownMinutes: 0 }))).toContain('claim')
    expect(asks(requested(HOUR))).toContain('claim')
    expect(asks({ request: null, stopNow: false, previous: null })).toContain('claim')
    expect(asks(requested(MIN))).not.toContain('claim')
  })
})

describe('what finishes work still runs', () => {
  test('a finished step\'s answer: its transition runs and the next step\'s agent-step is dropped', () => {
    const building = rec(20, { state: 'building', step: 'build' })
    const result: StepResult = { event: 'ok', reason: null, why: null, head: HEAD, choice: null, data: null }
    const ended = entry(stepKey(building, 'build', building.attempt), 'agent-step', { issue: 20, class: 'develop', step: 'build', agentId: 'agent-1', outcome: { kind: 'step', step: 'build', result }, startedAt: NOW - 5 * MIN, endedAt: NOW - MIN })
    const open = withLedger(world([building], undefined), [prepared(building), ended])
    const before = plan(open)
    expect(kindsOf(before)).toContain('transition')
    const during = plan({ ...open, v2: { ...(open.v2 as V2State), windDown: requested(MIN) } })
    expect(kindsOf(during)).toEqual(kindsOf(before).filter(k => k !== 'agent-step' && k !== 'claim'))
    expect(kindsOf(during)).toContain('transition')
  })

  test('the same plan minus its starts, across a battery of worlds', () => {
    const designing = rec(30, { state: 'designing', step: 'design' })
    const fixing = rec(31, { state: 'fixing', step: 'fix' })
    const worlds = [
      withLedger(world([designing, queued(32)], undefined, { queue: [7], issues: [issue(7)] }), [prepared(designing)]),
      world([designing, fixing], undefined, { control: control({ updateDue: { at: NOW - MIN, reason: 'r' } }) }, { leases: [] }),
    ]
    for (const open of worlds) {
      const during = plan({ ...open, v2: { ...(open.v2 as V2State), windDown: requested(MIN) } })
      const keep = (a: Action) => !(['claim', 'agent-step', 'queue-update', 'queue-merge', 'ci-rerun', 'judge', 'task', 'restart-self'].includes(a.kind) || (a.kind === 'slot' && a.op === 'lease'))
      const expected = plan(open).actions.filter(keep).map(a => a.key)
      expect(during.actions.filter(a => a.kind !== 'title').map(a => a.key)).toEqual(expected.filter(k => k !== 'title'))
    }
  })
})

describe('the status file and the title', () => {
  test('running steps, the queue and the release task, idle, stop_now and cap_ms', () => {
    const a = rec(40, { state: 'building', step: 'build' })
    const b = rec(41, { state: 'designing', step: 'design' })
    const stepA = stepRunning(a, 'build')
    const stepB = stepRunning(b, 'design')
    const wd = { ...requested(3 * MIN), previous: { requestedAt: NOW - 3 * MIN, startedAt: NOW - 3 * MIN }, stopNow: true }
    const s = withLedger(world([a, b], wd), [stepA, stepB, entry('q:1', 'queue-merge', { status: 'running', endedAt: null }), entry('rel', 'task', { wake: 'release', status: 'running', endedAt: null })])
    const active = windDownOf(s, { windDownMinutes: 3 })
    if (active.mode !== 'active') throw new Error('not active')
    expect(windDownStatus(s, active)).toEqual({
      requested_at: new Date(NOW - 3 * MIN).toISOString(),
      started_at: new Date(NOW - 3 * MIN).toISOString(),
      cap_ms: 180_000,
      running: { steps: [stepA.key, stepB.key], gate: true, queue: true, release: true },
      idle: false,
      stop_now: true,
      at: new Date(NOW).toISOString(),
    })
    const quiet = world([], { ...wd, stopNow: false })
    const idle = windDownStatus(quiet, active)
    expect(idle).toMatchObject({ running: { steps: [], gate: false, queue: false, release: false }, idle: true, stop_now: false })
  })

  test('the title: `winding down <m>m · <n> running`, right after the counts', () => {
    const a = rec(40, { state: 'building', step: 'build' })
    const b = rec(41, { state: 'designing', step: 'design' })
    const wd = { ...requested(3 * MIN), previous: { requestedAt: NOW - 3 * MIN, startedAt: NOW - 3 * MIN } }
    const s = withLedger(world([a, b], wd), [stepRunning(a, 'build'), stepRunning(b, 'design')])
    expect(plan(s).title).toMatch(/\) · winding down 3m · 2 running$/)
    expect(plan(world([a, b], undefined)).title).not.toContain('winding down')
  })
})

describe('a request the stop never followed', () => {
  test('is planned normally again and told once, keyed by its requested_at', () => {
    const open = world([], requested(HOUR), { queue: [5], issues: [issue(5)] })
    const r = plan(open)
    expect(kindsOf(r)).toEqual(expect.arrayContaining(['claim', 'tell']))
    const tell = r.actions.find((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell')
    expect(tell).toMatchObject({ wake: 'wind-down-stale', key: `tell:wind-down-stale:${NOW - HOUR}` })
    // told: the next pass, with the request gone or not, tells nothing
    const told = withLedger(open, [entry(tell?.key ?? '', 'tell', { wake: 'wind-down-stale' })])
    expect(plan(told).actions.filter(a => a.kind === 'tell')).toEqual([])
    expect(plan(world([], undefined, { queue: [5], issues: [issue(5)] })).actions.filter(a => a.kind === 'tell')).toEqual([])
  })
})

// --- whole passes ----------------------------------------------------------------------------------------

describe('a pass in the test host', () => {
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
  const settings = (extra: Record<string, unknown> = {}) => ({ repo: REPO, mode: 'act', checkout: '/work', planner: 'v2', ...extra })
  const request = (ago: number) => JSON.stringify({ requested_at: new Date(NOW - ago).toISOString(), trigger: 'restart-self' })
  const status = (h: { files: Map<string, string> }) => JSON.parse(h.files.get(FILES.status) ?? 'null') as Record<string, unknown> | null

  test('with a request: the status file lands by temp and rename, started_at stays across passes, stop_now follows the file, and the request is kept', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: settings({ windDownMinutes: 3 }), run: quiet, files: { [FILES.request]: request(MIN) } })
    await $.session.start(START)
    await clock.advance(6_000)
    const first = status(h)
    expect(first).toMatchObject({ requested_at: new Date(NOW - MIN).toISOString(), cap_ms: 180_000, running: { steps: [], gate: false, queue: false, release: false }, idle: true, stop_now: false })
    // written by the temp-and-rename script, over the status path
    const writes = h.seen.filter(s => s.argv[2] === WIND_DOWN_WRITE_SCRIPT)
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(s => s.argv[4] === FILES.status)).toBe(true)
    await clock.advance(60_000)
    h.files.set(FILES.stopNow, '{}')
    await clock.advance(60_000)
    const later = status(h)
    expect(later?.started_at).toBe(first?.started_at)
    expect(later?.stop_now).toBe(true)
    expect(later?.at).not.toBe(first?.at)
    expect(h.files.has(FILES.request)).toBe(true)
    // the title carries it
    expect(h.titles.at(-1)).toMatch(/winding down \dm · 0 running/)
  })

  test('windDownMinutes 0: the request is ignored, no status file, work is not held', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: settings({ windDownMinutes: 0 }), run: quiet, files: { [FILES.request]: request(MIN) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.files.has(FILES.status)).toBe(false)
    expect(h.files.has(FILES.request)).toBe(true)
    expect(h.titles.at(-1) ?? '').not.toContain('winding down')
  })

  test('no request: no status file and nothing removed', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: settings(), run: quiet })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.files.has(FILES.status)).toBe(false)
    expect(h.seen.filter(s => s.argv[0] === 'rm' && s.argv.includes(FILES.request))).toEqual([])
  })

  test('a stale request is removed by the loop, once told, and the next pass writes no status', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: settings({ windDownMinutes: 3 }), run: quiet, files: { [FILES.request]: request(HOUR), [FILES.status]: '{}' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.files.has(FILES.request)).toBe(false)
    await clock.advance(60_000)
    expect(h.seen.filter(s => s.argv[0] === 'rm' && s.argv.includes(FILES.request))).toHaveLength(1)
    expect(h.titles.at(-1) ?? '').not.toContain('winding down')
  })

  test('a request that does not parse is a request at the file\'s mtime, with a problem in the decision log', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, {
      config: settings({ windDownMinutes: 3 }),
      run: (argv, s) => (argv[0] === 'stat' ? { stdout: `${Math.floor((NOW - MIN) / 1000)}\n` } : quiet(argv, s)),
      files: { [FILES.request]: '{not json' },
    })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(status(h)).toMatchObject({ requested_at: new Date(NOW - MIN).toISOString(), idle: true })
    expect(JSON.stringify(h.passes().at(-1))).toContain('treated as a request at its modification time')
  })
})
