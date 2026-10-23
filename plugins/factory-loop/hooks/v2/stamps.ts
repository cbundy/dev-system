// The intake stamps (docs/factory-loop/v2/SPEC.md 2.4, 13.4, epic #995): what the intake step stamped on
// an issue's body, kept in the store under stamps:<repo> as { v: 1, stamps: { "<issue>": Stamp },
// tries?: { "<issue>": Try }, owned?: { "<issue>": Group[] } }. The reader here is pure and checks every
// field; the writer is the intake run (v2/act-intake.ts) alone, through the pure functions below
// (withTry, withStamp, withOwned) over the value as the store holds it, so an unknown top-level key
// survives a write (updateStamps, store.ts). An absent, unreadable or malformed key is the empty store,
// and an entry that does not read is dropped, so a bad stamp never scores and a bad try never blocks.
//
// - stamps: the last ok stamp of the issue (its body version, area, needs_owner, touches, and the
//   label names the loop set from it).
// - tries: the newest body version tried, and how it went: running from the moment the run is
//   recorded (before the reader is spawned), then ok, dropped or failed. A version tried is never
//   tried again, whatever its outcome; an edited body is a new version.
// - owned: the label groups the owner has taken over on an issue ('area', 'needs-decision'); the loop
//   never touches a group again once it is owned.
import type { Ms } from '../types'

// version: the body version a later child stamps; area: one of config.intakeAreas; needsOwner: the
// issue waits on a decision; touches: the paths it expects to change; at: when it was stamped;
// labels: the label names the loop last set from it.
export type Stamp = { version: string; area: string; needsOwner: boolean; touches: string[]; at: Ms; labels: string[] }
export type Stamps = Record<string, Stamp>

export const stampsKey = (repo: string) => `stamps:${repo}`

// a reader that has not ended its turn by then is reported as failed, once (the dry run, v2/intake.ts), or its
// try is settled failed (rule I1, v2/rules-intake.ts)
export const STAMP_TIMEOUT_MS = 10 * 60_000

// How one try of one body version stands: running until its run ended or was settled.
export const TRY_OUTCOMES = ['running', 'ok', 'dropped', 'failed'] as const
export type TryOutcome = (typeof TRY_OUTCOMES)[number]
// reason: why a failed try failed (timeout, lost, spawn-failed, ...); absent otherwise.
export type StampTry = { version: string; outcome: TryOutcome; at: Ms; reason?: string }
export type StampTries = Record<string, StampTry>

// The label groups the loop sets from a stamp, each owned by the loop or taken over by the owner.
export const LABEL_GROUPS = ['area', 'needs-decision'] as const
export type LabelGroup = (typeof LABEL_GROUPS)[number]
export type StampOwned = Record<string, LabelGroup[]>

// Everything the key holds, as the readers give it.
export type StampStore = { stamps: Stamps; tries: StampTries; owned: StampOwned }
export const EMPTY_STAMP_STORE: StampStore = { stamps: {}, tries: {}, owned: {} }

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string')

function stampOf(raw: unknown): Stamp | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const { version, area, needsOwner, touches, at, labels } = o
  if (typeof version !== 'string' || version === '' || typeof area !== 'string' || typeof needsOwner !== 'boolean') return null
  if (!isStrings(touches) || !isStrings(labels) || typeof at !== 'number' || !Number.isFinite(at)) return null
  return { version, area, needsOwner, touches: [...touches], at, labels: [...labels] }
}

function tryOf(raw: unknown): StampTry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { version, outcome, at, reason } = raw as Record<string, unknown>
  if (typeof version !== 'string' || version === '' || !(TRY_OUTCOMES as readonly unknown[]).includes(outcome) || typeof at !== 'number' || !Number.isFinite(at)) return null
  if (reason !== undefined && typeof reason !== 'string') return null
  return { version, outcome: outcome as TryOutcome, at, ...(reason === undefined ? {} : { reason }) }
}

const isIssueKey = (k: string) => /^[1-9][0-9]*$/.test(k)
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

// stampsFromStore: the stamps stamps:<repo> holds, each checked field by field; {} for a value that
// is not the store (absent, not an object, another version).
export function stampsFromStore(raw: unknown): Stamps {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || o.stamps === null || typeof o.stamps !== 'object' || Array.isArray(o.stamps)) return {}
  const out: Stamps = {}
  for (const [issue, value] of Object.entries(o.stamps as Record<string, unknown>)) {
    const stamp = /^[1-9][0-9]*$/.test(issue) ? stampOf(value) : null
    if (stamp !== null) out[issue] = stamp
  }
  return out
}

// triesFromStore: the tries the key holds, each checked field by field; {} when there are none.
export function triesFromStore(raw: unknown): StampTries {
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.tries)) return {}
  const out: StampTries = {}
  for (const [issue, value] of Object.entries(raw.tries)) {
    const t = isIssueKey(issue) ? tryOf(value) : null
    if (t !== null) out[issue] = t
  }
  return out
}

// ownedFromStore: the owned groups the key holds; a name that is no group is dropped, an issue left
// with none is dropped.
export function ownedFromStore(raw: unknown): StampOwned {
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.owned)) return {}
  const out: StampOwned = {}
  for (const [issue, value] of Object.entries(raw.owned)) {
    if (!isIssueKey(issue) || !Array.isArray(value)) continue
    const groups = LABEL_GROUPS.filter(g => value.includes(g))
    if (groups.length > 0) out[issue] = [...groups]
  }
  return out
}

// stampStoreFromStore: all three of the key's maps.
export const stampStoreFromStore = (raw: unknown): StampStore => ({ stamps: stampsFromStore(raw), tries: triesFromStore(raw), owned: ownedFromStore(raw) })

// readStampStore: the key's stamps, tries and owned groups; empty when the read throws.
export async function readStampStore(io: { get: (key: string) => Promise<unknown> }, repo: string): Promise<StampStore> {
  try {
    return stampStoreFromStore(await io.get(stampsKey(repo)))
  } catch {
    return EMPTY_STAMP_STORE
  }
}

// The writers: each returns the whole value to store, the old one with one issue's entry set. Keys
// this module does not know are carried over as they are; what is not the store (absent, not an
// object, another version) starts a new one. Nothing is mutated.
function setIn(raw: unknown, field: 'stamps' | 'tries' | 'owned', issue: number, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(raw) && raw.v === 1 ? { ...raw } : { v: 1 }
  // the key always holds `stamps`, as the readers before the writer expect
  if (!isObject(out.stamps)) out.stamps = {}
  const was = out[field]
  out[field] = { ...(isObject(was) ? was : {}), [String(issue)]: value }
  return out
}

// withTry: the try of an issue's body version recorded (it replaces the issue's earlier try).
export const withTry = (raw: unknown, issue: number, t: StampTry): Record<string, unknown> => setIn(raw, 'tries', issue, t)
// withStamp: the issue's stamp recorded.
export const withStamp = (raw: unknown, issue: number, stamp: Stamp): Record<string, unknown> => setIn(raw, 'stamps', issue, stamp)
// withOwned: the issue's owned groups recorded; the union of what was owned and `groups`.
export function withOwned(raw: unknown, issue: number, groups: readonly LabelGroup[]): Record<string, unknown> {
  const was = ownedFromStore(raw)[String(issue)] ?? []
  return setIn(raw, 'owned', issue, LABEL_GROUPS.filter(g => was.includes(g) || groups.includes(g)))
}

// readStamps: the store's stamps; {} when the read throws, since a stamp only ever adds to a score.
export async function readStamps(io: { get: (key: string) => Promise<unknown> }, repo: string): Promise<Stamps> {
  try {
    return stampsFromStore(await io.get(stampsKey(repo)))
  } catch {
    return {}
  }
}
