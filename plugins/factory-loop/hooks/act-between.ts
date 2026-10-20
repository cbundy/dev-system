// Between passes: the hooks that feed the ledger (v2 SPEC 13.2, 13.8.2, 13.10 item 4). What an agent's answer, a
// wake's turn, the wake answer tool and `/factory retry` do to the live ledger. act.ts holds the
// pass and the executors; this module reads them and is read by driver-between.ts alone, so nothing
// here is imported back by act.ts.
import { clip, ctxOf, logLoop, transition } from './act'
import type { ActEnv, Between } from './act'
import type { AgentAnswer } from './exec'
import { finish, retryIssue } from './ledger'
import type { LedgerEntry, State } from './types'
import { stepAnswered } from './v2/steps'
import { answerTool, onTurnComplete, onTurnStart } from './wake'
import type { TurnEnd } from './wake'

// The one repair message to an agent of the loop, of the type it runs as (a step's agent type,
// plugin:name): null once delivered, else why not, in the engine's own words.
export type Repair = (agentId: string, text: string, type: `${string}:${string}`) => Promise<string | null>

// What an agent's answer did: 'applied' (its entry finished; repaired when a repair message went
// out before it), 'repair' (unreadable, so the agent was asked once more), 'recorded' (its tool
// already answered), 'held' (a gated writer's answer waits for its stop gate line, the entry
// running on), 'dropped' or 'not ours'. key: its entry; undelivered: why its repair message
// was not delivered, whole, for the decision log (the entry's summary keeps a clipped copy, #559).
export type Answered = {
  result: 'applied' | 'repair' | 'held' | 'recorded' | 'dropped' | 'not ours'
  why?: string
  key?: string
  repaired?: boolean
  undelivered?: string
}

// agentAnswered: an agent step of the loop finished (its turn.complete): its answer is read by
// steps.ts (the file it recorded with the answer script) and its entry finished. 'applied' asks
// for a pass. An agent the ledger never held is 'not ours'; an answer for an entry that no longer
// runs (a stop timed it out, a retry replaced it) is logged and dropped, never applied. An answer
// that does not read first gets one repair message to the same agent, naming what was wrong and
// asking again (#548, #561): the entry runs on with its attempt unspent, and only an answer still
// unreadable after it, or a message that could not be delivered, fails the attempt as before.
export async function agentAnswered(
  env: ActEnv,
  state: State,
  answer: AgentAnswer,
  between: Between,
  repair: Repair = async () => 'the loop sends no messages from here',
): Promise<Answered> {
  const id = answer.agentId
  const entry = env.live.ledger.find(e => e.agentId === id && e.kind === 'agent-step')
  if (entry === undefined) return { result: 'not ours' }
  if (entry.status === 'done') return { result: 'recorded', key: entry.key }
  if (entry.status !== 'running') return { result: 'dropped', why: `late answer for ${entry.key} (${entry.status})` }
  between.answering.add(id)
  between.repairing.delete(id)
  try {
    // a v2 agent step's answer is read by steps.ts, and is never interim (v2 SPEC 10.8)
    const step = await stepAnswered(ctxOf(env, state, entry), entry, answer, undefined, between.gateHeld)
    // a gated writer's turn ended before its stop gate line: the entry runs on until a pass finds it
    if (step.held === true) return { result: 'held', key: entry.key }
    let exec = step.exec
    const ours = (e: LedgerEntry | undefined): e is LedgerEntry => e !== undefined && e.agentId === id && e.startedAt === entry.startedAt
    const still = () => {
      const current = env.live.ledger.find(e => e.key === entry.key)
      return ours(current) && current.status === 'running' ? current : null
    }
    // the attempt no longer runs: a stop or a retry ended it
    const ended = (): Answered => {
      const current = env.live.ledger.find(e => e.key === entry.key)
      return ours(current) && current.status === 'done' ? { result: 'recorded', key: entry.key } : { result: 'dropped', why: `answer for ${entry.key} came after the entry ended` }
    }
    if (still() === null) return ended()
    const at = await env.io.now()
    const current = still()
    if (current === null) return ended()
    const repaired = current.reminded === true
    let refused: string | undefined
    if (step.repair !== null && !repaired) {
      const problem = step.problem ?? 'no machine line'
      // the repair is on the entry before it goes out, so a reload never sends a second one
      const marked = transition(env.live, l => finish(l, entry.key, { status: 'running', reminded: true }, at))
      await env.save()
      await logLoop(env, marked)
      // a v2 step's own repair asks for the script again
      const undelivered = await repair(id, step.repair, step.subagentType)
      if (undelivered === null) {
        // listed idle or completed until the message resumes it, which the list may show late: the
        // passes take it as at work for a while, then count that listing afresh
        between.completedSeen.delete(id)
        between.repairing.set(id, at)
        return { result: 'repair', why: problem, key: entry.key }
      }
      refused = undelivered
      exec = { ...exec, summary: clip(`${exec.summary}; the repair message was not delivered: ${undelivered}`) }
    }
    const now = await env.io.now()
    if (still() === null) return ended()
    const moved = transition(env.live, l => finish(l, entry.key, exec, now, { config: env.rt.config }))
    await env.save()
    await logLoop(env, moved)
    const applied: Answered = { result: 'applied', key: entry.key, repaired }
    if (refused !== undefined) applied.undelivered = refused
    return applied
  } finally {
    between.answering.delete(id)
  }
}

// The refusal of a tool call that could not be decided in time (#558): the agent answers in text.
export const TOOL_LATE = 'Not recorded: the factory loop could not check this answer in time; reply with your text lines instead.'

// Asked just before a tool call changes the ledger: false once the caller has answered the call
// without it (register.ts bounded), and then nothing changes.
export type Claim = () => boolean

// keep: what follows a transition a hook made at once in the live ledger (#558): the ledger
// saved, then the moved entries' loop events.
export async function keep(env: ActEnv, moved: readonly LedgerEntry[]): Promise<void> {
  if (moved.length === 0) return
  await env.save()
  await logLoop(env, moved)
}

const WAKE_HEAD = /^(JUDGE|TASK|TELL) /m

// wakeStarted: a turn that opens with a wake's first line is that wake's turn (wake.ts
// onTurnStart). A frame the engine puts before a plugin's prompt is skipped to that line.
export async function wakeStarted(env: ActEnv, said: string, turnId: string): Promise<boolean> {
  const at = said.search(WAKE_HEAD)
  if (at < 0) return false
  const now = await env.io.now()
  const u = onTurnStart(env.live.ledger, said.slice(at), turnId)
  if (u === null) return false
  const moved = transition(env.live, l => finish(l, u.key, u, now))
  await env.save()
  await logLoop(env, moved)
  return true
}

// wakeEnded: a main-loop turn ended (wake.ts onTurnComplete): its ANSWER blocks close their
// wakes, a tell's own turn delivers it, an unanswered wake gets its one reminder. The caller
// submits the prompts (never awaiting them inside the turn's own hook), logs the problems, and
// pings when a wake moved.
export async function wakeEnded(env: ActEnv, turn: TurnEnd): Promise<{ moved: boolean; prompts: string[]; problems: string[] }> {
  const now = await env.io.now()
  const out = onTurnComplete(env.live.ledger, turn, env.rt.repo)
  const moved = out.updates.flatMap(u => transition(env.live, l => finish(l, u.key, u, now)))
  if (moved.length > 0) {
    await env.save()
    await logLoop(env, moved)
  }
  return { moved: out.updates.length > 0, prompts: out.prompts, problems: out.problems }
}

// wakeAnswered: mcp__factory-loop__answer, checked as the ANSWER block is (wake.ts answerTool)
// and recorded in the live ledger at once, with no await between the check and the change, as an
// agent's tool was (#558); `moved` asks for keep, once the call has its answer. claim: asked
// just before the ledger changes.
export async function wakeAnswered(
  env: ActEnv,
  input: unknown,
  agentId: string | undefined,
  claim: Claim = () => true,
): Promise<{ ok: boolean; text: string; moved: LedgerEntry[] }> {
  const now = await env.io.now()
  const r = answerTool(env.live.ledger, input, env.rt.repo, agentId === undefined ? {} : { agentId })
  const update = r.update
  if (update === null) return { ok: r.ok, text: r.text, moved: [] }
  if (!claim()) return { ok: false, text: TOOL_LATE, moved: [] }
  return { ok: r.ok, text: r.text, moved: transition(env.live, l => finish(l, update.key, update, now)) }
}

// retried: `/factory retry <N>` clears the issue's exhausted entries in the live ledger at once
// (D-38, ledger.ts retryIssue): the keys it cleared, and the entries it moved, for keep once the
// op has its answer (#558).
export function retried(env: Pick<ActEnv, 'live' | 'rt'>, issue: number): { cleared: string[]; moved: LedgerEntry[] } {
  let cleared: string[] = []
  const moved = transition(env.live, l => {
    const r = retryIssue(l, issue, env.rt.config)
    cleared = r.cleared
    return r.ledger
  })
  return { cleared, moved }
}
