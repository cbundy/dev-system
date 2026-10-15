// observe: run the read-only commands of SPEC 3.3 and assemble the State plan takes. Thin on
// purpose: every output goes straight to a pure parser (parse.ts, derive.ts) and buildState.
// Cadences (config queueEveryMs, githubEveryMs, usageEveryMs, milestoneEveryMs) keep GitHub
// reads well under the rate limit; a failed source keeps its last value with its old time, so
// plan can see how stale it is. Every command runs from the main checkout with the runtime's
// environment (rt.env), which in observe mode sends its event writes to the sink (SPEC 11.1).
// With planner v2 or the v2 shadow, v2/observe.ts reads what v2 adds (v2 SPEC 2.4), and planner
// v2 reads no runs and infers no slot's issue from its reflog.
import { EMPTY_CONTROL, controlFrom } from './config'
import { EVENTS_SQL, deriveLedger, eventsFromRows, factsOf } from './derive'
import type { FactoryEvent } from './derive'
import { rateLimited } from './exec'
import { choose } from './ledger'
import type { LedgerSource } from './ledger'
import {
  parseBrief,
  parseCheckout,
  parseCsv,
  parseDirty,
  parseFactoryState,
  parseIssueRead,
  parseMilestone,
  parsePipelineOnce,
  parsePool,
  parseQueue,
  parseQueueOnce,
  parseReflog,
  parseSubIssues,
  parseUsage,
} from './parse'
import type { Factory } from './parse'
import { ENDED, LIVE, issueFromBranch, listedLive } from './plan'
import { TRACKER_DEPTH, buildState, runsFromWatch, seenRuns } from './state'
import type { GithubIssue, SeenRun } from './state'
import type { Checkout, Config, Control, LedgerEntry, Milestone, Pool, Source, SourceName, State, Usage } from './types'
import { emptyV2Cache, observeV2, readOrder } from './v2/observe'
import type { V2Cache, V2Stored } from './v2/observe'
import type { HeadSeen } from './v2/types'

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
  // $.session.id(), by which v2's workspace rail reads the companion's handshake (v2 SPEC 10.9)
  session?: string
  // the observe-mode event sink (SPEC 11.1), null when acting; env carries it
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
  // the settings v2 runs with (config.ts LoadedConfig.v2), which the v2 shadow plans with; absent:
  // config's
  v2Config?: Config
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
  // the repo it was filled for: a pass for another repo starts it over (resetFor)
  repo?: string
  queue?: Timed<number[]>
  github: Map<number, Timed<GithubIssue>>
  // trackers' direct open sub-issues, from their timelines (D-35)
  timelines: Map<number, Timed<number[]>>
  usage?: Timed<Usage>
  milestone?: Timed<Milestone | null>
  factory?: Timed<Factory>
  events?: Timed<FactoryEvent[]>
  pool?: Timed<Pool>
  // the issue branch each lease of a detached slot was found on (#563), by `<path> <lease id>`:
  // a lease works one issue, so its reflog is read once it names one
  leaseBranches: Map<string, string>
  // runSource local: the last poll's runs, each with when it was first seen as it is
  runs?: Timed<SeenRun[]>
  // act mode: the last ledger rebuilt from the event log, and how many entries it found
  rebuilt?: Timed<number>
  v2: V2Cache
}

export function emptyCache(): Cache {
  return { github: new Map(), timelines: new Map(), leaseBranches: new Map(), v2: emptyV2Cache() }
}

// resetFor: nothing read for one repo may stand in for another's (a queue, a milestone, issue
// facts), so a cache filled for another repo, as when the workspace config names a new one
// without a reload, is emptied in place before the pass reads anything.
function resetFor(cache: Cache, repo: string) {
  if (cache.repo === repo) return
  delete cache.queue
  delete cache.usage
  delete cache.milestone
  delete cache.factory
  delete cache.events
  delete cache.pool
  delete cache.runs
  delete cache.rebuilt
  cache.github.clear()
  cache.timelines.clear()
  cache.leaseBranches.clear()
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
  // a command's stderr showed a GitHub rate limit: register sets the backoff (SPEC 10.2)
  rateLimited: boolean
  // the PR heads v2 has seen (v2 SPEC 2.4), for act mode to keep; null when v2 read nothing
  v2Heads: Record<string, HeadSeen> | null
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
// the ledger, the GitHub backoff and the queue's known list. `v2Stored` is what the store holds
// for v2, read when v2 plans or shadows.
export async function observe(
  io: Io,
  rt: Runtime,
  cache: Cache,
  loadedAt: number,
  lastTitle: string | null,
  stored?: Stored,
  v2Stored?: V2Stored,
): Promise<Observation> {
  resetFor(cache, rt.repo)
  const now = await io.now()
  const cfg = rt.config
  const v2Only = cfg.planner === 'v2'
  const v2On = v2Only || cfg.shadow === 'v2'
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
  } else if (v2Only) {
    mark('runs', false, null, 'not read: planner v2 has no pipeline runs')
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

  // The ledger. Observe mode: what the device's own events prove (SPEC 7.5). Act mode: the
  // store's whenever it holds one; when it holds none, the ledger is rebuilt from a week of
  // events (the facts window would lose older holds). An empty store after a rebuild that found
  // nothing is simply empty: the week is not read again every pass. Read before GitHub, which
  // reads the issues of the loop's running work.
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

  // GitHub per issue, oldest reads first, and first of all the issues the loop may act on or
  // counts as live, so a closed one is known before plan drives it (#556): those of its running
  // work (an entry running, or an agent at work past its answer), this device's issues and every
  // issue in a live stage, and those of a merged Run it that has not answered `done` (its closing
  // ends rule M5's wait). A run is driven only for an issue this device holds, so the watcher's
  // runs add none. Then the queue, and the issues `only` names with the sub-issues their trackers
  // stand for (D-35). An issue known closed is not read again unless the queue, which lists open
  // issues only, names it, or this device holds it (it may be reopened); a failed read keeps the
  // last value.
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
    const first = v2On ? readOrder(v2Stored?.records ?? []) : []
    const wanted = [...new Set([...first, ...working, ...held, ...live, ...runIts, ...queue, ...control.only, ...subIssues])]
    const rank = (n: number) => (first.includes(n) ? first.indexOf(n) - first.length : 0)
    const due = wanted
      .filter(n => {
        const c = cache.github.get(n)
        if (c !== undefined && c.value.facts?.open === false && !queue.includes(n) && !held.includes(n) && !first.includes(n)) return false
        return c === undefined || now - c.at >= cfg.githubEveryMs
      })
      .sort((a, b) => rank(a) - rank(b) || (cache.github.get(a)?.at ?? 0) - (cache.github.get(b)?.at ?? 0))
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

  // the pool slots rule H3 might return (#563). An implementer detaches its slot once the
  // pipeline holds the branch, so a leased slot on no branch is matched to its issue by the newest
  // issue branch its HEAD reflog shows checked out since the lease began (git's own record, per
  // worktree, whoever leased it and whenever the loop loaded); a slot of a finished issue then has
  // its tree read for changes, untracked files too, as `treehouse return` counts them. A failed
  // read leaves the slot unknown, which H3 keeps. Available and busy slots are not read.
  const finishedIssue = (n: number) => {
    const f = factory?.issues.find(i => i.number === n)
    const open = cache.github.get(n)?.value.facts?.open ?? f?.github?.open ?? null
    return open === false || (f !== undefined && ENDED.includes(f.stage))
  }
  const readSlots = async (read: Pool): Promise<Pool> => {
    const found = new Map<string, string>()
    const slots: Pool['slots'] = []
    for (const slot of read.slots) {
      if (slot.state === 'available' || slot.busy) {
        slots.push(slot)
        continue
      }
      let leaseBranch = slot.leaseBranch
      if (leaseBranch === null && slot.lease !== null && slot.leasedAt !== null) {
        const id = `${slot.path} ${slot.lease}`
        leaseBranch = cache.leaseBranches.get(id) ?? null
        if (leaseBranch === null) {
          try {
            const r = await run(['git', '-C', slot.path, '--no-optional-locks', 'reflog', 'show', '--date=unix', '--format=%gd%x09%gs', '-n', '500', 'HEAD'], undefined, 10_000)
            const branches = r.exitCode === 0 ? parseReflog(r.stdout, slot.leasedAt) : null
            leaseBranch = branches?.find(b => issueFromBranch(b) !== null) ?? null
          } catch {
            // unknown: H3 keeps the slot and says so
          }
        }
        if (leaseBranch !== null) found.set(id, leaseBranch)
      }
      const n = leaseBranch === null ? null : issueFromBranch(leaseBranch)
      let dirty: boolean | null = null
      if (n !== null && finishedIssue(n)) {
        try {
          const r = await run(['git', '-C', slot.path, '--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=normal'], undefined, 30_000)
          dirty = r.exitCode === 0 ? parseDirty(r.stdout) : null
        } catch {
          // not read: H3 keeps the slot and says so
        }
      }
      slots.push({ ...slot, leaseBranch, dirty })
    }
    // only the leases still out are remembered
    cache.leaseBranches = found
    return { ...read, slots }
  }

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
      if (pool !== null && !v2Only) pool = await readSlots(pool)
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
    checkout,
  })
  if (!v2On) return { state, commands, queueKnown, ledgerSource: chosen.source, rateLimited: limited, v2Heads: null }
  const read = await observeV2({ io, rt, cache: cache.v2, run, state, stored: v2Stored, poolJson, github: cache.github, backoff: backoffUntil !== null, limited: () => limited })
  return { state: { ...state, v2: read.v2 }, commands, queueKnown, ledgerSource: chosen.source, rateLimited: limited, v2Heads: read.heads }
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
