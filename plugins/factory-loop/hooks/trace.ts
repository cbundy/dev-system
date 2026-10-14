// Trace mode (#552): with config `trace` on, each pass writes one record to
// <loop dir>/trace-YYYY-MM-DD.jsonl beside its decision-log line, for troubleshooting and for
// measuring the loop: what asked for the pass, how long it and each of its phases took, every
// command it ran (the source it read, its exit, its bytes), each action's times, the wakes'
// latencies, and what each issue waits on and since when. The files stay within config
// traceMaxBytes: the oldest go first, and today's is cut short rather than pass it (traceRoom).
// register.ts holds the clock and the files; a Tracer only times the calls it is handed, and the
// rest here is pure.
import type { ActOutcome } from './act'
import type { ActIo, RunResult } from './exec'
import type { Io } from './observe'
import type { ActionKind, LedgerEntry, LedgerStatus, Ms, PlanResult, Skip, SourceName, Stage, State } from './types'

// A pass's phases in the order they run, each ending where the next begins: setup (the settings,
// the kill switch, the agent list), rails (act mode's checks and the act lock), observe, plan, act
// (the actions, the title, the notices and the store writes after them) and log (the decision log,
// a recorded state, the daily prune).
export const PHASES = ['setup', 'rails', 'observe', 'plan', 'act', 'log'] as const
export type Phase = (typeof PHASES)[number]

// What an observe command reads: a State source, or the main checkout.
export type TraceSource = SourceName | 'checkout'

// One command or engine call: the phase it ran in, the source it read (observe's reads), when it
// started (t, ms into the pass), how long it took, its exit and the bytes it printed; error when
// it threw or was refused.
export type Command = { phase: Phase; source?: TraceSource; cmd: string; t: number; ms: number; exit?: number | null; bytes?: number; error?: string }

export type Tracer = {
  // performance.now(), and its reading when the pass started
  now: () => number
  t0: number
  // the loop's clock at one reading of `now`: a clock time (an action's start) as a pass time
  anchor: { at: Ms; t: number }
  phase: Phase
  lapAt: number
  phases: Record<Phase, number>
  commands: Command[]
  // the pass's time in store writes, event writes and the act lock, whatever phase they ran in
  persistMs: number
  eventsMs: number
  lockMs: number
}

const CMD_MAX = 160
const ERROR_MAX = 200
const WAKES: readonly ActionKind[] = ['judge', 'task', 'tell']
const LIVE: readonly Stage[] = ['designing', 'implementing', 'in pipeline', 'parked', 'ready to merge']
const encoder = new TextEncoder()

// to a tenth of a millisecond: plan takes a few
const tenth = (ms: number) => Math.round(ms * 10) / 10
const iso = (ms: Ms) => new Date(ms).toISOString()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

// newTracer: a pass that started at t0 (a reading of now), with the loop's clock at `at` now.
export function newTracer(now: () => number, t0: number, at: Ms): Tracer {
  const t = now()
  return {
    now,
    t0,
    anchor: { at, t },
    phase: 'setup',
    lapAt: t0,
    phases: { setup: 0, rails: 0, observe: 0, plan: 0, act: 0, log: 0 },
    commands: [],
    persistMs: 0,
    eventsMs: 0,
    lockMs: 0,
  }
}

// begin: the phase running ends now and the next one starts.
export function begin(tr: Tracer | null, phase: Phase) {
  if (tr === null) return
  const t = tr.now()
  tr.phases[tr.phase] += t - tr.lapAt
  tr.lapAt = t
  tr.phase = phase
}

// carve: ms of the phase running belong to another (act mode plans inside its act step).
export function carve(tr: Tracer | null, phase: Phase, ms: number) {
  if (tr === null) return
  tr.phases[phase] += ms
  tr.lapAt += ms
}

// passTime: a time on the loop's clock as ms into the pass.
export function passTime(tr: Tracer, at: Ms): number {
  return tenth(at - tr.anchor.at + tr.anchor.t - tr.t0)
}

// spent: work, its time added to one of the pass's totals.
export async function spent<T>(tr: Tracer | null, total: 'persistMs' | 'eventsMs' | 'lockMs', work: () => Promise<T>): Promise<T> {
  if (tr === null) return work()
  const start = tr.now()
  try {
    return await work()
  } finally {
    tr[total] += tr.now() - start
  }
}

// timed: one call, recorded in the order calls start.
async function timed<T>(tr: Tracer, cmd: string, work: () => Promise<T>, read: (r: T) => Partial<Command> = () => ({}), source?: TraceSource): Promise<T> {
  const start = tr.now()
  const at = { cmd: cmd.slice(0, CMD_MAX), t: tenth(start - tr.t0), ms: 0 }
  const c: Command = source === undefined ? { phase: tr.phase, ...at } : { phase: tr.phase, source, ...at }
  tr.commands.push(c)
  try {
    const r = await work()
    Object.assign(c, read(r))
    return r
  } catch (err) {
    c.exit = null
    c.error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX)
    throw err
  } finally {
    c.ms = tenth(tr.now() - start)
  }
}

const ran = (r: RunResult): Partial<Command> => ({ exit: r.exitCode, bytes: byteLength(r.stdout) })

// sourceOf: the State source an observe command reads (observe.ts), from its program.
export function sourceOf(argv: readonly string[]): TraceSource | undefined {
  const [cmd = '', ...args] = argv
  const tool = cmd.slice(cmd.lastIndexOf('/') + 1)
  if (cmd === 'callum-flow-factory-state') return 'factory'
  if (cmd === 'dev-query') return 'facts'
  if (tool === 'pipeline-watch.sh') return 'runs'
  if (tool === 'queue-watch.sh' || (cmd === 'callum-flow-issue-read' && args.includes('--list'))) return 'queue'
  if (cmd === 'callum-flow-issue-read') return 'github'
  if (tool === 'usage-check.sh') return 'usage'
  if (cmd === 'treehouse') return 'pool'
  if (cmd === 'git') return 'checkout'
  if (cmd === 'callum-flow-milestone') return 'milestone'
  return undefined
}

// tracedIo: observe's engine calls, each recorded with the source it reads.
export function tracedIo(tr: Tracer, io: Io): Io {
  return {
    ...io,
    run: (argv, init) => timed(tr, argv.join(' '), () => io.run(argv, init), ran, sourceOf(argv)),
    readFile: path => timed(tr, `fs.read ${path}`, () => io.readFile(path), text => (text === null ? {} : { bytes: byteLength(text) })),
    sessionLimits: () => timed(tr, 'session.usage', () => io.sessionLimits()),
  }
}

// tracedActIo: the act half's engine calls, each recorded; event writes also count in eventsMs.
export function tracedActIo(tr: Tracer, io: ActIo): ActIo {
  const refused = (r: { deny?: string; error?: string }): Partial<Command> => {
    const why = r.deny ?? r.error
    return why === undefined ? {} : { error: why.slice(0, ERROR_MAX) }
  }
  return {
    ...io,
    run: (argv, init) => {
      const call = () => timed(tr, argv.join(' '), () => io.run(argv, init), ran)
      return argv[0] === 'callum-flow-event' ? spent(tr, 'eventsMs', call) : call()
    },
    spawnAgent: input => timed(tr, `agent.spawn ${input.name ?? input.subagentType}`, () => io.spawnAgent(input), refused),
    stopAgent: agentId => timed(tr, `TaskStop ${agentId}`, () => io.stopAgent(agentId), refused),
    submit: text => timed(tr, `prompt.submit ${text.split('\n', 1)[0] ?? ''}`, () => io.submit(text)),
    rename: title => timed(tr, 'rename', () => io.rename(title)),
    usage: () => timed(tr, 'session.usage', () => io.usage()),
    readFile: path => timed(tr, `fs.read ${path}`, () => io.readFile(path), text => (text === null ? {} : { bytes: byteLength(text) })),
    writeFile: (path, text) => timed(tr, `fs.write ${path}`, () => io.writeFile(path, text), () => ({ bytes: byteLength(text) })),
  }
}

// lockTimed: one write of the act lock (rails.ts LOCK_CAS_SCRIPT), recorded as `act lock`, its
// time, the flock wait included, counted in lockMs.
export function lockTimed<T extends RunResult>(tr: Tracer | null, work: () => Promise<T>): Promise<T> {
  if (tr === null) return work()
  return spent(tr, 'lockMs', () => timed(tr, 'act lock', work, r => ({ exit: r.exitCode })))
}

// --- the record's parts -----------------------------------------------------------------------

// One source as the pass found it: read (`reads` commands, `ms` in all) or taken from the observe
// cache, how old State says its data is, and why it failed.
export type SourceRow = { ok: boolean; cached: boolean; reads: number; ms: number; ageMs: Ms | null; error?: string }

// sourceRows: each State source and the main checkout. A source that ran no command of its own
// this pass took its data from the observe cache (GitHub when no issue was due), unless it is one
// of `made`, built each pass from another source (a shadow's runs from the event log, its pool
// from the pool size).
export function sourceRows(state: State, commands: readonly Command[], made: readonly SourceName[] = []): Record<string, SourceRow> {
  const read = (name: TraceSource) => {
    const own = commands.filter(c => c.source === name)
    return { reads: own.length, ms: tenth(own.reduce((n, c) => n + c.ms, 0)) }
  }
  const out: Record<string, SourceRow> = {}
  for (const [name, s] of Object.entries(state.sources) as [SourceName, State['sources'][SourceName]][]) {
    const r = read(name)
    const row: SourceRow = { ok: s.ok, cached: r.reads === 0 && s.at !== null && !made.includes(name), ...r, ageMs: s.at === null ? null : state.now - s.at }
    if (s.error !== undefined) row.error = s.error
    out[name] = row
  }
  if (state.checkout !== null) {
    const failed = 'error' in state.checkout ? state.checkout.error : null
    out.checkout = { ok: failed === null, cached: false, ...read('checkout'), ageMs: failed === null ? 0 : null, ...(failed === null ? {} : { error: failed }) }
  }
  return out
}

// One executed action: when plan handed it over, when it started and ended (ms into the pass;
// null for one held before it started), and how long it ran. A spawn's ms is its time to start:
// it returns once the agent started.
export type ActionRow = { key: string; kind: ActionKind; status: ActOutcome['status']; queued: number | null; started: number | null; ended: number | null; ms: Ms }

export function actionRows(tr: Tracer, outcomes: readonly ActOutcome[], queuedAt: Ms | null): ActionRow[] {
  return outcomes.map(o => {
    const started = o.at === undefined ? null : passTime(tr, o.at)
    return {
      key: o.key,
      kind: o.kind,
      status: o.status,
      queued: queuedAt === null ? null : passTime(tr, queuedAt),
      started,
      ended: started === null ? null : tenth(started + o.ms),
      ms: o.ms,
    }
  })
}

// attemptOf: one attempt of a ledger entry (a retry keeps the key, not the start).
export function attemptOf(e: LedgerEntry): string {
  return `${e.key}@${e.startedAt}`
}

// One wake's latencies: queued (its submit), delivered (its turn started), ended (answered, or
// timed out or lost), the ms between them.
export type WakeRow = {
  key: string
  wake: string | null
  status: LedgerStatus
  queued: string
  delivered: string | null
  ended: string | null
  deliverMs: Ms | null
  answerMs: Ms | null
}

// wakeRows: every open wake, and each wake that ended at or after `since` and was not reported
// yet, with the attempts it reports ended (attemptOf), so the caller reports each once.
// delivered: when each attempt's turn first started (register.ts records it at turn.start).
export function wakeRows(
  ledger: readonly LedgerEntry[],
  delivered: ReadonlyMap<string, Ms>,
  reported: ReadonlySet<string>,
  since: Ms,
): { rows: WakeRow[]; reported: string[] } {
  const rows: WakeRow[] = []
  const ended: string[] = []
  for (const e of ledger) {
    if (!WAKES.includes(e.kind)) continue
    const end = e.status === 'running' ? null : (e.endedAt ?? e.startedAt)
    if (end !== null && (reported.has(attemptOf(e)) || end < since)) continue
    if (end !== null) ended.push(attemptOf(e))
    const at = delivered.get(attemptOf(e)) ?? null
    rows.push({
      key: e.key,
      wake: e.wake ?? null,
      status: e.status,
      queued: iso(e.startedAt),
      delivered: at === null ? null : iso(at),
      ended: end === null ? null : iso(end),
      deliverMs: at === null ? null : at - e.startedAt,
      answerMs: at === null || end === null ? null : end - at,
    })
  }
  return { rows, reported: ended }
}

// What one issue waits on (null: the whole pass, a source down), since when, and for how long.
export type WaitRow = { issue: number | null; stage: Stage | null; rule: string | null; on: string; since: string | null; forMs: Ms | null }

const waitKey = (s: Skip) => `${s.issue}:${s.rule}`

// waitSince: when each skip, by issue and rule, was first seen in a run of passes: one that keeps
// coming keeps its start, so a stall shows as a growing age (its words may change, as a
// countdown's do); one that stops is forgotten.
export function waitSince(prev: ReadonlyMap<string, Ms>, skipped: readonly Skip[], now: Ms): Map<string, Ms> {
  const next = new Map<string, Ms>()
  for (const s of skipped) if (!next.has(waitKey(s))) next.set(waitKey(s), prev.get(waitKey(s)) ?? now)
  return next
}

// waitingRows: each skip plan gave (the rule's reason, with how long it has been given), each
// running ledger entry an issue waits for, and each live issue of this device that nothing acts
// on and nothing names, waiting in its stage.
export function waitingRows(state: State, result: PlanResult, ledger: readonly LedgerEntry[], since: ReadonlyMap<string, Ms>): WaitRow[] {
  const stageOf = (n: number | null) => (n === null ? null : (state.issues.find(i => i.number === n)?.stage ?? null))
  const rows: WaitRow[] = []
  const seen = new Set<string>()
  for (const s of result.skipped) {
    if (seen.has(waitKey(s))) continue
    seen.add(waitKey(s))
    const at = since.get(waitKey(s)) ?? state.now
    rows.push({ issue: s.issue, stage: stageOf(s.issue), rule: s.rule, on: s.why, since: iso(at), forMs: state.now - at })
  }
  for (const e of ledger) {
    if (e.status !== 'running' || e.issue === null) continue
    rows.push({ issue: e.issue, stage: stageOf(e.issue), rule: e.rule, on: `${e.key} running`, since: iso(e.startedAt), forMs: state.now - e.startedAt })
  }
  for (const i of state.issues) {
    if (i.stage === null || !LIVE.includes(i.stage) || i.holder !== state.device) continue
    if (rows.some(r => r.issue === i.number) || result.actions.some(a => a.issue === i.number)) continue
    const at = i.stageSince
    rows.push({ issue: i.number, stage: i.stage, rule: null, on: 'no rule acts on it', since: at === null ? null : iso(at), forMs: at === null ? null : state.now - at })
  }
  return rows.sort((a, b) => (a.issue ?? 0) - (b.issue ?? 0))
}

export type TraceInput = {
  tr: Tracer
  // the decision-log line's fields the record repeats, so the two join
  line: { at: string; pass: number; loaded: string; mode: string; executed: boolean; trigger: string }
  state: State
  // the sources built each pass from another (sourceRows)
  made: readonly SourceName[]
  outcomes: readonly ActOutcome[]
  // when plan handed the actions over, on the loop's clock; null when the pass did not act
  queuedAt: Ms | null
  wakes: WakeRow[]
  waiting: WaitRow[]
}

// traceRecord: the pass's record, its log phase ending now: start and end on the loop's clock
// (`at` is the decision log's, when observe began), ms between them.
export function traceRecord(input: TraceInput): Record<string, unknown> {
  const { tr } = input
  begin(tr, 'log')
  const start = Math.round(tr.anchor.at - (tr.anchor.t - tr.t0))
  const ms = tenth(tr.lapAt - tr.t0)
  return {
    v: 1,
    ...input.line,
    start: iso(start),
    end: iso(Math.round(start + ms)),
    ms,
    phases: Object.fromEntries(PHASES.map(p => [p, tenth(tr.phases[p])])),
    persistMs: tenth(tr.persistMs),
    eventsMs: tenth(tr.eventsMs),
    lockMs: tenth(tr.lockMs),
    sources: sourceRows(input.state, tr.commands, input.made),
    commands: tr.commands,
    actions: actionRows(tr, input.outcomes, input.queuedAt),
    wakes: input.wakes,
    waiting: input.waiting,
  }
}

// --- the files and their cap --------------------------------------------------------------------

const TRACE_NAME = /^trace-\d{4}-\d{2}-\d{2}\.jsonl$/
// a record is written only while the line that cuts today's file short would still fit after it
export const CUT_ROOM = 256

export function traceName(day: string): string {
  return `trace-${day}.jsonl`
}

// cutLine: the last line of a trace file the cap cut short (under CUT_ROOM bytes).
export function cutLine(at: string, cap: number): string {
  return JSON.stringify({ v: 1, at, cut: `the trace cap (${cap} bytes) is reached: nothing more is traced today` }) + '\n'
}

export type Room = { remove: string[]; write: 'record' | 'cut' | 'none' }

// traceRoom: what one more record of `bytes` takes under the cap, given the loop dir's files:
// the oldest trace files are deleted first (by the day in their names, never today's) until it
// fits; when today's file alone leaves no room, it is cut short with one line (cutLine), and
// once cut (`cut`) nothing more goes in it. The files never pass the cap.
export function traceRoom(files: readonly { name: string; size: number }[], day: string, bytes: number, cap: number, cut: boolean): Room {
  if (cut) return { remove: [], write: 'none' }
  const today = traceName(day)
  const traces = files.filter(f => TRACE_NAME.test(f.name)).sort((a, b) => a.name.localeCompare(b.name))
  let total = traces.reduce((n, f) => n + f.size, 0)
  const fits = (more: number) => total + more <= cap
  const remove: string[] = []
  for (const f of traces) {
    if (fits(bytes + CUT_ROOM)) break
    if (f.name === today) continue
    remove.push(f.name)
    total -= f.size
  }
  if (fits(bytes + CUT_ROOM)) return { remove, write: 'record' }
  return { remove, write: fits(CUT_ROOM) ? 'cut' : 'none' }
}
