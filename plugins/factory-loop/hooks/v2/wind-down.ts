// Wind-down (docs/factory-loop/v2/SPEC.md 10.11), pure: the owner (or the stop script of #842) asks
// the loop to finish what runs and start nothing, by writing `<loop dir>/wind-down.request`. While a
// request stands (and config windDownMinutes is above 0), one guard in the planner drops every
// action that starts work, before admission, and the loop writes `wind-down.status.json` each pass
// so the stopper can see when nothing runs. A request the stop never followed is removed after the
// cap plus a margin, and the loop plans normally again. This module decides and reads no clock;
// wind-down-files.ts reads and writes the files (observe.ts and register.ts call it).
import { skip, wake, want } from '../foundation'
import type { PlanCtx } from '../foundation'
import type { Action, LedgerEntry, Ms, State } from '../types'
import type { V2Ctx } from './types'

export const WIND_DOWN_REQUEST = 'wind-down.request'
export const WIND_DOWN_STATUS = 'wind-down.status.json'
export const WIND_DOWN_STOP_NOW = 'wind-down.stop-now'

export const windDownPaths = (loopDir: string) => ({
  request: `${loopDir}/${WIND_DOWN_REQUEST}`,
  status: `${loopDir}/${WIND_DOWN_STATUS}`,
  stopNow: `${loopDir}/${WIND_DOWN_STOP_NOW}`,
})

// A request older than the cap plus this, with the loop still running, is one the stop never followed.
export const WIND_DOWN_MARGIN_MS = 5 * 60_000

// What observe read: the request (null: none), whether the stop-now file exists, and the status
// file the loop wrote last pass (for started_at).
export type WindDownRead = {
  // iso: requestedAt as the writer's text, for the owner's tell (the planner reads no clock)
  // remembered: the session's own memory of the request it wrote (withRemembered), the file being gone
  request: { requestedAt: Ms; iso: string; trigger: string | null; problem: string | null; remembered?: true } | null
  stopNow: boolean
  previous: { requestedAt: Ms; startedAt: Ms } | null
}

export type WindDown =
  | { mode: 'off' }
  | { mode: 'active'; requestedAt: Ms; startedAt: Ms; capMs: Ms }
  | { mode: 'stale'; requestedAt: Ms; capMs: Ms }

// windDownOf: the mode this pass plans in.
export function windDownOf(state: State, config: { windDownMinutes: number }): WindDown {
  const read = state.v2?.windDown
  if (read === undefined || read.request === null || config.windDownMinutes <= 0) return { mode: 'off' }
  const { requestedAt } = read.request
  const capMs = config.windDownMinutes * 60_000
  if (state.now - requestedAt > capMs + WIND_DOWN_MARGIN_MS) return { mode: 'stale', requestedAt, capMs }
  const startedAt = read.previous !== null && read.previous.requestedAt === requestedAt ? read.previous.startedAt : state.now
  return { mode: 'active', requestedAt, startedAt, capMs }
}

// The closed drop list: every kind that starts work.
function starts(a: Action): boolean {
  switch (a.kind) {
    case 'claim':
    case 'agent-step':
    case 'queue-update':
    case 'queue-merge':
    case 'ci-rerun':
    case 'judge':
    case 'task':
      return true
    case 'slot':
      return a.op === 'lease'
    default:
      return false
  }
}

// windDownGuard: in wind-down, drops every start from the plan, each with a skip line. What finishes
// work (transition, pr, label, comment, event, split, slot frees and kills, stop-agent, tell,
// heartbeat, sweep) stays.
export function windDownGuard(ctx: PlanCtx, wd: WindDown): void {
  if (wd.mode !== 'active') return
  const kept: Action[] = []
  for (const a of ctx.out) {
    if (starts(a)) skip(ctx, a.rule, a.issue, `wind-down: no new start (${a.kind})`)
    else kept.push(a)
  }
  ctx.out.length = 0
  ctx.out.push(...kept)
}

// windDownTells: a stale request is told once, by its requested_at.
export function windDownTells(ctx: V2Ctx, wd: WindDown): void {
  if (wd.mode !== 'stale') return
  const at = ctx.v2.windDown?.request?.iso ?? String(wd.requestedAt)
  const minutes = wd.capMs / 60_000
  want(
    ctx,
    wake('tell', 'wind-down-stale', `tell:wind-down-stale:${wd.requestedAt}`, 'O2', null, { requested_at: at, cap_minutes: minutes }, [
      `A wind-down was requested at ${at} and the stop did not follow within ${minutes} minutes plus ${WIND_DOWN_MARGIN_MS / 60_000}. The loop removed the request and plans normally again.`,
    ]),
  )
}

// windDownTitle: the title's words: `winding down <m>m`, `<n> running`.
export function windDownTitle(state: State, wd: WindDown): string[] {
  if (wd.mode !== 'active') return []
  const n = state.ledger.filter(e => e.status === 'running' && e.kind === 'agent-step').length
  return [`winding down ${Math.floor((state.now - wd.startedAt) / 60_000)}m`, `${n} running`]
}

