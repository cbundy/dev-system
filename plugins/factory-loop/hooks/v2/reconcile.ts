// R1, every pass (docs/factory-loop/v2/SPEC.md 6.2), before the record's rules: every issue that
// shows as active must have a live step.
//
// 1. Records are never released: the table keeps them live (every running step and waiting state
//    has a timeout, 4.4), and a stuck one goes down the unknown path to a park with a question.
// 2. A live claim with no record is a ghost: the `factory` source shows the issue live with this
//    device as the holder, it has no record and no claim action is in flight. R1 releases it at
//    once (release.ts): its agents stopped and its factory labels off, then, once those have ended
//    and W2 has freed any loop slot leased for it, `reclaimed` (still labelled ready) or
//    `abandoned`, last. In observe mode and in the shadow the same plan is logged, not executed.
//    A release is keyed by the claim it ends (claimOf). Once its event is done the issue is no
//    ghost of that claim, whatever the factory still shows, so S1 may claim it again.
// 3. Only this device's claims: another device's claims and labels are never looked at
//    (totality/T-02).
// 4. The main-checkout tripwire (10.7): a change to the main checkout since the checkout the
//    tripwire last settled on (new tracked changes, or a moved HEAD) tells the owner once, with the
//    paths and the steps that ran in that window. It is level-triggered: the change stays pending,
//    and its tell planned on every pass R1 runs, until the tell is done (checkoutBaseOf), so a pass
//    that drops it (one wake at a time, a rate cap, a store-blind pass) loses nothing. No step's
//    outcome changes, and the loop never cleans the checkout.
//
// R1 has no mode, no approval and no hold on claims (section 15, "Reconcile has no mode"). The
// one-shot migration for what v1 left behind is bin/factory-reconcile (6.3). Pure: the time is
// state.now.
import { attemptsKindOf, gate, listedLive, skip, wake, want } from '../foundation'
import type { Gate } from '../foundation'
import type { Action, Checkout, IssueView, LedgerEntry, Ms, Stage } from '../types'
import { claimKey, lifeOf, short } from './keys'
import { LIVE_STAGES, RELEASE_OPS, releaseClaimOf, releaseEffects, releaseEventAction, releaseKey } from './release'
import type { ReleaseAgent } from './release'
import type { IssueRecord, Lease, V2Ctx } from './types'

const MIN = 60_000

// The agent kinds whose entries are steps an agent runs, for the tripwire's window: v2's, and v1's
// while its ledger is still read.
const AGENT_KINDS: readonly string[] = ['agent-step', 'spawn', 'delegate']

// What the tripwire names at most, so the notice stays short.
const LIST_MAX = 10

// A ghost (6.2, 2): a live claim of this device with no record and no claim in flight.
export type Ghost = {
  issue: number
  // the claim the release ends, as its keys carry it (claimOf); null when no time is known
  claim: string | null
  stage: Stage
  // when the factory shows it entered its stage
  since: Ms | null
  // still labelled ready; null when its labels have not been read
  ready: boolean | null
  pr: number | null
  // the loop's agents still at work on it
  agents: ReleaseAgent[]
  // the loop slots leased for it, which W2 frees (10.1)
  slots: Lease[]
}

// reconcile (R1): the tripwire, then each ghost's release.
export function reconcile(ctx: V2Ctx): void {
  tripwire(ctx)
  for (const ghost of ghostsOf(ctx)) release(ctx, ghost)
}

// --- ghosts (6.2) ---------------------------------------------------------------------------------

// ghostsOf: this device's live claims with no record, no claim in flight and no done release, by
// issue number. S1 leaves these to R1, whose release ends their claim before any new one. A claim
// whose release is done is not one: the factory may still show it live (a no-mistakes run's stage
// outlives the release until the factory tools end it, 6.4), and S1 may claim it again, whose
// claim starts the new life.
export function ghostsOf(ctx: V2Ctx): Ghost[] {
  const { state, config } = ctx
  const ready = config.readyLabel.toLowerCase()
  const out: Ghost[] = []
  for (const issue of [...state.issues].sort((a, b) => a.number - b.number)) {
    if (!liveClaim(issue, state.device)) continue
    if (heldByRecord(ctx.v2.records, issue)) continue
    if (claimInFlight(ctx, issue.number)) continue
    const claim = claimOf(state.ledger, issue)
    if (claim !== null && ctx.byKey.get(releaseKey(issue.number, claim, RELEASE_OPS.event))?.status === 'done') continue
    out.push({
      issue: issue.number,
      claim,
      stage: issue.stage as Stage,
      since: issue.stageSince,
      ready: issue.labels === null ? null : issue.labels.some(l => l.toLowerCase() === ready),
      pr: issue.pr,
      agents: agentsOn(ctx, issue.number),
      slots: ctx.v2.leases.filter(l => l.issue === issue.number),
    })
  }
  return out
}

// liveClaim: the factory shows the issue live with this device as the holder, and it is not
// known closed on GitHub (a closed issue's claim is ended by the sweep's `closed`, H2).
function liveClaim(issue: IssueView, device: string): boolean {
  return issue.holder === device && issue.stage !== null && LIVE_STAGES.includes(issue.stage) && issue.open !== false
}

// heldByRecord: a record holds the issue's claim: one that is not closed (rule 1), or a closed one
// at least as new as what the factory shows, whose closing events have not reached the factory yet
// (its own entry actions end its claim, 4.5). A factory view newer than every record's close is a
// claim no record holds.
function heldByRecord(records: readonly IssueRecord[], issue: IssueView): boolean {
  const mine = records.filter(r => r.issue === issue.number)
  if (mine.some(r => r.state !== 'closed')) return true
  if (mine.length === 0) return false
  return issue.stageSince === null || mine.some(r => r.since >= (issue.stageSince ?? 0))
}

// claimInFlight: a claim of the issue runs, or a v2 claim is done and its record is still to be
// made (row S0 makes one from every done claim, 3.3).
function claimInFlight(ctx: V2Ctx, n: number): boolean {
  const lives = ctx.v2.records.filter(r => r.issue === n).map(r => claimKey(n, r.life))
  return ctx.state.ledger.some(e => {
    if (e.kind !== 'claim' || e.issue !== n) return false
    if (e.status === 'running') return true
    if (e.status !== 'done' || !e.key.startsWith(claimKey(n, ''))) return false
    if (e.outcome?.kind === 'claim' && e.outcome.result === 'lost') return false
    return !lives.includes(e.key)
  })
}

// claimOf: the claim a ghost's release is dated by, as its keys carry it (keys.ts lifeOf), so a
// later claim never reuses an earlier release's keys and one claim's release never gets new ones:
// - the newest done claim entry of the issue (S1's, or one derived from its `claimed` event when
//   the ledger was rebuilt), a claim that was not lost;
// - else the claim the newest release begun for the issue is keyed by, so a release once begun
//   keeps its keys;
// - else, to begin one, when the factory shows it entered its stage. A run's stage moves that
//   time, which is why it never dates a release already begun.
// null when none is known.
export function claimOf(ledger: readonly LedgerEntry[], issue: IssueView): string | null {
  let at: Ms | null = null
  let begun: { claim: string; at: Ms } | null = null
  for (const e of ledger) {
    if (e.issue !== issue.number) continue
    if (e.kind === 'claim' && e.status === 'done' && !(e.outcome?.kind === 'claim' && e.outcome.result === 'lost')) {
      if (at === null || e.startedAt > at) at = e.startedAt
      continue
    }
    const claim = e.rule === 'R1' ? releaseClaimOf(issue.number, e.key) : null
    if (claim !== null && (begun === null || e.startedAt > begun.at)) begun = { claim, at: e.startedAt }
  }
  if (at !== null) return lifeOf(at)
  if (begun !== null) return begun.claim
  return issue.stageSince === null ? null : lifeOf(issue.stageSince)
}

// agentsOn: the loop's agents still at work on the issue: an entry of it that runs, or whose agent
// the session still lists at work, once per agent.
function agentsOn(ctx: V2Ctx, n: number): ReleaseAgent[] {
  const seen = new Map<string, string>()
  const entries = ctx.state.ledger.filter(e => e.issue === n && e.agentId !== undefined).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const e of entries) {
    const id = e.agentId as string
    if (!seen.has(id) && (e.status === 'running' || listedLive(ctx.state.agents, id))) seen.set(id, e.key)
  }
  return [...seen].map(([agentId, entry]) => ({ agentId, entry }))
}

// --- the release (6.4) ----------------------------------------------------------------------------

// release: a ghost's effects, then its event once they have ended. A done event plans nothing
// more, whatever the factory still shows (property 17): ghostsOf leaves its claim out.
function release(ctx: V2Ctx, g: Ghost): void {
  const age = g.since === null ? '' : ` for ${Math.max(0, Math.round((ctx.state.now - g.since) / MIN))} min`
  if (g.claim === null) {
    skip(ctx, 'R1', g.issue, `ghost #${g.issue} in ${g.stage}: no claim time is known, so it is not released`)
    return
  }
  const claim = g.claim
  const why = `ghost #${g.issue}: a live claim of this device in ${g.stage}${age} with no record`
  const waits: string[] = []
  for (const action of releaseEffects({ issue: g.issue, claim }, g.agents, why)) {
    const at = effect(ctx, action)
    if (action.kind === 'stop-agent') {
      // best effort, as an entry action's stop is (4.5): a stop that failed has ended too
      if (at !== 'done' && at !== 'exhausted') waits.push(`its agent ${action.agentId} stopped`)
    } else if (at === 'exhausted') {
      stalled(ctx, g.issue, action)
      return
    } else if (at !== 'done') {
      waits.push('its factory labels off')
    }
  }
  if (!ctx.v2.sources.leases.ok) waits.push('a read of the pool (its loop slots are not known)')
  for (const slot of g.slots) waits.push(`slot ${slot.path} freed (W2)`)
  if (g.ready === null) waits.push(`a read of #${g.issue}'s labels (ready or not)`)
  if (waits.length > 0) {
    skip(ctx, 'R1', g.issue, `the release of ghost #${g.issue} waits for ${waits.join(', ')}`)
    return
  }
  const checked = `this device's live claim has no record and no claim in flight${g.agents.length > 0 ? `; ${g.agents.length} agent(s) stopped` : ''}`
  const event = releaseEventAction({ issue: g.issue, claim, ready: g.ready === true, stage: g.stage, checked, branch: null, pr: g.pr }, why)
  if (effect(ctx, event) === 'exhausted') stalled(ctx, g.issue, event)
}

// effect: an action of the release, planned unless its key is blocked; an exhausted key is the
// caller's to report as stalled.
function effect(ctx: V2Ctx, action: Action): Gate {
  const g = gate(ctx, action.key, attemptsKindOf(action), action.maxAttempts)
  return g === 'exhausted' ? g : want(ctx, action)
}

// stalled: a release effect used up its attempts (4.5): the release holds there, its skip line
// says why, and the owner hears once; `/factory retry N` clears it.
function stalled(ctx: V2Ctx, issue: number, action: Action): void {
  const error = ctx.byKey.get(action.key)?.summary ?? 'used up its attempts'
  skip(ctx, 'R1', issue, `stalled: ${action.key}: ${error}`)
  want(ctx, wake('tell', 'stalled', `tell:stalled:${action.key}`, 'R1', issue, { issue, key: action.key, kind: action.kind }))
}

// --- the main-checkout tripwire (10.7) ------------------------------------------------------------

// A main-checkout read that did not fail.
export type CheckoutRead = Exclude<Checkout, { error: string }>

// The checkout the tripwire last settled on (V2State.checkoutBase): the newest read with no change
// pending against the one before, or whose change the owner has been told of; at: when it was read.
export type CheckoutBase = { checkout: CheckoutRead; at: Ms }

// A change to the main checkout between two reads: where HEAD is now, whether it moved (or changed
// branch), and the tracked paths changed now that were not before.
export type CheckoutChange = { head: string | null; branch: string | null; moved: { from: string | null; to: string | null } | null; paths: string[] }

// checkoutChange: the change from one read to another; null when there is none, or when either
// read is missing or failed.
export function checkoutChange(before: Checkout | null, now: Checkout | null): CheckoutChange | null {
  if (before === null || now === null || 'error' in before || 'error' in now) return null
  const moved = before.head !== now.head || before.branch !== now.branch
  const paths = now.dirty.filter(p => !before.dirty.includes(p)).sort()
  if (!moved && paths.length === 0) return null
  return { head: now.head, branch: now.branch, moved: moved ? { from: before.head, to: now.head } : null, paths }
}

// tripwireKey: the notice's key, by what the checkout now is (its HEAD, branch and changed paths),
// so one change is told once and a different one again.
export function tripwireKey(now: CheckoutRead): string {
  const text = [now.head ?? 'none', now.branch ?? '(detached)', ...[...now.dirty].sort()].join('\n')
  return `tell:checkout:${short(now.head ?? 'none')}:${fnv(text)}`
}

// checkoutBaseOf: the base the tripwire compares this pass's read with, from the last one, the
// read and the ledger (observe keeps it between passes, v2/observe.ts). Pure. It moves only when
// nothing is left untold:
// - a failed or missing read keeps it;
// - the first read after a load has none to compare with: a read whose notice is done becomes the
//   base, else a clean checkout at its HEAD, so changes left untold before a restart are told
//   after it (a HEAD that moved while the loop was down is not seen);
// - a read with no change against the base, or whose notice is done, becomes the base;
// - any other read leaves the change pending: the base stays, and R1 plans its notice again.
export function checkoutBaseOf(base: CheckoutBase | null, now: Checkout | null, ledger: readonly LedgerEntry[], at: Ms): CheckoutBase | null {
  if (now === null || 'error' in now) return base
  const told = ledger.some(e => e.key === tripwireKey(now) && e.status === 'done')
  if (told) return { checkout: now, at }
  if (base === null) return { checkout: { ...now, dirty: [] }, at }
  if (checkoutChange(base.checkout, now) === null) return { checkout: now, at }
  return base
}

// tripwire: tell(checkout) for a change against the base until it is told, with its paths and the
// agent steps that ran in that window: running now, or ended since the base was read (and at least
// within two pass intervals, the last pass with slack for a late one).
function tripwire(ctx: V2Ctx): void {
  const now = ctx.state.checkout
  const base = ctx.v2.checkoutBase
  if (base === null || now === null || 'error' in now) return
  const change = checkoutChange(base.checkout, now)
  const key = tripwireKey(now)
  if (change === null || ctx.byKey.get(key)?.status === 'done') return
  const since = Math.min(base.at, ctx.state.now - 2 * ctx.config.passEveryMs)
  const steps = ctx.state.ledger
    .filter(e => AGENT_KINDS.includes(e.kind) && (e.status === 'running' || (e.endedAt !== null && e.endedAt >= since)))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(e => `${e.key} (${e.status}${e.issue === null ? '' : `, #${e.issue}`})`)
  const context = [
    ...(change.moved === null ? [] : [`HEAD moved: ${short(change.moved.from ?? 'none')} -> ${short(change.moved.to ?? 'none')} on ${change.branch ?? 'a detached HEAD'}`]),
    ...listed('changed', change.paths),
    ...listed('steps in that window', steps),
  ]
  const fields = { branch: change.branch ?? 'detached', head: short(change.head ?? 'none'), moved: change.moved === null ? 'no' : 'yes', paths: change.paths.length, steps: steps.length }
  want(ctx, wake('tell', 'checkout', key, 'R1', null, fields, context))
}

// listed: a heading line and up to LIST_MAX items, then how many more.
function listed(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) return []
  const more = items.length > LIST_MAX ? [`and ${items.length - LIST_MAX} more`] : []
  return [`${heading}:`, ...items.slice(0, LIST_MAX).map(i => `- ${i}`), ...more]
}

// fnv: FNV-1a of a text, as 8 hex digits (state.ts digestOf's hash).
function fnv(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
