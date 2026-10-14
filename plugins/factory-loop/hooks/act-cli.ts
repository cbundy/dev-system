// The executors that spend no tokens (SPEC 6.1): the CLI kinds, plus stop-agent and title,
// which call the engine instead of a command. Each CLI kind turns its action into the steps of
// its catalogue row, runs them in order through ctx.cmd and ctx.event, stops at the first
// failure and says what happened. They decide nothing (plan did). The steps and the reading of
// their output are pure functions below, so tests, the replay harness and the argv safety test
// read them without the engine.
import { detailOf, rateLimited } from './exec'
import type { EventFields, Exec, ExecCtx, Executor, RunInit, RunResult } from './exec'
import { parsePool } from './parse'
import { issueFromBranch } from './plan'
import type { Action, ActionKind, LedgerEntry } from './types'

const SEC = 1000
const SUMMARY_MAX = 200

// The kinds this module runs as commands.
export type CliKind =
  | 'heartbeat'
  | 'sweep'
  | 'claim'
  | 'close-issue'
  | 'release-parent'
  | 'abandon'
  | 'milestone-later'
  | 'milestone-expect'
  | 'pr-reopen'
  | 'pr-comment'
  | 'pr-close'
  | 'release-worktree'
  | 'restart-self'

// Each command's timeout, by its action's kind (SPEC 6.1). A step of a multi-step kind gets
// the kind's timeout. stop-agent (30 s) and title (10 s) are engine calls, timed by ActIo.
export const CLI_TIMEOUT_MS: Record<CliKind, number> = {
  heartbeat: 120 * SEC,
  sweep: 300 * SEC,
  claim: 120 * SEC,
  'close-issue': 60 * SEC,
  'release-parent': 60 * SEC,
  abandon: 60 * SEC,
  'milestone-later': 60 * SEC,
  'milestone-expect': 60 * SEC,
  'pr-reopen': 60 * SEC,
  'pr-comment': 60 * SEC,
  'pr-close': 60 * SEC,
  'release-worktree': 120 * SEC,
  'restart-self': 600 * SEC,
}

// The exit recorded for a command that never exited: it could not start, or it outlived its
// timeout and $.process.run ended it. Either counts as failed (SPEC 10.1).
export const NO_EXIT = -1

// One step of an action: a command, or a factory event through ctx.event (SPEC 7.4). `ok`
// lists the exits that are an answer, not a failure (default: 0 only).
export type Step =
  | { argv: string[]; timeoutMs: number; stdin?: string; ok?: number[] }
  | { event: string; fields: EventFields }

// stepsOf: the steps one action runs, in order (SPEC 6.1), or why it is refused: a loop bug,
// never retried. Every command runs from the main checkout. gh gets --repo, so a write can
// only reach the configured repo (SPEC 11.5).
export function stepsOf(action: Action, repo: string, inDevLabel: string): Step[] | string {
  const n = action.issue === null ? null : String(action.issue)
  const noIssue = `${action.kind} names no issue`
  const unlabel = (issue: string, kind: 'release-parent' | 'abandon'): Step => ({
    argv: ['gh', 'issue', 'edit', issue, '--repo', repo, '--remove-label', inDevLabel],
    timeoutMs: CLI_TIMEOUT_MS[kind],
  })
  switch (action.kind) {
    case 'heartbeat':
      return [{ argv: ['callum-flow-claim', '--heartbeat'], timeoutMs: CLI_TIMEOUT_MS.heartbeat }]
    case 'sweep':
      return [{ argv: ['callum-flow-sweep'], timeoutMs: CLI_TIMEOUT_MS.sweep }]
    case 'claim':
      // exit 3: another device's live claim won, an answer (SPEC 10.5)
      return n === null ? noIssue : [{ argv: ['callum-flow-claim', n], timeoutMs: CLI_TIMEOUT_MS.claim, ok: [0, 3] }]
    case 'close-issue':
      return n === null
        ? noIssue
        : [{ argv: ['gh', 'issue', 'close', n, '--repo', repo, '--reason', 'completed'], timeoutMs: CLI_TIMEOUT_MS['close-issue'] }]
    case 'milestone-later':
      return n === null ? noIssue : [{ argv: ['callum-flow-milestone', 'plan', n, 'later'], timeoutMs: CLI_TIMEOUT_MS['milestone-later'] }]
    case 'release-parent':
      // the parent is now a tracker. The label comes off first, so the event records a release
      // that happened, and a retry after a failed event repeats only the label edit.
      return n === null
        ? noIssue
        : [unlabel(n, 'release-parent'), { event: 'abandoned', fields: { issue: action.issue, note: `split into ${action.created.join(',')}` } }]
    case 'abandon': {
      if (n === null) return noIssue
      const fields: EventFields = { issue: action.issue, note: action.note }
      if (action.run !== null) fields.run = action.run
      if (action.branch !== null) fields.branch = action.branch
      return [unlabel(n, 'abandon'), { event: 'abandoned', fields }]
    }
    case 'milestone-expect':
      // the CLI takes the reason as one line (exit 2 otherwise)
      return [{ argv: ['callum-flow-milestone', 'expect', action.bump, oneLine(action.why)], timeoutMs: CLI_TIMEOUT_MS['milestone-expect'] }]
    case 'pr-reopen': {
      // a reopen makes GitHub register the PR's checks again (rule P6a)
      const pr = String(action.pr)
      return [
        { argv: ['gh', 'pr', 'close', pr, '--repo', repo], timeoutMs: CLI_TIMEOUT_MS['pr-reopen'] },
        { argv: ['gh', 'pr', 'reopen', pr, '--repo', repo], timeoutMs: CLI_TIMEOUT_MS['pr-reopen'] },
      ]
    }
    case 'pr-comment':
      return [
        {
          argv: ['gh', 'pr', 'comment', String(action.pr), '--repo', repo, '--body-file', '-'],
          timeoutMs: CLI_TIMEOUT_MS['pr-comment'],
          stdin: action.body,
        },
      ]
    case 'pr-close': {
      // rule M8 (#553): read the PR, then close it with a comment linking the one its work moved
      // to; the executor runs the close only once the read says so (prCloseCheck). Never
      // --delete-branch: the old branch keeps its commits.
      const pr = String(action.pr)
      const comment = `Superseded by #${action.by}: a conflict fix moved this work to \`${action.newBranch}\`. Closed by the factory loop.`
      return [
        { argv: ['gh', 'pr', 'view', pr, '--repo', repo, '--json', 'state,headRefName'], timeoutMs: CLI_TIMEOUT_MS['pr-close'] },
        { argv: ['gh', 'pr', 'close', pr, '--repo', repo, '--comment', comment], timeoutMs: CLI_TIMEOUT_MS['pr-close'] },
      ]
    }
    case 'release-worktree':
      // Empty stdin: were the slot dirty after all, treehouse's discard prompt reads end of
      // input and keeps the work. The status read proves the slot is back (SPEC 6.1).
      return [
        { argv: ['treehouse', 'return', action.path], timeoutMs: CLI_TIMEOUT_MS['release-worktree'], stdin: '' },
        { argv: ['treehouse', 'status', '--json'], timeoutMs: CLI_TIMEOUT_MS['release-worktree'] },
      ]
    case 'restart-self':
      // only once the drain for an update is complete (rule H4, D-15)
      return action.rule === 'H4'
        ? [{ argv: ['dev-restart-self'], timeoutMs: CLI_TIMEOUT_MS['restart-self'] }]
        : `restart-self comes only from rule H4, not ${action.rule}`
    default:
      return `${action.kind} runs no command`
  }
}

// Exit 2 is a usage error, a loop bug never retried (SPEC 10.1), for the image's own CLIs
// (callum-flow-*, dev-restart-self). gh exits 2 when a command is cancelled and 1 on bad
// usage; treehouse exits 1 on bad usage too.
export function usageError(argv: readonly string[], exit: number): boolean {
  return exit === 2 && argv[0] !== 'gh' && argv[0] !== 'treehouse'
}

// commandFailure: a command that exited with a failure: its exit and detailOf() in the
// outcome (SPEC 10.1), and a GitHub rate limit flagged for the driver's backoff (SPEC 10.2).
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

// prCloseCheck: what `gh pr view --json state,headRefName` says about closing a superseded run's
// PR: 'close' for an open PR on a branch of its issue other than the one the work moved to; done,
// left alone, for one already merged or closed; refused for one on any other branch.
export function prCloseCheck(action: Extract<Action, { kind: 'pr-close' }>, json: string): 'close' | Exec {
  let pr: Record<string, unknown> = {}
  try {
    const v: unknown = JSON.parse(json)
    if (v !== null && typeof v === 'object') pr = v as Record<string, unknown>
  } catch {
    // read below as unreadable
  }
  const { state, headRefName: head } = pr
  if (state === 'MERGED' || state === 'CLOSED') {
    return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: `PR #${action.pr} is already ${state.toLowerCase()}: left alone` }
  }
  if (state !== 'OPEN' || typeof head !== 'string') {
    return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail: json.slice(0, 2000) }, summary: `gh pr view: PR #${action.pr} did not read` }
  }
  if (head === action.newBranch || issueFromBranch(head) !== action.issue) {
    return refused(`PR #${action.pr} is on ${head}, not a superseded branch of #${action.issue}`)
  }
  return 'close'
}

// slotState: the pool's word for the slot at this path in `treehouse status --json`
// ('available' once returned), or null when the listing is unreadable or lacks the slot.
export function slotState(json: string, path: string): string | null {
  return parsePool(json, 0)?.slots.find(s => s.path === path)?.state ?? null
}

// finish: what the steps' output says once every step passed (SPEC 6.1 "Outcome recorded").
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
    case 'release-parent':
      return ok(`released #${action.issue}, split into ${action.created.join(',')}`)
    case 'abandon':
      return ok(`abandoned #${action.issue}`)
    case 'milestone-later':
    case 'milestone-expect':
      // the CLI prints what moved or the line it set; a repo not opted in is a no-op note
      return ok(out(last) || action.kind)
    case 'pr-reopen':
      return ok(`PR #${action.pr} closed and reopened`)
    case 'pr-comment': {
      // gh prints the new comment's URL
      const url = last === undefined ? '' : firstLine(last.stdout)
      return ok(`commented on PR #${action.pr}${url === '' ? '' : `: ${url}`}`)
    }
    case 'release-worktree': {
      const state = last === undefined ? null : slotState(last.stdout, action.path)
      if (state === 'available') return ok(`returned ${action.path}`)
      const detail = `${action.path} is ${state ?? 'not listed'} after treehouse return`
      return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail }, summary: clip(detail) }
    }
    case 'restart-self':
      // the session ends; the loop resumes on load (SPEC 7.5)
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
        await ctx.event(step.event, step.fields)
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
    const steps = stepsOf(action, ctx.rt.repo, ctx.rt.config.inDevLabel)
    if (typeof steps === 'string') return refused(steps)
    const ran = await runSteps(ctx, steps)
    return 'failed' in ran ? ran.failed : finish(action, ran.results)
  }
}

// pr-close (rule M8, #553): the read, then the close only when prCloseCheck allows it, so a PR
// that merged or closed meanwhile, or one on another branch, is never closed.
const prClose: Executor = async (ctx, action) => {
  if (action.kind !== 'pr-close') return refused(`the pr-close executor got a ${action.kind} action`)
  const steps = stepsOf(action, ctx.rt.repo, ctx.rt.config.inDevLabel)
  const [view, close] = typeof steps === 'string' ? [] : steps
  if (view === undefined || close === undefined) return refused(typeof steps === 'string' ? steps : 'pr-close has no steps')
  const read = await runSteps(ctx, [view])
  if ('failed' in read) return read.failed
  const check = prCloseCheck(action, read.results[0]?.stdout ?? '')
  if (check !== 'close') return check
  const closed = await runSteps(ctx, [close])
  if ('failed' in closed) return closed.failed
  return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: clip(`closed PR #${action.pr}, superseded by #${action.by}`) }
}

// ownAgent: the ledger holds a running entry for this agent id, so the loop spawned it. An
// agent the loop did not spawn is never stopped (SPEC 6.1).
export function ownAgent(ledger: readonly LedgerEntry[], agentId: string): boolean {
  return ledger.some(e => e.status === 'running' && e.agentId === agentId)
}

// stop-agent: TaskStop through ActIo, for one of the loop's own agents (rules A1, A2). A stop
// that is not supported is recorded as failed with the reason (SPEC 13).
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

// title: /rename through ActIo (rule O1, SPEC 9.1).
const title: Executor = async (ctx, action) => {
  if (action.kind !== 'title') return refused(`the title executor got a ${action.kind} action`)
  try {
    await ctx.io.rename(action.text)
  } catch (err) {
    return { status: 'failed', summary: clip(`rename failed: ${message(err)}`) }
  }
  return { status: 'done', summary: clip(action.text) }
}

export const cliExecutors: Partial<Record<ActionKind, Executor>> = {
  heartbeat: command('heartbeat'),
  sweep: command('sweep'),
  claim: command('claim'),
  'close-issue': command('close-issue'),
  'release-parent': command('release-parent'),
  abandon: command('abandon'),
  'milestone-later': command('milestone-later'),
  'milestone-expect': command('milestone-expect'),
  'pr-reopen': command('pr-reopen'),
  'pr-comment': command('pr-comment'),
  'pr-close': prClose,
  'release-worktree': command('release-worktree'),
  'restart-self': command('restart-self'),
  'stop-agent': stopAgent,
  title,
}

// --- small text helpers ---------------------------------------------------------------------

// label: a command's name for a summary: gh with its noun and verb, others with one argument.
function label(argv: readonly string[]): string {
  return argv.slice(0, argv[0] === 'gh' ? 3 : 2).join(' ')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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
