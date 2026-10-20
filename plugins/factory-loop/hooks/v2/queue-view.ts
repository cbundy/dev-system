// The queue view (docs/factory-loop/v2/SPEC.md S1): what the claim rule saw of the ready queue in
// one pass, in order: each candidate's rank, score and factors, whether the pass would claim it
// and, if not, why as a code. S1 (rules-claim.ts) builds it as it filters; planV2 finalises it
// after admission, since a claim S1 wants can still be dropped (admit, wind-down). The loop's
// snapshot writer (hooks/queue-snapshot.ts) sends it as a `queue_snapshot` event.
//
// Pure: no clock, no engine.
import type { Action } from '../types'
import type { ScoredFactor, ScoreResult } from './score'

export type Why = 'blocked' | 'skipped' | 'paused' | 'outside_only' | 'no_slot' | 'new_off' | 'usage_tier' | 'rejected' | 'tracker' | 'held' | 'exhausted' | 'untrusted' | 'unknown'

export type QueueRow = { issue: number; rank: number; score: number | null; factors: ScoredFactor[] | null; claimable: boolean; why: Why | null }

export type QueueView = {
  rows: QueueRow[]
  considered: number
  // claims left under the in-flight cap after S1's loop; null when the cap is unset
  free_slots: number | null
  priority: number[]
  only: number[]
  serial: boolean
  noNewWork: boolean
}

// The reasons S1 skips or limits an issue with, by pattern, first match wins.
const REASONS: ReadonlyArray<[RegExp, Why]> = [
  [/^blocked by \d+ open issues?$/, 'blocked'],
  [/^label factory:rejected\b/, 'rejected'],
  [/^label /, 'skipped'],
  [/^owner: skip$/, 'skipped'],
  [/^owner: paused$/, 'paused'],
  [/^owner: only /, 'outside_only'],
  [/^capacity: /, 'no_slot'],
  [/^owner: one at a time$/, 'no_slot'],
  [/^claims per pass$/, 'no_slot'],
  [/^owner: no new work$/, 'new_off'],
  [/^tier (stop-new|stop-all)$/, 'usage_tier'],
  [/^slow: /, 'usage_tier'],
  [/^tracker \(/, 'tracker'],
  [/^in the factory as /, 'held'],
  [/^another device holds it/, 'held'],
  [/^exhausted: /, 'exhausted'],
  [/^untrusted author$/, 'untrusted'],
  [/^(not observed|closed|GitHub state unknown|author unknown|labels unknown|blockers unknown|sub-issues unknown)$/, 'unknown'],
  [/^no .+ label$/, 'unknown'],
]

// whyOf: the code of a skip or limit reason; null when the reason maps to nothing (the tests fail on it).
export function whyOf(reason: string): Why | null {
  return REASONS.find(([re]) => re.test(reason))?.[1] ?? null
}

export function newView(considered: number, priority: readonly number[], only: readonly number[], serial: boolean, noNewWork: boolean): QueueView {
  return { rows: [], considered, free_slots: null, priority: [...priority], only: [...only], serial, noNewWork }
}

// noteRow: the next candidate's row, in order. A reason text maps through whyOf; a row with a code
// of its own passes it. null why: S1 wants the claim (finalised by finalise).
export function noteRow(view: QueueView, issue: number, scored: ScoreResult | null, why: string | null, code?: Why): void {
  const w = why === null ? null : (code ?? whyOf(why) ?? 'unknown')
  view.rows.push({ issue, rank: view.rows.length + 1, score: scored?.score ?? null, factors: scored?.factors ?? null, claimable: w === null, why: w })
}

// finalise: after admission, a row is claimable exactly when the plan holds an S1 claim for it;
// a wanted claim that admission or wind-down dropped is `no_slot`. Returns the view as planned.
export function finalise(view: QueueView, actions: readonly Action[]): QueueView {
  const claimed = new Set(actions.flatMap(a => (a.kind === 'claim' && a.rule === 'S1' && a.issue !== null ? [a.issue] : [])))
  return { ...view, rows: view.rows.map(r => (r.claimable && !claimed.has(r.issue) ? { ...r, claimable: false, why: 'no_slot' as const } : r)) }
}
