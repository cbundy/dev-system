// factory-loop: the issue orchestrator as one code loop (docs/factory-loop/SPEC.md).
//
// Every passEveryMs, or at once when pinged, a pass reads the factory (observe.ts) and plans
// (plan.ts). In act mode, once the safety rails pass (rails.ts: the act lock, the role, the old
// watcher, another orchestrator's heartbeat), it runs plan's actions through their executors
// (act.ts) and records each in the ledger (ledger.ts), which it keeps in $.store. In observe mode
// (the default), or while a rail holds act mode back, it executes nothing and every command's
// event writes go to a sink (SPEC 11.1). Each pass appends one decision-log line and sets the
// session title. This is the only module that holds $: it builds the engine calls the others
// make, and wires the hooks that feed the ledger between passes (agents' answers, wake turns) and
// the owner's controls (/factory, the control and answer tools).
import type { AgentSpawnArgs, EngineInterface, Register } from 'claude-code'

import {
  actPass,
  agentAnswered,
  breakerEventArgv,
  capEventArgv,
  capKey,
  commandOf,
  logLoop,
  loggedOf,
  passErrorTell,
  retried,
  sendNotice,
  transition,
  updateDone,
  wakeAnswered,
  wakeEnded,
  wakeStarted,
} from './act'
import type { ActEnv, ActReport, Between, Live } from './act'
import { DEFAULT_CONFIG, EMPTY_CONTROL, loadConfig } from './config'
import { CONTROL_TOOL, FACTORY_COMMAND, controlTool, readControl, retryText, runOp, writeControl } from './control'
import type { FileIo } from './control'
import { LOOP_FILES_KEEP_DAYS, pruneArgvs } from './exec'
import type { ActIo } from './exec'
import { finish, load, onLoad, save } from './ledger'
import type { StoreIo } from './ledger'
import { GITHUB_BACKOFF_MS, emptyCache, observe } from './observe'
import type { Io, Runtime, Stored } from './observe'
import { issueFromBranch, plan } from './plan'
import {
  EMPTY_RAIL_MEMORY,
  LOCK_CAS_SCRIPT,
  actLockPath,
  checkRails,
  decideLock,
  holdActLock,
  leaseMsOf,
  newScheduler,
  nextPass,
  noticeTell,
  parseLease,
  passEnded,
  releaseActLock,
  requestPass,
  roleProblem,
  waitOver,
} from './rails'
import type { BreakerNotice, LockIo, Notice, PassSource, RailEnv, RailMemory } from './rails'
import { digestOf } from './state'
import type { Action, AgentStatus, Config, LedgerEntry, Ms, PlanResult, SourceName, State } from './types'
import { ANSWER_TOOL, orphanedWakes } from './wake'

const HOUR = 3_600_000
const FIRST_PASS_AFTER_MS = 5_000
const STATE_KEEP_BYTES = 3_500_000
// recorded states per day at most (observe mode writes one per changed digest): one every five
// minutes on average, which the replay needs, while a churning digest cannot fill the disk
const STATES_PER_DAY = 288
// SPEC 6.1: stop-agent 30 s, title 10 s; the strict lib has no setTimeout, so $.clock times them
const STOP_TIMEOUT_MS = 30_000
const RENAME_TIMEOUT_MS = 10_000
// $.agent.spawn resolves once the agent started; one that never does must not hold the pass
const SPAWN_TIMEOUT_MS = 60_000
// $.prompt.submit resolves once its turn starts, which waits for the session to be idle: a wake
// is taken as queued after this, so a busy session never holds a pass (a late drop still counts)
const SUBMIT_GRACE_MS = 5_000
// three passes in a row that throw tell the owner (SPEC 10.9)
const ERROR_PASSES = 3
const DEFAULT_TOOLS_DIR = '/usr/local/share/callum-tools'

const lastPassRef = { plugin: 'factory-loop', key: 'lastPass' } as const

let started: Promise<void> | undefined
// a session no person reaches (a `-p` run, the SDK) never runs the loop: every Claude process in
// the workspace loads the plugin, the pipeline's own review runs included, and only the
// interactive session may observe or act (D-61)
let headless = false
let loadedAt = 0
let cwd = '.'
let passNo = 0
let lastTitle: string | null = null
let lastDigest: string | null = null
// states written today, and the day the loop dir was last pruned (YYYY-MM-DD)
let statesToday = { day: '', count: 0 }
let prunedDay = ''
const cache = emptyCache()

// The pass scheduler (SPEC 2): one pass at a time, 5 s apart, pings first, with the ping-storm
// breaker (D-39); the timer re-armed when config.passEveryMs changes.
let sched = newScheduler()
let timer: { ms: Ms; cancel: () => void } | null = null
// passes in a row that threw, since when, and whether the owner was told (SPEC 10.9)
let failures = 0
let failingSince: Ms | null = null
let errorTold = false

// The ledger (SPEC 7), loaded from $.store by the first act-mode pass or hook that needs it.
// Every transition replaces live.ledger whole, synchronously (act.ts Live).
// basis: the act lock as it stood when the store was loaded; a write goes back to the store only
// while the lock names this session or still stands so (mayWrite)
const live: Live & { loaded: boolean; repo: string; basis: string | null } = { ledger: [], loaded: false, repo: '', basis: null }
// the last pass's runtime and state, for the hooks between passes
let lastRt: Runtime | null = null
let lastState: State | null = null
// this session held the act lock at some pass, so session.end releases it
let heldLock = false
// agents whose answer is being handled, and when each was first listed completed (act.ts)
const between: Between = { answering: new Set(), completedSeen: new Map() }
let lastWakeAt = 0
// dev-restart-self returned (rule H4): the workspace is about to be replaced, so nothing more is
// started in this module's life, and the next load finds the update done (act.ts updateDone)
let restartAsked: Ms | null = null
// the store refused the last ledger write (persist); null once one succeeds
let saveProblem: string | null = null
// serialized work: ledger saves, the act lock's writes, the hooks that change the ledger, and the
// owner's ops
let saving: Promise<void> = Promise.resolve()
let locking: Promise<unknown> = Promise.resolve()
let loading: Promise<boolean> | null = null
let hooking: Promise<void> = Promise.resolve()
let ops: Promise<unknown> = Promise.resolve()

// One row of $.agent.list(), as observe and the reconciling read it.
type AgentRow = { id: string; type: string; status: AgentStatus }

// Options as the manifest's userConfig gives them; the workspace config file overrides them.
type Options = { mode?: unknown; repo?: unknown; shadowDevice?: unknown; runSource?: unknown }
let options: Options = {}

async function text($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
  } catch {
    return null
  }
}

function json(raw: string | null): Record<string, unknown> {
  try {
    const v = raw === null ? {} : JSON.parse(raw)
    return v !== null && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function configDir($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`
}

// runtime: the settings one pass runs with (SPEC 4.1): plugin options, then the workspace
// file ${CLAUDE_CONFIG_DIR}/factory-loop/config.json, then the repo's .claude/factory-loop.json.
// env is every command's base environment: the repo, the configured labels (callum-flow-claim
// and callum-flow-sweep read them), binDir ahead of PATH when the workspace file names one (a
// testbed runs the branch's own CLIs), and the event sink when the mode is not act.
async function runtime($: EngineInterface): Promise<Runtime> {
  const base = `${await configDir($)}/factory-loop`
  const file = json(await text($, `${base}/config.json`))
  const pick = (key: keyof Options) => (typeof file[key] === 'string' && file[key] !== '' ? file[key] : options[key])
  const checkout = str(file.checkout) || cwd
  let repo = typeof pick('repo') === 'string' && pick('repo') !== '' ? String(pick('repo')) : ''
  if (repo === '') repo = await originOf($, checkout)
  const requested = pick('mode')
  const mode = requested === 'off' || requested === 'act' ? requested : 'observe'
  const shadow = typeof pick('shadowDevice') === 'string' ? String(pick('shadowDevice')) : ''
  const host = (await $.env.get('DEV_MACHINE_NAME')) || ''
  // the shadow device stands in only while nothing can be executed
  const device = shadow !== '' && mode !== 'act' ? shadow : host
  // the repo-local settings, durations and all (SPEC 4.2); what they get wrong is logged
  const loaded = loadConfig(json(await text($, `${checkout}/.claude/factory-loop.json`)))
  const config: Config = { ...loaded.config, mode: mode as Config['mode'] }
  const loopDir = `${base}/${repo.replace('/', '__')}`
  const sink = mode === 'act' ? null : `${loopDir}/sink-events`
  const env: Record<string, string> = {
    CALLUM_FLOW_REPO: repo,
    CALLUM_FLOW_READY_LABEL: config.readyLabel,
    CALLUM_FLOW_IN_DEV_LABEL: config.inDevLabel,
  }
  const binDir = str(file.binDir)
  if (binDir !== '') env.PATH = `${binDir}:${(await $.env.get('PATH')) || '/usr/local/bin:/usr/bin:/bin'}`
  if (sink !== null) env.CALLUM_EVENTS_DIR = sink
  return {
    mode,
    repo,
    device,
    runSource: pick('runSource') === 'events' ? 'events' : 'local',
    poolSize: typeof file.poolSize === 'number' ? file.poolSize : 16,
    cwd: checkout,
    loopDir,
    sink,
    env,
    toolsDir: str(file.toolsDir) || DEFAULT_TOOLS_DIR,
    config,
    configProblems: loaded.problems,
  }
}

// originOf: the GitHub repo (owner/name) the checkout's origin names, or '' when it names none.
async function originOf($: EngineInterface, checkout: string, env?: Record<string, string>): Promise<string> {
  try {
    const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], env === undefined ? { cwd: checkout, timeoutMs: 10_000 } : { cwd: checkout, env, timeoutMs: 10_000 })
    return r.exitCode === 0 ? (r.stdout.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1] ?? '') : ''
  } catch {
    return ''
  }
}

// observing: the runtime of a pass that executes nothing: its events go to the sink (SPEC 11.1).
function observing(rt: Runtime): Runtime {
  const sink = `${rt.loopDir}/sink-events`
  return { ...rt, sink, env: { ...rt.env, CALLUM_EVENTS_DIR: sink } }
}

// acting: the runtime for work the loop did start in act mode (an agent's answer, a wake's
// turn, a notice): its events are real ones.
function acting(rt: Runtime): Runtime {
  const { CALLUM_EVENTS_DIR: _sink, ...env } = rt.env
  return { ...rt, sink: null, env }
}

// within: the work, or a rejection once ms pass on $.clock.
function within<T>($: EngineInterface, ms: Ms, work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = $.clock.after(ms, () => reject(new Error(`${what}: no answer within ${ms / 1000} s`)))
    work.then(
      v => {
        t.cancel()
        resolve(v)
      },
      err => {
        t.cancel()
        reject(err)
      },
    )
  })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// io: the engine calls observe makes, as closures over $ (the validator keeps $ in this file).
// The agent list is read once per pass, before observe (listAgents).
function io($: EngineInterface, agents: AgentRow[]): Io {
  return {
    now: () => $.clock.now(),
    run: (argv, init) => $.process.run(argv, init),
    readFile: path => text($, path),
    sessionLimits: async () => (await $.session.usage()).rateLimits,
    agents: async () => agents,
  }
}

// actIo: the engine calls the act half makes (exec.ts ActIo).
function actIo($: EngineInterface): ActIo {
  return {
    now: () => $.clock.now(),
    run: (argv, init) => $.process.run(argv, init),
    spawnAgent: async input => {
      const args: AgentSpawnArgs = { subagentType: input.subagentType, prompt: input.prompt, description: input.description }
      if (input.name !== undefined) args.name = input.name
      if (input.model !== undefined) args.model = input.model
      const r = await within($, SPAWN_TIMEOUT_MS, $.agent.spawn(args), 'agent spawn')
      if (r.deny !== undefined) return { deny: r.deny }
      return r.agentId === undefined ? {} : { agentId: r.agentId }
    },
    stopAgent: async agentId => {
      const r = await within($, STOP_TIMEOUT_MS, $.tool.call({ tool: 'TaskStop', task_id: agentId }), 'TaskStop')
      if (r.deny !== undefined) return { stopped: false, error: r.deny }
      if (r.isError === true) return { stopped: false, error: r.text ?? 'TaskStop reported an error' }
      return { stopped: true }
    },
    submit: async prompt => {
      const settled = $.prompt.submit({ text: prompt }).then(
        r => (r.drop === undefined ? null : `dropped: ${r.drop}`),
        err => `refused: ${message(err)}`,
      )
      const early = await within($, SUBMIT_GRACE_MS, settled, 'submit').catch(() => 'queued')
      if (early === 'queued') {
        void settled.then(why => (why === null ? undefined : lateDrop($, prompt, why)))
        return
      }
      if (early !== null) throw new Error(`the prompt was ${early}`)
    },
    rename: async title => {
      await within($, RENAME_TIMEOUT_MS, $.command.run({ command: 'rename', args: title }), 'rename')
    },
    usage: async () => {
      const limits = (await $.session.usage()).rateLimits
      const pct = (kind: string) => limits.find(l => l.kind === kind)?.percentUsed ?? null
      return { fiveHour: pct('five_hour'), sevenDay: pct('seven_day') }
    },
    readFile: path => text($, path),
    writeFile: (path, body) => $.fs.write(path, body),
  }
}

function fileIo($: EngineInterface): FileIo {
  return { readFile: path => text($, path), writeFile: (path, body) => $.fs.write(path, body) }
}

// lockIo: the act lock's reads and its one compare-and-set command (rails.ts LOCK_CAS_SCRIPT).
function lockIo($: EngineInterface): LockIo {
  return {
    readFile: path => text($, path),
    cmd: (argv, init) => $.process.run(argv, init.stdin === undefined ? { timeoutMs: init.timeoutMs } : { stdin: init.stdin, timeoutMs: init.timeoutMs }),
  }
}

// lockOp: one write of the act lock at a time from this module (a pass's renewals, session.end).
function lockOp<T>(work: () => Promise<T>): Promise<T> {
  const run = locking.then(work)
  locking = run.catch(() => undefined)
  return run
}

async function append($: EngineInterface, path: string, line: string) {
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], { stdin: line, timeoutMs: 10_000 })
}

// appendLine: one more decision-log line, beside the pass lines: an owner op, a turn's
// problems, a pass that threw (SPEC 12).
async function appendLine($: EngineInterface, rt: Runtime, line: Record<string, unknown>) {
  const at = new Date(await $.clock.now()).toISOString()
  await append($, `${rt.loopDir}/decisions-${at.slice(0, 10)}.jsonl`, JSON.stringify({ v: 1, at, ...line }) + '\n').catch(() => undefined)
}

async function setTitle($: EngineInterface, title: string) {
  if (title === lastTitle) return
  await $.command.run({ command: 'rename', args: title })
  lastTitle = title
}

// wakeIdAt: a fresh wake id, from the clock so it stays unique across restarts (SPEC 8.1).
function wakeIdAt(now: Ms): string {
  lastWakeAt = Math.max(now, lastWakeAt + 1)
  return `w${lastWakeAt.toString(36)}`
}

// --- the store: the ledger, the backoff, the queue's known list, rail memory, notices --------

const keysOf = (repo: string) => ({
  backoff: `backoff:${repo}`,
  known: `queue-known:${repo}`,
  rails: `rails:${repo}`,
  notices: `notices:${repo}`,
})

// mayLoad: no other session holds a live act lease, so this one may load the store's ledger, which
// is then fresh. The act lock is the one writer's lease (SPEC 11.2).
async function mayLoad($: EngineInterface, rt: Runtime): Promise<{ ok: boolean; basis: string | null }> {
  try {
    const basis = await text($, actLockPath(rt.loopDir))
    return { ok: decideLock(basis, await $.session.id(), await $.clock.now(), leaseMsOf(rt.config)).hold, basis }
  } catch {
    return { ok: false, basis: null }
  }
}

// mayWrite: the ledger in memory is still the store's truth: the act lock names this session, or
// stands as it did at the load (a session the rails keep in observe, sending a notice). A lease
// another session wrote since, live or expired, means that session kept the ledger meanwhile: this
// one never writes over it, and reloads the store before it acts again.
async function mayWrite($: EngineInterface, rt: Runtime): Promise<boolean> {
  try {
    const now = await text($, actLockPath(rt.loopDir))
    return parseLease(now)?.session === (await $.session.id()) || now === live.basis
  } catch {
    return false
  }
}

// ensureLedger: the ledger in memory, loaded from the store once per module load (and again
// when this session takes the act lock over from another), with every running command entry
// marked lost (SPEC 7.5). A store that cannot be read leaves it unloaded: falling back to the
// event log would overwrite the real ledger at the next save.
async function ensureLedger($: EngineInterface, rt: Runtime, problems: string[]): Promise<boolean> {
  if (live.loaded && live.repo === rt.repo) return true
  // a pass and a hook that both need it load it once
  loading ??= loadLedger($, rt, problems).finally(() => {
    loading = null
  })
  return loading
}

async function loadLedger($: EngineInterface, rt: Runtime, problems: string[]): Promise<boolean> {
  const may = await mayLoad($, rt)
  if (!may.ok) return false
  let stored: LedgerEntry[] | null
  try {
    stored = await load(storeIo($), rt.repo)
  } catch (err) {
    problems.push(`ledger: the store could not be read: ${message(err).slice(0, 200)}`)
    return false
  }
  live.ledger = stored ?? []
  live.logged = loggedOf(live.ledger)
  live.loaded = true
  live.repo = rt.repo
  live.basis = may.basis
  const now = await $.clock.now()
  const env = hookEnv($, rt, now)
  // running commands died with the old module; wakes another session submitted went with it
  const session = await $.session.id()
  const moved = transition(live, l => onLoad(l, now))
  for (const u of orphanedWakes(live.ledger, session)) moved.push(...transition(live, l => finish(l, u.key, u, now)))
  await persist($, rt)
  await logLoop(env, moved)
  problems.push(...env.problems)
  return true
}

// persist: write the live ledger, one save at a time; whether it was written. save prunes it, and
// the memory takes what was written unless a transition came in meanwhile (the next save prunes
// that). A store that refuses the write is kept in saveProblem until a save succeeds: the pass
// reports it, and nothing starts while the ledger cannot be saved (act.ts actOne).
function persist($: EngineInterface, rt: Runtime): Promise<boolean> {
  const run = saving.then(async (): Promise<boolean> => {
    if (!live.loaded) return false
    if (!(await mayWrite($, rt))) {
      // another session acts now: it keeps the ledger, and this one reloads before it acts again
      live.loaded = false
      return false
    }
    const snapshot = live.ledger
    try {
      const written = await save(storeIo($), rt.repo, snapshot, await $.clock.now())
      if (live.ledger === snapshot) live.ledger = written
      saveProblem = null
      return true
    } catch (err) {
      saveProblem = message(err).slice(0, 200)
      return false
    }
  })
  saving = run.then(
    () => undefined,
    () => undefined,
  )
  return run.catch(() => false)
}

// storeIo: ledger.ts's StoreIo over $.store.
function storeIo($: EngineInterface): StoreIo {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) }
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: EngineInterface, key: string, value: unknown, problems: string[]) {
  try {
    await $.store.set(key, value)
  } catch (err) {
    problems.push(`store: ${key} not saved: ${message(err).slice(0, 200)}`)
  }
}

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function railMemoryFrom(raw: unknown): RailMemory {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const hb = o.heartbeat as Record<string, unknown> | null | undefined
  const w = o.watcher as Record<string, unknown> | null | undefined
  return {
    heartbeat: hb && isMs(hb.since) && typeof hb.device === 'string' ? { since: hb.since, device: hb.device } : EMPTY_RAIL_MEMORY.heartbeat,
    watcher: w && isMs(w.since) && typeof w.pid === 'string' ? { since: w.since, pid: w.pid, seenAt: isMs(w.seenAt) ? w.seenAt : w.since } : EMPTY_RAIL_MEMORY.watcher,
  }
}

// Notices that come from outside plan wait here until no wake is open; caps are the hourly
// rate-cap loop events already logged.
type NoticeBook = { pending: Notice[]; caps: string[] }

function noticeOf(raw: unknown): Notice | null {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (o === null || !isMs(o.since)) return null
  if (o.kind === 'heartbeat-other' && typeof o.device === 'string') return { kind: o.kind, device: o.device, since: o.since }
  if (o.kind === 'old-watcher' && typeof o.pid === 'string') return { kind: o.kind, pid: o.pid, since: o.since }
  if (o.kind === 'breaker' && isMs(o.until) && isMs(o.passes)) return { kind: o.kind, since: o.since, until: o.until, passes: o.passes }
  return null
}

function noticesFrom(raw: unknown): NoticeBook {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pending = Array.isArray(o.pending) ? o.pending.map(noticeOf).filter((n): n is Notice => n !== null) : []
  const caps = Array.isArray(o.caps) ? o.caps.filter((c): c is string => typeof c === 'string') : []
  return { pending, caps }
}

// stale: a notice whose spell ended before it could go out says nothing true any more.
function stale(n: Notice, memory: RailMemory | null, now: Ms): boolean {
  if (n.kind === 'breaker') return now >= n.until
  if (memory === null) return false
  if (n.kind === 'heartbeat-other') return memory.heartbeat?.since !== n.since
  return memory.watcher?.since !== n.since
}

// --- the scheduler (SPEC 2, D-39) ---------------------------------------------------------------

// request: a timer tick or a ping asks for a pass; the scheduler decides when it starts. The
// pass runs with the $ of whoever asked (a timer's closure, a hook's own).
async function request($: EngineInterface, source: PassSource) {
  if (headless) return
  sched = requestPass(sched, source, await $.clock.now())
  await step($)
}

// ask: request a pass with the $ the loop's timers run with, made once per load (ensure), so a
// ping from a hook never runs a pass on that hook's own dispatch.
let ask: ((source: PassSource) => void) | null = null

// ping: an agent of the loop finished, a wake was answered, an owner control arrived.
function ping() {
  ask?.('ping')
}

async function step($: EngineInterface) {
  const now = await $.clock.now()
  const r = nextPass(sched, now)
  sched = r.scheduler
  if (r.next.do === 'start') {
    void runPass($, r.notice)
      .catch(() => undefined)
      .finally(() => {
        sched = passEnded(sched)
        void step($).catch(() => undefined)
      })
  } else if (r.next.do === 'wait') {
    $.clock.after(r.next.ms, () => {
      sched = waitOver(sched)
      void step($).catch(() => undefined)
    })
  }
}

function rearm($: EngineInterface, ms: Ms) {
  if (timer?.ms === ms) return
  timer?.cancel()
  const t = $.clock.every(ms, () => void request($, 'timer').catch(() => undefined))
  timer = { ms, cancel: () => t.cancel() }
}

// --- one pass (SPEC 2) ----------------------------------------------------------------------------

// listAgents: one agent list per pass. Only a successful read may mark agents lost.
async function listAgents($: EngineInterface): Promise<{ ok: boolean; agents: AgentRow[] }> {
  try {
    return { ok: true, agents: (await $.agent.list()).map(a => ({ id: a.id, type: a.type, status: a.status })) }
  } catch {
    return { ok: false, agents: [] }
  }
}

async function railEnv($: EngineInterface): Promise<RailEnv> {
  return {
    DEV_ROLE: await $.env.get('DEV_ROLE'),
    ORCHESTRATOR_WATCH_LOCK_DIR: await $.env.get('ORCHESTRATOR_WATCH_LOCK_DIR'),
    XDG_RUNTIME_DIR: await $.env.get('XDG_RUNTIME_DIR'),
    TMPDIR: await $.env.get('TMPDIR'),
  }
}

// hookEnv: an act step's environment outside a pass (a hook, a notice): real events.
function hookEnv($: EngineInterface, rt: Runtime, now: Ms, session = ''): ActEnv {
  return {
    io: actIo($),
    rt: acting(rt),
    live,
    commands: [],
    wakeId: () => wakeIdAt(now),
    session,
    save: () => persist($, rt),
    holds: async () => true,
    problems: [],
  }
}

// bareState: a state for an act step outside a pass when none was planned yet this load.
function bareState(rt: Runtime, now: Ms): State {
  const off = { ok: false, at: null }
  const names: SourceName[] = ['factory', 'facts', 'runs', 'queue', 'github', 'usage', 'pool', 'milestone']
  return {
    now,
    repo: rt.repo,
    device: rt.device,
    loadedAt,
    sources: Object.fromEntries(names.map(n => [n, off])) as State['sources'],
    usage: { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true },
    issues: [],
    queue: [],
    runs: [],
    pool: null,
    agents: [],
    milestone: null,
    ledger: live.ledger,
    control: EMPTY_CONTROL,
    lastTitle,
    githubBackoffUntil: null,
  }
}

async function runPass($: EngineInterface, breaker: BreakerNotice | null) {
  let rt: Runtime | undefined
  try {
    rt = await runtime($)
    lastRt = rt
    rearm($, rt.config.passEveryMs)
    const off = rt.mode === 'off' || (await killed($))
    if (off || rt.repo === '') {
      await setTitle($, `🔄 ${rt.repo.split('/')[1] ?? 'loop'} · off`)
    } else {
      passNo += 1
      await pass($, rt, breaker)
    }
    failures = 0
    failingSince = null
    errorTold = false
  } catch (err) {
    failures += 1
    const now = await $.clock.now()
    failingSince ??= now
    if (rt !== undefined) {
      await appendLine($, rt, { pass: passNo, error: String(err).slice(0, 500), failures })
      const name = rt.repo.split('/')[1] ?? 'loop'
      const title = lastTitle === null ? `🔄 ${name} · error` : lastTitle.endsWith(' · error') ? lastTitle : `${lastTitle} · error`
      await setTitle($, title).catch(() => undefined)
      if (failures >= ERROR_PASSES && rt.mode === 'act' && !errorTold) errorTold = await tellError($, rt, now, String(err))
    }
  }
}

// tellError: three passes in a row threw; the owner hears of it once (SPEC 10.9), from a session
// that may act: a role the rails refuse tells nothing, as checkRails does.
async function tellError($: EngineInterface, rt: Runtime, now: Ms, error: string): Promise<boolean> {
  try {
    const problems: string[] = []
    if (roleProblem(await $.env.get('DEV_ROLE'), rt.config) !== null || (await killed($))) return false
    if (!(await ensureLedger($, rt, problems))) return false
    const env = hookEnv($, rt, now, await $.session.id())
    const sent = await sendNotice(env, lastState ?? bareState(rt, now), passErrorTell(failingSince ?? now, failures, error))
    return sent === 'sent'
  } catch {
    return false
  }
}

async function pass($: EngineInterface, rt: Runtime, breaker: BreakerNotice | null) {
  const now = await $.clock.now()
  const keys = keysOf(rt.repo)
  const listed = await listAgents($)
  const commands: string[] = []
  const problems: string[] = []
  let railReasons: string[] = []
  let memory: RailMemory | null = null
  let book: NoticeBook = { pending: [], caps: [] }
  let booked = JSON.stringify(book)
  let act = false
  let sid = ''

  // the rails, at the start of every act-mode pass, before anything acts (SPEC 11.2)
  if (rt.mode === 'act') {
    const aio = actIo($)
    sid = await $.session.id()
    const remembered = railMemoryFrom(await storeGet($, keys.rails))
    // the CLIs act on the checkout's own origin, the gh executors on rt.repo: they must be one
    // repo, or a merge lands in one and its follow-ups in the other (SPEC 11.5)
    const origin = await originOf($, rt.cwd, rt.env)
    const refusals = origin.toLowerCase() === rt.repo.toLowerCase() ? [] : [`repo: the checkout ${rt.cwd} is ${origin === '' ? 'no GitHub repository' : origin}, not ${rt.repo}`]
    // the rails' probes join the pass's command list; the lease's write does not
    const logged = commandOf(aio, rt, commands)
    const rails = await checkRails(
      { cmd: (argv, init) => (argv[2] === LOCK_CAS_SCRIPT ? lockIo($).cmd(argv, init) : logged(argv, init)), readFile: aio.readFile },
      { repo: rt.repo, device: rt.device, session: sid, loopDir: rt.loopDir, config: rt.config, env: await railEnv($), now, memory: remembered, refusals },
    )
    memory = rails.memory
    railReasons = rails.reasons
    act = rails.act
    if (JSON.stringify(rails.memory) !== JSON.stringify(remembered)) await storeSet($, keys.rails, rails.memory, problems)
    if (rails.lock !== null && rails.lock.held) {
      heldLock = true
      // another session's lease ran out under it: the store holds its ledger, the truth now
      if (rails.lock.took !== null) live.loaded = false
    }
    book = noticesFrom(await storeGet($, keys.notices))
    booked = JSON.stringify(book)
    const fresh: Notice[] = breaker === null ? rails.notices : [...rails.notices, breaker]
    for (const n of fresh) if (!book.pending.some(p => noticeTell(p).key === noticeTell(n).key)) book.pending.push(n)
    if (breaker !== null) await commandOf(aio, acting(rt), commands)(breakerEventArgv(breaker), { timeoutMs: 60_000 }).catch(() => undefined)
    if (act && restartAsked !== null) {
      act = false
      railReasons.push(`restart: dev-restart-self asked for a new workspace at ${new Date(restartAsked).toISOString()}; nothing acts until it restarts`)
    }
    if (act && !(await ensureLedger($, rt, problems))) {
      act = false
      railReasons.push('ledger: not loaded, so nothing is acted on this pass')
    }
  }

  // observe: act mode reads the store's ledger, backoff and queue list; anything else runs as
  // observe, its events to the sink
  const passRt = act ? rt : rt.mode === 'act' ? observing(rt) : rt
  let stored: Stored | undefined
  if (act) {
    const backoff = await storeGet($, keys.backoff)
    const known = await storeGet($, keys.known)
    stored = {
      ledger: live.ledger.length > 0 ? live.ledger : null,
      githubBackoffUntil: isMs(backoff) ? backoff : null,
      queueKnown: Array.isArray(known) && known.every(n => typeof n === 'number') ? known : null,
    }
  }
  // A shadow watches another session: this module's own load says nothing about when that
  // session restarted, so the first-pass heartbeat (rule H1) is left to real lease timing.
  const shadowing = rt.device !== ((await $.env.get('DEV_MACHINE_NAME')) || '')
  const observed = await observe(io($, listed.agents), passRt, cache, shadowing ? 0 : loadedAt, lastTitle, stored)
  let state = observed.state
  // an acting pass renews its lease before every action and on a timer while it runs, so no
  // step outlives it; once another session holds it, this pass runs nothing more and keeps the
  // ledger no longer (the next pass that holds it reloads the store)
  let holding = true
  const renew = async (): Promise<boolean> => {
    if (!holding) return false
    const path = actLockPath(rt.loopDir)
    // a save that found the lock another session's let the ledger go: nothing more acts on it
    const lock = live.loaded ? await lockOp(async () => holdActLock(lockIo($), path, sid, await $.clock.now(), leaseMsOf(rt.config))) : null
    if (lock !== null && lock.held && lock.took === null) return true
    holding = false
    live.loaded = false
    if (lock !== null && !lock.held) problems.push(lock.reason)
    else {
      // a lease taken over mid-pass, or written meanwhile, was another session's: its ledger is the truth
      const other = lock?.took?.session ?? parseLease(await text($, path))?.session ?? 'unknown'
      problems.push(`act lock: session ${other} held it during this pass; this one keeps the ledger no longer`)
    }
    return false
  }
  // a save writes only while this pass holds the lease, and persist checks it again
  const save = async (): Promise<boolean> => {
    if (act && !holding) return false
    return persist($, rt)
  }
  const holds = () => (act ? renew() : Promise.resolve(holding))
  const env: ActEnv = { io: actIo($), rt, live, commands, wakeId: () => wakeIdAt(state.now), session: sid, save, holds, problems }

  let report: ActReport | null = null
  let result: PlanResult
  const told: string[] = []
  const renewal = act ? $.clock.every(rt.config.passEveryMs, () => void renew().catch(() => undefined)) : null
  try {
    if (act) {
      // a lost store, rebuilt from the event log, becomes the ledger the loop keeps
      if (observed.ledgerSource === 'events' && live.ledger.length === 0 && state.ledger.length > 0) {
        live.ledger = [...state.ledger]
        live.logged = loggedOf(live.ledger)
        await persist($, rt)
      }
      // the restart for an update ran: the update is done, so the drain ends (rule H4)
      if (updateDone(live.ledger, state.control, loadedAt) && (await clearUpdate($, rt, state.control.updateDue?.at ?? null))) {
        state = { ...state, control: { ...state.control, updateDue: null } }
      }
      const acted = await actPass(env, state, listed, between)
      state = acted.state
      result = acted.result
      report = acted.report
      lastState = state
      if (report.outcomes.some(o => o.kind === 'restart-self' && o.status === 'done')) restartAsked = state.now
      if (report.title !== null) lastTitle = report.title
      // a rate-cap hold has no entry of its own: one loop event per cap per hour (SPEC 11.4)
      const hour = `:${Math.floor(state.now / HOUR)}`
      for (const capped of result.capped) {
        const key = capKey(capped, state.now)
        if (book.caps.includes(key)) continue
        const r = await commandOf(env.io, rt, commands)(capEventArgv(capped, state.now), { timeoutMs: 60_000 }).catch(() => null)
        if (r !== null && r.exitCode === 0) book.caps.push(key)
      }
      book.caps = book.caps.filter(k => k.endsWith(hour))
    } else {
      // a pass that may not act plans as observe mode does, and its title says so
      const config: Config = rt.mode === 'act' ? { ...rt.config, mode: 'observe' } : rt.config
      result = plan(state, config)
      await setTitle($, result.title)
    }

    // notices from outside plan go out once no wake is open, acting or not (SPEC 9.2, 11.2), until a
    // restart was asked for
    if (rt.mode === 'act' && restartAsked === null) {
      book.pending = book.pending.filter(n => !stale(n, memory, state.now))
      if (book.pending.length > 0 && (act || (await ensureLedger($, rt, problems)))) {
        const nenv: ActEnv = { ...env, rt: acting(rt) }
        let waiting = false
        for (const n of book.pending) {
          const tell = noticeTell(n)
          if (waiting || live.ledger.some(e => e.key === tell.key && e.status !== 'lost')) continue
          const sent = await sendNotice(nenv, state, tell)
          if (sent === 'sent') told.push(tell.key)
          else waiting = true
        }
        // a notice stays until its tell ended: one the engine dropped after the submit (lost,
        // lateDrop) goes out once more
        book.pending = book.pending.filter(n => {
          const e = live.ledger.find(x => x.key === noticeTell(n).key)
          return e === undefined || e.status === 'running' || e.status === 'lost'
        })
      }
      if (JSON.stringify(book) !== booked) await storeSet($, keys.notices, book, problems)
    }
  } finally {
    renewal?.cancel()
  }

  // what act mode keeps for the next pass: the queue's known list and the GitHub backoff
  if (act) {
    if (observed.queueKnown !== null) await storeSet($, keys.known, observed.queueKnown, problems)
    const limited = report?.rateLimited === true ? state.now + GITHUB_BACKOFF_MS : 0
    const until = Math.max(state.githubBackoffUntil ?? 0, limited)
    if (until > state.now) await storeSet($, keys.backoff, until, problems)
  }

  if (act && saveProblem !== null) problems.push(`ledger: not saved, so nothing starts until a save succeeds: ${saveProblem}`)
  const digest = digestOf(state)
  const at = new Date(state.now).toISOString()
  const issues = state.issues
  const line = {
    v: 1,
    at,
    pass: passNo,
    // pass numbers restart when the module reloads; the load time tells the runs apart
    loaded: new Date(loadedAt).toISOString(),
    mode: rt.mode,
    executed: act,
    device: rt.device,
    tier: result.tier,
    digest,
    sources: Object.fromEntries(
      Object.entries(state.sources).map(([k, s]) => [k, s.ok ? 'ok' : `failed${s.error ? `: ${s.error}` : ''}`]),
    ),
    counts: {
      queued: state.queue.length,
      dev: issues.filter(i => i.stage === 'designing' || i.stage === 'implementing').length,
      pipeline: issues.filter(i => i.stage === 'in pipeline' || i.stage === 'parked').length,
      merge: issues.filter(i => i.stage === 'ready to merge').length,
      owner: result.owner,
    },
    actions: result.actions.filter(a => a.kind !== 'title').map(summaryOf),
    skipped: result.skipped.slice(0, 60),
    outcomes: report?.outcomes.filter(o => o.kind !== 'title').map(o => ({ key: o.key, status: o.status, ms: o.ms, summary: o.summary })),
    capped: result.capped.length > 0 ? result.capped : undefined,
    atCap: result.atCap ? true : undefined,
    rails: railReasons.length > 0 ? railReasons : undefined,
    ledgerSource: act ? observed.ledgerSource : undefined,
    breaker: breaker === null ? undefined : { since: new Date(breaker.since).toISOString(), until: new Date(breaker.until).toISOString(), passes: breaker.passes },
    told: told.length > 0 ? told : undefined,
    config: rt.configProblems.length > 0 ? rt.configProblems : undefined,
    problems: problems.length > 0 ? problems : undefined,
    commands: [...observed.commands, ...commands],
    title: result.title,
  }
  await append($, `${rt.loopDir}/decisions-${at.slice(0, 10)}.jsonl`, JSON.stringify(line) + '\n')
  // full states for the replay harness, in observe mode only (SPEC 4.2 recordStates), a day's worth
  // at most
  const day = at.slice(0, 10)
  if (statesToday.day !== day) statesToday = { day, count: 0 }
  if (digest !== lastDigest && rt.mode !== 'act' && statesToday.count < STATES_PER_DAY) {
    const body = JSON.stringify(state)
    if (body.length < STATE_KEEP_BYTES) {
      await $.fs.write(`${rt.loopDir}/states/${day}/${passNo}.json`, body)
      statesToday.count += 1
    }
    lastDigest = digest
  }
  // once a day, the loop dir's files older than the ledger's week go (SPEC 11.6)
  if (prunedDay !== day) {
    prunedDay = day
    for (const argv of pruneArgvs(rt.loopDir, LOOP_FILES_KEEP_DAYS)) await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
  }
  await $.state.set(lastPassRef, {
    pass: passNo,
    at: state.now,
    mode: rt.mode,
    executed: act,
    rails: railReasons,
    tier: result.tier,
    title: result.title,
    actions: line.actions.length,
    owner: result.owner,
  })
  // the title says error until the store takes the ledger again (SPEC 10.9)
  if (act && saveProblem !== null) throw new Error(`ledger: not saved: ${saveProblem}`)
}

function summaryOf(a: Action) {
  return {
    key: a.key,
    kind: a.kind,
    class: a.class,
    rule: a.rule,
    issue: a.issue,
    agent: a.kind === 'spawn' ? a.agent : undefined,
    run: 'run' in a && typeof a.run === 'string' ? a.run : undefined,
    pr: 'pr' in a && typeof a.pr === 'number' ? a.pr : undefined,
    reason: a.reason,
  }
}

// clearUpdate: control.json without updateDue, once the restart for it ran (rule H4).
async function clearUpdate($: EngineInterface, rt: Runtime, at: Ms | null): Promise<boolean> {
  if (at === null) return false
  const run = ops.then(async () => {
    const fio = fileIo($)
    const loaded = await readControl(fio, rt.loopDir)
    if (loaded.error !== null || loaded.control.updateDue?.at !== at) return false
    await writeControl(fio, rt.loopDir, { ...loaded.control, updateDue: null })
    await appendLine($, rt, { control: 'update off', text: `restart:${at} ran: the update is done and the drain ends` })
    return true
  })
  ops = run.catch(() => undefined)
  return run.catch(() => false)
}

// --- between passes: the hooks that feed the ledger ---------------------------------------------

// hook: hook work that reads and changes the ledger, one at a time and in the order the events
// came (a wake's turn.start before its turn.complete).
function hook(work: () => Promise<void>): Promise<void> {
  const run = hooking.then(work)
  hooking = run.catch(() => undefined)
  return hooking
}

// ledgerFor: the runtime a hook works with, while the loop is in act mode with no kill switch
// (SPEC 11.1, 11.3: observe and off log no real event and keep no ledger), once the ledger is
// loaded: by this module already, or now (an answer that comes before the first pass after a
// reload).
async function ledgerFor($: EngineInterface): Promise<Runtime | null> {
  if (headless) return null
  const rt = lastRt ?? (await runtime($).catch(() => null))
  if (rt === null || rt.repo === '' || rt.mode !== 'act' || (await killed($))) return null
  if (live.loaded && live.repo === rt.repo) return rt
  return (await ensureLedger($, rt, [])) ? rt : null
}

// killed: the kill switch exists (SPEC 11.3).
async function killed($: EngineInterface): Promise<boolean> {
  return $.fs.exists(`${await configDir($)}/factory-loop/OFF`)
}

// actsNow: the loop may start something (a reminder): act mode, no kill switch, and no restart
// asked for.
async function actsNow($: EngineInterface, rt: Runtime): Promise<boolean> {
  return rt.mode === 'act' && restartAsked === null && !(await killed($))
}

// turn.start: a wake's own turn takes its turn id.
async function turnStarted($: EngineInterface, said: string, turnId: string) {
  if (!/^(JUDGE|TASK|TELL) /m.test(said)) return
  const rt = await ledgerFor($)
  if (rt === null) return
  await wakeStarted(hookEnv($, rt, await $.clock.now()), said, turnId)
}

type TurnEnded = { turnId: string; answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }

// turn.complete of the main loop: answers close their wakes, a tell's turn delivers it, and an
// unanswered wake gets its one reminder (act.ts wakeEnded); then a ping.
async function mainTurnEnded($: EngineInterface, e: TurnEnded) {
  const rt = await ledgerFor($)
  if (rt === null) return
  const env = hookEnv($, rt, await $.clock.now())
  const out = await wakeEnded(env, e)
  // never awaited here: a submitted prompt resolves once its turn starts, after this one ends
  if (out.prompts.length > 0 && (await actsNow($, rt))) {
    for (const p of out.prompts) void env.io.submit(p).catch(err => appendLine($, rt, { turn: e.turnId, problems: [`reminder not sent: ${message(err)}`] }))
  }
  const problems = [...out.problems, ...env.problems]
  if (problems.length > 0) await appendLine($, rt, { turn: e.turnId, problems })
  if (out.moved) ping()
}

// turn.complete of an agent of the loop: its answer recorded (act.ts agentAnswered), then a ping.
async function agentTurnEnded($: EngineInterface, e: TurnEnded & { agentId: string }) {
  const rt = await ledgerFor($)
  if (rt === null) return
  const now = await $.clock.now()
  const env = hookEnv($, rt, now)
  const r = await agentAnswered(env, lastState ?? bareState(rt, now), { agentId: e.agentId, answer: e.answer, reason: e.reason }, between)
  const problems = [...(r.why === undefined ? [] : [`${r.why}: dropped`]), ...env.problems]
  if (problems.length > 0) await appendLine($, rt, { agent: e.agentId, problems })
  if (r.result === 'applied') ping()
}

// lateDrop: a wake prompt the engine dropped after it was taken as queued started no turn: it is
// lost with its attempt given back, as a drop within the grace uses none (wake.ts), so plan asks
// again; its loop event says so, since its start was logged. A wake whose turn already started is
// left alone (a reminder's drop changes nothing).
async function lateDrop($: EngineInterface, prompt: string, why: string) {
  const id = /\bid=(\S+)/.exec(prompt.split('\n', 1)[0] ?? '')?.[1]
  if (id === undefined) return
  await hook(async () => {
    const rt = await ledgerFor($)
    if (rt === null) return
    const now = await $.clock.now()
    const moved = transition(live, l => {
      const e = l.find(x => x.wakeId === id && x.status === 'running' && x.turnId === undefined)
      if (e === undefined) return l
      const given = { ...e, status: 'lost' as const, attempts: Math.max(0, e.attempts - 1), endedAt: now, summary: `submit ${why}`.slice(0, 200) }
      return l.map(x => (x.key === e.key ? given : x))
    })
    if (moved.length === 0) return
    await persist($, rt)
    await logLoop(hookEnv($, rt, now), moved)
  })
}

// releaseLock: at session.end this session's lease expires, so the next session acts at once.
async function releaseLock($: EngineInterface, sessionId: string) {
  if (!heldLock || lastRt === null) return
  const loopDir = lastRt.loopDir
  await lockOp(async () => releaseActLock(lockIo($), actLockPath(loopDir), sessionId, await $.clock.now()))
  heldLock = false
}

// --- the owner's controls (SPEC 4.3, D-38) -------------------------------------------------------

type OpAnswer = { ok: boolean; text: string }

// ownerOp: /factory <op> and the control tool, one at a time (control.json is read, changed and
// written whole). A change pings the loop and gets its own decision-log line; retry clears the
// issue's exhausted entries through the ledger.
function ownerOp($: EngineInterface, input: string | Record<string, unknown>, agentId: string | undefined): Promise<OpAnswer> {
  const run = ops.then(async (): Promise<OpAnswer> => {
    const rt = lastRt ?? (await runtime($))
    const paths = { loopDir: rt.loopDir, configDir: await configDir($) }
    const now = await $.clock.now()
    const last = (await $.state.get(lastPassRef)).value ?? null
    const from = agentId === undefined ? { last } : { last, agentId }
    const reply = typeof input === 'string' ? await runOp(fileIo($), paths, input, now, from) : await controlTool(fileIo($), paths, input, now, from)
    let said = reply.text
    if (reply.retryIssue !== null) said = await retry($, reply.retryIssue)
    if (reply.ping) {
      await appendLine($, rt, { control: reply.logged, text: said })
      ping()
    }
    return { ok: reply.ok, text: said }
  })
  ops = run.catch(() => undefined)
  return run
}

async function retry($: EngineInterface, issue: number): Promise<string> {
  let said = `Retry #${issue}: this session holds no ledger (act mode keeps one), so nothing was cleared.`
  await hook(async () => {
    const rt = await ledgerFor($)
    if (rt === null) return
    said = retryText(issue, await retried(hookEnv($, rt, await $.clock.now()), issue))
  })
  return said
}

// answer: mcp__factory-loop__answer (act.ts wakeAnswered).
async function answer($: EngineInterface, input: Record<string, unknown>, agentId: string | undefined): Promise<OpAnswer> {
  let reply: OpAnswer = { ok: false, text: 'Not recorded: no wake of the factory loop is open in this session.' }
  await hook(async () => {
    const rt = await ledgerFor($)
    if (rt === null) return
    const r = await wakeAnswered(hookEnv($, rt, await $.clock.now()), input, agentId)
    reply = { ok: r.ok, text: r.text }
    if (r.moved) ping()
  })
  return reply
}

// toolInput: a tool call's own arguments, without the envelope the engine adds.
function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...input } = e
  return input
}

async function registerControls($: EngineInterface) {
  // the command's name is written out, so the validator reads its hook as one that answers its
  // own command
  const command = () =>
    $.command.register({ name: 'factory', description: FACTORY_COMMAND.description, argumentHint: FACTORY_COMMAND.argumentHint, immediate: FACTORY_COMMAND.immediate })
  for (const register of [command, () => $.tool.register(CONTROL_TOOL), () => $.tool.register(ANSWER_TOOL)]) {
    try {
      await register()
    } catch {
      // a host without the noun: the loop runs, the owner uses control.json
    }
  }
}

// ensure: start once per module load, from whichever hook fires first. session.start does not
// fire for a plugin a /reload-plugins adds to a running session (the wake probe saw it).
function ensure($: EngineInterface) {
  started ??= (async () => {
    loadedAt = await $.clock.now()
    ask = source => void request($, source).catch(() => undefined)
    await registerControls($)
    $.clock.after(FIRST_PASS_AFTER_MS, () => void request($, 'timer').catch(() => undefined))
    rearm($, DEFAULT_CONFIG.passEveryMs)
  })().catch(() => {
    started = undefined
  })
  return started
}

export const register: Register = (on, opts) => {
  options = opts as Options

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    cwd = e.cwd
    if (!e.isInteractive) headless = true
    else await ensure($)
    return result
  })

  // The note /rename leaves for the model is blanked as it is stored, so a title costs the
  // conversation about 3 tokens (FINDINGS check 3). Any row also starts the loop if needed.
  on('session.append', async ($, e, next) => {
    if (!headless) void ensure($)
    const isRenameNote =
      e.door === 'prompt' && e.origin.kind === 'plugin' && JSON.stringify(e.message.content ?? '').includes('named this session')
    return next(isRenameNote ? { ...e, message: { ...e.message, content: [] } } : e)
  }).catch(($, e, next) => next(e))

  // Turns feed the ledger after they are answered; what any turn returns is never changed.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    await hook(() => turnStarted($, e.text, e.turnId))
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const ended: TurnEnded = { turnId: e.turnId, answer: e.answer, reason: e.reason }
    const agentId = e.agentId
    await hook(() => (agentId === undefined ? mainTurnEnded($, ended) : agentTurnEnded($, { ...ended, agentId })))
    return result
  }).catch(($, e, next) => next(e))

  // session.end has one short bound for every hook: the lease goes first
  on('session.end', async ($, e, next) => {
    await releaseLock($, e.sessionId).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /factory <op>: the owner's controls from any client (SPEC 4.3)
  on('command.run', { command: 'factory' }, async ($, e) => ({ text: (await ownerOp($, e.args, undefined)).text })).catch(() => ({
    text: 'factory-loop: the op could not run; nothing was changed.',
  }))

  on('tool.call', { tool: 'mcp__factory-loop__control' }, async ($, e) => {
    const r = await ownerOp($, toolInput(e), e.agentId)
    return r.ok ? { result: r.text } : { deny: r.text }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'factory-loop: the op could not run; nothing was changed.' }))

  on('tool.call', { tool: 'mcp__factory-loop__answer' }, async ($, e) => {
    const r = await answer($, toolInput(e), e.agentId)
    return r.ok ? { result: r.text } : { deny: r.text }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'factory-loop: the answer could not be recorded.' }))
}

// for the tests
export const testing = { issueFromBranch }
