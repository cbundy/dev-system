// The merge queue (docs/factory-loop/v2/SPEC.md 9): its order, Q1 (update the head when it is
// behind) and Q2 (merge the head when it is clean, green and its patch is the approved one). Only
// the head is ever updated or merged. A record behind it waits untouched however far behind main it falls,
// told after its period (E6), and no other open PR is updated, rebased or closed by any rule.
// With the `mergeTrain` setting on, the record right behind the head is also tested on a train
// branch the loop pushes, never on its own branch (rules-train.ts, 9.8), and merges right after the
// head, once, with the tree that test passed (property 8).
//
// - Order (9.1): the records in merge-queue whose step is `queue`, oldest seqAt first, ties by
//   issue; paused issues and records held by the owner's `don't-merge` label (on the issue or the PR;
//   labels that cannot be read hold too) are not in it, and keep their seqAt, so the next record is the
//   head and a released one is back at its place; a held step is `held`, never `waiting`; a record on
//   triage is not in it either. Every transition
//   sets seqAt, so a head whose step ends other than ok goes to the back and the next PR becomes
//   the head (property 14).
// - The head's step (4.2): its result from the tries of its seq (steps-queue.ts), then the PR as
//   read: a changed patch, a conflict, red CI after the one re-run (or GitHub's refusal of it), an
//   untrusted author, a wait on GitHub past its bound; otherwise Q1, a CI re-run, the body written again after a linkage FAIL,
//   the PR reopened after a hand close the record handled, or Q2. A PR that did not read is a wait
//   on GitHub, bounded like any other (4.4); only a GitHub rate limit holds it with no clock.
// - Release hold (9.1): while a release bump PR's head is inside its window, at most `releaseHold` from
//   the head's anchor and with no failed check (rules-release-hold.ts), the head plans no Q2 and its step is `held`, with no clock. Every record
//   stays in the queue at its place, and Q1, CI re-runs and fixers go on, so the head is ready the
//   moment the hold ends.
// - Every action of the head is wanted through the foundation, so one that failed is tried again
//   after its backoff. A queue action or a CI re-run that used up its attempts makes the step
//   unknown, so the queue moves past a head that cannot move (9.1); a PR write is an effect, and
//   one that used up its attempts holds the record as stalled, told to the owner (4.5).
// - PLANS gives that step to rules-state.ts, which calls it with the record's hold, so Q1 and Q2
//   never start before the head's entry actions are done or while another event takes it.
//   queueRules is the composer's hook for rules over the whole queue: the merge train's (Q3,
//   rules-train.ts), which builds, deletes and sweeps train branches and touches no PR.
//
// Pure: the time is state.now.
import { want } from '../foundation'
import type { Gate } from '../foundation'
import type { Action, LedgerEntry } from '../types'
import { prKey, rerunKey, short } from './keys'
import { lifeEntries, triggerOf, unknownOf } from './rules-agent'
import { refusedLine } from './refused'
import { releaseHoldOf, utcTime } from './rules-release-hold'
import { RERUN_ATTEMPTS } from './rules-review'
import { trainDroppedOf, trainRules, trainStateOf } from './rules-train'
import type { TrainState } from './rules-train'
import type { StepEnv, StepPlan, StepRead } from './rules-agent'
import type { PrView } from './sources-prs'
import { ciOf, conflictNote, headFacts, mayHaveMerged, mergeKey, mergeResult, mergesAt, pastWait, redNotes, updateKey, updateResult } from './steps-queue'
import type { HeadFacts } from './steps-queue'
import { DONT_MERGE_LABEL, sameLabel } from './types'
import type { IssueRead, IssueRecord, StepKind, TableEvent, Trigger, V2Ctx } from './types'

// The merge tries Q2 makes of one head in one seq: a FAIL of class behind, checks or linkage (after
// the body is written again) earns another, and the guard refusing a head this often while the
// loop reads it as ready is a fact the loop cannot read, so the step is unknown.
export const MERGE_TRIES = 3

// The attempts of one CI re-run (8.5) are the review step's (RERUN_ATTEMPTS, rules-review.ts): a
// call that failed on a transient error re-ran nothing, so it is tried again after its backoff
// before the step is unknown; GitHub's own refusal is never retried.

// The mergeable states GitHub merges from (the guard's CLEAN, UNSTABLE and HAS_HOOKS).
const MERGEABLE: readonly string[] = ['clean', 'unstable', 'has_hooks']

// queueOf: the merge queue, head first (9.1). `excluded`: the issues left out of it, the paused and
// the held (excludedOf).
export function queueOf(records: readonly IssueRecord[], excluded: readonly number[]): IssueRecord[] {
  return records.filter(r => r.state === 'merge-queue' && r.step === 'queue' && !excluded.includes(r.issue)).sort((a, b) => a.seqAt - b.seqAt || a.issue - b.issue)
}

// The owner's hold on a record (9.1): the label `don't-merge` on its issue or its PR, or, failing
// closed, labels that could not be read. where: which carries the label.
export type DontMerge = { kind: 'label'; where: 'issue' | 'pr'; pr: number | null } | { kind: 'unread' }

// holdOf: the hold on a record from the issue reads and the PR views, or null. The label matches
// by its exact name, ignoring case. A positive hold wins over an unread one. Unread: the issue read
// is missing or its labels null, or a PR view exists whose labels are null; a record with no view
// yet is held by the issue alone, since Q1 and Q2 need a view anyway.
export function holdOf(reads: Readonly<Record<number, IssueRead | undefined>>, views: readonly PrView[], r: IssueRecord): DontMerge | null {
  const labels = reads[r.issue]?.labels ?? null
  const view = r.pr === null ? undefined : views.find(p => p.pr === r.pr && p.issue === r.issue)
  if (labels?.some(l => sameLabel(l, DONT_MERGE_LABEL)) === true) return { kind: 'label', where: 'issue', pr: null }
  if (view?.labels?.some(l => sameLabel(l, DONT_MERGE_LABEL)) === true) return { kind: 'label', where: 'pr', pr: view.pr }
  if (labels === null || (view !== undefined && view.labels === null)) return { kind: 'unread' }
  return null
}

// excludedOf: the issues the queue leaves out: the paused and the records holdOf holds.
export function excludedOf(records: readonly IssueRecord[], paused: readonly number[], reads: Readonly<Record<number, IssueRead | undefined>>, views: readonly PrView[]): number[] {
  return [...paused, ...records.filter(r => holdOf(reads, views, r) !== null).map(r => r.issue)]
}

// dontMergeOf: the held step's reason, or null when the record is not held.
export function dontMergeOf(ctx: V2Ctx, r: IssueRecord): string | null {
  const h = holdOf(ctx.v2.reads, ctx.v2.prs.prs, r)
  if (h === null) return null
  if (h.kind === 'unread') return 'merge queue: labels not read, held until they are'
  return `merge queue: held by the ${DONT_MERGE_LABEL} label on ${h.where === 'issue' ? 'the issue' : `PR #${h.pr}`}`
}

// queueNow: the merge queue as this pass reads it, head first.
export function queueNow(ctx: V2Ctx): IssueRecord[] {
  return queueOf(ctx.v2.records, excludedOf(ctx.v2.records, ctx.state.control.paused, ctx.v2.reads, ctx.v2.prs.prs))
}

// queueRules: the composer's hook (plan.ts) for rules over the whole queue: the merge train's Q3. The
// head's Q1 and Q2 are its step's (PLANS.queue), and no PR but the head's is touched.
export function queueRules(ctx: V2Ctx): void {
  trainRules(ctx, queueNow(ctx))
}

const fact = (f: string): Trigger => ({ kind: 'fact', fact: f })
const held = (why: string): StepRead => ({ kind: 'held', why })
const result = (event: TableEvent, trigger: Trigger): StepRead => ({ kind: 'result', event, trigger })
const sameSha = (a: string | null, b: string | null) => a !== null && b !== null && (a.startsWith(b) || b.startsWith(a))

// defaultBranch: the branch the queue merges into: the main checkout's origin/HEAD, else the one
// the prs source read main's head of.
function defaultBranch(ctx: V2Ctx): string | null {
  const c = ctx.state.checkout
  if (c !== null && !('error' in c)) return c.defaultBranch
  return ctx.v2.prs.main?.branch ?? null
}

// --- the queue's step (PLANS.queue) ------------------------------------------------------------------

const queuePlan: StepPlan = env => {
  const { ctx, r } = env
  if (ctx.state.control.paused.includes(r.issue)) return held('merge queue: paused by the owner, so the queue moves past it')
  const why = dontMergeOf(ctx, r)
  if (why !== null) return held(why)
  const queue = queueNow(ctx)
  const at = queue.findIndex(x => x.issue === r.issue && x.life === r.life)
  const head = queue[0]
  if (at > 0 && head !== undefined) return { kind: 'waiting', why: `merge queue: waits behind #${head.issue} (${at + 1} of ${queue.length})` }
  return headStep(env)
}

export const PLANS: Partial<Record<StepKind, StepPlan>> = { queue: queuePlan }

// headStep: the head's step this pass (4.2, 9.2, 9.3).
function headStep(env: StepEnv): StepRead {
  const { ctx, r } = env
  const facts = headFacts(ctx, r)
  if (facts.running !== null) return { kind: 'running', since: facts.running.startedAt, timeoutMs: ctx.config.ciStartMs, key: facts.running.key }
  const base = defaultBranch(ctx)
  const view = r.pr === null ? undefined : ctx.v2.prs.prs.find(p => p.pr === r.pr && p.issue === r.issue)
  // merged: by one of this seq's tries, or at a head a merge of the life names (a hand merge is
  // E3, which rules-state.ts takes before the step)
  const merged = facts.merges.find(e => e.status === 'done' && e.outcome?.kind === 'queue' && e.outcome.merged)
  if (merged !== undefined) return result({ kind: 'ok', data: { pr: r.pr ?? undefined, head: merged.head ?? undefined } }, triggerOf(merged))
  if (view?.state === 'merged') {
    const named = lifeEntries(ctx, r, 'queue-merge').some(e => mayHaveMerged(e) && sameSha(e.head, view.mergedHead))
    if (named) return result({ kind: 'ok', data: { pr: view.pr, head: view.mergedHead ?? undefined } }, fact(`queue-merged:${view.pr}@${short(view.mergedHead ?? '')}`))
    return held(`merge queue: PR #${view.pr} shows merged; GitHub's event is taken first`)
  }
  // the newest try of the seq that ended, unless the PR has moved past the head it tried
  const last = [...facts.updates, ...facts.merges].sort((a, b) => a.startedAt - b.startedAt).at(-1)
  if (last !== undefined) {
    const read = last.kind === 'queue-merge' ? mergeResult(ctx, r, last, base ?? 'the default branch') : updateResult(ctx, r, last, base ?? 'the default branch')
    const moved = view !== undefined && view.state === 'open' && view.head !== null && last.head !== null && !sameSha(view.head, last.head)
    if (read.kind === 'result' && !moved) return result(read.event, triggerOf(last))
  }
  if (!env.start) return held(env.hold ?? 'merge queue: held')
  if (r.pr === null) return result({ kind: 'not-ok', reason: 'patch', data: { text: 'no PR is recorded for the approved work; reviewing ensures one' } }, fact(`queue-no-pr:${r.issue}:s${r.seq}`))
  if (view === undefined) return unread(env, facts, r.pr)
  if (view.state === 'closed') return reopen(env, facts, view, base)
  if (view.head === null) return wait(env, facts, view, `merge queue: the head of PR #${view.pr} is not read`)
  return openHead(env, facts, view, view.head, base, trainStateOf(ctx, queueNow(ctx), r))
}

// unread: the head's PR was not read this pass. An untrusted author is a fact (the reader's exit
// 3): policy (9.3, T15). A rate limit that cut the reads short holds the head with no clock, as
// admission holds a step; any other read that failed, or a PR left out for no reason the source
// gives, is a wait on GitHub, bounded (4.4), so a PR that never reads makes the head unknown.
function unread(env: StepEnv, facts: HeadFacts, pr: number): StepRead {
  const { ctx, r } = env
  const prs = ctx.v2.prs
  const failed = prs.unread?.find(u => u.pr === pr && u.issue === r.issue)
  if (failed?.untrusted === true) {
    const text = `PR #${pr} was not opened by a trusted author: the reader refused it (callum-flow-issue-read exit 3)`
    return result({ kind: 'not-ok', reason: 'policy', data: { pr, text } }, fact(`queue-untrusted:${pr}:s${r.seq}`))
  }
  if (failed !== undefined) return wait(env, facts, undefined, `merge queue: PR #${pr} did not read: ${failed.why}`, failed.since)
  if (prs.cut !== undefined) return held(`merge queue: PR #${pr} was not read: ${prs.cut}`)
  const why = ctx.v2.sources.prs.ok ? 'not read this pass' : `not read: ${ctx.v2.sources.prs.error ?? 'the prs source failed'}`
  return wait(env, facts, undefined, `merge queue: PR #${pr} was ${why}`)
}

// openHead: the head's open PR, read: Q2 only when its patch is the approved one, it does not
// conflict, it is not behind and every check passed or was skipped. Behind is a fact the loop
// reads itself: the PR's base is not main's head (GitHub computes mergeability lazily, so it shows
// unknown for a while after main moves), or GitHub says so.
function openHead(env: StepEnv, facts: HeadFacts, view: PrView, head: string, base: string | null, train: TrainState): StepRead {
  const { ctx, r } = env
  const at = `${view.pr}@${short(head)}`
  if (view.patch === null) return wait(env, facts, view, `merge queue: the patch id of ${short(head)} is not computed`)
  if (view.patch !== r.approvedPatch) {
    const text = `head ${short(head)} has patch ${short(view.patch)}, not the approved ${r.approvedPatch === null ? 'none' : short(r.approvedPatch)}`
    return result({ kind: 'not-ok', reason: 'patch', data: { pr: view.pr, text } }, fact(`queue-patch:${at}:${short(view.patch)}`))
  }
  if (view.mergeable === 'dirty') {
    const note = conflictNote(r, base ?? 'the default branch')
    return result({ kind: 'not-ok', reason: 'conflict', data: { pr: view.pr, text: note, notes: [note] } }, fact(`queue-conflict:${at}`))
  }
  const tries = mergesAt(facts, head)
  const lastTry = tries.at(-1)
  const lastClass = lastTry?.outcome?.kind === 'queue' ? lastTry.outcome.failClass : null
  if (lastTry !== undefined && lastClass === 'linkage') {
    const linkage = linkageStep(env, view, tries, base)
    if (linkage !== null) return linkage
  }
  const main = ctx.v2.prs.main?.sha ?? null
  const moved = main !== null && view.base !== null && !sameSha(view.base, main)
  // a record with a live train is behind main by the head it rides on: Q1 would only undo the train
  if (train.kind === 'waiting') return wait(env, facts, view, `merge queue: ${train.why}`)
  if ((moved || view.mergeable === 'behind') && train.kind !== 'ready') return update(env, facts, view, head)
  const ci = ciOf(r, view.checks, facts.reruns)
  switch (ci.kind) {
    case 'red': {
      const notes = redNotes(ci.failed, ci.refused)
      return result({ kind: 'not-ok', reason: 'ci-red', data: { pr: view.pr, text: `red CI on ${short(head)}: ${ci.failed.map(c => c.name).join(', ')}`, notes } }, fact(`queue-ci-red:${at}`))
    }
    case 'retry':
      return rerun(env, view, ci.runs)
    case 'refused':
      return held(refusedLine('merge queue', head, ci.checks))
    case 'pending':
      return wait(env, facts, view, `merge queue: CI runs on ${short(head)} (${ci.done} of ${ci.all} checks done)`)
    case 'none':
      return wait(env, facts, view, `merge queue: no check has reported on ${short(head)} yet`)
  }
  if (!(train.kind === 'ready' ? [...MERGEABLE, 'behind'] : MERGEABLE).includes(view.mergeable ?? '')) return wait(env, facts, view, `merge queue: CI is green on ${short(head)}, and GitHub shows it ${view.mergeable ?? 'not computed'}`)
  const release = releaseHoldOf(ctx)
  if (release !== null) return held(`merge queue: held for release PR #${release.pr} until ${utcTime(release.until)}`)
  return merge(env, view, head, tries, train)
}

// update: Q1 (9.2): `gh pr update-branch`, keyed by main's head at plan time, once per base in
// the seq.
function update(env: StepEnv, facts: HeadFacts, view: PrView, head: string): StepRead {
  const { ctx, r } = env
  const main = ctx.v2.prs.main?.sha ?? null
  if (main === null) return wait(env, facts, view, `merge queue: PR #${view.pr} is behind, and main's head on origin is not read`)
  const key = updateKey(r, main)
  if (ctx.byKey.has(key)) return wait(env, facts, view, `merge queue: PR #${view.pr} was updated onto ${short(main)}; waits for GitHub to show its new head`)
  const g = want(ctx, { kind: 'queue-update', key, class: 'free', rule: 'Q1', reason: `update PR #${view.pr} onto main ${short(main)}`, issue: r.issue, pr: view.pr, base: main, head, maxAttempts: 1 })
  return planned(env, g, key, `the update of PR #${view.pr}`)
}

// merge: Q2 (9.3): `callum-flow-merge <p> --patch <approvedPatch>`, the guard inside it, keyed by
// the head and the try.
function merge(env: StepEnv, view: PrView, head: string, tries: readonly LedgerEntry[], train: TrainState): StepRead {
  const { ctx, r } = env
  const patch = r.approvedPatch
  if (patch === null) return held('merge queue: no approved patch')
  // a try that fell back from the train (a drop) is not a refusal of the guard to count
  const counted = tries.filter(e => !(e.outcome?.kind === 'queue' && e.outcome.drop !== undefined))
  if (counted.length >= MERGE_TRIES) {
    const entry = tries.at(-1) ?? null
    const event = unknownOf(ctx, r, entry, 'cli', `the merge guard refused ${short(head)} ${counted.length} times while the loop read it as ready`)
    return result(event, entry === null ? fact(`queue-tries:${view.pr}@${short(head)}`) : triggerOf(entry))
  }
  const key = mergeKey(r, head, tries.length + 1)
  // with a live train the merge carries its tree; otherwise it says why the record's train was dropped (9.8)
  const dropped = train.kind === 'ready' ? null : trainDroppedOf(ctx, queueNow(ctx), r)
  const via = train.kind === 'ready' ? { testedTree: train.train.tree } : dropped === null ? {} : { trainDropped: dropped }
  const g = want(ctx, { kind: 'queue-merge', key, class: 'free', rule: 'Q2', reason: `merge PR #${view.pr} at ${short(head)}${train.kind === 'ready' ? ` on the train ${short(train.train.train)}` : ''}`, issue: r.issue, pr: view.pr, head, patch, ...via, maxAttempts: 1 })
  return planned(env, g, key, `the merge of PR #${view.pr}`)
}

// rerun: the one CI re-run of each finished run whose checks failed (8.5), by round and run id,
// tried again when its call failed on a transient error; one used up re-ran nothing, so the checks
// after it are a fact not read, and the step is unknown, never red (in reviewing it is a stalled
// effect instead: the queue moves past a head that cannot move, 9.1).
function rerun(env: StepEnv, view: PrView, runs: readonly string[]): StepRead {
  const { ctx, r } = env
  const reads = runs.map(runId => {
    const key = rerunKey(r, r.round, runId)
    const g = want(ctx, { kind: 'ci-rerun', key, class: 'free', rule: 'S2', reason: `re-run the failed checks of run ${runId} on PR #${view.pr}`, issue: r.issue, pr: view.pr, runId, round: r.round, maxAttempts: RERUN_ATTEMPTS })
    return planned(env, g, key, `the re-run of run ${runId}`)
  })
  return reads.find(x => x.kind === 'result') ?? reads.find(x => x.kind === 'held' && x.why !== '') ?? held('')
}

// linkageStep: after a linkage FAIL the body is written again, once per queue attempt, then Q2
// runs again; a linkage FAIL after that rewrite is policy (8.1, 9.3). A write that failed is tried
// again after its backoff, and one that used up its attempts is stalled (4.5). null: the merge
// may try again.
function linkageStep(env: StepEnv, view: PrView, tries: readonly LedgerEntry[], base: string | null): StepRead | null {
  const { ctx, r } = env
  const action = prAction(ctx, r, 'body', base)
  const g = want(ctx, action)
  if (g !== 'done') return planned(env, g, action.key, `the body of PR #${view.pr}`)
  const body = ctx.byKey.get(action.key)
  const last = tries.at(-1)
  if (body !== undefined && last !== undefined && body.endedAt !== null && last.startedAt > body.endedAt) {
    const lines = last.outcome?.kind === 'queue' ? last.outcome.lines : []
    const text = `the linkage still fails after the body was written again: ${lines.join('; ') || 'no FAIL line'}`
    return result({ kind: 'not-ok', reason: 'policy', data: { pr: view.pr, text } }, fact(`queue-linkage:${view.pr}:s${r.seq}`))
  }
  return null
}

// reopen: a PR a person closed parked the record (E4); the resume brings it back here, so the
// loop's ensure reopens it (8.1, P1).
function reopen(env: StepEnv, facts: HeadFacts, view: PrView, base: string | null): StepRead {
  const action = prAction(env.ctx, env.r, 'ensure', base)
  const g = want(env.ctx, action)
  if (g === 'done') return wait(env, facts, view, `merge queue: PR #${view.pr} was reopened; waits for GitHub to show it open`)
  return planned(env, g, action.key, `the reopening of PR #${view.pr}`)
}

// prAction: the loop's own PR write (8.1, U5's executor): its title, summary and evidence are the
// builder's answer, the newest one of the life.
function prAction(ctx: V2Ctx, r: IssueRecord, op: 'ensure' | 'body', base: string | null): Action {
  const built = lifeEntries(ctx, r, 'agent-step')
    .filter(e => e.status === 'done' && e.outcome?.kind === 'step' && e.outcome.step === 'build' && e.outcome.result.event === 'ok')
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  const said = built?.outcome?.kind === 'step' ? built.outcome.result.data : null
  const o = said !== null && typeof said === 'object' ? (said as Record<string, unknown>) : {}
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return {
    kind: 'pr',
    op,
    key: prKey(r, op, r.attempt),
    class: 'free',
    rule: op === 'body' ? 'Q2' : 'S2',
    reason: op === 'body' ? `write the body of PR #${r.pr ?? '?'} again after a linkage FAIL` : `reopen PR #${r.pr ?? '?'} for the merge queue`,
    issue: r.issue,
    branch: r.branch,
    base: base ?? '',
    pr: r.pr,
    title: text(o.title) ?? `#${r.issue}`,
    summary: text(o.summary) ?? '',
    evidence: text(o.evidence),
    brief: r.brief,
  }
}

// planned: what a step's own action says once wanted: '' when planned this pass, else why not.
// One that used up its attempts is the step's unknown (cli), so the head never holds on it (an
// effect that did, a PR write, holds the record as stalled before the step runs, 4.5).
function planned(env: StepEnv, g: Gate, key: string, what: string): StepRead {
  if (g === 'go') return held('')
  if (g === 'wait') return held(`merge queue: ${what} runs again after its backoff`)
  if (g === 'running') return held(`merge queue: ${what} runs`)
  if (g === 'done') return held(`merge queue: ${what} is done`)
  const entry = env.ctx.byKey.get(key) ?? null
  const event = unknownOf(env.ctx, env.r, entry, 'cli', `${what} used up its attempts: ${entry?.summary ?? entry?.status ?? 'no try recorded'}`)
  return result(event, entry === null ? fact(`queue-exhausted:${key}`) : triggerOf(entry))
}

// wait: the head waits on GitHub with nothing of its own running; past the bound (4.4) it is
// unknown (github-wait), counted from no earlier than `since` (the first of a PR's failed reads in
// a row). A GitHub backoff holds it with no clock, as admission holds a step.
function wait(env: StepEnv, facts: HeadFacts, view: PrView | undefined, why: string, since?: number): StepRead {
  const { ctx, r } = env
  const s = ctx.state
  if (s.githubBackoffUntil !== null && s.now < s.githubBackoffUntil) return held(`${why}; GitHub reads wait out a rate limit`)
  const past = pastWait(ctx, r, view, facts, since)
  if (past === null) return held(why)
  return result(unknownOf(ctx, r, null, 'github-wait', `${why}: ${past}`), fact(`queue-wait:${r.issue}:s${r.seq}`))
}
