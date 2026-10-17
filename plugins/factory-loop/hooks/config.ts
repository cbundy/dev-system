// Default settings (SPEC 4.2), and the pure loaders for the settings files and the control
// state. The repo-local .claude/factory-loop.json overrides any setting; the plugin ships no
// repo-specific values. Types only are imported, so plan.ts and the replay can use this too, and
// v2's vocabulary (v2/types.ts), which holds constants alone.
import type { ActionKind, AgentType, AnswerChannel, Config, Control, Ms } from './types'
import { MODELS, PLANNERS, SHADOWS, V2_ACTION_KINDS } from './v2/types'

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
  titleEveryMs: 5 * MIN,
  queueEveryMs: 2 * MIN,
  githubEveryMs: 5 * MIN,
  usageEveryMs: 5 * MIN,
  milestoneEveryMs: 10 * MIN,
  usageStaleMs: 15 * MIN,
  heartbeatEveryMs: 20 * MIN,
  sweepEveryMs: 30 * MIN,
  checkoutEveryMs: 5 * MIN,
  slowGapMs: 10 * MIN,
  maxStartsPerPass: 4,
  maxInFlightIssues: 5,
  worktreeReserve: 2,
  reviewFixCap: 3,
  guardRecheckMs: 3 * MIN,
  // a backstop: a repair re-guards at once, and a failure is judged once (#550)
  guardTtlMs: 5 * MIN,
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
    'fast-forward': 2,
    // heartbeat, sweep and update-checkout are never used up (they retry at their cadence, SPEC
    // 6.1): this many failures in a row tells the owner once
    heartbeat: 3,
    sweep: 3,
    'update-checkout': 3,
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
    // v2 (appendix B): a step key is one attempt, the table retries steps (v2 SPEC 5.1); an
    // update and a merge are one per key; a CI re-run's call three, with backoff, since one that
    // failed on a transient error re-ran nothing (8.5); effects keep the default 3, and a slot op
    // and a CI re-run carry their own caps on their actions
    'agent-step': 1,
    'ci-rerun': 3,
    'queue-update': 1,
    'queue-merge': 1,
  },
  retryBackoffMs: 2 * MIN,
  rateCaps: { start: 30, spawn: 120, wake: 20, perIssueKind: 6 },
  allowActOutsideOrchestrator: false,
  // off: the decision log alone carries each pass's time and trigger (#552)
  trace: false,
  // 100 MiB in all (owner, #552)
  traceMaxBytes: 100 * 1024 * 1024,
  // script: a TEMPORARY WORKAROUND (#561, D-74). The registered answer tools (`tool`, #548) are
  // the intended channel, but on Claude Code 2.1.296 and 2.1.299 an agent spawned from the loop's
  // timer never reaches the loop's tool hook (#560, SPEC 13), while Bash works: agents record
  // their answer with bin/factory-answer, checked by the same contract. Set it back to `tool`
  // once the probe shows a timer-spawned agent reaching the tool hook.
  answerChannel: 'script',
  // v2 (v2 SPEC appendix A): v1 plans until cutover; the shadow is off
  planner: 'v1',
  shadow: 'off',
  stateTimeoutMs: {
    design: 45 * MIN,
    build: 90 * MIN,
    review: 30 * MIN,
    fix: 60 * MIN,
    triage: 15 * MIN,
    queued: 6 * 60 * MIN,
    queueWait: 2 * 60 * MIN,
    parked: 24 * 60 * MIN,
  },
  ciStartMs: 10 * MIN,
  ciRunMs: 30 * MIN,
  prEveryMs: 30_000,
  maxTriages: 2,
  maxLives: 3,
  triageModel: 'opus',
  reviewer: 'adjudicator',
  reviewerModel: 'opus',
  // the plugin ships no repo's commands: a repo sets its own (dev-system: npm run lint, npm test)
  gateCommands: [],
  gateTimeoutMs: 10 * MIN,
}

// The defaults that differ under planner v2, for a key no settings file sets: K is 3 (v2 SPEC
// section 15; v1's stays 5).
export const V2_DEFAULTS: Readonly<Pick<Config, 'maxInFlightIssues'>> = { maxInFlightIssues: 3 }

export const ANSWER_CHANNELS: readonly AnswerChannel[] = ['script', 'tool', 'text']

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

// shortDuration: milliseconds as the shortest exact "2h", "5m" or "60s" parseDuration reads back.
export function shortDuration(ms: Ms): string {
  if (ms > 0 && ms % (60 * MIN) === 0) return `${ms / (60 * MIN)}h`
  if (ms > 0 && ms % MIN === 0) return `${ms / MIN}m`
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

// Every action kind, for the loaders that read one from text (SPEC 6.1).
export const ACTION_KINDS: readonly ActionKind[] = [
  'heartbeat', 'sweep', 'claim', 'spawn', 'delegate', 'respond', 'env-retry', 'guard', 'update-behind', 'fast-forward',
  'update-checkout', 'fix-linkage', 'merge', 'close-issue', 'release-parent', 'abandon', 'milestone-later', 'milestone-expect',
  'pr-reopen', 'pr-comment', 'pr-close', 'release-worktree', 'restart-self', 'rollout', 'stop-agent', 'judge', 'task', 'tell', 'title',
  ...V2_ACTION_KINDS,
]
// maxAttempts may name any action kind or agent type.
const ATTEMPT_KEYS: readonly (ActionKind | AgentType)[] = [...ACTION_KINDS, 'designer', 'implementer', 'adjudicator', 'fixer']
const TIME_MAPS = ['agentTimeoutMs', 'wakeTimeoutMs', 'stateTimeoutMs'] as const
const COUNT_MAPS = ['maxAttempts', 'rateCaps'] as const

// v2: the settings v2 runs with, from the same layers: config itself under planner v2; under v1,
// V2_DEFAULTS on every key no layer set, which the v2 shadow plans with (v2 SPEC 2.3).
export type LoadedConfig = { config: Config; problems: string[]; v2: Config }

// jsonObject: a settings file's text as an object; {} for no file, or one that does not read.
export function jsonObject(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = raw === null ? {} : JSON.parse(raw)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// loadConfig: DEFAULT_CONFIG with each raw JSON object layered over it, in order. A time
// setting takes a duration string under its key with "Ms" dropped (`passEvery: "60s"`), or a
// number of milliseconds under either spelling; the agentTimeout and wakeTimeout maps likewise,
// per entry. An unknown key or a bad value is left out and named in `problems`, for the
// decision log (owner, 2026-10-13). Under planner v2 a key no layer sets takes V2_DEFAULTS'.
export function loadConfig(...layers: unknown[]): LoadedConfig {
  const d = DEFAULT_CONFIG
  const out: Record<string, unknown> = {
    ...d,
    skipLabels: [...d.skipLabels],
    agentTimeoutMs: { ...d.agentTimeoutMs },
    wakeTimeoutMs: { ...d.wakeTimeoutMs },
    stateTimeoutMs: { ...d.stateTimeoutMs },
    maxAttempts: { ...d.maxAttempts },
    rateCaps: { ...d.rateCaps },
    gateCommands: [...d.gateCommands],
  }
  // the V2_DEFAULTS keys a layer set to a value it takes
  const set = new Set<string>()
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
      if (raw === 'answerTools') {
        // #560's switch, replaced by answerChannel (#561) and not read
        problems.push('answerTools: replaced by answerChannel (script, tool or text), and ignored')
      } else if (!(key in defaults)) {
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
        if (value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
          out[key] = value
          set.add(key)
        } else bad(raw, value, 'a whole number or null')
      } else if (key === 'skipLabels') {
        if (Array.isArray(value) && value.every(v => typeof v === 'string')) out[key] = [...value]
        else bad(raw, value, 'a list of labels')
      } else if (key === 'gateCommands') {
        if (Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim() !== '')) out[key] = [...value]
        else bad(raw, value, 'a list of commands')
      } else if (key === 'planner') {
        if (PLANNERS.some(p => p === value)) out[key] = value
        else bad(raw, value, PLANNERS.join(' or '))
      } else if (key === 'shadow') {
        if (SHADOWS.some(p => p === value)) out[key] = value
        else bad(raw, value, SHADOWS.join(' or '))
      } else if (key.endsWith('Model')) {
        if (MODELS.some(m => m === value)) out[key] = value
        else bad(raw, value, `${MODELS.slice(0, -1).join(', ')} or ${MODELS.at(-1)}`)
      } else if (key === 'maxTriages') {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value
        else bad(raw, value, 'a whole number')
      } else if (key === 'maxLives') {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1) out[key] = value
        else bad(raw, value, 'a whole number of at least 1')
      } else if (key === 'answerChannel') {
        const channel = ANSWER_CHANNELS.find(c => c === value)
        if (channel !== undefined) out[key] = channel
        else bad(raw, value, 'script, tool or text')
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
  const v2: Record<string, unknown> = { ...out }
  for (const [key, value] of Object.entries(V2_DEFAULTS)) if (!set.has(key)) v2[key] = value
  const config = (out.planner === 'v2' ? v2 : out) as unknown as Config
  return { config, problems, v2: v2 as unknown as Config }
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
    resumed: items(o.resumed).flatMap(r =>
      typeof r.subject === 'string' && at(r.at) ? [typeof r.note === 'string' ? { subject: r.subject, at: r.at, note: r.note } : { subject: r.subject, at: r.at }] : [],
    ),
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
