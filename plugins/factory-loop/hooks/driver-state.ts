// The factory loop driver's state (register.ts and the driver-*.ts modules it wires): the constants
// the driver runs by, and everything that lives for the module's life. A binding another module
// reassigns cannot be imported by name, so every reassigned value is a field of the one holder,
// `S`; the collections that are only mutated stay exported under their own names. Nothing here
// imports another driver module, and `ping` reads only `S.ask`, so every driver module can use it.
import type { EngineInterface } from 'claude-code'

import type { ActEnv, Between, Live } from './act'
import type { ViewInputs } from './config-view'
import { emptyCache } from './observe'
import type { Runtime } from './observe'
import { newScheduler } from './rails'
import type { PassSource } from './rails'
import type { AgentStatus, Ms, State } from './types'
import { newV2Live } from './v2/store'
import { newSettingsCache } from './v2/settings'

export const HOUR = 3_600_000
export const FIRST_PASS_AFTER_MS = 5_000
export const STATE_KEEP_BYTES = 3_500_000
// recorded states per day at most (observe mode writes one per changed digest): one every five
// minutes on average, which the replay needs, while a churning digest cannot fill the disk
export const STATES_PER_DAY = 288
// v2 SPEC 13.6.1: stop-agent 30 s, title 10 s; the strict lib has no setTimeout, so $.clock times them
export const STOP_TIMEOUT_MS = 30_000
export const RENAME_TIMEOUT_MS = 10_000
// $.agent.spawn resolves once the agent started; one that never does must not hold the pass
export const SPAWN_TIMEOUT_MS = 60_000
// $.session.send resolves once the repair message is queued (#548); one that hangs is undelivered
export const REPAIR_TIMEOUT_MS = 10_000
// $.prompt.submit resolves once its turn starts, which waits for the session to be idle: a wake
// is taken as queued after this, so a busy session never holds a pass (a late drop still counts)
export const SUBMIT_GRACE_MS = 5_000
// three passes in a row that throw tell the owner (v2 SPEC 13.10 item 9)
export const ERROR_PASSES = 3
// The engine gives each hook a budget of its own time per dispatch (HookBudget, 10 s: awaiting
// the hook queue counts, a $ call does not), and a tool call whose hook outruns it is left with
// "no tool.call hook answered this call" (stage D run 3, #558). The loop's tool hooks decide
// against what is in memory and answer at once; one whose own work is not done within this
// bound refuses, asking for text.
export const TOOL_ANSWER_MS = 2_000
export const DEFAULT_TOOLS_DIR = '/usr/local/share/callum-tools'

export const ASKED_MAX = 20

// One row of $.agent.list(), as observe and the reconciling read it.
export type AgentRow = { id: string; type: string; status: AgentStatus }

// Options as the manifest's userConfig gives them; the workspace config file overrides them.
export type Options = { mode?: unknown; repo?: unknown; shadowDevice?: unknown; runSource?: unknown }

// What a tool call leaves for once it has answered (#558): its ledger work (act.ts keep, or an
// answer's follow-up, with notes on what failed), then its decision-log line, given the problems
// met, and its ping.
export type After = { rt: Runtime; run?: (env: ActEnv) => Promise<string[]>; line?: (problems: string[]) => Record<string, unknown>; ping?: string }

// The values the modules reassign. Each is read and written as S.<name>.
export const S = {
  started: undefined as Promise<void> | undefined,
  // a session no person reaches (a `-p` run, the SDK) never runs the loop: every Claude process in
  // the workspace loads the plugin, the pipeline's own review runs included, and only the
  // interactive session may observe or act (D-61)
  headless: false,
  loadedAt: 0,
  cwd: '.',
  passNo: 0,
  lastTitle: null as string | null,
  lastTitleAt: null as Ms | null,
  lastDigest: null as string | null,
  // states written today, and the day the loop dir was last pruned (YYYY-MM-DD)
  statesToday: { day: '', count: 0 },
  prunedDay: '',

  // The pass scheduler (v2 SPEC 13.2): one pass at a time, 5 s apart, pings first, with the ping-storm
  // breaker (D-39); the timer re-armed when config.passEveryMs changes.
  sched: newScheduler(),
  timer: null as { ms: Ms; cancel: () => void } | null,
  // passes in a row that threw, since when, and whether the owner was told (v2 SPEC 13.10 item 9)
  failures: 0,
  failingSince: null as Ms | null,
  errorTold: false,

  // the last pass's runtime and state, for the hooks between passes
  lastRt: null as (Runtime & ViewInputs) | null,
  lastState: null as State | null,
  // this session held the act lock at some pass, so session.end releases it
  heldLock: false,
  // what asked for the next pass, in the order it came: the decision log's trigger (#552)
  asked: [] as string[],
  // for the trace (#552): when each skip was first seen in a run of passes (trace.ts waitSince),
  // the last pass's start, and the day and cap a trace file was cut short at
  waits: new Map<string, Ms>(),
  prevPassAt: 0 as Ms,
  traceCut: null as string | null,
  // the day and cap whose trace file this load has read for an earlier load's cut (writeTrace)
  traceChecked: null as string | null,
  lastWakeAt: 0,
  // dev-restart-self returned (rule H4): the workspace is about to be replaced, so nothing more is
  // started in this module's life, and the next load finds the update done (act.ts updateDone)
  restartAsked: null as Ms | null,
  // the request R2 wrote for that restart (a wind-down, v2 SPEC 10.11): the loop keeps acting in
  // wind-down meanwhile and starts nothing; null once it is stale or when no request was written
  restartRequestAt: null as Ms | null,
  // the store refused the last ledger write (persist); null once one succeeds
  saveProblem: null as string | null,
  // serialized work: ledger saves, the act lock's writes, the hooks that change the ledger, and the
  // owner's ops
  saving: Promise.resolve() as Promise<void>,
  locking: Promise.resolve() as Promise<unknown>,
  loading: null as Promise<boolean> | null,
  hooking: Promise.resolve() as Promise<void>,
  ops: Promise.resolve() as Promise<unknown>,
  options: {} as Options,

  // Late-bound calls: each is set once per load by ensure (driver-controls.ts) with the $ the
  // loop's timers run with, so a module lower in the import graph can reach what is built above it
  // and a hook never runs a pass or its follow-up work on its own dispatch.
  // ask: request a pass.
  ask: null as ((source: PassSource, why: string) => void) | null,
  // background: queue what a tool call leaves for later; saveNow saves the ledger at once.
  background: null as ((after: After) => void) | null,
  saveNow: null as ((rt: Runtime) => void) | null,
  // lateDrop: a wake prompt the engine dropped after it was taken as queued (driver-between.ts)
  lateDrop: null as ((prompt: string, why: string) => void) | null,
}

export const cache = emptyCache()

// The ledger (v2 SPEC 13.7), loaded from $.store by the first act-mode pass or hook that needs it.
// Every transition replaces live.ledger whole, synchronously (act.ts Live).
// basis: the act lock as it stood when the store was loaded; a write goes back to the store only
// while the lock names this session or still stands so (mayWrite)
export const live: Live & { loaded: boolean; repo: string; basis: string | null } = { ledger: [], loaded: false, repo: '', basis: null }
// v2's records and the heads it has seen, kept as the ledger is (v2/store.ts), and the repo-local
// settings as origin's default branch holds them (v2/settings.ts)
export const liveV2 = newV2Live()
export const settingsCache = newSettingsCache()
// when each wake attempt's turn started, and the ended wakes already reported (trace.ts)
export const delivered = new Map<string, Ms>()
export const reportedWakes = new Set<string>()
// agents whose answer is being handled, when each was first listed with its turn ended (idle or
// completed), and when each was sent its repair message (act.ts)
export const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map() }
// the loop's own agent types with a repair message of the loop's on its way, and how many: the
// engine resumes an agent only as a type it offers the model, so the loop offers its hidden types
// for just that long (repairTo, #559)
export const resuming = new Map<string, number>()

// ping: an agent of the loop finished (`agent <id>`), a wake was answered (`wake <id>`), an owner
// control arrived (`owner <op>` for /factory, `judge <op>` for the control tool).
export function ping(why: string) {
  S.ask?.('ping', why)
}
