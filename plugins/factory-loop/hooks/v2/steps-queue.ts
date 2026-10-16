// How the merge queue's head step reads its result (docs/factory-loop/v2/SPEC.md 4.2, 4.4, 8.5,
// 9). The head runs no agent, so it adds no StepModule (STEPS stays empty): its result comes from
// the queue's own actions of the seq (Q1's update and Q2's merge, act-queue.ts), the CI re-runs
// of its round, and the PR as the prs source read it (sources-prs.ts). This module reads them, for
// rules-queue.ts, which plans:
// - keys: a queue action is one try of the head in one seq. Q1 is keyed by main's head at plan
//   time and Q2 by the PR head, as 9.2 and 9.3 key them, each with the seq (and a merge with its
//   try), so a head that comes back to the front after an unknown can try again, and a merge
//   after a body re-render or a re-run of the same head is a try of its own;
// - mergeResult and updateResult: a finished try, by the guard's FAIL class (9.3) or the update's
//   refusal (9.2), each a done try whose outcome carries its class (act-queue.ts): ok once
//   merged; not-ok with conflict, patch or policy; again (no transition) for behind, checks and
//   linkage; unknown for a failed try (a CLI failure, a guard that could not read, class read) or
//   a lost one;
// - mayHaveMerged: a merge try that merged, or may have (running or lost), never a refusal;
// - ciOf: the checks on the head, each failed or cancelled one after its one re-run per round, read
//   as the review step reads its own (8.5);
// - pastWait: the bound on a wait on GitHub with nothing of the head's own running (4.4).
//
// Pure: the time is state.now.
import type { LedgerEntry, Ms } from '../types'
import { keyParts, prKey, queueKey, rerunKey, short } from './keys'
import { lifeEntries, unknownOf } from './rules-agent'
import { rerunRefused } from './rules-review'
import type { CheckRun, PrView } from './sources-prs'
import type { StepModule } from './steps'
import type { AgentStep, GuardClass, IssueRecord, RecordRef, TableEvent, V2Ctx } from './types'

export const STEPS: Partial<Record<AgentStep, StepModule>> = {}

// --- keys ---------------------------------------------------------------------------------------------

// updateKey: Q1's update of the seq onto main's head (9.2): each outside merge moves main and so
// earns one more update; the seq lets a head that came back to the front update again.
export function updateKey(r: RecordRef, base: string): string {
  return `${queueKey(r, 'update', base)}/s${r.seq}`
}

// mergeKey: Q2's k-th merge try of the seq at this PR head (9.3).
export function mergeKey(r: RecordRef, head: string, k: number): string {
  return `${queueKey(r, 'merge', head)}/s${r.seq}/m${k}`
}

const QUEUE_REST = /^queue\/(update|merge)\/([0-9a-f]+)\/s(\d+)(?:\/m(\d+))?$/

// The parts of a queue key: its op, the hash it names (main's or the PR's head, 7 characters), its
// seq and, for a merge, its try.
export function queueKeyParts(key: string): { op: 'update' | 'merge'; sha: string; seq: number; k: number | null } | null {
  const m = QUEUE_REST.exec(keyParts(key)?.rest ?? '')
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null
  return { op: m[1] as 'update' | 'merge', sha: m[2], seq: Number(m[3]), k: m[4] === undefined ? null : Number(m[4]) }
}

const sameSha = (a: string | null, b: string | null) => a !== null && b !== null && (a.startsWith(b) || b.startsWith(a))

// --- the head's facts -------------------------------------------------------------------------------------

// What the head did in this seq: its updates and merges, oldest first; the CI re-runs of its
// round; what of it runs (a queue action, a re-run, a PR write); and when the newest of them ended.
export type HeadFacts = {
  updates: LedgerEntry[]
  merges: LedgerEntry[]
  reruns: LedgerEntry[]
  running: LedgerEntry | null
  lastEnd: Ms | null
}

const byStart = (a: LedgerEntry, b: LedgerEntry) => a.startedAt - b.startedAt

export function headFacts(ctx: V2Ctx, r: IssueRecord): HeadFacts {
  const life = lifeEntries(ctx, r)
  const ofSeq = (op: 'update' | 'merge') =>
    life.filter(e => e.kind === `queue-${op}` && queueKeyParts(e.key)?.op === op && queueKeyParts(e.key)?.seq === r.seq).sort(byStart)
  const updates = ofSeq('update')
  const merges = ofSeq('merge')
  // the round's re-runs, by the prefix of their key (one per run id)
  const round = rerunKey(r, r.round, '')
  const reruns = life.filter(e => e.kind === 'ci-rerun' && e.key.startsWith(round)).sort(byStart)
  const writes = [prKey(r, 'body', r.attempt), prKey(r, 'ensure')].flatMap(k => {
    const e = ctx.byKey.get(k)
    return e === undefined ? [] : [e]
  })
  const own = [...updates, ...merges, ...writes, ...reruns.filter(e => e.startedAt >= r.seqAt)]
  const running = own.find(e => e.status === 'running') ?? null
  const ends = own.flatMap(e => (e.endedAt === null ? [] : [e.endedAt]))
  return { updates, merges, reruns, running, lastEnd: ends.length === 0 ? null : Math.max(...ends) }
}

// mergesAt: the merge tries of the seq at this head, oldest first.
export function mergesAt(facts: HeadFacts, head: string): LedgerEntry[] {
  return facts.merges.filter(e => sameSha(queueKeyParts(e.key)?.sha ?? null, short(head)))
}

// --- a finished try ----------------------------------------------------------------------------------------

// What a finished try says: the step's result for the table, or `again`: no transition, the head's
// state is read afresh (a guard FAIL of class behind, checks or linkage, 9.3; an update done).
export type TryRead = { kind: 'result'; event: TableEvent } | { kind: 'again'; cls: GuardClass | null }

const notOk = (reason: string, data: Record<string, unknown>): TryRead => ({ kind: 'result', event: { kind: 'not-ok', reason, data } })

// lines: the guard's FAIL lines a try recorded, as one line of text.
function linesOf(e: LedgerEntry): string {
  const o = e.outcome
  const lines = o?.kind === 'queue' ? o.lines.filter(l => /\bFAIL\b/.test(l)) : []
  return lines.length === 0 ? (e.summary ?? e.status) : lines.join('; ')
}

// conflictNote: what the fixer is told of a conflict (9.7): merge the default branch in, never
// rebase.
export function conflictNote(r: IssueRecord, base: string): string {
  return `PR #${r.pr ?? '?'} conflicts with ${base}: merge origin/${base} into ${r.branch}, resolve the conflicts and push; never rebase or force-push`
}

// mayHaveMerged: a queue-merge try that merged (done, merged), or may have (running, or lost to a
// reload); a refusal (done, not merged) and a failed or timed-out try never did.
export function mayHaveMerged(e: LedgerEntry): boolean {
  if (e.status === 'running' || e.status === 'lost') return true
  return e.status === 'done' && e.outcome?.kind === 'queue' && e.outcome.merged
}

// mergeResult: a merge try that ended (9.3). Merged is ok; a refusal, done with the guard's class,
// is read by its class; a failed try (a CLI failure, a refusal GitHub gave no reason for, a guard
// that could not read: class read, act-queue.ts), or one lost to a reload, is unknown. The PR's
// own merged state is read before this, so a lost try that merged is ok.
export function mergeResult(ctx: V2Ctx, r: IssueRecord, e: LedgerEntry, base: string): TryRead {
  const o = e.outcome?.kind === 'queue' ? e.outcome : null
  if (e.status === 'done' && o?.merged === true) return { kind: 'result', event: { kind: 'ok', data: { pr: r.pr ?? undefined, head: o.head ?? e.head ?? undefined } } }
  const text = linesOf(e)
  const pr = r.pr ?? undefined
  switch (e.status === 'done' ? (o?.failClass ?? null) : null) {
    case 'policy':
      return notOk('policy', { pr, text })
    case 'patch':
      return notOk('patch', { pr, text })
    case 'conflict':
      return notOk('conflict', { pr, text, notes: [conflictNote(r, base)] })
    case 'behind':
    case 'checks':
    case 'linkage':
      return { kind: 'again', cls: o?.failClass ?? null }
    default:
      return { kind: 'result', event: unknownOf(ctx, r, e, 'cli', `the merge of PR #${r.pr ?? '?'} at ${short(e.head ?? '')} ended ${e.status}: ${text}`) }
  }
}

// updateResult: an update that ended (9.2): a refusal for a conflict (done, class conflict) is
// not-ok; any other done update moved the head (or found it up to date), so the head is read
// afresh; anything else is unknown.
export function updateResult(ctx: V2Ctx, r: IssueRecord, e: LedgerEntry, base: string): TryRead {
  const o = e.outcome?.kind === 'queue' ? e.outcome : null
  if (e.status === 'done' && o?.failClass === 'conflict') return notOk('conflict', { pr: r.pr ?? undefined, text: o.lines.join('; ') || 'the update conflicts', notes: [conflictNote(r, base)] })
  if (e.status === 'done') return { kind: 'again', cls: null }
  return { kind: 'result', event: unknownOf(ctx, r, e, 'cli', `the update of PR #${r.pr ?? '?'} ended ${e.status}: ${e.summary ?? 'no reason given'}`) }
}

// --- CI on the head (8.5) -----------------------------------------------------------------------------------

// What the head's checks say: every check on the head counts, required or not, and a failed or
// cancelled one gets one re-run per round (by its run, rerunKey) before it counts as failed, read
// as the review step reads its own (8.5, rules-review.ts ciHalf):
// - red: a check failed after its re-run, GitHub refused the re-run (rerunRefused), or none is
//   possible (no run to re-run);
// - retry: the finished runs whose failed checks get their one re-run now, or again after a
//   transient failure of the call (a GitHub blip, a gh error): it re-ran nothing, so the check is
//   never red for it (the step tries the re-run again after its backoff, or is unknown once it is
//   used up);
// - pending: a check has not finished; a failed check's run still has a job going (GitHub refuses
//   to re-run a run in progress); or a re-run's result is not read yet: it runs, or GitHub took it
//   (done, its answer lost or timed out, or a check of the run ended since its start) and the read
//   is older than it. pastWait bounds that wait, so a re-run GitHub never took makes the step
//   unknown, never red;
// - none: no check on the head yet; green: every check passed or was skipped.
export type CiRead =
  | { kind: 'red'; failed: CheckRun[]; refused: Record<string, string> }
  | { kind: 'retry'; runs: string[] }
  | { kind: 'pending'; done: number; all: number }
  | { kind: 'none' }
  | { kind: 'green' }

export function ciOf(r: IssueRecord, checks: readonly CheckRun[], reruns: readonly LedgerEntry[]): CiRead {
  const red: CheckRun[] = []
  const refused: Record<string, string> = {}
  const rerun = new Set<string>()
  let waiting = false
  const going = new Set(checks.flatMap(c => (c.bucket === 'pending' && c.runId !== null ? [c.runId] : [])))
  for (const c of checks.filter(x => x.bucket === 'fail' || x.bucket === 'cancel')) {
    if (c.runId === null) {
      red.push(c)
      continue
    }
    const runId = c.runId
    const key = rerunKey(r, r.round, runId)
    const e = reruns.find(x => x.key === key)
    if (going.has(runId) || e?.status === 'running') {
      waiting = true
      continue
    }
    if (e === undefined) {
      rerun.add(runId)
      continue
    }
    if (rerunRefused(e)) {
      red.push(c)
      refused[runId] = e.summary ?? e.status
      continue
    }
    const since = (x: CheckRun) => x.completedAt !== null && x.completedAt >= e.startedAt
    const took = e.status === 'done' || e.status === 'lost' || e.status === 'timed-out' || checks.some(x => x.runId === runId && since(x))
    if (!took) rerun.add(runId)
    else if (since(c)) red.push(c)
    else waiting = true
  }
  if (red.length > 0) return { kind: 'red', failed: red, refused }
  if (rerun.size > 0) return { kind: 'retry', runs: [...rerun].sort() }
  const done = checks.filter(c => c.bucket === 'pass' || c.bucket === 'skipping').length
  if (waiting || checks.some(c => c.bucket === 'pending')) return { kind: 'pending', done, all: checks.length }
  return checks.length === 0 ? { kind: 'none' } : { kind: 'green' }
}

// redNotes: the failed checks, by name and link, for the fixer (9.7: it reads their logs with
// gh run view --log-failed), each with its re-run or GitHub's refusal of it.
export function redNotes(failed: readonly CheckRun[], refused: Readonly<Record<string, string>> = {}): string[] {
  return failed.slice(0, 8).map(c => {
    const no = c.runId === null ? undefined : refused[c.runId]
    const after = c.runId === null ? '' : no === undefined ? ` after its one re-run (run ${c.runId})` : `, and GitHub refused its one re-run (${no})`
    return `check ${c.name} failed${after}${c.link === null ? '' : `: ${c.link}`}`
  })
}

// --- the wait on GitHub (4.4) ----------------------------------------------------------------------------------

// becameHead: when the record last came to the front of the queue, as near as the ledger tells:
// its own seq, or a later transition that took another record off its queue step.
export function becameHead(ctx: V2Ctx, r: IssueRecord): Ms {
  let at = r.seqAt
  for (const e of ctx.state.ledger) {
    const o = e.outcome
    if (e.kind !== 'transition' || e.issue === r.issue || e.status !== 'done' || o?.kind !== 'transition') continue
    if (o.from === 'merge-queue' && o.step === 'queue' && e.endedAt !== null && e.endedAt > at) at = e.endedAt
  }
  return at
}

// pastWait: why a wait on GitHub with nothing of the head's own running is past its bound (4.4),
// or null: a check has run longer than ciRunMs; or no check has started ciStartMs after the
// latest of the head's first sighting, the head coming to the front, the end of its last action,
// the last check's completion and `since` (the first of its PR's failed reads in a row). Bounding
// the wait also bounds a head GitHub shows blocked, unknown or draft with nothing to run.
export function pastWait(ctx: V2Ctx, r: IssueRecord, view: PrView | undefined, facts: HeadFacts, since = 0): string | null {
  const now = ctx.state.now
  const { ciStartMs, ciRunMs } = ctx.config
  const checks = view?.checks ?? []
  const runs = checks.filter(c => c.startedAt !== null && c.completedAt === null)
  const long = runs.find(c => now - (c.startedAt ?? now) > ciRunMs)
  if (long !== undefined) return `check ${long.name} has run for ${minutes(now - (long.startedAt ?? now))} min, past its ${minutes(ciRunMs)}`
  if (runs.length > 0) return null
  const seen = view?.head === null || view?.head === undefined ? undefined : ctx.v2.heads[view.head]?.at
  const completed = checks.flatMap(c => (c.completedAt === null ? [] : [c.completedAt]))
  const from = Math.max(becameHead(ctx, r), seen ?? 0, facts.lastEnd ?? 0, since, ...completed)
  return now - from > ciStartMs ? `nothing started on GitHub for ${minutes(now - from)} min, past its ${minutes(ciStartMs)}` : null
}

function minutes(ms: Ms): number {
  return Math.round(ms / 60_000)
}
