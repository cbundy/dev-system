// The intake stamps (docs/factory-loop/v2/SPEC.md 2.4, epic #995): what the intake step stamped on an
// issue's body, kept in the store under stamps:<repo> as { v: 1, stamps: { "<issue>": Stamp } }. This
// module only reads them; nothing writes the key yet. An absent, unreadable or malformed key is the
// empty store, and an entry that does not read is dropped, so a bad stamp never scores.
import type { Ms } from '../types'

// version: the body version a later child stamps; area: one of config.intakeAreas; needsOwner: the
// issue waits on a decision; touches: the paths it expects to change; at: when it was stamped;
// labels: the label names the loop last set from it.
export type Stamp = { version: string; area: string; needsOwner: boolean; touches: string[]; at: Ms; labels: string[] }
export type Stamps = Record<string, Stamp>

export const stampsKey = (repo: string) => `stamps:${repo}`

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string')

function stampOf(raw: unknown): Stamp | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const { version, area, needsOwner, touches, at, labels } = o
  if (typeof version !== 'string' || version === '' || typeof area !== 'string' || typeof needsOwner !== 'boolean') return null
  if (!isStrings(touches) || !isStrings(labels) || typeof at !== 'number' || !Number.isFinite(at)) return null
  return { version, area, needsOwner, touches: [...touches], at, labels: [...labels] }
}

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

// readStamps: the store's stamps; {} when the read throws, since a stamp only ever adds to a score.
export async function readStamps(io: { get: (key: string) => Promise<unknown> }, repo: string): Promise<Stamps> {
  try {
    return stampsFromStore(await io.get(stampsKey(repo)))
  } catch {
    return {}
  }
}
