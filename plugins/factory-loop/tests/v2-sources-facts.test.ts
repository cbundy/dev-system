// The facts and ledger rebuild's source switch and shadow compare (docs/factory-loop/v2/SPEC.md 3.3,
// v2/sources-facts.ts, rules-shadow.ts): the new store's rows map to the events factsOf, deriveLedger and
// onceKey read, a refused row fails the read, and the compare counts what differs outside the settle window.
import { describe, expect, test } from 'claude-code/testing'

import { deriveLedger, eventsFromRows, factsOf } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import { eventArgv, onceKey } from '../hooks/v2/events'
import { validateStrict } from '../hooks/v2/event-reader'
import { planV2 } from '../hooks/v2/plan'
import { compareFacts, eventsFromNewRows, floorsFromRows, viewOf } from '../hooks/v2/sources-facts'
import { SETTLE_MS } from '../hooks/v2/sources-records'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { emptyCache } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import { observeV2 } from '../hooks/v2/observe'
import type { V2Readers } from '../hooks/v2/observe'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, eventRow, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const SHA = '201fcea210d88b17ef51cda1b1036347ba0f50a0'
// One old log line (the keys of images/base/callum-flow-event's jq object) with the new event the
// translator (images/base/factory-event-translate.js, docs/factory-events/translator.md) makes of it,
// its type and payload written out as a fixture pair.
type Line = { old: Record<string, string | number | null>; type: string; data: Record<string, unknown>; ts: number; issue: number | null; actor: string; device: string }
const iso = (ms: number) => new Date(ms).toISOString()
const T = NOW - 2 * 60 * MIN
const secs = (ms: number) => iso(Math.floor(ms / 1000) * 1000).replace('.000Z', 'Z')

function pair(state: string, type: string, data: Record<string, unknown>, o: { ts?: number; issue?: number | null; actor?: string; device?: string; col?: Record<string, string | number | null>; note?: string | null } = {}): Line {
  const l = { ts: o.ts ?? T, issue: o.issue === undefined ? 48 : o.issue, actor: o.actor ?? 'agent', device: o.device ?? DEVICE }
  return { ...l, type, data, old: { ts: secs(l.ts), state, issue: l.issue, run_id: null, branch: null, pr: null, head: null, note: o.note ?? null, actor: l.actor, device: l.device, ...o.col } }
}
type Opts = Parameters<typeof pair>[4]
const reclaimed = (o: Opts = {}) => pair('reclaimed', 'requeued', { reason: 'lease-expired', stage: null, lives: null, branch: null, pr: null, detail: null }, { actor: 'sweep', note: 'lease expired', ...o })
const claimed = (o: Opts = {}) => pair('claimed', 'claimed', { lease_minutes: 120 }, { note: 'lease: 120', ...o })
const renewed = (o: Opts = {}) => pair('renewed', 'claim_renewed', { lease_minutes: 120 }, { note: 'lease: 120', ...o })
const merged = (o: Opts = {}) => pair('merged', 'merged', { pr: 47, branch: 'issue-48', head: SHA, by: 'factory', recovered: false }, { col: { pr: 47, branch: 'issue-48', head: SHA }, ...o })
const readied = (o: Opts = {}) => pair('ready', 'ready', { title: null, labels: null, parent: null }, { actor: 'queue-watch', ...o })
const swept = (o: Opts = {}) => pair('closed', 'closed', { reason: 'completed' }, { actor: 'sweep', note: 'completed', ...o })
const tell = (status: 'done' | 'failed', o: Opts = {}) =>
  pair('loop', 'loop_entry', { kind: 'tell', key: 'tell:parked:48', status, attempts: 1, class: 'owner', rule: 'H1', started_at: iso(1792117900000), ended_at: iso(1792117901000), agent_id: null, wake: 'parked' }, {
    note: `kind=tell key=tell:parked:48 status=${status} attempts=1 class=owner rule=H1 started=1792117900000 ended=1792117901000 wake=parked out=wake decision=ok`,
    ...o,
  })
const intervened = (fact: string, o: Opts = {}) =>
  pair('intervention', 'intervention', { who: 'loop', cause: 'park', life: 'tmz94z', fact, pr: null, detail: 'a park' }, { note: `who=loop cause=park life=tmz94z fact=${fact} reason=a%20park`, ...o })
const reviewed = (answer: string, o: Opts = {}) =>
  pair('reviewed', 'reviewed', { branch: 'issue-48', pr: 47, head: SHA, verdict: 'approve', round: 3, patch: SHA, errors: 0, warnings: 0, infos: 0, reviewer: 'adjudicator', answer_path: answer }, {
    col: { pr: 47, branch: 'issue-48', head: SHA },
    note: `verdict=approve round=3 patch=${SHA} errors=0 warnings=0 infos=0 reviewer=adjudicator answer=${answer}`,
    ...o,
  })

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const oldRowOf = (l: Line): Record<string, string> => Object.fromEntries(Object.entries(l.old).map(([k, v]) => [k, text(v)]))
let seq = 0
function newRowOf(l: Line, over: Record<string, string> = {}): Record<string, string> {
  seq += 1
  return eventRow(l.type, l.data, l.ts, { issue: text(l.issue), actor: l.actor, device: l.device, device_seq: String(seq), ...over })
}
const oldOf = (lines: Line[]): FactoryEvent[] => eventsFromRows(lines.map(oldRowOf))
const newOf = (lines: Line[]): FactoryEvent[] => eventsFromNewRows(lines.map(l => newRowOf(l)))

describe('the new rows as the events the facts code reads (eventsFromNewRows)', () => {
  const cases: [string, Line, (view: ReturnType<typeof viewOf>) => void][] = [
    ['requeued is reclaimed (a sweep requeue)', reclaimed(), v => {
      expect([...v.reclaimed.keys()]).toEqual([48])
      expect([...v.ledger.keys()]).toEqual(['sweep:derived'])
    }],
    ['claimed', claimed(), v => expect([...v.ledger.keys()]).toEqual([`claim:48:derived:${Math.floor(T / 1000) * 1000}`])],
    ['claim_renewed is renewed', renewed(), v => expect([...v.ledger.keys()]).toEqual(['heartbeat:derived'])],
    ['merged', merged(), v => expect([...v.ledger.values()]).toMatchObject([{ key: 'rollout:48', pr: 47 }])],
    ['ready', readied(), v => {
      expect([...v.readyAt]).toEqual([[48, Math.floor(T / 1000) * 1000]])
      expect([...v.ledger.keys()]).toEqual([])
    }],
    ['closed by the sweep', swept(), v => expect([...v.ledger.keys()]).toEqual(['sweep:derived'])],
    ['loop_entry is a loop event', tell('done'), v => {
      expect(v.ledger.get('tell:parked:48')).toMatchObject({ kind: 'tell', status: 'done', wake: 'parked', startedAt: 1792117900000, endedAt: 1792117901000, issue: 48 })
    }],
    ['intervention', intervened('i48/ltmz94z/s7/t'), v => expect([...v.once]).toEqual(['intervention 48 park i48/ltmz94z/s7/t'])],
    ['reviewed', reviewed('/a/i48_r3.answer.json'), v => expect([...v.once]).toEqual(['reviewed 48 /a/i48_r3.answer.json'])],
  ]
  for (const [name, l, check] of cases) {
    test(`${name}: the old and the new row give equal reclaimed, ledger and once keys`, () => {
      check(viewOf(newOf([l]), DEVICE))
      expect(viewOf(newOf([l]), DEVICE)).toEqual(viewOf(oldOf([l]), DEVICE))
      expect(factsOf(newOf([l])).reclaimed).toEqual(factsOf(oldOf([l])).reclaimed)
      expect(factsOf(newOf([l])).readyAt).toEqual(factsOf(oldOf([l])).readyAt)
      expect(newOf([l]).map(e => onceKey(e))).toEqual(oldOf([l]).map(e => onceKey(e)))
    })
  }

  test("the old log keeps a loop entry's outcome that the new event drops, so the compare drops it on both sides", () => {
    expect(deriveLedger(oldOf([tell('done')]), DEVICE)[0]?.outcome).toMatchObject({ kind: 'wake', decision: 'ok' })
    expect(deriveLedger(newOf([tell('done')]), DEVICE)[0]?.outcome).toBeUndefined()
  })

  test('the time is cut to whole seconds, as the old log stores it, so derived keys agree', () => {
    const [e] = eventsFromNewRows([newRowOf(claimed(), { ts: '2026-10-16T02:00:43.512Z' })])
    expect(e?.ts).toBe(Date.parse('2026-10-16T02:00:43Z'))
  })

  test('an unknown type, an unknown version and a payload the reader refuses each throw, naming the event and the source new', () => {
    const good = newRowOf(claimed())
    const cases: Record<string, string>[] = [
      { ...good, type: 'usage' },
      { ...good, type: 'wind_down', data: '{}' },
      { ...good, type_version: '9' },
      { ...good, data: '{}' },
      { ...good, data: '{' },
      { ...good, ts: 'x' },
    ]
    for (const row of cases) {
      let message = ''
      try {
        eventsFromNewRows([newRowOf(claimed()), row])
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain(`event ${good.event_id}`)
      expect(message).toContain('source new')
    }
  })
})

describe('floorsFromRows', () => {
  test('reads the device and its floor; a row that does not read throws, naming the source new', () => {
    expect(floorsFromRows([{ device: 'a', floor: '2026-10-17T13:26:02Z' }])).toEqual(new Map([['a', Date.parse('2026-10-17T13:26:02Z')]]))
    expect(() => floorsFromRows([{ device: 'a', floor: 'x' }])).toThrow('source new')
    expect(() => floorsFromRows([{ floor: '2026-10-17T13:26:02Z' }])).toThrow('source new')
  })
})

describe('compareFacts', () => {
  const base = [reclaimed(), claimed(), intervened('i48/a'), tell('done')]

  test('equal sides: nothing differs, and the compare is not empty', () => {
    const c = compareFacts(oldOf(base), newOf(base), DEVICE, NOW, NOW)
    expect(c.data).toEqual({ reader: 'loop-facts', tool: 'factory-loop', compared: 1 + 3 + 1, differences: 0, live_differences: 0, diff_keys: [], old_ok: true, new_ok: true, settle_seconds: 600, detail: null, scope_floor: null, out_of_scope: 0 })
    expect(validateStrict('shadow_read', 1, c.data)).toEqual([])
    expect(c.diffs).toEqual([])
  })

  test('the newest ready per issue is compared: equal history gives equal readyAt, a ready on one side is the key ready:#N', () => {
    const history = [readied({ ts: T - MIN }), readied({ ts: T }), readied({ issue: 49, ts: T - 5 * MIN })]
    expect(factsOf(newOf(history)).readyAt).toEqual(factsOf(oldOf(history)).readyAt)
    expect(factsOf(newOf(history)).readyAt.get(48)).toBe(Math.floor(T / 1000) * 1000)
    const equal = compareFacts(oldOf(history), newOf(history), DEVICE, NOW, NOW)
    expect(equal.data).toMatchObject({ compared: 2, differences: 0 })
    const c = compareFacts(oldOf(history), newOf(history.slice(0, 2)), DEVICE, NOW, NOW)
    expect(c.data).toMatchObject({ differences: 1, diff_keys: ['ready:#49'], compared: 2 })
    // the newest one differs: also a difference
    const d = compareFacts(oldOf(history), newOf([history[0], history[2]]), DEVICE, NOW, NOW)
    expect(d.data.diff_keys).toEqual(['ready:#48'])
  })

  test('a reclaimed, a ledger and a once-key difference each count, by key', () => {
    const changed = [reclaimed({ ts: T + MIN }), claimed(), intervened('i48/b'), tell('failed')]
    const c = compareFacts(oldOf(base), newOf(changed), DEVICE, NOW, NOW)
    expect(c.data.differences).toBe(c.data.live_differences)
    expect(c.data.diff_keys).toEqual(['reclaimed:#48', 'ledger:sweep:derived', 'ledger:tell:parked:48', 'once:intervention 48 park i48/a', 'once:intervention 48 park i48/b'])
    expect(c.diffs[0]?.text).toBe(`#48 reclaimed: old ${secs(T).replace('Z', '.000Z')}, new ${secs(T + MIN).replace('Z', '.000Z')}`)
    expect(c.data.detail).toBe(c.diffs[0]?.text)
  })

  describe('the scope floor: history from before a device\'s first new-store event', () => {
    const FLOOR = T - 5 * MIN
    const before = (o: Opts = {}) => ({ ...o, ts: FLOOR - 60 * MIN })
    // the loop device's events from before its floor (old store only) and from the floor on (both)
    const history = [claimed(before()), merged(before({ issue: 49 })), tell('done', before()), reviewed('/a/old.json', before()), intervened('i48/old', before())]
    const after = [claimed({ ts: FLOOR + MIN, issue: 50 }), merged({ ts: FLOOR + MIN, issue: 51 }), reviewed('/a/new.json', { ts: FLOOR + MIN })]
    const floors = new Map([[DEVICE, Math.floor(FLOOR / 1000) * 1000]])

    test('without floors the old history is a difference: the loop\'s claim, rollout, tell and once keys', () => {
      const c = compareFacts(oldOf([...history, ...after]), newOf(after), DEVICE, NOW, NOW)
      expect(c.data.differences).toBeGreaterThan(0)
      expect(c.data.diff_keys.some(k => k.startsWith('ledger:claim:48:derived:'))).toBe(true)
      expect(c.data).toMatchObject({ scope_floor: null, out_of_scope: 0 })
    })

    test('with the floor both sides agree: 0 differences, 0 live, the dropped events counted', () => {
      const c = compareFacts(oldOf([...history, ...after]), newOf(after), DEVICE, NOW, NOW, floors)
      expect(c.data).toMatchObject({ differences: 0, live_differences: 0, diff_keys: [], out_of_scope: history.length, scope_floor: iso(Math.floor(FLOOR / 1000) * 1000) })
      expect(validateStrict('shadow_read', 1, c.data)).toEqual([])
    })

    test('an event in the floor\'s own second stays on both sides (old whole second, new with milliseconds)', () => {
      const own = claimed({ ts: Math.floor(FLOOR / 1000) * 1000 + 663 })
      const c = compareFacts(oldOf([own]), newOf([own]), DEVICE, NOW, NOW, floors)
      expect(c.data).toMatchObject({ compared: 1, differences: 0, out_of_scope: 0 })
      // and one that the new store lacks still shows
      expect(compareFacts(oldOf([own]), newOf([]), DEVICE, NOW, NOW, floors).data.differences).toBe(1)
    })

    test('a device with no floor keeps its old events, and shows as a difference; events with no device stay', () => {
      const lone = claimed({ ...before(), device: 'lone' })
      const own = new Map([[DEVICE, Math.floor(FLOOR / 1000) * 1000]])
      const c = compareFacts(oldOf([lone]), newOf([]), 'lone', NOW, NOW, own)
      expect(c.data).toMatchObject({ differences: 1, out_of_scope: 0, scope_floor: null })
      const nodev = reclaimed({ ...before(), device: '' })
      expect(compareFacts(oldOf([nodev]), newOf([]), DEVICE, NOW, NOW, own).data.diff_keys).toContain('reclaimed:#48')
    })

    test('another device\'s floor cuts only that device\'s events, a reclaimed of it too', () => {
      const other = reclaimed({ ts: FLOOR - 60 * MIN, device: 'someone-else', issue: 52 })
      const mine = reclaimed({ ts: FLOOR - 60 * MIN, issue: 53 })
      const both = new Map([...floors, ['someone-else', Math.floor(FLOOR / 1000) * 1000]])
      const c = compareFacts(oldOf([other, mine]), newOf([]), DEVICE, NOW, NOW, both)
      expect(c.data.diff_keys).toEqual([])
      expect(c.data.out_of_scope).toBe(2)
      // only the other device's floor: this device's reclaimed is a difference again
      const onlyOther = new Map([['someone-else', Math.floor(FLOOR / 1000) * 1000]])
      const keys = compareFacts(oldOf([other, mine]), newOf([]), DEVICE, NOW, NOW, onlyOther).data.diff_keys
      expect(keys).toContain('reclaimed:#53')
      expect(keys).not.toContain('reclaimed:#52')
    })
  })

  test('a difference only inside the settle window shows in live_differences, not in differences', () => {
    const recent = claimed({ ts: NOW - SETTLE_MS / 2 })
    const c = compareFacts(oldOf([...base, recent]), newOf(base), DEVICE, NOW, NOW)
    expect(c.data).toMatchObject({ differences: 0, live_differences: 1, diff_keys: [] })
    // outside the window it counts
    expect(compareFacts(oldOf([...base, recent]), newOf(base), DEVICE, NOW + 2 * SETTLE_MS, NOW).data).toMatchObject({ differences: 1, live_differences: 1 })
  })

  test("other devices' events prove nothing of this device's ledger or once keys", () => {
    const other = claimed({ device: 'someone-else' })
    expect(compareFacts(oldOf([...base, other]), newOf(base), DEVICE, NOW, NOW).data.differences).toBe(0)
  })
})

describe('the facts shadow in the planner (rules-shadow.ts)', () => {
  const same = reclaimed()
  const compare = (issue: number) => compareFacts(oldOf([same]), newOf([issue === 48 ? same : reclaimed({ issue })]), DEVICE, NOW, NOW)

  // the pass's v2 read, given this compare as the facts' read left it, and the planner over it
  async function plan(shadow: ReturnType<typeof compare>, ledger: LedgerEntry[] = []): Promise<Action[]> {
    const run = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    const io: Io = { now: async () => NOW, run, readFile: async () => null, sessionLimits: async () => [], agents: async () => [] }
    const rt: Runtime = { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: {}, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config(), configProblems: [] }
    const ok = { ok: true, at: NOW }
    const readers: V2Readers = {
      prs: async ctx => ({ read: { prs: [] }, source: ok, heads: ctx.heads }),
      interventions: async () => ({ read: { companion: [], controlDigest: null, configDigest: null }, source: ok }),
    }
    const cache = emptyCache()
    const o = await observeV2({ io, rt, cache: cache.v2, run, state: baseState({ now: NOW }), stored: { records: [], heads: null, error: null }, poolJson: null, github: cache.github, backoff: false, limited: () => false, readers, factsShadow: shadow })
    const s = baseState({ now: NOW })
    const state: State = { ...s, ledger: [...s.ledger, ...ledger], v2: { ...o.v2, sources: { ...o.v2.sources, store: ok } } }
    return planV2(state, config({ mode: 'act', maxInFlightIssues: 3 })).actions
  }
  const shadowEvents = (actions: Action[]) => actions.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.event.state === 'shadow_read')
  const tells = (actions: Action[]) => actions.filter(a => a.kind === 'tell' && a.wake === 'facts-shadow')

  test('a compare writes one shadow_read event with reader loop-facts, and an equal one tells nothing', async () => {
    const actions = await plan(compare(48))
    const [ev] = shadowEvents(actions)
    expect(shadowEvents(actions)).toHaveLength(1)
    expect(ev?.key).toBe(`facts-shadow:${NOW}`)
    expect(ev?.rule).toBe('H1')
    expect(ev?.event.state === 'shadow_read' ? ev.event.data.reader : null).toBe('loop-facts')
    expect(ev?.event.state === 'shadow_read' && eventArgv(ev.event).slice(0, 4)).toEqual(['callum-flow-event', '--type', 'shadow_read', '--data'])
    expect(tells(actions)).toEqual([])
  })

  test('a differing compare tells the owner once per distinct set of keys, with the first difference and the way back', async () => {
    const first = await plan(compare(49))
    const [t] = tells(first)
    expect(tells(first)).toHaveLength(1)
    expect(t).toMatchObject({ kind: 'tell', wake: 'facts-shadow', key: 'tell:facts-shadow:reclaimed:#48,reclaimed:#49', class: 'owner', rule: 'H1' })
    const body = t?.kind === 'tell' ? t.context.join('\n') : ''
    expect(body).toContain('reclaimed:#48, reclaimed:#49')
    expect(body).toContain('first: #48 reclaimed: old')
    expect(body).toContain('/factory config set eventsSource old')
    // the same set told again: its ledger entry is done, so nothing is planned
    const done = entry('tell:facts-shadow:reclaimed:#48,reclaimed:#49', 'tell', { status: 'done' })
    expect(tells(await plan(compare(49), [done]))).toEqual([])
    // another set is told again
    expect(tells(await plan(compare(50), [done])).map(a => a.key)).toEqual(['tell:facts-shadow:reclaimed:#48,reclaimed:#50'])
  })
})
