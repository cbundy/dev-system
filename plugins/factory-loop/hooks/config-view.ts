// `/factory config` (#698): the settings the loop runs with, grouped, each with where its value
// came from. Pure: it renders the Runtime the last pass used (viewOf) and the control state, and
// reads no file, so it shows what the pass runs with, not what the files say now.
import { budgetOf } from './spend'
import type { ApiKeySettings } from './spend'
import { GATE_CPUS, resolveGateConcurrency, shortDuration } from './config'
import type { Runtime } from './observe'
import { effectiveCap } from './v2/capacity'
import type { CapInfo } from './v2/capacity'
import type { GateLine } from './v2/sources-interventions'
import type { Config, Control, Ms } from './types'

// Where a value came from. plugin, env and directive are for the few values that have no settings
// layer: the plugin's options, the machine name, and control.json.
export type Source = 'default' | 'repo' | 'workspace' | 'plugin' | 'env' | 'directive'

// What runtime() adds to the Runtime for the view: the workspace file as read, the plugin's version.
export type ViewInputs = { workspaceRaw: Record<string, unknown>; pluginVersion: string; deviceFrom: Source }

// What the view needs of a pass's Runtime, with the parts a Runtime may lack filled in.
export type ConfigView = {
  config: Config
  device: string
  poolSize: number
  // the container's CPU count the loop read; undefined: not read (a test's, an older pass)
  cpus: number | undefined
  // the cap the loop holds to, with the container's memory and the slot estimate it came from
  cap: CapInfo
  repoRaw: Record<string, unknown>
  workspaceRaw: Record<string, unknown>
  problems: readonly string[]
  modeFrom: Source
  deviceFrom: Source
  pluginVersion: string
  // API-key mode: the budget settings the container's environment gave (spend.ts); absent: subscription
  apiKey?: ApiKeySettings
}

const WIDTH = 60
const LABEL = 16
const VALUE = 22

// clock: a time as HH:MM UTC, with the date when it is not today's.
export function clock(at: Ms, now: Ms): string {
  const iso = new Date(at).toISOString()
  const day = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? '' : `${iso.slice(0, 10)} `
  return `${day}${iso.slice(11, 16)} UTC`
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// the spellings a settings file may use for a key: `passEveryMs` is also `passEvery`
function spellings(key: string): string[] {
  return key.endsWith('Ms') ? [key, key.slice(0, -2)] : [key]
}

// sets: whether a layer sets the key; `parent.sub` looks into the parent's object
function sets(layer: Record<string, unknown>, key: string): boolean {
  const [parent = '', sub] = key.split('.')
  if (sub === undefined) return spellings(parent).some(name => name in layer)
  return spellings(parent).some(name => {
    const inner = layer[name]
    return isObject(inner) && sub in inner
  })
}

// layerRejected: whether a config problem rejected the value this layer holds for the key (or for
// its parent object). A problem reads `name: <JSON of the value> is not ...`, so the rejected layer
// is the one whose value, written as JSON, is the one the problem quotes.
function layerRejected(problems: readonly string[], layer: Record<string, unknown>, key: string): boolean {
  const [parent = '', sub] = key.split('.')
  return spellings(parent).some(name => {
    const mine = layer[name]
    if (mine === undefined) return false
    const held = sub === undefined ? [[name, mine]] : [[name, mine], ...(isObject(mine) && sub in mine ? [[`${name}.${sub}`, mine[sub]]] : [])]
    return held.some(([label, value]) => problems.some(p => p.startsWith(`${label}: ${JSON.stringify(value) ?? String(value)} is not `)))
  })
}

// sourceOf: the layer a key's value in force came from: the workspace file if it set the key and
// the loader kept its value, else the repo's file likewise, else the default. A value the loader
// rejected is skipped, so the key shows the lower layer whose value is in force.
export function sourceOf(
  key: string,
  repoRaw: Record<string, unknown> | null,
  workspaceRaw: Record<string, unknown> | null,
  problems: readonly string[] = [],
): Source {
  if (workspaceRaw !== null && sets(workspaceRaw, key) && !layerRejected(problems, workspaceRaw, key)) return 'workspace'
  if (repoRaw !== null && sets(repoRaw, key) && !layerRejected(problems, repoRaw, key)) return 'repo'
  return 'default'
}

export function originOf(file: Record<string, unknown>, key: string): Source {
  return typeof file[key] === 'string' && file[key] !== '' ? 'workspace' : 'plugin'
}

// viewOf: the view of the settings a pass ran with. A Runtime without the provenance fields
// (a test's, an older pass) reads as every value from its default.
export function viewOf(rt: Runtime & Partial<ViewInputs>, gates?: readonly GateLine[]): ConfigView {
  const file = rt.workspaceRaw ?? {}
  return {
    config: rt.config,
    device: rt.device,
    poolSize: rt.poolSize,
    cpus: rt.cpus,
    cap: effectiveCap(rt.config, rt.memoryBytes ?? null, gates),
    repoRaw: rt.repoSettings ?? {},
    workspaceRaw: file,
    problems: rt.configProblems,
    modeFrom: originOf(file, 'mode'),
    deviceFrom: rt.deviceFrom ?? (rt.device === '' ? 'default' : 'env'),
    pluginVersion: rt.pluginVersion ?? 'unknown',
    ...(rt.apiKey === undefined ? {} : { apiKey: rt.apiKey }),
  }
}

type Row = { label: string; value: string; source?: Source | 'mixed'; note?: string }

const clip = (line: string) => (line.length <= WIDTH ? line : `${line.slice(0, WIDTH - 3)}...`)

function render(row: Row): string[] {
  // a label past the column still keeps a space before its value
  const head = `  ${row.label.padEnd(LABEL)}${row.label.length >= LABEL ? ' ' : ''}`
  const room = WIDTH - head.length - (row.source === undefined ? 0 : row.source.length + 1)
  const value = row.value.length > room ? `${row.value.slice(0, Math.max(0, room - 3))}...` : row.value
  const line = row.source === undefined ? `${head}${value}` : `${head}${value.padEnd(Math.min(VALUE, room))} ${row.source}`
  return [line.trimEnd(), ...(row.note === undefined ? [] : [clip(`    ${row.note}`)])]
}

// the one source of several keys, or mixed when they differ
function together(sources: Source[]): Source | 'mixed' {
  const first = sources[0] ?? 'default'
  return sources.every(s => s === first) ? first : 'mixed'
}

// apiKeyRows: API-key mode's budget and reset day, which come from the workspace's parameters
// (claude_budget_usd, claude_budget_reset_day), not from a config file.
function apiKeyRows(k: ApiKeySettings): string[] {
  const budget = budgetOf({ budgetUsd: k.budgetUsd, resetDay: '1' })
  const day = budgetOf({ budgetUsd: '1', resetDay: k.resetDay })
  return [
    ...render({ label: 'budget', value: 'budgetUsd' in budget ? `$${budget.budgetUsd} a month` : 'none (new work stops)', source: 'env', note: 'from the workspace parameters, not a file' }),
    ...render({ label: 'budget reset day', value: 'resetDay' in day ? `day ${day.resetDay}, 00:00 UTC` : `${k.resetDay || 'none'} (invalid, new work stops)`, source: 'env' }),
  ]
}

// gateConcurrencyText: the gates that run at once and where that came from: `1 (auto: 8 CPUs / 8)`
// for `auto`, `3 (repo)` for a number a file sets.
function gateConcurrencyText(value: 'auto' | number, cpus: number | undefined, source: Source): string {
  if (value !== 'auto') return `${value} (${source})`
  const n = cpus ?? 1
  return `${resolveGateConcurrency(value, n)} (auto: ${n} CPUs / ${GATE_CPUS})`
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`

// the memory rows of the Capacity group (v2/capacity.ts): what the container holds, the ceiling it gives and the cap in force
function memoryRows(c: Config, cap: CapInfo, row: (label: string, key: string, value: string, note?: string) => Row): string[] {
  return [
    ...render(row('slotMemoryMiB', 'slotMemoryMiB', `${c.slotMemoryMiB === 'auto' ? 'auto' : `${c.slotMemoryMiB} MiB`} (${gib(cap.estimateBytes)}, ${cap.estimateSource})`)),
    ...render(row('memoryReserveMiB', 'memoryReserveMiB', `${c.memoryReserveMiB} MiB`)),
    ...render({ label: 'memory', value: cap.memoryBytes === null ? 'not readable: no memory ceiling' : gib(cap.memoryBytes) }),
    ...render({ label: 'memory ceiling', value: cap.ceiling === null ? 'none' : String(cap.ceiling) }),
    ...render({ label: 'effective cap', value: cap.effective === null ? 'no cap' : String(cap.effective) }),
  ]
}

const MODE_NOTE = { off: 'runs nothing', observe: 'plans and logs only', act: 'does the work' }
const STATES = ['design', 'build', 'review', 'fix', 'queued', 'parked', 'waiting'] as const

// configText: the answer to `/factory config`. A null view is a loop that has not run a pass.
export function configText(view: ConfigView | null, control: Control, now: Ms): string {
  if (view === null) return 'Factory loop: no pass yet, so no settings are loaded.'
  const c = view.config
  const src = (key: string) => sourceOf(key, view.repoRaw, view.workspaceRaw, view.problems)
  const row = (label: string, key: string, value: string, note?: string): Row => ({ label, value, source: src(key), ...(note === undefined ? {} : { note }) })
  const ms = (key: keyof Config & string) => row(key.replace(/Ms$/, ''), key, shortDuration(c[key] as Ms))
  const override = control.usageOverride
  const live = override !== null && now < override.expiresAt

  const timeouts = STATES.map(name => ({ name, ms: c.stateTimeoutMs[name], from: src(`stateTimeoutMs.${name}`) }))
  const from = together(timeouts.map(t => t.from))
  const changed = (['repo', 'workspace'] as const)
    .map(s => ({ s, names: timeouts.filter(t => t.from === s).map(t => t.name) }))
    .filter(g => g.names.length > 0)
    .map(g => `${g.s}: ${g.names.join(' ')}`)
  const compact = timeouts.map(t => `${t.name} ${shortDuration(t.ms)}`)
  const half = Math.ceil(compact.length / 2)

  const weights = Object.entries(c.queueScore).map(([name, v]) => ({ name, text: `${name} ${v}`, from: src(`queueScore.${name}`) }))
  const scoreFrom = together(weights.map(w => w.from))
  const scoreChanged = (['repo', 'workspace'] as const)
    .map(s => ({ s, names: weights.filter(w => w.from === s).map(w => w.name) }))
    .filter(g => g.names.length > 0)
    .map(g => `${g.s}: ${g.names.join(' ')}`)
  const scoreLines: string[] = []
  for (let i = 0; i < weights.length; i += 3) scoreLines.push(clip(`    ${weights.slice(i, i + 3).map(w => w.text).join(' ')}`))

  const groups: [string, string[]][] = [
    [
      'Loop',
      [
        ...render({ label: 'mode', value: c.mode, source: view.modeFrom, note: MODE_NOTE[c.mode] }),
        ...render(ms('passEveryMs')),
        ...render(ms('mainEveryMs')),
        ...render({ label: 'plugin', value: view.pluginVersion }),
        ...render({ label: 'device', value: view.device === '' ? '(none)' : view.device, source: view.deviceFrom }),
        ...render(row('regime', 'regime', c.regime)),
      ],
    ],
    [
      'Capacity',
      [
        ...render(row('maxInFlight', 'maxInFlightIssues', c.maxInFlightIssues === null ? 'no cap' : String(c.maxInFlightIssues))),
        ...memoryRows(c, view.cap, row),
        ...render({ label: 'poolSize', value: String(view.poolSize), source: typeof view.workspaceRaw.poolSize === 'number' ? 'workspace' : 'default' }),
        ...render(row('worktreeReserve', 'worktreeReserve', String(c.worktreeReserve))),
        ...render(row('maxStarts', 'maxStartsPerPass', String(c.maxStartsPerPass))),
        ...render({ label: 'serial', value: control.serial ? 'on' : 'off', source: 'directive' }),
        ...render({ label: 'new work', value: control.noNewWork ? 'off' : 'on', source: 'directive' }),
      ],
    ],
    [
      'Claims',
      [
        ...render(row('readyLabel', 'readyLabel', c.readyLabel)),
        ...render(row('priorityLabel', 'priorityLabel', c.priorityLabel)),
        ...render(row('skipLabels', 'skipLabels', c.skipLabels.length === 0 ? 'none' : c.skipLabels.join(', '))),
        ...render({ label: 'queueScore', value: '', source: scoreFrom, ...(scoreFrom === 'mixed' && scoreChanged.length > 0 ? { note: scoreChanged.join('; ') } : {}) }),
        ...scoreLines,
        ...render(row('intakeStamp', 'intakeStamp', c.intakeStamp)),
        ...render(row('intakeAreas', 'intakeAreas', c.intakeAreas.join(', '))),
      ],
    ],
    [
      'Limits',
      [
        ...render(row('reviewFixCap', 'reviewFixCap', String(c.reviewFixCap))),
        ...render(row('conflictFixCap', 'conflictFixCap', String(c.conflictFixCap))),
        ...render(row('maxLives', 'maxLives', String(c.maxLives))),
        ...render(row('maxTriages', 'maxTriages', String(c.maxTriages))),
        ...render(row('windDown', 'windDownMinutes', c.windDownMinutes === 0 ? 'off' : `${c.windDownMinutes}m`)),
        ...render(ms('minimumReleaseCadenceMs')),
        ...render(row('releaseBranchPrefix', 'releaseBranchPrefix', c.releaseBranchPrefix ?? 'none')),
        ...render(row('releaseHold', 'releaseHoldMs', c.releaseHoldMs === 0 ? 'off' : shortDuration(c.releaseHoldMs))),
        ...render(row('releaseInProgress', 'releaseInProgressMs', c.releaseInProgressMs === 0 ? 'off' : shortDuration(c.releaseInProgressMs))),
        ...render({ label: 'stateTimeout', value: '', source: from, ...(from === 'mixed' && changed.length > 0 ? { note: changed.join('; ') } : {}) }),
        clip(`    ${compact.slice(0, half).join(' ')}`),
        clip(`    ${compact.slice(half).join(' ')}`),
      ],
    ],
    [
      'Agents and gates',
      [
        ...render(row('reviewer', 'reviewer', c.reviewer)),
        ...render(row('reviewerModel', 'reviewerModel', c.reviewerModel)),
        ...render(row('triageModel', 'triageModel', c.triageModel)),
        ...render(row('intakeModel', 'intakeModel', c.intakeModel)),
        ...render({ label: 'gateCommands', value: c.gateCommands.length === 0 ? 'none' : '', source: src('gateCommands') }),
        ...c.gateCommands.map(cmd => clip(`    ${cmd}`)),
        ...render(ms('gateTimeoutMs')),
        ...render({
          label: 'gateConcurrency',
          value: gateConcurrencyText(c.gateConcurrency, view.cpus, src('gateConcurrency')),
        }),
        ...render(ms('gateWaitTimeoutMs')),
      ],
    ],
    [
      'Usage',
      [
        ...render({
          label: 'slow/new/all %',
          value: `${c.usageSlowPct} / ${c.usageStopNewPct} / ${c.usageStopAllPct}`,
          source: together([src('usageSlowPct'), src('usageStopNewPct'), src('usageStopAllPct')]),
          note: 'slow down / stop new work / stop all',
        }),
        ...render({
          label: 'override',
          value: live ? `to ${override.untilPct}% until ${clock(override.expiresAt, now)}` : 'none',
          source: 'directive',
        }),
        ...(view.apiKey === undefined ? [] : apiKeyRows(view.apiKey)),
      ],
    ],
    ['Config problems', view.problems.length === 0 ? ['  none'] : view.problems.map(p => clip(`  ${p}`))],
  ]
  return groups.flatMap(([title, lines], i) => [...(i === 0 ? [] : ['']), title, ...lines]).join('\n')
}
