// Lives (docs/factory-loop/v2/SPEC.md 3.2, 6.4; the owner, 2026-10-15): each claim of an issue is
// one life. A record carries its life's number since the issue's count last started (`lives`),
// which S0 sets from the issue's earlier lives; R1's release of a ghost, whose life has no record,
// counts as one too. A release at the maxLives-th life does not put the issue back in the queue:
// it gets factory:rejected. The count starts again with the first claim after a rejection, which
// S1 makes only once the owner has removed factory:rejected and added `ready`.
//
// What the loop knows of an issue's earlier lives: its records (a closed one is kept 7 days) and
// R1's releases in the ledger (kept as long), each dated by its claim. A record's `lives` already
// counts the lives before it, so pruning loses no count while the newest record is kept; a life
// older than everything kept is no longer counted, and the cap still catches churn, which comes
// within hours.
//
// Pure.
import type { LedgerEntry, Ms } from '../types'
import { lifeAt } from './keys'
import { RELEASE_OUTCOMES, releaseClaimOf, releaseKey } from './release'
import type { ReleaseOutcome } from './release'
import type { ClosedWhy, IssueRecord } from './types'

// One earlier life: its claim, when it began, the count its record carries (null for a release,
// which has no record), why it ended, and whether it ended rejected.
export type Life = { life: string; at: Ms; lives: number | null; ended: string; rejected: boolean }

// The lives before one claim, since the count last started: how many, one line each for those the
// loop still knows (oldest first), and whether the newest earlier life ended rejected (this claim
// is the first after the owner lifted factory:rejected).
export type Lives = { count: number; ended: string[]; afterReject: boolean }

const WHY_TEXT: Readonly<Record<ClosedWhy, string>> = {
  merged: 'merged',
  'merged-by-hand': 'merged by hand',
  dropped: 'dropped',
  split: 'split into sub-issues',
  'closed-on-github': 'the issue was closed on GitHub',
  'claim-lost': 'another device claimed it',
  done: 'its work had merged already',
}

const RELEASED: Readonly<Record<ReleaseOutcome, string>> = {
  requeue: 'released: a live claim with no record, put back in the queue',
  leave: 'released: a live claim with no record, out of the factory (the owner dropped it)',
  reject: 'released: a live claim with no record, rejected',
}

// endedOf: why a record's life ended, in words: its why, and its note when that says more.
export function endedOf(r: IssueRecord): string {
  if (r.state !== 'closed') return `still ${r.state}`
  const why = r.why === null ? 'closed' : WHY_TEXT[r.why]
  const note = r.notes[0]
  return note === undefined || note === r.why ? why : `${why}: ${note}`
}

// knownLives: the issue's lives the loop knows, oldest first: one per record, and one per R1
// release begun (its label entry, whose op is its outcome) for a claim no record holds.
export function knownLives(records: readonly IssueRecord[], ledger: readonly LedgerEntry[], issue: number): Life[] {
  const out = new Map<string, Life>()
  for (const r of records) if (r.issue === issue) out.set(r.life, { life: r.life, at: lifeAt(r.life) ?? 0, lives: r.lives, ended: endedOf(r), rejected: false })
  for (const e of ledger) {
    if (e.issue !== issue || e.rule !== 'R1') continue
    const claim = releaseClaimOf(issue, e.key)
    const outcome = claim === null ? undefined : RELEASE_OUTCOMES.find(o => e.key === releaseKey(issue, claim, o))
    if (claim === null || outcome === undefined || out.has(claim)) continue
    out.set(claim, { life: claim, at: lifeAt(claim) ?? 0, lives: null, ended: RELEASED[outcome], rejected: outcome === 'reject' })
  }
  return [...out.values()].sort((a, b) => a.at - b.at || (a.life < b.life ? -1 : a.life > b.life ? 1 : 0))
}

// livesBefore: the issue's lives before this claim, since the count last started (the newest
// rejected one ends the old count). Each record's own count is taken as it stands; a release
// counts one more than the life before it.
export function livesBefore(records: readonly IssueRecord[], ledger: readonly LedgerEntry[], issue: number, claim: string): Lives {
  const at = lifeAt(claim) ?? Number.MAX_SAFE_INTEGER
  const all = knownLives(records, ledger, issue).filter(l => l.life !== claim && l.at < at)
  let start = 0
  all.forEach((l, i) => {
    if (l.rejected) start = i + 1
  })
  const since = all.slice(start)
  let count = 0
  const ended: string[] = []
  for (const l of since) {
    count = l.lives ?? count + 1
    ended.push(`life ${count}, claimed ${claimedAt(l.life)}: ${l.ended}`)
  }
  // a first known life with a count above 1: the lives before it are pruned
  const first = since[0]?.lives ?? 1
  if (first > 1) ended.unshift(`${first === 2 ? 'life 1' : `lives 1 to ${first - 1}`}: no longer in the loop's records`)
  return { count, ended, afterReject: start > 0 && start === all.length }
}

// claimedAt: when a life's claim was made, as a rejection's lines say it: to the minute, in UTC.
export function claimedAt(life: string): string {
  const at = lifeAt(life)
  return at === null ? 'at an unknown time' : `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
