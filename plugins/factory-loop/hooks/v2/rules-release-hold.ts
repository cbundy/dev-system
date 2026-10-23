// The release hold (docs/factory-loop/v2/SPEC.md 9.1): while a release bump PR's head is inside its
// window, the merge queue plans no merge (rules-queue.ts openHead), so the bump PR's CI run is not
// preempted by a merge that moves main. The window is per head: it starts at the head's anchor (the
// latest of the PR's creation, the head commit's time and the earliest start of the head's checks,
// release-hold-types.ts) and lasts `releaseHold` at most. A failed or cancelled check on the head
// ends the hold, and a push starts a new window for the new head. The bump PR is read from GitHub
// (sources-release.ts), so every device's loop honours the hold and a restart loses nothing.
//
// Each window is also an intervention (7.2): `hold:release` at the start, then one of
// `hold:release-merged`, `-closed`, `-pushed`, `-failed` or `-timeout` at the end, keyed
// `hold/release/pr<n>/h<head12>/start` and `.../end` so each is logged once (a loop upgraded
// mid-hold may hold a start in the old key form `hold/release/pr<n>/start`, which is ended once
// too). A window that runs out with the head open and its checks not red also plans the owner item
// `release-hold`. Pure.
import { wake, want } from '../foundation'
import type { LedgerEntry, Ms } from '../types'
import { intervention } from './events'
import { interventionKey } from './keys'
import { anchorOf } from './release-hold-types'
import type { ReleasePr } from './release-hold-types'
import type { Planned } from './rules-interventions'
import { excludedOf, queueOf } from './rules-queue'
import type { V2Ctx } from './types'

// The first 12 characters of a head, as the facts name it.
const head12 = (head: string) => head.slice(0, 12)

// The fact keys of one window's two interventions; a null head is the old form (one hold per PR).
export const releaseFact = (pr: number, head: string | null, at: 'start' | 'end') => (head === null ? `hold/release/pr${pr}/${at}` : `hold/release/pr${pr}/h${head12(head)}/${at}`)

// A window the ledger logged the start of: the bump PR, its head (12 characters; null in the old form) and whether the end is logged.
export type ReleaseWindow = { pr: number; head: string | null; ended: boolean }

// startsOf: every window the ledger logged the start of.
export function startsOf(ledger: readonly LedgerEntry[]): ReleaseWindow[] {
  const done = new Set(ledger.filter(e => e.status === 'done').map(e => e.key))
  const out: ReleaseWindow[] = []
  for (const e of ledger) {
    const m = /^iv\/hold\/release\/pr(\d+)\/(?:h([0-9a-f]+)\/)?start$/.exec(e.key)
    if (m?.[1] === undefined || e.status !== 'done') continue
    const pr = Number(m[1])
    const head = m[2] ?? null
    if (!out.some(w => w.pr === pr && w.head === head)) out.push({ pr, head, ended: done.has(interventionKey(releaseFact(pr, head, 'end'))) })
  }
  return out
}

// startedOpen: the windows whose start the ledger logged and not the end.
export const startedOpen = (ledger: readonly LedgerEntry[]): ReleaseWindow[] => startsOf(ledger).filter(w => !w.ended)

export type ReleaseHold = { pr: number; branch: string; until: Ms }

// utcTime: a time as the skip line and the interventions show it.
export const utcTime = (at: Ms) => `${new Date(at).toISOString().slice(11, 16)} UTC`

// listed: the open bump PRs as the source read them, the prefix checked again; none with the hold off.
function listed(ctx: V2Ctx): ReleasePr[] {
  const prefix = ctx.config.releaseBranchPrefix
  if (prefix === null || ctx.config.releaseHoldMs <= 0) return []
  return (ctx.v2.releasePrs?.prs ?? []).filter(p => p.branch.startsWith(prefix))
}

// releaseHoldOf: the bump PR the queue is held for and until when (the latest end of the windows in
// force), or null when none is in force. A head whose checks are red holds nothing.
export function releaseHoldOf(ctx: V2Ctx): ReleaseHold | null {
  const hold = ctx.config.releaseHoldMs
  let out: ReleaseHold | null = null
  for (const p of listed(ctx)) {
    const until = anchorOf(p) + hold
    if (p.checks !== 'red' && ctx.state.now < until && (out === null || until > out.until)) out = { pr: p.pr, branch: p.branch, until }
  }
  return out
}

// heldHeads: the queue's records whose merge the hold defers, by issue, head first.
function heldHeads(ctx: V2Ctx): string {
  const queue = queueOf(ctx.v2.records, excludedOf(ctx.v2.records, ctx.state.control.paused, ctx.v2.reads, ctx.v2.prs.prs))
  return queue.length === 0 ? 'no record in the queue' : `the merge of ${queue.map(r => `#${r.issue}`).join(', ')}`
}

// loggedIn: whether an intervention of this fact is done in the ledger or the event log.
const loggedIn = (ctx: V2Ctx, fact: string) => ctx.byKey.get(interventionKey(fact))?.status === 'done' || ctx.v2.logged.some(k => k.endsWith(` ${fact}`))

// fromReleaseHold: the starts and ends the facts show and the ledger or the event log has not logged.
export function fromReleaseHold(ctx: V2Ctx): Planned[] {
  const out: Planned[] = []
  const hold = ctx.config.releaseHoldMs
  const now = ctx.state.now
  const read = ctx.v2.releasePrs
  const open = new Map(listed(ctx).map(p => [p.pr, p]))
  const add = (cause: string, fact: string, reason: string, pr: number, head: string | null, failed: string[] | null = null) =>
    out.push({ key: interventionKey(fact), rule: 'Q2', event: { ...intervention('loop', cause, fact, reason, { issue: null, life: null, pr }), head, ...(failed === null ? {} : { failed_jobs: failed }) } })

  for (const p of open.values()) {
    const until = anchorOf(p) + hold
    if (now >= until || p.checks === 'red' || loggedIn(ctx, releaseFact(p.pr, p.head, 'start'))) continue
    add('hold:release', releaseFact(p.pr, p.head, 'start'), `the merge queue holds for release PR #${p.pr} (${p.branch}) at ${head12(p.head)}, checks ${p.checks ?? 'not read'}, until ${utcTime(until)}; holds ${heldHeads(ctx)}`, p.pr, p.head)
  }
  const started: { pr: number; head: string | null }[] = startedOpen(ctx.state.ledger).map(w => ({ pr: w.pr, head: w.head }))
  for (const p of open.values()) if (loggedIn(ctx, releaseFact(p.pr, p.head, 'start')) && !started.some(w => w.pr === p.pr && w.head === head12(p.head))) started.push({ pr: p.pr, head: head12(p.head) })
  for (const w of started) {
    const fact = releaseFact(w.pr, w.head, 'end')
    if (loggedIn(ctx, fact)) continue
    const p = open.get(w.pr)
    let how: 'merged' | 'closed' | 'pushed' | 'failed' | 'timeout' | null
    if (p === undefined) how = read?.left[w.pr] ?? null
    else if (w.head !== null && w.head !== head12(p.head)) how = 'pushed'
    else if (p.checks === 'red') how = 'failed'
    else how = now >= anchorOf(p) + hold ? 'timeout' : null
    if (how === null) continue
    const text =
      how === 'timeout' ? `is still open after its window, checks ${p?.checks ?? 'not read'}` : how === 'pushed' ? `was pushed to (now at ${head12(p?.head ?? '')}), so the window of ${w.head ?? 'its head'} ended` : how === 'failed' ? `has failed checks (${p?.failed.join(', ') || 'none named'})` : how
    add(`hold:release-${how}`, fact, `release PR #${w.pr} ${text}; the hold deferred ${heldHeads(ctx)}`, w.pr, w.head === null ? (p?.head ?? null) : p !== undefined && head12(p.head) === w.head ? p.head : w.head, how === 'failed' ? (p?.failed ?? []) : null)
  }
  return out
}

// releaseHoldRules: the owner item for a window that ran out with the head open and its checks not
// red, once per head (the key); it needs the window's start logged, so a PR first seen after its
// window tells nothing.
export function releaseHoldRules(ctx: V2Ctx): void {
  const hold = ctx.config.releaseHoldMs
  for (const p of listed(ctx)) {
    const anchor = anchorOf(p)
    if (p.checks === 'red' || ctx.state.now < anchor + hold || !loggedIn(ctx, releaseFact(p.pr, p.head, 'start'))) continue
    const minutes = Math.floor((ctx.state.now - anchor) / 60_000)
    const fields = { pr: p.pr, branch: p.branch, head: p.head, minutes, checks: p.checks ?? 'not read' }
    want(ctx, wake('tell', 'release-hold', `tell:release-hold:${p.pr}:${head12(p.head)}`, 'Q2', null, fields))
  }
}
