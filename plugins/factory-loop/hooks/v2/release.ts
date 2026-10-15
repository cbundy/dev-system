// The release of an issue that shows as active with no live step (docs/factory-loop/v2/SPEC.md
// 6.4), shared by R1 (reconcile.ts) and the one-shot migration (bin/factory-reconcile): stop any
// agent of the loop on it, remove its factory labels (the migration also `In development`), free
// its slot, then log `reclaimed` (still labelled ready: back to the queue) or `abandoned` (it
// leaves the factory), last, with the release's fields. The event is last so it is never logged
// for a release that did not happen (the order D-48 set for `abandon`).
//
// - R1's effects are actions keyed i<N>/reconcile/<claim time>/<op> (keys.ts reconcileKey), so a
//   done key never runs again. Its slot is freed by W2, whose rule frees every loop slot no record
//   holds, so R1 plans no free of its own: its event waits until the slot is gone (reconcile.ts).
// - The migration is not the loop: it runs its effects itself and writes its events through
//   events.ts, from what this module builds, so both releases read the same.
// - Each release is an intervention (cause `reconcile`, 7.2): by the loop for R1's, which
//   rules-interventions.ts derives from the done event entry (isReleaseEntry), by a person for
//   the migration's, which acts on the owner's approval and logs its own (releaseIntervention).
//
// Pure: the bin tool imports it as well as the planner.
import type { Action, LedgerEntry, Stage } from '../types'
import type { InterventionEvent, ReleaseEvent } from './events'
import { reconcileKey } from './keys'
import { FACTORY_LABEL_PREFIX } from './types'

// The text fields' bounds: an intervention's reason is one line of at most 200 characters (7.2).
const REASON_MAX = 200

// The factory-state stages of a live claim, what shows as active (6.1): its holder works the
// issue. queued is a claim that ended (ready, reclaimed) or lapsed; merged and closed without merge
// are final.
export const LIVE_STAGES: readonly Stage[] = ['designing', 'implementing', 'in pipeline', 'parked', 'ready to merge']

export type ReleaseInput = {
  issue: number
  // the claim's time, base-36 seconds (keys.ts lifeOf): what the release's keys are scoped to
  claim: string
  // still labelled ready: back to the queue (reclaimed); else it leaves the factory (abandoned)
  ready: boolean
  // the factory-state stage it shows as active in
  stage: string
  // what was checked, for the event's reason: `no live step in <stage>: <checked>`
  checked: string
  branch: string | null
  pr: number | null
}

// An agent of the loop still at work on the issue, by its id and the ledger entry that started it.
export type ReleaseAgent = { agentId: string; entry: string }

// The ops a release keys its actions by (keys.ts reconcileKey): one stop per agent, the labels,
// the event.
export const RELEASE_OPS = { label: 'label', event: 'event', stop: (agentId: string) => `stop/${agentId}` } as const

// releaseKey: one op of the release of this issue's claim.
export function releaseKey(issue: number, claim: string, op: string): string {
  return reconcileKey(issue, claim, op)
}

// isReleaseEntry: R1's release event as the ledger keeps it; its done entry is the release, the
// fact of R1's intervention (7.2).
export function isReleaseEntry(e: Pick<LedgerEntry, 'kind' | 'rule'>): boolean {
  return e.kind === 'event' && e.rule === 'R1'
}

// releaseState: reclaimed for an issue still labelled ready, else abandoned (6.4).
export function releaseState(ready: boolean): ReleaseEvent['state'] {
  return ready ? 'reclaimed' : 'abandoned'
}

// releaseReason: the release's free-text field (6.4).
export function releaseReason(stage: string, checked: string): string {
  return `no live step in ${stage}: ${oneLine(checked)}`
}

// releaseLabels: of an issue's labels, the ones a release removes, as the issue spells them: every
// factory label, and for the migration `In development` too (3.6). Labels compare without regard
// to case, as GitHub's do.
export function releaseLabels(labels: readonly string[], migration: boolean, inDevLabel: string): string[] {
  const prefix = FACTORY_LABEL_PREFIX.toLowerCase()
  const inDev = inDevLabel.toLowerCase()
  return labels.filter(l => l.toLowerCase().startsWith(prefix) || (migration && l.toLowerCase() === inDev))
}

// releaseEvent: the closing event, with the release's fields (7.1).
export function releaseEvent(input: ReleaseInput): ReleaseEvent {
  return {
    state: releaseState(input.ready),
    issue: input.issue,
    branch: input.branch,
    pr: input.pr,
    stage: input.stage,
    checked: oneLine(input.checked),
    reason: 'reconcile',
  }
}

// releaseIntervention: the intervention a release is (7.2), keyed by its event's key, so readers
// count it once: by the loop for R1's, by a person for the migration's.
export function releaseIntervention(input: ReleaseInput, who: InterventionEvent['who']): InterventionEvent {
  const reason = `${releaseState(input.ready)}: ${releaseReason(input.stage, input.checked)}`
  return {
    state: 'intervention',
    who,
    cause: 'reconcile',
    reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 3)}...` : reason,
    issue: input.issue,
    life: null,
    pr: input.pr,
    fact: releaseKey(input.issue, input.claim, RELEASE_OPS.event),
  }
}

// releaseEffects: R1's effects, in order: a stop for each agent of the loop still at work on the
// issue (best effort, as an entry action's stop is, 4.5), then every factory label off (op clear,
// which removes none while another device holds a live claim, 3.4). why: the reason each action
// carries into the decision log.
export function releaseEffects(input: Pick<ReleaseInput, 'issue' | 'claim'>, agents: readonly ReleaseAgent[], why: string): Action[] {
  const base = { class: 'free' as const, rule: 'R1', issue: input.issue }
  const stops: Action[] = agents.map(a => ({
    ...base,
    kind: 'stop-agent',
    key: releaseKey(input.issue, input.claim, RELEASE_OPS.stop(a.agentId)),
    reason: `${why}: stop its agent`,
    agentId: a.agentId,
    entry: a.entry,
  }))
  const label: Action = { ...base, kind: 'label', key: releaseKey(input.issue, input.claim, RELEASE_OPS.label), reason: `${why}: its factory labels off`, op: 'clear', label: null }
  return [...stops, label]
}

// releaseEventAction: R1's last action, once its effects have ended and its slot is free.
export function releaseEventAction(input: ReleaseInput, why: string): Action {
  const event = releaseEvent(input)
  return { kind: 'event', key: releaseKey(input.issue, input.claim, RELEASE_OPS.event), class: 'free', rule: 'R1', reason: `${why}: ${event.state}`, issue: input.issue, event }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
