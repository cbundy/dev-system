// The release hold (docs/factory-loop/v2/SPEC.md 9.1): while a release bump PR is open, within
// `releaseHold` of its creation, the merge queue plans no merge (rules-queue.ts openHead), so the
// bump PR's CI run is not preempted by a merge that moves main. The bump PR is read from GitHub
// (sources-release.ts), so every device's loop honours the hold, a restart loses nothing, and a
// release that failed holds for the window at most.
//
// Each hold is also an intervention (7.2): `hold:release` at the start, then one of
// `hold:release-merged`, `hold:release-closed` or `hold:release-timeout` at the end, keyed
// `hold/release/pr<n>/start` and `.../end` so each is logged once. Pure.
import type { LedgerEntry, Ms } from '../types'
import { intervention } from './events'
import { interventionKey } from './keys'
import type { Planned } from './rules-interventions'
import { excludedOf, queueOf } from './rules-queue'
import type { ReleasePr, V2Ctx } from './types'

// The fact keys of one hold's two interventions.
export const releaseFact = (pr: number, at: 'start' | 'end') => `hold/release/pr${pr}/${at}`

// startedOpen: the bump PRs whose hold the ledger logged the start of and not the end.
export function startedOpen(ledger: readonly LedgerEntry[]): number[] {
  const done = new Set(ledger.filter(e => e.status === 'done').map(e => e.key))
  const out: number[] = []
  for (const e of ledger) {
    const m = /^iv\/hold\/release\/pr(\d+)\/start$/.exec(e.key)
    if (m?.[1] === undefined || e.status !== 'done') continue
    const pr = Number(m[1])
    if (!done.has(interventionKey(releaseFact(pr, 'end'))) && !out.includes(pr)) out.push(pr)
  }
  return out
}

export type ReleaseHold = { pr: number; branch: string; createdAt: Ms; until: Ms }

// utcTime: a time as the skip line and the interventions show it.
export const utcTime = (at: Ms) => `${new Date(at).toISOString().slice(11, 16)} UTC`

// listed: the open bump PRs as the source read them, the prefix checked again; none with the hold off.
function listed(ctx: V2Ctx): ReleasePr[] {
  const prefix = ctx.config.releaseBranchPrefix
  if (prefix === null || ctx.config.releaseHoldMs <= 0) return []
  return (ctx.v2.releasePrs?.prs ?? []).filter(p => p.branch.startsWith(prefix))
}

// releaseHoldOf: the bump PR the queue is held for and until when (the latest end of the windows in
// force), or null when none is in force.
export function releaseHoldOf(ctx: V2Ctx): ReleaseHold | null {
  const hold = ctx.config.releaseHoldMs
  let out: ReleaseHold | null = null
  for (const p of listed(ctx)) {
    const until = p.createdAt + hold
    if (ctx.state.now < until && (out === null || until > out.until)) out = { ...p, until }
  }
  return out
}

// heldHeads: the queue's records whose merge the hold defers, by issue, head first.
function heldHeads(ctx: V2Ctx): string {
  const queue = queueOf(ctx.v2.records, excludedOf(ctx.v2.records, ctx.state.control.paused, ctx.v2.reads, ctx.v2.prs.prs))
  return queue.length === 0 ? 'no record in the queue' : `the merge of ${queue.map(r => `#${r.issue}`).join(', ')}`
}

// fromReleaseHold: the starts and ends the facts show and the ledger or the event log has not logged.
export function fromReleaseHold(ctx: V2Ctx): Planned[] {
  const out: Planned[] = []
  const logged = (fact: string) => ctx.byKey.get(interventionKey(fact))?.status === 'done' || ctx.v2.logged.some(k => k.endsWith(` ${fact}`))
  const hold = ctx.config.releaseHoldMs
  const now = ctx.state.now
  const read = ctx.v2.releasePrs
  const open = new Map(listed(ctx).map(p => [p.pr, p]))
  const add = (cause: string, fact: string, reason: string, pr: number) =>
    out.push({ key: interventionKey(fact), rule: 'Q2', event: intervention('loop', cause, fact, reason, { issue: null, life: null, pr }) })

  for (const p of open.values()) {
    if (now >= p.createdAt + hold || logged(releaseFact(p.pr, 'start'))) continue
    add('hold:release', releaseFact(p.pr, 'start'), `the merge queue holds for release PR #${p.pr} (${p.branch}), opened ${utcTime(p.createdAt)}, until ${utcTime(p.createdAt + hold)}; holds ${heldHeads(ctx)}`, p.pr)
  }
  const started = new Set([...startedOpen(ctx.state.ledger), ...[...open.keys()].filter(n => logged(releaseFact(n, 'start')))])
  for (const n of started) {
    const fact = releaseFact(n, 'end')
    if (logged(fact)) continue
    const p = open.get(n)
    const how = p !== undefined ? (now >= p.createdAt + hold ? 'timeout' : null) : (read?.left[n] ?? null)
    if (how === null) continue
    const text = how === 'timeout' ? 'is still open after its window' : how === 'merged' ? 'merged' : 'closed'
    add(`hold:release-${how}`, fact, `release PR #${n} ${text}; the hold deferred ${heldHeads(ctx)}`, n)
  }
  return out
}
