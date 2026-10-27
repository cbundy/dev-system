// The owner's controls (v2 SPEC 13.4.3, D-38): /factory, the control tool and the answer tool, and
// ensure, which starts the driver once per module load.
import type { EngineInterface } from 'claude-code'

import { commandOf } from './act'
import type { ActEnv } from './act'
import { retried, wakeAnswered } from './act-between'
import type { Claim } from './act-between'
import { DEFAULT_CONFIG } from './config'
import { viewOf } from './config-view'
import { CONTROL_TOOL, FACTORY_COMMAND, controlTool, issuesOf, retryText, runOp } from './control'
import type { FileIo } from './control'
import { armSummary } from './pass-summary'
import { logOwnerOp } from './v2/act-events'
import { opLanded, parkedOf } from './v2/ops'
import { noteWritten, notingIo } from './v2/store'
import { restartCheck } from './update-check'
import { ANSWER_TOOL } from './wake'
import { actIo, acting, configDir, fileIo, killed, runtime, v2StoreIo } from './driver-io'
import { hookEnv, noteConfigOp, persist } from './driver-store'
import { rearm, request } from './driver-pass'
import { startStamp, stampJob } from './driver-stamp'
import { afterwards, bounded, held, hook, kept, later, lateDrop } from './driver-between'
import type { OpAnswer } from './driver-between'
import { FIRST_PASS_AFTER_MS, S, live, liveV2 } from './driver-state'

// the last pass's summary (types/index.d.ts): the engine's validator reads a state reference only
// when it is a literal const of the file that uses it, so driver-pass.ts spells the same one
const lastPassRef = { plugin: 'factory-loop', key: 'lastPass' } as const

export const OP_LATE: OpAnswer = { ok: false, text: 'factory-loop: the op could not run in time; nothing was changed.' }

export const OP_UNSURE: OpAnswer = { ok: false, text: 'factory-loop: the op was still being written when it had to answer; /factory status shows whether it took.' }

// ownerOp: /factory <op> and the control tool, one at a time (control.json is read, changed and
// written whole), answered within TOOL_ANSWER_MS (bounded, #558): the queue holds file reads and
// writes alone, and an op answered late writes nothing. A change pings the loop and gets its own
// decision-log line once it has its answer; retry clears the issue's exhausted entries in the
// live ledger at once. An op that landed with the loop acting before or after it is an intervention of the
// op's origin, person or judge (act-events.ts), and its writes the loop's (7.2).
export function ownerOp($: EngineInterface, input: string | Record<string, unknown>, agentId: string | undefined, by: 'person' | 'judge'): Promise<OpAnswer> {
  const work = (claim: Claim) => {
    const run = S.ops.then(async (): Promise<OpAnswer> => {
      const rt = S.lastRt ?? (await runtime($))
      const paths = { loopDir: rt.loopDir, configDir: await configDir($) }
      const now = await $.clock.now()
      const last = (await $.state.get(lastPassRef)).value ?? null
      const parked = parkedOf(S.lastState?.v2?.records)
      const view = viewOf(rt, S.lastState?.v2?.interventions.gates)
      const check = () => restartCheck((argv, opts) => $.process.run(argv, opts))
      const from = agentId === undefined ? { last, parked, view, restartCheck: check } : { last, agentId, parked, view, restartCheck: check }
      const fio = notingIo(claimedIo(fileIo($), claim), noteWritten(liveV2, v2StoreIo($), rt))
      const reply = typeof input === 'string' ? await runOp(fio, paths, input, now, from) : await controlTool(fio, paths, input, now, from)
      let said = reply.text
      if (reply.retryIssue !== null) said = await retry($, reply.retryIssue, claim)
      // a dry-run stamp answers at once and runs in the background (driver-stamp.ts); a late answer starts nothing
      if (reply.ok && reply.op?.op === 'stamp') said = claim() ? startStamp(rt, reply.op.issue, now) : OP_LATE.text
      // a setting a config op changed: the next pass's settings diff says who changed it (rule N1)
      if (reply.logged !== null && reply.op?.op === 'config' && reply.op.change !== undefined && claim()) await noteConfigOp($, rt.repo, reply.op.change.key, by, now)
      const landed = reply.op === null ? null : opLanded({ mode: rt.mode }, reply.op, reply.logged, issuesOf(reply.op), now, by)
      const logOp = landed === null ? undefined : (env: ActEnv) => logOwnerOp(env, landed)
      const line = (problems: string[]) => ({ control: reply.logged, by, text: said, problems: problems.length > 0 ? problems : undefined })
      if (reply.ping && claim()) later($, { rt, run: logOp, line, ping: `${by === 'judge' ? 'judge' : 'owner'} ${reply.logged ?? ''}` })
      // a refused update: a decision-log line and, in act mode, an intervention; no ping
      if (reply.noted != null && claim()) {
        const refusal = opLanded({ mode: rt.mode }, { op: 'update', reason: null }, reply.noted, [], now, by)
        later($, { rt, run: refusal === null ? undefined : (env: ActEnv) => logOwnerOp(env, refusal), line: problems => ({ control: reply.noted, by, text: said, problems: problems.length > 0 ? problems : undefined }) })
      }
      return { ok: reply.ok, text: said }
    })
    S.ops = run.catch(() => undefined)
    return run
  }
  return bounded($, work, OP_LATE, OP_UNSURE)
}

// claimedIo: file writes that go ahead only once the op claims its change (bounded), so an op
// answered late writes nothing.
export function claimedIo(io: FileIo, claim: Claim): FileIo {
  return { readFile: io.readFile, writeFile: (path, body) => (claim() ? io.writeFile(path, body) : Promise.reject(new Error('the op ran out of time'))) }
}

// retry: `/factory retry <N>` in the live ledger (act.ts retried): cleared at once, saved and
// logged once the op has its answer (#558).
export async function retry($: EngineInterface, issue: number, claim: Claim): Promise<string> {
  const rt = await held($)
  if (rt === 'none') return `Retry #${issue}: this session holds no ledger (act mode keeps one), so nothing was cleared.`
  if (rt === 'loading') return `Retry #${issue}: the ledger is not loaded yet (the next pass loads it), so nothing was cleared.`
  if (!claim()) return OP_LATE.text
  const r = retried({ live, rt }, issue)
  later($, { rt, run: kept(r.moved) })
  return retryText(issue, r.cleared)
}

export const NO_WAKE: OpAnswer = { ok: false, text: 'Not recorded: no wake of the factory loop is open in this session.' }

export const WAKE_LOADING: OpAnswer = { ok: false, text: 'Not recorded: the factory loop has not loaded its ledger yet; give the ANSWER block in your reply instead.' }

export const WAKE_LATE: OpAnswer = { ok: false, text: 'Not recorded: the factory loop could not check this answer in time; give the ANSWER block in your reply instead.' }

// answer: mcp__factory-loop__answer (act.ts wakeAnswered), answered at once from the ledger in
// memory (#558); the ledger saved, the wake's loop event and the ping follow once it has its
// answer.
export function answer($: EngineInterface, input: Record<string, unknown>, agentId: string | undefined): Promise<OpAnswer> {
  const work = async (claim: Claim): Promise<OpAnswer> => {
    const rt = await held($)
    if (rt === 'none') return NO_WAKE
    if (rt === 'loading') return WAKE_LOADING
    const r = await wakeAnswered(hookEnv($, rt, await $.clock.now()), input, agentId, claim)
    if (r.moved.length > 0) later($, { rt, run: kept(r.moved), ping: `wake ${typeof input.id === 'string' ? input.id : '?'}` })
    return { ok: r.ok, text: r.text }
  }
  return bounded($, work, WAKE_LATE)
}

// toolInput: a tool call's own arguments, without the envelope the engine adds.
export function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...input } = e
  return input
}

export async function registerControls($: EngineInterface) {
  // the command's name is written out, so the validator reads its hook as one that answers its
  // own command
  const command = () =>
    $.command.register({ name: 'factory', description: FACTORY_COMMAND.description, argumentHint: FACTORY_COMMAND.argumentHint, immediate: FACTORY_COMMAND.immediate })
  for (const register of [command, () => $.tool.register(CONTROL_TOOL), () => $.tool.register(ANSWER_TOOL)]) {
    try {
      await register()
    } catch {
      // a host without the noun: the loop runs, the owner uses control.json
    }
  }
}

// ensure: start once per module load, from whichever hook fires first. session.start does not
// fire for a plugin a /reload-plugins adds to a running session (the wake probe saw it).
export function ensure($: EngineInterface) {
  S.started ??= (async () => {
    S.loadedAt = await $.clock.now()
    S.lateDrop = (prompt, why) => void lateDrop($, prompt, why)
    S.ask = (source, why) => void request($, source, why).catch(() => undefined)
    S.background = after => void hook(() => afterwards($, after))
    S.saveNow = rt => void persist($, rt)
    // not in the hook queue: a spawn that hangs (up to SPAWN_TIMEOUT_MS) must not hold the turn ends behind it
    S.stampJob = (rt, run) => void stampJob($, rt, run)
    await registerControls($)
    // the first pass after a load: a session start or a reload
    $.clock.after(FIRST_PASS_AFTER_MS, () => void request($, 'timer', 'first').catch(() => undefined))
    rearm($, DEFAULT_CONFIG.passEveryMs)
    armSummary($, { rt: () => S.lastRt, killed: () => killed($), loadedAt: () => S.loadedAt, send: (rt, argv) => commandOf(actIo($), acting(rt), [])(argv, { timeoutMs: 60_000 }), run: (rt, argv, init) => commandOf(actIo($), acting(rt), [])(argv, init) })
  })().catch(() => {
    S.started = undefined
  })
  return S.started
}
