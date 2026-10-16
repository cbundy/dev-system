// Throwaway spike, never merged: can a mod drive the orchestrator loop in a
// Remote Control session? Every check appends a JSON line to LOG, and the
// session title shows the latest state so it can be followed from the phone.
//
//   1 loaded   session.start fires: a "loaded" line (again after each restart)
//   2 tick     a "tick" line every minute, also while the session sits idle
//   3 title    $.mcp.call sets the session title, with no permission prompt
//   4 handback on request (touch REQUEST), a built-in and a callum-flow agent
//              are spawned at once; two minutes later a "handback-result" line
//              says what reached the main conversation besides the mod's own
//              renames, and how many model turns ran
//   5 restart  after dev-restart-self: a new "loaded" line and ticks resume
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

const LOG = '/persist/claude/spike/log.jsonl'
const TICK_MS = 60_000
const REQUEST = '/persist/claude/spike/handback-test.request'
const TEST_AGENTS = ['Explore', 'callum-flow:explorer']
const TEST_PROMPT = 'Reply with the single word pong. Do not use any tools.'
const REPORT_AFTER_MS = 2 * 60_000

type HandbackTest = {
  startedAt: string
  agents: Record<string, string>
  answers: Record<string, unknown>[]
  mainRows: Record<string, unknown>[]
  mainTurns: number
}

let sessionId: string | undefined
let ticks = 0
let test: HandbackTest | undefined
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

// A session started from claude.ai has the claude-code-remote server; one the
// CLI started (`claude --remote-control`, as orchestrators are) has none, so
// fall back to the built-in /rename, run as if typed.
let titleRoute: 'mcp' | 'rename' = 'mcp'

async function setTitleByMcp($: EngineInterface, title: string) {
  if (sessionId === undefined) {
    const found = await $.mcp.call('claude-code-remote', 'get_session', {})
    sessionId = JSON.parse(textOf(found)).ccr?.id
    if (sessionId === undefined) throw new Error(`no session id: ${textOf(found).slice(0, 200)}`)
  }
  const set = await $.mcp.call('claude-code-remote', 'set_session_title', { session_id: sessionId, title })
  if (set.isError) throw new Error(textOf(set).slice(0, 200))
}

async function setTitle($: EngineInterface, title: string) {
  if (titleRoute === 'mcp') {
    try {
      await setTitleByMcp($, title)
      return 'mcp'
    } catch (err) {
      void log($, 'title', { route: 'mcp', ok: false, error: String(err) })
      titleRoute = 'rename'
    }
  }
  try {
    const result = await $.command.run({ command: 'rename', args: title })
    void log($, 'title', { route: 'rename', ok: true, result })
    return 'rename'
  } catch (err) {
    void log($, 'title', { route: 'rename', ok: false, error: String(err) })
    return false
  }
}

async function tick($: EngineInterface) {
  ticks += 1
  await maybeStartHandbackTest($)
  const tokens = await contextTokens($)
  const titled = await setTitle($, `spike · tick ${ticks} · ${hhmm()} UTC · ctx ${tokens ?? '?'}`)
  void log($, 'tick', { n: ticks, contextTokens: tokens, titled })
}

// Only on request, so a reload never spawns agents by itself.
async function maybeStartHandbackTest($: EngineInterface) {
  if (test !== undefined || !(await $.fs.exists(REQUEST))) return
  await $.process.run(['rm', '-f', REQUEST])
  const run: HandbackTest = { startedAt: new Date().toISOString(), agents: {}, answers: [], mainRows: [], mainTurns: 0 }
  test = run
  const spawned = await Promise.all(
    TEST_AGENTS.map(subagentType =>
      $.agent.spawn({ subagentType, model: 'haiku', description: `handback test: ${subagentType}`, prompt: TEST_PROMPT }),
    ),
  )
  spawned.forEach((result, i) => {
    if (result.agentId !== undefined) run.agents[result.agentId] = TEST_AGENTS[i] ?? '?'
  })
  void log($, 'handback-spawned', { spawned, contextTokens: await contextTokens($) })
  $.clock.after(REPORT_AFTER_MS, () => {
    void (async () => {
      await log($, 'handback-result', { ...run, contextTokens: await contextTokens($) })
      test = undefined
    })()
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void log($, 'loaded', { version: (await $.session.version()).version })
    void setTitle($, `spike · loaded ${hhmm()} UTC`)
    $.clock.every(TICK_MS, () => void tick($))
    return result
  })

  // Every row the main conversation keeps: did the agent's result land there?
  // The note /rename leaves for the model ("The user named this session ...")
  // is blanked, so a title update costs no context.
  on('session.append', async ($, e, next) => {
    const isRenameNote =
      e.door === 'prompt' &&
      e.origin.kind === 'plugin' &&
      JSON.stringify(e.message.content ?? '').includes('named this session')
    const result = await next(isRenameNote ? { ...e, message: { ...e.message, content: [] } } : e)
    const isOwnRename = isRenameNote || e.door === 'command'
    if (test !== undefined && e.agentId === undefined && !isOwnRename) {
      test.mainRows.push({ door: e.door, origin: e.origin.kind, type: e.message.type, name: e.message.name })
    }
    if (e.agentId === undefined) {
      void log($, 'append', {
        door: e.door,
        origin: e.origin.kind,
        type: e.message.type,
        name: e.message.name,
        isMeta: e.message.isMeta,
        chars: JSON.stringify(e.message.content ?? '').length,
        storedChars: JSON.stringify(result.message?.content ?? '').length,
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agentType = e.agentId === undefined ? undefined : test?.agents[e.agentId]
    if (test !== undefined && agentType !== undefined) {
      test.answers.push({ agentType, answer: e.answer.slice(0, 60), durationMs: e.durationMs })
    } else if (e.agentId === undefined) {
      if (test !== undefined) test.mainTurns += 1
      void log($, 'main-turn', { durationMs: e.durationMs, contextTokens: await contextTokens($) })
    }
    return result
  })
}
