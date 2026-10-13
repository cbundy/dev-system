// Default settings (SPEC 4.2), and the pure loaders for the settings files and the control
// state. The repo-local .claude/factory-loop.json overrides any setting; the plugin ships no
// repo-specific values. Types only are imported, so plan.ts and the replay can use this too.
import type { ActionKind, AgentType, Config, Control, Ms } from './types'

const MIN = 60_000

export const DEFAULT_CONFIG: Config = {
  mode: 'observe',
  shadowDevice: null,
  readyLabel: 'ready',
  // labels are lower case for now and compared without regard to case (owner, 2026-10-13)
  inDevLabel: 'in development',
  skipLabels: [],
  trackerTitle: '^(Epic|Tracker)\\b',
  usageSlowPct: 85,
  usageStopNewPct: 90,
  usageStopAllPct: 95,
  passEveryMs: 60_000,
  queueEveryMs: 2 * MIN,
  githubEveryMs: 5 * MIN,
  usageEveryMs: 5 * MIN,
  milestoneEveryMs: 10 * MIN,
  usageStaleMs: 15 * MIN,
  heartbeatEveryMs: 20 * MIN,
  sweepEveryMs: 30 * MIN,
  slowGapMs: 10 * MIN,
  maxStartsPerPass: 4,
  maxInFlightIssues: 5,
  worktreeReserve: 2,
  reviewFixCap: 3,
  guardRecheckMs: 3 * MIN,
  guardTtlMs: 30 * MIN,
  respondSettleMs: 15 * MIN,
  updateBehindRetryMs: 5 * MIN,
  updateBehindRetries: 3,
  ciStallRecheckMs: 15 * MIN,
  blindNoticeAfterMs: 15 * MIN,
  agentTimeoutMs: { designer: 60 * MIN, implementer: 120 * MIN, adjudicator: 30 * MIN, fixer: 120 * MIN },
  wakeTimeoutMs: { judge: 30 * MIN, task: 360 * MIN, tell: 30 * MIN },
  maxAttempts: {
    claim: 3,
    designer: 2,
    implementer: 2,
    adjudicator: 2,
    fixer: 2,
    respond: 2,
    merge: 2,
    'fix-linkage': 2,
    guard: 3,
    // heartbeat and sweep are never used up (they retry at their cadence, SPEC 6.1): this many
    // failures in a row tells the owner once
    heartbeat: 3,
    sweep: 3,
    // a restart is tried once; the owner hears if it fails (SPEC 6.1)
    'restart-self': 1,
    // SPEC 6.1: a close and reopen once, a stop once, a slot's return twice
    'pr-reopen': 1,
    'stop-agent': 1,
    'release-worktree': 2,
    // a wake is asked once (with one reminder inside the attempt); then its fallback holds
    judge: 1,
    task: 1,
    tell: 1,
  },
  retryBackoffMs: 2 * MIN,
  rateCaps: { start: 30, spawn: 120, wake: 20, perIssueKind: 6 },
  allowActOutsideOrchestrator: false,
}

export const EMPTY_CONTROL: Control = {
  paused: [],
  noNewWork: false,
  skip: [],
  priority: [],
  only: [],
  serial: false,
  usageOverride: null,
  updateDue: null,
  resumed: [],
  dropped: [],
  notes: [],
}

// --- the settings files (SPEC 4.2) -------------------------------------------------------

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: MIN, h: 60 * MIN, d: 24 * 60 * MIN }

// parseDuration: "500ms", "60s", "5m", "2h" or "1d" in milliseconds; null for anything else.
export function parseDuration(text: string): Ms | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(text)
  const unit = m?.[2] === undefined ? undefined : UNITS[m[2]]
  return m?.[1] === undefined || unit === undefined ? null : Math.round(Number(m[1]) * unit)
}

// Every action kind, for the loaders that read one from text (SPEC 6.1).
export const ACTION_KINDS: readonly ActionKind[] = [
  'heartbeat', 'sweep', 'claim', 'spawn', 'delegate', 'respond', 'guard', 'update-behind', 'fix-linkage', 'merge',
  'close-issue', 'release-parent', 'abandon', 'milestone-later', 'milestone-expect', 'pr-reopen', 'pr-comment',
  'release-worktree', 'restart-self', 'rollout', 'stop-agent', 'judge', 'task', 'tell', 'title',
]
// maxAttempts may name any action kind or agent type.
const ATTEMPT_KEYS: readonly (ActionKind | AgentType)[] = [...ACTION_KINDS, 'designer', 'implementer', 'adjudicator', 'fixer']
const TIME_MAPS = ['agentTimeoutMs', 'wakeTimeoutMs'] as const
const COUNT_MAPS = ['maxAttempts', 'rateCaps'] as const

export type LoadedConfig = { config: Config; problems: string[] }

// loadConfig: DEFAULT_CONFIG with each raw JSON object layered over it, in order. A time
// setting takes a duration string under its key with "Ms" dropped (`passEvery: "60s"`), or a
// number of milliseconds under either spelling; the agentTimeout and wakeTimeout maps likewise,
// per entry. An unknown key or a bad value is left out and named in `problems`, for the
// decision log (owner, 2026-10-13).
export function loadConfig(...layers: unknown[]): LoadedConfig {
  const d = DEFAULT_CONFIG
  const out: Record<string, unknown> = {
    ...d,
    skipLabels: [...d.skipLabels],
    agentTimeoutMs: { ...d.agentTimeoutMs },
    wakeTimeoutMs: { ...d.wakeTimeoutMs },
    maxAttempts: { ...d.maxAttempts },
    rateCaps: { ...d.rateCaps },
  }
  const defaults = d as unknown as Record<string, unknown>
  const problems: string[] = []
  const bad = (key: string, value: unknown, want: string) => problems.push(`${key}: ${JSON.stringify(value) ?? String(value)} is not ${want}`)
  const ms = (key: string, value: unknown, short: boolean): number | null => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    const parsed = short && typeof value === 'string' ? parseDuration(value) : null
    if (parsed === null) bad(key, value, short ? 'a duration (like 60s, 5m, 2h)' : 'a number of milliseconds')
    return parsed
  }

  for (const layer of layers) {
    if (layer === undefined || layer === null) continue
    if (typeof layer !== 'object' || Array.isArray(layer)) {
      problems.push('settings: not a JSON object')
      continue
    }
    for (const [raw, value] of Object.entries(layer)) {
      const short = !(raw in defaults) && `${raw}Ms` in defaults
      const key = short ? `${raw}Ms` : raw
      const base = defaults[key]
      if (!(key in defaults)) {
        problems.push(`${raw}: unknown setting`)
      } else if ((TIME_MAPS as readonly string[]).includes(key) || (COUNT_MAPS as readonly string[]).includes(key)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          bad(raw, value, 'an object')
          continue
        }
        const target = out[key] as Record<string, number>
        const known = key === 'maxAttempts' ? (ATTEMPT_KEYS as readonly string[]) : Object.keys(base as object)
        for (const [sub, v] of Object.entries(value)) {
          const name = `${raw}.${sub}`
          if (!known.includes(sub)) {
            problems.push(`${name}: unknown${key === 'rateCaps' && sub === 'merge' ? ' (merges are never capped)' : ''}`)
          } else if ((TIME_MAPS as readonly string[]).includes(key)) {
            const n = ms(name, v, short)
            if (n !== null) target[sub] = n
          } else if (typeof v === 'number' && Number.isInteger(v) && v >= (key === 'maxAttempts' ? 1 : 0)) {
            target[sub] = v
          } else {
            bad(name, v, key === 'maxAttempts' ? 'a whole number of at least 1' : 'a whole number')
          }
        }
      } else if (key.endsWith('Ms') && typeof base === 'number') {
        const n = ms(raw, value, short)
        if (n !== null) out[key] = n
      } else if (key === 'mode') {
        if (value === 'off' || value === 'observe' || value === 'act') out[key] = value
        else bad(raw, value, 'off, observe or act')
      } else if (key === 'shadowDevice') {
        if (value === null || typeof value === 'string') out[key] = value
        else bad(raw, value, 'a device name or null')
      } else if (key === 'maxInFlightIssues') {
        if (value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) out[key] = value
        else bad(raw, value, 'a whole number or null')
      } else if (key === 'skipLabels') {
        if (Array.isArray(value) && value.every(v => typeof v === 'string')) out[key] = [...value]
        else bad(raw, value, 'a list of labels')
      } else if (key === 'trackerTitle') {
        if (typeof value === 'string' && compiles(value)) out[key] = value
        else bad(raw, value, 'a regular expression')
      } else if (typeof base === 'string') {
        if (typeof value === 'string' && value !== '') out[key] = value
        else bad(raw, value, 'a non-empty string')
      } else if (typeof base === 'boolean') {
        if (typeof value === 'boolean') out[key] = value
        else bad(raw, value, 'true or false')
      } else if (typeof base === 'number') {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
        else bad(raw, value, 'a number')
      }
    }
  }
  return { config: out as unknown as Config, problems }
}

function compiles(pattern: string) {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

// --- the control state (SPEC 4.3) ----------------------------------------------------------

// controlFrom: control.json's parsed contents as Control, field by field: a missing or
// malformed field takes its empty value, and a malformed list item is dropped, so one bad
// directive never voids the others.
export function controlFrom(raw: unknown): Control {
  const o = record(raw) ?? {}
  const issues = (v: unknown) => (Array.isArray(v) ? v.filter(isIssue) : [])
  const at = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const items = (v: unknown) => (Array.isArray(v) ? v.map(record).filter(r => r !== null) : [])
  const override = record(o.usageOverride)
  const update = record(o.updateDue)
  return {
    paused: issues(o.paused),
    noNewWork: o.noNewWork === true,
    skip: issues(o.skip),
    priority: issues(o.priority),
    only: issues(o.only),
    serial: o.serial === true,
    usageOverride:
      override !== null && at(override.untilPct) && at(override.expiresAt) ? { untilPct: override.untilPct, expiresAt: override.expiresAt } : null,
    updateDue: update !== null && at(update.at) ? { reason: typeof update.reason === 'string' ? update.reason : '', at: update.at } : null,
    resumed: items(o.resumed).flatMap(r => (typeof r.subject === 'string' && at(r.at) ? [{ subject: r.subject, at: r.at }] : [])),
    dropped: items(o.dropped).flatMap(r => (isIssue(r.issue) && at(r.at) ? [{ issue: r.issue, at: r.at }] : [])),
    notes: items(o.notes).flatMap(r =>
      typeof r.text === 'string' && at(r.at) && (r.issue === undefined || r.issue === null || isIssue(r.issue))
        ? [{ issue: isIssue(r.issue) ? r.issue : null, text: r.text, at: r.at }]
        : [],
    ),
  }
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function isIssue(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}
