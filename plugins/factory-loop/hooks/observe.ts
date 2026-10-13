// observe: run the read-only commands of SPEC 3.3 and assemble the State plan takes. Thin on
// purpose: every output goes straight to a pure parser (parse.ts, derive.ts) and buildState.
// Cadences (config queueEveryMs, githubEveryMs, usageEveryMs, milestoneEveryMs) keep GitHub
// reads well under the rate limit; a failed source keeps its last value with its old time, so
// plan can see how stale it is.
import { EMPTY_CONTROL, controlFrom } from './config'
import { EVENTS_SQL, deriveLedger, eventsFromRows, factsOf } from './derive'
import type { FactoryEvent } from './derive'
import {
  parseBrief,
  parseCsv,
  parseFactoryState,
  parseIssueRead,
  parseMilestone,
  parsePool,
  parseQueue,
  parseSubIssues,
  parseUsage,
} from './parse'
import type { Factory } from './parse'
import { TRACKER_DEPTH, buildState } from './state'
import type { GithubIssue } from './state'
import type { Config, Control, Milestone, Pool, Source, SourceName, State, Usage } from './types'

const GITHUB_READS_PER_PASS = 12
const EVENT_DAYS = 3
const USAGE_CHECK = '/usr/local/share/callum-tools/usage-check.sh'

// Runtime: what one pass runs as, from the plugin options, the workspace config file and the
// repo-local settings (SPEC 4.1).
export type Runtime = {
  mode: 'off' | 'observe' | 'act'
  repo: string
  device: string
  runSource: 'local' | 'events'
  poolSize: number
  cwd: string
  loopDir: string
  sink: string | null
  config: Config
  // what loadConfig left out of the repo-local settings, for the decision log
  configProblems: string[]
}

type Timed<T> = { at: number; value: T }

// Cache: what survives between passes in the module (a reload starts it over).
export type Cache = {
  queue?: Timed<number[]>
  github: Map<number, Timed<GithubIssue>>
  // trackers' direct open sub-issues, from their timelines (D-35)
  timelines: Map<number, Timed<number[]>>
  usage?: Timed<Usage>
  milestone?: Timed<Milestone | null>
  factory?: Timed<Factory>
  events?: Timed<FactoryEvent[]>
  pool?: Timed<Pool>
}

export function emptyCache(): Cache {
  return { github: new Map(), timelines: new Map() }
}

export type Observation = { state: State; commands: string[] }

// Io: the engine calls observe needs, built by register.ts (the only module that holds $).
export type Io = {
  now: () => Promise<number>
  run: (argv: string[], init: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile: (path: string) => Promise<string | null>
  sessionLimits: () => Promise<{ kind: string; percentUsed: number; resetsAt?: string }[]>
  agents: () => Promise<{ id: string; type: string; status: State['agents'][number]['status'] }[]>
}

export async function observe(io: Io, rt: Runtime, cache: Cache, loadedAt: number, lastTitle: string | null): Promise<Observation> {
  const now = await io.now()
  const cfg = rt.config
  const commands: string[] = []
  const sources = {} as Record<SourceName, Source>
  const mark = (name: SourceName, ok: boolean, at: number | null, error?: string) => {
    sources[name] = error === undefined ? { ok, at } : { ok, at, error }
  }
  const run = async (argv: string[], stdin?: string, timeoutMs = 60_000) => {
    const env: Record<string, string> = { CALLUM_FLOW_REPO: rt.repo }
    if (rt.sink !== null) env.CALLUM_EVENTS_DIR = rt.sink
    commands.push(argv.join(' ').slice(0, 160))
    return io.run(argv, { cwd: rt.cwd, env, stdin, timeoutMs })
  }
  const fail = (r: { exitCode: number; stderr: string }) => `exit ${r.exitCode}: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`

  // factory: required; a failure makes the pass blind (rule G2)
  try {
    const r = await run(['callum-flow-factory-state', '--repo', rt.repo, '--format', 'json', '--github', 'off'], undefined, 90_000)
    const parsed = r.exitCode === 0 ? parseFactoryState(r.stdout, rt.repo) : null
    if (parsed !== null) cache.factory = { at: now, value: parsed }
    mark('factory', parsed !== null, cache.factory?.at ?? null, parsed === null ? fail(r) : undefined)
  } catch (err) {
    mark('factory', false, cache.factory?.at ?? null, String(err))
  }

  // facts: the event log, one query
  try {
    const vars = ['-v', `repo=${rt.repo}`, '-v', `at=${new Date(now).toISOString()}`, '-v', `days=${EVENT_DAYS}`]
    const r = await run(['dev-query', '--csv', ...vars], EVENTS_SQL)
    if (r.exitCode === 0) cache.events = { at: now, value: eventsFromRows(parseCsv(r.stdout)) }
    mark('facts', r.exitCode === 0, cache.events?.at ?? null, r.exitCode === 0 ? undefined : fail(r))
  } catch (err) {
    mark('facts', false, cache.events?.at ?? null, String(err))
  }
  const factory = cache.factory?.value ?? null
  const events = cache.events?.value ?? []
  const facts = cache.events !== undefined ? factsOf(events) : null
  mark('runs', rt.runSource === 'events' ? sources.facts.ok : false, sources.facts.at, rt.runSource === 'local' ? 'pipeline-watch.sh --once is not built yet' : undefined)

  // queue: every queueEveryMs
  if (cache.queue === undefined || now - cache.queue.at >= cfg.queueEveryMs) {
    try {
      const r = await run(['callum-flow-issue-read', '--json', '--list', '--label', cfg.readyLabel])
      const queue = r.exitCode === 0 ? parseQueue(r.stdout) : null
      if (queue !== null) cache.queue = { at: now, value: queue }
      mark('queue', queue !== null, cache.queue?.at ?? null, queue === null ? fail(r) : undefined)
    } catch (err) {
      mark('queue', false, cache.queue?.at ?? null, String(err))
    }
  } else {
    mark('queue', true, cache.queue.at)
  }

  // GitHub per issue: the queue, this device's live issues, and the issues `only` names with
  // the sub-issues their trackers stand for (D-35), oldest reads first
  const control = await readControl(io, rt)
  const tracker = new RegExp(cfg.trackerTitle, 'i')
  const isTracker = (n: number) => {
    const facts = cache.github.get(n)?.value.facts
    return facts !== null && facts !== undefined && ((facts.subIssues ?? 0) > 0 || tracker.test(facts.title))
  }
  // the trackers under `only` to read a timeline for (nested ones TRACKER_DEPTH deep), and every
  // sub-issue they are known to stand for, from what the cache holds now
  const walkTrackers = () => {
    const trackers: number[] = []
    const subIssues: number[] = []
    const walk = (n: number, depth: number) => {
      if (depth >= TRACKER_DEPTH || trackers.includes(n) || !isTracker(n)) return
      trackers.push(n)
      for (const sub of cache.timelines.get(n)?.value ?? []) {
        if (!subIssues.includes(sub)) subIssues.push(sub)
        walk(sub, depth + 1)
      }
    }
    for (const n of control.only) walk(n, 0)
    return { trackers, subIssues }
  }
  const { subIssues } = walkTrackers()
  const mine = (factory?.issues ?? []).filter(i => !i.ended && i.holder === rt.device)
  const wanted = [...new Set([...(cache.queue?.value ?? []), ...mine.map(i => i.number), ...control.only, ...subIssues])]
  const due = wanted
    .filter(n => {
      const c = cache.github.get(n)
      return c === undefined || now - c.at >= cfg.githubEveryMs
    })
    .sort((a, b) => (cache.github.get(a)?.at ?? 0) - (cache.github.get(b)?.at ?? 0))
    .slice(0, GITHUB_READS_PER_PASS)
  let githubOk = true
  for (const n of due) {
    try {
      const r = await run(['callum-flow-issue-read', '--json', String(n)])
      if (r.exitCode === 3) {
        cache.github.set(n, { at: now, value: { facts: null, trusted: false, brief: null } })
        continue
      }
      const facts = r.exitCode === 0 ? parseIssueRead(r.stdout) : null
      if (facts === null) {
        githubOk = false
        continue
      }
      let brief = cache.github.get(n)?.value.brief ?? null
      if (mine.some(i => i.number === n && i.stage === 'designing')) {
        const c = await run(['callum-flow-issue-read', '--json', String(n), '--comments'])
        if (c.exitCode === 0) brief = parseBrief(c.stdout)
      }
      cache.github.set(n, { at: now, value: { facts, trusted: true, brief } })
    } catch {
      githubOk = false
    }
  }
  // tracker timelines, in the reads left this pass, walked again so a tracker read just now counts
  const timelinesDue = walkTrackers()
    .trackers.filter(n => {
      const c = cache.timelines.get(n)
      return c === undefined || now - c.at >= cfg.githubEveryMs
    })
    .slice(0, Math.max(0, GITHUB_READS_PER_PASS - due.length))
  for (const n of timelinesDue) {
    try {
      const r = await run(['callum-flow-issue-read', '--json', '--timeline', String(n)])
      const subs = r.exitCode === 0 ? parseSubIssues(r.stdout, rt.repo) : null
      if (subs === null) githubOk = false
      else cache.timelines.set(n, { at: now, value: subs })
    } catch {
      githubOk = false
    }
  }
  mark('github', githubOk, now)

  // usage: usage-check.sh every usageEveryMs, and the session's own figures every pass
  if (cache.usage === undefined || now - cache.usage.at >= cfg.usageEveryMs) {
    try {
      const r = await run([USAGE_CHECK], undefined, 30_000)
      cache.usage = { at: now, value: parseUsage(r.stdout.trim()) }
    } catch {
      // unavailable: plan fails open as the skill says
    }
  }
  // a reading older than usageStaleMs counts as unavailable (SPEC 3.1)
  const reading = cache.usage !== undefined && now - cache.usage.at < cfg.usageStaleMs ? cache.usage.value : null
  const usage = withSession(reading, await io.sessionLimits())
  mark('usage', usage !== null && !usage.unavailable, cache.usage?.at ?? null)

  // pool: the shadow cannot see the shadowed device's pool, so it is assumed from its load
  let pool: Pool | null = null
  if (rt.runSource === 'events') {
    const busy = mine.filter(i => ['implementing', 'in pipeline', 'parked', 'ready to merge'].includes(i.stage)).length
    pool = { free: Math.max(0, rt.poolSize - busy), total: rt.poolSize, slots: [] }
    mark('pool', true, now)
  } else {
    try {
      const r = await run(['treehouse', 'status', '--json'])
      pool = r.exitCode === 0 ? parsePool(r.stdout, rt.poolSize) : null
      if (pool !== null) cache.pool = { at: now, value: pool }
      mark('pool', pool !== null, cache.pool?.at ?? null, pool === null ? fail(r) : undefined)
    } catch (err) {
      mark('pool', false, cache.pool?.at ?? null, String(err))
    }
  }

  // milestone: every milestoneEveryMs; nothing printed means the repo has not opted in
  if (cache.milestone === undefined || now - cache.milestone.at >= cfg.milestoneEveryMs) {
    try {
      const r = await run(['callum-flow-milestone', 'show', 'next'])
      if (r.exitCode === 0) cache.milestone = { at: now, value: parseMilestone(r.stdout) }
    } catch {
      // leave the last reading
    }
  }
  mark('milestone', cache.milestone !== undefined, cache.milestone?.at ?? null)

  // The ledger: in observe mode what the device's own events prove (SPEC 7.5); act mode keeps
  // its own in the store (phase 3).
  const ledger = factory !== null && facts !== null ? deriveLedger(events, factory, facts, rt.device) : []
  const agents = (await io.agents())
    .filter(a => ledger.some(e => e.agentId === a.id))
    .map(a => ({ id: a.id, type: a.type, status: a.status }))

  const state = buildState({
    now,
    repo: rt.repo,
    device: rt.device,
    loadedAt,
    sources,
    factory,
    facts,
    runs: null,
    queue: cache.queue?.value ?? null,
    github: new Map([...cache.github].map(([n, c]) => [n, c.value])),
    timelines: new Map([...cache.timelines].map(([n, c]) => [n, c.value])),
    usage,
    pool,
    agents,
    milestone: cache.milestone?.value ?? null,
    ledger,
    control,
    lastTitle,
    githubBackoffUntil: null,
    trackerTitle: cfg.trackerTitle,
  })
  return { state, commands }
}

// withSession: the higher of usage-check.sh's reading and the session's own, per window.
function withSession(reading: Usage | null, limits: { kind: string; percentUsed: number; resetsAt?: string }[]): Usage | null {
  const session = (kind: string) => limits.find(l => l.kind === kind)
  const five = session('five_hour')
  const seven = session('seven_day')
  if (reading === null && five === undefined && seven === undefined) return null
  const base: Usage = reading ?? { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false }
  const max = (a: number | null, b: number | undefined) => (b === undefined ? a : a === null ? b : Math.max(a, b))
  return {
    ...base,
    fiveHour: max(base.fiveHour, five?.percentUsed),
    sevenDay: max(base.sevenDay, seven?.percentUsed),
    unavailable: base.unavailable && five === undefined && seven === undefined,
  }
}

// readControl: control.json, field by field (controlFrom); missing or unreadable is no directive.
async function readControl(io: Io, rt: Runtime): Promise<Control> {
  try {
    const text = await io.readFile(`${rt.loopDir}/control.json`)
    return text === null ? EMPTY_CONTROL : controlFrom(JSON.parse(text))
  } catch {
    return EMPTY_CONTROL
  }
}
