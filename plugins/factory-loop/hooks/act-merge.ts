// The rollout executor (v2 SPEC 13.6.1, D-29): the read of a hand-merged issue's rollout, which rule M7
// asks for when the issue's PR was merged by hand. It decides nothing (plan did): it runs
// fabriek-rollout through ctx.cmd and reads the CLI's own line and exit code
// (images/base/fabriek-rollout). The argv and the reading of the output are pure functions
// below, so tests and the argv safety test use them without the engine.
import { detailOf, rateLimited } from './exec'
import type { Exec, ExecCtx, Executor, RunInit, RunResult } from './exec'
import type { Action, ActionKind, Rollout } from './types'

const SEC = 1000
const SUMMARY_MAX = 200

// The rollout read is one issue read, like close-issue (v2 SPEC 13.6.1).
export const MERGE_TIMEOUT_MS = {
  rollout: 60 * SEC,
} as const

// The exit recorded for a command that never exited: it could not start, or it outlived its
// timeout and was ended. Either counts as failed (v2 SPEC 13.10 item 1).
export const NO_EXIT = -1

// --- argv (v2 SPEC 13.6.1) ---------------------------------------------------------------------------

export function rolloutArgv(issue: number): string[] {
  return ['fabriek-rollout', String(issue)]
}

// --- reading the CLI's output ----------------------------------------------------------------

export type RolloutRead =
  | { rollout: Rollout; source: string; line: string }
  | { rollout: null; problem: 'conflict' | 'invalid' | 'unreadable' | 'unknown'; line: string }

// parseRollout: fabriek-rollout's one line: `ROLLOUT <merge|run-it|keep-open> source=<brief|body>`,
// or `ROLLOUT conflict|invalid|unreadable <reason>` (exit 1).
export function parseRollout(text: string): RolloutRead {
  const line = lines(text).find(l => l.startsWith('ROLLOUT ')) ?? ''
  const ok = /^ROLLOUT (merge|run-it|keep-open) source=(\S+)$/.exec(line)
  if (ok?.[1] !== undefined && ok[2] !== undefined) return { rollout: ok[1] as Rollout, source: ok[2], line }
  const bad = /^ROLLOUT (conflict|invalid|unreadable)\b/.exec(line)?.[1] as 'conflict' | 'invalid' | 'unreadable' | undefined
  return { rollout: null, problem: bad ?? 'unknown', line }
}

// --- the executor -------------------------------------------------------------------------------

// rollout (rule M7 for a hand merge, D-29): the merged issue's rollout, read as the merge
// executor reads it. A hand merge prints no close_issue, so none is recorded.
const rollout: Executor = async (ctx, action) => {
  if (action.kind !== 'rollout') return wrongKind('rollout', action)
  if (action.issue === null) return refused('a rollout read names no issue')
  const argv = rolloutArgv(action.issue)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS.rollout)
  if (!('exitCode' in r)) return r
  const read = parseRollout(r.stdout)
  if (r.exitCode !== 0 || read.rollout === null) return failure(argv, r, read.line)
  return { status: 'done', outcome: { kind: 'rollout', rollout: read.rollout, closeIssue: null }, summary: clip(read.line) }
}

export const mergeExecutors: Partial<Record<ActionKind, Executor>> = { rollout }

// --- helpers -----------------------------------------------------------------------------------

// run: one command through ctx.cmd; a command that cannot start or outlives its timeout is a
// failed attempt with no exit (v2 SPEC 13.10 item 1).
async function run(ctx: ExecCtx, argv: string[], timeoutMs: number, stdin?: string, cwd?: string): Promise<RunResult | Exec> {
  const init: RunInit = { timeoutMs }
  if (stdin !== undefined) init.stdin = stdin
  if (cwd !== undefined) init.cwd = cwd
  try {
    return await ctx.cmd(argv, init)
  } catch (err) {
    return { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${label(argv)}: ${message(err)}`) }
  }
}

// failure: a command that exited with a failure: its exit and detail in the outcome (v2 SPEC
// 13.10 item 1). Exit 2 from the image's own CLIs is a usage error, a loop bug never retried; a GitHub
// rate limit in stderr is flagged for the driver's backoff (v2 SPEC 13.10 item 2).
export function failure(argv: readonly string[], r: RunResult, said?: string): Exec {
  const line = said || lines(r.stderr).pop() || lines(r.stdout).pop() || ''
  const exec: Extract<Exec, { status: 'failed' }> = {
    status: 'failed',
    outcome: { kind: 'cli', exit: r.exitCode, detail: detailOf(r) },
    summary: clip(`${label(argv)}: exit ${r.exitCode}${line === '' ? '' : `: ${line}`}`),
  }
  if (r.exitCode === 2 && /^(fabriek|callum-flow)-/.test(argv[0] ?? '')) exec.noRetry = true
  if (rateLimited(r.stderr)) exec.rateLimited = true
  return exec
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function wrongKind(kind: ActionKind, action: Action): Exec {
  return refused(`the ${kind} executor got a ${action.kind} action`)
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
}

function label(argv: readonly string[]): string {
  return argv.slice(0, 1).join(' ')
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
