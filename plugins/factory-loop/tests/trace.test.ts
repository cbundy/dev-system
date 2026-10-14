// Trace mode (#552): off by default, when the decision log alone gains each pass's total time and
// its trigger; on (the repo-local settings, the workspace file, or `/factory trace on` mid-run),
// one record per pass in trace-YYYY-MM-DD.jsonl beside the decision log, with the phases, every
// command, the sources, each action's times, the wakes' latencies and what each issue waits on,
// all under a size cap that deletes the oldest files first and cuts today's short. The driver
// runs in the engine's test host (tests/host.ts); the record's parts are pure (hooks/trace.ts).
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_CONFIG, loadConfig } from '../hooks/config'
import { formatOp, parseOp, runOp } from '../hooks/control'
import type { FileIo } from '../hooks/control'
import type { ActIo } from '../hooks/exec'
import type { Io } from '../hooks/observe'
import {
  CUT_ROOM,
  PHASES,
  begin,
  carve,
  cutLine,
  isCutLine,
  lockTimed,
  newTracer,
  sourceOf,
  traceRecord,
  traceRoom,
  tracedActIo,
  tracedIo,
  waitSince,
  waitingRows,
  wakeRows,
} from '../hooks/trace'
import type { LedgerEntry, PlanResult } from '../hooks/types'
import { DEVICE, MIN, NOW, entry, issue, mine, state } from './fixtures'
import { CFG_DIR, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, SESSION, TOOLS, agentDone, factoryDoc, host, iso } from './host'
import type { Seen } from './host'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const OBSERVE = { repo: REPO, mode: 'observe', checkout: '/work' }
const ACT = { repo: REPO, mode: 'act', checkout: '/work' }
const CONFIG_FILE = `${CFG_DIR}/factory-loop/config.json`
const REPO_FILE = '/work/.claude/factory-loop.json'
const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-9001'
const DAY = iso(NOW).slice(0, 10)
const TRACE = `${LOOP_DIR}/trace-${DAY}.jsonl`

type Rec = Record<string, unknown>
type Command = { phase: string; source?: string; cmd: string; t: number; ms: number; exit?: number | null; bytes?: number }

// world: issue 470 in the ready queue, the rest quiet; both modes' reads answered.
function world(issues: Rec[] = []) {
  return (argv: string[], s: Seen) => {
    const [cmd, ...args] = argv
    switch (cmd) {
      case 'callum-flow-factory-state':
        return { stdout: factoryDoc(issues) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: `queue known=${args[args.indexOf('--known') + 1] ?? 'none'} now=470\n` }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read':
        if (args.includes('--comments')) return { stdout: JSON.stringify({ comments: [], stripped: 0 }) }
        if (args.includes('--list')) return { stdout: JSON.stringify({ issues: [{ number: 470 }], stripped: 0 }) }
        if (args.join(' ') === '--json 470') {
          const issue = { number: 470, title: 'The loop acts', state: 'open', labels: [{ name: 'ready' }], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }
          return { stdout: JSON.stringify({ issue, stripped: 0 }) }
        }
        return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: '[]' }
    }
    return undefined
  }
}

const ledgerOf = (entries: LedgerEntry[]) => ({ [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries } })
const SWEPT = entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })

async function factoryOp($: Engine, args: string) {
  return $.command.run({ command: 'factory', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

const commandsOf = (r: Rec) => r.commands as Command[]

describe('trace off (the default)', () => {
  test('the decision log gains the pass total and its trigger; nothing else is written or read', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: OBSERVE, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    const [first, second] = h.passes()
    expect(first).toMatchObject({ trigger: 'first' })
    expect(second).toMatchObject({ trigger: 'timer' })
    for (const line of h.passes()) {
      expect(typeof line.ms).toBe('number')
      expect(line.ms as number).toBeGreaterThanOrEqual(0)
    }
    expect([...h.files.keys()].filter(p => p.includes('/trace-'))).toEqual([])
    expect(h.listed).toEqual([])
    expect(h.seen.some(s => s.argv[0] === 'rm')).toBe(false)
  })

  test('a pass that throws logs its total and trigger on its error line', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: ACT, run: world(), store: ledgerOf([SWEPT]) })
    h.failSet = key => key === `ledger:${REPO}`
    await $.session.start(START)
    await clock.advance(6_000)
    const error = h.lines().find(l => typeof l.error === 'string')
    expect(error).toMatchObject({ pass: 1, trigger: 'first' })
    expect(typeof error?.ms).toBe('number')
  })
})

describe('trace on', () => {
  test('one record per pass beside the decision log: trigger, phases, commands, sources and waits', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { ...OBSERVE, trace: true }, run: world(), files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ noNewWork: true }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    const passes = h.passes()
    const traces = h.traces()
    expect(traces).toHaveLength(2)
    expect([...h.files.keys()]).toContain(TRACE)
    const [t1, t2] = traces as [Rec, Rec]

    // the record joins its decision-log line by time and pass, and names its trigger
    expect(t1).toMatchObject({ v: 1, at: passes[0]?.at, pass: 1, mode: 'observe', executed: false, trigger: 'first' })
    expect(t2).toMatchObject({ at: passes[1]?.at, pass: 2, trigger: 'timer' })

    // the phases in the order they ran; the total covers them all
    const phases = t1.phases as Record<string, number>
    expect(Object.keys(phases)).toEqual(['setup', 'rails', 'observe', 'plan', 'act', 'log'])
    expect(Object.keys(phases)).toEqual([...PHASES])
    const total = t1.ms as number
    for (const ms of Object.values(phases)) {
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(total)
    }
    for (const key of ['persistMs', 'eventsMs', 'lockMs']) expect(typeof t1[key]).toBe('number')

    // every command of the pass, each with the source it read, its time, exit and bytes
    expect(commandsOf(t1)[0]).toMatchObject({ phase: 'setup', cmd: 'agent.list' })
    const factory = commandsOf(t1).find(c => c.cmd.startsWith('callum-flow-factory-state'))
    expect(factory).toMatchObject({ phase: 'observe', source: 'factory', exit: 0, bytes: factoryDoc([]).length })
    expect(factory?.t).toBeGreaterThanOrEqual(0)
    const sourceOf = (r: Rec, start: string) => commandsOf(r).find(c => c.cmd.startsWith(start))?.source
    expect(sourceOf(t1, 'callum-flow-issue-read --json --list')).toBe('queue')
    expect(sourceOf(t1, 'callum-flow-issue-read --json 470')).toBe('github')
    expect(sourceOf(t1, `${TOOLS}/usage-check.sh`)).toBe('usage')
    expect(sourceOf(t1, 'git ')).toBe('checkout')
    // what came from the observe cache: the queue, GitHub and usage are read on their cadences
    const sources1 = t1.sources as Record<string, Rec>
    const sources2 = t2.sources as Record<string, Rec>
    expect(sources1.queue).toMatchObject({ ok: true, cached: false, reads: 1, ageMs: 0 })
    expect(sources2.queue).toMatchObject({ ok: true, cached: true, reads: 0 })
    expect(sources2.github).toMatchObject({ cached: true, reads: 0 })
    expect(sources2.factory).toMatchObject({ ok: true, cached: false, reads: 1, ageMs: 0 })
    expect(sources2.queue?.ageMs).toBe(Date.parse(String(t2.at)) - Date.parse(String(t1.at)))

    // what each issue waits on, and since when: the same skip keeps its start, so its age grows
    const wait = (r: Rec) => (r.waiting as Rec[]).find(w => w.issue === 470 && w.rule === 'D1')
    expect(wait(t1)).toMatchObject({ on: 'owner: no new work', since: t1.at, forMs: 0 })
    expect(wait(t2)).toMatchObject({ on: 'owner: no new work', since: t1.at, forMs: Date.parse(String(t2.at)) - Date.parse(String(t1.at)) })
    // observe mode executes nothing
    expect(t1.actions).toEqual([])
  })

  test('the repo-local settings switch it on for the repo; the workspace file overrides them', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: OBSERVE, run: world(), files: { [REPO_FILE]: JSON.stringify({ trace: true }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.traces()).toHaveLength(1)
    expect(h.last().config).toBeUndefined()
    h.files.set(CONFIG_FILE, JSON.stringify({ ...OBSERVE, trace: false }))
    await clock.advance(60_000)
    expect(h.passes()).toHaveLength(2)
    expect(h.traces()).toHaveLength(1)
  })

  test('/factory trace on and off work mid-run, through the workspace file, and /factory help lists it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { ...OBSERVE, poolSize: 8 }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.traces()).toEqual([])

    const r = await factoryOp($, 'trace on')
    expect(r.text).toStartWith('Trace on')
    expect(JSON.parse(h.files.get(CONFIG_FILE) ?? '{}')).toEqual({ ...OBSERVE, poolSize: 8, trace: true })
    // its line follows the answer (#558)
    await clock.settle()
    expect(h.lines().some(l => l.control === 'trace on')).toBe(true)
    // the op pings a pass, which traces
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(2)
    expect(h.traces()).toHaveLength(1)
    expect(h.traces()[0]).toMatchObject({ pass: 2, trigger: 'owner trace on' })

    expect((await factoryOp($, 'trace off')).text).toStartWith('Trace off')
    expect(JSON.parse(h.files.get(CONFIG_FILE) ?? '{}')).toMatchObject({ trace: false })
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(3)
    expect(h.traces()).toHaveLength(1)

    expect((await factoryOp($, 'help')).text).toContain('trace on|off')
    expect((await factoryOp($, 'trace')).text).toBe('Usage: trace on|off')
  })

  test('each pass names what asked for it: the timer, an agent, a wake, an owner op', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const issues = [{ issue: 470, stage: 'designing', entered_at: iso(since), holder: DEVICE, run: null, pr: null, stuck: null, github: null }]
    const store = ledgerOf([
      SWEPT,
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(`design:470:${since}`, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
      entry('judge:sequence:512:abc1234', 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - MIN, endedAt: null, wakeId: 'w9', session: SESSION }),
    ])
    const h = host(on, { config: { ...ACT, trace: true }, run: world(issues), store })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    await $.session.start(START)
    await clock.advance(6_000)

    await agentDone($, h, 'agent-1', `Brief posted.\nRESULT brief=${BRIEF} created=none pending_decision=no`)
    await clock.advance(5_000)
    await $.tool.call({ tool: 'mcp__factory-loop__answer', id: 'w9', decision: 'merge' })
    await clock.advance(5_000)
    await factoryOp($, 'pause 470')
    await clock.advance(5_000)
    await clock.advance(60_000)
    const triggers = h.passes().map(l => l.trigger)
    expect(triggers).toEqual(['first', 'agent agent-1', 'wake w9', 'owner pause 470', 'timer'])
    expect(h.traces().map(t => t.trigger)).toEqual(triggers)
  })
})

describe('act mode, traced', () => {
  test("each action's queue, start and end, the act lock, and the store and event writes are timed", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { ...ACT, trace: true }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    const t = h.traces()[0] as Rec
    expect(t).toMatchObject({ mode: 'act', executed: true })
    const actions = t.actions as Rec[]
    expect(actions.map(a => [a.key, a.kind, a.status])).toEqual([
      ['update-checkout:0', 'update-checkout', 'done'],
      ['sweep:0', 'sweep', 'done'],
      ['claim:470:new', 'claim', 'done'],
      ['title', 'title', 'done'],
    ])
    let last = 0
    for (const a of actions) {
      expect(a.started as number).toBeGreaterThanOrEqual(a.queued as number)
      expect(a.started as number).toBeGreaterThanOrEqual(last)
      expect(a.ended as number).toBeGreaterThanOrEqual(a.started as number)
      last = a.ended as number
    }
    // the rails took the act lock; the claim ran in the act phase
    expect(commandsOf(t).find(c => c.cmd === 'act lock')).toMatchObject({ phase: 'rails', exit: 0 })
    expect(commandsOf(t).find(c => c.cmd.startsWith('callum-flow-claim 470'))).toMatchObject({ phase: 'act', exit: 0 })
    expect(t.lockMs as number).toBeGreaterThanOrEqual(0)
    expect(t.persistMs as number).toBeGreaterThanOrEqual(0)
  })

  test("a wake's row: queued by its action, delivered when its turn starts, answered when its turn ends", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const key = `design:470:${since}`
    const issues = [{ issue: 470, stage: 'designing', entered_at: iso(since), holder: DEVICE, run: null, pr: null, stuck: null, github: null }]
    const store = ledgerOf([
      SWEPT,
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'done', startedAt: NOW - 15 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'designer', unparsed: true } }),
      entry('tell:agent-failed:9', 'tell', { wake: 'agent-failed', class: 'owner', status: 'done', startedAt: NOW - 40 * MIN, endedAt: NOW - 30 * MIN }),
    ])
    const h = host(on, { config: { ...ACT, trace: true }, run: world(issues), store })
    await $.session.start(START)
    await clock.advance(6_000)
    const wake = h.prompts[0] ?? ''
    const id = /id=(\S+)/.exec(wake)?.[1] ?? ''
    const queued = NOW + 5_000
    const row = (r: Rec) => (r.wakes as Rec[]).find(w => w.key === `judge:report:${key}`)
    expect(row(h.traces()[0] as Rec)).toMatchObject({ wake: 'report', status: 'running', queued: iso(queued), delivered: null, ended: null })
    // a wake that ended before this load is not news
    expect(((h.traces()[0] as Rec).wakes as Rec[]).map(w => w.key)).toEqual([`judge:report:${key}`])

    // the pass ran 5 s in; the clock stands at 6 s
    await clock.advance(2_000)
    await $.turn.start({ text: wake, turnId: 'turn-1' })
    await clock.advance(3_000)
    const fields = JSON.stringify({ brief: BRIEF, created: [], pendingDecision: false })
    await $.turn.complete({ turnId: 'turn-1', answer: `ANSWER ${id} parsed\nfields: ${fields}`, reason: 'answer', durationMs: 900, isAborted: false })
    await clock.advance(5_000)
    const second = h.traces()[1] as Rec
    expect(second.trigger).toBe(`wake ${id}`)
    expect(row(second)).toMatchObject({
      status: 'done',
      queued: iso(queued),
      delivered: iso(NOW + 8_000),
      ended: iso(NOW + 11_000),
      deliverMs: 3_000,
      answerMs: 3_000,
    })
    // an ended wake is reported once
    await clock.advance(60_000)
    expect(row(h.traces()[2] as Rec)).toBeUndefined()
  })
})

describe('the cap (default 100 MiB, traceMaxBytes)', () => {
  test('the oldest trace files go first; today\'s is cut short, never past the cap', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const old = (day: string, bytes: number) => [`${LOOP_DIR}/trace-${day}.jsonl`, `${'x'.repeat(bytes - 1)}\n`] as const
    const todays = () => (h.files.get(TRACE) ?? '').split('\n').filter(l => l !== '')
    const files = Object.fromEntries([
      old('2026-10-10', 20_000),
      old('2026-10-11', 20_000),
      old('2026-10-12', 9_000),
      [REPO_FILE, JSON.stringify({ traceMaxBytes: 50_000 })],
    ])
    const h = host(on, { config: { ...OBSERVE, trace: true }, run: world(), files })
    const traceBytes = () =>
      [...h.files.entries()].filter(([p]) => p.startsWith(`${LOOP_DIR}/trace-`)).reduce((n, [, body]) => n + new TextEncoder().encode(body).length, 0)
    await $.session.start(START)
    await clock.advance(6_000)
    // 49 000 bytes and one more record do not fit 50 000: the oldest file went, nothing else
    expect(h.files.has(`${LOOP_DIR}/trace-2026-10-10.jsonl`)).toBe(false)
    expect(h.files.has(`${LOOP_DIR}/trace-2026-10-11.jsonl`)).toBe(true)
    expect(h.files.has(`${LOOP_DIR}/trace-2026-10-12.jsonl`)).toBe(true)
    expect(todays().map(l => JSON.parse(l).pass)).toEqual([1])
    expect(traceBytes()).toBeLessThanOrEqual(50_000)
    // the decision log is never a trace file
    expect([...h.files.keys()].some(p => p.startsWith(`${LOOP_DIR}/decisions-`))).toBe(true)

    // a cap today's file alone fills: the older files go, and today's is cut short with one line
    const today = new TextEncoder().encode(h.files.get(TRACE) ?? '').length
    const cap = today + 300
    h.files.set(REPO_FILE, JSON.stringify({ traceMaxBytes: cap }))
    await clock.advance(60_000)
    expect([...h.files.keys()].filter(p => p.startsWith(`${LOOP_DIR}/trace-`))).toEqual([TRACE])
    const lines = todays()
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ v: 1, cut: expect.stringContaining('trace cap') })
    expect(traceBytes()).toBeLessThanOrEqual(cap)
    // and nothing more is written to it today
    await clock.advance(60_000)
    expect(todays()).toHaveLength(2)
    expect(h.passes()).toHaveLength(3)
  })

  test("a reload finds today's file cut and keeps it closed, reading its tail once; a new cap opens it again (SPEC 12.1)", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // an earlier load wrote a big record, then cut the file under this cap
    const cap = 20_000
    const big = `${JSON.stringify({ v: 1, pass: 1, pad: 'x'.repeat(19_000) })}\n`
    const cut = big + cutLine(iso(NOW - MIN), cap)
    const h = host(on, { config: { ...OBSERVE, trace: true }, run: world(), files: { [TRACE]: cut, [REPO_FILE]: JSON.stringify({ traceMaxBytes: cap }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    // the quiet passes' records would fit, yet nothing goes after the cut line
    expect(h.passes()).toHaveLength(2)
    expect(h.files.get(TRACE)).toBe(cut)
    expect(h.seen.filter(s => s.argv[0] === 'tail').map(s => s.argv)).toEqual([['tail', '-c', String(CUT_ROOM), '--', TRACE]])
    // the cap changes: the file is open again
    h.files.set(REPO_FILE, JSON.stringify({ traceMaxBytes: cap + 50_000 }))
    await clock.advance(60_000)
    const lines = (h.files.get(TRACE) ?? '').split('\n').filter(l => l !== '')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ pass: 3 })
  })
})

// --- the pure parts (hooks/trace.ts) ----------------------------------------------------------------

describe('traceRoom: the cap', () => {
  const today = '2026-10-13'
  const f = (day: string, size: number) => ({ name: `trace-${day}.jsonl`, size })

  test('a record that fits is written, and nothing is deleted', () => {
    expect(traceRoom([f('2026-10-12', 300), f(today, 50)], today, 100, 1000, false)).toEqual({ remove: [], write: 'record' })
  })

  test('the oldest files go first, by the day in their names, until the record fits; other files are never counted', () => {
    const files = [f('2026-10-12', 300), f('2026-10-10', 300), { name: 'decisions-2026-10-10.jsonl', size: 5000 }, f(today, 50), f('2026-10-11', 300), { name: 'trace-notes.txt', size: 9000 }]
    // 950 bytes and 100 more, with the cut line's room, pass 1000: two files go
    expect(traceRoom(files, today, 100, 1000, false)).toEqual({ remove: ['trace-2026-10-10.jsonl', 'trace-2026-10-11.jsonl'], write: 'record' })
  })

  test("today's file alone leaves no room: every older file goes and today's is cut short, once", () => {
    expect(traceRoom([f('2026-10-12', 300), f(today, 700)], today, 100, 1000, false)).toEqual({ remove: ['trace-2026-10-12.jsonl'], write: 'cut' })
    expect(traceRoom([f(today, 800)], today, 10, 1000, true)).toEqual({ remove: [], write: 'none' })
    // a cap too small for the cut line writes nothing at all
    expect(traceRoom([f('2026-10-12', 30), f(today, 0)], today, 100, 100, false)).toEqual({ remove: ['trace-2026-10-12.jsonl'], write: 'none' })
  })

  test('the cut line fits its room, whatever the cap', () => {
    const line = cutLine('2026-10-13T03:00:00.000Z', Number.MAX_SAFE_INTEGER)
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(CUT_ROOM)
    expect(JSON.parse(line)).toMatchObject({ v: 1, at: '2026-10-13T03:00:00.000Z' })
  })

  test("isCutLine: the cut line of this cap only; a record, another cap's cut or a torn line is not", () => {
    const line = cutLine('2026-10-13T03:00:00.000Z', 1000).trimEnd()
    expect(isCutLine(line, 1000)).toBe(true)
    expect(isCutLine(line, 2000)).toBe(false)
    expect(isCutLine(JSON.stringify({ v: 1, pass: 3 }), 1000)).toBe(false)
    expect(isCutLine(line.slice(10), 1000)).toBe(false)
    expect(isCutLine('', 1000)).toBe(false)
  })
})

describe('the tracer', () => {
  test('phases follow one another, the plan carved out of the act step; a record adds up to the total', () => {
    let t = 100
    // the pass started at 90; the loop's clock read NOW at 100
    const tr = newTracer(() => t, 90, NOW)
    t = 110
    begin(tr, 'rails')
    t = 115
    begin(tr, 'observe')
    t = 160
    begin(tr, 'act')
    carve(tr, 'plan', 3)
    t = 200
    const record = traceRecord({
      tr,
      line: { at: iso(NOW), pass: 7, loaded: iso(NOW - MIN), mode: 'act', executed: true, trigger: 'timer' },
      state: state(),
      made: [],
      outcomes: [
        { key: 'claim:1:new', kind: 'claim', status: 'done', ms: 20, summary: 'claimed #1', at: NOW + 70 },
        { key: 'merge:2', kind: 'merge', status: 'skipped', ms: 0, summary: 'held' },
      ],
      queuedAt: NOW + 65,
      wakes: [],
      waiting: [],
    })
    expect(record).toMatchObject({ v: 1, pass: 7, trigger: 'timer', ms: 110, phases: { setup: 20, rails: 5, observe: 45, plan: 3, act: 37, log: 0 } })
    // the pass began 10 ms before the clock read NOW
    expect(record).toMatchObject({ start: iso(NOW - 10), end: iso(NOW + 100) })
    const sum = Object.values(record.phases as Record<string, number>).reduce((n, ms) => n + ms, 0)
    expect(sum).toBe(record.ms as number)
    // clock times as ms into the pass: the anchor reading (100) is 10 ms in
    expect(record.actions).toEqual([
      { key: 'claim:1:new', kind: 'claim', status: 'done', queued: 75, started: 80, ended: 100, ms: 20 },
      { key: 'merge:2', kind: 'merge', status: 'skipped', queued: 75, started: null, ended: null, ms: 0 },
    ])
  })

  test('every engine call is recorded in start order: its phase, source, time, exit and bytes; a throw keeps its error', async () => {
    let t = 0
    const tr = newTracer(() => t, 0, NOW)
    begin(tr, 'observe')
    const io: Io = {
      now: async () => NOW,
      run: async argv => {
        t += 5
        if (argv[0] === 'treehouse') throw new Error('timed out')
        return { exitCode: argv[0] === 'git' ? 1 : 0, stdout: 'héllo', stderr: '' }
      },
      readFile: async () => 'abc',
      sessionLimits: async () => [],
      agents: async () => [],
    }
    const traced = tracedIo(tr, io)
    await traced.run(['callum-flow-factory-state', '--repo', 'a/b'], { cwd: '/w', env: {}, timeoutMs: 1 })
    await traced.run(['git', 'status'], { cwd: '/w', env: {}, timeoutMs: 1 })
    await expect(traced.run(['treehouse', 'status', '--json'], { cwd: '/w', env: {}, timeoutMs: 1 })).rejects.toThrow('timed out')
    await traced.readFile('/x/control.json')
    expect(tr.commands).toEqual([
      { phase: 'observe', source: 'factory', cmd: 'callum-flow-factory-state --repo a/b', t: 0, ms: 5, exit: 0, bytes: 6 },
      { phase: 'observe', source: 'checkout', cmd: 'git status', t: 5, ms: 5, exit: 1, bytes: 6 },
      { phase: 'observe', source: 'pool', cmd: 'treehouse status --json', t: 10, ms: 5, exit: null, error: 'timed out' },
      { phase: 'observe', cmd: 'fs.read /x/control.json', t: 15, ms: 0, bytes: 3 },
    ])
  })

  test('the act half: event writes count in eventsMs, the act lock in lockMs, a refused spawn keeps why', async () => {
    let t = 0
    const tr = newTracer(() => t, 0, NOW)
    begin(tr, 'act')
    const run: ActIo['run'] = async () => {
      t += 4
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const io = tracedActIo(tr, {
      now: async () => NOW,
      run,
      spawnAgent: async () => ({ deny: 'no agents here' }),
      stopAgent: async () => ({ stopped: true }),
      submit: async () => undefined,
      rename: async () => undefined,
      usage: async () => ({ fiveHour: null, sevenDay: null }),
      readFile: async () => null,
      writeFile: async () => undefined,
    })
    await io.run(['callum-flow-event', 'loop', '--note', 'x'], { cwd: '/w', env: {}, timeoutMs: 1 })
    await io.run(['callum-flow-claim', '470'], { cwd: '/w', env: {}, timeoutMs: 1 })
    await io.spawnAgent({ subagentType: 'callum-flow:designer', prompt: 'p', description: 'Design #470', name: 'designer-470' })
    await io.submit('JUDGE report id=w1 repo=a/b\ncontext')
    await lockTimed(tr, async () => {
      t += 7
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    expect(tr.eventsMs).toBe(4)
    expect(tr.lockMs).toBe(7)
    expect(tr.commands.map(c => [c.cmd, c.ms, c.exit ?? null, c.error ?? null])).toEqual([
      ['callum-flow-event loop --note x', 4, 0, null],
      ['callum-flow-claim 470', 4, 0, null],
      ['agent.spawn designer-470', 0, null, 'no agents here'],
      ['prompt.submit JUDGE report id=w1 repo=a/b', 0, null, null],
      ['act lock', 7, 0, null],
    ])
    // with trace off, the lock's write is only the write
    expect(await lockTimed(null, async () => ({ exitCode: 3, stdout: '', stderr: '' }))).toEqual({ exitCode: 3, stdout: '', stderr: '' })
  })

  test('sourceOf names the source each observe command reads', () => {
    const cases: [string[], string | undefined][] = [
      [['callum-flow-factory-state', '--repo', 'a/b'], 'factory'],
      [['dev-query', '--csv'], 'facts'],
      [['/tools/pipeline-watch.sh', '--once'], 'runs'],
      [['/tools/queue-watch.sh', '--once'], 'queue'],
      [['callum-flow-issue-read', '--json', '--list', '--label', 'ready'], 'queue'],
      [['callum-flow-issue-read', '--json', '470', '--comments'], 'github'],
      [['/tools/usage-check.sh'], 'usage'],
      [['treehouse', 'status', '--json'], 'pool'],
      [['git', 'symbolic-ref'], 'checkout'],
      [['callum-flow-milestone', 'show', 'next'], 'milestone'],
      [['callum-flow-claim', '470'], undefined],
    ]
    for (const [argv, source] of cases) expect(sourceOf(argv)).toBe(source)
  })
})

describe('waits and wakes', () => {
  const skip = (issue: number | null, rule: string, why: string) => ({ issue, rule, why })
  const planned = (over: Partial<PlanResult> = {}): PlanResult => ({ tier: 'normal', overridden: false, actions: [], skipped: [], title: '', owner: 0, capped: [], atCap: false, ...over })

  test('a skip keeps the time it was first seen while it keeps coming, its words changing or not; one that stops is forgotten', () => {
    const first = waitSince(new Map(), [skip(5, 'M1', 'next guard in 120s'), skip(null, 'G2', 'blind'), skip(6, 'D1', 'tier slow')], NOW)
    const second = waitSince(first, [skip(5, 'M1', 'next guard in 60s'), skip(null, 'G2', 'blind')], NOW + MIN)
    expect([...second]).toEqual([
      ['5:M1', NOW],
      ['null:G2', NOW],
    ])
    expect(waitSince(second, [skip(6, 'D1', 'tier slow')], NOW + 2 * MIN).get('6:D1')).toBe(NOW + 2 * MIN)
  })

  test('each issue waits on its skips, its running entries, or its stage when nothing names it', () => {
    const s = state({ issues: [mine(5, 'in pipeline'), mine(7, 'implementing', { stageSince: NOW - 40 * MIN }), mine(8, 'designing'), issue(9)] })
    const result = planned({
      skipped: [skip(5, 'M1', 'PR #505 waits for its head to move'), skip(5, 'M1', 'a second M1 skip'), skip(null, 'G2', 'blind')],
      actions: [{ kind: 'claim', key: 'claim:8:new', class: 'start', rule: 'D1', reason: 'ready', issue: 8 }],
    })
    const ledger = [entry('implement:7', 'delegate', { issue: 7, rule: 'D4', status: 'running', startedAt: NOW - 30 * MIN, endedAt: null })]
    const since = new Map([['5:M1', NOW - 25 * MIN]])
    expect(waitingRows(s, result, ledger, since)).toEqual([
      { issue: null, stage: null, rule: 'G2', on: 'blind', since: iso(NOW), forMs: 0 },
      { issue: 5, stage: 'in pipeline', rule: 'M1', on: 'PR #505 waits for its head to move', since: iso(NOW - 25 * MIN), forMs: 25 * MIN },
      { issue: 7, stage: 'implementing', rule: 'D4', on: 'implement:7 running', since: iso(NOW - 30 * MIN), forMs: 30 * MIN },
    ])
    // a live issue no rule names and no action touches waits in its stage
    const quiet = waitingRows(s, planned(), [], new Map())
    expect(quiet.find(r => r.issue === 7)).toEqual({ issue: 7, stage: 'implementing', rule: null, on: 'no rule acts on it', since: iso(NOW - 40 * MIN), forMs: 40 * MIN })
    expect(quiet.some(r => r.issue === 9)).toBe(false)
  })

  test('a wake row: open each pass, ended once, with its delivery and answer times', () => {
    const open = entry('judge:a', 'judge', { wake: 'sequence', status: 'running', startedAt: NOW - 3 * MIN, endedAt: null })
    const done = entry('tell:b', 'tell', { wake: 'agent-failed', status: 'done', startedAt: NOW - 2 * MIN, endedAt: NOW - MIN })
    const old = entry('judge:c', 'judge', { wake: 'report', status: 'done', startedAt: NOW - 60 * MIN, endedAt: NOW - 50 * MIN })
    const notWake = entry('claim:9:new', 'claim', { status: 'done' })
    const delivered = new Map([[`tell:b@${NOW - 2 * MIN}`, NOW - 90_000]])
    const first = wakeRows([open, done, old, notWake], delivered, new Set(), NOW - 5 * MIN)
    expect(first.rows).toEqual([
      { key: 'judge:a', wake: 'sequence', status: 'running', queued: iso(NOW - 3 * MIN), delivered: null, ended: null, deliverMs: null, answerMs: null },
      { key: 'tell:b', wake: 'agent-failed', status: 'done', queued: iso(NOW - 2 * MIN), delivered: iso(NOW - 90_000), ended: iso(NOW - MIN), deliverMs: 30_000, answerMs: 30_000 },
    ])
    expect(first.reported).toEqual([`tell:b@${NOW - 2 * MIN}`])
    expect(wakeRows([open, done], delivered, new Set(first.reported), NOW - 5 * MIN).rows.map(r => r.key)).toEqual(['judge:a'])
  })
})

describe('the setting and the op', () => {
  test('trace and traceMaxBytes are repo-local settings, off and 100 MiB by default; bad values are named', () => {
    expect(DEFAULT_CONFIG).toMatchObject({ trace: false, traceMaxBytes: 104_857_600 })
    expect(loadConfig({ trace: true, traceMaxBytes: 1_000 }).config).toMatchObject({ trace: true, traceMaxBytes: 1_000 })
    expect(loadConfig({ trace: 'yes', traceMaxBytes: -1 }).problems).toEqual(['trace: "yes" is not true or false', 'traceMaxBytes: -1 is not a number'])
  })

  test('trace on|off parses, reads back, and writes the workspace file, keeping its other keys', async () => {
    const parsed = parseOp('TRACE On')
    expect(parsed).toEqual({ ok: true, op: { op: 'trace', on: true } })
    if (parsed.ok) expect(formatOp(parsed.op)).toBe('trace on')
    for (const bad of ['trace', 'trace maybe', 'trace on now']) expect(parseOp(bad)).toEqual({ ok: false, error: 'Usage: trace on|off' })

    const files = new Map([[CONFIG_FILE, JSON.stringify({ repo: REPO, mode: 'act' })]])
    const io: FileIo = { readFile: async path => files.get(path) ?? null, writeFile: async (path, text) => void files.set(path, text) }
    const paths = { loopDir: LOOP_DIR, configDir: CFG_DIR }
    expect(await runOp(io, paths, 'trace off', NOW)).toMatchObject({ ok: true, ping: true, logged: 'trace off', mode: null })
    expect(JSON.parse(files.get(CONFIG_FILE) ?? '')).toEqual({ repo: REPO, mode: 'act', trace: false })
    // control.json is not touched; a workspace file that is not a JSON object is left alone
    expect(files.has(`${LOOP_DIR}/control.json`)).toBe(false)
    files.set(CONFIG_FILE, 'trace=on')
    expect(await runOp(io, paths, 'trace on', NOW)).toMatchObject({ ok: false, ping: false, text: 'Not changed: the workspace config file is not valid JSON.' })
    // only the main conversation sets it
    expect(await runOp(io, paths, 'trace on', NOW, { agentId: 'a1' })).toMatchObject({ ok: false, text: 'Not changed: only the main conversation sets owner directives.' })
  })
})
