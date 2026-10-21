// observe: run the read-only commands of v2 SPEC 13.3.3 and assemble the State plan takes. Thin on
// purpose: every output goes straight to a pure parser (parse.ts, derive.ts) and buildState.
// Cadences (config queueEveryMs, githubEveryMs, usageEveryMs, milestoneEveryMs) keep GitHub
// reads well under the rate limit; a failed source keeps its last value with its old time, so
// plan can see how stale it is. Every command runs from the main checkout with the runtime's
// environment (rt.env), which in observe mode sends its event writes to the sink (v2 SPEC 13.11.1).
// v2/observe.ts reads what v2 adds (v2 SPEC 2.4); the loop reads no pipeline runs and infers no
// slot's issue from its reflog.
import { EMPTY_CONTROL, controlFrom } from './config'
import { deriveLedger, factsOf } from './derive'
import type { FactoryEvent } from './derive'
import { rateLimited } from './exec'
import { choose } from './ledger'
import { readIssues } from './observe-github'
import { newestTag, readMilestone, repoTags, tagRepos, waitsOnTag } from './observe-milestone'
import type { LedgerSource } from './ledger'
import {
  parseBrief,
  parseCheckout,
  parseCsv,
  parseFactoryState,
  parsePool,
  parseQueue,
  parseQueueOnce,
  parseSubIssues,
  parseUsage,
} from './parse'
import type { Factory } from './parse'
import { spendEventData, tallyStep, unavailableSpend } from './spend'
import type { ApiKeySettings, Tally } from './spend'
import { LIVE, listedLive } from './foundation'
import { TRACKER_DEPTH, buildState } from './state'
import type { GithubIssue } from './state'
import type { Checkout, Config, Control, LedgerEntry, Milestone, Pool, ReleaseInfo, Source, SourceName, State, Usage } from './types'
import { exitFail, readFacts } from './v2/sources-facts'
import type { FactsShadow } from './v2/sources-facts'
import { emptyV2Cache, lastEnded, observeV2, readDue, readOrder } from './v2/observe'
import type { V2Cache, V2Stored } from './v2/observe'
import type { HeadSeen } from './v2/types'

const GITHUB_READS_PER_PASS = 12
const EVENT_DAYS = 3
// a ledger rebuilt after a lost store reads a week of events: holds older than the facts
// window (a pending decision, an escalation) must survive it, and entries are kept 7 days
export const REBUILD_DAYS = 7
// how long GitHub reads wait after a rate limit (v2 SPEC 13.10 item 2)
export const GITHUB_BACKOFF_MS = 15 * 60_000

// Runtime: what one pass runs as, from the plugin options and both settings files (v2 SPEC 13.4.1).
export type Runtime = {
  mode: 'off' | 'observe' | 'act'
  repo: string
  device: string
  runSource: 'local' | 'events'
  poolSize: number
  cwd: string
  loopDir: string
  // where the step agents' transcripts are (v2/step-tokens.ts): the config dir and the cwd of this session, whose
  // munged name is the project folder; absent in a test's Runtime: no token reading
  configDir?: string
  sessionCwd?: string
  // this session and process, as v2's workspace rail checks the companion's handshake (v2 SPEC 10.9)
  workspace?: { session: string; process?: string }
  // the observe-mode event sink (v2 SPEC 13.11.1), null when acting; env carries it
  sink: string | null
  // the base environment of every command the loop runs, observe and act alike:
  // CALLUM_FLOW_REPO, CALLUM_EVENTS_DIR=<sink> when not acting, and PATH with the workspace
  // config's binDir in front (a testbed runs the branch's own CLIs before a release)
  env: Record<string, string>
  // where pipeline-watch.sh, queue-watch.sh and usage-check.sh live (workspace config toolsDir)
  toolsDir: string
  // the plugin's own directory ($.plugin.root), where the answer script lives (#561)
  pluginRoot: string
  config: Config
  // API-key mode (DEV_CLAUDE_AUTH=api-key): the budget settings from the environment, unparsed (spend.ts);
  // absent: subscription mode, and in a test's Runtime
  apiKey?: ApiKeySettings
  // the container's CPU count (read once per process) and the stop gates the companion may run at once,
  // resolved from config.gateConcurrency; absent in a test's Runtime: no limit
  cpus?: number
  gateConcurrency?: number
  // the container's memory in bytes, read once per process (config.ts gateLimits); null: not readable, so no memory ceiling; absent in a test's Runtime
  memoryBytes?: number | null
  // what loadConfig left out of the repo-local settings, for the decision log
  configProblems: string[]
  // what the repo-local settings file says, no defaults (settings.ts repoLoaded); null: not read
  repoSettings?: Record<string, unknown> | null
}

// Stored: what act mode keeps in $.store across passes and reloads. register.ts reads it
// (`ledger:<repo>` through ledger.ts load, `backoff:<repo>`, `queue-known:<repo>`) and passes
// none in observe mode, which keeps nothing of its own.
export type Stored = {
  // null: the store holds no ledger (a new device, a wiped config), so it is rebuilt from the log
  ledger: LedgerEntry[] | null
  // GitHub reads wait until then after a rate limit (v2 SPEC 13.10 item 2)
  githubBackoffUntil: number | null
  // the queue's last now= list, handed back to queue-watch.sh as --known (v2 SPEC 13.3.4)
  queueKnown: number[] | null
  // when the current starved spell began (S1, v2/rules-starved.ts); null: no spell
  starvedSince?: number | null
}

type Timed<T> = { at: number; value: T }

// Cache: what survives between passes in the module (a reload starts it over).
export type Cache = {
  // the repo it was filled for: a pass for another repo starts it over (resetFor)
  repo?: string
  queue?: Timed<number[]>
  github: Map<number, Timed<GithubIssue>>
  // trackers' direct open sub-issues, from their timelines (D-35)
  timelines: Map<number, Timed<number[]>>
  usage?: Timed<Usage>
  // API-key mode: when the last usage event was written (a reload starts it over)
  usageEvent?: Ms
  milestone?: Timed<Milestone | null>
  release?: Timed<ReleaseInfo>
  // when the oldest closed issue of the milestone closed (observe-milestone.ts)
  closed?: Timed<string | null>
  factory?: Timed<Factory>
  events?: Timed<FactoryEvent[]>
  // the last compare of the facts' two stores (v2/sources-facts.ts); absent: none made this load
  factsShadow?: FactsShadow
  pool?: Timed<Pool>
  // act mode: the last ledger rebuilt from the event log, and how many entries it found
  rebuilt?: Timed<number>
  v2: V2Cache
}

export function emptyCache(): Cache {
  return { github: new Map(), timelines: new Map(), v2: emptyV2Cache() }
}

// resetFor: nothing read for one repo may stand in for another's (a queue, a milestone, issue
// facts), so a cache filled for another repo, as when the workspace config names a new one
// without a reload, is emptied in place before the pass reads anything.
function resetFor(cache: Cache, repo: string) {
  if (cache.repo === repo) return
  delete cache.queue
  delete cache.usage
  delete cache.usageEvent
  delete cache.milestone
  delete cache.release
  delete cache.closed
  delete cache.factory
  delete cache.events
  delete cache.factsShadow
  delete cache.pool
  delete cache.rebuilt
  cache.github.clear()
  cache.timelines.clear()
  cache.v2 = emptyV2Cache()
  cache.repo = repo
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
  // a command's stderr showed a GitHub rate limit: register sets the backoff (v2 SPEC 13.10 item 2)
  rateLimited: boolean
  // the PR heads v2 has seen (v2 SPEC 2.4), for act mode to keep; null when v2 read nothing
  v2Heads: Record<string, HeadSeen> | null
  // API-key mode: the tally after this pass's reading, for an acting pass to store; null: leave it
  spend: Tally | null
}

// Io: the engine calls observe needs, built by register.ts (the only module that holds $).
export type Io = {
  now: () => Promise<number>
  run: (argv: string[], init: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile: (path: string) => Promise<string | null>
  sessionLimits: () => Promise<{ kind: string; percentUsed: number; resetsAt?: string }[]>
  // the process-wide cost in dollars (session usage cost.usd); null: none; absent in a test's Io
  sessionCost?: () => Promise<number | null>
  agents: () => Promise<{ id: string; type: string; status: State['agents'][number]['status'] }[]>
}

// observe: one pass's reads. `stored` is act mode's store (undefined in observe mode): it adds
// the ledger, the GitHub backoff and the queue's known list. `v2Stored` is what the store holds
// for v2.
export async function observe(
  io: Io,
  rt: Runtime,
  cache: Cache,
  loadedAt: number,
  lastTitle: string | null, lastTitleAt: number | null,
  stored?: Stored,
  v2Stored?: V2Stored,
  spendStored?: unknown,
): Promise<Observation> {
  resetFor(cache, rt.repo)
  const now = await io.now()
  const cfg = rt.config
  const commands: string[] = []
  const sources = {} as Record<SourceName, Source>
  let limited = false
  const mark = (name: SourceName, ok: boolean, at: number | null, error?: string) => {
    sources[name] = error === undefined ? { ok, at } : { ok, at, error }
  }
  const run = async (argv: string[], stdin?: string, timeoutMs = 60_000, env = rt.env) => {
    commands.push(argv.join(' ').slice(0, 160))
    const r = await io.run(argv, { cwd: rt.cwd, env, stdin, timeoutMs })
    if (rateLimited(r.stderr)) limited = true
    return r
  }
  const tool = (name: string) => `${rt.toolsDir}/${name}`
  const fail = exitFail
  // act mode: GitHub reads wait out a rate limit (v2 SPEC 13.10 item 2); old values stay, with their age
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

  // facts: the event log, one query, from the store `eventsSource` picks (v2/sources-facts.ts)
  const factsRead = await readFacts({ now, rt, run }, EVENT_DAYS, cache)
  if (factsRead.ok) cache.events = { at: now, value: factsRead.value }
  mark('facts', factsRead.ok, cache.events?.at ?? null, factsRead.ok ? undefined : factsRead.error)
  const factory = cache.factory?.value ?? null
  const events = cache.events?.value ?? []
  const facts = cache.events !== undefined ? factsOf(events) : null

  // runs: the loop reads no pipeline runs. With runSource events (the shadow and the replay) the
  // event log's view of them stands, so the source is as good as the facts.
  if (rt.runSource === 'events') mark('runs', sources.facts.ok, sources.facts.at)
  else mark('runs', false, null, 'not read: the loop has no pipeline runs')

  // The ledger. Observe mode: what the device's own events prove (v2 SPEC 13.7.5). Act mode: the
  // store's whenever it holds one; else it is rebuilt from a `week` of events (the facts window
  // would lose older holds), where v2 reads its logged facts too (7.2). A rebuild that found nothing
  // leaves it empty, and the week is not read every pass. Read before the queue and GitHub: a read
  // older than a label write of the loop's own is due, so it sees what GitHub took.
  let chosen: { ledger: LedgerEntry[]; source: LedgerSource }, week: FactoryEvent[] | null = null
  if (stored === undefined) {
    chosen = choose(null, factory !== null && facts !== null ? deriveLedger(events, rt.device) : null)
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
      const weekRead = await readFacts({ now, rt, run }, REBUILD_DAYS)
      if (weekRead.ok) {
        week = weekRead.value
        derived = deriveLedger(week, rt.device)
        cache.rebuilt = { at: now, value: derived.length }
      } else {
        problem = weekRead.error
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
  const lastLabelWrite = (n?: number) => lastEnded(ledger, e => e.kind === 'label' && e.status === 'done' && (n === undefined || e.issue === n))

  // queue: every queueEveryMs, and the pass after a label write. Act mode reads it through
  // queue-watch.sh --once, which logs a `ready` event for each member the stored list lacks
  // (v2 SPEC 13.3.4); observe mode keeps the plain reader, so the shadow logs no ready events of its own.
  let queueKnown: number[] | null = null
  if (backoffUntil !== null) {
    mark('queue', false, cache.queue?.at ?? null, waiting)
  } else if (readDue(cache.queue?.at, now, cfg.queueEveryMs, lastLabelWrite())) {
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
    mark('queue', true, cache.queue?.at ?? null)
  }

  // GitHub per issue, oldest reads first, and first of all the issues the loop may act on or
  // counts as live, so a closed one is known before plan drives it (#556): those of its running
  // work (an entry running, or an agent at work past its answer), this device's issues and every
  // issue in a live stage, and those of a merged Run it that has not answered `done` (its closing
  // ends rule M5's wait). A run is driven only for an issue this device holds, so the watcher's
  // runs add none. Then the queue, and the issues `only` names with the sub-issues their trackers
  // stand for (D-35). An issue known closed is not read again unless the queue, which lists open
  // issues only, names it, or this device holds it (it may be reopened); a failed read keeps the
  // last value. A read older than a label write of the loop's own or a PR's close is due at once.
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
    const queue = cache.queue?.value ?? []
    const working = ledger
      .filter(e => e.status === 'running' || (e.agentId !== undefined && listedLive(agents, e.agentId)))
      .flatMap(e => (e.issue === null ? [] : [e.issue]))
    const live = (factory?.issues ?? []).filter(i => !i.ended && LIVE.includes(i.stage)).map(i => i.number)
    const runIts = ledger
      .filter(e => e.key.startsWith('task:run-it:') && !(e.status === 'done' && e.outcome?.kind === 'wake' && e.outcome.decision === 'done'))
      .flatMap(e => (e.issue === null ? [] : [e.issue]))
    const held = mine.map(i => i.number)
    // v2's records go first, in v2's read order (v2 SPEC 2.4); then the oldest reads
    const first = readOrder(v2Stored?.records ?? [])
    // the open issues the read issues block: read last, so a chain never starves the issues the loop acts on
    const chain = [...cache.github.values()].flatMap(c => c.value.facts?.blockingList ?? [])
    const named = new Set([...first, ...working, ...held, ...live, ...runIts, ...queue, ...control.only, ...subIssues])
    const wanted = [...new Set([...named, ...chain])]
    const rank = (n: number) => (first.includes(n) ? first.indexOf(n) - first.length : named.has(n) ? 0 : 1)
    const due = wanted
      .filter(n => {
        const c = cache.github.get(n)
        if (c !== undefined && c.value.facts?.open === false && !queue.includes(n) && !held.includes(n) && !first.includes(n)) return false
        return readDue(c?.at, now, cfg.githubEveryMs, Math.max(lastLabelWrite(n), cache.v2.changed[n] ?? -Infinity))
      })
      .sort((a, b) => rank(a) - rank(b) || (cache.github.get(a)?.at ?? 0) - (cache.github.get(b)?.at ?? 0))
      .slice(0, GITHUB_READS_PER_PASS)
    const designing = new Set(mine.filter(i => i.stage === 'designing').map(i => i.number))
    let githubOk = await readIssues(run, due, { repo: rt.repo, cache: cache.github, now, designing, limited: () => limited })
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

  // usage: usage-check.sh every usageEveryMs, and the session's own figures every pass. In API-key mode
  // neither: the session's cost goes into the stored tally every pass (spend.ts) and the reading is spend.
  let spend: Tally | null = null
  let usage: Usage | null
  if (rt.apiKey !== undefined) {
    const apiKey = rt.apiKey
    const cost = await (io.sessionCost?.() ?? Promise.resolve(null)).catch(() => null)
    const step = tallyStep(spendStored, { costUsd: cost, process: rt.workspace?.process ?? '', session: rt.workspace?.session ?? '' }, now, apiKey)
    spend = step.tally
    // a cost that cannot be read keeps the last real reading until it is older than usageStaleMs
    if (step.usage.reason !== 'spend:no-session-cost' || cache.usage?.value.spend == null) cache.usage = { at: now, value: step.usage }
    const stale = now - cache.usage.at >= cfg.usageStaleMs
    usage = stale ? unavailableSpend('spend:stale') : cache.usage.value
    if (cache.usageEvent === undefined || now - cache.usageEvent >= cfg.usageEveryMs) {
      cache.usageEvent = now
      try {
        await run(['callum-flow-event', '--type', 'usage', '--actor', 'watcher', '--data', JSON.stringify(spendEventData(usage))], undefined, 30_000)
      } catch {
        // best effort, as usage-check.sh's own event write
      }
    }
  } else {
    if (cache.usage === undefined || now - cache.usage.at >= cfg.usageEveryMs) {
      try {
        const r = await run([tool('usage-check.sh')], undefined, 30_000)
        cache.usage = { at: now, value: parseUsage(r.stdout.trim()) }
      } catch {
        // unavailable: plan fails open as the skill says
      }
    }
    // a reading older than usageStaleMs counts as unavailable (v2 SPEC 13.3.1)
    const reading = cache.usage !== undefined && now - cache.usage.at < cfg.usageStaleMs ? cache.usage.value : null
    usage = withSession(reading, await io.sessionLimits())
  }
  mark('usage', usage !== null && !usage.unavailable, cache.usage?.at ?? null)

  // pool: the shadow cannot see the shadowed device's pool, so it is assumed from its load
  let pool: Pool | null = null
  let poolJson: string | null = null
  if (rt.runSource === 'events') {
    const busy = mine.filter(i => ['implementing', 'in pipeline', 'parked', 'ready to merge'].includes(i.stage)).length
    pool = { free: Math.max(0, rt.poolSize - busy), total: rt.poolSize, slots: [] }
    mark('pool', true, now)
  } else {
    try {
      const r = await run(['treehouse', 'status', '--json'])
      pool = r.exitCode === 0 ? parsePool(r.stdout, rt.poolSize) : null
      if (pool !== null) poolJson = r.stdout
      if (pool !== null) cache.pool = { at: now, value: pool }
      mark('pool', pool !== null, cache.pool?.at ?? null, pool === null ? fail(r) : undefined)
    } catch (err) {
      mark('pool', false, cache.pool?.at ?? null, String(err))
    }
  }

  // checkout: the main checkout's branch and tracked changes, every pass (rule G5, #544). Agents
  // the loop starts begin there and designers read its code, so one an agent moved holds them.
  // --no-optional-locks: the read never takes the index lock from under an agent's git command.
  let checkout: Checkout
  try {
    const origin = await run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], undefined, 10_000)
    if (origin.exitCode !== 0) {
      // --quiet: a ref that is not set exits 1 with nothing on stderr
      const why = origin.stderr.trim() === '' ? `exit ${origin.exitCode}` : fail(origin)
      checkout = { error: `no origin/HEAD (${why}); git remote set-head origin --auto sets it` }
    } else {
      const status = await run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=no'], undefined, 30_000)
      const read = status.exitCode === 0 ? parseCheckout(origin.stdout, status.stdout) : null
      checkout = read ?? { error: status.exitCode === 0 ? 'git status did not read' : fail(status) }
    }
  } catch (err) {
    checkout = { error: String(err) }
  }

  // milestone and, while it qualifies, the last release (observe-milestone.ts)
  await readMilestone(cache, { now, every: cfg.milestoneEveryMs, repo: rt.repo, base: 'defaultBranch' in checkout ? checkout.defaultBranch : null, run, tagWanted: waitsOnTag(v2Stored?.records ?? []), tagRepos: tagRepos(v2Stored?.records ?? []), backoff: backoffUntil !== null })
  mark('milestone', cache.milestone !== undefined, cache.milestone?.at ?? null)

  // act mode holds GitHub writes and waits while the backoff lasts, and from the pass that met a
  // limit: v2's reads below too, so a wait one of them could not read holds with no clock
  const backoffOf = () => (stored !== undefined && limited ? Math.max(backoffUntil ?? 0, now + GITHUB_BACKOFF_MS) : backoffUntil)

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
    milestone: cache.milestone?.value == null || cache.closed === undefined ? (cache.milestone?.value ?? null) : { ...cache.milestone.value, oldestClosedAt: cache.closed.value },
    release: cache.release?.value ?? null,
    ledger,
    control,
    lastTitle, lastTitleAt,
    githubBackoffUntil: backoffOf(),
    trackerTitle: cfg.trackerTitle,
    checkout,
  })
  const read = await observeV2({ io, rt, cache: cache.v2, run, state, tag: newestTag(cache), tags: repoTags(cache), stored: v2Stored, poolJson, github: cache.github, events: week ?? events, factsShadow: cache.factsShadow, backoff: backoffUntil !== null, limited: () => limited, starvedSince: stored?.starvedSince ?? null })
  return { state: { ...state, githubBackoffUntil: backoffOf(), v2: read.v2 }, commands, queueKnown, ledgerSource: chosen.source, rateLimited: limited, v2Heads: read.heads, spend }
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
