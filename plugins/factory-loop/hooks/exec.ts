// The act half's contract (v2 SPEC 13.6, 13.7, 13.8): what an executor is given and what it reports.
// register.ts builds ActIo over $ (the only module that holds $); every executor module
// (act-cli.ts, act-merge.ts, wake.ts and v2's) takes an ExecCtx and returns an Exec, and the
// driver records the result in the ledger (ledger.ts). Executors decide nothing: plan already
// did. They turn one action into commands, an agent spawn or a wake, and say what happened.
import type { Runtime } from './observe'
import type { Action, LedgerEntry, Ms, Outcome, State } from './types'
import type { V2Io } from './v2/types'

export type RunInit = { cwd?: string; stdin?: string; timeoutMs: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type SpawnInput = {
  subagentType: string
  prompt: string
  description: string
  name?: string
  model?: string
  // the slot an agent step runs in (v2 SPEC 10.3): its prompt opens with the slot line
  cwd?: string
}

// ActIo: the engine calls the act half makes. Commands always go through ExecCtx.cmd, which
// adds the repo, the mode's environment (v2 SPEC 13.11.1) and the decision log's command list.
export type ActIo = {
  now: () => Promise<Ms>
  run: (argv: string[], init: RunInit & { cwd: string; env: Record<string, string> }) => Promise<RunResult>
  // $.agent.spawn: resolves once the agent started; its answer arrives as its turn.complete
  spawnAgent: (input: SpawnInput) => Promise<{ agentId?: string; deny?: string }>
  // TaskStop through $.tool.call, for one of the loop's own agents only (v2 SPEC 13.6.1, 13.13)
  stopAgent: (agentId: string) => Promise<{ stopped: boolean; error?: string }>
  // $.prompt.submit: a turn of its own once the session is idle (v2 SPEC 13.8.1)
  submit: (text: string) => Promise<void>
  // $.command.run rename (v2 SPEC 13.9.1)
  rename: (title: string) => Promise<void>
  // $.session.usage().rateLimits as percentages, for the pre-check before a token-spending
  // action (v2 SPEC 13.10 item 7); null where the session has no reading
  usage: () => Promise<{ fiveHour: number | null; sevenDay: number | null }>
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, text: string) => Promise<void>
  // v2's live records and the driver's ping (v2 SPEC 3.3, 4.6), for the transition executor; absent
  // where the driver keeps no records (a test's fake, a hook outside act mode)
  v2?: V2Io
}

export type ExecCtx = {
  io: ActIo
  rt: Runtime
  // the state this pass planned from
  state: State
  // this attempt's ledger entry, already running with its attempt counted
  entry: LedgerEntry
  // runs a command from the main checkout (or init.cwd) with the repo and mode environment;
  // never through a shell unless the argv itself is `sh -c` for a detached launch
  cmd: (argv: string[], init: RunInit) => Promise<RunResult>
  // logs one factory event through callum-flow-event: its type, its data and its issue (v2 SPEC 13.7.4)
  event: (type: string, data: Record<string, unknown>, at: { issue: number }) => Promise<void>
  // a fresh wake id, unique across restarts (v2 SPEC 13.8.1 `id=`)
  wakeId: () => string
}

// What an executor reports:
// - done / failed: finished within the pass, with the outcome plan reads next pass;
// - running: continues past the pass. An agent ends in its turn.complete (agentId), a wake
//   with its answer (wakeId);
// - skipped: a pre-check refused it (a usage tier that forbids its class, a rail), so no
//   attempt is counted and the entry is dropped.
// noRetry: a usage error (exit 2) is a loop bug, never retried (v2 SPEC 13.10 item 1).
// rateLimited: stderr showed a GitHub rate limit; the driver sets githubBackoffUntil (v2 SPEC 13.10 item 2).
export type Exec =
  | { status: 'done'; outcome?: Outcome; summary: string }
  | { status: 'failed'; outcome?: Outcome; summary: string; noRetry?: boolean; rateLimited?: boolean }
  | { status: 'running'; agentId?: string; wakeId?: string; outcome?: Outcome; summary: string }
  | { status: 'skipped'; summary: string }

export type Executor<A extends Action = Action> = (ctx: ExecCtx, action: A) => Promise<Exec>

// One agent's answer, as its turn.complete gives it.
export type AgentAnswer = { agentId: string; answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }

// GitHub's rate-limit signatures in a command's stderr (v2 SPEC 13.10 item 2).
export function rateLimited(stderr: string): boolean {
  return /API rate limit exceeded|secondary rate limit|HTTP (403|429)[^\n]*rate.?limit/i.test(stderr)
}

// The first 2 000 characters of a failed command's stderr, for the outcome (v2 SPEC 13.10 item 1).
export function detailOf(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim()).slice(0, 2000)
}

// Where a v2 agent step's raw answer is kept (v2/steps.ts writes it).
export function answerPath(loopDir: string, key: string): string {
  return `${loopDir}/answers/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`
}

// The answer script under the plugin's root (#561): agents record their answer with it.
export const ANSWER_SCRIPT = 'bin/factory-answer'

// The last line of every wake prompt (skills/judge/SKILL.md answers by it).
export const WAKE_POINTER = 'Answer with the factory-loop:judge skill.'

// The loop dir's files that only grow (v2 SPEC 13.11.6): spawn records, saved answers, old respond logs,
// recorded states and the decision logs, kept as long as the ledger keeps entries (7 days).
export const LOOP_FILES_KEEP_DAYS = 7

// pruneArgvs: the commands that delete those files once older than `days`, then the day
// directories of states/ left empty. Everything else in the loop dir (the act lock, control.json,
// the event sink) is never touched.
export function pruneArgvs(loopDir: string, days: number): string[][] {
  const under = (dir: string) => ['-path', `${loopDir}/${dir}/*`]
  return [
    ['find', loopDir, '-mindepth', '1', '-type', 'f', '(', ...under('spawns'), '-o', ...under('answers'), '-o', ...under('respond'), '-o', ...under('states'), '-o', '-name', 'decisions-*.jsonl', ')', '-mmin', `+${days * 24 * 60}`, '-delete'],
    ['find', `${loopDir}/states`, '-mindepth', '1', '-type', 'd', '-empty', '-delete'],
  ]
}
