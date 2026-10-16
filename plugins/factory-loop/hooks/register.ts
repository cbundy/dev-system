// factory-loop: the issue orchestrator as one code loop (docs/factory-loop/SPEC.md).
//
// Every passEveryMs, or at once when pinged, a pass reads the factory (observe.ts) and plans
// (plan.ts). In act mode, once the safety rails pass (rails.ts: the act lock, the role, the old
// watcher, another orchestrator's heartbeat), it runs plan's actions through their executors
// (act.ts) and records each in the ledger (ledger.ts), which it keeps in $.store. In observe mode
// (the default), or while a rail holds act mode back, it executes nothing and every command's
// event writes go to a sink (SPEC 11.1). Each pass appends one decision-log line and sets the
// session title. This is the only module that holds $: it builds the engine calls the others
// make, and wires the hooks that feed the ledger between passes (agents' answers, recorded with
// the answer script, in text or through their answer tools, and their repair messages; wake
// turns) and the owner's controls
// (/factory, the control and answer tools), and keeps the loop's own agent types (agents/) from
// the model. The setting `planner` picks the layer whose plan acts (v1's plan.ts or v2/plan.ts),
// and the v2 shadow plans beside v1 and is only logged (v2 SPEC 2.3); v2's records and the PR heads
// it has seen live in the store beside the ledger (records:<repo>, heads:<repo>).
import type { AgentSpawnArgs, EngineInterface, Register } from 'claude-code'

import {
  TOOL_LATE,
  actPass,
  agentAnswered,
  agentToolAnswered,
  breakerEventArgv,
  capEventArgv,
  capKey,
  commandOf,
  keep,
  logLoop,
  loggedOf,
  passErrorTell,
  planPass,
  retried,
  sendNotice,
  transition,
  updateDone,
  wakeAnswered,
  wakeEnded,
  wakeStarted,
} from './act'
import type { ActEnv, ActReport, Answered, Between, Claim, Live, Repair, Shadowed, ToolAnswered } from './act'
import { SUBAGENT_OF, stillAtWork } from './act-agents'
import { AGENT_TOOLS, DESIGN, HANDOFF, VERDICT } from './agent-tools'
import { DEFAULT_CONFIG, EMPTY_CONTROL, jsonObject } from './config'
import { loopBaseOf, loopDirOf } from './contract.mjs'
import { viewOf } from './config-view'
import type { ViewInputs } from './config-view'
import { CONTROL_TOOL, FACTORY_COMMAND, controlTool, issuesOf, readControl, retryText, runOp, writeControl } from './control'
import type { FileIo } from './control'
import { LOOP_FILES_KEEP_DAYS, pruneArgvs } from './exec'
import type { ActIo } from './exec'
import { finish, load, onLoad, save } from './ledger'
import type { StoreIo } from './ledger'
import { GITHUB_BACKOFF_MS, emptyCache, observe } from './observe'
import type { Io, Runtime, Stored } from './observe'
import { issueFromBranch } from './plan'
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
  pingsIgnored,
  releaseActLock,
  requestPass,
  roleProblem,
  waitOver,
} from './rails'
import type { BreakerNotice, LockIo, Notice, PassSource, RailEnv, RailMemory } from './rails'
import { armSummary, holdsLock, recordPass } from './pass-summary'
import { within } from './within'
import { digestOf } from './state'
import {
  CUT_ROOM,
  attemptOf,
  begin,
  byteLength,
  called,
  carve,
  cutLine,
  isCutLine,
  lockTimed,
  newTracer,
  spent,
  traceName,
  traceRecord,
  traceRoom,
  tracedActIo,
  tracedIo,
  waitSince,
  waitingRows,
  wakeRows,
} from './trace'
import type { Tracer } from './trace'
import type { Action, AgentStatus, AgentType, Config, LedgerEntry, Ms, PlanResult, SourceName, State } from './types'
import { logOwnerOp } from './v2/act-events'
import type { V2Stored } from './v2/observe'
import { opLanded, parkedOf } from './v2/ops'
import { transitionsOf } from './v2/plan'
import { stateCounts } from './v2/rules-state'
import { newSettingsCache, repoLoaded } from './v2/settings'
import type { SettingsIo } from './v2/settings'
import { keepV2, loadV2, newV2Live, noteIdle, noteKillSwitch, noteWritten, notingIo, readStoredV2, storedV2, v2IoOf } from './v2/store'
import type { V2StoreIo } from './v2/store'
import { STEP_AGENT } from './v2/types'
import type { V2Io } from './v2/types'
import { BASH_TIMEOUT_MS, processIdOf, withSlotLine } from './v2/workspace'
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
// the agent list an interim answer is checked against: a hang must not hold the hooks behind it
const LIST_TIMEOUT_MS = 10_000
// $.session.send resolves once the repair message is queued (#548); one that hangs is undelivered
const REPAIR_TIMEOUT_MS = 10_000
// $.prompt.submit resolves once its turn starts, which waits for the session to be idle: a wake
// is taken as queued after this, so a busy session never holds a pass (a late drop still counts)
const SUBMIT_GRACE_MS = 5_000
// three passes in a row that throw tell the owner (SPEC 10.9)
const ERROR_PASSES = 3
// The engine gives each hook a budget of its own time per dispatch (HookBudget, 10 s: awaiting
// the hook queue counts, a $ call does not), and a tool call whose hook outruns it is left with
// "no tool.call hook answered this call" (stage D run 3, #558). The loop's tool hooks decide
// against what is in memory and answer at once; one whose own work is not done within this
// bound refuses, asking for text.
const TOOL_ANSWER_MS = 2_000
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
let lastTitle: string | null = null, lastTitleAt: Ms | null = null
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
// v2's records and the heads it has seen, kept as the ledger is (v2/store.ts), and the repo-local
// settings as origin's default branch holds them under planner v2 (v2/settings.ts)
const liveV2 = newV2Live()
const settingsCache = newSettingsCache()
// the last pass's runtime and state, for the hooks between passes
let lastRt: (Runtime & ViewInputs) | null = null
let lastState: State | null = null
// this session held the act lock at some pass, so session.end releases it
let heldLock = false
// what asked for the next pass, in the order it came: the decision log's trigger (#552)
let asked: string[] = []
const ASKED_MAX = 20
// for the trace (#552): when each skip was first seen in a run of passes (trace.ts waitSince),
// when each wake attempt's turn started, the ended wakes already reported, the last pass's start,
// and the day and cap a trace file was cut short at
let waits = new Map<string, Ms>()
const delivered = new Map<string, Ms>()
const reportedWakes = new Set<string>()
let prevPassAt: Ms = 0
let traceCut: string | null = null
// the day and cap whose trace file this load has read for an earlier load's cut (writeTrace)
let traceChecked: string | null = null
// agents whose answer is being handled, when each was first listed with its turn ended (idle or
// completed), and when each was sent its repair message (act.ts)
const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map() }
// the loop's own agent types with a repair message of the loop's on its way, and how many: the
// engine resumes an agent only as a type it offers the model, so the loop offers its hidden types
// for just that long (repairTo, #559)
const resuming = new Map<string, number>()
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

// The workspace file's keys that are not settings: the plugin's options and the runtime's own.
// Every other key there is a setting, over the repo's file (v2 SPEC section 15: the workspace
// file may set any key and wins); answerTools, which answerChannel replaced (#561), is passed on
// only to be named as replaced.
const RUNTIME_KEYS: readonly string[] = ['mode', 'repo', 'shadowDevice', 'runSource', 'checkout', 'poolSize', 'toolsDir', 'binDir']

async function text($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
  } catch {
    return null
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// configDir: CLAUDE_CONFIG_DIR, else ~/.claude, with no doubled or trailing /: every path the loop
// issues is built on it, and the answer script refuses a path that is not plain.
async function configDir($: EngineInterface) {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`
  return dir.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

// runtime: the settings one pass runs with (SPEC 4.1): plugin options, then the workspace
// file ${CLAUDE_CONFIG_DIR}/factory-loop/config.json, then the repo's .claude/factory-loop.json.
// env is every command's base environment: the repo, the configured labels (callum-flow-claim
// and callum-flow-sweep read them), binDir ahead of PATH when the workspace file names one (a
// testbed runs the branch's own CLIs), and the event sink when the mode is not act.
async function runtime($: EngineInterface): Promise<Runtime & ViewInputs> {
  const dir = await configDir($)
  const base = loopBaseOf(dir)
  const file = jsonObject(await text($, `${base}/config.json`))
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
  // the repo-local settings, durations and all (SPEC 4.2), then the workspace file's over them.
  // Under planner v2 the repo's are origin's default branch's. What either gets wrong is logged.
  const over = Object.fromEntries(Object.entries(file).filter(([key]) => !RUNTIME_KEYS.includes(key)))
  const loaded = await repoLoaded(settingsIo($), settingsCache, checkout, jsonObject(await text($, `${checkout}/.claude/factory-loop.json`)), over)
  const config: Config = { ...loaded.config, mode: mode as Config['mode'] }
  const loopDir = loopDirOf(dir, repo)
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
    workspace: { session: await $.session.id(), process: processIdOf(await text($, '/proc/self/stat')) },
    sink,
    env,
    toolsDir: str(file.toolsDir) || DEFAULT_TOOLS_DIR,
    // where the answer script lives (#561): the plugin's own directory, wherever it was loaded from
    pluginRoot: $.plugin.root,
    config,
    v2Config: { ...loaded.v2, mode: config.mode },
    configProblems: loaded.problems,
    repoSettings: loaded.raw,
    workspaceRaw: file,
    pluginVersion: str(jsonObject(await text($, `${$.plugin.root}/.claude-plugin/plugin.json`)).version) || 'unknown',
  }
}

// settingsIo and v2StoreIo: what v2/settings.ts and v2/store.ts run on.
function settingsIo($: EngineInterface): SettingsIo {
  return { run: (argv, opts) => $.process.run(argv, opts), now: () => $.clock.now() }
}

function v2StoreIo($: EngineInterface): V2StoreIo {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), now: () => $.clock.now() }
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
      // an agent step starts in its slot: the companion reads the slot line (v2 SPEC 10.3)
      const args: AgentSpawnArgs = { subagentType: input.subagentType, prompt: withSlotLine(input.prompt, input.cwd), description: input.description }
      if (input.cwd !== undefined) args.cwd = input.cwd
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
    v2: v2Io($),
  }
}

// v2Io: the live records for the transition executor, stored after every ledger save queued
// before them (v2/store.ts), the driver's ping and the live ledger (v2 SPEC 3.3, 4.6).
function v2Io($: EngineInterface): V2Io {
  return v2IoOf(liveV2, v2StoreIo($), { ready: () => live.loaded && lastRt !== null, write: save => afterSaves($, lastRt, save), ping: why => ping(why), ledger: () => live.ledger })
}

function fileIo($: EngineInterface): FileIo {
  return { readFile: path => text($, path), writeFile: (path, body) => $.fs.write(path, body) }
}

// lockIo: the act lock's reads and its one compare-and-set command (rails.ts LOCK_CAS_SCRIPT),
// timed when a traced pass writes it.
function lockIo($: EngineInterface, tr: Tracer | null = null): LockIo {
  return {
    readFile: path => text($, path),
    cmd: (argv, init) =>
      lockTimed(tr, () => $.process.run(argv, init.stdin === undefined ? { timeoutMs: init.timeoutMs } : { stdin: init.stdin, timeoutMs: init.timeoutMs })),
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

// offTitle: the title while the loop is off (mode off or the kill switch).
function offTitle(rt: Runtime): string {
  return `🔄 ${rt.repo.split('/')[1] ?? 'loop'} · off`
}

async function setTitle($: EngineInterface, title: string) { // every rename, the driver's own included, starts the throttle window
  if (title === lastTitle) return
  await $.command.run({ command: 'rename', args: title })
  lastTitle = title
  lastTitleAt = await $.clock.now()
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
  // v2's records and heads load with the ledger, whose lease keeps them too
  await loadV2(liveV2, v2StoreIo($), rt.repo)
  const now = await $.clock.now()
  const env = hookEnv($, rt, now)
  // running commands died with the old module; wakes another session submitted went with it
  const moved = transition(live, l => onLoad(l, now))
  moved.push(...closeOrphans(await $.session.id(), now))
  await persist($, rt)
  await logLoop(env, moved)
  problems.push(...env.problems)
  return true
}

// closeOrphans: the live ledger's wakes no one can answer any more lost at once (wake.ts
// orphanedWakes, SPEC 7.5); the entries it moved, for the loop events.
function closeOrphans(session: string, now: Ms): LedgerEntry[] {
  const moved: LedgerEntry[] = []
  for (const u of orphanedWakes(live.ledger, session, loadedAt)) moved.push(...transition(live, l => finish(l, u.key, u, now)))
  return moved
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

// afterSaves: a store write queued after every save before it, run only while this session may
// still write the store (mayWrite); whether it ran without error.
function afterSaves($: EngineInterface, rt: Runtime | null, write: () => Promise<void>): Promise<boolean> {
  const run = saving.then(async (): Promise<boolean> => {
    if (rt === null || !(await mayWrite($, rt))) return false
    await write()
    return true
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
// pass runs with the $ of whoever asked (a timer's closure, a hook's own). `why` names the asker
// for the pass's trigger; a ping the breaker ignores asks for nothing.
async function request($: EngineInterface, source: PassSource, why: string) {
  if (headless) return
  const now = await $.clock.now()
  if (!(source === 'ping' && pingsIgnored(sched, now)) && !asked.includes(why) && asked.length < ASKED_MAX) asked.push(why)
  sched = requestPass(sched, source, now)
  await step($)
}

// ask: request a pass with the $ the loop's timers run with, made once per load (ensure), so a
// ping from a hook never runs a pass on that hook's own dispatch.
let ask: ((source: PassSource, why: string) => void) | null = null

// ping: an agent of the loop finished (`agent <id>`), a wake was answered (`wake <id>`), an owner
// control arrived (`owner <op>`).
function ping(why: string) {
  ask?.('ping', why)
}

// background: queue what a tool call leaves for later with the $ the loop's timers run with, as
// ask does, made once per load (ensure); saveNow saves the ledger with that $ at once.
let background: ((after: After) => void) | null = null
let saveNow: ((rt: Runtime) => void) | null = null

async function step($: EngineInterface) {
  const now = await $.clock.now()
  const r = nextPass(sched, now)
  sched = r.scheduler
  if (r.next.do === 'start') {
    // every request since the last pass started is this one's trigger
    const trigger = asked.length > 0 ? asked.join(', ') : 'timer'
    asked = []
    void runPass($, r.notice, trigger)
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
  const t = $.clock.every(ms, () => void request($, 'timer', 'timer').catch(() => undefined))
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
    killed: () => killed($),
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
    lastTitle, lastTitleAt,
    githubBackoffUntil: null,
    checkout: null,
  }
}

async function runPass($: EngineInterface, breaker: BreakerNotice | null, trigger: string) {
  // the pass's time runs from here, for the decision log and the trace (#552)
  const t0 = performance.now()
  let rt: Runtime | undefined
  try {
    rt = await runtime($)
    lastRt = rt
    rearm($, rt.config.passEveryMs)
    await noteIdle(liveV2, v2StoreIo($), fileIo($), rt)
    const off = rt.mode === 'off' || (await noteKillSwitch(liveV2, v2StoreIo($), rt, await killed($)))
    if (off || rt.repo === '') {
      await setTitle($, offTitle(rt))
    } else {
      passNo += 1
      await pass($, rt, breaker, trigger, t0)
    }
    failures = 0
    failingSince = null
    errorTold = false
  } catch (err) {
    failures += 1
    const now = await $.clock.now()
    failingSince ??= now
    if (rt !== undefined) {
      recordPass(now, Math.round(performance.now() - t0), false, true)
      await appendLine($, rt, { pass: passNo, trigger, ms: Math.round(performance.now() - t0), error: String(err).slice(0, 500), failures })
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

async function pass($: EngineInterface, rt: Runtime, breaker: BreakerNotice | null, trigger: string, t0: number) {
  const now = await $.clock.now()
  // trace mode (#552): the pass's phases, every engine call it makes and its totals; null when off
  const tr = rt.config.trace ? newTracer(() => performance.now(), t0, now) : null
  const keys = keysOf(rt.repo)
  const listed = await called(tr, 'agent.list', () => listAgents($), r => (r.ok ? {} : { error: 'not read' }))
  const commands: string[] = []
  const problems: string[] = []
  const aio = tr === null ? actIo($) : tracedActIo(tr, actIo($))
  const keepInStore = (key: string, value: unknown) => spent(tr, 'persistMs', () => storeSet($, key, value, problems))
  let railReasons: string[] = []
  let memory: RailMemory | null = null
  let book: NoticeBook = { pending: [], caps: [] }
  let booked = JSON.stringify(book)
  let act = false
  let sid = ''

  // the rails, at the start of every act-mode pass, before anything acts (SPEC 11.2)
  begin(tr, 'rails')
  if (rt.mode === 'act') {
    sid = await $.session.id()
    const remembered = railMemoryFrom(await storeGet($, keys.rails))
    // the CLIs act on the checkout's own origin, the gh executors on rt.repo: they must be one
    // repo, or a merge lands in one and its follow-ups in the other (SPEC 11.5)
    const origin = await originOf($, rt.cwd, rt.env)
    const refusals = origin.toLowerCase() === rt.repo.toLowerCase() ? [] : [`repo: the checkout ${rt.cwd} is ${origin === '' ? 'no GitHub repository' : origin}, not ${rt.repo}`]
    // the rails' probes join the pass's command list; the lease's write does not
    const logged = commandOf(aio, rt, commands)
    const rails = await checkRails(
      { cmd: (argv, init) => (argv[2] === LOCK_CAS_SCRIPT ? lockIo($, tr).cmd(argv, init) : logged(argv, init)), readFile: aio.readFile },
      { repo: rt.repo, device: rt.device, session: sid, loopDir: rt.loopDir, config: rt.config, env: await railEnv($), now, memory: remembered, refusals },
    )
    memory = rails.memory
    railReasons = rails.reasons
    act = rails.act
    if (JSON.stringify(rails.memory) !== JSON.stringify(remembered)) await keepInStore(keys.rails, rails.memory)
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
  begin(tr, 'observe')
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
  const reads = tr === null ? io($, listed.agents) : tracedIo(tr, io($, listed.agents))
  // v2's records and heads: act mode's own, else the store's, read and never written (v2 SPEC 2.3)
  let v2Stored: V2Stored | undefined
  if (rt.config.planner === 'v2' || rt.config.shadow === 'v2') v2Stored = await (act ? storedV2(liveV2, v2StoreIo($), rt.repo) : readStoredV2(v2StoreIo($), rt.repo))
  const observed = await observe(reads, passRt, cache, shadowing ? 0 : loadedAt, lastTitle, lastTitleAt, stored, v2Stored)
  let state = observed.state
  if (act && rt.config.planner === 'v2') await keepV2(liveV2, observed.v2Heads, state, keepInStore)
  // an acting pass renews its lease before every action and on a timer while it runs, so no
  // step outlives it; once another session holds it, this pass runs nothing more and keeps the
  // ledger no longer (the next pass that holds it reloads the store)
  let holding = true
  const renew = async (): Promise<boolean> => {
    if (!holding) return false
    const path = actLockPath(rt.loopDir)
    // a save that found the lock another session's let the ledger go: nothing more acts on it
    const lock = live.loaded ? await lockOp(async () => holdActLock(lockIo($, tr), path, sid, await $.clock.now(), leaseMsOf(rt.config))) : null
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
    return spent(tr, 'persistMs', () => persist($, rt))
  }
  const holds = () => (act ? renew() : Promise.resolve(holding))
  const env: ActEnv = { io: aio, rt, live, commands, wakeId: () => wakeIdAt(state.now), session: sid, save, holds, killed: () => killed($), problems }

  let report: ActReport | null = null
  let result: PlanResult
  let shadow: Shadowed | null = null
  // when plan handed the actions over, for the trace
  let queuedAt: Ms | null = null
  const told: string[] = []
  const renewal = act ? $.clock.every(rt.config.passEveryMs, () => void renew().catch(() => undefined)) : null
  try {
    if (act) {
      begin(tr, 'act')
      // a lost store, rebuilt from the event log, becomes the ledger the loop keeps
      if (observed.ledgerSource === 'events' && live.ledger.length === 0 && state.ledger.length > 0) {
        live.ledger = [...state.ledger]
        live.logged = loggedOf(live.ledger)
        // a wake it rebuilt was open in an earlier session, which took its prompt along
        const moved = closeOrphans(sid, state.now)
        await spent(tr, 'persistMs', () => persist($, rt))
        await logLoop(env, moved)
      }
      // the restart for an update ran: the update is done, so the drain ends (rule H4)
      if (updateDone(live.ledger, state.control, loadedAt) && (await clearUpdate($, rt, state.control.updateDue?.at ?? null))) {
        state = { ...state, control: { ...state.control, updateDue: null } }
      }
      const acted = await actPass(env, state, listed, between)
      carve(tr, 'plan', acted.planned.ms)
      queuedAt = acted.planned.at
      state = acted.state
      result = acted.result
      shadow = acted.shadow
      report = acted.report
      lastState = state
      if (report.outcomes.some(o => o.kind === 'restart-self' && o.status === 'done')) restartAsked = state.now
      if (report.title !== null) [lastTitle, lastTitleAt] = [report.title, state.now]
      // the kill switch stopped the pass between actions: the title says off now, not next pass
      if (report.killed) await setTitle($, offTitle(rt))
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
      begin(tr, 'plan')
      const planned = planPass(state, config, rt.v2Config)
      result = planned.result
      shadow = planned.shadow
      begin(tr, 'act')
      if (result.actions.some(a => a.kind === 'title')) await setTitle($, result.title)
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
      if (JSON.stringify(book) !== booked) await keepInStore(keys.notices, book)
    }
  } finally {
    renewal?.cancel()
  }

  // what act mode keeps for the next pass: the queue's known list and the GitHub backoff
  if (act) {
    if (observed.queueKnown !== null) await keepInStore(keys.known, observed.queueKnown)
    const limited = report?.rateLimited === true ? state.now + GITHUB_BACKOFF_MS : 0
    const until = Math.max(state.githubBackoffUntil ?? 0, limited)
    if (until > state.now) await keepInStore(keys.backoff, until)
  }

  if (act && saveProblem !== null) problems.push(`ledger: not saved, so nothing starts until a save succeeds: ${saveProblem}`)
  // each skip keeps the time it was first seen while it lasts, for the trace's waits
  waits = waitSince(waits, result.skipped, state.now)
  const digest = digestOf(state)
  const at = new Date(state.now).toISOString()
  const issues = state.issues
  begin(tr, 'log')
  const passMs = Math.round(performance.now() - t0)
  const line = {
    v: 1,
    at,
    pass: passNo,
    // pass numbers restart when the module reloads; the load time tells the runs apart
    loaded: new Date(loadedAt).toISOString(),
    // what asked for the pass, and its time up to this line (#552)
    trigger,
    ms: passMs,
    mode: rt.mode,
    executed: act,
    device: rt.device,
    // the layer whose plan this is (v2 SPEC 2.3)
    planner: rt.config.planner,
    tier: result.tier,
    digest,
    sources: Object.fromEntries(
      [...Object.entries(state.sources), ...Object.entries(state.v2?.sources ?? {}).map(([k, v]) => [`v2.${k}`, v] as const)].map(([k, s]) => [k, s.ok ? 'ok' : `failed${s.error ? `: ${s.error}` : ''}`]),
    ),
    counts:
      rt.config.planner === 'v2'
        ? { queue: state.queue.length, ...stateCounts(state.v2?.records ?? []), owner: result.owner }
        : {
            queued: state.queue.length,
            dev: issues.filter(i => i.stage === 'designing' || i.stage === 'implementing').length,
            pipeline: issues.filter(i => i.stage === 'in pipeline' || i.stage === 'parked').length,
            merge: issues.filter(i => i.stage === 'ready to merge').length,
            owner: result.owner,
          },
    actions: result.actions.filter(a => a.kind !== 'title').map(summaryOf),
    transitions: rt.config.planner === 'v2' ? transitionsOf(result) : undefined,
    skipped: result.skipped.slice(0, 60),
    // the v2 shadow's plan, logged and never executed, and the K it planned with (v2's own default)
    shadow:
      shadow === null
        ? undefined
        : 'error' in shadow
          ? shadow
          : { k: (rt.v2Config ?? rt.config).maxInFlightIssues, actions: shadow.actions.filter(a => a.kind !== 'title').map(summaryOf), skipped: shadow.skipped.slice(0, 60), transitions: transitionsOf(shadow) },
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
    planner: rt.config.planner,
    shadow: rt.config.shadow,
  })
  const ledger = act ? live.ledger : state.ledger
  if (tr !== null) {
    // ended wakes since the last pass, or since this module loaded: not the ledger's whole week
    const wakes = wakeRows(ledger, delivered, reportedWakes, Math.max(prevPassAt, loadedAt))
    for (const attempt of wakes.reported) reportedWakes.add(attempt)
    const record = traceRecord({
      tr,
      line: { at, pass: passNo, loaded: line.loaded, mode: rt.mode, executed: act, trigger },
      state,
      made: rt.runSource === 'events' ? ['runs', 'pool'] : [],
      outcomes: report?.outcomes ?? [],
      queuedAt,
      wakes: wakes.rows,
      waiting: waitingRows(state, result, ledger, waits),
    })
    await writeTrace($, rt, record).catch(() => undefined)
  }
  // the wake attempts a ledger let go are forgotten: the hooks time the live ledger's turns
  if (delivered.size > 0) {
    const held = new Set(live.ledger.map(attemptOf))
    for (const attempt of delivered.keys()) if (!held.has(attempt)) delivered.delete(attempt)
  }
  if (reportedWakes.size > 0) {
    const shown = new Set(ledger.map(attemptOf))
    for (const attempt of reportedWakes) if (!shown.has(attempt)) reportedWakes.delete(attempt)
  }
  prevPassAt = state.now
  // the title says error until the store takes the ledger again (SPEC 10.9)
  if (act && saveProblem !== null) throw new Error(`ledger: not saved: ${saveProblem}`)
  holdsLock(act)
  recordPass(await $.clock.now(), passMs, report?.outcomes.some(o => o.kind !== 'title') ?? false, false)
}

// writeTrace: the pass's trace record beside its decision log, within config traceMaxBytes
// (trace.ts traceRoom): the oldest trace files go first, and today's is cut short rather than
// pass the cap. A cut stays for the day across reloads: the first write of a load reads whether
// today's file already ends with the cut line (SPEC 12.1). A trace that cannot be written never
// fails the pass.
async function writeTrace($: EngineInterface, rt: Runtime, record: Record<string, unknown>) {
  const at = String(record.at)
  const day = at.slice(0, 10)
  const cap = rt.config.traceMaxBytes
  const dayCap = `${day}:${cap}`
  const line = JSON.stringify(record) + '\n'
  const files = (await $.fs.list(rt.loopDir)).filter(e => e.kind === 'file')
  const path = `${rt.loopDir}/${traceName(day)}`
  if (traceCut !== dayCap && traceChecked !== dayCap) {
    if (files.some(f => f.name === traceName(day) && f.size > 0) && (await endsCut($, path, cap))) traceCut = dayCap
    traceChecked = dayCap
  }
  const room = traceRoom(files, day, byteLength(line), cap, traceCut === dayCap)
  if (room.remove.length > 0) {
    const r = await $.process.run(['rm', '-f', '--', ...room.remove.map(name => `${rt.loopDir}/${name}`)], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) return
  }
  if (room.write === 'record') await append($, path, line)
  if (room.write === 'cut') {
    await append($, path, cutLine(at, cap))
    traceCut = dayCap
  }
}

// endsCut: the trace file's last line is the cut line of this cap. Only its tail is read, since
// the file may be far larger than $.fs.read takes; the cut line fits in CUT_ROOM bytes.
async function endsCut($: EngineInterface, path: string, cap: number): Promise<boolean> {
  const r = await $.process.run(['tail', '-c', String(CUT_ROOM), '--', path], { timeoutMs: 10_000 })
  return r.exitCode === 0 && isCutLine(r.stdout.trimEnd().split('\n').pop() ?? '', cap)
}

function summaryOf(a: Action) {
  return {
    key: a.key,
    kind: a.kind,
    class: a.class,
    rule: a.rule,
    issue: a.issue,
    agent: a.kind === 'spawn' ? a.agent : undefined,
    step: a.kind === 'agent-step' ? a.step : undefined,
    run: 'run' in a && typeof a.run === 'string' ? a.run : undefined,
    pr: 'pr' in a && typeof a.pr === 'number' ? a.pr : undefined,
    reason: a.reason,
  }
}

// clearUpdate: control.json without updateDue, once the restart for it ran (rule H4). Its line
// is appended outside the owner's op queue, which holds only file reads and writes (#558).
async function clearUpdate($: EngineInterface, rt: Runtime, at: Ms | null): Promise<boolean> {
  if (at === null) return false
  const run = ops.then(async () => {
    const fio = notingIo(fileIo($), noteWritten(liveV2, v2StoreIo($), rt))
    const loaded = await readControl(fio, rt.loopDir)
    if (loaded.error !== null || loaded.control.updateDue?.at !== at) return false
    await writeControl(fio, rt.loopDir, { ...loaded.control, updateDue: null })
    return true
  })
  ops = run.catch(() => undefined)
  const cleared = await run.catch(() => false)
  if (cleared) await appendLine($, rt, { control: 'update off', text: `restart:${at} ran: the update is done and the drain ends` })
  return cleared
}

// --- between passes: the hooks that feed the ledger ---------------------------------------------

// hook: hook work that reads and changes the ledger, one at a time and in the order the events
// came (a wake's turn.start before its turn.complete). A tool call never waits here: it changes
// the ledger in memory at once and leaves the rest to this queue (later, #558).
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

// held: the runtime a tool call is decided against, from memory alone (#558): the last pass's,
// in act mode with no kill switch, with its ledger loaded. 'none': this session keeps no ledger
// (observe, off, the kill switch, a session no person reaches); 'loading': it has not loaded one
// yet (no pass since this module loaded, the store unread, the act lock another session's).
// Nothing is loaded here, so a call never waits on ensureLedger.
async function held($: EngineInterface): Promise<Runtime | 'none' | 'loading'> {
  if (headless) return 'none'
  const rt = lastRt
  if (rt === null) return 'loading'
  if (rt.repo === '' || rt.mode !== 'act' || (await killed($))) return 'none'
  return live.loaded && live.repo === rt.repo ? rt : 'loading'
}

// What a tool call leaves for once it has answered (#558): its ledger work (act.ts keep, or an
// answer's follow-up, with notes on what failed), then its decision-log line, given the problems
// met, and its ping.
type After = { rt: Runtime; run?: (env: ActEnv) => Promise<string[]>; line?: (problems: string[]) => Record<string, unknown>; ping?: string }

// later: what a tool call leaves for once it has answered, in the hook queue behind the hook work
// before it, with the $ the loop's timers run with (background), never the call's own, whose
// dispatch has ended by then. A call that changed the ledger has it saved at once, outside the
// hook queue (persist keeps its own order), so a reload or a crash before its turn in the queue
// never loses it: its entry would be marked lost and its work redone.
function later($: EngineInterface, after: After) {
  if (after.run !== undefined) {
    if (saveNow !== null) saveNow(after.rt)
    else void persist($, after.rt)
  }
  if (background !== null) background(after)
  else void hook(() => afterwards($, after))
}

// afterwards: one After, in the hook queue.
async function afterwards($: EngineInterface, after: After) {
  const env = hookEnv($, after.rt, await $.clock.now())
  const notes = after.run === undefined ? [] : await after.run(env)
  if (after.line !== undefined) await appendLine($, after.rt, after.line([...notes, ...env.problems]))
  if (after.ping !== undefined) ping(after.ping)
}

// kept: an After's ledger work for a transition a hook made at once: saved, then logged.
function kept(moved: readonly LedgerEntry[]) {
  return async (env: ActEnv): Promise<string[]> => {
    await keep(env, moved)
    return []
  }
}

// bounded: a tool hook's answer, from work that decides it, within TOOL_ANSWER_MS on $.clock
// (#558); past it, `late`. The work calls claim() just before it changes anything, and changes
// nothing when it returns false: the bound has passed, so a call answered late changed nothing. A
// claimed call still unanswered at the bound (a write that hangs) answers `unsure`.
function bounded($: EngineInterface, work: (claim: Claim) => Promise<OpAnswer>, late: OpAnswer, unsure: OpAnswer = late): Promise<OpAnswer> {
  let at: 'open' | 'claimed' | 'late' = 'open'
  const claim = () => {
    if (at === 'open') at = 'claimed'
    return at === 'claimed'
  }
  return new Promise<OpAnswer>((resolve, reject) => {
    const t = $.clock.after(TOOL_ANSWER_MS, () => {
      if (at === 'open') at = 'late'
      resolve(at === 'late' ? late : unsure)
    })
    work(claim).then(
      r => {
        t.cancel()
        resolve(r)
      },
      err => {
        t.cancel()
        reject(err)
      },
    )
  })
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
  const now = await $.clock.now()
  if (!(await wakeStarted(hookEnv($, rt, now), said, turnId))) return
  // when each wake's turn first started, for its trace row (#552)
  for (const e of live.ledger) if (e.turnId === turnId && !delivered.has(attemptOf(e))) delivered.set(attemptOf(e), now)
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
  if (out.moved) {
    const ids = live.ledger.flatMap(x => (x.turnId === e.turnId && x.wakeId !== undefined ? [x.wakeId] : []))
    ping(ids.length > 0 ? `wake ${ids.join(' ')}` : `turn ${e.turnId}`)
  }
}

// turn.complete of an agent of the loop: its answer recorded (act.ts agentAnswered), then a ping.
// An interim answer is held while a fresh agent list shows the agent still at work (#545); an
// unreadable one first gets its one repair message, while the loop may start things (#548). The
// decision log says which path each answer took (answerLine).
async function agentTurnEnded($: EngineInterface, e: TurnEnded & { agentId: string }) {
  const rt = await ledgerFor($)
  if (rt === null) return
  const now = await $.clock.now()
  const env = hookEnv($, rt, now)
  const repair: Repair = (await actsNow($, rt)) ? (id, text, type) => repairTo($, id, text, type) : async () => 'the loop starts nothing until its restart'
  const r = await agentAnswered(env, lastState ?? bareState(rt, now), { agentId: e.agentId, answer: e.answer, reason: e.reason }, between, id => atWork($, id), repair)
  const why = r.why === undefined || r.result === 'repair' ? [] : [r.result === 'dropped' ? `${r.why}: dropped` : r.why]
  const problems = [...why, ...env.problems]
  const path = answerLine(r)
  if (path !== null || problems.length > 0) await appendLine($, rt, { agent: e.agentId, ...path, problems: problems.length > 0 ? problems : undefined })
  if (r.result === 'applied') ping(`agent ${e.agentId}`)
}

// answerLine: the path an agent's answer at its turn's end took, for its decision-log line: read
// from the file it recorded with the answer script ('script', #561) or from its text ('text'),
// with how its entry ended, or asked again ('repair', with why); scriptRefused is what kept a
// recorded file out of a text answer, afterRepair marks an answer that came after the repair
// message, and repairRefused is why one was not delivered, whole (#559). The tool's path is
// agentTool's line.
function answerLine(r: Answered): Record<string, unknown> | null {
  if (r.key === undefined) return null
  if (r.result === 'repair') return { key: r.key, answer: 'repair', why: r.why }
  if (r.result !== 'applied') return null
  const e = live.ledger.find(x => x.key === r.key)
  return {
    key: r.key,
    answer: r.via ?? 'text',
    status: e?.status,
    summary: e?.summary,
    scriptRefused: r.scriptProblem,
    afterRepair: r.repaired === true ? true : undefined,
    repairRefused: r.undelivered,
  }
}

// repairTo: the one repair message to an agent of the loop, which resumes it with its transcript
// once its turn has ended (#548); null once queued, else why not. The engine resumes an agent only
// as a type it offers the model, and the loop hides its own (agent.offer below), so the agent's
// type is offered while the message is on its way: hidden, the engine refused every repair of
// testbed run 3 ("is not offered in this session", #559).
async function repairTo($: EngineInterface, agentId: string, text: string, type: AgentType | `${string}:${string}`): Promise<string | null> {
  const subagent = type.includes(':') ? type : SUBAGENT_OF[type as AgentType]
  resuming.set(subagent, (resuming.get(subagent) ?? 0) + 1)
  try {
    const r = await within($, REPAIR_TIMEOUT_MS, $.session.send({ to: { agentId }, text }), 'repair message')
    return r.isDelivered ? null : r.reason
  } catch (err) {
    return message(err)
  } finally {
    const left = (resuming.get(subagent) ?? 1) - 1
    if (left > 0) resuming.set(subagent, left)
    else resuming.delete(subagent)
  }
}

// atWork: the agent list shows the agent still at work (act-agents.ts stillAtWork). A list that
// cannot be read proves nothing, so the answer is read as final.
async function atWork($: EngineInterface, id: string): Promise<boolean> {
  try {
    const rows = await within($, LIST_TIMEOUT_MS, $.agent.list(), 'agent list')
    return stillAtWork(rows.map(a => (a.parentId === undefined ? { id: a.id, status: a.status } : { id: a.id, status: a.status, parentId: a.parentId })), id)
  } catch {
    return false
  }
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

const OP_LATE: OpAnswer = { ok: false, text: 'factory-loop: the op could not run in time; nothing was changed.' }
const OP_UNSURE: OpAnswer = { ok: false, text: 'factory-loop: the op was still being written when it had to answer; /factory status shows whether it took.' }

// ownerOp: /factory <op> and the control tool, one at a time (control.json is read, changed and
// written whole), answered within TOOL_ANSWER_MS (bounded, #558): the queue holds file reads and
// writes alone, and an op answered late writes nothing. A change pings the loop and gets its own
// decision-log line once it has its answer; retry clears the issue's exhausted entries in the
// live ledger at once. Under planner v2 the ops take v2's meaning; an op that landed with v2 acting
// before or after it is a person intervention (act-events.ts), and its writes the loop's (7.2).
function ownerOp($: EngineInterface, input: string | Record<string, unknown>, agentId: string | undefined): Promise<OpAnswer> {
  const work = (claim: Claim) => {
    const run = ops.then(async (): Promise<OpAnswer> => {
      const rt = lastRt ?? (await runtime($))
      const paths = { loopDir: rt.loopDir, configDir: await configDir($) }
      const now = await $.clock.now()
      const last = (await $.state.get(lastPassRef)).value ?? null
      const planner = rt.config.planner
      const parked = parkedOf(planner, lastState?.v2?.records)
      const view = viewOf(rt)
      const from = agentId === undefined ? { last, planner, parked, view } : { last, agentId, planner, parked, view }
      const fio = notingIo(claimedIo(fileIo($), claim), noteWritten(liveV2, v2StoreIo($), rt))
      const reply = typeof input === 'string' ? await runOp(fio, paths, input, now, from) : await controlTool(fio, paths, input, now, from)
      let said = reply.text
      if (reply.retryIssue !== null) said = await retry($, reply.retryIssue, claim)
      const landed = reply.op === null ? null : opLanded({ planner, mode: rt.mode }, reply.op, reply.logged, issuesOf(reply.op), now)
      const logOp = landed === null ? undefined : (env: ActEnv) => logOwnerOp(env, landed)
      const line = (problems: string[]) => ({ control: reply.logged, text: said, problems: problems.length > 0 ? problems : undefined })
      if (reply.ping && claim()) later($, { rt, run: logOp, line, ping: `owner ${reply.logged ?? ''}` })
      return { ok: reply.ok, text: said }
    })
    ops = run.catch(() => undefined)
    return run
  }
  return bounded($, work, OP_LATE, OP_UNSURE)
}

// claimedIo: file writes that go ahead only once the op claims its change (bounded), so an op
// answered late writes nothing.
function claimedIo(io: FileIo, claim: Claim): FileIo {
  return { readFile: io.readFile, writeFile: (path, body) => (claim() ? io.writeFile(path, body) : Promise.reject(new Error('the op ran out of time'))) }
}

// retry: `/factory retry <N>` in the live ledger (act.ts retried): cleared at once, saved and
// logged once the op has its answer (#558).
async function retry($: EngineInterface, issue: number, claim: Claim): Promise<string> {
  const rt = await held($)
  if (rt === 'none') return `Retry #${issue}: this session holds no ledger (act mode keeps one), so nothing was cleared.`
  if (rt === 'loading') return `Retry #${issue}: the ledger is not loaded yet (the next pass loads it), so nothing was cleared.`
  if (!claim()) return OP_LATE.text
  const r = retried({ live, rt }, issue)
  later($, { rt, run: kept(r.moved) })
  return retryText(issue, r.cleared)
}

const NO_WAKE: OpAnswer = { ok: false, text: 'Not recorded: no wake of the factory loop is open in this session.' }
const WAKE_LOADING: OpAnswer = { ok: false, text: 'Not recorded: the factory loop has not loaded its ledger yet; give the ANSWER block in your reply instead.' }
const WAKE_LATE: OpAnswer = { ok: false, text: 'Not recorded: the factory loop could not check this answer in time; give the ANSWER block in your reply instead.' }

// answer: mcp__factory-loop__answer (act.ts wakeAnswered), answered at once from the ledger in
// memory (#558); the ledger saved, the wake's loop event and the ping follow once it has its
// answer.
function answer($: EngineInterface, input: Record<string, unknown>, agentId: string | undefined): Promise<OpAnswer> {
  const work = async (claim: Claim): Promise<OpAnswer> => {
    const rt = await held($)
    if (rt === 'none') return NO_WAKE
    if (rt === 'loading') return WAKE_LOADING
    const r = await wakeAnswered(hookEnv($, rt, await $.clock.now()), input, agentId, claim)
    if (r.moved.length > 0) later($, { rt, run: kept(r.moved), ping: `wake ${typeof input.id === 'string' ? input.id : '?'}` })
    return { ok: r.ok, text: r.text }
  }
  return bounded($, work, WAKE_LATE)
}

const NO_LEDGER = 'Not recorded: no factory loop keeps a ledger in this session; reply with your text lines instead.'
const LEDGER_LOADING = 'Not recorded: the factory loop has not loaded its ledger yet; reply with your text lines instead.'

// agentTool: an agent's answer tool (act.ts agentToolAnswered, #548), answered at once (#558):
// refused unless this session keeps the ledger, loaded, and the caller is an agent of the loop
// whose answer it waits on; an accepted call has its input saved and is recorded in the ledger in
// memory, which goes to the store at once (later). What follows, in the hook queue once the call
// has its answer: its events, the ledger saved and its loop event, then a decision-log line for
// each call (the answer's path, 'tool', or why it was refused) and an accepted call's ping.
function agentTool($: EngineInterface, tool: string, input: Record<string, unknown>, agentId: string | undefined): Promise<OpAnswer> {
  const work = async (claim: Claim): Promise<OpAnswer> => {
    const rt = await held($)
    if (rt === 'none') return { ok: false, text: NO_LEDGER }
    if (rt === 'loading') return { ok: false, text: LEDGER_LOADING }
    const now = await $.clock.now()
    const r = await agentToolAnswered(hookEnv($, rt, now), lastState ?? bareState(rt, now), tool, input, agentId, claim)
    // the answer given: this one, or the bound's once it passed
    const given: ToolAnswered = claim() ? r : { ok: false, text: TOOL_LATE, key: r.key }
    const path = given.ok ? { answer: 'tool', afterRepair: given.repaired === true ? true : undefined } : { answer: 'tool refused', why: given.text }
    later($, {
      rt,
      run: given.after,
      line: problems => ({ agent: agentId, tool, key: given.key, ...path, problems: problems.length > 0 ? problems : undefined }),
      // an accepted call ends its entry as the agent's turn.complete would: the same trigger
      ping: given.ok ? `agent ${agentId ?? '?'}` : undefined,
    })
    return { ok: given.ok, text: given.text }
  }
  return bounded($, work, { ok: false, text: TOOL_LATE })
}

const agentReply = (r: OpAnswer) => (r.ok ? { result: r.text } : { deny: r.text })
const AGENT_TOOL_FAILED = { deny: 'factory-loop: the answer could not be recorded; reply with your text lines instead.' }

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
  const agentTools = AGENT_TOOLS.map(spec => () => $.tool.register(spec))
  for (const register of [command, () => $.tool.register(CONTROL_TOOL), () => $.tool.register(ANSWER_TOOL), ...agentTools]) {
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
    ask = (source, why) => void request($, source, why).catch(() => undefined)
    background = after => void hook(() => afterwards($, after))
    saveNow = rt => void persist($, rt)
    await registerControls($)
    // the first pass after a load: a session start or a reload
    $.clock.after(FIRST_PASS_AFTER_MS, () => void request($, 'timer', 'first').catch(() => undefined))
    rearm($, DEFAULT_CONFIG.passEveryMs)
    armSummary($, { rt: () => lastRt, killed: () => killed($), send: (rt, argv) => commandOf(actIo($), acting(rt), [])(argv, { timeoutMs: 60_000 }) })
  })().catch(() => {
    started = undefined
  })
  return started
}

export const register: Register = (on, opts) => {
  options = opts as Options

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // the 10-minute Bash timeout for every agent the loop starts (v2 SPEC 10.5)
    await $.env.set('BASH_DEFAULT_TIMEOUT_MS', BASH_TIMEOUT_MS).catch(() => undefined)
    await $.env.set('BASH_MAX_TIMEOUT_MS', BASH_TIMEOUT_MS).catch(() => undefined)
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

  // the agents' answer tools (#548), each name written out like the others'
  on('tool.call', { tool: 'mcp__factory-loop__verdict' }, async ($, e) => agentReply(await agentTool($, VERDICT, toolInput(e), e.agentId))).catch(
    ($, e, next) => (next.called ? next(e) : AGENT_TOOL_FAILED),
  )
  on('tool.call', { tool: 'mcp__factory-loop__design' }, async ($, e) => agentReply(await agentTool($, DESIGN, toolInput(e), e.agentId))).catch(
    ($, e, next) => (next.called ? next(e) : AGENT_TOOL_FAILED),
  )
  on('tool.call', { tool: 'mcp__factory-loop__handoff' }, async ($, e) => agentReply(await agentTool($, HANDOFF, toolInput(e), e.agentId))).catch(
    ($, e, next) => (next.called ? next(e) : AGENT_TOOL_FAILED),
  )

  // the loop's own agent types (act-agents.ts SUBAGENT_OF) are its spawns alone: the model is
  // never offered them, so it keeps to the callum-flow agents it knows. The engine asks too when a
  // message resumes an agent, and resumes none of a type it does not offer: while the loop's own
  // repair message to one is on its way (repairTo), its type is offered (#559)
  on('agent.offer', { agent: 'factory-loop:adjudicator' }, ($, e, next) => (resuming.has(e.agent) ? next(e) : { isOffered: false })).catch(($, e, next) =>
    next.called ? next(e) : { isOffered: false },
  )
  on('agent.offer', { agent: 'factory-loop:designer' }, ($, e, next) => (resuming.has(e.agent) ? next(e) : { isOffered: false })).catch(($, e, next) =>
    next.called ? next(e) : { isOffered: false },
  )
  // v2's agent types (v2/types.ts STEP_AGENT), hidden the same way
  for (const agent of new Set(Object.values(STEP_AGENT))) {
    on('agent.offer', { agent }, ($, e, next) => (resuming.has(e.agent) ? next(e) : { isOffered: false })).catch(($, e, next) => (next.called ? next(e) : { isOffered: false }))
  }
}

// for the tests
export const testing = { issueFromBranch }
