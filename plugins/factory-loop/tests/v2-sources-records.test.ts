// The record rebuild's source switch and shadow compare (docs/factory-loop/v2/SPEC.md 3.3, sources-records.ts,
// rules-shadow.ts): `old` reads factory.events, `new` reads factory.event_store, `shadow` reads both once per
// load and then hourly, compares the two rebuilds and leaves the records to the old read.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/config'
import { emptyCache } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { eventArgv } from '../hooks/v2/events'
import type { TransitionEvent } from '../hooks/v2/events'
import { validateStrict } from '../hooks/v2/event-reader'
import { lifeOf } from '../hooks/v2/keys'
import { observeV2 } from '../hooks/v2/observe'
import type { V2Readers } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { diffRecords, SETTLE_MS, SHADOW_EVERY_MS } from '../hooks/v2/sources-records'
import { madeRecord } from '../hooks/v2/table'
import type { IssueRecord } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state as baseState, transitionRow } from './fixtures'
import type { Config } from '../hooks/types'
import { LOOP_DIR, REPO, TOOLS } from './host'

const LIFE = lifeOf(NOW - 3 * 60 * MIN)
const OK = { ok: true, at: NOW }
const DAY = 24 * 60 * MIN

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 3 * DAY), seq: 3, seqAt: NOW - 2 * DAY, state: 'building', step: 'build', since: NOW - 2 * DAY, ...over }
}

const csvField = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const csv = (header: string[], rows: Record<string, string>[]) => [header.join(','), ...rows.map(r => header.map(h => csvField(r[h] ?? '')).join(','))].join('\n') + '\n'

// the old rows (factory.events, in REBUILD_SQL's columns) and the new ones (NEW_REBUILD_SQL's) of the same transitions
function oldRow(r: IssueRecord, ts: number): Record<string, string> {
  const e: TransitionEvent = { state: 'transition', record: r, row: 'T1', from: null, via: 't1' }
  const argv = eventArgv(e)
  return { ts: new Date(ts).toISOString(), state: 'transition', issue: String(r.issue), run_id: '', branch: r.branch, pr: r.pr === null ? '' : String(r.pr), head: r.head ?? '', note: argv[argv.indexOf('--note') + 1] ?? '', actor: '', device: DEVICE }
}
const OLD_HEADER = ['ts', 'state', 'issue', 'run_id', 'branch', 'pr', 'head', 'note', 'actor', 'device']
const oldCsv = (list: [IssueRecord, number][]) => csv(OLD_HEADER, list.map(([r, ts]) => oldRow(r, ts)))
const NEW_HEADER = Object.keys(transitionRow(rec(1), NOW))
const newCsv = (list: [IssueRecord, number][]) => csv(NEW_HEADER, list.map(([r, ts]) => transitionRow(r, ts)))

type Reply = { exitCode: number; stdout: string; stderr?: string }
type Stores = { old?: Reply | Error; new?: Reply | Error }

function harness(stores: Stores, over: Partial<Config> = {}, stored: IssueRecord[] | null = null) {
  const runs: { argv: string[]; stdin?: string }[] = []
  const run = async (argv: string[], stdin?: string) => {
    runs.push({ argv, stdin })
    if (argv[0] !== 'dev-query') return { exitCode: 0, stdout: '', stderr: '' }
    const reply = argv.includes('--factory') ? stores.new : stores.old
    if (reply instanceof Error) throw reply
    return { stderr: '', ...(reply ?? { exitCode: 0, stdout: '' }) }
  }
  const io: Io = { now: async () => NOW, run, readFile: async () => null, sessionLimits: async () => [], agents: async () => [] }
  const rt: Runtime = {
    mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: {}, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config({ eventsSource: 'shadow', ...over }), configProblems: [],
  }
  const readers: V2Readers = {
    prs: async ctx => ({ read: { prs: [] }, source: OK, heads: ctx.heads }),
    interventions: async () => ({ read: { companion: [], controlDigest: null, configDigest: null }, source: OK }),
  }
  const cache = emptyCache()
  const pass = (now = NOW) =>
    observeV2({ io, rt, cache: cache.v2, run, state: baseState({ now }), stored: { records: stored, heads: null, error: null }, poolJson: null, github: cache.github, backoff: false, limited: () => false, readers })
  const queries = (factory: boolean) => runs.filter(r => r.argv[0] === 'dev-query' && r.argv.includes('--factory') === factory)
  return { runs, pass, cache, queries }
}

// the planner over a state holding the pass's v2 read
async function plan(h: ReturnType<typeof harness>, ledger: LedgerEntry[] = [], now = NOW): Promise<{ actions: Action[]; state: State }> {
  const o = await h.pass(now)
  const s = baseState({ now })
  const state: State = { ...s, ledger: [...s.ledger, ...ledger], v2: { ...o.v2, sources: { ...o.v2.sources, store: OK } } }
  return { actions: planV2(state, config({ mode: 'act', maxInFlightIssues: 3 })).actions, state }
}
const shadowEvents = (actions: Action[]) => actions.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.event.state === 'shadow_read')
const tells = (actions: Action[]) => actions.filter(a => a.kind === 'tell' && a.wake === 'records-shadow')

const A = rec(7)
const B = rec(8, { state: 'parked', step: null, resumeTo: 'designing', question: 'q?' })
const SAME: Stores = { old: { exitCode: 0, stdout: oldCsv([[A, NOW - 2 * DAY], [B, NOW - 2 * DAY]]) }, new: { exitCode: 0, stdout: newCsv([[A, NOW - 2 * DAY], [B, NOW - 2 * DAY]]) } }

describe('eventsSource shadow (v2 SPEC 3.3)', () => {
  test('equal stores: differences 0, a shadow_read event that validates strictly, and no tell', async () => {
    const h = harness(SAME, { eventsSource: 'shadow' })
    const { actions } = await plan(h)
    const [ev] = shadowEvents(actions)
    expect(shadowEvents(actions)).toHaveLength(1)
    expect(ev?.key).toBe(`records-shadow:${NOW}`)
    expect(ev?.event.state === 'shadow_read' ? ev.event.data : null).toEqual({
      reader: 'loop-records', tool: 'factory-loop', compared: 2, differences: 0, live_differences: 0, diff_keys: [], old_ok: true, new_ok: true, settle_seconds: 600, detail: null,
    })
    expect(validateStrict('shadow_read', 1, ev?.event.state === 'shadow_read' ? ev.event.data : null)).toEqual([])
    expect(tells(actions)).toEqual([])
    expect(ev?.event.state === 'shadow_read' && eventArgv(ev.event).slice(0, 4)).toEqual(['callum-flow-event', '--type', 'shadow_read', '--data'])
    expect(ev?.event.state === 'shadow_read' && eventArgv(ev.event)).not.toContain('--issue')
  })

  test('a changed field on one issue: differences 1, diff_keys [n], the first difference, and one tell per distinct set', async () => {
    const changed = { ...A, round: 4 }
    const stores: Stores = { old: SAME.old, new: { exitCode: 0, stdout: newCsv([[changed, NOW - 2 * DAY], [B, NOW - 2 * DAY]]) } }
    const h = harness(stores)
    const first = await plan(h)
    const [ev] = shadowEvents(first.actions)
    const data = ev?.event.state === 'shadow_read' ? ev.event.data : null
    expect(data).toMatchObject({ compared: 2, differences: 1, live_differences: 1, diff_keys: ['7'], old_ok: true, new_ok: true, detail: '#7 round: old 0, new 4' })
    expect(validateStrict('shadow_read', 1, data)).toEqual([])
    const [tell] = tells(first.actions)
    expect(tells(first.actions)).toHaveLength(1)
    expect(tell).toMatchObject({ kind: 'tell', wake: 'records-shadow', key: 'tell:records-shadow:7', class: 'owner' })
    const text = tell?.kind === 'tell' ? tell.context.join('\n') : ''
    expect(text).toContain('#7')
    expect(text).toContain('#7 round: old 0, new 4')
    expect(text).toContain('/factory config set eventsSource old')
    // the same set told again: its ledger entry is done, so nothing is planned
    const done = entry('tell:records-shadow:7', 'tell', { status: 'done' })
    expect(tells((await plan(h, [done])).actions)).toEqual([])
    // another set is told
    const both: Stores = { old: SAME.old, new: { exitCode: 0, stdout: newCsv([[changed, NOW - 2 * DAY], [{ ...B, question: 'other' }, NOW - 2 * DAY]]) } }
    const h2 = harness(both)
    expect(tells((await plan(h2, [done])).actions).map(a => a.key)).toEqual(['tell:records-shadow:7,8'])
  })

  test('a failing new read (a refused row, a missing factory URL, a thrown run) gives new_ok false, never fails the pass, and the records come from old', async () => {
    const bad: Reply = { exitCode: 0, stdout: csv(NEW_HEADER, [transitionRow(A, NOW - 2 * DAY, { type_version: '9' })]) }
    for (const newSide of [{ exitCode: 78, stdout: '' }, { exitCode: 77, stdout: '' }, new Error('boom'), bad]) {
      const h = harness({ old: SAME.old, new: newSide })
      const o = await h.pass()
      expect(o.v2.sources.store.ok).toBe(true)
      expect(o.v2.records.map(r => r.issue)).toEqual([7, 8])
      expect(o.v2.recordsFrom).toBe('events')
      const data = o.v2.recordsShadow?.data
      expect(data).toMatchObject({ old_ok: true, new_ok: false, compared: 0, differences: 0, live_differences: 0, diff_keys: [] })
      expect(typeof data?.detail).toBe('string')
      expect(validateStrict('shadow_read', 1, data)).toEqual([])
    }
  })

  test('a failing old read fails the rebuild as today, and a failing old read beside a store that holds records fails nothing', async () => {
    const empty = harness({ old: { exitCode: 7, stdout: '' }, new: SAME.new })
    const o = await empty.pass()
    expect(o.v2.sources.store).toMatchObject({ ok: false, error: "the rebuild's read failed: exit 7" })
    expect(o.v2.records).toEqual([])
    expect(o.v2.recordsShadow?.data).toMatchObject({ old_ok: false, new_ok: true })
    const held = harness({ old: { exitCode: 7, stdout: '' }, new: SAME.new }, {}, [A])
    const p = await held.pass()
    expect(p.v2.sources.store.ok).toBe(true)
    expect(p.v2.records).toEqual([A])
    expect(p.v2.recordsShadow?.data.old_ok).toBe(false)
  })

  test('a row inside the settle window counts in live_differences only', async () => {
    const late = rec(9, { seq: 1, seqAt: NOW - MIN, since: NOW - MIN })
    const stores: Stores = { old: SAME.old, new: { exitCode: 0, stdout: newCsv([[A, NOW - 2 * DAY], [B, NOW - 2 * DAY], [late, NOW - MIN]]) } }
    const h = harness(stores)
    const o = await h.pass()
    expect(SETTLE_MS).toBe(600_000)
    expect(o.v2.recordsShadow?.data).toMatchObject({ compared: 3, differences: 0, live_differences: 1, diff_keys: [] })
    // once past the window it is a difference
    const later = await h.pass(NOW + SHADOW_EVERY_MS)
    expect(later.v2.recordsShadow?.data).toMatchObject({ differences: 1, live_differences: 1, diff_keys: ['9'] })
  })

  test('the compare runs while the store holds records, and runs again only after an hour', async () => {
    const h = harness(SAME, {}, [A, B])
    const first = await h.pass()
    expect(first.v2.recordsFrom).toBe('store')
    expect(h.queries(false)).toHaveLength(1)
    expect(h.queries(true)).toHaveLength(1)
    expect(first.v2.recordsShadow?.at).toBe(NOW)
    await h.pass(NOW + 10 * MIN)
    await h.pass(NOW + SHADOW_EVERY_MS - MIN)
    expect(h.queries(true)).toHaveLength(1)
    const next = await h.pass(NOW + SHADOW_EVERY_MS)
    expect(h.queries(true)).toHaveLength(2)
    expect(next.v2.recordsShadow?.at).toBe(NOW + SHADOW_EVERY_MS)
  })

  test('with the store empty, one pass reads each store once and the records come from the old read', async () => {
    const h = harness(SAME)
    const o = await h.pass()
    expect(h.queries(false)).toHaveLength(1)
    expect(h.queries(true)).toHaveLength(1)
    expect([o.v2.recordsFrom, o.v2.records]).toEqual(['events', [A, B]])
    expect(h.queries(true)[0]?.argv).toEqual(['dev-query', '--factory', '--csv', '-v', `repo=${REPO}`, '-v', `device=${DEVICE}`, '-v', `at=${new Date(NOW).toISOString()}`, '-v', 'days=90'])
  })
})

describe('eventsSource old and new (v2 SPEC 3.3)', () => {
  test('old: the rebuild reads factory.events alone, as before, and no compare is made', async () => {
    const h = harness(SAME, { eventsSource: 'old' })
    const o = await h.pass()
    expect(h.queries(true)).toEqual([])
    expect(h.queries(false)).toHaveLength(1)
    expect([o.v2.recordsFrom, o.v2.records, o.v2.recordsShadow]).toEqual(['events', [A, B], undefined])
    // a store that holds records reads nothing
    const held = harness(SAME, { eventsSource: 'old' }, [A])
    await held.pass()
    expect(held.runs.filter(r => r.argv[0] === 'dev-query')).toEqual([])
  })

  test('the default: an empty store rebuilds from event_store alone', async () => {
    const h = harness({ old: { exitCode: 9, stdout: 'must not be read' }, new: SAME.new }, { eventsSource: DEFAULT_CONFIG.eventsSource })
    const o = await h.pass()
    expect(h.queries(false)).toEqual([])
    expect(h.queries(true)).toHaveLength(1)
    expect(h.queries(true)[0]?.stdin).toContain('factory.event_store')
    expect([o.v2.sources.store.ok, o.v2.recordsFrom, o.v2.records]).toEqual([true, 'events', [A, B]])
    expect(o.v2.recordsShadow).toBeUndefined()
  })

  test('new: with an empty store the records rebuild from event_store alone', async () => {
    const h = harness({ old: { exitCode: 9, stdout: 'must not be read' }, new: SAME.new }, { eventsSource: 'new' })
    const o = await h.pass()
    expect(h.queries(false)).toEqual([])
    expect(h.queries(true)).toHaveLength(1)
    expect(h.queries(true)[0]?.stdin).toContain('factory.event_store')
    expect([o.v2.sources.store.ok, o.v2.recordsFrom, o.v2.records]).toEqual([true, 'events', [A, B]])
    expect(o.v2.recordsShadow).toBeUndefined()
  })

  test('new: a refused row fails the whole read - the store source is not ok, its error names the event_id and the source, and no record is rebuilt', async () => {
    const rows = [transitionRow(A, NOW - 2 * DAY), transitionRow(B, NOW - 2 * DAY, { type_version: '9' }, 'ev-the-bad-one')]
    const h = harness({ new: { exitCode: 0, stdout: csv(NEW_HEADER, rows) } }, { eventsSource: 'new' })
    const o = await h.pass()
    expect(o.v2.sources.store.ok).toBe(false)
    expect(o.v2.sources.store.error).toContain('ev-the-bad-one')
    expect(o.v2.sources.store.error).toContain('source new')
    expect(o.v2.records).toEqual([])
    expect(o.v2.recordsFrom).toBe('none')
  })

  test('new: a missing factory URL (exit 77, 78) is a failed read', async () => {
    for (const exitCode of [77, 78]) {
      const h = harness({ new: { exitCode, stdout: '' } }, { eventsSource: 'new' })
      const o = await h.pass()
      expect(o.v2.sources.store).toMatchObject({ ok: false, error: `the rebuild's read failed (source new): exit ${exitCode}` })
    }
  })
})

describe('diffRecords', () => {
  test('per issue, field by field; an issue only one side holds is named', () => {
    expect(diffRecords([A, B], [A, B])).toEqual([])
    expect(diffRecords([A, B], [{ ...A, notes: ['x'] }, B])).toEqual([{ issue: 7, text: '#7 notes: old [], new ["x"]' }])
    expect(diffRecords([A], [A, B])).toEqual([{ issue: 8, text: '#8 record: old absent, new present' }])
    expect(diffRecords([A, B], [B])).toEqual([{ issue: 7, text: '#7 record: old present, new absent' }])
  })

  test('object key order is no difference, at any depth; array order is', () => {
    const wait = [{ kind: 'pr-merged', pr: 997 }] as const
    const reordered = JSON.parse('[{"pr":997,"kind":"pr-merged"}]')
    expect(diffRecords([{ ...A, wait: [...wait] }], [{ ...A, wait: reordered }])).toEqual([])
    expect(diffRecords([{ ...A, notes: ['a', 'b'] }], [{ ...A, notes: ['b', 'a'] }])).toEqual([{ issue: 7, text: '#7 notes: old ["a","b"], new ["b","a"]' }])
  })
})
