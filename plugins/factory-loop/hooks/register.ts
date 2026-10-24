// factory-loop: the issue orchestrator as one code loop (docs/factory-loop/v2/SPEC.md 13).
//
// Every passEveryMs, or at once when pinged, a pass reads the factory (observe.ts) and plans
// (v2/plan.ts). In act mode, once the safety rails pass (rails.ts: the act lock, the role, the old
// watcher, another orchestrator's heartbeat), it runs plan's actions through their executors
// (act.ts) and records each in the ledger (ledger.ts), which it keeps in $.store. In observe mode
// (the default), or while a rail holds act mode back, it executes nothing and every command's
// event writes go to a sink (v2 SPEC 13.11.1). Each pass appends one decision-log line and sets the
// session title. The driver is this module and the driver-*.ts modules under it, the only ones
// that hold $: this one wires the hooks; driver-state.ts holds the state they share (one holder,
// `S`), driver-io.ts builds the engine calls, driver-store.ts keeps the ledger in $.store,
// driver-pass.ts schedules and runs a pass (driver-pass-log.ts its trace), driver-between.ts feeds
// the ledger between passes (agents' answers and their repair messages; wake turns) and
// driver-controls.ts holds the owner's controls (/factory, the control and answer tools) and
// ensure. The loop's own agent types (agents/) are kept from the model here. v2's records and the PR
// heads it has seen live in the store beside the ledger (records:<repo>, heads:<repo>).
import type { Register } from 'claude-code'

import { agentTurnEnded, hook, mainTurnEnded, releaseLock, turnStarted } from './driver-between'
import type { TurnEnded } from './driver-between'
import { answer, ensure, ownerOp, toolInput } from './driver-controls'
import { S, resuming } from './driver-state'
import type { Options } from './driver-state'
import { issueFromBranch } from './foundation'
import { INTAKE_AGENT } from './v2/intake'
import { STEP_AGENT } from './v2/types'
import { BASH_TIMEOUT_MS } from './v2/workspace'

export const register: Register = (on, opts) => {
  S.options = opts as Options

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // the 10-minute Bash timeout for every agent the loop starts (v2 SPEC 10.5)
    await $.env.set('BASH_DEFAULT_TIMEOUT_MS', BASH_TIMEOUT_MS).catch(() => undefined)
    await $.env.set('BASH_MAX_TIMEOUT_MS', BASH_TIMEOUT_MS).catch(() => undefined)
    S.cwd = e.cwd
    if (!e.isInteractive) S.headless = true
    else await ensure($)
    return result
  })

  // The note /rename leaves for the model is blanked as it is stored, so a title costs the
  // conversation about 3 tokens (FINDINGS check 3). Any row also starts the loop if needed.
  on('session.append', async ($, e, next) => {
    if (!S.headless) void ensure($)
    const isRenameNote =
      e.door === 'prompt' && e.origin.kind === 'plugin' && JSON.stringify(e.message.content ?? '').includes('named this session')
    return next(isRenameNote ? { ...e, message: { ...e.message, content: [] } } : e)
  }).catch(($, e, next) => next(e))

  // Turns feed the ledger after they are answered; what any turn returns is never changed.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    await hook(() => turnStarted($, e.text, e.turnId))
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const ended: TurnEnded = { turnId: e.turnId, answer: e.answer, reason: e.reason }
    const agentId = e.agentId
    await hook(() => (agentId === undefined ? mainTurnEnded($, ended) : agentTurnEnded($, { ...ended, agentId })))
    return result
  }).catch(($, e, next) => next(e))

  // session.end has one short bound for every hook: the lease goes first
  on('session.end', async ($, e, next) => {
    await releaseLock($, e.sessionId).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /factory <op>: the owner's controls from any client (v2 SPEC 13.4.3)
  on('command.run', { command: 'factory' }, async ($, e) => ({ text: (await ownerOp($, e.args, undefined, 'person')).text })).catch(() => ({
    text: 'factory-loop: the op could not run; nothing was changed.',
  }))

  on('tool.call', { tool: 'mcp__factory-loop__control' }, async ($, e) => {
    const r = await ownerOp($, toolInput(e), e.agentId, 'judge')
    return r.ok ? { result: r.text } : { deny: r.text }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'factory-loop: the op could not run; nothing was changed.' }))

  on('tool.call', { tool: 'mcp__factory-loop__answer' }, async ($, e) => {
    const r = await answer($, toolInput(e), e.agentId)
    return r.ok ? { result: r.text } : { deny: r.text }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'factory-loop: the answer could not be recorded.' }))

  // the loop's own agent types (agents/) are its spawns alone: the model is
  // never offered them, so it keeps to the callum-flow agents it knows. The engine asks too when a
  // message resumes an agent, and resumes none of a type it does not offer: while the loop's own
  // repair message to one is on its way (repairTo), its type is offered (#559)
  // the loop's agent types (v2/types.ts STEP_AGENT and the intake agent), hidden as above
  for (const agent of new Set([...Object.values(STEP_AGENT), INTAKE_AGENT])) {
    on('agent.offer', { agent }, ($, e, next) => (resuming.has(e.agent) ? next(e) : { isOffered: false })).catch(($, e, next) => (next.called ? next(e) : { isOffered: false }))
  }
}

// for the tests
export const testing = { issueFromBranch }
