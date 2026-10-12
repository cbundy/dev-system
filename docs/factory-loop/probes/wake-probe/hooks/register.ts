// Throwaway probe for the factory loop (docs/factory-loop/SPEC.md 8.4): in the orchestrators'
// launch mode, can a mod wake the main model with one fixed line, hand it hidden context, and
// get a typed answer back through a tool it registers? Runs only on request
// (touch REQUEST), and writes one JSON line per observation to LOG:
//
//   A  tool answer   JUDGE line + hidden context word; the model answers through
//                    mcp__wake-probe__answer with the word as its reason
//   B  text answer   JUDGE line asking for a bare "ANSWER w2 ok" line and no tools
//
// For each: did a turn start and end, did the answer arrive and match, what did the main
// conversation keep (session.append rows), and what did it cost (context tokens, usage).
// It also tries the decision log's append path: one `sh -c 'cat >> file'` per line.
import type { EngineInterface, Register } from 'claude-code'

const DIR = '/persist/claude/loop/wake-probe'
const LOG = `${DIR}/log.jsonl`
const REQUEST = `${DIR}/run.request`
const WORD = 'heron'
const POLL_MS = 10_000
const B_AFTER_MS = 60_000

type Phase = { id: string; startedAt: number; contextBefore: number | null; rows: Record<string, unknown>[] }

let current: Phase | undefined
let busy = false

async function log($: EngineInterface, check: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), check, ...fields }) + '\n'
  try {
    await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', LOG], { stdin: line, timeoutMs: 10_000 })
  } catch {
    // a lost line is the probe's own problem, never the session's
  }
}

// listed: the tools the model can call now whose name names the probe.
const listed = async ($: EngineInterface) =>
  (await $.tool.list()).filter(t => t.name.includes('wake')).map(t => ({ name: t.name, mcp: t.mcp }))

const contextTokens = async ($: EngineInterface) => (await $.session.usage()).context.tokens ?? null

async function start($: EngineInterface, id: string, text: string) {
  current = { id, startedAt: await $.clock.now(), contextBefore: await contextTokens($), rows: [] }
  await log($, 'submit', { id, text, contextBefore: current.contextBefore, listed: await listed($) })
  const result = await $.prompt.submit({ text })
  await log($, 'submitted', { id, entered: 'drop' in result ? `dropped: ${String(result.drop)}` : (result.text ?? '').slice(0, 200) })
}

async function poll($: EngineInterface) {
  if (busy || current !== undefined || !(await $.fs.exists(REQUEST))) return
  busy = true
  try {
    await $.process.run(['rm', '-f', REQUEST])
    await start(
      $,
      'w1',
      'JUDGE wake-test id=w1 key=probe-a (a test of the factory loop judgment wake: call the ' +
        'mcp__wake-probe__answer tool once with id "w1", decision "ok" and, as reason, the word ' +
        'the hidden context names; use no other tool and end your turn)',
    )
  } finally {
    busy = false
  }
}

// ensure: start once per module load, from whichever hook fires first. session.start does
// not fire for a plugin a /reload-plugins adds to a running session, so every hook calls it.
let started: Promise<void> | undefined
function ensure($: EngineInterface) {
  started ??= init($).catch(() => {
    started = undefined
  })
  return started
}

async function init($: EngineInterface) {
  const { tool } = await $.tool.register({
    name: 'answer',
    description: 'Answer a JUDGE line from the factory loop: the line id, a decision, and a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        decision: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id', 'decision'],
    },
    isDeferred: false,
  })
  await log($, 'loaded', { version: (await $.session.version()).version, tool, listed: await listed($) })
  $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await ensure($)
    return result
  })

  // The hidden context rides beside the probe's own prompt only.
  on('prompt.submit', async ($, e, next) => {
    await log($, 'prompt-hook', { origin: e.origin, phase: current?.id ?? null, context: e.context?.length ?? 0 })
    if (e.origin.kind !== 'plugin' || current?.id !== 'w1') return next(e)
    const context = [...(e.context ?? []), `wake-probe hidden context: the word is "${WORD}".`]
    const result = await next({ ...e, context })
    await log($, 'prompt-hook-result', { context: 'context' in result ? (result.context?.length ?? 0) : 'dropped' })
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__wake-probe__answer' }, async ($, e) => {
    const input = e as unknown as { id?: string; decision?: string; reason?: string }
    await log($, 'answer-tool', {
      id: input.id,
      decision: input.decision,
      reason: input.reason,
      wordMatched: typeof input.reason === 'string' && input.reason.toLowerCase().includes(WORD),
    })
    return { result: `recorded ${input.id ?? '?'}` }
  }).catch(() => ({ result: 'recorded' }))

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    void ensure($)
    if (current !== undefined && e.agentId === undefined) {
      current.rows.push({
        door: e.door,
        origin: e.origin.kind,
        type: e.message.type,
        name: e.message.name,
        chars: JSON.stringify(e.message.content ?? '').length,
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || current === undefined) return result
    const phase = current
    const answer = e.answer
    await log($, 'turn', {
      id: phase.id,
      reason: e.reason,
      durationMs: e.durationMs,
      sinceSubmitMs: (await $.clock.now()) - phase.startedAt,
      answer: answer.slice(0, 400),
      textAnswer: answer.match(/^ANSWER (\S+) (\S+)/m)?.slice(1) ?? null,
      usage: e.usage ?? null,
      contextBefore: phase.contextBefore,
      contextAfter: await contextTokens($),
      rows: phase.rows,
    })
    current = undefined
    if (phase.id === 'w1') {
      $.clock.after(B_AFTER_MS, () =>
        void start($, 'w2', 'JUDGE wake-test id=w2 key=probe-b (reply with exactly one line, ANSWER w2 ok, and use no tools)').catch(
          () => undefined,
        ),
      )
    }
    return result
  })
}
