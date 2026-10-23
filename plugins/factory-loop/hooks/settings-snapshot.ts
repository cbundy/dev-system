// settings.json: the settings the loop runs with, rewritten by every pass that observes. A pure
// builder (snapshotOf) and one best-effort write (writeSnapshot); a failed write is a problem line
// in the decision log and never fails the pass. Nothing is copied from the environment but the two
// experiment shares, and the layer files are never copied whole, only the source of each key.
import { DEFAULT_CONFIG } from './config'
import { originOf, sourceOf } from './config-view'
import type { Source, ViewInputs } from './config-view'
import type { Runtime } from './observe'
import type { CapInfo } from './v2/capacity'
import type { Config, Control, Ms } from './types'
import { WIND_DOWN_WRITE_SCRIPT } from './v2/wind-down-files'

export const SNAPSHOT_VERSION = 1

// the agents whose `model:` line the snapshot reports, and the file each is read from
export const AGENT_FILES = { designer: 'designer-v2', builder: 'builder', fixer: 'fixer', adjudicator: 'adjudicator' } as const
export type AgentModels = Partial<Record<keyof typeof AGENT_FILES, string | null>>

export type ShareEnv = { implementerOpusPct?: string | null; designSessionPct?: string | null }

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// leafKeys: every key of the config in DEFAULT_CONFIG's order (then any other), an object-valued
// one expanded to `parent.sub`; arrays are leaves.
export function leafKeys(config: Config): string[] {
  const record = config as unknown as Record<string, unknown>
  const names = [...Object.keys(DEFAULT_CONFIG), ...Object.keys(record).filter(k => !(k in DEFAULT_CONFIG))]
  return names.flatMap(name => {
    const value = record[name]
    return isPlain(value) ? Object.keys(value).map(sub => `${name}.${sub}`) : [name]
  })
}

// modelOf: the `model:` line of an agent file's frontmatter, null when there is none
export function modelOf(frontmatter: string | null): string | null {
  if (frontmatter === null) return null
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(frontmatter)
  const m = /^model:[ \t]*(.+?)[ \t]*$/m.exec(head === null ? '' : (head[1] ?? ''))
  const v = m?.[1]?.replace(/^(["'])(.*)\1$/, '$2') ?? ''
  return v === '' ? null : v
}

// shareOf: an integer percentage 0-100, else null
export function shareOf(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n <= 100 ? n : null
}

export type Snapshot = {
  v: number
  repo: string
  at: string
  plugin_version: string
  settings: Record<string, unknown>
  layers: Record<string, Source>
  derived: {
    gateConcurrency: number | null
    cpus: number | null
    // the container's memory and the cap the loop held to; optional: a snapshot from before them has neither
    memoryBytes?: number | null
    effectiveCap?: number | null
    models: Record<'designer' | 'builder' | 'fixer' | 'triage' | 'reviewer' | 'adjudicator', string | null>
    experiment: { implementerOpusPct: number | null; designSessionPct: number | null }
  }
  problems: string[]
}

// snapshotFrom: the kept value as a snapshot with its time in ms, null when it is not a valid snapshot of this version
export function snapshotFrom(raw: unknown): { snap: Snapshot; at: Ms } | null {
  if (!isPlain(raw) || raw.v !== SNAPSHOT_VERSION || typeof raw.at !== 'string' || typeof raw.plugin_version !== 'string') return null
  if (!isPlain(raw.settings) || !isPlain(raw.layers) || !isPlain(raw.derived)) return null
  const at = Date.parse(raw.at)
  return Number.isNaN(at) ? null : { snap: raw as unknown as Snapshot, at }
}

export function snapshotOf(rt: Runtime & Partial<ViewInputs>, control: Control, agentModels: AgentModels, env: ShareEnv, at: Ms, cap?: Pick<CapInfo, 'effective'>): Snapshot {
  const repoRaw = rt.repoSettings ?? null
  const workspaceRaw = rt.workspaceRaw ?? {}
  const record = rt.config as unknown as Record<string, unknown>
  const live = control.usageOverride !== null && at < control.usageOverride.expiresAt
  const settings: Record<string, unknown> = {}
  const names = [...Object.keys(DEFAULT_CONFIG), ...Object.keys(record).filter(k => !(k in DEFAULT_CONFIG))]
  for (const name of names) settings[name] = record[name] ?? null
  Object.assign(settings, {
    poolSize: rt.poolSize,
    device: rt.device,
    serial: control.serial,
    noNewWork: control.noNewWork,
    usageOverride: live && control.usageOverride !== null ? { untilPct: control.usageOverride.untilPct, expiresAt: control.usageOverride.expiresAt } : null,
  })
  const layers: Record<string, Source> = {}
  for (const key of leafKeys(rt.config)) {
    layers[key] = key === 'mode' ? originOf(workspaceRaw, 'mode') : sourceOf(key, repoRaw, workspaceRaw, rt.configProblems)
  }
  layers.poolSize = typeof workspaceRaw.poolSize === 'number' ? 'workspace' : 'default'
  layers.device = rt.deviceFrom ?? (rt.device === '' ? 'default' : 'env')
  layers.serial = layers.noNewWork = layers.usageOverride = 'directive'
  return {
    v: SNAPSHOT_VERSION,
    repo: rt.repo,
    at: new Date(at).toISOString(),
    plugin_version: rt.pluginVersion ?? 'unknown',
    settings,
    layers,
    derived: {
      gateConcurrency: rt.gateConcurrency ?? null,
      cpus: rt.cpus ?? null,
      memoryBytes: rt.memoryBytes ?? null,
      effectiveCap: cap?.effective ?? null,
      models: {
        designer: agentModels.designer ?? null,
        builder: agentModels.builder ?? null,
        fixer: agentModels.fixer ?? null,
        triage: rt.config.triageModel ?? null,
        reviewer: rt.config.reviewerModel ?? null,
        adjudicator: agentModels.adjudicator ?? null,
      },
      experiment: { implementerOpusPct: shareOf(env.implementerOpusPct), designSessionPct: shareOf(env.designSessionPct) },
    },
    problems: [...rt.configProblems],
  }
}

export type SnapshotIo = { run: (argv: string[], init: { stdin?: string; timeoutMs: number }) => Promise<{ exitCode: number; stderr: string }> }

// writeSnapshot: the file lands whole or not at all; returns the problems for the decision log
export async function writeSnapshot(io: SnapshotIo, loopDir: string, snap: Snapshot): Promise<string[]> {
  try {
    const r = await io.run(['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'settings-snapshot', `${loopDir}/settings.json`], { stdin: `${JSON.stringify(snap, null, 2)}\n`, timeoutMs: 10_000 })
    return r.exitCode === 0 ? [] : [`settings snapshot: write failed (exit ${r.exitCode}${r.stderr.trim() === '' ? '' : `: ${r.stderr.trim().slice(0, 200)}`})`]
  } catch (e) {
    return [`settings snapshot: write failed (${e instanceof Error ? e.message : String(e)})`]
  }
}

// the agents' models, read once per loaded plugin (its root) and kept
let modelsRead: { root: string; models: Promise<AgentModels> } | undefined

export function agentModelsOf(read: (path: string) => Promise<string | null>, pluginRoot: string): Promise<AgentModels> {
  if (modelsRead?.root !== pluginRoot) {
    const entries = Object.entries(AGENT_FILES).map(async ([agent, file]) => [agent, modelOf(await read(`${pluginRoot}/agents/${file}.md`).catch(() => null))] as const)
    modelsRead = { root: pluginRoot, models: Promise.all(entries).then(Object.fromEntries) }
  }
  return modelsRead.models
}

// forgetModels: for tests
export function forgetModels() {
  modelsRead = undefined
}
