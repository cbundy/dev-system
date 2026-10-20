// Refused jobs (docs/factory-loop/v2/SPEC.md 8.5): a failed Actions job GitHub did not start for the
// account's sake (sources-prs.ts classifies it `refused`) is an outside block, held by the review
// step and the merge queue's head (refused.ts). This rule file is the repo-wide half:
// - the spell: it opens with the owner tell `actions-refused` (issue null, key
//   tell:actions-refused:<job id of the earliest refused check>) while a read PR shows a refused
//   check and no spell is open, and closes with the notice `actions-resumed` after it;
// - while it is open, every PROBE_MS one refused run is re-run (the first record's in the order the
//   prs source reads them, the queue's head first), key <life>/refused/<run>/p<k>;
// - when a read shows a job started after the spell opened that is not refused, the notice goes out
//   and every record re-runs each refused run once, key <life>/refused/<run>/go;
// - each refused run is logged once as an `intervention` (cause ci-refused).
// None of it parks an issue or tells per issue. Pure.
import { gate, skip, wake, want } from '../foundation'
import type { LedgerEntry } from '../types'
import { intervention, logOnce } from './events'
import { interventionKey, lifeKey, refusedGoKey, refusedProbeKey } from './keys'
import { isRefused } from './refused'
import { excludedOf } from './rules-queue'
import { jobIdOf, prRecords } from './sources-prs'
import type { CheckRun, PrView } from './sources-prs'
import type { IssueRecord, V2Ctx } from './types'

const RULE = 'S2'
// how often a refused run is re-run while the spell is open
export const PROBE_MS = 30 * 60_000
const REASON_MAX = 200
const RERUN_ATTEMPTS = 3

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

type Held = { r: IssueRecord; view: PrView; checks: CheckRun[]; runs: string[] }

// heldOf: the records whose PR shows a refused check on an open head, in the order the prs source
// reads them (the queue's head first), each with its refused checks and their runs.
function heldOf(ctx: V2Ctx): Held[] {
  const { records, prs, reads } = ctx.v2
  const excluded = excludedOf(records, ctx.state.control.paused, reads, prs.prs)
  const out: Held[] = []
  for (const x of prRecords(records, excluded, ctx.state.ledger)) {
    const view = prs.prs.find(v => v.pr === x.pr && v.issue === x.issue)
    if (view === undefined || view.state !== 'open' || view.head === null) continue
    const checks = view.checks.filter(c => isRefused(c) && c.runId !== null)
    if (checks.length === 0) continue
    const runs = [...new Set(checks.map(c => c.runId as string))].sort((a, b) => Number(a) - Number(b))
    const r = records.find(y => y.issue === x.issue)
    if (r !== undefined) out.push({ r, view, checks, runs })
  }
  return out
}

type Spell = { key: string; at: number; resumed: LedgerEntry | null }

// spellOf: the newest refusal spell: its tell's entry, and the notice's entry once it is there.
function spellOf(ctx: V2Ctx): Spell | null {
  let tell: LedgerEntry | null = null
  for (const e of ctx.state.ledger) if (e.kind === 'tell' && e.wake === 'actions-refused' && (tell === null || e.startedAt >= tell.startedAt)) tell = e
  if (tell === null) return null
  return { key: tell.key, at: tell.startedAt, resumed: ctx.byKey.get(`tell:actions-resumed:${tell.key}`) ?? null }
}

const timeOf = (c: CheckRun): number => c.completedAt ?? c.startedAt ?? 0

// startedJob: a job started after the spell opened that GitHub did start (a refused one is not), on
// any read head: the proof that Actions runs again.
function startedJob(ctx: V2Ctx, since: number): { view: PrView; check: CheckRun } | null {
  let best: { view: PrView; check: CheckRun } | null = null
  for (const view of ctx.v2.prs.prs) {
    if (view.state !== 'open' || view.head === null) continue
    for (const c of view.checks) {
      if (c.bucket === 'refused' || c.bucket === 'skipping' || jobIdOf(c.link) === null || c.startedAt === null || c.startedAt <= since) continue
      if (best === null || c.startedAt < (best.check.startedAt ?? Infinity)) best = { view, check: c }
    }
  }
  return best
}

function rerun(ctx: V2Ctx, h: Held, runId: string, key: string, why: string): void {
  want(ctx, { kind: 'ci-rerun', key, class: 'free', rule: RULE, reason: why, issue: h.r.issue, pr: h.view.pr, runId, round: h.r.round, maxAttempts: RERUN_ATTEMPTS })
}

export function refusedRules(ctx: V2Ctx): void {
  const held = heldOf(ctx)
  logRefused(ctx, held)
  const spell = spellOf(ctx)
  const now = ctx.state.now
  if (spell !== null && spell.resumed === null) {
    const started = startedJob(ctx, spell.at)
    if (started !== null) {
      resume(ctx, spell, held, started)
      return
    }
    // a probe: the first record's first refused run, once per period of the spell
    const k = Math.floor((now - spell.at) / PROBE_MS)
    const first = held[0]
    const run = first?.runs[0]
    if (k >= 1 && first !== undefined && run !== undefined) {
      rerun(ctx, first, run, refusedProbeKey(first.r, run, k), `probe: re-run the refused run ${run} of PR #${first.view.pr}, period ${k} of the refusal spell`)
    }
    return
  }
  // no spell is open: the refused runs of one that closed get their re-run (a go that was not
  // admitted is planned again), the others open a new one
  const closed = spell?.resumed ?? null
  const old = (c: CheckRun) => closed !== null && timeOf(c) < closed.startedAt
  for (const h of held) for (const run of new Set(h.checks.filter(old).map(c => c.runId as string))) rerun(ctx, h, run, refusedGoKey(h.r, run), `re-run the refused run ${run} of PR #${h.view.pr}: Actions runs again`)
  const fresh = held.map(h => ({ ...h, checks: h.checks.filter(c => !old(c)) })).filter(h => h.checks.length > 0)
  if (fresh.length > 0) openSpell(ctx, fresh)
}

// openSpell: the owner tell, keyed by the earliest refused check's job id.
function openSpell(ctx: V2Ctx, held: readonly Held[]): void {
  const all = held.flatMap(h => h.checks.map(c => ({ h, c })))
  all.sort((a, b) => (a.c.completedAt ?? Infinity) - (b.c.completedAt ?? Infinity) || Number(jobIdOf(a.c.link) ?? 0) - Number(jobIdOf(b.c.link) ?? 0))
  const first = all[0]
  if (first === undefined) return
  const job = jobIdOf(first.c.link) ?? 'none'
  const why = first.c.refusedWhy ?? 'GitHub did not start the job'
  const prs = [...new Set(held.map(h => h.view.pr))]
  const tell = wake('tell', 'actions-refused', `tell:actions-refused:${job}`, RULE, null, { job, run: first.c.runId, prs: prs.map(p => `#${p}`).join(', '), why: clip(why, REASON_MAX) }, [
    `GitHub did not start a CI job: ${clip(why, REASON_MAX)}`,
    'This is the account (payments or the spending limit), not the code: no fixer runs and no round re-run is spent.',
    `The loop holds ${prs.length === 1 ? 'PR' : 'PRs'} ${prs.map(p => `#${p}`).join(', ')}, and resumes by itself: it re-runs one refused run every 30 minutes, and every refused run once a job starts.`,
  ])
  want(ctx, tell.kind === 'tell' ? { ...tell, loopData: { decision: 'hold', decision_reason: clip(why, REASON_MAX) } } : tell)
}

// resume: the notice, and each refused run's one re-run.
function resume(ctx: V2Ctx, spell: Spell, held: readonly Held[], started: { view: PrView; check: CheckRun }): void {
  const minutes = Math.max(0, Math.round((ctx.state.now - spell.at) / 60_000))
  const reason = clip(`job "${started.check.name.replace(/\s+/g, ' ').slice(0, 80)}" (${jobIdOf(started.check.link) ?? 'none'}) started on PR #${started.view.pr}; the spell lasted ${minutes} min`, REASON_MAX)
  const tell = wake('tell', 'actions-resumed', `tell:actions-resumed:${spell.key}`, RULE, null, { minutes, pr: started.view.pr }, [
    `GitHub starts CI jobs again (${reason}).`,
    'The loop re-runs every run it held, once.',
  ])
  want(ctx, tell.kind === 'tell' ? { ...tell, loopData: { decision: 'resume', decision_reason: reason } } : tell)
  for (const h of held) for (const run of h.runs) rerun(ctx, h, run, refusedGoKey(h.r, run), `re-run the refused run ${run} of PR #${h.view.pr}: Actions runs again`)
}

// logRefused: one `intervention` per refused run, the issue held instead of sent to a fixer.
function logRefused(ctx: V2Ctx, held: readonly Held[]): void {
  for (const h of held) {
    for (const run of h.runs) {
      const checks = h.checks.filter(c => c.runId === run)
      const fact = `${lifeKey(h.r)}/refused/${run}`
      const why = checks[0]?.refusedWhy ?? 'GitHub did not start the job'
      const event = {
        ...intervention('loop', 'ci-refused', fact, why, { issue: h.r.issue, life: h.r.life, pr: h.view.pr }),
        failed_jobs: checks.slice(0, 20).map(c => clip(c.name, 200)),
        head: h.view.head,
      }
      const key = interventionKey(fact)
      const g = gate(ctx, key, 'event')
      if (g === 'go') ctx.out.push({ kind: 'event', key, class: 'free', rule: RULE, reason: 'intervention: loop ci-refused', issue: h.r.issue, ...logOnce(ctx.v2.logged, event) })
      else if (g === 'exhausted') skip(ctx, RULE, h.r.issue, `exhausted: ${key}: the refused-run row is not logged`)
    }
  }
}
