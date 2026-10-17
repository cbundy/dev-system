// Throwaway spike, never merged: which quiet routes put a loop report in a Remote Control
// conversation (phone) and what does each cost the model's context? See ../../README.md.
//
// A timer runs the /probe-report command (or another route) once between two real turns, in the
// phase named by PHASE_FILE (or DEFAULT_PHASE when the file is absent). Every observation is one
// JSON line in LOG, outside any repository: each session.append row, each turn.start, and
// $.session.usage() before a run and after the next real model turn. The mod never writes to
// GitHub or a repository.
import type { EngineInterface, Register } from 'claude-code'

const LOG = '/persist/claude/spike/loop-report.jsonl'
const PHASE_FILE = '/persist/claude/spike/loop-report.phase'
const DEFAULT_PHASE = 'control' // changed by a git pull, or overridden by PHASE_FILE
const TICK_MS = 60_000
const MARKER = 'PROBE-REPORT'

const PHASES = [
  'control', // no report: two real turns with nothing between them
  'report', // /probe-report through $.command.run, the stored row left as it is
  'report-trim', // the same, with the stored output row blanked by a session.append hook
  'append-user', // $.session.append, type user (the model reads it)
  'append-system', // $.session.append, type system (a notice the model never reads)
  'ui-log', // $.ui.log to the transcript
  'ui-toast', // $.ui.toast
  'ui-status', // $.ui.status
  'ui-notify', // $.ui.notify
] as const
type Phase = (typeof PHASES)[number]

const isPhase = (text: string): text is Phase => (PHASES as readonly string[]).includes(text)

// A sample report in the epic's (#684) shape: an In flight and a Merged table, 10 rows in all.
const IN_FLIGHT: [string, string, string][] = [
  ['#701', 'Add the retry budget to the merge queue', 'review'],
  ['#704', 'Show the lease owner in /factory status', 'build'],
  ['#709', 'Cap the spawn log at 10 MB', 'CI'],
  ['#711', 'Name the stalled gate in the PR body', 'build'],
  ['#715', 'Read the answer file once per pass', 'design'],
]
const MERGED: [string, string, string][] = [
  ['#690', 'Pin the plugin types in the lockfile', '#697'],
  ['#693', 'Give each step its own scratch folder', '#723'],
  ['#696', 'Add a read-only config op', '#722'],
  ['#699', 'Size the test pool from the container', '#725'],
  ['#702', 'Wait on checks with a 60 s interval', '#721'],
]

function sampleReport(now: number): string {
  const stamp = new Date(now).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' })
  const table = (head: string[], rows: string[][]) =>
    [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
  return [
    `**${MARKER}** - ${stamp} (Europe/Amsterdam)`,
    '',
    '### In flight',
    table(['Issue', 'Title', 'Stage'], IN_FLIGHT),
    '',
    '### Merged',
    table(['Issue', 'Title', 'PR'], MERGED),
  ].join('\n')
}

type Pending = { runId: number; phase: Phase; at: string; usageBefore: unknown; turnStarts: number }

let runs = 0
let pending: Pending | undefined
let running: Phase | undefined // set while a run is in flight, so the trim hook knows our own row
let writing: Promise<void> = Promise.resolve()

// Serialized, so lines logged from overlapping hooks are never lost.
function log($: EngineInterface, kind: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), phase: running ?? pending?.phase ?? currentPhase, kind, ...fields }) + '\n'
  writing = writing
    .then(async () => {
      const prev = (await $.fs.exists(LOG)) ? String(await $.fs.read(LOG)) : ''
      await $.fs.write(LOG, prev + line)
    })
    .catch(() => undefined)
  return writing
}

let currentPhase: string = DEFAULT_PHASE

async function readPhase($: EngineInterface): Promise<Phase | 'off'> {
  const text = (await $.fs.exists(PHASE_FILE)) ? String(await $.fs.read(PHASE_FILE)).trim() : DEFAULT_PHASE
  if (text === 'off') return 'off'
  if (isPhase(text)) return text
  void log($, 'bad-phase', { text })
  return 'off'
}

const usageOf = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  return { contextTokens: usage.context.tokens, percent: usage.context.percent, costUsd: usage.cost?.usd }
}

async function deliver($: EngineInterface, phase: Phase, report: string) {
  const block = { type: 'text' as const, text: report }
  switch (phase) {
    case 'control':
      return 'none'
    case 'report':
    case 'report-trim':
      return await $.command.run({ command: 'probe-report' })
    case 'append-user':
      return await $.session.append({ message: { type: 'user', content: [block] } })
    case 'append-system':
      return await $.session.append({ message: { type: 'system', content: [block] } })
    case 'ui-log':
      $.ui.log(report)
      return 'logged'
    case 'ui-toast':
      $.ui.toast(report, { timeoutMs: 20_000 })
      return 'toasted'
    case 'ui-status':
      $.ui.status(report)
      return 'pinned'
    case 'ui-notify':
      return await $.ui.notify(report, { title: 'loop report probe' })
  }
}

async function tick($: EngineInterface) {
  const phase = await readPhase($)
  currentPhase = phase
  if (phase === 'off') return
  if (pending !== undefined) return // one run per gap between two real turns
  runs += 1
  const runId = runs
  const usageBefore = await usageOf($)
  pending = { runId, phase, at: new Date().toISOString(), usageBefore, turnStarts: 0 }
  void log($, 'run-start', { runId, usageBefore })
  running = phase
  try {
    const result = await deliver($, phase, sampleReport(await $.clock.now()))
    void log($, 'run-done', { runId, result })
  } catch (err) {
    void log($, 'run-error', { runId, error: String(err) })
  } finally {
    running = undefined
  }
  void log($, 'run-end', { runId, awaiting: 'next real model turn' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'probe-report', description: 'Probe: print a sample loop report', immediate: true }).catch(() => undefined)
    void log($, 'loaded', { version: (await $.session.version()).version, phases: PHASES, defaultPhase: DEFAULT_PHASE })
    $.clock.every(TICK_MS, () => void tick($))
    return result
  })

  on('command.run', { command: 'probe-report' }, async $ => ({ text: sampleReport(await $.clock.now()) }))

  // Every row the conversation keeps. In the report-trim phase the stored output row of our own
  // run is blanked, as the loop blanks the /rename note, so the report costs the model nothing.
  on('session.append', async ($, e, next) => {
    const chars = JSON.stringify(e.message.content ?? '').length
    const isOurRow = running === 'report-trim' && chars > 0 && JSON.stringify(e.message.content).includes(MARKER)
    const result = await next(isOurRow ? { ...e, message: { ...e.message, content: [] } } : e)
    void log($, 'append', {
      door: e.door,
      origin: e.origin.kind,
      type: e.message.type,
      name: e.message.name,
      chars,
      storedChars: JSON.stringify(result.message?.content ?? '').length,
      trimmed: isOurRow,
      agentId: e.agentId,
      duringRun: running !== undefined,
    })
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && pending !== undefined) pending.turnStarts += 1
    void log($, 'turn-start', { turnId: e.turnId, agentId: e.agentId, text: e.text.slice(0, 60), duringRun: running !== undefined })
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && pending !== undefined) {
      const done = pending
      pending = undefined
      void log($, 'turn-end', {
        runId: done.runId,
        turnId: e.turnId,
        reason: e.reason,
        turnStartsSinceRun: done.turnStarts,
        usageBefore: done.usageBefore,
        usageAfter: await usageOf($),
      })
    }
    return result
  }).catch(($, e, next) => next(e))
}
