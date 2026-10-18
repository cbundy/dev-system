// The fleet's rules (docs/factory-loop/v2/SPEC.md 14.1) that name no record: H2 sweeps (on its
// period, and once a record closed, so the claim of a merged or closed issue ends at once), O3 wakes
// the judge for the release task, R2 restarts for an update, and what used up its attempts with no
// issue to hold is told to the owner. They keep v1's meaning and keys (v2 SPEC 13.5.3 and 14.1: H2, O3, R2), with
// v1's drain gone: R2 waits only for a queue action or the release task to finish, and for a pass
// with nothing else to start (section 15, "Restart without a drain"); a running step it cuts
// re-runs free (row U1). Pure.
import { gate, releaseDue, skip, wake, want } from '../foundation'
import type { PlanCtx } from '../foundation'
import type { Action, ActionKind, LedgerEntry } from '../types'
import { entryDone, entryItems, reopenedOffNext } from './rules-entry'
import type { EntryItem } from './rules-entry'
import type { V2Ctx } from './types'
import { windDownOf } from './wind-down'

// lastDone: the newest done entry of a kind.
function lastDone(ctx: PlanCtx, kind: ActionKind): LedgerEntry | undefined {
  let last: LedgerEntry | undefined
  for (const e of ctx.state.ledger) {
    if (e.kind !== kind || e.status !== 'done' || e.endedAt === null) continue
    if (last === undefined || e.endedAt > (last.endedAt ?? 0)) last = e
  }
  return last
}

// fleetRules: H2 and O3.
export function fleetRules(ctx: V2Ctx): void {
  const { state, config } = ctx
  // H2: the sweep, every sweepEveryMs, and once a close's entry actions (the merged fact first,
  // R3-F1) all ended after the last sweep began: the sweep ends the claim with the event it logs on
  // its period (3.6)
  const sweep = lastDone(ctx, 'sweep')
  const settledAt = (items: EntryItem[]) => (entryDone(ctx, items) ? Math.max(0, ...items.map(i => ctx.byKey.get(i.action.key)?.endedAt ?? 0)) : 0)
  const closed = ctx.v2.records.find(r => r.state === 'closed' && settledAt(entryItems(ctx, r, null)) > (sweep?.startedAt ?? 0))
  if (sweep === undefined || state.now - (sweep.endedAt ?? 0) >= config.sweepEveryMs || closed !== undefined) {
    want(ctx, { kind: 'sweep', key: `sweep:${sweep?.endedAt ?? 0}`, class: 'free', rule: 'H2', reason: closed === undefined ? 'sweep due' : `#${closed.issue} closed`, issue: null })
  }
  // O3: the Next milestone has no open item and at least one closed: the judge cuts the release
  // an issue that waits on a release tag of this repo makes the review due too: the judge answers that wait
  const waiting = ctx.v2.records.filter(r => r.state === 'waiting' && (r.wait ?? []).some(c => c.kind === 'tag-contains' && c.repo === undefined)).map(r => r.issue).sort((a, b) => a - b)
  for (const a of reopenedOffNext(ctx)) want(ctx, a)
  const due = releaseDue(state, config, waiting)
  if (due !== null) want(ctx, wake('task', 'release', due.key, 'O3', null, due.fields))
}

// fleetTells: what used up its attempts with no record to hold (a record's own exhausted effects
// hold it as stalled, 4.5): a task timed out, anything else is stalled. Each tells the owner once.
// Run after every other rule, so each rule's exhausted keys are in.
export function fleetTells(ctx: PlanCtx): void {
  for (const key of new Set(ctx.exhausted)) {
    const entry = ctx.byKey.get(key)
    if (entry === undefined || entry.issue !== null) continue
    const name = entry.kind === 'task' ? 'task-timeout' : 'stalled'
    want(ctx, wake('tell', name, `tell:${name}:${key}`, 'O2', null, { key, kind: entry.kind }))
  }
}

// The work R2 waits for: a merge-queue action or the release task, running.
const HOLDS_RESTART = (e: LedgerEntry) => e.status === 'running' && (e.kind === 'queue-update' || e.kind === 'queue-merge' || (e.kind === 'task' && e.wake === 'release'))

// restartOf (R2): the restart for an update that is due, last in the pass, once no queue action or
// release task runs, and only on a pass that admitted nothing else (kept), as v1's H4 did: what
// starts in the pass the restart ends would only be cut, a release task or a queue action among
// them, and every agent step would spend its attempt's free re-run for nothing. A restart that
// failed is used up (it runs once): the owner hears once (fleetTells), and it waits until the
// update is asked for again.
export function restartOf(ctx: PlanCtx, kept: readonly Action[]): Action | null {
  const due = ctx.state.control.updateDue
  if (due === null) return null
  if (windDownOf(ctx.state, ctx.config).mode === 'active') {
    skip(ctx, 'R2', null, 'wind-down')
    return null
  }
  const holding = ctx.state.ledger.filter(HOLDS_RESTART).map(e => e.key)
  if (holding.length > 0) {
    skip(ctx, 'R2', null, `update due: waiting on ${holding.join(', ')}`)
    return null
  }
  // an intervention's event is no work a restart would cut: it is written before the restart, in
  // the same pass (rules-interventions.ts)
  const starting = kept.filter(a => a.kind !== 'title' && !(a.kind === 'event' && a.key.startsWith('iv/'))).map(a => a.key)
  if (starting.length > 0) {
    skip(ctx, 'R2', null, `update due: this pass starts ${starting.slice(0, 5).join(', ')}${starting.length > 5 ? ` and ${starting.length - 5} more` : ''} first`)
    return null
  }
  const key = `restart:${due.at}`
  const g = gate(ctx, key, 'restart-self')
  if (g === 'exhausted') {
    skip(ctx, 'R2', null, `exhausted: ${key}`)
    return null
  }
  if (g !== 'go') return null
  return { kind: 'restart-self', key, class: 'free', rule: 'R2', reason: 'update due', issue: null, why: due.reason, at: due.at }
}

// restartTells: an exhausted restart, told once (rule R2), before the plan's admission.
export function restartTells(ctx: PlanCtx): void {
  const due = ctx.state.control.updateDue
  if (due !== null && gate(ctx, `restart:${due.at}`, 'restart-self') === 'exhausted') ctx.exhausted.push(`restart:${due.at}`)
}
