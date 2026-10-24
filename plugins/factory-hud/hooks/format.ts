// The pure half of factory-hud: what the status entry says and which toasts are due.
// No $ here, so the tests drive it directly.
import type { SessionContextUsage, SessionRateLimit } from 'claude-code'

export type Factory = {
  live: number
  design: number
  dev: number
  pipe: number
  merge: number
  queued: number
  at: number
}

export type Readout = {
  context?: SessionContextUsage
  limits: readonly SessionRateLimit[]
  factory?: Factory
  isFactoryShown: boolean
  isFactoryLoading: boolean
  versions: string
}

// The v2 states callum-flow-factory-state reports (docs/factory-state.md) that count as live (waiting stays out).
const LIVE = ['designing', 'building', 'reviewing', 'fixing', 'parked', 'merge-queue']
// A report from an image older than the tool switch has only the old stage word: it maps to a state here.
// This is a small copy of plugins/factory-loop/hooks/factory-state-map.ts (a separate mod, no import): change both together.
const STAGE_STATE: Record<string, string> = {
  queued: 'queued',
  designing: 'designing',
  implementing: 'building',
  'in pipeline': 'reviewing',
  parked: 'parked',
  waiting: 'waiting',
  'ready to merge': 'merge-queue',
}
const STATES = ['queued', 'designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting', 'closed']

// stateOf: the v2 state one issue row shows; an ended row or a lapsed claim is not live (it counts as closed or queued).
function stateOf(issue: { state?: unknown; stage?: unknown; ended?: unknown; detail?: unknown }): string {
  if (issue.ended === true) return 'closed'
  if (typeof issue.detail === 'string' && issue.detail.startsWith('claim lapsed at')) return 'queued'
  if (typeof issue.state === 'string' && STATES.includes(issue.state)) return issue.state
  return STAGE_STATE[String(issue.stage)] ?? String(issue.stage)
}
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const STALE_MS = 5 * 60_000

// counts: the factory-state JSON document as the counts the entry shows, or undefined
// when it is not one.
export function counts(json: string, at: number): Factory | undefined {
  let doc: { repos?: { issues?: { state?: unknown; stage?: unknown; ended?: unknown; detail?: unknown }[] }[] }
  try {
    doc = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(doc?.repos)) return undefined
  const states = doc.repos.flatMap(repo => repo.issues ?? []).map(stateOf)
  const n = (names: string[]) => states.filter(state => names.includes(state)).length
  return {
    live: n(LIVE),
    design: n(['designing']),
    dev: n(['building']),
    pipe: n(['reviewing', 'fixing', 'parked']),
    merge: n(['merge-queue']),
    queued: n(['queued']),
    at,
  }
}

// repoSlug: owner/name from a GitHub origin URL (https or ssh).
export function repoSlug(url: string): string | undefined {
  return url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1]
}

// clock: HH:MM in the zone, or UTC when the zone is unknown.
export function clock(ms: number, zone: string | undefined): string {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone })
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

// statusText: the one line the status entry shows.
export function statusText(r: Readout, now: number, zone: string | undefined): string {
  const parts = [clock(now, zone)]
  if (r.context?.percent !== undefined) parts.push(`ctx ${Math.ceil(r.context.percent)}%`)
  for (const limit of r.limits) {
    const name = WINDOWS[limit.kind]
    if (name) parts.push(`${name} ${Math.ceil(limit.percentUsed)}%`)
  }
  if (r.isFactoryShown && r.factory) {
    const f = r.factory
    const age = now - f.at
    parts.push(
      `| ${f.live} live: design ${f.design} dev ${f.dev} pipe ${f.pipe}` +
        (f.merge > 0 ? ` merge ${f.merge}` : '') +
        ` | queued ${f.queued}` +
        (age >= STALE_MS ? ` (${Math.floor(age / 60_000)}m old)` : ''),
    )
  } else if (r.isFactoryShown && r.isFactoryLoading) {
    parts.push('| factory loading')
  }
  if (r.versions) parts.push(`| ${r.versions}`)
  return parts.join('  ')
}

// versionsText: Claude Code's version, then callum-flow, the base image and no-mistakes
// from dev-version's snapshot when there is one.
export function versionsText(claude: string, snapshot: string | undefined): string {
  const parts = [`cc ${claude.split(' ')[0]}`]
  if (snapshot) {
    try {
      const v = JSON.parse(snapshot) as {
        plugin_version?: string | null
        base_image?: string | null
        components?: { name?: string; running?: string | null }[]
      }
      if (v.plugin_version) parts.push(`flow ${v.plugin_version}`)
      if (v.base_image) parts.push(`img ${v.base_image}`)
      const nm = v.components?.find(c => c.name === 'no-mistakes')?.running
      if (nm) parts.push(`nm ${nm}`)
    } catch {
      // A snapshot that is not JSON adds nothing.
    }
  }
  return parts.join(' ')
}

// dueAlerts: the toasts due now and not yet shown, as [key, text]: context at 85%, a usage
// window at 90%.
export function dueAlerts(
  context: SessionContextUsage | undefined,
  limits: readonly SessionRateLimit[],
  shown: readonly string[],
): [string, string][] {
  const due: [string, string][] = []
  if ((context?.percent ?? 0) >= 85) {
    due.push(['context-85', `Context is ${Math.ceil(context?.percent ?? 0)}% full`])
  }
  for (const limit of limits) {
    const name = WINDOWS[limit.kind]
    if (name && limit.percentUsed >= 90) {
      due.push([`${limit.kind}-90`, `${name} usage is at ${Math.ceil(limit.percentUsed)}%`])
    }
  }
  return due.filter(([key]) => !shown.includes(key))
}

// hudSource: the store the factory counts read, from FACTORY_HUD_SOURCE. Empty or unset
// leaves factory-state's own default; a value that is not a store gives a warning.
export function hudSource(raw: string | undefined): { source?: 'old' | 'new' | 'shadow'; warning?: string } {
  if (raw === undefined || raw === '') return {}
  if (raw === 'old' || raw === 'new' || raw === 'shadow') return { source: raw }
  return { warning: `FACTORY_HUD_SOURCE=${raw} is not old, new or shadow; ignored` }
}
