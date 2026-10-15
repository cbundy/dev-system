// The claims (docs/factory-loop/v2/SPEC.md 3.3, 3.5, 4.1, 14.1): S1 claims a ready issue as far
// as the filters, the capacity and the tier allow; row S0 makes the queued record from the life's
// done claim, so a v2 claim never becomes a ghost; H1 renews the claims of the records that are
// not closed, and claims a lapsed one again onto its record (exit 3 is claim-lost, which
// rules-state.ts reads), logging the record's current transition again so readers see its stage.
//
// - A life is its claim's time in base-36 seconds (keys.ts lifeOf): a first claim is keyed
//   i<N>/claim/<life>, and a retry of a failed one keeps that key; a re-claim is keyed under the
//   life, i<N>/l<life>/claim/<at>.
// - The claim filters are v1's D1 filters (open, trusted, `ready`, no skip label, not blocked, not
//   a tracker, not skipped or paused, `only` and `priority` order), but a drop applies to the life
//   it closed (4.1), so re-adding `ready` brings a dropped issue back, and only another device's
//   live work keeps an issue from a claim; the claim tool is the arbiter.
// - Capacity: records queued or in flight, plus claims in flight, stay under K
//   (maxInFlightIssues); a parked record never counts. Slow claims once per pass and none within
//   slowGapMs of the last; merge work never holds a claim back (section 15).
//
// Pure: the time is state.now.
import { gate, skip, wake, want } from '../foundation'
import type { IssueView, LedgerEntry, Ms } from '../types'
import { claimKey, keyParts, lifeOf, reclaimKey, transitionKey } from './keys'
import { lifeEntries } from './rules-agent'
import { ROW_S0, madeRecord } from './table'
import type { Claimed } from './table'
import type { IssueRecord, V2Ctx } from './types'

const FIRST = /^i([1-9]\d*)\/claim\/([0-9a-z]+)$/

// claimOf: a first claim's issue and life, from its key; null for any other key.
export function claimOf(key: string): { issue: number; life: string } | null {
  const m = FIRST.exec(key)
  return m === null || m[1] === undefined || m[2] === undefined ? null : { issue: Number(m[1]), life: m[2] }
}

// claimedOf: what a done claim gave: the claim the record is made from (its adopted PR, 3.5),
// 'lost' when another device holds the issue (exit 3), or null when it is not done. A first claim
// names its life in its key; a re-claim is keyed under the life it renews.
export function claimedOf(e: LedgerEntry): Claimed | 'lost' | null {
  if (e.status !== 'done') return null
  const c = claimOf(e.key) ?? keyParts(e.key)
  if (c === null) return null
  const { issue, life } = c
  const o = e.outcome
  if (o?.kind === 'claim') return o.result === 'lost' ? 'lost' : { issue, life, branch: `issue-${issue}`, pr: null, others: [] }
  if (o?.kind === 'adopt') return { issue, life, branch: o.branch, pr: o.pr, others: [...o.others] }
  return null
}

const firstClaims = (ctx: V2Ctx) => ctx.state.ledger.filter(e => e.kind === 'claim' && claimOf(e.key) !== null)

const hasRecord = (ctx: V2Ctx, issue: number, life: string) => ctx.v2.records.some(r => r.issue === issue && r.life === life)

// mayHold: a first claim that ended without done but may hold the claim on GitHub: the claim tool
// posted it and the adoption's reads failed after (the claim executor records outcome claim
// `claimed` on the failed entry), or the loop reloaded mid-claim (lost). The issue's `ready` is
// gone then, so the queue no longer lists it.
function mayHold(e: LedgerEntry): boolean {
  return e.status === 'lost' || (e.status === 'failed' && e.outcome?.kind === 'claim' && e.outcome.result === 'claimed')
}

// heldClaims: per issue with no record that is not closed, its newest first claim when that one
// may hold the claim (mayHold). S1 finishes each whatever the queue says, so a v2 claim never
// becomes a ghost (3.3, totality/T-14): a retry is safe, because callum-flow-claim keeps its own
// live claim without posting again.
function heldClaims(ctx: V2Ctx): LedgerEntry[] {
  const latest = new Map<number, LedgerEntry>()
  for (const e of firstClaims(ctx)) {
    const n = claimOf(e.key)?.issue
    if (n === undefined) continue
    const seen = latest.get(n)
    if (seen === undefined || e.startedAt > seen.startedAt) latest.set(n, e)
  }
  return [...latest.entries()]
    .filter(([n, e]) => mayHold(e) && !ctx.v2.records.some(r => r.issue === n && r.state !== 'closed'))
    .sort(([a], [b]) => a - b)
    .map(([, e]) => e)
}

// inFlightClaims: the issues whose first claim is in flight: running, done with no record yet
// (row S0 makes it this pass), or one that may hold the claim and has attempts left (S1 finishes
// it). They hold their place under the cap, and R1 (6.2) never takes one for a ghost.
export function inFlightClaims(ctx: V2Ctx): Set<number> {
  const out = new Set<number>()
  for (const e of firstClaims(ctx)) {
    const got = claimedOf(e)
    if (e.status === 'running' || (got !== null && got !== 'lost' && !hasRecord(ctx, got.issue, got.life))) out.add(claimOf(e.key)?.issue ?? 0)
  }
  for (const e of heldClaims(ctx)) if (gate(ctx, e.key, 'claim') !== 'exhausted') out.add(e.issue ?? claimOf(e.key)?.issue ?? 0)
  out.delete(0)
  return out
}

// lastClaimAt: when the record's claim was last made or made again: its lease starts then.
export function lastClaimAt(ctx: V2Ctx, r: IssueRecord): Ms {
  let at = 0
  for (const e of [...firstClaims(ctx), ...lifeEntries(ctx, r, 'claim')]) {
    if (e.issue !== r.issue || e.endedAt === null) continue
    const got = claimedOf(e)
    if (got === null || got === 'lost' || got.life !== r.life) continue
    at = Math.max(at, e.endedAt)
  }
  return at
}

// --- S0: a record from its done claim ----------------------------------------------------------------

function makeRecords(ctx: V2Ctx): void {
  for (const e of firstClaims(ctx).sort((a, b) => a.startedAt - b.startedAt)) {
    const got = claimedOf(e)
    if (got === null || got === 'lost' || hasRecord(ctx, got.issue, got.life)) continue
    const live = ctx.v2.records.find(r => r.issue === got.issue && r.state !== 'closed')
    if (live !== undefined) {
      skip(ctx, 'S1', got.issue, `claimed ${e.key}, but a record of life ${live.life} is not closed`)
      continue
    }
    const next = madeRecord(got, ctx.state.now)
    want(ctx, {
      kind: 'transition',
      key: transitionKey(next),
      class: 'free',
      rule: 'S1',
      reason: `S0: claimed${got.pr === null ? '' : `, PR #${got.pr} adopted`}`,
      issue: got.issue,
      row: ROW_S0.id,
      event: 'ok',
      from: null,
      next,
      trigger: { kind: 'claim', key: e.key },
      cause: null,
      via: got.pr === null ? 'claim' : 'adopt',
    })
  }
}

// --- S1: claims that may be held, finished -------------------------------------------------------------

// finishClaims: each first claim that may hold the claim (heldClaims) runs again under its own key
// until it is done, then S0 makes its record; one that used up its attempts is told once, and R1
// releases it. Not new work: no capacity, tier or owner filter holds it. The issues it handled.
function finishClaims(ctx: V2Ctx): Set<number> {
  const handled = new Set<number>()
  for (const e of heldClaims(ctx)) {
    const n = e.issue ?? claimOf(e.key)?.issue
    if (n === undefined) continue
    handled.add(n)
    if (gate(ctx, e.key, 'claim') === 'exhausted') {
      skip(ctx, 'S1', n, `exhausted: ${e.key}`)
      want(ctx, wake('tell', 'stalled', `tell:stalled:${e.key}:${e.endedAt ?? e.startedAt}`, 'S1', n, { issue: n, key: e.key }, [`error: ${e.summary ?? e.status}`]))
      continue
    }
    want(ctx, { kind: 'claim', key: e.key, class: 'free', rule: 'S1', reason: 'finish the claim: it may hold the issue already', issue: n })
  }
  return handled
}

// --- S1: new claims ------------------------------------------------------------------------------------

const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// The stages of another device's live work.
const LIVE_STAGES: readonly string[] = ['designing', 'implementing', 'in pipeline', 'parked', 'ready to merge']

// candidateProblem: why a queue issue may not be claimed, or null (v1's D1 filters, 4.1's drop).
function candidateProblem(ctx: V2Ctx, issue: IssueView | undefined, n: number): string | null {
  const { config, state } = ctx
  if (issue === undefined) return 'not observed'
  if (issue.open !== true) return issue.open === false ? 'closed' : 'GitHub state unknown'
  if (issue.trusted !== true) return issue.trusted === false ? 'untrusted author' : 'author unknown'
  if (issue.labels === null) return 'labels unknown'
  if (!issue.labels.some(l => sameLabel(l, config.readyLabel))) return `no ${config.readyLabel} label`
  const skipLabel = issue.labels.find(l => config.skipLabels.some(s => sameLabel(s, l)))
  if (skipLabel !== undefined) return `label ${skipLabel}`
  if (issue.blockedBy === null) return 'blockers unknown'
  if (issue.blockedBy > 0) return `blocked by ${issue.blockedBy} open issue${issue.blockedBy > 1 ? 's' : ''}`
  if (issue.subIssues === null) return 'sub-issues unknown'
  if (issue.subIssues > 0) return 'tracker (has sub-issues)'
  if (issue.epic === true) return 'tracker (title)'
  if (issue.holder !== null && issue.holder !== state.device && issue.stage !== null && LIVE_STAGES.includes(issue.stage)) return `another device holds it (${issue.holder})`
  if (state.control.skip.includes(n)) return 'owner: skip'
  if (state.control.paused.includes(n)) return 'owner: paused'
  return null
}

// onlyIssues: control.only with each tracker in it standing for its open sub-issues (D-35); a
// tracker whose sub-issues are not read yet stands for nothing this pass.
function onlyIssues(ctx: V2Ctx, issues: Map<number, IssueView>): number[] {
  const out: number[] = []
  for (const n of ctx.state.control.only) {
    const issue = issues.get(n)
    const tracker = issue !== undefined && ((issue.subIssues ?? 0) > 0 || issue.epic === true)
    const add = (m: number) => {
      if (!out.includes(m)) out.push(m)
    }
    if (!tracker) add(n)
    else if (issue.subIssueList === null) skip(ctx, 'S1', n, 'owner: only names this tracker, whose sub-issues are not read yet')
    else issue.subIssueList.forEach(add)
  }
  return out
}

function claims(ctx: V2Ctx, handled: ReadonlySet<number>): void {
  const { state, config, tier } = ctx
  for (const source of ['queue', 'github'] as const) {
    if (!state.sources[source].ok) {
      skip(ctx, 'S1', null, `${source} source unavailable`)
      return
    }
  }
  const control = state.control
  const issues = new Map(state.issues.map(i => [i.number, i]))
  const only = onlyIssues(ctx, issues)
  for (const n of only) if (!state.queue.includes(n)) skip(ctx, 'S1', n, 'owner: only names it, but it is not in the ready queue')
  const listed = (control.only.length > 0 ? only : control.priority).filter(n => state.queue.includes(n))
  const order = [...listed, ...[...state.queue].filter(n => !listed.includes(n)).sort((a, b) => a - b)]
  const live = ctx.v2.records.filter(r => r.state !== 'closed')
  const firsts = firstClaims(ctx)
  const inFlight = inFlightClaims(ctx)
  const held = live.filter(r => r.state !== 'parked').length + inFlight.size
  const cap = config.maxInFlightIssues
  const lastClaim = Math.max(0, ...firsts.map(e => e.startedAt))
  let started = 0
  for (const n of order) {
    const record = live.find(r => r.issue === n)
    if (record !== undefined) {
      skip(ctx, 'S1', n, `in the factory as ${record.state}`)
      continue
    }
    if (inFlight.has(n) || handled.has(n)) continue
    const why = candidateProblem(ctx, issues.get(n), n)
    if (why !== null) {
      skip(ctx, 'S1', n, why)
      continue
    }
    const latest = firsts.filter(e => e.issue === n).sort((a, b) => a.startedAt - b.startedAt).at(-1)
    let key = claimKey(n, lifeOf(state.now))
    if (latest !== undefined && latest.status !== 'done') {
      // a claim that failed runs again under its own key, until its attempts are used up
      if (gate(ctx, latest.key, 'claim') === 'exhausted') {
        skip(ctx, 'S1', n, `exhausted: ${latest.key}`)
        want(ctx, wake('tell', 'stalled', `tell:stalled:${latest.key}:${latest.endedAt ?? latest.startedAt}`, 'S1', n, { issue: n, key: latest.key }, [`error: ${latest.summary ?? latest.status}`]))
        continue
      }
      key = latest.key
    } else if (latest !== undefined && claimedOf(latest) === 'lost' && latest.startedAt > (issues.get(n)?.stageSince ?? 0)) {
      skip(ctx, 'S1', n, 'another device holds it')
      continue
    }
    let limit: string | null = null
    if (control.noNewWork) limit = 'owner: no new work'
    else if (control.only.length > 0 && !only.includes(n)) limit = `owner: only ${control.only.map(o => `#${o}`).join(' ')}`
    else if (tier === 'stop-new' || tier === 'stop-all') limit = `tier ${tier}`
    else if (cap !== null && held + started >= cap) limit = `capacity: ${held + started} of ${cap} queued or in flight`
    else if (control.serial && held + started > 0) limit = 'owner: one at a time'
    else if (tier === 'slow' && started > 0) limit = 'slow: one claim per pass'
    else if (tier === 'slow' && lastClaim > 0 && state.now - lastClaim < config.slowGapMs) limit = 'slow: too soon after the last claim'
    else if (started >= config.maxStartsPerPass) limit = 'claims per pass'
    if (limit !== null) {
      if (limit.startsWith('capacity')) ctx.atCap = true
      skip(ctx, 'S1', n, limit)
      continue
    }
    if (want(ctx, { kind: 'claim', key, class: 'start', rule: 'S1', reason: 'ready and unblocked', issue: n }) === 'go') started += 1
  }
}

// claimRules: S0 for the claims that are done, then S1 finishes the claims that may be held and
// makes new ones, last of the record's rules: work in flight goes first.
export function claimRules(ctx: V2Ctx): void {
  makeRecords(ctx)
  claims(ctx, finishClaims(ctx))
}

// --- H1: the heartbeat and the re-claims ---------------------------------------------------------------

function lastDone(ctx: V2Ctx, kind: LedgerEntry['kind']): LedgerEntry | undefined {
  let last: LedgerEntry | undefined
  for (const e of ctx.state.ledger) {
    if (e.kind !== kind || e.status !== 'done' || e.endedAt === null) continue
    if (last === undefined || e.endedAt > (last.endedAt ?? 0)) last = e
  }
  return last
}

// latestReclaim: the record's newest re-claim, under its life.
export function latestReclaim(ctx: V2Ctx, r: IssueRecord): LedgerEntry | undefined {
  return lifeEntries(ctx, r, 'claim')
    .sort((a, b) => a.startedAt - b.startedAt)
    .at(-1)
}

// reclaimLost: the record's newest re-claim exited 3: another device holds a live claim.
export function reclaimLost(ctx: V2Ctx, r: IssueRecord): LedgerEntry | null {
  const e = latestReclaim(ctx, r)
  return e !== undefined && claimedOf(e) === 'lost' ? e : null
}

// lapsedAt: when the record's claim lapsed after its last claim (4.1), from facts, never from the
// ready label list, which lags behind edits (3.4): a `reclaimed` event after the last claim (the
// sweep or a release gave it back), or the factory source showing this device's claim lapsed
// with its lease ending after the last claim. null: it holds.
function lapsedAt(ctx: V2Ctx, r: IssueRecord, at: Ms): Ms | null {
  const view = ctx.state.issues.find(i => i.number === r.issue)
  if (view === undefined) return null
  if (view.reclaimedAt !== null && view.reclaimedAt > at) return view.reclaimedAt
  if (view.claimLapsedAt !== null && view.holder === ctx.state.device && view.claimLapsedAt > at) return view.claimLapsedAt
  return null
}

// reclaim: a record whose claim lapsed (lapsedAt) or that the factory shows another device holding
// (after a heartbeat's time, so the factory has seen the record's own claim) is claimed again onto
// the record (4.1); a done one logs the record's current transition event again.
function reclaim(ctx: V2Ctx, r: IssueRecord): void {
  const { state, config } = ctx
  const latest = latestReclaim(ctx, r)
  if (latest?.status === 'running') return
  const got = latest === undefined ? null : claimedOf(latest)
  if (got === 'lost') return
  if (latest !== undefined && latest.status !== 'done') {
    if (gate(ctx, latest.key, 'claim') !== 'exhausted') {
      want(ctx, { kind: 'claim', key: latest.key, class: 'free', rule: 'H1', reason: 'claim it again: the last try failed', issue: r.issue })
      return
    }
    // used up: the owner hears once, and `/factory retry N` clears it (4.5)
    skip(ctx, 'H1', r.issue, `stalled: ${latest.key}: ${latest.summary ?? latest.status}`)
    want(ctx, wake('tell', 'stalled', `tell:stalled:${latest.key}:${latest.endedAt ?? latest.startedAt}`, 'H1', r.issue, { issue: r.issue, key: latest.key }, [`error: ${latest.summary ?? latest.status}`]))
    return
  }
  if (latest !== undefined && got !== null) {
    const t = ctx.byKey.get(transitionKey(r))
    const o = t?.outcome?.kind === 'transition' ? t.outcome : null
    want(ctx, {
      kind: 'event',
      key: `${latest.key}/transition`,
      class: 'free',
      rule: 'H1',
      reason: 'claimed again: its stage logged again',
      issue: r.issue,
      event: { state: 'transition', record: r, row: o?.row ?? 'H1', from: o?.from ?? null, via: 'reclaim' },
    })
  }
  const at = lastClaimAt(ctx, r)
  const view = state.issues.find(i => i.number === r.issue)
  const lapsed = lapsedAt(ctx, r, at)
  const other = view !== undefined && view.holder !== null && view.holder !== state.device && state.now - at >= config.heartbeatEveryMs
  if (lapsed === null && !other) return
  const reason = lapsed !== null ? (view?.reclaimedAt === lapsed ? 'its claim lapsed: the sweep gave it back (reclaimed)' : 'its claim lapsed: the factory shows its lease ended') : `the factory shows ${view?.holder ?? 'another device'} holding it`
  want(ctx, { kind: 'claim', key: reclaimKey(r, lifeOf(state.now)), class: 'free', rule: 'H1', reason, issue: r.issue })
}

// heartbeatRules (H1): `callum-flow-claim --heartbeat <N...>` for the records that are not closed
// when a lease is due (each was last renewed by the later of its claim and the last heartbeat) or
// on the first pass after a load; then each one's re-claim when it lapsed.
export function heartbeatRules(ctx: V2Ctx): void {
  const { state, config } = ctx
  const live = ctx.v2.records.filter(r => r.state !== 'closed').sort((a, b) => a.issue - b.issue)
  if (live.length === 0) return
  const beatAt = lastDone(ctx, 'heartbeat')?.endedAt ?? 0
  const stalest = Math.min(...live.map(r => Math.max(beatAt, lastClaimAt(ctx, r))))
  const afterLoad = stalest >= state.loadedAt
  if (!afterLoad || state.now - stalest >= config.heartbeatEveryMs) {
    want(ctx, { kind: 'heartbeat', key: `heartbeat:${beatAt}`, class: 'free', rule: 'H1', reason: afterLoad ? 'lease renewal due' : 'first pass after load', issue: null })
  }
  for (const r of live) reclaim(ctx, r)
}
