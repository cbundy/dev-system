// The fleet's rules (docs/factory-loop/v2/SPEC.md 14.1) that name no record: H2 sweeps, O3 wakes
// the judge for the release task, R2 restarts for an update, and what used up its attempts with no
// issue to hold is told to the owner. They keep v1's meaning and keys (v1 SPEC 5: H2, O3, H4), with
// v1's drain gone: R2 waits only for a queue action or the release task to finish (section 15,
// "Restart without a drain"); a step it cuts re-runs free (row U1). Pure.
import { gate, skip, wake, want } from '../foundation'
import type { PlanCtx } from '../foundation'
import type { Action, ActionKind, LedgerEntry } from '../types'
import type { V2Ctx } from './types'

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
  // H2: the sweep, every sweepEveryMs
  const sweep = lastDone(ctx, 'sweep')
  if (sweep === undefined || state.now - (sweep.endedAt ?? 0) >= config.sweepEveryMs) {
    want(ctx, { kind: 'sweep', key: `sweep:${sweep?.endedAt ?? 0}`, class: 'free', rule: 'H2', reason: 'sweep due', issue: null })
  }
  // O3: the Next milestone has no open item and at least one closed: the judge cuts the release
  const m = state.milestone
  if (state.sources.milestone.ok && m !== null && m.open === 0 && m.closed > 0) {
    want(ctx, wake('task', 'release', `task:release:${m.closed}:${m.expected ?? 'none'}`, 'O3', null, { closed: m.closed, expected: m.expected }))
  }
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
// release task runs. A restart that failed is used up (it runs once): the owner hears once
// (fleetTells), and it waits until the update is asked for again.
export function restartOf(ctx: PlanCtx): Action | null {
  const due = ctx.state.control.updateDue
  if (due === null) return null
  const holding = ctx.state.ledger.filter(HOLDS_RESTART).map(e => e.key)
  if (holding.length > 0) {
    skip(ctx, 'R2', null, `update due: waiting on ${holding.join(', ')}`)
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
