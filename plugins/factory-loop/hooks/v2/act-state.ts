// The record's executors (docs/factory-loop/v2/SPEC.md 3.3, 3.4, 3.5, 4.5, 14.1 H1, appendix B):
// - `transition` re-checks its trigger against the live ledger, then stores the next record with
//   a compare on (issue, life, seq) through ActIo.v2 and pings the driver. A trigger that no
//   longer holds (an answer that came after the plan) or a record that moved is a skip: nothing
//   is counted and the next pass plans again (totality/T-17).
// - `label` writes a state's label in one call (the other six off), clears every factory label
//   from a closed record, sets R1's release in one call (`ready` or factory:rejected on, the seven
//   off), or makes the eight (op ensure, `--force` updates one that exists).
// - `comment` looks for its hidden key, <!-- factory-loop:<ledger key> -->, in the issue's or the
//   PR's trusted comments before it posts, so a retry never posts twice; the comment's URL is the
//   outcome's detail.
// - `event` writes what events.ts builds (7.1), the one seam for v2's events.
// - Under planner v2 the reused `claim` also lists the open PRs and adopts the newest one by a
//   trusted author on a branch of the issue (3.5), and `heartbeat` renews the records' claims by
//   number (H1).
// The follow-ups of a closed record (rollout, close-issue, release-parent, milestone-later) and
// stop-agent keep v1's executors (act-cli.ts, act-merge.ts). Executors decide nothing: plan did.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, ExecCtx, Executor, RunResult } from '../exec'
import type { ActionKind, Action, LedgerEntry } from '../types'
import * as ARGV from './argv'
import { eventArgv } from './events'
import { neutralBody } from './prompts-work'
import { ALL_FACTORY_LABELS, FACTORY_LABELS, REJECTED_LABEL } from './types'
import type { FactoryLabel, IssueRecord, RecordRef, Trigger } from './types'

const SEC = 1000
const GH_MS = 60 * SEC
const CLAIM_MS = 120 * SEC
const EVENT_MS = 60 * SEC
const SUMMARY_MAX = 200

const ALL_LABELS: readonly FactoryLabel[] = Object.values(FACTORY_LABELS).map(l => l.name)

type Run = { ok: true; r: RunResult } | { ok: false; exec: Exec }

// run: one command through ctx.cmd; a throw (it could not start, or outlived its timeout) is a
// failed attempt.
async function run(ctx: ExecCtx, argv: string[], timeoutMs: number, stdin?: string): Promise<Run> {
  try {
    return { ok: true, r: await ctx.cmd(argv, stdin === undefined ? { timeoutMs } : { timeoutMs, stdin }) }
  } catch (err) {
    return { ok: false, exec: { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${message(err)}`) } }
  }
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

// --- transition (3.3, 4.6) ---------------------------------------------------------------------------------

// triggerStale: why the row's trigger no longer holds in the live ledger, or null when it holds:
// the life's claim is done (S0), the step's entry is as plan saw it; a GitHub or owner fact holds.
export function triggerStale(ledger: readonly LedgerEntry[], trigger: Trigger): string | null {
  if (trigger.kind === 'fact') return null
  const entry = ledger.find(e => e.key === trigger.key)
  if (entry === undefined) return `${trigger.key} is gone`
  if (trigger.kind === 'claim') return entry.status === 'done' ? null : `${trigger.key} is ${entry.status}, not done`
  if (entry.status !== trigger.status || entry.startedAt !== trigger.startedAt) return `${trigger.key} is ${entry.status} now, not ${trigger.status} as planned`
  return null
}

// recordStale: why the records no longer take this transition (the compare on issue, life and
// seq), or null.
export function recordStale(records: readonly IssueRecord[], from: RecordRef | null, next: IssueRecord): string | null {
  if (from === null) {
    if (records.some(r => r.issue === next.issue && r.life === next.life)) return `the record of #${next.issue} life ${next.life} exists already`
    const live = records.find(r => r.issue === next.issue && r.state !== 'closed')
    return live === undefined ? null : `#${next.issue} has a record of life ${live.life} that is not closed`
  }
  const cur = records.find(r => r.issue === from.issue && r.life === from.life)
  if (cur === undefined) return `#${from.issue} has no record of life ${from.life}`
  return cur.seq === from.seq ? null : `the record of #${from.issue} moved to seq ${cur.seq}`
}

// applied: the records with the transition stored: S0 adds the record, any other row replaces it.
export function applied(records: readonly IssueRecord[], from: RecordRef | null, next: IssueRecord): IssueRecord[] {
  if (from === null) return [...records, next]
  return records.map(r => (r.issue === from.issue && r.life === from.life ? next : r))
}

const transition: Executor = async (ctx, action) => {
  if (action.kind !== 'transition') return refused(`the transition executor got a ${action.kind} action`)
  const live = ctx.io.v2?.ledger?.() ?? ctx.state.ledger
  const stale = triggerStale(live, action.trigger)
  if (stale !== null) return { status: 'skipped', summary: clip(`${action.row} not applied: ${stale}; the next pass plans again`) }
  const io = ctx.io.v2
  if (io === undefined) return refused('no live records to store a transition in')
  const before = io.records()
  const moved = recordStale(before, action.from, action.next)
  if (moved !== null) return { status: 'skipped', summary: clip(`${action.row} not applied: ${moved}`) }
  const old = action.from === null ? undefined : before.find(r => r.issue === action.next.issue && r.life === action.next.life)
  const r = await io.updateRecords(records => (recordStale(records, action.from, action.next) === null ? applied(records, action.from, action.next) : null))
  if (!r.saved) {
    const now = recordStale(io.records(), action.from, action.next)
    if (now !== null) return { status: 'skipped', summary: clip(`${action.row} not applied: ${now}`) }
    return { status: 'failed', summary: clip(`${action.row}: the records store did not take seq ${action.next.seq} of #${action.next.issue}`) }
  }
  io.ping(`transition #${action.next.issue} ${action.row}`)
  const from = old?.state ?? null
  return {
    status: 'done',
    outcome: { kind: 'transition', row: action.row, event: action.event, cause: action.cause ?? null, from, to: action.next.state, step: old?.step ?? null, stored: true, via: action.via ?? action.row },
    summary: clip(`#${action.next.issue} ${from ?? 'new'} -> ${action.next.state} (${action.row}, seq ${action.next.seq})`),
  }
}

// --- label (3.4) -------------------------------------------------------------------------------------------

// labelArgvs: the commands of a label action: set (the state's on, the other six off in the same
// call), clear (all seven off), requeue (the repo's ready label on, the seven off), reject
// (factory:rejected on, the seven off), or ensure (each of the eight made or updated).
export function labelArgvs(action: Extract<Action, { kind: 'label' }>, repo: string): string[][] | string {
  if (action.op === 'ensure') return ALL_FACTORY_LABELS.map(l => ARGV.labelCreateArgv(repo, l))
  if (action.issue === null) return `label ${action.op} names no issue`
  if (action.op === 'clear') return [ARGV.labelClearArgv(repo, action.issue, ALL_LABELS)]
  if (action.op === 'reject') return [ARGV.labelReleaseArgv(repo, action.issue, REJECTED_LABEL.name, ALL_LABELS)]
  if (action.op === 'requeue') {
    if (action.ready === undefined || action.ready.trim() === '') return 'label requeue names no ready label'
    return [ARGV.labelReleaseArgv(repo, action.issue, action.ready, ALL_LABELS)]
  }
  if (action.label === null) return 'label set names no label'
  const add = action.label
  return [ARGV.labelSetArgv(repo, action.issue, add, ALL_LABELS.filter(l => l !== add))]
}

const label: Executor = async (ctx, action) => {
  if (action.kind !== 'label') return refused(`the label executor got a ${action.kind} action`)
  const argvs = labelArgvs(action, ctx.rt.repo)
  if (typeof argvs === 'string') return refused(argvs)
  for (const argv of argvs) {
    const ran = await run(ctx, argv, GH_MS)
    if (!ran.ok) return ran.exec
    if (ran.r.exitCode !== 0) return commandFailure(argv, ran.r)
  }
  const what =
    action.op === 'ensure'
      ? `the ${argvs.length} factory labels made`
      : action.op === 'clear'
        ? `factory labels cleared from #${action.issue}`
        : action.op === 'requeue'
          ? `#${action.issue} back in the queue: ${action.ready} on, factory labels off`
          : action.op === 'reject'
            ? `#${action.issue} rejected: ${REJECTED_LABEL.name} on, factory labels off`
            : `#${action.issue} labelled ${action.label}`
  return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: what }
}

// --- comment (4.5) -----------------------------------------------------------------------------------------

// hiddenKey: the marker a comment carries, by which a retry finds it.
export function hiddenKey(key: string): string {
  return `<!-- factory-loop:${key} -->`
}

// commentBody: the posted text: the body neutralized (no closing keyword before a reference, D-56)
// in blocks of lines, so a long one (a design brief) is not cut at neutral()'s 4 000 characters,
// then the hidden key on its own line.
export function commentBody(body: string, key: string): string {
  return `${neutralBody(body)}\n\n${hiddenKey(key)}\n`
}

// postedUrl: the URL of a trusted comment that carries the key, from `callum-flow-issue-read --json
// ... --comments`; '' when one carries it with no URL; null when none does; undefined when the read
// is not in its shape.
export function postedUrl(json: string, key: string): string | null | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return undefined
  }
  const comments = doc !== null && typeof doc === 'object' ? (doc as { comments?: unknown }).comments : undefined
  if (!Array.isArray(comments)) return undefined
  const marker = hiddenKey(key)
  for (const c of comments) {
    const o = c !== null && typeof c === 'object' ? (c as Record<string, unknown>) : {}
    if (typeof o.body === 'string' && o.body.includes(marker)) return typeof o.html_url === 'string' ? o.html_url : ''
  }
  return null
}

const comment: Executor = async (ctx, action) => {
  if (action.kind !== 'comment') return refused(`the comment executor got a ${action.kind} action`)
  const where = `${action.on === 'issue' ? 'issue' : 'PR'} #${action.number}`
  const readArgv = ARGV.commentsReadArgv(action.on, action.number)
  const read = await run(ctx, readArgv, GH_MS)
  if (!read.ok) return read.exec
  if (read.r.exitCode !== 0) return commandFailure(readArgv, read.r)
  const found = postedUrl(read.r.stdout, action.key)
  if (found === undefined) return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail: read.r.stdout.slice(0, 2000) }, summary: `the comments of ${where} did not read` }
  if (found !== null) return { status: 'done', outcome: { kind: 'cli', exit: 0, detail: found }, summary: clip(`already on ${where}${found === '' ? '' : `: ${found}`}`) }
  const argv = action.on === 'issue' ? ARGV.issueCommentArgv(ctx.rt.repo, action.number) : ARGV.prCommentArgv(ctx.rt.repo, action.number)
  const posted = await run(ctx, argv, GH_MS, commentBody(action.body, action.key))
  if (!posted.ok) return posted.exec
  if (posted.r.exitCode !== 0) return commandFailure(argv, posted.r)
  const url = posted.r.stdout.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return { status: 'done', outcome: { kind: 'cli', exit: 0, detail: url }, summary: clip(`commented on ${where}${url === '' ? '' : `: ${url}`}`) }
}

// --- event (7.1) -------------------------------------------------------------------------------------------

const event: Executor = async (ctx, action) => {
  if (action.kind !== 'event') return refused(`the event executor got a ${action.kind} action`)
  const argv = eventArgv(action.event)
  const ran = await run(ctx, argv, EVENT_MS)
  if (!ran.ok) return ran.exec
  if (ran.r.exitCode === 0) return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: `logged ${action.event.state}` }
  // callum-flow-event exits non-zero only on a usage error (2), a loop bug never retried
  return commandFailure(argv, ran.r)
}

// --- claim and heartbeat under planner v2 (3.5, H1) ----------------------------------------------------------

// issueBranch: a branch of issue N: issue-<N>, alone or as the last path part's prefix (3.5).
export function issueBranch(branch: string, issue: number): boolean {
  return new RegExp(`(^|/)issue-${issue}(-|$)`).test(branch)
}

// openPrsOf: the open PRs of `gh pr list --json number,headRefName` on a branch of the issue,
// newest first; null when the list does not read.
export function openPrsOf(json: string, issue: number): { pr: number; branch: string }[] | null {
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const out: { pr: number; branch: string }[] = []
  for (const raw of list) {
    const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof o.number === 'number' && Number.isInteger(o.number) && typeof o.headRefName === 'string' && issueBranch(o.headRefName, issue)) out.push({ pr: o.number, branch: o.headRefName })
  }
  return out.sort((a, b) => b.pr - a.pr)
}

// held: an adoption read that failed after the claim tool posted the claim. The attempt fails, and
// its outcome says the claim is held, so S1 retries it whatever the queue says (rules-claim.ts
// heldClaims): `ready` is gone, and the claim must not become a ghost.
function held(n: number, exec: Exec): Exec {
  if (exec.status !== 'failed') return exec
  return { ...exec, outcome: { kind: 'claim', result: 'claimed' }, summary: clip(`claimed #${n}, but the PRs to adopt did not read: ${exec.summary}`) }
}

// claim: `callum-flow-claim N` (exit 3: another device holds it). A first claim (S1) then adopts
// the newest open PR by a trusted author on a branch of the issue (callum-flow-issue-read refuses
// an untrusted one with exit 3); the others are named and left alone. A re-claim (H1) adopts
// nothing: its record keeps its branch and PR.
const claim: Executor = async (ctx, action) => {
  if (action.kind !== 'claim' || action.issue === null) return refused('a claim names an issue')
  const n = action.issue
  const argv = ARGV.claimArgv(n)
  const ran = await run(ctx, argv, CLAIM_MS)
  if (!ran.ok) return ran.exec
  if (ran.r.exitCode === 3) {
    const why = ran.r.stderr.trim().split('\n').pop() ?? ''
    return { status: 'done', outcome: { kind: 'claim', result: 'lost' }, summary: clip(`lost #${n}${why === '' ? '' : `: ${why}`}`) }
  }
  if (ran.r.exitCode !== 0) return commandFailure(argv, ran.r)
  if (action.rule !== 'S1') return { status: 'done', outcome: { kind: 'claim', result: 'claimed' }, summary: `claimed #${n} again` }
  const listArgv = ARGV.openPrsArgv(ctx.rt.repo)
  const listed = await run(ctx, listArgv, GH_MS)
  if (!listed.ok) return held(n, listed.exec)
  if (listed.r.exitCode !== 0) return held(n, commandFailure(listArgv, listed.r))
  const prs = openPrsOf(listed.r.stdout, n)
  if (prs === null) return held(n, { status: 'failed', summary: 'gh pr list: the open PRs did not read' })
  let adopted: { pr: number; branch: string } | null = null
  for (const candidate of prs) {
    const readArgv = ARGV.prReadArgv(candidate.pr)
    const read = await run(ctx, readArgv, GH_MS)
    if (!read.ok) return held(n, read.exec)
    if (read.r.exitCode === 3) continue
    if (read.r.exitCode !== 0) return held(n, commandFailure(readArgv, read.r))
    adopted = candidate
    break
  }
  const others = prs.filter(p => p !== adopted).map(p => p.pr)
  const branch = adopted?.branch ?? `issue-${n}`
  const summary = adopted === null ? `claimed #${n} on ${branch}` : `claimed #${n}, adopted PR #${adopted.pr} on ${branch}`
  return { status: 'done', outcome: { kind: 'adopt', branch, pr: adopted?.pr ?? null, others }, summary: clip(`${summary}${others.length === 0 ? '' : `; left alone: ${others.map(p => `#${p}`).join(' ')}`}`) }
}

// heartbeat: the claims of the records that are not closed, by number (H1).
const heartbeat: Executor = async (ctx, action) => {
  if (action.kind !== 'heartbeat') return refused(`the heartbeat executor got a ${action.kind} action`)
  const issues = [...new Set((ctx.state.v2?.records ?? []).filter(r => r.state !== 'closed').map(r => r.issue))].sort((a, b) => a - b)
  if (issues.length === 0) return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'no record to renew' }
  const argv = ARGV.heartbeatArgv(issues)
  const ran = await run(ctx, argv, CLAIM_MS)
  if (!ran.ok) return ran.exec
  if (ran.r.exitCode !== 0) return commandFailure(argv, ran.r)
  return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: clip(`leases renewed: ${issues.map(n => `#${n}`).join(' ')}`) }
}

export const executors: Partial<Record<ActionKind, Executor>> = { transition, label, comment, event, claim, heartbeat }

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
