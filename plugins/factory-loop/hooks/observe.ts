// observe: run the read-only commands of SPEC 3.3 and assemble the State plan takes. Thin on
// purpose: every output goes straight to a pure parser (parse.ts, derive.ts) and buildState.
// Cadences (config queueEveryMs, githubEveryMs, usageEveryMs, milestoneEveryMs) keep GitHub
// reads well under the rate limit; a failed source keeps its last value with its old time, so
// plan can see how stale it is. Every command runs from the main checkout with the runtime's
// environment (rt.env), which in observe mode sends its event writes to the sink (SPEC 11.1).
import { EMPTY_CONTROL, controlFrom } from './config'
import { EVENTS_SQL, deriveLedger, eventsFromRows, factsOf } from './derive'
import type { FactoryEvent } from './derive'
import { rateLimited } from './exec'
import { choose } from './ledger'
import type { LedgerSource } from './ledger'
import {
  parseBrief,
  parseCsv,
  parseFactoryState,
  parseIssueRead,
  parseMilestone,
  parsePipelineOnce,
  parsePool,
  parseQueue,
  parseQueueOnce,
  parseSubIssues,
  parseUsage,
} from './parse'
import type { Factory } from './parse'
import { TRACKER_DEPTH, buildState, runsFromWatch, seenRuns } from './state'
import type { GithubIssue, SeenRun } from './state'
import type { Config, Control, LedgerEntry, Milestone, Pool, Source, SourceName, State, Usage } from './types'

const GITHUB_READS_PER_PASS = 12
const EVENT_DAYS = 3
// a ledger rebuilt after a lost store reads a week of events: holds older than the facts
// window (a pending decision, an escalation) must survive it, and entries are kept 7 days
const REBUILD_DAYS = 7
// one poll probes every watched branch's newest run, GitHub included
const PIPELINE_TIMEOUT_MS = 120_000
// how long GitHub reads wait after a rate limit (SPEC 10.2)
export const GITHUB_BACKOFF_MS = 15 * 60_000

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
  // the observe-mode event sink (SPEC 11.1), null when acting; env carries it
  sink: string | null
  // the base environment of every command the loop runs, observe and act alike:
  // CALLUM_FLOW_REPO, CALLUM_EVENTS_DIR=<sink> when not acting, and PATH with the workspace
  // config's binDir in front (a testbed runs the branch's own CLIs before a release)
  env: Record<string, string>
  // where pipeline-watch.sh, queue-watch.sh and usage-check.sh live (workspace config toolsDir)
  toolsDir: string
  config: Config
  // what loadConfig left out of the repo-local settings, for the decision log
  configProblems: string[]
}

// Stored: what act mode keeps in $.store across passes and reloads. register.ts reads it
// (`ledger:<repo>` through ledger.ts load, `backoff:<repo>`, `queue-known:<repo>`) and passes
// none in observe mode, which keeps nothing of its own.
export type Stored = {
  // null: the store holds no ledger (a new device, a wiped config), so it is rebuilt from the log
  ledger: LedgerEntry[] | null
  // GitHub reads wait until then after a rate limit (SPEC 10.2)
  githubBackoffUntil: number | null
  // the queue's last now= list, handed back to queue-watch.sh as --known (SPEC 3.4)
  queueKnown: number[] | null
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
  // runSource local: the last poll's runs, each with when it was first seen as it is
  runs?: Timed<SeenRun[]>
  // act mode: the last ledger rebuilt from the event log, and how many entries it found
  rebuilt?: Timed<number>
}

export function emptyCache(): Cache {
  return { github: new Map(), timelines: new Map() }
}

export type Observation = {
  state: State
  commands: string[]
  // queue-watch.sh's now= list when it read the queue this pass, for register to save as the
  // next --known; null when it did not (the cadence, a failure, a backoff, observe mode): the
  // stored list stands
  queueKnown: number[] | null
  // where the ledger came from, for the decision log: the store, the event log, or neither
  ledgerSource: LedgerSource
  // a command's stderr showed a GitHub rate limit: register sets the backoff (SPEC 10.2)
  rateLimited: boolean
}

// Io: the engine calls observe needs, built by register.ts (the only module that holds $).
export type Io = {
  now: () => Promise<number>
  run: (argv: string[], init: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile: (path: string) => Promise<string | null>
  sessionLimits: () => Promise<{ kind: string; percentUsed: number; resetsAt?: string }[]>
  agents: () => Promise<{ id: string; type: string; status: State['agents'][number]['status'] }[]>
}

// observe: one pass's reads. `stored` is act mode's store (undefined in observe mode): it adds
// the ledger, the GitHub backoff and the queue's known list.
export async function observe(
  io: Io,
  rt: Runtime,
  cache: Cache,
  loadedAt: number,
  lastTitle: string | null,
  stored?: Stored,
): Promise<Observation> {
  const now = await io.now()
  const cfg = rt.config
  const commands: string[] = []
  const sources = {} as Record<SourceName, Source>
  let limited = false
  const mark = (name: SourceName, ok: boolean, at: number | null, error?: string) => {
    sources[name] = error === undefined ? { ok, at } : { ok, at, error }
  }
  const run = async (argv: string[], stdin?: string, timeoutMs = 60_000) => {
    commands.push(argv.join(' ').slice(0, 160))
    const r = await io.run(argv, { cwd: rt.cwd, env: rt.env, stdin, timeoutMs })
    if (rateLimited(r.stderr)) limited = true
    return r
  }
  const tool = (name: string) => `${rt.toolsDir}/${name}`
  const fail = (r: { exitCode: number; stderr: string }) => `exit ${r.exitCode}: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`
  const eventsSince = (days: number) => ['dev-query', '--csv', '-v', `repo=${rt.repo}`, '-v', `at=${new Date(now).toISOString()}`, '-v', `days=${days}`]
  // act mode: GitHub reads wait out a rate limit (SPEC 10.2); old values stay, with their age
  const until = stored?.githubBackoffUntil ?? null
  const backoffUntil = until !== null && until > now ? until : null
  const waiting = backoffUntil === null ? '' : `GitHub rate limit: waiting until ${new Date(backoffUntil).toISOString()}`

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
    const r = await run(eventsSince(EVENT_DAYS), EVENTS_SQL)
    if (r.exitCode === 0) cache.events = { at: now, value: eventsFromRows(parseCsv(r.stdout)) }
    mark('facts', r.exitCode === 0, cache.events?.at ?? null, r.exitCode === 0 ? undefined : fail(r))
  } catch (err) {
    mark('facts', false, cache.events?.at ?? null, String(err))
  }
  const factory = cache.factory?.value ?? null
  const events = cache.events?.value ?? []
  const facts = cache.events !== undefined ? factsOf(events) : null

  // runs: the pipeline watcher's one-shot poll (runSource local), or the event log's view of
  // them (runSource events: the shadow and the replay). A failed poll is a failed source,
  // never "no runs", and so is a line the parser cannot read.
  if (rt.runSource === 'events') {
    mark('runs', sources.facts.ok, sources.facts.at)
  } else {
    try {
      const r = await run([tool('pipeline-watch.sh'), '--once'], undefined, PIPELINE_TIMEOUT_MS)
      const read = r.exitCode === 0 ? parsePipelineOnce(r.stdout) : null
      if (read !== null && read.bad.length === 0) {
        cache.runs = { at: now, value: seenRuns(cache.runs?.value ?? [], read.runs, now) }
        mark('runs', true, now)
      } else {
        const why = read === null ? fail(r) : `unreadable line: ${read.bad[0]?.slice(0, 200)}`
        mark('runs', false, cache.runs?.at ?? null, why)
      }
    } catch (err) {
      mark('runs', false, cache.runs?.at ?? null, String(err))
    }
  }

  // queue: every queueEveryMs. Act mode reads it through queue-watch.sh --once, which logs a
  // `ready` event for each member the stored list lacks (SPEC 3.4); observe mode keeps the
  // plain reader, so the shadow logs no ready events of its own.
  let queueKnown: number[] | null = null
  if (backoffUntil !== null) {
    mark('queue', false, cache.queue?.at ?? null, waiting)
  } else if (cache.queue === undefined || now - cache.queue.at >= cfg.queueEveryMs) {
    try {
      if (stored !== undefined) {
        const known = stored.queueKnown !== null && stored.queueKnown.length > 0 ? stored.queueKnown.join(',') : 'none'
        const r = await run([tool('queue-watch.sh'), '--once', '--repo', rt.repo, '--label', cfg.readyLabel, '--known', known])
        const line = r.exitCode === 0 ? parseQueueOnce(r.stdout) : null
        if (line !== null) {
          cache.queue = { at: now, value: line.now }
          queueKnown = line.now
        }
        mark('queue', line !== null, cache.queue?.at ?? null, line === null ? fail(r) : undefined)
      } else {
        const r = await run(['callum-flow-issue-read', '--json', '--list', '--label', cfg.readyLabel])
        const queue = r.exitCode === 0 ? parseQueue(r.stdout) : null
        if (queue !== null) cache.queue = { at: now, value: queue }
        mark('queue', queue !== null, cache.queue?.at ?? null, queue === null ? fail(r) : undefined)
      }
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
  const mine = (factory?.issues ?? []).filter(i => !i.ended && i.holder === rt.device)
  if (backoffUntil !== null) {
    const ats = [...cache.github.values(), ...cache.timelines.values()].map(c => c.at)
    mark('github', false, ats.length > 0 ? Math.max(...ats) : null, waiting)
  } else {
    const { subIssues } = walkTrackers()
    const wanted = [...new Set([...(cache.queue?.value ?? []), ...mine.map(i => i.number), ...control.only, ...subIssues])]
    const due = wanted
      .filter(n => {
        const c = cache.github.get(n)
        return c === undefined || now - c.at >= cfg.githubEveryMs
      })
      .sort((a, b) => (cache.github.get(a)?.at ?? 0) - (cache.github.get(b)?.at ?? 0))
      .slice(0, GITHUB_READS_PER_PASS)
    let githubOk = true
    // a rate limit seen this pass ends the pass's GitHub reads: each would only hit it again
    for (const n of due) {
      if (limited) {
        githubOk = false
        break
      }
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
      if (limited) {
        githubOk = false
        break
      }
      try {
        const r = await run(['callum-flow-issue-read', '--json', '--timeline', String(n)])
        const subs = r.exitCode === 0 ? parseSubIssues(r.stdout, rt.repo) : null
        if (subs === null) githubOk = false
        else cache.timelines.set(n, { at: now, value: subs })
      } catch {
        githubOk = false
      }
    }
    mark('github', githubOk, now, !githubOk && limited ? 'GitHub rate limit' : undefined)
  }

  // usage: usage-check.sh every usageEveryMs, and the session's own figures every pass
  if (cache.usage === undefined || now - cache.usage.at >= cfg.usageEveryMs) {
    try {
      const r = await run([tool('usage-check.sh')], undefined, 30_000)
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

  // The ledger. Observe mode: what the device's own events prove (SPEC 7.5). Act mode: the
  // store's whenever it holds one; when it holds none, the ledger is rebuilt from a week of
  // events (the facts window would lose older holds). An empty store after a rebuild that found
  // nothing is simply empty: the week is not read again every pass.
  let chosen: { ledger: LedgerEntry[]; source: LedgerSource }
  if (stored === undefined) {
    chosen = choose(null, factory !== null && facts !== null ? deriveLedger(events, factory, facts, rt.device) : null)
  } else if (stored.ledger !== null && stored.ledger.length > 0) {
    // the store holds it, so a later loss is rebuilt again
    cache.rebuilt = undefined
    chosen = choose(stored.ledger, null)
  } else if (cache.rebuilt?.value === 0) {
    chosen = choose(stored.ledger, null)
  } else {
    let derived: LedgerEntry[] | null = null
    let problem = 'the factory source failed'
    if (factory !== null) {
      try {
        const r = await run(eventsSince(REBUILD_DAYS), EVENTS_SQL)
        if (r.exitCode === 0) {
          const week = eventsFromRows(parseCsv(r.stdout))
          derived = deriveLedger(week, factory, factsOf(week), rt.device)
          cache.rebuilt = { at: now, value: derived.length }
        } else {
          problem = fail(r)
        }
      } catch (err) {
        problem = String(err)
      }
    }
    chosen = choose(stored.ledger, derived)
    // a lost ledger the log could not rebuild: the event log is what failed, so say so there,
    // and plan holds what needs it; the rebuild runs again next pass
    if (derived === null) mark('facts', false, sources.facts.at, `the store holds no ledger and the event log could not rebuild it: ${problem}`)
  }
  const ledger = chosen.ledger
  const agents = (await io.agents())
    .filter(a => ledger.some(e => e.agentId === a.id))
    .map(a => ({ id: a.id, type: a.type, status: a.status }))

  // act mode holds GitHub writes while the backoff lasts, and from the pass that met a limit
  let githubBackoffUntil = backoffUntil
  if (stored !== undefined && limited) githubBackoffUntil = Math.max(backoffUntil ?? 0, now + GITHUB_BACKOFF_MS)

  const state = buildState({
    now,
    repo: rt.repo,
    device: rt.device,
    loadedAt,
    sources,
    factory,
    facts,
    runs: rt.runSource === 'local' ? runsFromWatch(cache.runs?.value ?? [], facts) : null,
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
    githubBackoffUntil,
    trackerTitle: cfg.trackerTitle,
  })
  return { state, commands, queueKnown, ledgerSource: chosen.source, rateLimited: limited }
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
