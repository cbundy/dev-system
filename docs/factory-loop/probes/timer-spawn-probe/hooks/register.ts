// Throwaway probe for the factory loop (docs/factory-loop/SPEC.md 13, #560, #561): can an agent
// that a mod spawns with $.agent.spawn call that mod's own tool? The loop's passes run from its
// timer, so its agents are spawned from a $.clock callback; on Claude Code 2.1.296 and 2.1.299
// such an agent's call fails in milliseconds with "<plugin> registered the tool ... but no
// tool.call hook answered this call" and the hook never runs, while the same spawn made inside a
// command.run hook works. That is why the loop's agents answer through the checked answer script
// (config answerChannel `script`, a temporary workaround) and not through the registered answer
// tools (`tool`, the intended design).
//
// Run it on each Claude Code upgrade, in a throwaway session:
//
//   claude --plugin-dir docs/factory-loop/probes/timer-spawn-probe
//   /timer-spawn-probe
//
// It spawns one agent inside the command's own hook (`hook`, the control) and one from a
// $.clock.after callback (`timer`, the loop's case); each loads the probe's tool with ToolSearch,
// calls it and replies with its result. Every observation is one JSON line in
// ${CLAUDE_CONFIG_DIR:-~/.claude}/timer-spawn-probe/log.jsonl: `spawned` per case, `called` when
// the tool hook runs (with the caller's agentId), and `answered` with each agent's reply.
// answerChannel can go back to `tool` once the timer agent's reply is `pong` and its `called`
// line is there. On 2.1.299 (2026-10-14) the timer agent replied with the engine's refusal above,
// and no `called` line came.
import type { EngineInterface, Register } from 'claude-code'

const ASK = 'Use ToolSearch with query select:mcp__timer-spawn-probe__ping, then call mcp__timer-spawn-probe__ping with {} and reply with the exact tool result text only.'
const cases = new Map<string, string>()

async function log($: EngineInterface, check: string, fields: Record<string, unknown> = {}) {
  const dir = `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`}/timer-spawn-probe`
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), check, ...fields }) + '\n'
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${dir}/log.jsonl`], { stdin: line, timeoutMs: 10_000 }).catch(() => undefined)
}

async function spawn($: EngineInterface, via: 'hook' | 'timer') {
  const r = await $.agent.spawn({ subagentType: 'timer-spawn-probe:pinger', description: `ping probe (${via})`, prompt: ASK })
  if (r.agentId !== undefined) cases.set(r.agentId, via)
  await log($, 'spawned', { via, agentId: r.agentId ?? null, deny: r.deny ?? null })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({ name: 'ping', description: 'Answers pong. Call it when asked.', inputSchema: { type: 'object', properties: {} } })
    await $.command.register({ name: 'timer-spawn-probe', description: 'spawn one agent from this hook and one from a timer; each calls the probe tool' })
    return r
  })

  on('tool.call', { tool: 'mcp__timer-spawn-probe__ping' }, async ($, e) => {
    await log($, 'called', { agentId: e.agentId ?? null, via: e.agentId === undefined ? null : (cases.get(e.agentId) ?? 'unknown') })
    return { result: 'pong' }
  }).catch(() => ({ deny: 'timer-spawn-probe: the hook failed' }))

  on('command.run', { command: 'timer-spawn-probe' }, async $ => {
    await spawn($, 'hook')
    $.clock.after(500, () => void spawn($, 'timer').catch(err => log($, 'spawned', { via: 'timer', error: String(err) })))
    return { text: 'timer-spawn-probe: one agent spawned from this hook, one from a timer; see log.jsonl' }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined && cases.has(e.agentId)) await log($, 'answered', { via: cases.get(e.agentId), agentId: e.agentId, answer: e.answer.slice(0, 500) })
    return r
  }).catch(($, e, next) => next(e))
}
