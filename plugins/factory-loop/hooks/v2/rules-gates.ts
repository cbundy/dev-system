// The gate runs (docs/factory-loop/v2/SPEC.md 10.6, 15): one `gate_run` event for each stop gate run
// the companion logged, `gate-pass`, `gate-fail` and `gate-unknown` alike, so the metrics can say how
// long gates wait for a turn and how long they run (docs/metrics.md "Gate waits"). The companion
// writes no event itself; the loop reads its gate lines (sources-interventions.ts gateLines) and
// writes the event through `callum-flow-event --type gate_run --data <json> --issue N`. Free, and
// keyed i<N>/l<life>/s<seq>/gate/<started_at ms, base 36>, so each run is written once however often
// its line is read and the loop reloads. A wiped store can write a run still in the window again:
// the schema counts one per (issue, life, seq, started_at).
//
// A line from a companion that has the waits but not `startedAt` and `queuedBehind` (v0.51.0): the
// start is the line's time less the run and the wait, and the queue is that of the `gate-wait` line
// of the same seq within the run; with none, the queue is 0 when the gate waited for nothing, and
// the run is skipped otherwise (a wait that ran out writes no `gate-wait`). A line with no numeric
// `waitMs` (a companion older than the waits, the hook's bare `gate-unknown`) is skipped: writing 0
// would invent a wait. A line whose values do not fit the schema writes nothing: the `event`
// executor treats a refused payload as a loop bug. Pure.
import { gate, skip } from '../foundation'
import type { GateRunData } from './events'
import { gateRunKey } from './keys'
import type { GateLine } from './sources-interventions'
import type { V2Ctx } from './types'

// The companion's gate causes that are runs (10.6), each a `gate_run`; `gate-wait` is no run, and
// `gate-unknown` is an intervention besides (sources-interventions.ts).
export const GATE_RUN_CAUSES = ['gate-pass', 'gate-fail', 'gate-unknown'] as const
export type GateRunCause = (typeof GATE_RUN_CAUSES)[number]

const RESULTS = { 'gate-pass': 'pass', 'gate-fail': 'fail', 'gate-unknown': 'unknown' } as const

const count = (v: number | null): v is number => v !== null && Number.isInteger(v) && v >= 0
// date-time as the companion writes it: UTC with a Z and 0 to 3 fraction digits (a real date: the line's startedMs)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

// fits: whether the data is what gate_run.v1 accepts (docs/factory-events/schemas/gate_run.v1.json).
// The planner holds no clock and so does not read through event-reader.ts; this is its twin, and
// tests/factory-loop-v2-events.test.js holds a payload this passes to the real schema.
function fits(d: GateRunData): boolean {
  return (
    /^[0-9a-z]+$/.test(d.life) &&
    count(d.seq) &&
    (d.head === null || /^[0-9a-f]{7,40}$/.test(d.head)) &&
    count(d.wait_ms) &&
    count(d.run_ms) &&
    (d.concurrency === null || (Number.isInteger(d.concurrency) && d.concurrency >= 1)) &&
    count(d.queued_behind) &&
    ISO.test(d.started_at)
  )
}

// gateRunOf: the `gate_run` data of one gate line, or null when it is to be skipped. waits: the
// `gate-wait` lines of the same pass.
export function gateRunOf(line: GateLine, waits: readonly GateLine[]): { data: GateRunData; startedMs: number } | null {
  if (line.cause === 'gate-wait' || !count(line.waitMs) || !count(line.ms) || line.head === undefined || line.concurrency === undefined) return null
  let startedAt: string
  let startedMs: number
  let queuedBehind: number
  if (line.startedAt !== null || line.queuedBehind !== null) {
    // the companion's own fields come together
    if (line.startedAt === null || line.startedMs === null || line.queuedBehind === null) return null
    startedAt = line.startedAt
    startedMs = line.startedMs
    queuedBehind = line.queuedBehind
  } else {
    if (line.derived === null) return null
    const start = line.derived.ms
    startedAt = line.derived.iso
    startedMs = start
    const own = waits
      .filter(w => w.cause === 'gate-wait' && w.issue === line.issue && w.life === line.life && w.seq === line.seq && w.at >= start && w.at <= line.at)
      .reduce<GateLine | null>((latest, w) => (latest === null || w.at >= latest.at ? w : latest), null)
    if (own !== null && own.queuedBehind !== null) queuedBehind = own.queuedBehind
    else if (line.waitMs === 0) queuedBehind = 0
    else return null
  }
  const data: GateRunData = {
    life: line.life,
    seq: line.seq,
    head: line.head,
    result: RESULTS[line.cause],
    wait_ms: line.waitMs,
    run_ms: line.ms,
    concurrency: line.concurrency,
    queued_behind: queuedBehind,
    started_at: startedAt,
  }
  return fits(data) ? { data, startedMs } : null
}

// gateRunRules: one free `event` action per gate run the ledger has not written. One that used up
// its attempts (callum-flow-event refused its payload: a loop bug) is told in its skip line, and the
// executor breaker catches a run of them.
export function gateRunRules(ctx: V2Ctx): void {
  const lines = ctx.v2.interventions.gates ?? []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!GATE_RUN_CAUSES.some(c => c === line.cause)) continue
    const run = gateRunOf(line, lines)
    if (run === null) continue
    const { data } = run
    const key = gateRunKey({ issue: line.issue, life: line.life, seq: line.seq }, run.startedMs)
    if (seen.has(key)) continue
    seen.add(key)
    const g = gate(ctx, key, 'event')
    if (g === 'go') ctx.out.push({ kind: 'event', key, class: 'free', rule: 'S2', reason: `gate run: ${data.result} in ${data.run_ms} ms after ${data.wait_ms} ms`, issue: line.issue, event: { state: 'gate_run', issue: line.issue, data } })
    else if (g === 'exhausted') skip(ctx, 'S2', line.issue, `exhausted: ${key}: the gate run is not logged`)
  }
}
