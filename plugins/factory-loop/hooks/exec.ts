// The act half's contract (SPEC 6, 7, 8): what an executor is given and what it reports.
// register.ts builds ActIo over $ (the only module that holds $); every executor module
// (act-cli.ts, act-merge.ts, act-agents.ts, wake.ts) takes an ExecCtx and returns an Exec,
// and the driver records the result in the ledger (ledger.ts). Executors decide nothing:
// plan already did. They turn one action into commands, an agent spawn or a wake, and say
// what happened.
import type { Runtime } from './observe'
import type { Action, ActionKind, LedgerEntry, Ms, Outcome, State } from './types'

export type RunInit = { cwd?: string; stdin?: string; timeoutMs: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type SpawnInput = {
  subagentType: string
  prompt: string
  description: string
  name?: string
  model?: string
}

// ActIo: the engine calls the act half makes. Commands always go through ExecCtx.cmd, which
// adds the repo, the mode's environment (SPEC 11.1) and the decision log's command list.
export type ActIo = {
  now: () => Promise<Ms>
  run: (argv: string[], init: RunInit & { cwd: string; env: Record<string, string> }) => Promise<RunResult>
  // $.agent.spawn: resolves once the agent started; its answer arrives as its turn.complete
  spawnAgent: (input: SpawnInput) => Promise<{ agentId?: string; deny?: string }>
  // TaskStop through $.tool.call, for one of the loop's own agents only (SPEC 6.1, 13)
  stopAgent: (agentId: string) => Promise<{ stopped: boolean; error?: string }>
  // $.prompt.submit: a turn of its own once the session is idle (SPEC 8.1)
  submit: (text: string) => Promise<void>
  // $.command.run rename (SPEC 9.1)
  rename: (title: string) => Promise<void>
  // $.session.usage().rateLimits as percentages, for the pre-check before a token-spending
  // action (SPEC 10.7); null where the session has no reading
  usage: () => Promise<{ fiveHour: number | null; sevenDay: number | null }>
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, text: string) => Promise<void>
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
  // logs one factory event through callum-flow-event (SPEC 7.4)
  event: (state: string, fields: EventFields) => Promise<void>
  // a fresh wake id, unique across restarts (SPEC 8.1 `id=`)
  wakeId: () => string
}

export type EventFields = {
  issue?: number | null
  run?: string | null
  branch?: string | null
  pr?: number | null
  head?: string | null
  note?: string | null
}

// An extra done entry an executor records beside its own: a guard FAIL that `merge` printed
// is a guard outcome for its PR and head, so rule M2 handles it next pass (SPEC 5.5), while the
// merge itself counts as a failed attempt that plan retries once the guard is clean.
export type ExtraEntry = {
  key: string
  kind: ActionKind
  issue: number | null
  run: string | null
  pr: number | null
  head: string | null
  outcome: Outcome
}

// What an executor reports:
// - done / failed: finished within the pass, with the outcome plan reads next pass;
// - running: continues past the pass. An agent ends in its turn.complete (agentId), a wake
//   with its answer (wakeId), a detached respond by the run moving (rule P3a);
// - skipped: a pre-check refused it (a usage tier that forbids its class, a rail), so no
//   attempt is counted and the entry is dropped.
// noRetry: a usage error (exit 2) is a loop bug, never retried (SPEC 10.1).
// rateLimited: stderr showed a GitHub rate limit; the driver sets githubBackoffUntil (SPEC 10.2).
export type Exec =
  | { status: 'done'; outcome?: Outcome; summary: string; extra?: ExtraEntry[] }
  | { status: 'failed'; outcome?: Outcome; summary: string; noRetry?: boolean; rateLimited?: boolean; extra?: ExtraEntry[] }
  | { status: 'running'; agentId?: string; wakeId?: string; outcome?: Outcome; summary: string }
  | { status: 'skipped'; summary: string }

export type Executor<A extends Action = Action> = (ctx: ExecCtx, action: A) => Promise<Exec>

// One agent's answer, as its turn.complete gives it.
export type AgentAnswer = { agentId: string; answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }

// GitHub's rate-limit signatures in a command's stderr (SPEC 10.2).
export function rateLimited(stderr: string): boolean {
  return /API rate limit exceeded|secondary rate limit|HTTP (403|429)[^\n]*rate.?limit/i.test(stderr)
}

// The first 2 000 characters of a failed command's stderr, for the outcome (SPEC 10.1).
export function detailOf(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim()).slice(0, 2000)
}

// Where an agent's raw answer is kept (act-agents.ts writes it), so a judge(report) or
// judge(handoff) wake points the model at the file instead of pasting the report (SPEC 7.2).
export function answerPath(loopDir: string, key: string): string {
  return `${loopDir}/answers/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`
}

// The answer script under the plugin's root (#561): agents record their answer with it while the
// registered answer tools cannot be reached (config answerChannel `script`, a workaround).
export const ANSWER_SCRIPT = 'bin/factory-answer'

// Where an agent records its answer with the answer script: a path unique to the ledger entry and
// its attempt (the attempt's number and start), so the loop reads only what this attempt's agent
// wrote, never a stale or another agent's file. The job file beside it (contract.mjs jobPathOf)
// is the loop's; the name has contract.mjs's ANSWER_NAME shape.
export function scriptAnswerPath(loopDir: string, entry: Pick<LedgerEntry, 'key' | 'attempts' | 'startedAt'>): string {
  const key = entry.key.replace(/[^A-Za-z0-9._-]+/g, '_')
  return `${loopDir}/answers/${key}.a${entry.attempts}.${Math.trunc(entry.startedAt)}.answer.json`
}

// The detached respond's log (act-merge.ts writes it; task(respond-stuck) names it): one per
// ledger key and attempt, so a retry or a later gate of the same run never overwrites it.
export function respondLogPath(loopDir: string, key: string, attempt: number): string {
  return `${loopDir}/respond/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}-${attempt}.log`
}

// logRegated: whether a respond's log ends in a fresh `gate:` block for `step`: the respond
// reached the run, and the step parked again (#620). The pipeline prints `gate:` followed by an
// indented `step:` line each time it parks; only the last block counts.
export function logRegated(text: string, step: string): boolean {
  const at = text.lastIndexOf('\ngate:\n')
  const start = at >= 0 ? at + 1 : text.startsWith('gate:\n') ? 0 : -1
  if (start < 0) return false
  const m = /^ {2}step: *"?([^"\s]+)"?\s*$/m.exec(text.slice(start + 'gate:\n'.length))
  return m !== null && m[1] === step
}

// The last line of every wake prompt (skills/judge/SKILL.md answers by it).
export const WAKE_POINTER = 'Answer with the factory-loop:judge skill.'

// The loop dir's files that only grow (SPEC 11.6): spawn records, saved answers, respond logs,
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
