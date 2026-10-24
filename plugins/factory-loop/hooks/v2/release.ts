// The release of an issue that shows as active with no live step (docs/factory-loop/v2/SPEC.md
// 6.4), shared by R1 (reconcile.ts) and the one-shot migration (bin/factory-reconcile): stop any
// agent of the loop on it, take its factory labels off, free its slot, then log the closing event,
// last, with the release's fields. The event is last so it is never logged for a release that did
// not happen (the order D-48 set for `abandon`). A release ends one of three ways (its outcome):
//
// - requeue: back in the queue. The seven state labels go and `ready` comes back in one call, and
//   the event is `reclaimed`. R1's default (the owner, 2026-10-15): claiming removes `ready`, so a
//   rule that kept only issues still labelled ready never put one back.
// - leave: out of the factory, `abandoned`. R1's when the owner dropped the issue since its claim;
//   the migration's for every issue it releases, whatever its labels (the owner, 2026-10-15): the
//   owner re-adds `ready` for any issue still wanted.
// - reject: R1's at the issue's maxLives-th life (lives.ts): factory:rejected instead of `ready`,
//   one comment and one owner tell (reconcile.ts) listing why each life ended, and `abandoned`
//   with outcome reject. The owner removing factory:rejected and adding `ready` brings the issue
//   back.
//
// - R1's effects are actions keyed i<N>/reconcile/<claim time>/<op> (keys.ts reconcileKey), so a
//   done key never runs again; the label action's op is the outcome (requeue, leave or reject), so
//   a release once begun keeps its outcome, and lives.ts counts it as a life. Its slot is freed by
//   W2, whose rule frees every loop slot no record holds, so R1 plans no free of its own: its event
//   waits until the slot is gone (reconcile.ts).
// - The migration is not the loop: it runs its effects itself and writes its events through
//   events.ts, from what this module builds, so both releases read the same.
// - Each release is an intervention (7.2): by the loop for R1's, which rules-interventions.ts
//   derives from the done event entry (isReleaseEntry), cause `rejected` for a rejection and
//   `reconcile` for any other; by a person for the migration's, which acts on the owner's approval
//   and logs its own (releaseIntervention).
//
// Pure: the bin tool imports it as well as the planner.
import type { Action, LedgerEntry } from '../types'
import { RELEASE_OUTCOMES } from './events'
import type { InterventionEvent, ReleaseEvent } from './events'
import { reconcileKey } from './keys'
import { FACTORY_LABEL_PREFIX, REJECTED_LABEL } from './types'

// The text fields' bounds: an intervention's reason is one line of at most 200 characters (7.2).
const REASON_MAX = 200

// The live claim's states are LIVE_STATES (../factory-state-map.ts, 6.1): its holder works the issue.
// queued is a claim that ended (ready, reclaimed) or lapsed; closed is final.

// How a release ends (6.4): back in the queue, out of the factory, or rejected at the last life
// (the list lives in events.ts, the seam that writes and reads them).
export { RELEASE_OUTCOMES }
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number]

export type ReleaseInput = {
  issue: number
  // the claim's time, base-36 seconds (keys.ts lifeOf): what the release's keys are scoped to
  claim: string
  outcome: ReleaseOutcome
  // the released life's number since the issue's count last started (lives.ts); null for the
  // migration, which counts no v1 lives
  lives: number | null
  // the v2 state the factory shows it as active in (the event's `stage` field holds it)
  stage: string
  // what was checked, for the event's reason: `no live step in <state>: <checked>`
  checked: string
  branch: string | null
  pr: number | null
}

// An agent of the loop still at work on the issue, by its id and the ledger entry that started it.
export type ReleaseAgent = { agentId: string; entry: string }

// The ops a release keys its actions by (keys.ts reconcileKey): one stop per agent, the labels (the
// outcome is the op), a rejection's comment, the event.
export const RELEASE_OPS = { comment: 'comment', event: 'event', stop: (agentId: string) => `stop/${agentId}` } as const

// releaseKey: one op of the release of this issue's claim.
export function releaseKey(issue: number, claim: string, op: string): string {
  return reconcileKey(issue, claim, op)
}

// releaseClaimOf: the claim a key of one of this issue's releases is scoped to (releaseKey); null
// for any other key.
export function releaseClaimOf(issue: number, key: string): string | null {
  // the codec's own spelling around the claim: what comes before it, and between it and the op
  const marked = reconcileKey(issue, '\u0000', '\u0001')
  const before = marked.slice(0, marked.indexOf('\u0000'))
  const between = marked.slice(marked.indexOf('\u0000') + 1, marked.indexOf('\u0001'))
  if (!key.startsWith(before)) return null
  const end = key.indexOf(between, before.length)
  return end > before.length ? key.slice(before.length, end) : null
}

// releaseOutcomeOf: the outcome the release of this claim began with: the op of its label entry
// in the ledger; null when none began.
export function releaseOutcomeOf(has: (key: string) => boolean, issue: number, claim: string): ReleaseOutcome | null {
  return RELEASE_OUTCOMES.find(o => has(releaseKey(issue, claim, o))) ?? null
}

// isReleaseEntry: R1's release event as the ledger keeps it, keyed by its claim's event op; its done
// entry is the release, the fact of R1's intervention (7.2). The intervention's own entry
// (iv/<this key>) is R1's too, and is not one.
export function isReleaseEntry(e: Pick<LedgerEntry, 'kind' | 'rule' | 'key' | 'issue'>): boolean {
  const claim = e.issue === null ? null : releaseClaimOf(e.issue, e.key)
  return e.kind === 'event' && e.rule === 'R1' && e.issue !== null && claim !== null && e.key === releaseKey(e.issue, claim, RELEASE_OPS.event)
}

// releaseState: reclaimed for a release back to the queue, else abandoned (6.4).
export function releaseState(outcome: ReleaseOutcome): ReleaseEvent['state'] {
  return outcome === 'requeue' ? 'reclaimed' : 'abandoned'
}

// releaseReason: the release's free-text field (6.4).
export function releaseReason(state: string, checked: string): string {
  return `no live step in ${state}: ${oneLine(checked)}`
}

// releaseLabels: of an issue's labels, the ones the migration removes, as the issue spells them:
// every factory label, and for the migration `In development` too (3.6). Labels compare without
// regard to case, as GitHub's do.
export function releaseLabels(labels: readonly string[], migration: boolean, inDevLabel: string): string[] {
  const prefix = FACTORY_LABEL_PREFIX.toLowerCase()
  const inDev = inDevLabel.toLowerCase()
  return labels.filter(l => l.toLowerCase().startsWith(prefix) || (migration && l.toLowerCase() === inDev))
}

// releaseEvent: the closing event, with the release's fields (7.1).
export function releaseEvent(input: ReleaseInput): ReleaseEvent {
  return {
    state: releaseState(input.outcome),
    issue: input.issue,
    branch: input.branch,
    pr: input.pr,
    stage: input.stage,
    checked: oneLine(input.checked),
    reason: 'reconcile',
    outcome: input.outcome,
    lives: input.lives,
  }
}

// releaseIntervention: the intervention a release is (7.2), keyed by its event's key, so readers
// count it once: by the loop for R1's, by a person for the migration's; cause `rejected` for a
// rejection, else `reconcile`.
export function releaseIntervention(input: ReleaseInput, who: InterventionEvent['who']): InterventionEvent {
  const what = input.outcome === 'reject' ? `rejected at life ${input.lives ?? '?'}` : releaseState(input.outcome)
  const reason = `${what}: ${releaseReason(input.stage, input.checked)}`
  return {
    state: 'intervention',
    who,
    cause: input.outcome === 'reject' ? 'rejected' : 'reconcile',
    reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 3)}...` : reason,
    issue: input.issue,
    life: null,
    pr: input.pr,
    fact: releaseKey(input.issue, input.claim, RELEASE_OPS.event),
  }
}

// releaseEffects: R1's effects, in order: a stop for each agent of the loop still at work on the
// issue (best effort, as an entry action's stop is, 4.5), then the labels by the outcome in one
// call (requeue: the seven off and `ready` on; leave: the seven off; reject: the seven off and
// factory:rejected on), then a rejection's comment, which lists why each life ended. why: the
// reason each action carries into the decision log; ready: the repo's ready label; ended: the
// lines of lives.ts rejectLines.
export function releaseEffects(input: Pick<ReleaseInput, 'issue' | 'claim' | 'outcome' | 'lives'>, agents: readonly ReleaseAgent[], why: string, ready: string, ended: readonly string[], maxLives: number): Action[] {
  const base = { class: 'free' as const, rule: 'R1', issue: input.issue }
  const stops: Action[] = agents.map(a => ({
    ...base,
    kind: 'stop-agent',
    key: releaseKey(input.issue, input.claim, RELEASE_OPS.stop(a.agentId)),
    reason: `${why}: stop its agent`,
    agentId: a.agentId,
    entry: a.entry,
  }))
  const key = releaseKey(input.issue, input.claim, input.outcome)
  const label: Action =
    input.outcome === 'requeue'
      ? { ...base, kind: 'label', key, reason: `${why}: back in the queue (${ready} on, its factory labels off)`, op: 'requeue', label: null, ready }
      : input.outcome === 'reject'
        ? { ...base, kind: 'label', key, reason: `${why}: rejected at life ${input.lives ?? '?'} of ${maxLives} (${REJECTED_LABEL.name} on, its factory labels off)`, op: 'reject', label: null }
        : { ...base, kind: 'label', key, reason: `${why}: out of the factory (the owner dropped it): its factory labels off`, op: 'clear', label: null }
  if (input.outcome !== 'reject') return [...stops, label]
  const comment: Action = {
    ...base,
    kind: 'comment',
    key: releaseKey(input.issue, input.claim, RELEASE_OPS.comment),
    reason: `${why}: say why each life ended`,
    on: 'issue',
    number: input.issue,
    body: rejectText(input.issue, ended, maxLives),
  }
  return [...stops, label, comment]
}

// rejectText: the rejection's comment: what happened, why each life ended, and the way back.
export function rejectText(issue: number, ended: readonly string[], maxLives: number): string {
  return [
    `The factory loop stopped retrying this issue: ${maxLives === 1 ? 'its life' : `its ${ordinal(maxLives)} life`} ended without a merge, so it is labelled \`${REJECTED_LABEL.name}\` and was not put back in the queue.`,
    '',
    'Why each life ended:',
    ...ended.map(l => `- ${l}`),
    '',
    `To try again, remove \`${REJECTED_LABEL.name}\` and add \`ready\` to #${issue}: the loop claims it as a new first life.`,
  ].join('\n')
}

// releaseEventAction: R1's last action, once its effects have ended and its slot is free.
export function releaseEventAction(input: ReleaseInput, why: string): Action {
  const event = releaseEvent(input)
  return { kind: 'event', key: releaseKey(input.issue, input.claim, RELEASE_OPS.event), class: 'free', rule: 'R1', reason: `${why}: ${event.state}`, issue: input.issue, event }
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${tail}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
