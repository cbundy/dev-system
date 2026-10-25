// A stopped main session holds the loop's work. When the owner stops the session, the engine refuses
// every agent start and every prompt with the text below until a person sends input. That is not a
// failure of any issue's step, so it uses up no attempt, no unknown, no triage and no breaker count
// (v2 SPEC 5.1, 5.3, 13.6.1): the step or wake is skipped, planned again next pass, and the hold is
// shown in the title and `/factory status` until a spawn or submit works again.
import { S } from './driver-state'

// The engine's refusal text for a stopped session. Pinned to that text, so no other deny is held.
export const SESSION_STOPPED = /the session was stopped and nobody has sent input since/

// The summary a held spawn gets.
export const HELD_SUMMARY = 'held: session stopped'

export type Hold = { since: number; spawns: number; wakes: number; what: string }
export type Resumed = { since: number; until: number; spawns: number; wakes: number }
// What the planner reads (State.hold): the hold in force, and one that ended since the last pass.
export type HoldView = { held: Hold | null; resumed: Resumed | null }

// markHeld: a refusal with the stopped-session text. The first one sets the hold's start; each one
// is counted (a wake by default).
export function markHeld(now: number, what: string, kind: 'spawn' | 'wake' = 'wake'): void {
  const h = S.held ?? { since: now, spawns: 0, wakes: 0, what }
  S.held = kind === 'spawn' ? { ...h, spawns: h.spawns + 1 } : { ...h, wakes: h.wakes + 1 }
}

// clearHeld: a spawn or submit that worked. The ended hold waits for the next pass to log it.
export function clearHeld(now: number): void {
  const h = S.held
  if (h === null) return
  S.held = null
  S.resumed = { since: h.since, until: now, spawns: h.spawns, wakes: h.wakes }
}

export function heldSince(): number | null {
  return S.held === null ? null : S.held.since
}

export function holdView(): HoldView {
  return { held: S.held, resumed: S.resumed }
}

// settleResumed: the pass logged the ended hold (or planned to), so it is not offered again.
export function settleResumed(): void {
  S.resumed = null
}
