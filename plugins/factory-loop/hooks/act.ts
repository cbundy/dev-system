// The act step (v2 SPEC 13.2, 13.6, 13.7, 13.8, 13.10): the one dispatcher from an action's kind to its executor,
// what an act-mode pass does once observe has read the factory (what the agent list proves,
// wakes past their timeout, plan, then plan's actions in order: start each ledger entry,
// pre-check usage for a token-spending class, run the executor, finish the entry with what it
// reported), and what the hooks between passes do to the ledger (an agent's answer, in text or
// through its answer tool, a wake's turn, the wake answer tool, `/factory retry`). Every entry
// that moves gets its `loop` event, once.
// register.ts holds $, builds the ActIo and keeps the store; everything here works through the
// ActIo and the live ledger, so the tests drive whole passes, and the argv safety test every
// executor, with a recording fake. The layer that plans is v2/plan.ts (v2 SPEC 2.3).
import { cliExecutors } from './act-cli'
import { isOffPass, launchOff, offPassExpired, sameAttempt } from './act-off'
import type { OffPass } from './act-off'
import { mergeExecutors } from './act-merge'
import type { ActIo, Exec, ExecCtx, Executor, RunInit, RunResult } from './exec'
import { GITHUB_V2, turnEnded } from './foundation'
import { changedEntries, finish, loopEvent, reconcileAgents, start } from './ledger'
import type { Runtime } from './observe'
import { preCheck } from './rails'
import type { Action, ActionKind, AgentStatus, Config, Control, LedgerEntry, Ms, PlanResult, State } from './types'
import { planV2 } from './v2/plan'
import { V2_EXECUTORS, executorOf } from './v2/registry'
import { stepAnswers, stepRecorded } from './v2/steps'
import { NO_TOKENS, readStepTokens } from './v2/step-tokens'
import { gateHoldMs } from './v2/steps-gate'
import { V2_ACTION_KINDS } from './v2/types'
import { expireWakes, wakeExecutors } from './wake'
import { readWakeCost } from './wake-cost'

const SUMMARY_MAX = 200
// fabriek-event is one jq call and one append; a minute is ample
const EVENT_TIMEOUT_MS = 60_000

// Every kind's executor (v2 SPEC 13.6.1): the shared kinds', and v2's for its new kinds (v2/registry.ts).
// act.test.ts checks that no ActionKind lacks one.
export const EXECUTORS: Partial<Record<ActionKind, Executor>> = {
  ...cliExecutors,
  ...mergeExecutors,
  ...wakeExecutors,
  ...Object.fromEntries(V2_ACTION_KINDS.map(kind => [kind, V2_EXECUTORS[kind]])),
}

const WAKES: readonly ActionKind[] = ['judge', 'task', 'tell']

// dispatch: the action's executor, v2's own for the kind first (a reused kind may have a v2
// behaviour), run again after a GitHub blip (registry.ts). A kind with no executor, or an
// executor that throws, is a failed attempt; neither is a reason to stop the pass.
export async function dispatch(ctx: ExecCtx, action: Action): Promise<Exec> {
  const run = executorOf(action.kind, EXECUTORS)
  if (run === undefined) return { status: 'failed', summary: `no executor for ${action.kind}`, noRetry: true }
  try {
    return await run(ctx, action)
  } catch (err) {
    return { status: 'failed', summary: clip(`${action.kind}: the executor threw: ${message(err)}`) }
  }
}

// --- commands and events (v2 SPEC 13.6.1, 13.7.4, 13.11.1) ---------------------------------------------------

// commandOf: ExecCtx.cmd: the argv from the main checkout (or init.cwd) with the runtime's
// environment, which carries the repo, the configured labels and, when not acting, the event
// sink. stdin passes through as given, an empty string included. Each command joins the pass's
// list for the decision log.
export function commandOf(io: ActIo, rt: Runtime, log: string[]): ExecCtx['cmd'] {
  return (argv: string[], init: RunInit): Promise<RunResult> => {
    log.push(argv.join(' ').slice(0, 160))
    const run: RunInit & { cwd: string; env: Record<string, string> } = { cwd: init.cwd ?? rt.cwd, env: init.env === undefined ? rt.env : { ...rt.env, ...init.env }, timeoutMs: init.timeoutMs }
    if (init.stdin !== undefined) run.stdin = init.stdin
    return io.run(argv, run)
  }
}

// eventArgv: `fabriek-event --type <type> --data <json> --issue N`.
export function eventArgv(type: string, data: Record<string, unknown>, at: { issue: number }): string[] {
  return ['fabriek-event', '--type', type, '--data', JSON.stringify(data), '--issue', String(at.issue)]
}

// eventOf: ExecCtx.event. fabriek-event exits non-zero only on a usage error (2); the error
// carries the exit as `exitCode`, which the executors read to never retry it.
export function eventOf(cmd: ExecCtx['cmd']): ExecCtx['event'] {
  return async (type, data, at) => {
    const r = await cmd(eventArgv(type, data, at), { timeoutMs: EVENT_TIMEOUT_MS })
    if (r.exitCode === 0) return
    const why = r.stderr.trim().split('\n').pop() ?? ''
    throw Object.assign(new Error(`fabriek-event ${type}: exit ${r.exitCode}${why === '' ? '' : `: ${why}`}`), { exitCode: r.exitCode })
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
  // a fresh wake id (v2 SPEC 13.8.1 `id=`)
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
  // the kill switch is set (v2 SPEC 13.11.3): one stat, asked before every action but the title and
  // before a notice goes out; once it is, the pass runs nothing more
  killed: () => Promise<boolean>
  // what went wrong outside any one action (a loop event not logged), for the decision log
  problems: string[]
  // where a command of an OFF_PASS kind (act-off.ts) ends; absent, it runs inline in the action
  offPass?: OffPass
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
    let argv = loopEvent(entry)
    if (argv === null) continue
    const said = JSON.stringify(argv)
    if (logged.get(entry.key) === said) continue
    logged.set(entry.key, said)
    // an agent step's end carries its transcript's token totals, read once: only here, where the
    // end is new (#657); no reading, no problem, where the runtime knows no config dir
    if (entry.kind === 'agent-step' && entry.status !== 'running' && entry.agentId !== undefined && env.rt.configDir !== undefined && env.rt.sessionCwd !== undefined) {
      const read = await readStepTokens(env.io, cmd, { configDir: env.rt.configDir, sessionCwd: env.rt.sessionCwd, session: entry.session ?? '', agentId: entry.agentId })
      if (read.problem !== null) env.problems.push(clip(`loop event ${entry.key}: ${read.problem}`))
      argv = loopEvent(entry, read.fields) ?? argv
    }
    // an ended task or tell carries the what-if cost of its window in its submitting session
    if ((entry.kind === 'task' || entry.kind === 'tell') && entry.status !== 'running' && entry.session !== undefined && entry.session !== '' && entry.endedAt !== null && env.rt.configDir !== undefined && env.rt.sessionCwd !== undefined) {
      const w = await readWakeCost(cmd, { configDir: env.rt.configDir, sessionCwd: env.rt.sessionCwd, session: entry.session }, entry.startedAt, entry.endedAt)
      if (w.problem !== null) env.problems.push(clip(`loop event ${entry.key}: ${w.problem}`))
      argv = loopEvent(entry, { ...NO_TOKENS, cost_usd: w.cost }) ?? argv
    }
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

// One action's result, for the decision log (v2 SPEC 13.12); at: when it started, for the trace (#552),
// absent for an action held before it started.
// off: the action's command runs off the pass (act-off.ts); ms is then its launch time.
export type ActOutcome = { key: string; kind: ActionKind; status: Exec['status']; ms: Ms; summary: string; at?: Ms; off?: true }

export type ActReport = {
  outcomes: ActOutcome[]
  // an executor met a GitHub rate limit: register sets the backoff (v2 SPEC 13.10 item 2)
  rateLimited: boolean
  // the kill switch stopped the pass between actions: register shows the loop off at once
  killed: boolean
}

// runActions: plan's actions in plan's order (finish in-flight work before starting new work).
// The kill switch is asked before each action but the title (bookkeeping only): an action
// already running finishes, and once the switch is seen every action left is skipped (#557).
export async function runActions(env: ActEnv, state: State, actions: readonly Action[]): Promise<ActReport> {
  const report: ActReport = { outcomes: [], rateLimited: false, killed: false }
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
    if (report.rateLimited && GITHUB_V2.includes(action.kind)) {
      report.outcomes.push({ key: action.key, kind: action.kind, status: 'skipped', ms: 0, summary: 'held: GitHub rate limit met this pass' })
      continue
    }
    const out = await actOne(env, state, action)
    report.outcomes.push(out.outcome)
    if (out.exec.status === 'failed' && out.exec.rateLimited === true) report.rateLimited = true
  }
  return report
}

// actOne: one action through the ledger (v2 SPEC 13.7): start (a retry keeps the key and counts an
// attempt), the usage pre-check for start, develop and drive (a refusal puts the entry back as
// it stood, v2 SPEC 13.10 item 7), the running entry saved, the executor, then finish with its Exec and
// { config, prev }. The title is compared, not keyed (v2 SPEC 13.5.8 O1), so it runs without an entry.
export async function actOne(env: ActEnv, state: State, action: Action): Promise<{ outcome: ActOutcome; exec: Exec }> {
  const t0 = await env.io.now()
  const done = async (exec: Exec) => {
    const ms = (await env.io.now()) - t0
    return { exec, outcome: { key: action.key, kind: action.kind, status: exec.status, ms, summary: clip(exec.summary), at: t0, ...(action.kind === 'title' && exec.status === 'running' ? { off: true as const } : {}) } }
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
  // and its rule re-derives what to do (v2 SPEC 13.7.5). A ledger that cannot be saved starts nothing.
  if (!(await env.save())) {
    const held: Exec = { status: 'skipped', summary: 'held: the ledger was not saved, so nothing starts' }
    env.live.ledger = finish(env.live.ledger, action.key, held, await env.io.now(), opts)
    return done(held)
  }
  if (env.offPass !== undefined && isOffPass(action.kind)) {
    // the command runs on, untraced, after the pass: its completion lands in the hook queue
    const off = env.offPass
    const ctx = ctxOf({ ...env, io: off.io, commands: [] }, state, s.entry)
    await launchOff(off, () => env.io.now(), () => dispatch(ctx, action), { key: action.key, kind: action.kind, started: s.entry, ...opts })
    const exec: Exec = { status: 'running', summary: 'running off the pass' }
    const done = await env.io.now()
    return { exec, outcome: { key: action.key, kind: action.kind, status: 'running', ms: done - t0, summary: exec.summary, at: t0, off: true } }
  }
  const exec = await dispatch(ctxOf(env, state, s.entry), action)
  await record(env, action.key, s.entry, exec, opts)
  return done(exec)
}

// record: finish the attempt with the executor's Exec, saved before its loop event, unless a hook
// already ended it: a wake answered (or a tell delivered) before its submit returned stays
// answered, and an entry a later attempt or a hook replaced is left alone (v2 SPEC 13.8.2, wake.ts
// onTurnStart); the hook saved it.
async function record(
  env: ActEnv,
  key: string,
  started: LedgerEntry,
  exec: Exec,
  opts: { config: Runtime['config']; prev: LedgerEntry | null },
): Promise<void> {
  const now = await env.io.now()
  const current = sameAttempt(env.live.ledger, started)
  if (current === undefined) return
  if (exec.status === 'running' && current.status !== 'running') return
  const moved = transition(env.live, l => finish(l, key, exec, now, opts))
  await env.save()
  await logLoop(env, moved)
}

// --- notices from outside plan (v2 SPEC 13.9.2, 13.11.2, 13.11.4) --------------------------------------------

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

// passErrorTell: three passes in a row threw (v2 SPEC 13.10 item 9): the owner hears of it once per spell.
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

// --- what a reload and the agent list prove (v2 SPEC 13.3.3, 13.7.5, 13.10 item 4) --------------------------------

export type ListedAgent = { id: string; status: AgentStatus }

// How long an agent sent the repair message counts as at work while the list still shows its
// turn ended, idle or completed (reconcilable): the engine resumes it from its transcript (#548),
// and when the list shows that is not proven. Past it, the usual one pass of grace, then lost.
export const REPAIR_GRACE_MS = 5 * 60_000

// reconcilable: the agent list as reconcileAgents should judge it. An agent listed idle has ended
// its turn as one listed completed has (foundation.ts turnEnded, #560), and each rule here reads them
// alike. An agent whose answer is being handled counts as running, listed or not, so a pass in
// between never marks it lost: that covers an agent whose repair message is on its way, since
// agentAnswered holds it in `answering` until the engine answers the send. So does one whose
// turn ended within REPAIR_GRACE_MS of its repair message being delivered (repairing: when each
// went out, until its next turn.complete), for the loop awaits its reply; an agent first listed
// with its turn ended counts as running for that pass, since its turn.complete may still be on
// its way (seen: when each id was first so listed, idle then completed being one sighting). seen
// and repairing are updated in place. So does a gated writer whose answer is held for its stop
// gate line (gateHeld: since when), within holdMs, listed or not: the hold, not the list, says
// when its step ends.
export function reconcilable(
  agents: readonly ListedAgent[],
  answering: ReadonlySet<string>,
  seen: Map<string, Ms>,
  now: Ms,
  repairing: Map<string, Ms>,
  gateHeld: Map<string, Ms> = new Map(),
  holdMs: Ms = 0,
): ListedAgent[] {
  for (const [id, at] of [...repairing]) if (now - at > REPAIR_GRACE_MS) repairing.delete(id)
  // a hold past its bound counts for nothing here but stays in the map: gateRule (steps.ts) owns its
  // start and takes the answer once the bound runs out, which a deleted hold would restart
  const holding = (id: string): boolean => {
    const at = gateHeld.get(id)
    return at !== undefined && now - at <= holdMs
  }
  const out = agents.map(a => {
    if (answering.has(a.id) || holding(a.id)) return { id: a.id, status: 'running' as AgentStatus }
    if (!turnEnded(a.status)) return a
    if (repairing.has(a.id)) return { id: a.id, status: 'running' as AgentStatus }
    const first = seen.get(a.id)
    if (first === undefined) seen.set(a.id, now)
    return first === undefined || first === now ? { id: a.id, status: 'running' as AgentStatus } : a
  })
  for (const id of [...answering, ...[...gateHeld.keys()].filter(holding)]) if (!agents.some(a => a.id === id) && !out.some(a => a.id === id)) out.push({ id, status: 'running' })
  for (const id of [...seen.keys()]) if (!agents.some(a => a.id === id && turnEnded(a.status))) seen.delete(id)
  return out
}

// updateDone: rule H4's restart for this update ran and the workspace came back: its entry is
// lost (the session restarted under it), or done before this module loaded. dev-restart-self
// returns once Coder accepts the build, minutes before the container is replaced, so a restart
// this module saw end is not done yet: the drain holds until the new session loads (D-15).
// control.updateDue is then cleared, or the loop would drain forever. A failed restart ends the
// update instead (driver-pass-log failUpdate), and the owner's notice lasts (rules-fleet restartTells).
export function updateDone(ledger: readonly LedgerEntry[], control: Control, loadedAt: Ms): boolean {
  const due = control.updateDue
  if (due === null) return false
  const restart = ledger.find(e => e.key === `restart:${due.at}`)
  return restart?.status === 'lost' || (restart?.status === 'done' && (restart.endedAt ?? loadedAt) < loadedAt)
}

// --- one act-mode pass, from what observe read (v2 SPEC 13.2) --------------------------------------------

// What the hooks between passes share with the pass: the agents whose answer is being handled,
// when each agent was first listed with its turn ended (idle or completed), and when each was
// sent its repair message (reconcilable), and since when each gated writer's answer has waited for
// its stop gate line (steps-gate.ts).
export type Between = { answering: Set<string>; completedSeen: Map<string, Ms>; repairing: Map<string, Ms>; gateHeld: Map<string, Ms> }

// The pass's agent list: only a read that worked may mark agents lost.
export type Listed = { ok: boolean; agents: ListedAgent[] }

// planned: when plan handed its actions over and how long it took (performance.now()), for the
// trace (#552)
export type Acted = { state: State; result: PlanResult; report: ActReport; planned: { at: Ms; ms: number } }

// planPass: the planner's plan (v2 SPEC 2.3).
export function planPass(state: State, config: Config): PlanResult {
  return planV2(state, config)
}

// finishAsRead: an answer read for an entry, applied only while the entry still runs as it was
// read (its turn.complete may have finished it during the read); the entries it moved.
function finishAsRead(env: ActEnv, was: LedgerEntry, exec: Exec, now: Ms): LedgerEntry[] {
  const current = env.live.ledger.find(e => e.key === was.key)
  if (current?.status !== 'running' || current.agentId !== was.agentId || current.startedAt !== was.startedAt) return []
  return transition(env.live, l => finish(l, was.key, exec, now, { config: env.rt.config }))
}

// answeredBeforeLost: the agent entries the agent list would mark lost (gone from it, or its turn
// ended with no answer read) whose agent recorded an answer with the answer script that passes its
// checks (#561): each is finished with that answer, as its turn.complete would have finished it
// (act-agents.ts scriptAnswered). An entry its turn.complete finished during the read is left
// alone.
async function answeredBeforeLost(env: ActEnv, state: State, agents: readonly ListedAgent[], now: Ms, between: Between): Promise<LedgerEntry[]> {
  const before = env.live.ledger
  // reconcileAgents keeps the ledger's order, entry for entry
  const reconciled = reconcileAgents(before, agents, now)
  const lost = before.filter((e, i) => e.status === 'running' && reconciled[i]?.status === 'lost')
  const moved: LedgerEntry[] = []
  for (const was of lost) {
    // a gated writer with no settling gate line is held (gateHeld), not lost: reconcilable then counts it
    const exec = await stepRecorded(ctxOf(env, state, was), was, true, undefined, between.gateHeld)
    if (exec !== null) moved.push(...finishAsRead(env, was, exec, now))
  }
  return moved
}

// actPass: the act-mode pass once the rails passed and observe read the factory: what the agent
// list proves (v2 SPEC 13.3.3, 13.10 item 4) and wakes past their timeout (v2 SPEC 13.8.2) go into the ledger first,
// then plan reads the state with that ledger, and its actions run in plan's order.
export async function actPass(env: ActEnv, observed: State, listed: Listed, between: Between): Promise<Acted> {
  const now = observed.now
  const moved: LedgerEntry[] = []
  if (listed.ok) {
    const holdMs = gateHoldMs(env.rt.config)
    const of = () => reconcilable(listed.agents, between.answering, between.completedSeen, now, between.repairing, between.gateHeld, holdMs)
    moved.push(...(await answeredBeforeLost(env, observed, of(), now, between)))
    // an entry that ended, or whose agent is gone from the ledger, holds nothing
    for (const id of [...between.gateHeld.keys()]) if (!env.live.ledger.some(e => e.agentId === id && e.status === 'running')) between.gateHeld.delete(id)
    const agents = of()
    moved.push(...transition(env.live, l => reconcileAgents(l, agents, now)))
  }
  for (const u of expireWakes(env.live.ledger, now, env.rt.config)) moved.push(...transition(env.live, l => finish(l, u.key, u, now)))
  // an off-pass command that outlived its bound is timed out; its completion, if it ever comes, is dropped
  for (const u of offPassExpired(env.live.ledger, now)) {
    env.problems.push(`${u.key}: ${u.summary}`)
    moved.push(...transition(env.live, l => finish(l, u.key, u, now)))
  }
  // a recorded answer ends its step when read (v2 SPEC 10.8)
  for (const r of await stepAnswers(env.live.ledger, e => ctxOf(env, observed, e), undefined, between.gateHeld)) moved.push(...finishAsRead(env, r.entry, r.exec, now))
  if (moved.length > 0) {
    await env.save()
    await logLoop(env, moved)
  }
  const state = { ...observed, ledger: env.live.ledger }
  const from = performance.now()
  const result = planPass(state, env.rt.config)
  const planned = { ms: performance.now() - from, at: await env.io.now() }
  const report = await runActions(env, state, result.actions)
  return { state, result, report, planned }
}

// --- small helpers --------------------------------------------------------------------------------

export function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
