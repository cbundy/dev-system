// The facts and the ledger rebuild's read of the event log (docs/factory-loop/v2/SPEC.md 3.3) and its
// source switch `eventsSource`, the same switch as the record rebuild's (sources-records.ts): `old` reads
// factory.events (EVENTS_SQL), `new` reads factory.event_store (NEW_EVENTS_SQL), and `shadow` (the
// default) decides on the old read and compares it with the new one, once per load and then at most
// hourly. Three things are compared: the newest `reclaimed` per issue (facts.reclaimed), the ledger
// deriveLedger rebuilds for this device, and the once keys v2's `logged` reads. The compare is written
// as a `shadow_read` event (reader `loop-facts`) and told to the owner by rules-shadow.ts.
//
// The new rows are mapped to the FactoryEvent that factsOf, deriveLedger and onceKey read, with the
// old state name, so those stay the one code path. A failing new read never fails a pass under
// `shadow`; under `new` it fails the read, and no row is ever skipped.
//
// The production new store holds only dual-written events, so the old read's window reaches back before
// it begins. The compare therefore reads each device's first new-store time for the repo (NEW_FLOORS_SQL)
// and leaves out of both sides the events of a device older than its floor (docs/factory-events/replay.md).
//
// The facts no v2 path reads (briefs, reviewFixes, verdicts, superseded, answered, pipeline) come out
// empty under `new`: only runsFromEvents reads them, and only the plan replay and the state digest read
// its runs (docs/factory-events/replay.md).
import { EVENTS_SQL, deriveLedger, eventsFromRows, factsOf, loopNote } from '../derive'
import type { FactoryEvent } from '../derive'
import { parseCsv } from '../parse'
import type { LedgerEntry } from '../types'
import { readEvent } from './event-reader'
import { eventNote, onceKey } from './events'
import type { ShadowReadData } from './events'
import { failedShadow, SETTLE_MS, SHADOW_EVERY_MS } from './sources-records'
import type { Ctx, Read } from './sources-records'

export const FACTS_SHADOW_READER = 'loop-facts'
const MAX_KEYS = 50

// The new types the facts read, each under the old state name the facts code reads: requeued as
// `reclaimed`, claim_renewed as `renewed`, loop_entry as `loop`. A `closed` event counts only from
// the sweep, whose actor deriveLedger reads.
export const FACTS_TYPES = ['requeued', 'claimed', 'claim_renewed', 'merged', 'loop_entry', 'intervention', 'reviewed'] as const

// The dev-query SQL that reads the new store's events for the facts and the ledger rebuild, with the
// variables repo, at and days (EVENTS_SQL's), over all devices, oldest first, in the columns
// eventsFromNewRows reads.
export const NEW_EVENTS_SQL = `select
  envelope, event_id,
  to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
  type, type_version, repo, device, actor, session_id, issue, base_image, dev_image, template_version,
  plugin_version, device_seq, data
from factory.event_store
where repo = :'repo'
  and ts <= :'at'::timestamptz
  and ts > :'at'::timestamptz - make_interval(days => :'days'::int)
  and (type in (${FACTS_TYPES.map(t => `'${t}'`).join(', ')}) or (type = 'closed' and actor = 'sweep'))
order by ts, device, device_seq;
`

// The dev-query SQL that reads each device's first time in the new store for the repo (variable repo),
// over every type, cut to whole seconds as the old log stores times: the columns device and floor.
export const NEW_FLOORS_SQL = `select device,
  to_char(date_trunc('second', min(ts)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as floor
from factory.event_store
where repo = :'repo' and device is not null
group by device
order by device;
`

// floorsFromRows: the floors of the rows of NEW_FLOORS_SQL, by device, in ms. A row that does not read
// throws, so the floor read fails (and the compare with it) rather than compare with a partial floor.
export function floorsFromRows(rows: readonly Record<string, string>[]): Map<string, number> {
  const floors = new Map<string, number>()
  for (const row of rows) {
    const at = Date.parse(row.floor ?? '')
    if (row.device === undefined || row.device === '' || Number.isNaN(at)) throw new Error(`source new: floor row does not read: ${JSON.stringify(row).slice(0, 150)}`)
    floors.set(row.device, at)
  }
  return floors
}

// One compare: the data of its `shadow_read` event, and each differing key with its text (ordered:
// reclaimed, ledger, once), for the owner's tell.
export type FactsShadow = { at: number; data: ShadowReadData; diffs: readonly { key: string; text: string }[] }

// --- the new rows as events (pure) ----------------------------------------------------------------

const orNull = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v)
const numOrNull = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number(v))

// eventsFromNewRows: the FactoryEvents of the rows of NEW_EVENTS_SQL, oldest first. A row of an
// unknown type or version, or one the shared reader refuses, throws an Error that names its event_id
// and the source `new`, so the whole read fails. The time is cut to whole seconds, as the old log
// stores it, so the keys derived from it (claim:N:derived:<ts>) and the facts agree.
export function eventsFromNewRows(rows: readonly Record<string, string>[]): FactoryEvent[] {
  const events: FactoryEvent[] = []
  for (const row of rows) {
    try {
      events.push(eventOfRow(row))
    } catch (err) {
      throw new Error(`source new: event ${row.event_id ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    }
  }
  return events.sort((a, b) => a.ts - b.ts)
}

function eventOfRow(row: Record<string, string>): FactoryEvent {
  const at = Date.parse(row.ts ?? '')
  if (Number.isNaN(at)) throw new Error('ts does not read')
  let data: unknown
  try {
    data = JSON.parse(row.data ?? '')
  } catch {
    throw new Error('data is not JSON')
  }
  const e = readEvent({ envelope: Number(row.envelope), type: row.type, type_version: Number(row.type_version), data })
  const d = e.data
  const issue = numOrNull(row.issue)
  const event: FactoryEvent = { ts: Math.floor(at / 1000) * 1000, state: '', issue, run: null, branch: null, pr: null, head: null, note: null, actor: orNull(row.actor), device: orNull(row.device) }
  switch (e.type) {
    case 'requeued':
      return { ...event, state: 'reclaimed', branch: d.branch as string | null, pr: d.pr as number | null }
    case 'claimed':
      return { ...event, state: 'claimed' }
    case 'claim_renewed':
      return { ...event, state: 'renewed' }
    case 'closed':
      return { ...event, state: 'closed' }
    case 'merged':
      return { ...event, state: 'merged', branch: d.branch as string | null, pr: d.pr as number | null, head: d.head as string | null }
    case 'loop_entry': {
      // the note the loop's own writer builds, so entryFromLoop reads the entry back; the outcome
      // tokens and the run, PR and head columns are not in the new event (replay.md)
      const entry: LedgerEntry = {
        key: d.key as string,
        kind: d.kind as LedgerEntry['kind'],
        class: d.class as LedgerEntry['class'],
        rule: d.rule as string,
        issue: null,
        run: null,
        pr: null,
        head: null,
        status: d.status as LedgerEntry['status'],
        attempts: d.attempts as number,
        startedAt: Date.parse(d.started_at as string),
        endedAt: d.ended_at === null ? null : Date.parse(d.ended_at as string),
      }
      if (d.agent_id !== null) entry.agentId = d.agent_id as string
      if (d.wake !== null) entry.wake = d.wake as string
      return { ...event, state: 'loop', note: loopNote(entry) }
    }
    case 'intervention':
      return {
        ...event,
        state: 'intervention',
        pr: d.pr as number | null,
        note: eventNote({ state: 'intervention', who: d.who as 'person' | 'loop', cause: d.cause as string, reason: d.detail as string, issue, life: d.life as string | null, pr: d.pr as number | null, fact: d.fact as string }),
      }
    case 'reviewed': {
      if (issue === null) throw new Error('issue is missing')
      const reviewed = {
        state: 'reviewed' as const,
        issue,
        branch: d.branch as string,
        pr: d.pr as number,
        head: d.head as string,
        verdict: d.verdict as 'approve' | 'changes' | 'unknown',
        round: d.round as number,
        patch: d.patch as string,
        errors: d.errors as number,
        warnings: d.warnings as number,
        infos: d.infos as number,
        reviewer: d.reviewer as string,
        answer: d.answer_path as string,
      }
      return { ...event, state: 'reviewed', branch: reviewed.branch, pr: reviewed.pr, head: reviewed.head, note: eventNote(reviewed) }
    }
    default:
      throw new Error(`unknown type ${e.type}`)
  }
}

// --- the compare (pure) ---------------------------------------------------------------------------

// What the three compared things hold: the newest `reclaimed` time per issue, the ledger by key, and
// the once keys.
export type View = { reclaimed: Map<number, number>; ledger: Map<string, LedgerEntry>; once: Set<string> }

// viewOf: the compared things of one side's events. The ledger entries the loop logged lose what the
// new `loop_entry` does not carry: the outcome and the run, PR and head columns (v2 reads those only
// of the entries it keys itself, which it never logs through a `loop` event), so both sides drop them.
export function viewOf(events: readonly FactoryEvent[], device: string): View {
  const list = [...events]
  const ledger = new Map<string, LedgerEntry>()
  for (const entry of deriveLedger(list, device)) {
    if (entry.rule === 'derived') ledger.set(entry.key, entry)
    else ledger.set(entry.key, { ...entry, run: null, pr: null, head: null, outcome: undefined })
  }
  const once = new Set(list.flatMap(e => (e.device === null || e.device === device ? (onceKey(e) ?? []) : [])))
  return { reclaimed: factsOf(list).reclaimed, ledger, once }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const iso = (ms: number | undefined): string => (ms === undefined ? 'absent' : new Date(ms).toISOString())

function diffViews(a: View, b: View): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  for (const issue of [...new Set([...a.reclaimed.keys(), ...b.reclaimed.keys()])].sort((x, y) => x - y)) {
    if (a.reclaimed.get(issue) !== b.reclaimed.get(issue)) out.push({ key: `reclaimed:#${issue}`, text: `#${issue} reclaimed: old ${iso(a.reclaimed.get(issue))}, new ${iso(b.reclaimed.get(issue))}` })
  }
  for (const key of [...new Set([...a.ledger.keys(), ...b.ledger.keys()])].sort()) {
    const x = a.ledger.get(key)
    const y = b.ledger.get(key)
    if (!same(x, y)) out.push({ key: `ledger:${key}`, text: `ledger ${key}: old ${x === undefined ? 'absent' : JSON.stringify(x)}, new ${y === undefined ? 'absent' : JSON.stringify(y)}` })
  }
  for (const key of [...new Set([...a.once, ...b.once])].sort()) {
    if (a.once.has(key) !== b.once.has(key)) out.push({ key: `once:${key}`, text: `once ${key}: old ${a.once.has(key) ? 'present' : 'absent'}, new ${b.once.has(key) ? 'present' : 'absent'}` })
  }
  return out
}

// inScope: the events a device's floor leaves in. An event of a device with a floor is out when older
// than it (both are whole seconds, so the floor's own second stays in); an event of a device with no
// floor, or with no device, stays in.
const inScope = (floors: ReadonlyMap<string, number>) => (e: FactoryEvent): boolean => {
  const floor = e.device === null ? undefined : floors.get(e.device)
  return floor === undefined || e.ts >= floor
}

// compareFacts: the two sides' events, compared once on everything read (live) and once with both
// sides cut SETTLE_MS back from now (the differences that count). Before that both sides lose the
// events older than their device's first new-store time (`floors`, by device in ms): history the new
// store never held. The data names this device's floor and how many events were left out.
export function compareFacts(oldEvents: readonly FactoryEvent[], newEvents: readonly FactoryEvent[], device: string, now: number, at: number, floors: ReadonlyMap<string, number> = new Map()): FactsShadow {
  const cut = now - SETTLE_MS
  const keep = inScope(floors)
  const outOfScope = oldEvents.filter(e => !keep(e)).length + newEvents.filter(e => !keep(e)).length
  oldEvents = oldEvents.filter(keep)
  newEvents = newEvents.filter(keep)
  const floor = floors.get(device)
  const a = viewOf(oldEvents, device)
  const b = viewOf(newEvents, device)
  const live = diffViews(a, b)
  const settled = diffViews(viewOf(oldEvents.filter(e => e.ts <= cut), device), viewOf(newEvents.filter(e => e.ts <= cut), device))
  const compared = new Set([...a.reclaimed.keys()].map(n => `r${n}`).concat([...b.reclaimed.keys()].map(n => `r${n}`), [...a.ledger.keys(), ...b.ledger.keys()].map(k => `l${k}`), [...a.once, ...b.once].map(k => `o${k}`))).size
  const data: ShadowReadData = {
    reader: FACTS_SHADOW_READER,
    tool: 'factory-loop',
    compared,
    differences: settled.length,
    live_differences: live.length,
    diff_keys: settled.slice(0, MAX_KEYS).map(d => d.key),
    old_ok: true,
    new_ok: true,
    settle_seconds: SETTLE_MS / 1000,
    detail: settled[0] === undefined ? null : settled[0].text.slice(0, 500),
    scope_floor: floor === undefined ? null : new Date(floor).toISOString(),
    out_of_scope: outOfScope,
  }
  return { at, data, diffs: settled }
}

// --- the reads --------------------------------------------------------------------------------------

// exitFail: why a command failed, as observe reports it.
export const exitFail = (r: { exitCode: number; stderr: string }): string => `exit ${r.exitCode}: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`

const eventsArgv = (ctx: Ctx, days: number, factory: boolean): string[] => [
  'dev-query',
  ...(factory ? ['--factory'] : []),
  '--csv',
  '-v',
  `repo=${ctx.rt.repo}`,
  '-v',
  `at=${new Date(ctx.now).toISOString()}`,
  '-v',
  `days=${days}`,
]

async function readOld(ctx: Ctx, days: number): Promise<Read<FactoryEvent[]>> {
  try {
    const r = await ctx.run(eventsArgv(ctx, days, false), EVENTS_SQL)
    return r.exitCode === 0 ? { ok: true, value: eventsFromRows(parseCsv(r.stdout)) } : { ok: false, error: exitFail(r) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// readNew: a missing factory URL (dev-query exit 77 or 78) or any refused row fails the read.
async function readNew(ctx: Ctx, days: number): Promise<Read<FactoryEvent[]>> {
  try {
    const r = await ctx.run(eventsArgv(ctx, days, true), NEW_EVENTS_SQL)
    if (r.exitCode !== 0) return { ok: false, error: `the event read failed (source new): ${exitFail(r)}` }
    return { ok: true, value: eventsFromNewRows(parseCsv(r.stdout)) }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `the event read failed: ${text.includes('source new') ? text : `source new: ${text}`}`.slice(0, 300) }
  }
}

// readFloors: each device's first new-store time for the repo; a failing read fails the compare.
async function readFloors(ctx: Ctx): Promise<Read<Map<string, number>>> {
  try {
    const r = await ctx.run(['dev-query', '--factory', '--csv', '-v', `repo=${ctx.rt.repo}`], NEW_FLOORS_SQL)
    if (r.exitCode !== 0) return { ok: false, error: `the floor read failed (source new): ${exitFail(r)}` }
    return { ok: true, value: floorsFromRows(parseCsv(r.stdout)) }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `the floor read failed: ${text.includes('source new') ? text : `source new: ${text}`}`.slice(0, 300) }
  }
}

// readFacts: the events of the last `days` from the source `eventsSource` picks. With `cache` (the
// facts read, not the ledger rebuild's) and the source `shadow`, the new store is also read and the
// two compared into cache.factsShadow on the first call of a load and then at most hourly; that
// compare's failure is never returned, and the events are the old read's.
export async function readFacts(ctx: Ctx, days: number, cache?: { factsShadow?: FactsShadow }): Promise<Read<FactoryEvent[]>> {
  const { now, rt } = ctx
  const source = rt.config.eventsSource
  if (source === 'new') return readNew(ctx, days)
  const old = await readOld(ctx, days)
  if (source !== 'shadow' || cache === undefined) return old
  if (cache.factsShadow !== undefined && now - cache.factsShadow.at < SHADOW_EVERY_MS) return old
  const fresh = await readNew(ctx, days)
  const floors = fresh.ok ? await readFloors(ctx) : null
  if (old.ok && fresh.ok && floors?.ok === true) {
    cache.factsShadow = compareFacts(old.value, fresh.value, rt.device, now, now, floors.value)
  } else {
    const newError = !fresh.ok ? fresh.error : floors?.ok === false ? floors.error : null
    cache.factsShadow = { at: now, data: failedShadow(FACTS_SHADOW_READER, old.ok ? null : old.error, newError), diffs: [] }
  }
  return old
}
