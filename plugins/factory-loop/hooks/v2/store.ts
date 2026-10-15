// v2's store keys in the pass driver (docs/factory-loop/v2/SPEC.md 2.3, 2.4, 3.3): the records
// (records:<repo>) and the PR heads first seen (heads:<repo>), kept in memory beside the ledger as
// the ledger is. register.ts holds one V2Live and the engine; each function here is one call from
// it: loadV2 with the ledger, storedV2 and readStoredV2 for observe, keepV2 after it, and v2IoOf
// for the transition executor (ActIo.v2).
//
// - A read keeps three cases apart: the store could not be read (or holds no stored records under
//   the key), so nothing is loaded and v2 plans nothing that releases or starts (v2/plan.ts); the
//   key is absent, so a rebuild from events may fill it (3.3); and stored records, an empty list
//   included, which are the truth.
// - A record change is kept in memory only once the store took it: a write that fails leaves both
//   at the old seq, so the transition executor's compare finds the record where the store has it
//   and its retry stores the new seq (3.3).
import type { Ms, State } from '../types'
import { headsFromStore, headsKey, headsToStore, recordsFromStore, recordsKey, recordsToStore } from './observe'
import type { V2Stored } from './observe'
import type { HeadSeen, IssueRecord, V2Io } from './types'

const ERROR_MAX = 200

// The store as the driver gives it: get throws when the store cannot be read.
export type V2StoreIo = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  now: () => Promise<Ms>
}

// The live records and heads of an acting session.
export type V2Live = {
  repo: string
  records: IssueRecord[]
  // the key held nothing at the load, and nothing was written since: a rebuild may fill it
  absent: boolean
  heads: Record<string, HeadSeen> | null
  loaded: boolean
  // why the records are not loaded: the store's read failed, or the key holds no stored records
  error: string | null
}

export function newV2Live(): V2Live {
  return { repo: '', records: [], absent: true, heads: null, loaded: false, error: 'not loaded yet' }
}

// What a read of records:<repo> gave.
type RecordsRead = { ok: true; records: IssueRecord[] | null } | { ok: false; error: string }

async function readRecords(io: V2StoreIo, repo: string): Promise<RecordsRead> {
  const key = recordsKey(repo)
  let raw: unknown
  try {
    raw = await io.get(key)
  } catch (err) {
    return { ok: false, error: `${key} could not be read: ${message(err)}` }
  }
  if (raw === undefined || raw === null) return { ok: true, records: null }
  const records = recordsFromStore(raw)
  return records === null ? { ok: false, error: `${key} holds no stored records: fix or remove it` } : { ok: true, records }
}

async function readHeads(io: V2StoreIo, repo: string): Promise<Record<string, HeadSeen> | null> {
  try {
    return headsFromStore(await io.get(headsKey(repo)))
  } catch {
    // the heads only bound waits: a failed read starts them afresh
    return null
  }
}

// loadV2: the store's records and heads into the live copy, with the ledger (whose lease keeps
// them too) and again on any pass while they are not loaded.
export async function loadV2(live: V2Live, io: V2StoreIo, repo: string): Promise<void> {
  const read = await readRecords(io, repo)
  live.repo = repo
  live.heads = await readHeads(io, repo)
  if (!read.ok) {
    live.records = []
    live.absent = false
    live.loaded = false
    live.error = read.error
    return
  }
  live.records = read.records ?? []
  live.absent = read.records === null
  live.loaded = true
  live.error = null
}

// storedV2: what an acting pass hands observe: the live copy, loaded again when it is not.
export async function storedV2(live: V2Live, io: V2StoreIo, repo: string): Promise<V2Stored> {
  if (!live.loaded || live.repo !== repo) await loadV2(live, io, repo)
  if (!live.loaded) return { records: null, heads: live.heads, error: live.error ?? 'not loaded' }
  return { records: live.absent ? null : live.records, heads: live.heads, error: null }
}

// readStoredV2: what a pass that does not act hands observe: the store's, read and never written
// (2.3).
export async function readStoredV2(io: V2StoreIo, repo: string): Promise<V2Stored> {
  const read = await readRecords(io, repo)
  const heads = await readHeads(io, repo)
  return read.ok ? { records: read.records, heads, error: null } : { records: null, heads, error: read.error }
}

// keepV2: what a pass acting under planner v2 keeps of v2's reads: the records a lost store was
// rebuilt into, as the ledger's are (3.3), and the PR heads first seen (2.4). A shadow keeps
// nothing.
export async function keepV2(live: V2Live, heads: Record<string, HeadSeen> | null, state: State, keep: (key: string, value: unknown) => Promise<void>): Promise<void> {
  if (!live.loaded) return
  if (state.v2 !== undefined && state.v2.recordsFrom === 'events' && live.absent) {
    live.records = [...state.v2.records]
    live.absent = false
    await keep(recordsKey(state.repo), recordsToStore(live.records, state.now))
  }
  if (heads !== null && JSON.stringify(heads) !== JSON.stringify(live.heads ?? {})) {
    live.heads = heads
    await keep(headsKey(state.repo), headsToStore(heads))
  }
}

// What the driver gives v2IoOf: whether the ledger is loaded and this session may act on it, a
// write queued after every store write before it that runs only while this session may still write
// the store (false when it did not run, or threw), and the driver's ping.
export type V2IoDeps = {
  ready: () => boolean
  write: (save: () => Promise<void>) => Promise<boolean>
  ping: (why: string) => void
}

const UNCHANGED = { changed: false, saved: false } as const

// v2IoOf: the live records for the transition executor (4.6). A change is stored before it is
// kept in memory; one the store refused is kept nowhere and reported unchanged, as V2Io says.
export function v2IoOf(live: V2Live, io: V2StoreIo, deps: V2IoDeps): V2Io {
  return {
    records: () => live.records,
    updateRecords: async fn => {
      if (!live.loaded || !deps.ready()) return UNCHANGED
      const before = live.records
      const next = fn(before)
      if (next === null) return UNCHANGED
      const repo = live.repo
      const saved = await deps.write(async () => {
        if (!live.loaded || live.repo !== repo || live.records !== before) throw new Error('the records changed while the write waited')
        await io.set(recordsKey(repo), recordsToStore(next, await io.now()))
      })
      if (!saved) return UNCHANGED
      live.records = next
      live.absent = false
      return { changed: true, saved: true }
    },
    ping: deps.ping,
  }
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 3)}...` : text
}
