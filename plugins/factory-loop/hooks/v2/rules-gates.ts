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
// executor treats a refused payload as a loop bug.
//
// Flakes: a `gate-pass` whose slot was clean gets `flaky` = whether the run before it in the same
// issue and life (the latest start before its own, any seq) was a `gate-fail` on the same head with a
// clean slot, and then `failed_tests` and `failed_at` from that fail. Anything that leaves it open
// whether the head, the tree or the run order changed in between (a run of unknown start, an unknown
// run, a null head, a dirty or unknown slot) is `flaky: false`: a false flake files a bug. A pass line
// from a companion before `clean` gets no `flaky` at all. A fail row carries its own `failed_tests`.
// Pure.
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
    ISO.test(d.started_at) &&
    (d.flaky === undefined || d.flaky === null || typeof d.flaky === 'boolean') &&
    (d.failed_tests === undefined ||
      d.failed_tests === null ||
      (Array.isArray(d.failed_tests) && d.failed_tests.length <= 20 && d.failed_tests.every(t => typeof t === 'string' && t.length <= 200))) &&
    (d.failed_at === undefined || d.failed_at === null || ISO.test(d.failed_at))
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
  if (line.cause === 'gate-fail' && line.failedTests !== null) data.failed_tests = line.failedTests
  return fits(data) ? { data, startedMs } : null
}

// startOf: when a line's run started, or null when the line says nothing of it.
const startOf = (l: GateLine): number | null => l.startedMs ?? l.derived?.ms ?? null

// flakeOf: the flake verdict of the pass `line`, started at `startedMs`: its data fields, or the check
// that refused it. The run before is the one of the latest known start; a line of no known start
// (the hook's bare `gate-unknown`) between the two may have run a gate, so it refuses.
export function flakeOf(line: GateLine, startedMs: number, lines: readonly GateLine[]): { flaky: true; failed_tests: string[] | null; failed_at: string; head: string } | { flaky: false; why: string } {
  let before: GateLine | null = null
  let beforeStart = -Infinity
  for (const l of lines) {
    if (l === line || l.issue !== line.issue || l.life !== line.life || !GATE_RUN_CAUSES.some(c => c === l.cause)) continue
    const start = startOf(l)
    if (start !== null && start < startedMs && start > beforeStart) {
      before = l
      beforeStart = start
    }
  }
  if (before === null) return { flaky: false, why: 'no run before it in this life' }
  for (const l of lines) {
    if (l.issue !== line.issue || l.life !== line.life || !GATE_RUN_CAUSES.some(c => c === l.cause) || startOf(l) !== null) continue
    if (l.at > beforeStart && l.at < startedMs) return { flaky: false, why: 'a run of unknown start lies between' }
  }
  if (before.cause === 'gate-pass') return { flaky: false, why: 'the run before was a pass' }
  if (before.cause === 'gate-unknown') return { flaky: false, why: 'the run before did not finish' }
  if (before.head === null || before.head === undefined || line.head === null || line.head === undefined) return { flaky: false, why: 'the head is unknown' }
  if (before.head !== line.head) return { flaky: false, why: 'the head moved' }
  if (before.clean !== true || line.clean !== true) return { flaky: false, why: 'the slot was dirty' }
  return { flaky: true, failed_tests: before.failedTests, failed_at: before.startedAt ?? before.derived?.iso ?? '', head: before.head }
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
    let note = ''
    if (line.cause === 'gate-pass' && line.hasClean) {
      const f = line.clean === true ? flakeOf(line, run.startedMs, lines) : { flaky: false as const, why: 'the slot was dirty' }
      if (f.flaky) {
        data.flaky = true
        data.failed_tests = f.failed_tests
        data.failed_at = f.failed_at
        note = `, flaky after the fail at ${f.failed_at} on ${f.head.slice(0, 7)}`
      } else {
        data.flaky = false
        note = `, not a flake: ${f.why}`
      }
      if (!fits(data)) continue
    }
    const key = gateRunKey({ issue: line.issue, life: line.life, seq: line.seq }, run.startedMs)
    if (seen.has(key)) continue
    seen.add(key)
    const g = gate(ctx, key, 'event')
    if (g === 'go') ctx.out.push({ kind: 'event', key, class: 'free', rule: 'S2', reason: `gate run: ${data.result} in ${data.run_ms} ms after ${data.wait_ms} ms${note}`, issue: line.issue, event: { state: 'gate_run', issue: line.issue, data } })
    else if (g === 'exhausted') skip(ctx, 'S2', line.issue, `exhausted: ${key}: the gate run is not logged`)
  }
}
