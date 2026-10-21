// Between passes: the hooks that feed the ledger (agents' answers and their repair messages, wake
// turns), the queue they run in, and the bound a tool hook answers within (#558).
import type { EngineInterface } from 'claude-code'

import { logLoop, transition } from './act'
import type { ActEnv } from './act'
import { completeOff } from './act-off'
import type { OffDone } from './act-off'
import { agentAnswered, keep, wakeEnded, wakeStarted } from './act-between'
import type { Answered, Claim, Repair } from './act-between'
import type { Runtime } from './observe'
import { actLockPath, releaseActLock } from './rails'
import { attemptOf } from './trace'
import type { LedgerEntry } from './types'
import { within } from './within'
import { appendLine, killed, lockIo, lockOp, mayWrite, message, runtime } from './driver-io'
import { bareState, ensureLedger, hookEnv, persist } from './driver-store'
import { REPAIR_TIMEOUT_MS, S, TOOL_ANSWER_MS, between, delivered, live, ping, resuming } from './driver-state'
import type { After } from './driver-state'

// hook: hook work that reads and changes the ledger, one at a time and in the order the events
// came (a wake's turn.start before its turn.complete). A tool call never waits here: it changes
// the ledger in memory at once and leaves the rest to this queue (later, #558).
export function hook(work: () => Promise<void>): Promise<void> {
  const run = S.hooking.then(work)
  S.hooking = run.catch(() => undefined)
  return S.hooking
}

// ledgerFor: the runtime a hook works with, while the loop is in act mode with no kill switch
// (v2 SPEC 13.11.1, 13.11.3: observe and off log no real event and keep no ledger), once the ledger is
// loaded: by this module already, or now (an answer that comes before the first pass after a
// reload).
export async function ledgerFor($: EngineInterface): Promise<Runtime | null> {
  if (S.headless) return null
  const rt = S.lastRt ?? (await runtime($).catch(() => null))
  if (rt === null || rt.repo === '' || rt.mode !== 'act' || (await killed($))) return null
  if (live.loaded && live.repo === rt.repo) return rt
  return (await ensureLedger($, rt, [])) ? rt : null
}

// held: the runtime a tool call is decided against, from memory alone (#558): the last pass's,
// in act mode with no kill switch, with its ledger loaded. 'none': this session keeps no ledger
// (observe, off, the kill switch, a session no person reaches); 'loading': it has not loaded one
// yet (no pass since this module loaded, the store unread, the act lock another session's).
// Nothing is loaded here, so a call never waits on ensureLedger.
export async function held($: EngineInterface): Promise<Runtime | 'none' | 'loading'> {
  if (S.headless) return 'none'
  const rt = S.lastRt
  if (rt === null) return 'loading'
  if (rt.repo === '' || rt.mode !== 'act' || (await killed($))) return 'none'
  return live.loaded && live.repo === rt.repo ? rt : 'loading'
}

// later: what a tool call leaves for once it has answered, in the hook queue behind the hook work
// before it, with the $ the loop's timers run with (background), never the call's own, whose
// dispatch has ended by then. A call that changed the ledger has it saved at once, outside the
// hook queue (persist keeps its own order), so a reload or a crash before its turn in the queue
// never loses it: its entry would be marked lost and its work redone.
export function later($: EngineInterface, after: After) {
  if (after.run !== undefined) {
    if (S.saveNow !== null) S.saveNow(after.rt)
    else void persist($, after.rt)
  }
  if (S.background !== null) S.background(after)
  else void hook(() => afterwards($, after))
}

// afterwards: one After, in the hook queue.
export async function afterwards($: EngineInterface, after: After) {
  const env = hookEnv($, after.rt, await $.clock.now())
  const notes = after.run === undefined ? [] : await after.run(env)
  if (after.line !== undefined) await appendLine($, after.rt, after.line([...notes, ...env.problems]))
  if (after.ping !== undefined) ping(after.ping)
}

// offPassDone: an off-pass command ended (act-off.ts): its completion runs in the hook queue, never in a
// pass. It changes nothing and writes nothing unless this session still holds the loaded ledger and the
// act lock; a completion for an attempt that already ended is dropped. One decision-log line names it,
// the trace gets its row, a rate limit is left for the next pass's backoff, and a pass is pinged.
export function offPassDone($: EngineInterface, rt: Runtime, done: OffDone): Promise<void> {
  return hook(async () => {
    let applied = false
    if (live.loaded && live.repo === rt.repo) {
      if (await mayWrite($, rt)) applied = await completeOff(hookEnv($, rt, await $.clock.now()), done)
      else live.loaded = false
    }
    const failed = done.exec.status === 'failed'
    const cli = done.exec.status === 'done' ? 0 : done.exec.status === 'failed' && done.exec.outcome?.kind === 'cli' ? done.exec.outcome.exit : -1
    S.offFinished.push({ cmd: done.kind, key: done.key, ms: Math.round(done.ms * 10) / 10, exit: cli, endedAt: new Date(done.endedAt).toISOString() })
    S.offFinished.splice(0, S.offFinished.length - 100)
    if (applied && failed && done.exec.rateLimited === true) S.offRateLimited = true
    await appendLine($, rt, { offPass: { key: done.key, kind: done.kind, status: done.exec.status, ms: Math.round(done.ms), summary: done.exec.summary, ...(applied ? {} : { dropped: true }) } })
    ping(`off-pass ${done.key}`)
  }).catch(() => undefined)
}

// kept: an After's ledger work for a transition a hook made at once: saved, then logged.
export function kept(moved: readonly LedgerEntry[]) {
  return async (env: ActEnv): Promise<string[]> => {
    await keep(env, moved)
    return []
  }
}

// bounded: a tool hook's answer, from work that decides it, within TOOL_ANSWER_MS on $.clock
// (#558); past it, `late`. The work calls claim() just before it changes anything, and changes
// nothing when it returns false: the bound has passed, so a call answered late changed nothing. A
// claimed call still unanswered at the bound (a write that hangs) answers `unsure`.
export function bounded($: EngineInterface, work: (claim: Claim) => Promise<OpAnswer>, late: OpAnswer, unsure: OpAnswer = late): Promise<OpAnswer> {
  let at: 'open' | 'claimed' | 'late' = 'open'
  const claim = () => {
    if (at === 'open') at = 'claimed'
    return at === 'claimed'
  }
  return new Promise<OpAnswer>((resolve, reject) => {
    const t = $.clock.after(TOOL_ANSWER_MS, () => {
      if (at === 'open') at = 'late'
      resolve(at === 'late' ? late : unsure)
    })
    work(claim).then(
      r => {
        t.cancel()
        resolve(r)
      },
      err => {
        t.cancel()
        reject(err)
      },
    )
  })
}

// actsNow: the loop may start something (a reminder): act mode, no kill switch, and no restart
// asked for without a wind-down request (with one the loop keeps acting in wind-down).
export async function actsNow($: EngineInterface, rt: Runtime): Promise<boolean> {
  return rt.mode === 'act' && (S.restartAsked === null || S.restartRequestAt !== null) && !(await killed($))
}

// turn.start: a wake's own turn takes its turn id.
export async function turnStarted($: EngineInterface, said: string, turnId: string) {
  if (!/^(JUDGE|TASK|TELL) /m.test(said)) return
  const rt = await ledgerFor($)
  if (rt === null) return
  const now = await $.clock.now()
  if (!(await wakeStarted(hookEnv($, rt, now), said, turnId))) return
  // when each wake's turn first started, for its trace row (#552)
  for (const e of live.ledger) if (e.turnId === turnId && !delivered.has(attemptOf(e))) delivered.set(attemptOf(e), now)
}

export type TurnEnded = { turnId: string; answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }

// turn.complete of the main loop: answers close their wakes, a tell's turn delivers it, and an
// unanswered wake gets its one reminder (act.ts wakeEnded); then a ping.
export async function mainTurnEnded($: EngineInterface, e: TurnEnded) {
  const rt = await ledgerFor($)
  if (rt === null) return
  const env = hookEnv($, rt, await $.clock.now())
  const out = await wakeEnded(env, e)
  // never awaited here: a submitted prompt resolves once its turn starts, after this one ends
  if (out.prompts.length > 0 && (await actsNow($, rt))) {
    for (const p of out.prompts) void env.io.submit(p).catch(err => appendLine($, rt, { turn: e.turnId, problems: [`reminder not sent: ${message(err)}`] }))
  }
  const problems = [...out.problems, ...env.problems]
  if (problems.length > 0) await appendLine($, rt, { turn: e.turnId, problems })
  if (out.moved) {
    const ids = live.ledger.flatMap(x => (x.turnId === e.turnId && x.wakeId !== undefined ? [x.wakeId] : []))
    ping(ids.length > 0 ? `wake ${ids.join(' ')}` : `turn ${e.turnId}`)
  }
}

// turn.complete of an agent of the loop: its answer recorded (act-between.ts agentAnswered), then a ping.
// An unreadable one first gets its one repair message, while the loop may start things (#548). The
// decision log says which path each answer took (answerLine).
export async function agentTurnEnded($: EngineInterface, e: TurnEnded & { agentId: string }) {
  const rt = await ledgerFor($)
  if (rt === null) return
  const now = await $.clock.now()
  const env = hookEnv($, rt, now)
  const repair: Repair = (await actsNow($, rt)) ? (id, text, type) => repairTo($, id, text, type) : async () => 'the loop starts nothing until its restart'
  const r = await agentAnswered(env, S.lastState ?? bareState(rt, now), { agentId: e.agentId, answer: e.answer, reason: e.reason }, between, repair)
  const why = r.why === undefined || r.result === 'repair' ? [] : [r.result === 'dropped' ? `${r.why}: dropped` : r.why]
  const problems = [...why, ...env.problems]
  const path = answerLine(r)
  if (path !== null || problems.length > 0) await appendLine($, rt, { agent: e.agentId, ...path, problems: problems.length > 0 ? problems : undefined })
  if (r.result === 'applied') ping(`agent ${e.agentId}`)
}

// answerLine: the path an agent's answer at its turn's end took, for its decision-log line: read
// from the file it recorded with the answer script ('script', #561), with how its entry ended, or
// asked again ('repair', with why), or held for its stop gate line ('held'); afterRepair marks an answer that came after the repair
// message, and repairRefused is why one was not delivered, whole (#559).
export function answerLine(r: Answered): Record<string, unknown> | null {
  if (r.key === undefined) return null
  if (r.result === 'repair') return { key: r.key, answer: 'repair', why: r.why }
  if (r.result === 'held') return { key: r.key, answer: 'held', why: 'its stop gate line is not in the companion log yet' }
  if (r.result !== 'applied') return null
  const e = live.ledger.find(x => x.key === r.key)
  return {
    key: r.key,
    answer: 'script',
    status: e?.status,
    summary: e?.summary,
    afterRepair: r.repaired === true ? true : undefined,
    repairRefused: r.undelivered,
  }
}

// repairTo: the one repair message to an agent of the loop, which resumes it with its transcript
// once its turn has ended (#548); null once queued, else why not. The engine resumes an agent only
// as a type it offers the model, and the loop hides its own (agent.offer below), so the agent's
// type is offered while the message is on its way: hidden, the engine refused every repair of
// testbed run 3 ("is not offered in this session", #559).
export async function repairTo($: EngineInterface, agentId: string, text: string, type: `${string}:${string}`): Promise<string | null> {
  const subagent = type
  resuming.set(subagent, (resuming.get(subagent) ?? 0) + 1)
  try {
    const r = await within($, REPAIR_TIMEOUT_MS, $.session.send({ to: { agentId }, text }), 'repair message')
    return r.isDelivered ? null : r.reason
  } catch (err) {
    return message(err)
  } finally {
    const left = (resuming.get(subagent) ?? 1) - 1
    if (left > 0) resuming.set(subagent, left)
    else resuming.delete(subagent)
  }
}

// lateDrop: a wake prompt the engine dropped after it was taken as queued started no turn: it is
// lost with its attempt given back, as a drop within the grace uses none (wake.ts), so plan asks
// again; its loop event says so, since its start was logged. A wake whose turn already started is
// left alone (a reminder's drop changes nothing).
export async function lateDrop($: EngineInterface, prompt: string, why: string) {
  const id = /\bid=(\S+)/.exec(prompt.split('\n', 1)[0] ?? '')?.[1]
  if (id === undefined) return
  await hook(async () => {
    const rt = await ledgerFor($)
    if (rt === null) return
    const now = await $.clock.now()
    const moved = transition(live, l => {
      const e = l.find(x => x.wakeId === id && x.status === 'running' && x.turnId === undefined)
      if (e === undefined) return l
      const given = { ...e, status: 'lost' as const, attempts: Math.max(0, e.attempts - 1), endedAt: now, summary: `submit ${why}`.slice(0, 200) }
      return l.map(x => (x.key === e.key ? given : x))
    })
    if (moved.length === 0) return
    await persist($, rt)
    await logLoop(hookEnv($, rt, now), moved)
  })
}

// releaseLock: at session.end this session's lease expires, so the next session acts at once.
export async function releaseLock($: EngineInterface, sessionId: string) {
  if (!S.heldLock || S.lastRt === null) return
  const loopDir = S.lastRt.loopDir
  await lockOp(async () => releaseActLock(lockIo($), actLockPath(loopDir), sessionId, await $.clock.now()))
  S.heldLock = false
}

export type OpAnswer = { ok: boolean; text: string }
