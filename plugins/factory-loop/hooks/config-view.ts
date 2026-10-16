// `/factory config` (#698): the settings the loop runs with, grouped, each with where its value
// came from. Pure: it renders the Runtime the last pass used (viewOf) and the control state, and
// reads no file, so it shows what the pass runs with, not what the files say now.
import { shortDuration } from './config'
import type { Runtime } from './observe'
import type { Config, Control, Ms } from './types'

// Where a value came from. plugin, env and directive are for the few values that have no settings
// layer: the plugin's options, the machine name, and control.json.
export type Source = 'default' | 'repo' | 'workspace' | 'plugin' | 'env' | 'directive'

// What runtime() adds to the Runtime for the view: the workspace file as read, the plugin's version.
export type ViewInputs = { workspaceRaw: Record<string, unknown>; pluginVersion: string }

// What the view needs of a pass's Runtime, with the parts a Runtime may lack filled in.
export type ConfigView = {
  config: Config
  device: string
  poolSize: number
  repoRaw: Record<string, unknown>
  workspaceRaw: Record<string, unknown>
  problems: readonly string[]
  modeFrom: Source
  deviceFrom: Source
  pluginVersion: string
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

// rejected: whether a config problem names the key (or its parent object)
function rejected(problems: readonly string[], key: string): boolean {
  const [parent = '', sub] = key.split('.')
  const names = spellings(parent).flatMap(name => (sub === undefined ? [name] : [name, `${name}.${sub}`]))
  return problems.some(p => names.some(name => p.startsWith(`${name}:`)))
}

// sourceOf: the layer a key's value in force came from: the workspace file if it set the key and
// no problem names it, else the repo's file likewise, else the default. A key a layer set but the
// loader rejected shows the layer it fell back to.
export function sourceOf(
  key: string,
  repoRaw: Record<string, unknown> | null,
  workspaceRaw: Record<string, unknown> | null,
  problems: readonly string[] = [],
): Source {
  if (rejected(problems, key)) {
    // the loader left a rejected value out; a lower layer may have set the key validly
    return workspaceRaw !== null && repoRaw !== null && sets(workspaceRaw, key) && sets(repoRaw, key) ? 'repo' : 'default'
  }
  if (workspaceRaw !== null && sets(workspaceRaw, key)) return 'workspace'
  if (repoRaw !== null && sets(repoRaw, key)) return 'repo'
  return 'default'
}

function originOf(file: Record<string, unknown>, key: string): Source {
  return typeof file[key] === 'string' && file[key] !== '' ? 'workspace' : 'plugin'
}

// viewOf: the view of the settings a pass ran with. A Runtime without the provenance fields
// (a test's, an older pass) reads as every value from its default.
export function viewOf(rt: Runtime & Partial<ViewInputs>): ConfigView {
  const file = rt.workspaceRaw ?? {}
  const shadow = typeof file.shadowDevice === 'string' && file.shadowDevice !== '' ? 'workspace' : 'plugin'
  return {
    config: rt.config,
    device: rt.device,
    poolSize: rt.poolSize,
    repoRaw: rt.repoSettings ?? {},
    workspaceRaw: file,
    problems: rt.configProblems,
    modeFrom: originOf(file, 'mode'),
    deviceFrom: rt.config.shadowDevice !== null && rt.device === rt.config.shadowDevice ? shadow : rt.device === '' ? 'default' : 'env',
    pluginVersion: rt.pluginVersion ?? 'unknown',
  }
}

type Row = { label: string; value: string; source?: Source | 'mixed'; note?: string }

const clip = (line: string) => (line.length <= WIDTH ? line : `${line.slice(0, WIDTH - 3)}...`)

function render(row: Row): string[] {
  const head = `  ${row.label.padEnd(LABEL)}`
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

const MODE_NOTE = { off: 'runs nothing', observe: 'plans and logs only', act: 'does the work' }
const STATES = ['design', 'build', 'review', 'fix', 'queued', 'parked'] as const

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

  const groups: [string, string[]][] = [
    [
      'Loop',
      [
        ...render({ label: 'mode', value: c.mode, source: view.modeFrom, note: MODE_NOTE[c.mode] }),
        ...render(row('planner', 'planner', c.planner, c.planner === 'v2' ? 'v2 plans and acts' : 'v1 plans and acts')),
        ...render(ms('passEveryMs')),
        ...render({ label: 'plugin', value: view.pluginVersion }),
        ...render({ label: 'device', value: view.device === '' ? '(none)' : view.device, source: view.deviceFrom }),
      ],
    ],
    [
      'Capacity',
      [
        ...render(row('maxInFlight', 'maxInFlightIssues', c.maxInFlightIssues === null ? 'no cap' : String(c.maxInFlightIssues))),
        ...render({ label: 'poolSize', value: String(view.poolSize), source: typeof view.workspaceRaw.poolSize === 'number' ? 'workspace' : 'default' }),
        ...render(row('worktreeReserve', 'worktreeReserve', String(c.worktreeReserve))),
        ...render(row('maxStarts', 'maxStartsPerPass', String(c.maxStartsPerPass))),
        ...render({ label: 'serial', value: control.serial ? 'on' : 'off', source: 'directive' }),
        ...render({ label: 'new work', value: control.noNewWork ? 'off' : 'on', source: 'directive' }),
      ],
    ],
    [
      'Limits',
      [
        ...render(row('reviewFixCap', 'reviewFixCap', String(c.reviewFixCap))),
        ...render(row('maxLives', 'maxLives', String(c.maxLives))),
        ...render(row('maxTriages', 'maxTriages', String(c.maxTriages))),
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
        ...render({ label: 'gateCommands', value: c.gateCommands.length === 0 ? 'none' : '', source: src('gateCommands') }),
        ...c.gateCommands.map(cmd => clip(`    ${cmd}`)),
        ...render(ms('gateTimeoutMs')),
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
      ],
    ],
    ['Config problems', view.problems.length === 0 ? ['  none'] : view.problems.map(p => clip(`  ${p}`))],
  ]
  return groups.flatMap(([title, lines], i) => [...(i === 0 ? [] : ['']), title, ...lines]).join('\n')
}
