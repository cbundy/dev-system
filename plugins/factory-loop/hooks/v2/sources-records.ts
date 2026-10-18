// The record rebuild's read (docs/factory-loop/v2/SPEC.md 3.3) and its source switch `eventsSource`:
// `old` rebuilds from factory.events (REBUILD_SQL), `new` from factory.event_store (NEW_REBUILD_SQL),
// and `shadow` (the default) reads both, compares the two rebuilds per issue and field by field, and
// leaves the records to the old read. The compare is written as a `shadow_read` event (reader
// `loop-records`) and told to the owner by rules-shadow.ts. A failing new read never fails a pass
// under `shadow`; under `new` it fails the rebuild, and no row is ever skipped.
import { eventsFromRows } from '../derive'
import type { FactoryEvent } from '../derive'
import { parseCsv } from '../parse'
import type { ShadowReadData } from './events'
import { NEW_REBUILD_SQL, REBUILD_DAYS, REBUILD_SQL, recordsFromEvents, recordsFromNewRows } from './record'
import type { SourceCtx } from './observe'
import type { IssueRecord } from './types'

export const SHADOW_READER = 'loop-records'
// the compare is made once per load, then at most this often
export const SHADOW_EVERY_MS = 60 * 60_000
// both sides are cut this far back so push lag is not counted as a difference
export const SETTLE_MS = 600_000
const MAX_KEYS = 50

// One compare: the data of its `shadow_read` event, and the first difference of each differing issue
// (ordered by issue), for the owner's tell.
export type RecordsShadow = { at: number; data: ShadowReadData; diffs: readonly { issue: number; text: string }[] }

// What survives between passes (V2Cache): the last rebuild and the last compare.
export type RecordsCache = { rebuilt: { at: number; records: IssueRecord[] } | null; shadow: RecordsShadow | null }

// --- the compare (pure) -----------------------------------------------------------------------------

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// diffRecords: the issues whose records differ, each with its first differing field as
// `#n field: old X, new Y` (a record only one side holds is `#n record: old present, new absent`).
export function diffRecords(oldRecords: readonly IssueRecord[], newRecords: readonly IssueRecord[]): { issue: number; text: string }[] {
  const o = new Map(oldRecords.map(r => [r.issue, r]))
  const n = new Map(newRecords.map(r => [r.issue, r]))
  const out: { issue: number; text: string }[] = []
  for (const issue of [...new Set([...o.keys(), ...n.keys()])].sort((a, b) => a - b)) {
    const a = o.get(issue)
    const b = n.get(issue)
    if (a === undefined || b === undefined) {
      out.push({ issue, text: `#${issue} record: old ${a === undefined ? 'absent' : 'present'}, new ${b === undefined ? 'absent' : 'present'}` })
      continue
    }
    const field = (Object.keys(a) as (keyof IssueRecord)[]).find(k => !same(a[k], b[k]))
    if (field !== undefined) out.push({ issue, text: `#${issue} ${field}: old ${JSON.stringify(a[field])}, new ${JSON.stringify(b[field])}` })
  }
  return out
}

// compareRebuilds: the two rebuilds of the same keys, once on everything read (live) and once with
// both sides cut SETTLE_MS back from now (the differences that count). Throws when the new rows
// are refused, which the caller reads as a failed new read.
export function compareRebuilds(events: readonly FactoryEvent[], rows: readonly Record<string, string>[], device: string, now: number, at: number): RecordsShadow {
  const cut = now - SETTLE_MS
  const live = diffRecords(recordsFromEvents(events, device), recordsFromNewRows(rows))
  const settled = diffRecords(
    recordsFromEvents(events.filter(e => e.ts <= cut), device),
    recordsFromNewRows(rows.filter(r => Date.parse(r.ts ?? '') <= cut)),
  )
  const issues = new Set([...recordsFromEvents(events, device), ...recordsFromNewRows(rows)].map(r => r.issue))
  const data: ShadowReadData = {
    reader: SHADOW_READER,
    tool: 'factory-loop',
    compared: issues.size,
    differences: settled.length,
    live_differences: live.length,
    diff_keys: settled.slice(0, MAX_KEYS).map(d => String(d.issue)),
    old_ok: true,
    new_ok: true,
    settle_seconds: SETTLE_MS / 1000,
    detail: settled[0] === undefined ? null : settled[0].text.slice(0, 500),
  }
  return { at, data, diffs: settled }
}

// a compare that could not be made: a side failed to read
function failedShadow(at: number, oldError: string | null, newError: string | null): RecordsShadow {
  const detail = [oldError === null ? null : `old: ${oldError}`, newError === null ? null : `new: ${newError}`].filter(x => x !== null).join('; ')
  const data: ShadowReadData = {
    reader: SHADOW_READER,
    tool: 'factory-loop',
    compared: 0,
    differences: 0,
    live_differences: 0,
    diff_keys: [],
    old_ok: oldError === null,
    new_ok: newError === null,
    settle_seconds: SETTLE_MS / 1000,
    detail: detail.slice(0, 500),
  }
  return { at, data, diffs: [] }
}

// --- the reads --------------------------------------------------------------------------------------

type Ctx = Pick<SourceCtx, 'now' | 'rt' | 'run'>
type Read<T> = { ok: true; value: T } | { ok: false; error: string }

const vars = (ctx: Ctx): string[] => ['-v', `repo=${ctx.rt.repo}`, '-v', `device=${ctx.rt.device}`, '-v', `at=${new Date(ctx.now).toISOString()}`, '-v', `days=${REBUILD_DAYS}`]

async function readOld(ctx: Ctx): Promise<Read<FactoryEvent[]>> {
  if (REBUILD_SQL === null) return { ok: false, error: 'the rebuild has no query' }
  try {
    const r = await ctx.run(['dev-query', '--csv', ...vars(ctx)], REBUILD_SQL)
    if (r.exitCode !== 0) return { ok: false, error: `the rebuild's read failed: exit ${r.exitCode}` }
    return { ok: true, value: eventsFromRows(parseCsv(r.stdout)) }
  } catch (err) {
    return { ok: false, error: `the rebuild's read failed: ${String(err).slice(0, 200)}` }
  }
}

// readNew: the rows of the new store and their records; a missing factory URL (dev-query exit 77 or
// 78) or any refused row fails the read.
async function readNew(ctx: Ctx): Promise<Read<{ rows: Record<string, string>[]; records: IssueRecord[] }>> {
  try {
    const r = await ctx.run(['dev-query', '--factory', '--csv', ...vars(ctx)], NEW_REBUILD_SQL)
    if (r.exitCode !== 0) return { ok: false, error: `the rebuild's read failed (source new): exit ${r.exitCode}` }
    const rows = parseCsv(r.stdout)
    return { ok: true, value: { rows, records: recordsFromNewRows(rows) } }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `the rebuild's read failed: ${text.includes('source new') ? text : `source new: ${text}`}`.slice(0, 300) }
  }
}

// readRecords: the pass's rebuild and compare, into the cache. storeEmpty: the store holds no records,
// so a rebuild is wanted (on the githubEveryMs cadence). Returns the error of a rebuild's read that
// failed (the store source's), else null. Under `shadow` the compare runs whether or not the store
// holds records, on its first pass of a load and then at most hourly; its failure is never returned.
export async function readRecords(ctx: Ctx, cache: RecordsCache, storeEmpty: boolean): Promise<string | null> {
  const { now, rt } = ctx
  const source = rt.config.eventsSource
  const rebuildDue = storeEmpty && (cache.rebuilt === null || now - cache.rebuilt.at >= rt.config.githubEveryMs)
  const shadowDue = source === 'shadow' && (cache.shadow === null || now - cache.shadow.at >= SHADOW_EVERY_MS)
  if (!rebuildDue && !shadowDue) return null
  const old = shadowDue || (rebuildDue && source !== 'new') ? await readOld(ctx) : null
  const fresh = shadowDue || (rebuildDue && source === 'new') ? await readNew(ctx) : null
  let error: string | null = null
  if (rebuildDue) {
    if (source === 'new') {
      if (fresh?.ok === true) cache.rebuilt = { at: now, records: fresh.value.records }
      else error = fresh?.ok === false ? fresh.error : null
    } else if (old?.ok === true) {
      cache.rebuilt = { at: now, records: recordsFromEvents(old.value, rt.device) }
    } else {
      error = old?.ok === false ? old.error : null
    }
  }
  if (shadowDue && old !== null && fresh !== null) {
    if (old.ok && fresh.ok) {
      try {
        cache.shadow = compareRebuilds(old.value, fresh.value.rows, rt.device, now, now)
      } catch (err) {
        cache.shadow = failedShadow(now, null, String(err).slice(0, 200))
      }
    } else {
      cache.shadow = failedShadow(now, old.ok ? null : old.error, fresh.ok ? null : fresh.error)
    }
  }
  return error
}
