// The v2 planner (docs/factory-loop/v2/SPEC.md 2.2, 2.5): planV2 is pure. It is a thin composer: it calls the rule modules in a fixed order, then the foundation's
// admission filters, one wake and the title, and holds no rule of its own. It imports types,
// hooks/v2/*.ts and hooks/foundation.ts only (tests/factory-loop-plan.test.js).
//
// The order is the order the act step runs the actions in: R1 first (6.2), then the record's
// rules (S0 to S6, H1), the slots (W2 before W1), the merge queue (Q1, Q2), the intake stamp's runs (I1: after every rule that claims, so S1's choice is made first), the interventions (the settings changes, then the flake rows), the gate runs, M1 (the default branch's state, whatever the store's state), and
// the fleet's (H2, O3); what used up its attempts is told, and a missing companion plugin (the
// workspace rail, 10.9: its hold is in the record's rules); G4 admits; R2's restart goes last of
// all, after the title, and only on a pass that admitted nothing else. When the records could not
// be read, the record's, slot and queue rules plan nothing (G2).
import { GITHUB_V2, admit, blindPass, newCtx, skip, tierOf, titleDue, titleOf } from '../foundation'
import type { Config, PlanResult, State } from '../types'
import { capOf, capacityTell } from './capacity'
import type { CapInfo } from './capacity'
import { finalise } from './queue-view'
import { reconcile } from './reconcile'
import { refusedRules } from './rules-refused'
import { releaseLogRules } from './rules-release-log'
import { fleetRules, fleetTells, restartOf, restartTells } from './rules-fleet'
import { flakeBugRules } from './rules-flake-bugs'
import { flakeRules } from './rules-flakes'
import { gateRunRules } from './rules-gates'
import { intakeRules } from './rules-intake'
import { interventionRules } from './rules-interventions'
import { mainRules } from './rules-main'
import { queueRules } from './rules-queue'
import { settingsRules } from './rules-settings'
import { slotRules } from './rules-slots'
import { starvedRules } from './rules-starved'
import { stateRules, stateTitle } from './rules-state'
import { V2_OWNER_TELLS } from './types'
import { windDownGuard, windDownOf, windDownTells, windDownTitle } from './wind-down'
import type { V2Ctx } from './types'
import type { QueueView } from './queue-view'
import { workspaceTell } from './workspace'

export function planV2(state: State, config: Config): PlanResult {
  const tier = tierOf(state.usage, config, state.control.usageOverride, state.now)
  const base = newCtx(state, config, tier, V2_OWNER_TELLS, GITHUB_V2)
  const blind = !state.sources.factory.ok
  const wd = windDownOf(state, config)
  let counts: { counts: string; after: string[] } | null = null
  let starved: boolean | null | undefined
  let cap: CapInfo | undefined
  let queue: QueueView | undefined
  if (blind) {
    blindPass(base)
  } else if (state.v2 === undefined) {
    skip(base, 'G2', null, 'v2 sources not read')
  } else {
    const ctx: V2Ctx = Object.assign(base, { v2: state.v2 })
    // records not read are blind for them: no rule that could release, claim or start runs, since
    // every live claim would look like a ghost and every slot like a free one (6.2)
    const store = state.v2.sources.store
    if (store.ok) {
      reconcile(ctx)
      stateRules(ctx)
      slotRules(ctx)
      queueRules(ctx)
      // I1 after S1 and the merge queue: their choice is made, and the intake stamp changes none of it
      intakeRules(ctx)
      starvedRules(ctx)
      starved = ctx.starved?.starved
      queue = ctx.queue
    } else {
      skip(ctx, 'G2', null, `v2 records not read: ${store.error ?? 'the store failed'}; nothing is released, claimed or started`)
    }
    interventionRules(ctx)
    settingsRules(ctx)
    flakeRules(ctx)
    refusedRules(ctx)
    flakeBugRules(ctx)
    gateRunRules(ctx)
    mainRules(ctx)
    fleetRules(ctx)
    releaseLogRules(ctx)
    restartTells(ctx)
    fleetTells(ctx)
    workspaceTell(ctx)
    capacityTell(ctx)
    cap = capOf(ctx)
    windDownTells(ctx, wd)
    counts = stateTitle(ctx)
  }
  // wind-down (10.11): after every rule ran, one guard drops every start before admission
  windDownGuard(base, wd)
  const actions = admit(base)
  const queued = queue === undefined ? undefined : finalise(queue, actions)
  const restart = blind ? null : restartOf(base, actions)
  const title = titleOf({
    repo: state.repo,
    counts: counts?.counts ?? null,
    observe: config.mode !== 'act',
    blind,
    before: windDownTitle(state, wd),
    tier: base.tier,
    after: counts?.after ?? [],
    atCap: base.atCap,
    capped: base.capped,
    backoff: state.githubBackoffUntil !== null && state.now < state.githubBackoffUntil,
    owner: base.owner.size,
  })
  if (titleDue(state, config, title)) actions.push({ kind: 'title', key: 'title', class: 'free', rule: 'O1', reason: 'status changed', issue: null, text: title })
  // the restart ends the session, so it goes after everything else, the title included
  if (restart !== null) actions.push(restart)
  return { tier: base.tier, overridden: base.overridden, actions, skipped: base.skipped, title, owner: base.owner.size, capped: base.capped, atCap: base.atCap, ...(cap === undefined ? {} : { cap }), ...(starved === undefined ? {} : { starved }), ...(queued === undefined ? {} : { queue: queued }) }
}

// What the decision log says of a plan's transitions: the issue, the row, its event, and the
// state and seq the record moves to.
export function transitionsOf(result: PlanResult): { issue: number | null; row: string; event: string; to: string; seq: number }[] {
  return result.actions.flatMap(a => (a.kind === 'transition' ? [{ issue: a.issue, row: a.row, event: a.event, to: a.next.state, seq: a.next.seq }] : []))
}
