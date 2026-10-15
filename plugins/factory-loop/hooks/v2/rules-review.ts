// The plan side of the review step (docs/factory-loop/v2/SPEC.md 4.2 reviewing, 4.4, 8.1 to 8.6,
// property 15): in reviewing, each pass,
// - the PR first: action `pr` op `ensure`, once per seq (8.1), whose done entry names the PR; the
//   builder's title, summary and evidence ride on it from the build step's done entry;
// - the reviewer, keyed by patch and round (keys.ts reviewKey, 8.4): a done review of the head's
//   patch in this round is used, whatever its attempt, seq or head, so a head that moved without
//   changing the patch, an unknown CI result or a retry never buys a second review; otherwise this
//   seq's own reviewer (rules-agent.ts agentStep: the slot prepared, then the agent spawned), whose
//   key counts the reviewers of that patch and round, so a re-run after an unknown is a fresh one;
//   a push that changes the patch while a reviewer of this seq runs has that reviewer stopped
//   (property 6) before the new patch's starts, in a slot prepared again; a reviewer the loop
//   stopped gives no review, whatever it answered;
// - the CI half (8.5): every check run on the head counts, required or not; a failed or cancelled
//   check gets one re-run per round and run id (`ci-rerun`, once its run has finished, retried
//   with backoff on a transient error) before it counts as failed; only GitHub's own refusal of
//   the re-run counts it failed at once; a re-run whose answer was lost, or one GitHub took though
//   its call failed, is awaited; a conflicting PR (`dirty`) ends the step at once, since GitHub
//   runs no workflow on it;
// - the step's result for the table (T8, T9, T10, U1 to U4): ok once the reviewer approved the
//   head's patch in this round and every check passed or was skipped, with the approved patch and
//   the PR; not-ok with `changes` (at once: a fixer will push a new head), `ci-red` (once the
//   reviewer is done, so one fixer gets both) or `conflict`; the reviewer's own unknown; or a
//   GitHub wait past its bound (4.4: no check started ciStartMs after the latest of the head's
//   first sighting, the step's last action and the last check's completion, or a check running
//   past ciRunMs), read only while nothing of the step's own runs; the PR's own read (not read
//   this pass, older than the seq, no head, no patch id) is bounded the same way, by ciStartMs
//   from the later of the seq's start and the ensure's end;
// - the review's writes (reviewer.ts): each ended reviewer's `reviewed` event and, for a valid
//   answer, its PR comment, and each done fixer's dispositions as `verdict` events; a result is
//   taken only once they are done, so leaving reviewing never loses one.
// rules-state.ts takes the review step's plan from PLANS.
//
// Pure: the time is state.now.
import { skip, want } from '../foundation'
import type { Action, LedgerEntry, State } from '../types'
import { keyParts, lifeKey, prKey, rerunKey, reviewKey, reviewPrepareKey, short } from './keys'
import { agentStep, lifeEntries, timeoutOf, triggerOf, unknownOf } from './rules-agent'
import type { StepEnv, StepPlan, StepRead } from './rules-agent'
import { stalledTell, stopKey } from './rules-entry'
import { REVIEWERS, answerName, dispositionsOf, fixNotes, reviewComment, reviewDataOf, reviewLead, reviewNotes, reviewedEvent, reviewerOf, verdictEvent } from './reviewer'
import type { ReviewData } from './reviewer'
import type { CheckRun, PrView } from './sources-prs'
import type { IssueRecord, StepKind, TableEvent, Trigger, V2Ctx } from './types'

const RULE = 'S2'
const MIN = 60_000
// a re-run's attempts: a GitHub blip, a gh timeout or a restart during the call is retried with
// backoff; the key stays one per round and run. The merge queue's head re-runs its checks with the
// same cap (rules-queue.ts).
export const RERUN_ATTEMPTS = 3

// The start of a failed re-run's summary when GitHub itself refused it (act-ci.ts): retrying
// cannot help, so its checks count as failed.
export const RERUN_REFUSED = 'GitHub refused the re-run'

const held = (why: string): StepRead => ({ kind: 'held', why })
const fact = (f: string): Trigger => ({ kind: 'fact', fact: f })

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// --- what the step reads -----------------------------------------------------------------------------------

// lifePr: the life's PR: the record's (adopted at claim, or set when reviewing ended), else the one
// the newest done ensure of this life named (8.1). rules-state.ts reads GitHub's PR events by it,
// so a PR merged or closed by hand during the first review round is seen (E3, E4).
export function lifePr(ledger: readonly LedgerEntry[], r: Pick<IssueRecord, 'issue' | 'life' | 'pr'>): number | null {
  if (r.pr !== null) return r.pr
  let newest: { at: number; pr: number } | null = null
  for (const e of ledger) {
    if (e.kind !== 'pr' || e.status !== 'done' || e.outcome?.kind !== 'pr') continue
    const p = keyParts(e.key)
    if (p === null || p.issue !== r.issue || p.life !== r.life) continue
    const at = e.endedAt ?? e.startedAt
    if (newest === null || at > newest.at) newest = { at, pr: e.outcome.pr }
  }
  return newest?.pr ?? null
}

// baseOf: the repository's default branch, as the main checkout's read names it; main when it was
// not read.
export function baseOf(state: Pick<State, 'checkout'>): string {
  const c = state.checkout
  return c !== null && c !== undefined && 'defaultBranch' in c && c.defaultBranch !== '' ? c.defaultBranch : 'main'
}

// workOf: the builder's title, summary and evidence for the PR (8.1), from the life's newest done
// build that answered ok; a title of the loop's own when there is none (an adopted PR).
function workOf(ctx: V2Ctx, r: IssueRecord): { title: string; summary: string; evidence: string | null } {
  const build = lifeEntries(ctx, r, 'agent-step')
    .filter(e => e.status === 'done' && e.outcome?.kind === 'step' && e.outcome.step === 'build' && e.outcome.result.event === 'ok')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  const d = build?.outcome?.kind === 'step' ? record(build.outcome.result.data) : null
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return { title: text(d?.title) ?? `Factory loop work for #${r.issue}`, summary: text(d?.summary) ?? '', evidence: text(d?.evidence) }
}

// The rest of a review key within its life: review/<patch7>/r<round>/a<k>.
const REVIEW_REST = /^review\/([0-9a-f]+)\/r(\d+)\/a(\d+)$/

function reviewParts(key: string): { patch7: string; round: number; k: number } | null {
  const m = REVIEW_REST.exec(keyParts(key)?.rest ?? '')
  return m === null ? null : { patch7: m[1] as string, round: Number(m[2]), k: Number(m[3]) }
}

// stopped: the loop stopped this reviewer (a stop-agent of the life names it, rules-entry.ts
// stopKey): a push changed the patch under it, or its seq ended while it ran.
function stopped(ctx: V2Ctx, r: IssueRecord, e: LedgerEntry): boolean {
  const rest = `/stop/${e.key.slice(lifeKey(r).length + 1)}`
  return lifeEntries(ctx, r, 'stop-agent').some(s => s.key.endsWith(rest))
}

// reviewOf: a review attempt's recorded result, or null when it gave none. A reviewer the loop
// stopped gives none, whatever it answered: its patch is not the one the step judges.
function reviewOf(ctx: V2Ctx, r: IssueRecord, e: LedgerEntry): ReviewData | null {
  if (e.status !== 'done' || e.outcome?.kind !== 'step' || stopped(ctx, r, e)) return null
  return reviewDataOf(e.outcome.result.data)
}

// --- effects -------------------------------------------------------------------------------------------

// effect: one keyed effect of the step: 'done', or what the step waits on while it is planned,
// runs, backs off, or used up its attempts (it then holds the record, and the owner hears, 4.5).
function effect(ctx: V2Ctx, r: IssueRecord, action: Action, what: string): 'done' | StepRead {
  const e = ctx.byKey.get(action.key)
  if (e?.status === 'done') return 'done'
  if (e?.status === 'running') return { kind: 'running', since: e.startedAt, timeoutMs: timeoutOf(ctx, 'review'), key: action.key }
  const g = want(ctx, action)
  if (g === 'go') return held('')
  if (g === 'exhausted') {
    const error = e?.summary ?? 'used up its attempts'
    want(ctx, stalledTell(r, action.key, error, e?.endedAt ?? 0))
    return held(`stalled: ${action.key}: ${error}`)
  }
  return held(g === 'wait' ? `review: ${what} retries after its backoff` : `review: ${what} runs`)
}

const base = (r: IssueRecord, key: string, reason: string) => ({ key, class: 'free' as const, rule: RULE, reason, issue: r.issue })

// writes: the review's writes (8.3, 7.1), each planned until done: every ended reviewer of the
// life logs its `reviewed` event (verdict unknown for one that gave no valid answer) and posts its
// result on the PR when it gave one; every done fixer of the life logs its dispositions as
// `verdict` events. null when all are done, else what a result waits on.
function writes(ctx: V2Ctx, r: IssueRecord, pr: number | null, pv: PrView | undefined): StepRead | null {
  let wait: StepRead | null = null
  const note = (read: 'done' | StepRead) => {
    if (read === 'done') return
    if (wait === null || (read.kind === 'held' && read.why.startsWith('stalled'))) wait = read
  }
  for (const e of lifeEntries(ctx, r, 'agent-step')) {
    if (e.status === 'running') continue
    if (e.step === 'review') {
      const parts = reviewParts(e.key)
      if (parts === null) continue
      const d = reviewOf(ctx, r, e)
      const same = pv !== undefined && pv.patch !== null && short(pv.patch) === parts.patch7
      const head = d?.head ?? (same ? pv?.head : null) ?? r.head
      const at = d?.pr ?? pr
      if (head === null || at === null) continue
      const event = reviewedEvent(
        { issue: r.issue, branch: r.branch, pr: at, head, round: d?.round ?? parts.round, patch: d?.patch ?? (same ? (pv?.patch as string) : parts.patch7), reviewer: d?.reviewer ?? ctx.config.reviewer, answer: d?.answer ?? answerName(e.key) },
        d,
      )
      note(effect(ctx, r, { ...base(r, `${e.key}/reviewed`, `log the review of round ${event.round}`), kind: 'event', event }, 'the review\'s event'))
      if (d !== null) note(effect(ctx, r, { ...base(r, `${e.key}/comment`, `post the review of round ${d.round} on PR #${d.pr}`), kind: 'comment', on: 'pr', number: d.pr, body: reviewComment(d) }, 'the review\'s comment'))
    } else if (e.step === 'fix' && e.status === 'done' && e.outcome?.kind === 'step') {
      const result = e.outcome.result
      for (const d of dispositionsOf(result.data)) {
        const event = verdictEvent({ issue: r.issue, branch: r.branch, pr, head: result.head }, d)
        note(effect(ctx, r, { ...base(r, `${e.key}/verdict/${d.id.replace(/[^A-Za-z0-9._-]+/g, '_')}`, `log the fixer's disposition of ${d.id}`), kind: 'event', event }, 'a fixer\'s verdict event'))
      }
    }
  }
  return wait
}

// ensure: the PR's ensure of this seq (8.1): its PR once done, else what the step waits on. It
// starts only when the step may start.
function ensure(env: StepEnv): number | StepRead {
  const { ctx, r } = env
  const key = prKey(r, 'ensure')
  const e = ctx.byKey.get(key)
  if (e?.status === 'done') {
    if (e.outcome?.kind === 'pr') return e.outcome.pr
    return { kind: 'result', event: unknownOf(ctx, r, e, 'cli', `${key} ended with no PR`), trigger: triggerOf(e) }
  }
  if (e?.status !== 'running' && !env.start) return held(env.hold ?? 'review is held')
  const work = workOf(ctx, r)
  const action: Action = {
    ...base(r, key, `open, adopt or reopen the PR of #${r.issue} for review round ${r.round}`),
    kind: 'pr',
    op: 'ensure',
    branch: r.branch,
    base: baseOf(ctx.state),
    pr: lifePr(ctx.state.ledger, r),
    title: work.title,
    summary: work.summary,
    evidence: work.evidence,
    brief: r.brief,
  }
  const read = effect(ctx, r, action, 'the PR\'s ensure')
  return read === 'done' ? held('') : read
}

// --- the reviewer (8.3, 8.4) -------------------------------------------------------------------------------

// doneReview: the done review of the head's patch in this round, whatever its attempt, seq or head
// (8.4); null when there is none.
function doneReview(ctx: V2Ctx, r: IssueRecord, patch: string): { entry: LedgerEntry; data: ReviewData } | null {
  let best: { entry: LedgerEntry; data: ReviewData } | null = null
  for (const e of lifeEntries(ctx, r, 'agent-step')) {
    const parts = reviewParts(e.key)
    const d = parts !== null && parts.patch7 === short(patch) && parts.round === r.round ? reviewOf(ctx, r, e) : null
    if (d !== null && d.patch === patch && (best === null || (e.endedAt ?? 0) > (best.entry.endedAt ?? 0))) best = { entry: e, data: d }
  }
  return best
}

// reviewer: this seq's own reviewer of the patch, started when there is none. An attempt started
// in an earlier seq ended that seq (it was its result, or it is being stopped), and one the loop
// stopped gives no review, so neither key is reused: the key counts the reviewers of the patch
// and round.
//
// Property 6: a reviewer of another patch still running (a push changed the patch during review)
// is stopped first, under the key rules-entry.ts stops a step with, so this seq's entry actions
// wait for the stop and the slot's kill too; the step holds, on that reviewer's clock, until it
// has ended. The new patch's reviewer, when another of its seq came first, gets the slot
// prepared again: the seq's prepare was for the old head.
function reviewer(env: StepEnv, patch: string): StepRead {
  const { ctx, r } = env
  const reviews = lifeEntries(ctx, r, 'agent-step').flatMap(e => {
    const parts = reviewParts(e.key)
    return parts !== null && parts.round === r.round ? [{ e, parts }] : []
  })
  // a reviewer of another patch, or one already stopped (the head went back to its patch since)
  const stale = reviews.filter(({ e, parts }) => e.status === 'running' && (parts.patch7 !== short(patch) || stopped(ctx, r, e))).sort((a, b) => a.e.startedAt - b.e.startedAt)
  const first = stale[0]
  if (first !== undefined) {
    for (const { e, parts } of stale) {
      // one of an earlier seq is that seq's old step: its entry actions stop it, under this key
      const key = stopKey(r, e.key)
      const stop = ctx.byKey.get(key)
      if (e.startedAt >= r.seqAt && e.agentId !== undefined && (stop === undefined || stop.status === 'running')) {
        want(ctx, { ...base(r, key, `a push changed the patch under review from ${parts.patch7} to ${short(patch)}`), kind: 'stop-agent', agentId: e.agentId, entry: e.key })
      }
    }
    skip(ctx, RULE, r.issue, `review: the reviewer of patch ${first.parts.patch7} (${first.parts.k}) still runs; it is stopped before the reviewer of patch ${short(patch)} starts`)
    return { kind: 'running', since: first.e.startedAt, timeoutMs: timeoutOf(ctx, 'review'), key: first.e.key }
  }
  const mine = reviews.filter(({ parts }) => parts.patch7 === short(patch))
  const ours = mine.filter(({ e }) => e.startedAt >= r.seqAt && !stopped(ctx, r, e)).sort((a, b) => b.e.startedAt - a.e.startedAt)[0]
  const k = ours?.parts.k ?? Math.max(0, ...mine.map(m => m.parts.k)) + 1
  const key = reviewKey(r, patch, r.round, k)
  const seqFirst = reviews.filter(({ e }) => e.startedAt >= r.seqAt).sort((a, b) => a.e.startedAt - b.e.startedAt)[0]
  const prepare = seqFirst === undefined || seqFirst.e.key === key ? undefined : reviewPrepareKey(r, patch, r.round, k, r.attempt)
  return agentStep(env, { step: 'review', key, prepare })
}

// --- the CI half (8.5) ---------------------------------------------------------------------------------------

type Ci = { kind: 'green' } | { kind: 'red'; notes: string[] } | { kind: 'pending'; why: string; own: StepRead | null }

const failedWord = (c: CheckRun) => (c.bucket === 'cancel' ? 'was cancelled' : 'failed')
const checkName = (c: CheckRun) => `CI check "${c.name.replace(/\s+/g, ' ').slice(0, 120)}"`

// rerunRefused: the re-run ended with GitHub's own refusal (act-ci.ts), which no retry can change.
// The merge queue's head reads its re-runs the same way (steps-queue.ts ciOf).
export function rerunRefused(e: LedgerEntry): boolean {
  return e.status === 'failed' && (e.summary ?? '').startsWith(RERUN_REFUSED)
}

// ciHalf: the head's checks: green, red (a check failed after its one re-run, or GitHub refused
// to re-run it), or pending, with the re-runs running and, when `plan` is set, those it plans.
// A re-run is retried with backoff on a transient error; one that used up its attempts holds the
// record as a stalled effect (effect). A re-run whose answer was lost or timed out is awaited, as
// is a failed one GitHub took anyway (its run shows a check started or ended since): ciWait
// bounds the wait.
function ciHalf(env: StepEnv, pv: PrView, head: string, plan: boolean): Ci {
  const { ctx, r } = env
  const repo = ctx.state.repo
  const red: string[] = []
  let own: StepRead | null = null
  let awaiting = 0
  const pending = pv.checks.filter(c => c.bucket === 'pending')
  const failing = pv.checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel')
  const runs = new Map<string, CheckRun[]>()
  for (const c of failing) {
    if (c.runId === null) red.push(`${checkName(c)} ${failedWord(c)} on ${short(head)}; it is not a GitHub Actions run, so it was not re-run${c.link === null ? '' : `: ${c.link}`}`)
    else runs.set(c.runId, [...(runs.get(c.runId) ?? []), c])
  }
  for (const [runId, checks] of runs) {
    const key = rerunKey(r, r.round, runId)
    const e = ctx.byKey.get(key)
    const log = `; read its log with \`gh run view ${runId} --log-failed --repo ${repo}\``
    // the run still has a job going (GitHub refuses to re-run a run in progress), or its re-run does
    if (pending.some(c => c.runId === runId) || e?.status === 'running') {
      awaiting += checks.length
      if (e?.status === 'running') {
        const read = effect(ctx, r, rerunAction(r, pv.pr, runId), `the re-run of run ${runId}`)
        if (read !== 'done' && own === null) own = read
      }
      continue
    }
    if (e !== undefined && rerunRefused(e)) {
      for (const c of checks) red.push(`${checkName(c)} ${failedWord(c)} on ${short(head)}, and GitHub refused its one re-run (${e.summary ?? e.status})${log}`)
      continue
    }
    // GitHub took the re-run: it is done, its answer was lost or timed out (it may have started),
    // or a check of the run ended after this attempt started
    const since = (c: CheckRun) => c.completedAt !== null && e !== undefined && c.completedAt >= e.startedAt
    const took = e !== undefined && (e.status === 'done' || e.status === 'lost' || e.status === 'timed-out' || pv.checks.some(c => c.runId === runId && since(c)))
    if (took) {
      for (const c of checks) {
        // still the result from before the re-run: GitHub has not shown the re-run yet
        if (!since(c)) awaiting += 1
        else red.push(`${checkName(c)} ${failedWord(c)} on ${short(head)} after its one re-run${c.link === null ? '' : `: ${c.link}`}${log}`)
      }
      continue
    }
    // not run yet, or failed on a transient error: planned (again, after its backoff)
    awaiting += checks.length
    if (!plan || !env.start) continue
    const read = effect(ctx, r, rerunAction(r, pv.pr, runId), `the re-run of run ${runId}`)
    if (read !== 'done' && own === null) own = read
  }
  if (red.length > 0) return { kind: 'red', notes: red }
  if (own !== null || pending.length > 0 || awaiting > 0 || pv.checks.length === 0) {
    const what = pv.checks.length === 0 ? 'no check yet' : `${pending.length} pending, ${awaiting} awaiting a re-run, ${pv.checks.length - pending.length - failing.length} passed or skipped`
    return { kind: 'pending', why: `review: waits for CI on ${short(head)} (${what})`, own }
  }
  return { kind: 'green' }
}

// rerunAction: the one re-run of a run's failed jobs in this round (8.5).
function rerunAction(r: IssueRecord, pr: number, runId: string): Action {
  return { ...base(r, rerunKey(r, r.round, runId), `re-run the failed jobs of run ${runId}, once in round ${r.round}`), kind: 'ci-rerun', pr, runId, round: r.round, maxAttempts: RERUN_ATTEMPTS }
}

// ciWait: a GitHub wait past its bound (4.4), read while nothing of the step's own runs: a check
// running past ciRunMs, or none started ciStartMs after the latest of the head's first sighting,
// the step's last action and the last check's completion. null within the bounds.
function ciWait(env: StepEnv, pv: PrView, head: string, patch: string): string | null {
  const { ctx, r } = env
  const now = ctx.state.now
  const pending = pv.checks.filter(c => c.bucket === 'pending')
  const long = pending.find(c => c.startedAt !== null && now - c.startedAt > ctx.config.ciRunMs)
  if (long !== undefined) return `${checkName(long)} has run for ${Math.round((now - (long.startedAt ?? now)) / MIN)} min on ${short(head)}, past ${Math.round(ctx.config.ciRunMs / MIN)} min`
  if (pending.some(c => c.startedAt !== null)) return null
  const rerun = `${lifeKey(r)}/rerun/r${r.round}/`
  const actions = lifeEntries(ctx, r).filter(e => e.key === prKey(r, 'ensure') || e.key.startsWith(rerun) || (reviewParts(e.key)?.patch7 === short(patch) && reviewParts(e.key)?.round === r.round))
  const anchor = Math.max(r.seqAt, ctx.v2.heads[head]?.at ?? 0, ...actions.map(e => e.endedAt ?? 0), ...pv.checks.map(c => c.completedAt ?? 0))
  if (now - anchor <= ctx.config.ciStartMs) return null
  return `no check started on ${short(head)} in ${Math.round((now - anchor) / MIN)} min, past ${Math.round(ctx.config.ciStartMs / MIN)} min`
}

// viewWait: a hold on the PR's own read (not read this pass, a read older than the seq, no head,
// no patch id) is a GitHub wait too (4.4): past ciStartMs from the later of the seq's start and
// the ensure's end it is unknown (github-wait), so a PR whose read never comes cannot hold its
// slot for good. Within the bound, or during a GitHub backoff (an admission hold), the step holds
// with its skip line. A reviewer or a re-run of the step that still runs keeps its own clock.
function viewWait(env: StepEnv, pr: number, why: string): StepRead {
  const { ctx, r } = env
  const now = ctx.state.now
  const rerun = `${lifeKey(r)}/rerun/r${r.round}/`
  const own = lifeEntries(ctx, r)
    .filter(e => e.status === 'running' && ((e.kind === 'agent-step' && e.startedAt >= r.seqAt) || (e.kind === 'ci-rerun' && e.key.startsWith(rerun))))
    .sort((a, b) => a.startedAt - b.startedAt)[0]
  if (own !== undefined) {
    skip(ctx, RULE, r.issue, `review: ${why}`)
    return { kind: 'running', since: own.startedAt, timeoutMs: timeoutOf(ctx, 'review'), key: own.key }
  }
  const backoff = ctx.state.githubBackoffUntil !== null && now < ctx.state.githubBackoffUntil
  const anchor = Math.max(r.seqAt, ctx.byKey.get(prKey(r, 'ensure'))?.endedAt ?? 0)
  if (backoff || now - anchor <= ctx.config.ciStartMs) return held(`review: ${why}`)
  const reason = `${why}, ${Math.round((now - anchor) / MIN)} min after the seq's start or the PR's ensure, past ${Math.round(ctx.config.ciStartMs / MIN)} min`
  return { kind: 'result', event: unknownOf(ctx, r, null, 'github-wait', reason), trigger: fact(`github-wait:${pr}/s${r.seq}`) }
}

// --- the step ------------------------------------------------------------------------------------------------

function notOk(reason: 'changes' | 'ci-red' | 'conflict', pr: number, lead: string, items: readonly string[], rest: string): TableEvent {
  return { kind: 'not-ok', reason, data: { pr, text: lead, notes: fixNotes(lead, items, rest) } }
}

// reviewStep: the review step's read this pass.
export const reviewStep: StepPlan = env => {
  const { ctx, r } = env
  const known = lifePr(ctx.state.ledger, r)
  const pending = writes(ctx, r, known, known === null ? undefined : ctx.v2.prs.prs.find(p => p.pr === known))
  const result = (event: TableEvent, trigger: Trigger): StepRead => pending ?? { kind: 'result', event, trigger }
  if (reviewerOf(ctx.config.reviewer, { model: ctx.config.reviewerModel }) === null) {
    return held(`review: the reviewer setting names no reviewer (${ctx.config.reviewer}); known: ${Object.keys(REVIEWERS).join(', ')}`)
  }
  const ensured = ensure(env)
  if (typeof ensured !== 'number') return ensured.kind === 'result' ? result(ensured.event, ensured.trigger) : ensured
  const pr = ensured
  // an admission hold: no PR was read this pass
  const source = ctx.v2.sources.prs
  if (!source.ok) return held(`review: the PRs were not read (${source.error ?? 'no reason given'})`)
  // the PR's own read: a GitHub wait, bounded (viewWait)
  const pv = ctx.v2.prs.prs.find(p => p.pr === pr)
  const unread = (why: string) => {
    const read = viewWait(env, pr, why)
    return read.kind === 'result' ? result(read.event, read.trigger) : read
  }
  if (pv === undefined) return unread(`PR #${pr} was not read this pass`)
  if (pv.readAt < r.seqAt) return unread(`waits for a read of PR #${pr} newer than seq ${r.seq}`)
  // merged or closed: GitHub's own events take the record (rules-state.ts, E3, E4)
  if (pv.state !== 'open') return held(`review: PR #${pr} is ${pv.state}`)
  if (pv.head === null) return unread(`PR #${pr} shows no head`)
  if (pv.patch === null) return unread(`waits for the patch id of head ${short(pv.head)}`)
  const head = pv.head
  const patch = pv.patch
  const done = doneReview(ctx, r, patch)
  const changes = done !== null && done.data.verdict === 'changes' ? done.data : null
  // a conflict ends the step at once (8.5): GitHub runs no workflow on a conflicting PR
  if (pv.mergeable === 'dirty') {
    const main = baseOf(ctx.state)
    const lead = `PR #${pr} conflicts with ${main} at head ${short(head)}: merge origin/${main} into ${r.branch}, resolve every conflict keeping both sides' intent, run the gates and push ${r.branch}`
    return result(notOk('conflict', pr, lead, changes === null ? [] : reviewNotes(changes), changes?.answer ?? 'the PR'), fact(`conflict:${pr}@${head}`))
  }
  const seen = ciHalf(env, pv, head, false)
  // changes at once: a fixer will push a new head, whatever CI says of this one; a check that
  // already failed after its re-run is told beside the error findings, before any warning, and
  // the overflow line names where both are
  if (changes !== null && done !== null) {
    const ci = seen.kind === 'red' ? seen.notes : []
    const rest = ci.length === 0 ? changes.answer : `${changes.answer}, and the PR's checks`
    return result(notOk('changes', pr, reviewLead(changes), reviewNotes(changes, ci), rest), triggerOf(done.entry))
  }
  if (done === null) {
    // the reviewer, and CI's re-runs beside it, so a red check waits for one fixer with both
    const read = reviewer(env, patch)
    if (read.kind === 'result') return result(read.event, read.trigger)
    ciHalf(env, pv, head, true)
    return read
  }
  const trigger = triggerOf(done.entry)
  if (seen.kind === 'red') {
    const lead = `CI failed on head ${short(head)} of PR #${pr} in review round ${r.round}: fix what each failed check shows (its log is named below), run the gates and push ${r.branch}`
    return result(notOk('ci-red', pr, lead, seen.notes, 'the PR\'s checks'), trigger)
  }
  if (seen.kind === 'green') return result({ kind: 'ok', data: { patch, pr } }, trigger)
  const ci = ciHalf(env, pv, head, true)
  if (ci.kind === 'pending' && ci.own !== null) return ci.own
  const wait = ciWait(env, pv, head, patch)
  if (wait !== null) return result(unknownOf(ctx, r, null, 'github-wait', wait), fact(`github-wait:${pr}@${head}/r${r.round}`))
  return held(seen.why)
}

export const PLANS: Partial<Record<StepKind, StepPlan>> = { review: reviewStep }
