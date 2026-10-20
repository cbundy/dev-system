// N1, the settings that changed (docs/factory-events/schemas/settings_changed.v1.json): the pass compares the
// snapshot of the settings in force now with the one the store kept, leaf by leaf, and logs one free
// `settings_changed` event for each leaf that differs, keyed by the leaf and the new snapshot's time, so a
// replayed pass logs it once. Pure: the snapshots come from the driver (driver-pass.ts), the config ops that
// landed since from the store (driver-controls.ts). No snapshot kept, or one that is not valid, plans nothing:
// the pass only stores the snapshot.
import { want, skip } from '../foundation'
import type { Snapshot } from '../settings-snapshot'
import type { SettingsChangedData } from './events'
import type { SettingsOp, V2Ctx } from './types'

// the most leaves one pass logs; the rest are named in a skip line
export const SETTINGS_FLOOD = 50

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// opsFrom: the stored config ops, the valid entries
export function opsFrom(raw: unknown): SettingsOp[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((o): SettingsOp[] =>
    isPlain(o) && typeof o.key === 'string' && (o.by === 'person' || o.by === 'judge') && typeof o.at === 'number' ? [{ key: o.key, by: o.by, at: o.at }] : [],
  )
}

// derivedLeaves: the derived values, an object expanded to `parent.sub` paths
function derivedLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlain(value)) for (const [k, v] of Object.entries(value)) derivedLeaves(v, `${prefix}.${k}`, out)
  else out.set(prefix, value ?? null)
}

// leavesOf: every leaf of a snapshot by key: the settings at the keys of its layers (the leafKeys of the config,
// an object-valued setting expanded, and the control's own), then `derived.*`. `at` and `problems` are no leaf.
export function leavesOf(s: Snapshot): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const key of Object.keys(s.layers)) {
    let v: unknown = s.settings[key]
    if (!(key in s.settings)) {
      v = s.settings
      for (const part of key.split('.')) v = isPlain(v) ? v[part] : undefined
    }
    out.set(key, v ?? null)
  }
  derivedLeaves(s.derived, 'derived', out)
  return out
}

export type Change = { key: string; old_value: unknown; new_value: unknown; layer: SettingsChangedData['layer'] }

// diffSnapshots: the leaves whose value differs (JSON equality), in key order of the new snapshot, then the removed
export function diffSnapshots(before: Snapshot, now: Snapshot): Change[] {
  const a = leavesOf(before)
  const b = leavesOf(now)
  const changes: Change[] = []
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const o = a.get(key) ?? null
    const n = b.get(key) ?? null
    if (JSON.stringify(o) === JSON.stringify(n)) continue
    const derived = key.startsWith('derived.')
    const layer = derived ? null : (now.layers[key] ?? before.layers[key] ?? null)
    changes.push({ key, old_value: o, new_value: n, layer })
  }
  return changes
}

// whoOf: who made the change, in order: the op that named the key since the previous snapshot, the layer and the plugin version
export function whoOf(c: Change, before: Snapshot, now: Snapshot, beforeAt: number, ops: readonly SettingsOp[]): SettingsChangedData['who'] {
  const since = beforeAt
  const op = ops.filter(o => o.key === c.key && o.at > since).sort((x, y) => y.at - x.at)[0]
  if (op !== undefined) return op.by
  if (c.layer === null) return 'plugin'
  if (c.layer === 'workspace' || c.layer === 'directive') return 'person'
  if (c.layer === 'repo') return 'repo'
  if (c.layer === 'default' && before.plugin_version !== now.plugin_version) return 'plugin'
  return 'person'
}

// settingsKey: the once key of a change
export const settingsKey = (key: string, at: number) => `settings/${key}/${at.toString(36)}`

export function settingsRules(ctx: V2Ctx): void {
  const s = ctx.v2.settings
  if (s === undefined || s.before === null || s.beforeAt === null) return
  const changes = diffSnapshots(s.before, s.now)
  for (const c of changes.slice(0, SETTINGS_FLOOD)) {
    const fact = settingsKey(c.key, s.nowAt)
    const data: SettingsChangedData = { ...c, who: whoOf(c, s.before, s.now, s.beforeAt, s.ops), fact }
    want(ctx, { kind: 'event', key: fact, class: 'free', rule: 'N1', reason: `setting ${c.key} changed`, issue: null, event: { state: 'settings_changed', data } })
  }
  if (changes.length > SETTINGS_FLOOD) skip(ctx, 'N1', null, `settings: ${changes.length} settings changed at once; the first ${SETTINGS_FLOOD} are logged, ${changes.length - SETTINGS_FLOOD} skipped`)
}
