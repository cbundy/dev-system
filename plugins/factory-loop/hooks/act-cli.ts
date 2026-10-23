// The executors that spend no tokens (v2 SPEC 13.6.1): the CLI kinds, plus stop-agent and title,
// which call the engine instead of a command. Each CLI kind turns its action into the steps of
// its catalogue row, runs them in order through ctx.cmd and ctx.event, stops at the first
// failure and says what happened. They decide nothing (plan did). The steps and the reading of
// their output are pure functions below, so tests, the replay harness and the argv safety test
// read them without the engine.
import { detailOf, rateLimited } from './exec'
import type { Exec, ExecCtx, Executor, RunInit, RunResult } from './exec'
import { closedData, splitAbandonedData } from './v2/event-native'
import type { Action, ActionKind, LedgerEntry } from './types'
import { WIND_DOWN_WRITE_SCRIPT } from './v2/wind-down-files'
import { windDownPaths } from './v2/wind-down'

const SEC = 1000
const SUMMARY_MAX = 200

// The kinds this module runs as commands.
export type CliKind =
  | 'heartbeat'
  | 'sweep'
  | 'claim'
  | 'close-issue'
  | 'delete-branch'
  | 'release-parent'
  | 'milestone-later'
  | 'restart-self'

// Each command's timeout, by its action's kind (v2 SPEC 13.6.1). A step of a multi-step kind gets
// the kind's timeout. stop-agent (30 s) and title (10 s) are engine calls, timed by ActIo.
export const CLI_TIMEOUT_MS: Record<CliKind, number> = {
  heartbeat: 120 * SEC,
  sweep: 300 * SEC,
  claim: 120 * SEC,
  'close-issue': 60 * SEC,
  'delete-branch': 60 * SEC,
  'release-parent': 60 * SEC,
  'milestone-later': 60 * SEC,
  'restart-self': 600 * SEC,
}

// The exit recorded for a command that never exited: it could not start, or it outlived its
// timeout and $.process.run ended it. Either counts as failed (v2 SPEC 13.10 item 1).
export const NO_EXIT = -1

// One step of an action: a command, or a factory event through ctx.event (v2 SPEC 13.7.4). `ok`
// lists the exits that are an answer, not a failure (default: 0 only).
export type Step =
  | { argv: string[]; timeoutMs: number; stdin?: string; ok?: number[] }
  | { event: string; data: Record<string, unknown>; issue: number }

// stepsOf: the steps one action runs, in order (v2 SPEC 13.6.1), or why it is refused: a loop bug,
// never retried. Every command runs from the main checkout. gh gets --repo, so a write can
// only reach the configured repo (v2 SPEC 13.11.5).
export function stepsOf(action: Action, repo: string, inDevLabel: string, loopDir: string): Step[] | string {
  const n = action.issue === null ? null : String(action.issue)
  const noIssue = `${action.kind} names no issue`
  const unlabel = (issue: string): Step => ({
    argv: ['gh', 'issue', 'edit', issue, '--repo', repo, '--remove-label', inDevLabel],
    timeoutMs: CLI_TIMEOUT_MS['release-parent'],
  })
  switch (action.kind) {
    case 'heartbeat':
      return [{ argv: ['callum-flow-claim', '--heartbeat'], timeoutMs: CLI_TIMEOUT_MS.heartbeat }]
    case 'sweep':
      return [{ argv: ['callum-flow-sweep'], timeoutMs: CLI_TIMEOUT_MS.sweep }]
    case 'claim':
      // exit 3: another device's live claim won, an answer (v2 SPEC 13.10 item 5)
      return n === null ? noIssue : [{ argv: ['callum-flow-claim', n], timeoutMs: CLI_TIMEOUT_MS.claim, ok: [0, 3] }]
    case 'close-issue':
      // a done close (logClosed) also logs the `closed` event, the way the tracker's close does
      return n === null
        ? noIssue
        : [
            { argv: ['gh', 'issue', 'close', n, '--repo', repo, '--reason', 'completed'], timeoutMs: CLI_TIMEOUT_MS['close-issue'] },
            ...(action.logClosed === true ? [{ event: 'closed', data: closedData('completed'), issue: action.issue as number }] : []),
          ]
    case 'delete-branch':
      // leased on the head plan read: a branch that moved since is kept (exit 1, "stale info"), which
      // is an answer, not a failure
      return [{ argv: ['git', 'push', `--force-with-lease=refs/heads/${action.branch}:${action.sha}`, 'origin', `:refs/heads/${action.branch}`], timeoutMs: CLI_TIMEOUT_MS['delete-branch'], ok: [0, 1] }]
    case 'milestone-later':
      return n === null ? noIssue : [{ argv: ['callum-flow-milestone', 'plan', n, 'later'], timeoutMs: CLI_TIMEOUT_MS['milestone-later'] }]
    case 'release-parent':
      // the parent is now a tracker. The label comes off first, so the event records a release
      // that happened, and a retry after a failed event repeats only the label edit.
      return n === null
        ? noIssue
        : [unlabel(n), { event: 'abandoned', data: splitAbandonedData(action.created, action.reasons ?? null, action.childWhys ?? null), issue: action.issue as number }]
    case 'restart-self':
      // only once the drain for an update is complete (rule H4, D-15), or v2's restart after a
      // capped wind-down (rule R2, v2 SPEC 14.1): R2 with wind-down on first writes the request,
      // in the form the status file's times take (wind-down.sh compares them as text)
      if (action.rule !== 'H4' && action.rule !== 'R2') return `restart-self comes only from rule H4 or R2, not ${action.rule}`
      return [
        ...(action.rule === 'R2' && action.windDownAt != null
          ? [{
              argv: ['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'wind-down-request', windDownPaths(loopDir).request],
              timeoutMs: 10_000,
              stdin: `${JSON.stringify({ requested_at: new Date(action.windDownAt).toISOString(), trigger: 'restart-self' })}\n`,
            }]
          : []),
        { argv: ['dev-restart-self'], timeoutMs: CLI_TIMEOUT_MS['restart-self'] },
      ]
    default:
      return `${action.kind} runs no command`
  }
}

// Exit 2 is a usage error, a loop bug never retried (v2 SPEC 13.10 item 1), for the image's own CLIs
// (callum-flow-*, dev-restart-self). gh exits 2 when a command is cancelled and 1 on bad
// usage; treehouse exits 1 on bad usage too.
export function usageError(argv: readonly string[], exit: number): boolean {
  return exit === 2 && argv[0] !== 'gh' && argv[0] !== 'treehouse'
}

// commandFailure: a command that exited with a failure: its exit and detailOf() in the
// outcome (v2 SPEC 13.10 item 1), and a GitHub rate limit flagged for the driver's backoff (v2 SPEC 13.10 item 2).
export function commandFailure(argv: readonly string[], r: RunResult): Exec {
  const line = lastLine(r.stderr) || lastLine(r.stdout)
  const exec: Extract<Exec, { status: 'failed' }> = {
    status: 'failed',
    outcome: { kind: 'cli', exit: r.exitCode, detail: detailOf(r) },
    summary: clip(`${label(argv)}: exit ${r.exitCode}${line === '' ? '' : `: ${line}`}`),
  }
  if (usageError(argv, r.exitCode)) exec.noRetry = true
  if (rateLimited(r.stderr)) exec.rateLimited = true
  return exec
}

// eventFailure: ctx.event threw. callum-flow-event exits non-zero only on a usage error (exit
// 2; a failed write still exits 0), so an error carrying exitCode 2 is never retried.
export function eventFailure(state: string, err: unknown): Exec {
  const code = typeof err === 'object' && err !== null ? (err as { exitCode?: unknown }).exitCode : undefined
  const exit = typeof code === 'number' ? code : NO_EXIT
  const exec: Extract<Exec, { status: 'failed' }> = {
    status: 'failed',
    outcome: { kind: 'cli', exit, detail: message(err).slice(0, 2000) },
    summary: clip(`event ${state}: ${message(err)}`),
  }
  if (exit === 2) exec.noRetry = true
  return exec
}

// finish: what the steps' output says once every step passed (v2 SPEC 13.6.1 "Outcome recorded").
export function finish(action: Action, results: RunResult[]): Exec {
  const last = results[results.length - 1]
  const out = (r: RunResult | undefined) => (r === undefined ? '' : firstLine(r.stdout) || lastLine(r.stderr))
  const ok = (summary: string): Exec => ({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: clip(summary) })
  switch (action.kind) {
    case 'claim':
      return last?.exitCode === 3
        ? { status: 'done', outcome: { kind: 'claim', result: 'lost' }, summary: clip(`lost #${action.issue}: ${lastLine(last.stderr)}`) }
        : { status: 'done', outcome: { kind: 'claim', result: 'claimed' }, summary: `claimed #${action.issue}` }
    case 'heartbeat':
      return ok('leases renewed')
    case 'sweep':
      return ok('swept')
    case 'close-issue':
      return ok(`closed #${action.issue}`)
    case 'delete-branch': {
      if (last?.exitCode === 0) return { status: 'done', outcome: { kind: 'cli', exit: 0, detail: 'deleted' }, summary: clip(`deleted ${action.branch}`) }
      const text = `${last?.stderr ?? ''}\n${last?.stdout ?? ''}`
      if (/stale info/i.test(text)) return { status: 'done', outcome: { kind: 'cli', exit: 0, detail: 'kept: moved' }, summary: clip(`kept ${action.branch}: it moved since it was read`) }
      return last === undefined ? { status: 'failed', summary: 'delete-branch ran no command' } : commandFailure(['git', 'push'], last)
    }
    case 'release-parent':
      return ok(`released #${action.issue}, split into ${action.created.join(',')}`)
    case 'milestone-later':
      // the CLI prints what moved or the line it set; a repo not opted in is a no-op note
      return ok(out(last) || action.kind)
    case 'restart-self':
      // the session ends; the loop resumes on load (v2 SPEC 13.7.5)
      return ok('restart requested')
    default:
      return { status: 'failed', summary: `${action.kind} runs no command`, noRetry: true }
  }
}

// runSteps: the steps in order, stopping at the first failure.
async function runSteps(ctx: ExecCtx, steps: Step[]): Promise<{ results: RunResult[] } | { failed: Exec }> {
  const results: RunResult[] = []
  for (const step of steps) {
    if ('event' in step) {
      try {
        await ctx.event(step.event, step.data, { issue: step.issue })
      } catch (err) {
        return { failed: eventFailure(step.event, err) }
      }
      continue
    }
    const init: RunInit = { timeoutMs: step.timeoutMs }
    if (step.stdin !== undefined) init.stdin = step.stdin
    let r: RunResult
    try {
      r = await ctx.cmd(step.argv, init)
    } catch (err) {
      const failed: Exec = {
        status: 'failed',
        outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) },
        summary: clip(`${label(step.argv)}: ${message(err)}`),
      }
      return { failed }
    }
    if (!(step.ok ?? [0]).includes(r.exitCode)) return { failed: commandFailure(step.argv, r) }
    results.push(r)
  }
  return { results }
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function command(kind: CliKind): Executor {
  return async (ctx, action) => {
    if (action.kind !== kind) return refused(`the ${kind} executor got a ${action.kind} action`)
    const steps = stepsOf(action, ctx.rt.repo, ctx.rt.config.inDevLabel, ctx.rt.loopDir)
    if (typeof steps === 'string') return refused(steps)
    const ran = await runSteps(ctx, steps)
    return 'failed' in ran ? ran.failed : finish(action, ran.results)
  }
}

// restartSelf: the restart's steps; when dev-restart-self itself fails after the request was
// written, the request comes off (best effort), so a restart that never came does not wind the
// loop down.
const restartSelf: Executor = async (ctx, action) => {
  if (action.kind !== 'restart-self') return refused(`the restart-self executor got a ${action.kind} action`)
  const steps = stepsOf(action, ctx.rt.repo, ctx.rt.config.inDevLabel, ctx.rt.loopDir)
  if (typeof steps === 'string') return refused(steps)
  // the request write (if any) is every step but the last
  const written = steps.slice(0, -1)
  const wrote = await runSteps(ctx, written)
  if ('failed' in wrote) return wrote.failed
  const ran = await runSteps(ctx, steps.slice(-1))
  if (!('failed' in ran)) return finish(action, [...wrote.results, ...ran.results])
  if (written.length > 0) await ctx.cmd(['rm', '-f', '--', windDownPaths(ctx.rt.loopDir).request], { timeoutMs: 10_000 }).catch(() => undefined)
  return ran.failed
}

// ownAgent: the ledger holds this agent id on an entry still running, so the loop spawned it and
// still waits on it. An agent the loop did not spawn is never stopped (v2 SPEC 13.6.1).
export function ownAgent(ledger: readonly LedgerEntry[], agentId: string): boolean {
  return ledger.some(e => e.agentId === agentId && e.status === 'running')
}

// stop-agent: TaskStop through ActIo, for one of the loop's own agents (rules A1, A2). A stop
// that is not supported is recorded as failed with the reason (v2 SPEC 13.13). TaskStop is expected to
// end the background shells the agent left running too, which is what keeps an agent at work
// past its answer (#587): Claude Code (2.1.296) kills an agent's running shell tasks as
// its loop exits. A process that detached from its shell outlives it.
const stopAgent: Executor = async (ctx, action) => {
  if (action.kind !== 'stop-agent') return refused(`the stop-agent executor got a ${action.kind} action`)
  if (!ownAgent(ctx.state.ledger, action.agentId)) return refused(`agent ${action.agentId} is not a running agent of the loop`)
  let r: { stopped: boolean; error?: string }
  try {
    r = await ctx.io.stopAgent(action.agentId)
  } catch (err) {
    r = { stopped: false, error: message(err) }
  }
  if (r.stopped) return { status: 'done', summary: `stopped ${action.agentId} (${action.reason})` }
  return { status: 'failed', summary: clip(`not stopped ${action.agentId}: ${r.error ?? 'no reason given'}`) }
}

// title: /rename through ActIo (rule O1, v2 SPEC 13.9.1). The rename runs off the pass (title-flight.ts):
// this starts it and returns; its time and status reach the trace as an off-pass row.
const title: Executor = async (ctx, action) => {
  if (action.kind !== 'title') return refused(`the title executor got a ${action.kind} action`)
  try {
    await ctx.io.rename(action.text)
  } catch (err) {
    return { status: 'failed', summary: clip(`rename failed: ${message(err)}`) }
  }
  return { status: 'running', summary: clip(`renaming off the pass: ${action.text}`) }
}

export const cliExecutors: Partial<Record<ActionKind, Executor>> = {
  heartbeat: command('heartbeat'),
  sweep: command('sweep'),
  claim: command('claim'),
  'close-issue': command('close-issue'),
  'delete-branch': command('delete-branch'),
  'release-parent': command('release-parent'),
  'milestone-later': command('milestone-later'),
  'restart-self': restartSelf,
  'stop-agent': stopAgent,
  title,
}

// --- small text helpers ---------------------------------------------------------------------

// label: a command's name for a summary: gh with its noun and verb, others with one argument.
function label(argv: readonly string[]): string {
  return argv.slice(0, argv[0] === 'gh' ? 3 : 2).join(' ')
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
}

function lastLine(text: string): string {
  return text.split('\n').map(l => l.trim()).filter(l => l !== '').pop() ?? ''
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
