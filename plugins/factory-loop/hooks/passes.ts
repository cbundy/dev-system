// The loop's pass summary (#680): once a minute, one native `loop_passes` event sums up the
// passes that ended in the minute before. Pure: no engine calls. register.ts feeds it every pass
// as it ends (notePass), closes a minute on its own timer (closeMinute) and sends what
// passesEventArgv builds. The event is bookkeeping, never a stage or progress; entryFromLoop
// returns null for it, so it never rebuilds a ledger entry. The reader does any weighting.

import type { ObserveSplit } from './observe-clock'

export const MINUTE_MS = 60_000

// One finished pass: how long it took, whether it acted (a non-title outcome) and whether it threw.
export type PassRecord = {
  ms: number
  acted: boolean
  error: boolean
  // the observe split, rounded; null when the pass has no measure
  observeMs: number | null
  commandsMs: number | null
  inProcessMs: number | null
}

// The passes recorded, by the start (epoch ms) of the UTC minute in which each ended.
export type PassBook = Map<number, PassRecord[]>

// What the note carries besides the numbers: the last runtime the loop resolved.
export type PassSettings = { mode: string; passEveryMs: number }

export type PassSummary = {
  from: number
  to: number
  passes: number
  mean: number | null
  p50: number | null
  p90: number | null
  max: number | null
  acting: number
  actingMean: number | null
  idleMean: number | null
  errors: number
  observeMean: number | null
  observeCommandsMean: number | null
  observeInProcessMean: number | null
  observeInProcessMax: number | null
  settings: PassSettings
}

export const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS

// notePass: a pass ended at endedAtMs and took ms.
export function notePass(book: PassBook, endedAtMs: number, ms: number, acted: boolean, error: boolean, split: ObserveSplit | null = null): void {
  const minute = minuteOf(endedAtMs)
  const list = book.get(minute)
  const rec: PassRecord = {
    ms: Math.round(ms),
    acted,
    error,
    observeMs: split === null ? null : Math.round(split.ms),
    commandsMs: split === null ? null : Math.round(split.commandsMs),
    inProcessMs: split === null ? null : Math.round(split.inProcessMs),
  }
  if (list === undefined) book.set(minute, [rec])
  else list.push(rec)
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length))

// nearest rank: the value at ceil(p * n) of the sorted values
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1] ?? null
}

// closeMinute: the summary of the minute starting at minuteStartMs (passes=0 when none ended in
// it), and the book let go of that minute and every older one, so memory stays bounded.
export function closeMinute(book: PassBook, minuteStartMs: number, settings: PassSettings): PassSummary {
  const recs = book.get(minuteStartMs) ?? []
  for (const k of [...book.keys()]) if (k <= minuteStartMs) book.delete(k)
  const all = recs.map(r => r.ms)
  const sorted = [...all].sort((a, b) => a - b)
  const acting = recs.filter(r => r.acted)
  const idle = recs.filter(r => !(r.acted))
  const nums = (xs: readonly (number | null)[]) => xs.filter((x): x is number => x !== null)
  const inProc = nums(recs.map(r => r.inProcessMs))
  return {
    from: minuteStartMs,
    to: minuteStartMs + MINUTE_MS,
    passes: recs.length,
    mean: mean(all),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
    acting: acting.length,
    actingMean: mean(acting.map(r => r.ms)),
    idleMean: mean(idle.map(r => r.ms)),
    errors: recs.filter(r => r.error).length,
    observeMean: mean(nums(recs.map(r => r.observeMs))),
    observeCommandsMean: mean(nums(recs.map(r => r.commandsMs))),
    observeInProcessMean: mean(inProc),
    observeInProcessMax: inProc.length === 0 ? null : Math.max(...inProc),
    settings,
  }
}

const opt = (v: number | null) => (v === null ? 'none' : String(v))

// passesNote: `kind=passes key=passes:<from> status=done ...` (key= and status= are what
// callum-flow-event requires of every loop note). No value holds a space.
export function passesNote(s: PassSummary): string {
  return [
    'kind=passes',
    `key=passes:${s.from}`,
    'status=done',
    `from=${new Date(s.from).toISOString()}`,
    `to=${new Date(s.to).toISOString()}`,
    `passes=${s.passes}`,
    `mean_ms=${opt(s.mean)}`,
    `p50_ms=${opt(s.p50)}`,
    `p90_ms=${opt(s.p90)}`,
    `max_ms=${opt(s.max)}`,
    `acting=${s.acting}`,
    `acting_mean_ms=${opt(s.actingMean)}`,
    `idle_mean_ms=${opt(s.idleMean)}`,
    `errors=${s.errors}`,
    `observe_mean_ms=${opt(s.observeMean)}`,
    `observe_commands_mean_ms=${opt(s.observeCommandsMean)}`,
    `observe_in_process_mean_ms=${opt(s.observeInProcessMean)}`,
    `observe_in_process_max_ms=${opt(s.observeInProcessMax)}`,
    `mode=${s.settings.mode}`,
    // the event's schema still requires the field: the loop always plans with v2
    'planner=v2',
    `pass_every_ms=${s.settings.passEveryMs}`,
  ].join(' ')
}

// passesEventArgv: the native call that logs a summary as a `loop_passes` event: the data the
// translator makes of passesNote(s).
export function passesEventArgv(s: PassSummary): string[] {
  const iso = (ms: number) => new Date(ms).toISOString()
  const data = {
    from_at: iso(s.from),
    to_at: iso(s.to),
    passes: s.passes,
    acting: s.acting,
    errors: s.errors,
    mean_ms: s.mean,
    p50_ms: s.p50,
    p90_ms: s.p90,
    max_ms: s.max,
    acting_mean_ms: s.actingMean,
    idle_mean_ms: s.idleMean,
    observe_mean_ms: s.observeMean,
    observe_commands_mean_ms: s.observeCommandsMean,
    observe_in_process_mean_ms: s.observeInProcessMean,
    observe_in_process_max_ms: s.observeInProcessMax,
    mode: s.settings.mode,
    // the event's schema still requires the field: the loop always plans with v2
    planner: 'v2',
    pass_every_ms: s.settings.passEveryMs,
  }
  return ['callum-flow-event', '--type', 'loop_passes', '--data', JSON.stringify(data)]
}
