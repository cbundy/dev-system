// The act step (SPEC 2, 6, 7, 8, 10): the one dispatcher from an action's kind to its executor,
// what an act-mode pass does once observe has read the factory (what the agent list proves,
// wakes past their timeout, plan, then plan's actions in order: start each ledger entry,
// pre-check usage for a token-spending class, run the executor, finish the entry with what it
// reported), and what the hooks between passes do to the ledger (an agent's answer, in text or
// through its answer tool, a wake's turn, the wake answer tool, `/factory retry`). Every entry
// that moves gets its `loop` event, once.
// register.ts holds $, builds the ActIo and keeps the store; everything here works through the
// ActIo and the live ledger, so the tests drive whole passes, and the argv safety test every
// executor, with a recording fake.
import { cliExecutors } from './act-cli'
import { agentExecutors, agentOf, interim, onAgentAnswer, onToolAnswer, purposeOfKey, repairAskOf, scriptAnswered } from './act-agents'
import { mergeExecutors } from './act-merge'
import type { ActIo, AgentAnswer, EventFields, Exec, ExecCtx, Executor, RunInit, RunResult } from './exec'
import { changedEntries, finish, loopEvent, reconcileAgents, retryIssue, start } from './ledger'
import type { Runtime } from './observe'
import { plan, turnEnded } from './plan'
import { repairPrompt } from './prompts'
import { preCheck } from './rails'
import type { BreakerNotice } from './rails'
import type { Action, ActionKind, AgentStatus, AgentType, Control, LedgerEntry, Ms, PlanResult, State } from './types'
import { answerTool, expireWakes, onTurnComplete, onTurnStart, wakeExecutors } from './wake'
import type { TurnEnd } from './wake'

const HOUR = 3_600_000
const SUMMARY_MAX = 200
// callum-flow-event is one jq call and one append; a minute is ample
const EVENT_TIMEOUT_MS = 60_000

// Every kind's executor (SPEC 6.1). act.test.ts checks that no ActionKind lacks one.
export const EXECUTORS: Partial<Record<ActionKind, Executor>> = {
  ...cliExecutors,
  ...mergeExecutors,
  ...agentExecutors,
  ...wakeExecutors,
}

// The kinds that write to GitHub, held for the rest of a pass once one met a rate limit, as
// plan holds them while the backoff lasts (plan.ts GITHUB, SPEC 10.2).
export const GITHUB_KINDS: readonly ActionKind[] = [
  'claim',
  'heartbeat',
  'sweep',
  'guard',
  'update-behind',
  'fix-linkage',
  'merge',
  'rollout',
  'close-issue',
  'release-parent',
  'abandon',
  'milestone-later',
  'milestone-expect',
  'pr-reopen',
  'pr-comment',
  'pr-close',
]

const WAKES: readonly ActionKind[] = ['judge', 'task', 'tell']

// dispatch: the action's executor, run once. A kind with no executor, or an executor that throws,
// is a failed attempt; neither is a reason to stop the pass.
export async function dispatch(ctx: ExecCtx, action: Action): Promise<Exec> {
  const run = EXECUTORS[action.kind]
  if (run === undefined) return { status: 'failed', summary: `no executor for ${action.kind}`, noRetry: true }
  try {
    return await run(ctx, action)
  } catch (err) {
    return { status: 'failed', summary: clip(`${action.kind}: the executor threw: ${message(err)}`) }
  }
}

// --- commands and events (SPEC 6.1, 7.4, 11.1) ---------------------------------------------------

// commandOf: ExecCtx.cmd: the argv from the main checkout (or init.cwd) with the runtime's
// environment, which carries the repo, the configured labels and, when not acting, the event
// sink. stdin passes through as given, an empty string included. Each command joins the pass's
// list for the decision log.
export function commandOf(io: ActIo, rt: Runtime, log: string[]): ExecCtx['cmd'] {
  return (argv: string[], init: RunInit): Promise<RunResult> => {
    log.push(argv.join(' ').slice(0, 160))
    const run: RunInit & { cwd: string; env: Record<string, string> } = { cwd: init.cwd ?? rt.cwd, env: rt.env, timeoutMs: init.timeoutMs }
    if (init.stdin !== undefined) run.stdin = init.stdin
    return io.run(argv, run)
  }
}

// eventArgv: `callum-flow-event <state>` with the fields as its flags.
export function eventArgv(state: string, f: EventFields): string[] {
  const argv = ['callum-flow-event', state]
  if (f.issue !== undefined && f.issue !== null) argv.push('--issue', String(f.issue))
  if (f.run !== undefined && f.run !== null) argv.push('--run', f.run)
  if (f.branch !== undefined && f.branch !== null) argv.push('--branch', f.branch)
  if (f.pr !== undefined && f.pr !== null) argv.push('--pr', String(f.pr))
  if (f.head !== undefined && f.head !== null) argv.push('--head', f.head)
  if (f.note !== undefined && f.note !== null) argv.push('--note', f.note)
  return argv
}

// eventOf: ExecCtx.event. callum-flow-event exits non-zero only on a usage error (2); the error
// carries the exit as `exitCode`, which the executors read to never retry it.
export function eventOf(cmd: ExecCtx['cmd']): ExecCtx['event'] {
  return async (state, fields) => {
    const r = await cmd(eventArgv(state, fields), { timeoutMs: EVENT_TIMEOUT_MS })
    if (r.exitCode === 0) return
    const why = r.stderr.trim().split('\n').pop() ?? ''
    throw Object.assign(new Error(`callum-flow-event ${state}: exit ${r.exitCode}${why === '' ? '' : `: ${why}`}`), { exitCode: r.exitCode })
  }
}

// --- the live ledger ---------------------------------------------------------------------------

// The ledger as the driver holds it: one array, replaced whole by every transition. The pass and
// the hooks that fire during it (an agent's answer, a wake's turn) apply their transitions to the
// array as it is then, with no await between the read and the write, so neither loses the other's.
// logged: the loop event last logged for each key (logLoop); a ledger loaded from the store or the
// event log starts it with loggedOf, since each of its entries was logged as it got there.
export type Live = { ledger: LedgerEntry[]; logged?: Map<string, string> }

// loggedOf: the loop event each entry of a loaded ledger already logged.
export function loggedOf(ledger: readonly LedgerEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of ledger) {
    const argv = loopEvent(entry)
    if (argv !== null) out.set(entry.key, JSON.stringify(argv))
  }
  return out
}

// transition: apply fn to the live ledger; the entries it changed, for their loop events.
export function transition(live: Live, fn: (ledger: LedgerEntry[]) => LedgerEntry[]): LedgerEntry[] {
  const before = live.ledger
  live.ledger = fn(before)
  return changedEntries(before, live.ledger)
}

// What an act step works with.
export type ActEnv = {
  io: ActIo
  // the acting runtime: its env sends events to the real log
  rt: Runtime
  live: Live
  // the pass's command list, for the decision log
  commands: string[]
  // a fresh wake id (SPEC 8.1 `id=`)
  wakeId: () => string
  // $.session.id(): the session a wake it submits belongs to ('' when unknown)
  session: string
  // writes the live ledger to the store: an attempt's start before its executor runs, and every
  // transition before its loop event, so a reload at any point finds what already happened;
  // false when it was not written
  save: () => Promise<boolean>
  // this session still holds the act lock, renewed now; once it does not, the pass runs nothing
  // more. Asked before every action.
  holds: () => Promise<boolean>
  // the kill switch is set (SPEC 11.3): one stat, asked before every action but the title and
  // before a notice goes out; once it is, the pass runs nothing more
  killed: () => Promise<boolean>
  // what went wrong outside any one action (a loop event not logged), for the decision log
  problems: string[]
}

export function ctxOf(env: ActEnv, state: State, entry: LedgerEntry): ExecCtx {
  const cmd = commandOf(env.io, env.rt, env.commands)
  return { io: env.io, rt: env.rt, state, entry, cmd, event: eventOf(cmd), wakeId: env.wakeId }
}

// logLoop: the `loop` event of each entry a transition moved that logs one: agents, wakes and
// owner notices (D-09, ledger.ts loopEvent), one per transition: an entry whose event would say
// just what its key's last one said is not logged again. A wake's turn taking its id, its
// reminder going out, and a turn that starts inside its submit (so turn.start moves the entry
// before the executor finishes it) each change the entry but not its event (run 2, #536). A
// failed log is noted, never retried.
export async function logLoop(env: Pick<ActEnv, 'io' | 'rt' | 'commands' | 'problems' | 'live'>, entries: readonly LedgerEntry[]): Promise<void> {
  const cmd = commandOf(env.io, env.rt, env.commands)
  const logged = (env.live.logged ??= new Map())
  for (const entry of entries) {
    const argv = loopEvent(entry)
    if (argv === null) continue
    const said = JSON.stringify(argv)
    if (logged.get(entry.key) === said) continue
    logged.set(entry.key, said)
    try {
      const r = await cmd(argv, { timeoutMs: EVENT_TIMEOUT_MS })
      if (r.exitCode !== 0) env.problems.push(clip(`loop event ${entry.key}: exit ${r.exitCode}`))
    } catch (err) {
      env.problems.push(clip(`loop event ${entry.key}: ${message(err)}`))
    }
  }
  // a key the ledger no longer holds (pruned, or a notice a retry cleared) is forgotten
  const held = new Set(env.live.ledger.map(e => e.key))
  for (const key of logged.keys()) if (!held.has(key)) logged.delete(key)
}

// --- one pass's actions ------------------------------------------------------------------------

// One action's result, for the decision log (SPEC 12); at: when it started, for the trace (#552),
// absent for an action held before it started.
export type ActOutcome = { key: string; kind: ActionKind; status: Exec['status']; ms: Ms; summary: string; at?: Ms }

export type ActReport = {
  outcomes: ActOutcome[]
  // an executor met a GitHub rate limit: register sets the backoff (SPEC 10.2)
  rateLimited: boolean
  // the title the title action set, when it did
  title: string | null
  // the kill switch stopped the pass between actions: register shows the loop off at once
  killed: boolean
}

// runActions: plan's actions in plan's order (finish in-flight work before starting new work).
// The kill switch is asked before each action but the title (bookkeeping only): an action
// already running finishes, and once the switch is seen every action left is skipped (#557).
export async function runActions(env: ActEnv, state: State, actions: readonly Action[]): Promise<ActReport> {
  const report: ActReport = { outcomes: [], rateLimited: false, title: null, killed: false }
  for (const action of actions) {
    if (!report.killed && action.kind !== 'title' && (await env.killed())) report.killed = true
    if (report.killed) {
      report.outcomes.push({ key: action.key, kind: action.kind, status: 'skipped', ms: 0, summary: 'kill switch' })
      continue
    }
    if (!(await env.holds())) {
      report.outcomes.push({ key: action.key, kind: action.kind, status: 'skipped', ms: 0, summary: 'held: the act lock is no longer this session\'s' })
      continue
    }
    if (report.rateLimited && GITHUB_KINDS.includes(action.kind)) {
      report.outcomes.push({ key: action.key, kind: action.kind, status: 'skipped', ms: 0, summary: 'held: GitHub rate limit met this pass' })
      continue
    }
    const out = await actOne(env, state, action)
    report.outcomes.push(out.outcome)
    if (out.exec.status === 'failed' && out.exec.rateLimited === true) report.rateLimited = true
    if (action.kind === 'title' && out.exec.status === 'done') report.title = action.text
  }
  return report
}

// actOne: one action through the ledger (SPEC 7): start (a retry keeps the key and counts an
// attempt), the usage pre-check for start, develop and drive (a refusal puts the entry back as
// it stood, SPEC 10.7), the running entry saved, the executor, then finish with its Exec and
// { config, prev }. The title is compared, not keyed (SPEC 5.8 O1), so it runs without an entry.
export async function actOne(env: ActEnv, state: State, action: Action): Promise<{ outcome: ActOutcome; exec: Exec }> {
  const t0 = await env.io.now()
  const done = async (exec: Exec) => {
    const ms = (await env.io.now()) - t0
    return { exec, outcome: { key: action.key, kind: action.kind, status: exec.status, ms, summary: clip(exec.summary), at: t0 } }
  }
  if (action.kind === 'title') return done(await dispatch(ctxOf(env, state, start([], action, t0).entry), action))

  const s = start(env.live.ledger, action, t0, env.session)
  // no loop event yet: the start and its finish are one transition, logged once
  env.live.ledger = s.ledger
  const opts = { config: env.rt.config, prev: s.prev }
  const refused = await preCheck({ usage: env.io.usage, now: env.io.now }, action, env.rt.config, state.control.usageOverride)
  if (refused !== null) {
    const now = await env.io.now()
    env.live.ledger = finish(env.live.ledger, action.key, refused, now, opts)
    await env.save()
    return done(refused)
  }
  // the entry is in the store, running, before anything happens: a reload, a crash or a restart
  // (restart-self ends the session) mid-action finds it and marks it lost, so its attempt counts
  // and its rule re-derives what to do (SPEC 7.5). A ledger that cannot be saved starts nothing.
  if (!(await env.save())) {
    const held: Exec = { status: 'skipped', summary: 'held: the ledger was not saved, so nothing starts' }
    env.live.ledger = finish(env.live.ledger, action.key, held, await env.io.now(), opts)
    return done(held)
  }
  const exec = await dispatch(ctxOf(env, state, s.entry), action)
  await record(env, action.key, s.entry, exec, opts)
  return done(exec)
}

// record: finish the attempt with the executor's Exec, saved before its loop event, unless a hook
// already ended it: a wake answered (or a tell delivered) before its submit returned stays
// answered, and an entry a later attempt or a hook replaced is left alone (SPEC 8.2, wake.ts
// onTurnStart); the hook saved it.
async function record(
  env: ActEnv,
  key: string,
  started: LedgerEntry,
  exec: Exec,
  opts: { config: Runtime['config']; prev: LedgerEntry | null },
): Promise<void> {
  const now = await env.io.now()
  const current = env.live.ledger.find(e => e.key === key)
  if (current === undefined || current.startedAt !== started.startedAt || current.attempts !== started.attempts) return
  if (exec.status === 'running' && current.status !== 'running') return
  const moved = transition(env.live, l => finish(l, key, exec, now, opts))
  await env.save()
  await logLoop(env, moved)
}

// --- notices from outside plan (SPEC 9.2, 11.2, 11.4) --------------------------------------------

// openWake: a judge, task or tell that is still running. Only one wake is open at a time (O2).
export function openWake(ledger: readonly LedgerEntry[]): LedgerEntry | undefined {
  return ledger.find(e => e.status === 'running' && WAKES.includes(e.kind))
}

// sendNotice: a tell that comes from outside plan (a rail, the ping breaker, failing passes) goes
// out through the wake executor under its own key, once, and only while no wake is open: a key
// the ledger holds was sent, unless it was lost (the engine dropped it before its turn); an open
// wake keeps it waiting (the caller keeps it pending), as does the kill switch.
export async function sendNotice(env: ActEnv, state: State, tell: Action): Promise<'sent' | 'waiting' | 'failed'> {
  if (env.live.ledger.some(e => e.key === tell.key && e.status !== 'lost')) return 'sent'
  if (openWake(env.live.ledger) !== undefined || (await env.killed())) return 'waiting'
  const { exec } = await actOne(env, state, tell)
  return exec.status === 'running' || exec.status === 'done' ? 'sent' : 'failed'
}

// passErrorTell: three passes in a row threw (SPEC 10.9): the owner hears of it once per spell.
export function passErrorTell(since: Ms, passes: number, error: string): Action {
  return {
    kind: 'tell',
    wake: 'pass-error',
    key: `tell:pass-error:${since}`,
    class: 'owner',
    rule: 'O2',
    reason: 'tell pass-error',
    issue: null,
    fields: { passes: String(passes) },
    context: [`last error: ${error.replace(/\s+/g, ' ').slice(0, 300)}`],
  }
}

// --- rate-cap holds (SPEC 11.4, D-24) ---------------------------------------------------------------

// capKey: a rate cap plan tripped (a bucket, or '<kind>:<issue>') as its hourly loop event's key.
export function capKey(capped: string, now: Ms): string {
  return `cap:${capped}:${Math.floor(now / HOUR)}`
}

// capEventArgv: a rate-cap hold has no ledger entry of its own, so its `loop` event is built
// here: one per capped bucket or kind and issue per hour, status held.
export function capEventArgv(capped: string, now: Ms): string[] {
  const [kind = capped, issue] = capped.split(':')
  const argv = ['callum-flow-event', 'loop']
  if (issue !== undefined && /^\d+$/.test(issue)) argv.push('--issue', issue)
  argv.push('--note', `kind=${kind} key=${capKey(capped, now)} status=held`)
  return argv
}

// breakerEventArgv: the ping-storm breaker opened (SPEC 2, 11.4, D-39): its `loop` event, beside
// its one tell.
export function breakerEventArgv(b: BreakerNotice): string[] {
  return ['callum-flow-event', 'loop', '--note', `kind=breaker key=breaker:pings:${b.since} status=open passes=${b.passes} until=${b.until}`]
}

// --- what a reload and the agent list prove (SPEC 3.3, 7.5, 10.4) --------------------------------

export type ListedAgent = { id: string; status: AgentStatus }

// How long an agent sent the repair message counts as at work while the list still shows its
// turn ended, idle or completed (reconcilable): the engine resumes it from its transcript (#548),
// and when the list shows that is not proven. Past it, the usual one pass of grace, then lost.
export const REPAIR_GRACE_MS = 5 * 60_000

// reconcilable: the agent list as reconcileAgents should judge it. An agent listed idle has ended
// its turn as one listed completed has (plan.ts turnEnded, #560), and each rule here reads them
// alike. An agent whose answer is being handled counts as running, listed or not, so a pass in
// between never marks it lost: that covers an agent whose repair message is on its way, since
// agentAnswered holds it in `answering` until the engine answers the send. So does one whose
// turn ended within REPAIR_GRACE_MS of its repair message being delivered (repairing: when each
// went out, until its next turn.complete), for the loop awaits its reply; an agent first listed
// with its turn ended counts as running for that pass, since its turn.complete may still be on
// its way (seen: when each id was first so listed, idle then completed being one sighting). seen
// and repairing are updated in place.
export function reconcilable(
  agents: readonly ListedAgent[],
  answering: ReadonlySet<string>,
  seen: Map<string, Ms>,
  now: Ms,
  repairing: Map<string, Ms>,
): ListedAgent[] {
  for (const [id, at] of [...repairing]) if (now - at > REPAIR_GRACE_MS) repairing.delete(id)
  const out = agents.map(a => {
    if (answering.has(a.id)) return { id: a.id, status: 'running' as AgentStatus }
    if (!turnEnded(a.status)) return a
    if (repairing.has(a.id)) return { id: a.id, status: 'running' as AgentStatus }
    const first = seen.get(a.id)
    if (first === undefined) seen.set(a.id, now)
    return first === undefined || first === now ? { id: a.id, status: 'running' as AgentStatus } : a
  })
  for (const id of answering) if (!agents.some(a => a.id === id)) out.push({ id, status: 'running' })
  for (const id of [...seen.keys()]) if (!agents.some(a => a.id === id && turnEnded(a.status))) seen.delete(id)
  return out
}

// updateDone: rule H4's restart for this update ran and the workspace came back: its entry is
// lost (the session restarted under it), or done before this module loaded. dev-restart-self
// returns once Coder accepts the build, minutes before the container is replaced, so a restart
// this module saw end is not done yet: the drain holds until the new session loads (D-15).
// control.updateDue is then cleared, or the loop would drain forever. A failed restart keeps the
// drain, and plan tells the owner (agent-failed).
export function updateDone(ledger: readonly LedgerEntry[], control: Control, loadedAt: Ms): boolean {
  const due = control.updateDue
  if (due === null) return false
  const restart = ledger.find(e => e.key === `restart:${due.at}`)
  return restart?.status === 'lost' || (restart?.status === 'done' && (restart.endedAt ?? loadedAt) < loadedAt)
}

// --- one act-mode pass, from what observe read (SPEC 2) --------------------------------------------

// What the hooks between passes share with the pass: the agents whose answer is being handled,
// when each agent was first listed with its turn ended (idle or completed), and when each was
// sent its repair message (reconcilable).
export type Between = { answering: Set<string>; completedSeen: Map<string, Ms>; repairing: Map<string, Ms> }

// The pass's agent list: only a read that worked may mark agents lost.
export type Listed = { ok: boolean; agents: ListedAgent[] }

// planned: when plan handed its actions over and how long it took (performance.now()), for the
// trace (#552)
export type Acted = { state: State; result: PlanResult; report: ActReport; planned: { at: Ms; ms: number } }

// answeredBeforeLost: the agent entries the agent list would mark lost (gone from it, or its turn
// ended with no answer read) whose agent recorded an answer with the answer script that passes its
// checks (#561): each is finished with that answer, as its turn.complete would have finished it
// (act-agents.ts scriptAnswered). An entry its turn.complete finished during the read is left
// alone.
async function answeredBeforeLost(env: ActEnv, state: State, agents: readonly ListedAgent[], now: Ms): Promise<LedgerEntry[]> {
  const before = env.live.ledger
  // reconcileAgents keeps the ledger's order, entry for entry
  const reconciled = reconcileAgents(before, agents, now)
  const lost = before.filter((e, i) => e.status === 'running' && reconciled[i]?.status === 'lost')
  const moved: LedgerEntry[] = []
  for (const was of lost) {
    const exec = await scriptAnswered(ctxOf(env, state, was), was)
    if (exec === null) continue
    const current = env.live.ledger.find(e => e.key === was.key)
    if (current?.status !== 'running' || current.agentId !== was.agentId || current.startedAt !== was.startedAt) continue
    moved.push(...transition(env.live, l => finish(l, was.key, exec, now, { config: env.rt.config })))
  }
  return moved
}

// actPass: the act-mode pass once the rails passed and observe read the factory: what the agent
// list proves (SPEC 3.3, 10.4) and wakes past their timeout (SPEC 8.2) go into the ledger first,
// then plan reads the state with that ledger, and its actions run in plan's order.
export async function actPass(env: ActEnv, observed: State, listed: Listed, between: Between): Promise<Acted> {
  const now = observed.now
  const moved: LedgerEntry[] = []
  if (listed.ok) {
    const agents = reconcilable(listed.agents, between.answering, between.completedSeen, now, between.repairing)
    moved.push(...(await answeredBeforeLost(env, observed, agents, now)))
    moved.push(...transition(env.live, l => reconcileAgents(l, agents, now)))
  }
  for (const u of expireWakes(env.live.ledger, now, env.rt.config)) moved.push(...transition(env.live, l => finish(l, u.key, u, now)))
  if (moved.length > 0) {
    await env.save()
    await logLoop(env, moved)
  }
  const state = { ...observed, ledger: env.live.ledger }
  const from = performance.now()
  const result = plan(state, env.rt.config)
  const planned = { ms: performance.now() - from, at: await env.io.now() }
  const report = await runActions(env, state, result.actions)
  return { state, result, report, planned }
}

// --- between passes: the hooks that feed the ledger (SPEC 2, 8.2, 10.4) ----------------------------

// The one repair message to an agent of the loop, of the type it runs as: null once delivered,
// else why not, in the engine's own words.
export type Repair = (agentId: string, text: string, type: AgentType) => Promise<string | null>

// What an agent's answer did: 'applied' (its entry finished; repaired when a repair message went
// out before it), 'repair' (unreadable, so the agent was asked once more), 'waiting' (interim),
// 'recorded' (its tool already answered), 'dropped' or 'not ours'. key: its entry; via: how an
// applied answer came (the answer script's file, #561, or its text); scriptProblem: what kept a
// file it recorded out; undelivered: why its repair message was not delivered, whole, for the
// decision log (the entry's summary keeps a clipped copy, #559).
export type Answered = {
  result: 'applied' | 'repair' | 'waiting' | 'recorded' | 'dropped' | 'not ours'
  why?: string
  key?: string
  repaired?: boolean
  via?: 'script' | 'text'
  scriptProblem?: string
  undelivered?: string
}

// agentAnswered: an agent of the loop finished (its turn.complete): its answer is read into the
// outcome (act-agents.ts onAgentAnswer: the file it recorded with the answer script, else its
// text; it logs the verdict and superseded events) and its entry finished. 'applied' asks for a
// pass. An agent the ledger never held is 'not ours'; an answer for an entry that no longer runs
// (an A1 stop timed it out, a retry replaced it) is logged and dropped, never applied, and the
// closing words of an agent whose tool already answered change nothing. An interim answer (no
// machine line, #545) from an agent atWork finds still at work leaves its entry running for its
// next answer, up to its timeout (rule A1); atWork is asked only then. A final answer with no
// machine line first gets one repair message to the same agent, naming what was wrong and asking
// again on the channel its spawn was asked on (#548, #561): the entry runs on with its attempt
// unspent, and only an answer still unreadable after it, or a message that could not be
// delivered, fails the attempt (or sends the designer's report to the model, rule D3) as before.
// A tool call is answered outside the hook queue (#558), so it may finish the entry while this
// answer is read: the entry is checked again just before each change, with no await between, and
// an entry its tool finished meanwhile is 'recorded', the text never read over it.
export async function agentAnswered(
  env: ActEnv,
  state: State,
  answer: AgentAnswer,
  between: Between,
  atWork: (agentId: string) => Promise<boolean> = async () => false,
  repair: Repair = async () => 'the loop sends no messages from here',
): Promise<Answered> {
  const id = answer.agentId
  const entry = env.live.ledger.find(e => e.agentId === id && (e.kind === 'spawn' || e.kind === 'delegate'))
  if (entry === undefined) return { result: 'not ours' }
  if (entry.status === 'done') return { result: 'recorded', key: entry.key }
  if (entry.status !== 'running') return { result: 'dropped', why: `late answer for ${entry.key} (${entry.status})` }
  between.answering.add(id)
  between.repairing.delete(id)
  try {
    const read = await onAgentAnswer(ctxOf(env, state, entry), entry, answer)
    let exec = read.exec
    const ours = (e: LedgerEntry | undefined): e is LedgerEntry => e !== undefined && e.agentId === id && e.startedAt === entry.startedAt
    const still = () => {
      const current = env.live.ledger.find(e => e.key === entry.key)
      return ours(current) && current.status === 'running' ? current : null
    }
    // the attempt no longer runs: its tool answered meanwhile, or a stop or a retry ended it
    const ended = (): Answered => {
      const current = env.live.ledger.find(e => e.key === entry.key)
      return ours(current) && current.status === 'done' ? { result: 'recorded', key: entry.key } : { result: 'dropped', why: `answer for ${entry.key} came after the entry ended` }
    }
    if (still() === null) return ended()
    if (interim(answer, exec) && (await atWork(id))) {
      return { result: 'waiting', why: `interim answer for ${entry.key}: the agent still works, so its final answer is awaited` }
    }
    const at = await env.io.now()
    const current = still()
    if (current === null) return ended()
    const repaired = current.reminded === true
    const type = agentOf(entry)
    let refused: string | undefined
    if (interim(answer, exec) && !repaired && type !== null) {
      const problem = read.problem ?? 'no machine line'
      // the repair is on the entry before it goes out, so a reload never sends a second one
      const marked = transition(env.live, l => finish(l, entry.key, { status: 'running', reminded: true }, at))
      await env.save()
      await logLoop(env, marked)
      // the channel the spawn's prompt asked for (its record); text when it names none, or the
      // script's job file is gone
      const { channel, script } = await repairAskOf(env, entry, read.channel)
      const undelivered = await repair(id, repairPrompt(type, purposeOfKey(entry.key), problem, channel, script), type)
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
    const applied: Answered = { result: 'applied', key: entry.key, repaired, via: read.via }
    if (read.scriptProblem !== undefined) applied.scriptProblem = read.scriptProblem
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

// What an answer tool's call did: ok and the text the agent reads; key: the entry it answered;
// after: an accepted call's follow-up, run once the call has its answer (#558): its events, the
// ledger saved and the entry's loop event, in that order (its input was saved before the call was
// recorded); notes on what failed, for the decision log.
export type ToolAnswered = { ok: boolean; text: string; key?: string; repaired?: boolean; after?: (env: ActEnv) => Promise<string[]> }

// agentToolAnswered: an agent's answer tool (agent-tools.ts, #548), tied to the entry that
// spawned it by the call's agentId. Only an agent whose entry still runs may answer: the main
// conversation, an agent the loop did not start (an implementer's own sub-agents among them) and
// one whose answer is in are refused. A call the contract refuses changes nothing and tells the
// agent what to correct; an accepted one finishes the entry at once, as its text would (its
// turn's closing words are then not read). Both channels share the reading, so a tool answer
// means exactly what the same answer in text means. The call is answered before the engine gives
// up on it (#558): the entry is checked and finished in the live ledger with no await between,
// so the answer is true when given and every hook and pass after it sees the entry done, and
// what is slow is left to `after`.
export async function agentToolAnswered(
  env: ActEnv,
  state: State,
  tool: string,
  input: unknown,
  agentId: string | undefined,
  claim: Claim = () => true,
): Promise<ToolAnswered> {
  const no = (why: string, key?: string): ToolAnswered => (key === undefined ? { ok: false, text: `Not recorded: ${why}.` } : { ok: false, text: `Not recorded: ${why}.`, key })
  if (agentId === undefined) return no('this tool takes the answer of an agent the factory loop started, and the main conversation is none')
  const entry = env.live.ledger.find(e => e.agentId === agentId && (e.kind === 'spawn' || e.kind === 'delegate'))
  if (entry === undefined) return no('the factory loop is waiting on no answer from this agent')
  if (entry.status !== 'running') {
    return no(entry.status === 'done' ? 'your answer is already recorded; end your turn' : `the factory loop no longer waits on this agent (${entry.status})`, entry.key)
  }
  const r = await onToolAnswer(ctxOf(env, state, entry), entry, tool, input)
  if ('refused' in r) return no(r.refused, entry.key)
  const now = await env.io.now()
  const current = env.live.ledger.find(e => e.key === entry.key)
  if (current === undefined || current.agentId !== agentId || current.status !== 'running' || current.startedAt !== entry.startedAt) {
    return no('the factory loop stopped waiting on this agent meanwhile', entry.key)
  }
  if (!claim()) return { ok: false, text: TOOL_LATE, key: entry.key }
  const moved = transition(env.live, l => finish(l, entry.key, r.exec, now, { config: env.rt.config }))
  const after = async (later: ActEnv): Promise<string[]> => {
    const notes = await r.after(ctxOf(later, state, entry))
    await keep(later, moved)
    return notes
  }
  return { ok: true, text: `Recorded: ${r.exec.summary}. End your turn now; no reply lines are needed.`, key: entry.key, repaired: current.reminded === true, after }
}

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
// agent's tool is (#558); `moved` asks for keep, once the call has its answer. claim: as for
// agentToolAnswered.
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

// --- small helpers --------------------------------------------------------------------------------

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
