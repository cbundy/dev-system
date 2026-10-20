// The settings `/factory config set|unset` writes into the workspace config file (v2 SPEC 13.4.3): which
// keys the file may hold, how a typed key and value are checked (by loadConfig itself, so the op
// accepts exactly what the loader would), when a change applies, and the edit of the file's text.
// Pure: control.ts runs it over the file's read and write.
import { ATTEMPT_KEYS, COUNT_MAPS, DEFAULT_CONFIG, TIME_MAPS, loadConfig, parseDuration, shortDuration } from './config'
import type { Config } from './types'

// The workspace file's keys that are not settings: the plugin's options and the runtime's own.
// Every other key there is a setting, over the repo's file (v2 SPEC section 15: the workspace
// file may set any key and wins); answerTools, which answerChannel replaced (#561), is passed on
// only to be named as replaced.
export const RUNTIME_KEYS: readonly string[] = ['mode', 'repo', 'shadowDevice', 'runSource', 'checkout', 'poolSize', 'toolsDir', 'binDir']

// When a change to a key applies. runtime() (register.ts) reads the workspace file and the repo's
// every pass, and nothing below keeps a setting from an earlier pass (the settings cache holds the
// repo's file on origin, not a value of this one), so every key is next-pass; a key some module
// captured once at load would be marked `restart` here, with the reason beside it. A timeout is
// next-pass too, but an agent or wake already running keeps the one it took (effectText says so).
export type Effect = 'next-pass' | 'restart'
export const SETTING_EFFECT: Record<keyof Config | 'poolSize', Effect> = {
  mode: 'next-pass',
  shadowDevice: 'next-pass',
  readyLabel: 'next-pass',
  priorityLabel: 'next-pass',
  inDevLabel: 'next-pass',
  skipLabels: 'next-pass',
  trackerTitle: 'next-pass',
  usageSlowPct: 'next-pass',
  usageStopNewPct: 'next-pass',
  usageStopAllPct: 'next-pass',
  // the timer is re-armed when it changes (register.ts rearm)
  passEveryMs: 'next-pass',
  titleEveryMs: 'next-pass',
  reportEveryMs: 'next-pass',
  queueEveryMs: 'next-pass',
  githubEveryMs: 'next-pass',
  usageEveryMs: 'next-pass',
  milestoneEveryMs: 'next-pass',
  usageStaleMs: 'next-pass',
  heartbeatEveryMs: 'next-pass',
  sweepEveryMs: 'next-pass',
  checkoutEveryMs: 'next-pass',
  slowGapMs: 'next-pass',
  maxStartsPerPass: 'next-pass',
  maxInFlightIssues: 'next-pass',
  worktreeReserve: 'next-pass',
  reviewFixCap: 'next-pass',
  conflictFixCap: 'next-pass',
  guardRecheckMs: 'next-pass',
  guardTtlMs: 'next-pass',
  respondSettleMs: 'next-pass',
  updateBehindRetryMs: 'next-pass',
  updateBehindRetries: 'next-pass',
  ciStallRecheckMs: 'next-pass',
  blindNoticeAfterMs: 'next-pass',
  starvedNoticeAfterMs: 'next-pass',
  agentTimeoutMs: 'next-pass',
  wakeTimeoutMs: 'next-pass',
  maxAttempts: 'next-pass',
  retryBackoffMs: 'next-pass',
  rateCaps: 'next-pass',
  queueScore: 'next-pass',
  allowActOutsideOrchestrator: 'next-pass',
  trace: 'next-pass',
  traceMaxBytes: 'next-pass',
  answerChannel: 'next-pass',
  eventsSource: 'next-pass',
  stateTimeoutMs: 'next-pass',
  ciStartMs: 'next-pass',
  ciRunMs: 'next-pass',
  prEveryMs: 'next-pass',
  mainEveryMs: 'next-pass',
  maxTriages: 'next-pass',
  windDownMinutes: 'next-pass',
  minimumReleaseCadenceMs: 'next-pass',
  releaseBranchPrefix: 'next-pass',
  releaseHoldMs: 'next-pass',
  releaseInProgressMs: 'next-pass',
  flakeWindowDays: 'next-pass',
  flakeBugMin: 'next-pass',
  flakeBugReadyCap: 'next-pass',
  flakeEpic: 'next-pass',
  maxLives: 'next-pass',
  triageModel: 'next-pass',
  reviewer: 'next-pass',
  reviewerModel: 'next-pass',
  gateCommands: 'next-pass',
  gateTimeoutMs: 'next-pass',
  gateConcurrency: 'next-pass',
  gateWaitTimeoutMs: 'next-pass',
  // runtime() reads it from the workspace file every pass
  poolSize: 'next-pass',
}

// The keys that have an op of their own, and which op. `set` refuses them, so the plugin option,
// and the runtime key keep one path.
// the pool size runtime() uses when the workspace file sets none
export const DEFAULT_POOL_SIZE = 16

const OWN_OP: Record<string, string> = {
  mode: 'mode off|observe|act',
  trace: 'trace on|off',
}

const MAPS: readonly string[] = [...TIME_MAPS, ...COUNT_MAPS]
const TIME: readonly string[] = TIME_MAPS

export type Checked = { ok: true; key: string; fileKey: string; sub: string | null; value: unknown } | { ok: false; error: string }

// the value text as JSON when it parses (3, true, null, ["npm test"]), else the plain string (6h)
export function valueOfText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// keyOf: a typed key as the canonical Config key and the spelling to write: `passEvery` is
// passEveryMs written as typed; `stateTimeout.design` is stateTimeoutMs, sub `design`.
export function keyOf(typed: string): { key: string; fileKey: string; sub: string | null } | null {
  const dot = typed.indexOf('.')
  const fileKey = dot < 0 ? typed : typed.slice(0, dot)
  const sub = dot < 0 ? null : typed.slice(dot + 1)
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>
  const key = fileKey === 'poolSize' || fileKey in defaults ? fileKey : `${fileKey}Ms` in defaults ? `${fileKey}Ms` : null
  return key === null || sub === '' ? null : { key, fileKey, sub }
}

// checkKey: the typed key alone (unset); checkSetting: a key and value typed by the owner, checked by loadConfig alone on a candidate
// file holding just that entry. Any problem, or an unknown key, refuses it with the loader's text.
export function checkKey(typed: string): Checked {
  const k = keyOf(typed)
  const bare = typed.split('.')[0] ?? typed
  if (bare in OWN_OP) return { ok: false, error: `${bare} has its own op: /factory ${OWN_OP[bare]}. Not changed.` }
  if (RUNTIME_KEYS.includes(bare) && bare !== 'poolSize') return { ok: false, error: `${bare} is a plugin option or runtime key, not a setting. Not changed.` }
  if (k === null) return { ok: false, error: `${typed}: unknown setting. Not changed.` }
  const isMap = MAPS.includes(k.key)
  if (isMap && k.sub === null) return { ok: false, error: `${typed}: name one entry, as ${k.fileKey}.<name>. Not changed.` }
  if (!isMap && k.sub !== null) return { ok: false, error: `${typed}: ${k.fileKey} has no entries. Not changed.` }
  if (k.sub !== null) {
    const known = k.key === 'maxAttempts' ? (ATTEMPT_KEYS as readonly string[]) : Object.keys((DEFAULT_CONFIG as unknown as Record<string, object>)[k.key] ?? {})
    if (!known.includes(k.sub)) return { ok: false, error: `${typed}: unknown entry. Not changed.` }
  }
  return { ok: true, ...k, value: undefined }
}

export function checkSetting(typed: string, value: unknown): Checked {
  const keyed = checkKey(typed)
  if (!keyed.ok) return keyed
  const k = keyed
  if (k.key === 'poolSize') {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return { ok: true, ...k, value }
    return { ok: false, error: `poolSize: ${JSON.stringify(value)} is not a whole number of at least 1. Not changed.` }
  }
  const candidate = k.sub === null ? { [k.fileKey]: value } : { [k.fileKey]: { [k.sub]: value } }
  const problems = loadConfig(candidate).problems
  if (problems.length > 0) return { ok: false, error: `${problems.join('; ')}. Not changed.` }
  return { ok: true, ...k, value }
}

// effectText: when a change to the key applies, from the table (a stub table in a test).
export function effectText(key: string, table: Record<string, Effect> = SETTING_EFFECT): string {
  if (table[key] === 'restart') return "after the loop's process restarts"
  return TIME.includes(key) && key !== 'stateTimeoutMs' ? 'from the next pass, to new work' : 'from the next pass'
}

// shown: a setting's value as the answer names it
export function shown(key: string, value: unknown): string {
  if (typeof value === 'number' && key.endsWith('Ms')) return shortDuration(value)
  if (value === null) return 'no cap'
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}

// valueIn: the value of a canonical key (and sub-key) in a loaded config
export function valueIn(config: Config | { poolSize: number }, key: string, sub: string | null): unknown {
  const v = (config as unknown as Record<string, unknown>)[key]
  return sub === null ? v : (v as Record<string, unknown> | undefined)?.[sub]
}

export type Edited = { ok: true; text: string; changed: boolean } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// editSetting: the workspace file's text with one setting set (value given) or removed (value
// undefined), every other key kept. A set of an Ms key writes the spelling typed and drops the
// other; a map entry merges into the object, and the last entry's removal drops the object. A file
// that is not a JSON object is left alone.
export function editSetting(text: string | null, k: { key: string; fileKey: string; sub: string | null }, value: unknown): Edited {
  let raw: unknown = {}
  if (text !== null && text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, error: 'the workspace config file is not valid JSON' }
    }
  }
  if (!isObject(raw)) return { ok: false, error: 'the workspace config file is not a JSON object' }
  const out: Record<string, unknown> = { ...raw }
  const names = k.key.endsWith('Ms') ? [k.key, k.key.slice(0, -2)] : [k.key]
  let changed = false
  if (k.sub === null) {
    for (const name of names) {
      if (name in out && (value === undefined || name !== k.fileKey)) {
        delete out[name]
        changed = true
      }
    }
    if (value !== undefined) {
      changed = changed || JSON.stringify(raw[k.fileKey]) !== JSON.stringify(value)
      out[k.fileKey] = value
    }
  } else {
    const sub = k.sub
    // both spellings' entries, the typed spelling's over the other's
    const merged: Record<string, unknown> = {}
    for (const name of [...names].reverse()) {
      const inner = out[name]
      if (isObject(inner)) Object.assign(merged, inner)
      delete out[name]
    }
    if (value === undefined) {
      changed = sub in merged
      delete merged[sub]
    } else {
      changed = JSON.stringify(raw[k.fileKey] !== undefined && isObject(raw[k.fileKey]) ? (raw[k.fileKey] as Record<string, unknown>)[sub] : undefined) !== JSON.stringify(value)
      merged[sub] = value
    }
    // the Ms spelling takes numbers only: an entry moved there from the short spelling keeps its meaning in ms
    if (k.fileKey === k.key) {
      for (const [name, v] of Object.entries(merged)) {
        const ms = typeof v === 'string' ? parseDuration(v) : null
        if (ms !== null) merged[name] = ms
      }
    }
    if (Object.keys(merged).length > 0) out[k.fileKey] = merged
  }
  return { ok: true, text: JSON.stringify(out, null, 2) + '\n', changed }
}

// withoutSetting: the workspace file's settings with the key (both spellings) or entry removed, as an
// unset leaves them: what the loader then reads.
export function withoutSetting(workspaceRaw: Record<string, unknown>, k: { key: string; fileKey: string; sub: string | null }): Record<string, unknown> {
  const edited = editSetting(JSON.stringify(workspaceRaw), k, undefined)
  return edited.ok ? (JSON.parse(edited.text) as Record<string, unknown>) : workspaceRaw
}
