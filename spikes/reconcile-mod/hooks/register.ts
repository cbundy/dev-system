// Throwaway spike, never merged: can a mod drive the orchestrator loop in a
// Remote Control session? Every check appends a JSON line to LOG, and the
// session title shows the latest state so it can be followed from the phone.
//
//   1 loaded   session.start fires: a "loaded" line (again after each restart)
//   2 tick     a "tick" line every minute, also while the session sits idle
//   3 title    $.mcp.call sets the session title, with no permission prompt
//   4 agent    an Explore agent spawned a few minutes after start answers; the
//              "append" lines show whether its result entered the main
//              conversation, the "main-turn" lines whether it woke the model
//   5 restart  after dev-restart-self: a new "loaded" line and ticks resume
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

const LOG = '/persist/spike/log.jsonl'
const TICK_MS = 60_000
const AGENT_AFTER_MS = 3 * 60_000

let sessionId: string | undefined
let ticks = 0
let agentId: string | undefined
let contextBefore: number | undefined
let writing: Promise<void> = Promise.resolve()

const hhmm = () => new Date().toISOString().slice(11, 16)

// Serialized, so lines logged from overlapping hooks are never lost.
function log($: EngineInterface, check: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), check, ...fields }) + '\n'
  writing = writing
    .then(async () => {
      const prev = (await $.fs.exists(LOG)) ? String(await $.fs.read(LOG)) : ''
      await $.fs.write(LOG, prev + line)
    })
    .catch(() => undefined)
  return writing
}

const textOf = (result: McpToolResult) =>
  result.content.map(block => ('text' in block ? String(block.text) : '')).join('')

const contextTokens = async ($: EngineInterface) => (await $.session.usage()).context.tokens

async function setTitle($: EngineInterface, title: string) {
  try {
    if (sessionId === undefined) {
      const found = await $.mcp.call('claude-code-remote', 'get_session', {})
      sessionId = JSON.parse(textOf(found)).ccr?.id
      if (sessionId === undefined) throw new Error(`no session id: ${textOf(found).slice(0, 200)}`)
    }
    const set = await $.mcp.call('claude-code-remote', 'set_session_title', { session_id: sessionId, title })
    if (set.isError) throw new Error(textOf(set).slice(0, 200))
    return true
  } catch (err) {
    void log($, 'title', { ok: false, error: String(err) })
    return false
  }
}

async function tick($: EngineInterface) {
  ticks += 1
  const tokens = await contextTokens($)
  const titled = await setTitle($, `spike · tick ${ticks} · ${hhmm()} UTC · ctx ${tokens ?? '?'}`)
  void log($, 'tick', { n: ticks, contextTokens: tokens, titled })
}

async function spawnAgent($: EngineInterface) {
  contextBefore = await contextTokens($)
  const result = await $.agent.spawn({
    subagentType: 'Explore',
    description: 'spike check 4',
    prompt: 'List the top-level files of the repository in the current directory and say in one sentence what it is for.',
  })
  agentId = result.agentId
  void log($, 'agent-spawned', { result, contextBefore })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void log($, 'loaded', { version: (await $.session.version()).version })
    void setTitle($, `spike · loaded ${hhmm()} UTC`)
    $.clock.every(TICK_MS, () => void tick($))
    $.clock.after(AGENT_AFTER_MS, () => void spawnAgent($))
    return result
  })

  // Every row the main conversation keeps: did the agent's result land there?
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      void log($, 'append', {
        door: e.door,
        origin: e.origin.kind,
        type: e.message.type,
        name: e.message.name,
        isMeta: e.message.isMeta,
        chars: JSON.stringify(e.message.content ?? '').length,
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (agentId !== undefined && e.agentId === agentId) {
      void log($, 'agent-answered', {
        answerChars: e.answer.length,
        durationMs: e.durationMs,
        contextBefore,
      })
      void setTitle($, `spike · agent answered ${hhmm()} UTC · ctx before ${contextBefore ?? '?'}`)
    } else if (e.agentId === undefined) {
      void log($, 'main-turn', { durationMs: e.durationMs, contextTokens: await contextTokens($) })
    }
    return result
  })
}
