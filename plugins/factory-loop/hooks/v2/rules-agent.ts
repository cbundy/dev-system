// The plan side of a record's step (docs/factory-loop/v2/SPEC.md 4.2, 4.4, 5.1, 10.2, 14.1 S2):
// what one step says each pass (StepRead), the generic agent step that the designer, the builder,
// the fixer and the triage run (S2: the slot prepared, then the agent spawned; its result read from
// its ledger entry, an outside cause named from facts the loop holds), and the lease step of a
// queued record. rules-state.ts asks each record's step through its StepPlan; a step whose reading
// is its own unit's (review, U6; the merge queue's head, U7; the work steps' effects, U5) has its
// plan in that unit's rules module, which may build on agentStep here.
//
// Pure: the time is state.now.
import { stepBreaker, want } from '../foundation'
import type { LedgerEntry, Ms, State } from '../types'
import { freeKey, keyParts, lifeAt, prepareKey, stepKey, stoppedBy } from './keys'
import type { FixWhy } from './prompts-work'
import type { EventData } from './table'
import { AGENT_STEPS, STEP_CLASS, STEP_ROLE, WHY_CAUSE } from './types'
import type { AgentStep, IssueRecord, Lease, OutsideCause, StepKind, StepMarker, StepResult, TableEvent, Trigger, UnknownWhy, V2Ctx } from './types'

// What a record's step says this pass:
// - running: something of the step runs; its clock started at `since` (4.4) and the step is
//   unknown (timeout) past timeoutMs;
// - result: the step ended with this event for the table, and the trigger the transition
//   re-checks (3.3);
// - waiting: a waiting state (4.4): nothing runs, and E6 tells on the state's period;
// - held: nothing of the step runs, and it has no clock: a start was planned this pass (why is
//   empty), or something holds it, which the skip line names (why).
export type StepRead =
  | { kind: 'running'; since: Ms; timeoutMs: Ms; key: string }
  | { kind: 'result'; event: TableEvent; trigger: Trigger }
  | { kind: 'waiting'; why: string }
  | { kind: 'held'; why: string }

// What a step's plan gets for one record: start says whether S2 may start the step's actions this
// pass (the seq's entry actions are done, nothing stalls the record, no other event takes it), and
// hold says why not; slot is the record's lease, when it holds one.
export type StepEnv = { ctx: V2Ctx; r: IssueRecord; slot: Lease | null; start: boolean; hold: string | null }

export type StepPlan = (env: StepEnv) => StepRead

// --- facts a step reads --------------------------------------------------------------------------------

// freeing: W2's free of this lease runs or is done, so the lease is gone though a pool read made
// before the free ended still shows it (10.1). A free that failed leaves the slot leased and whole.
export function freeing(ctx: V2Ctx, l: Pick<Lease, 'lease'>): boolean {
  const e = ctx.byKey.get(freeKey(l.lease))
  return e !== undefined && (e.status === 'running' || e.status === 'done')
}

// leasesOfLife: the life's leases, by holder factory-loop:<N>:<life> (10.1), but those W2 frees.
export function leasesOfLife(ctx: V2Ctx, r: Pick<IssueRecord, 'issue' | 'life'>): Lease[] {
  return ctx.v2.leases.filter(l => l.issue === r.issue && l.life === r.life && !freeing(ctx, l))
}

// leaseOf: the slot the record holds: its life's lease (leasesOfLife). When the life has two (a
// lease whose answer was lost, taken again), the one its newest done prepare named, else its newest
// done lease, else the first by path, so the choice holds from pass to pass; W2 frees the other.
export function leaseOf(ctx: V2Ctx, r: Pick<IssueRecord, 'issue' | 'life'>): Lease | null {
  const mine = leasesOfLife(ctx, r)
  if (mine.length <= 1) return mine[0] ?? null
  const named = (op: 'prepare' | 'lease') =>
    lifeEntries(ctx, r, 'slot')
      .filter(e => e.status === 'done' && e.outcome?.kind === 'slot' && e.outcome.op === op)
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .flatMap(e => (e.outcome?.kind === 'slot' && e.outcome.lease !== null ? [e.outcome.lease] : []))
  for (const id of [...named('prepare'), ...named('lease')]) {
    const l = mine.find(x => x.lease === id)
    if (l !== undefined) return l
  }
  return [...mine].sort((a, b) => a.path.localeCompare(b.path))[0] ?? null
}

// lifeEntries: the ledger entries of one life (their keys name it), of one kind or all.
export function lifeEntries(ctx: V2Ctx, r: Pick<IssueRecord, 'issue' | 'life'>, kind?: LedgerEntry['kind']): LedgerEntry[] {
  return ctx.state.ledger.filter(e => {
    if (kind !== undefined && e.kind !== kind) return false
    const p = keyParts(e.key)
    return p !== null && p.issue === r.issue && p.life === r.life
  })
}

// sentToFix: why a transition sent the record toward a fixer, or null when it is not one that
// does: T9 into fixing (fix:<kind>), X2 into fixing (triage:fix), or T10 parking at the fix cap
// (fix-cap:<kind>), whose resume leads back to fixing through queued (T1). X4 shares X2's via but
// parks, so the state it went to counts too.
function sentToFix(to: string, via: string): FixWhy | null {
  if (to === 'fixing' && via === 'triage:fix') return 'triage'
  const kind = (to === 'fixing' ? /^fix:(review|ci|conflict)$/ : to === 'parked' ? /^fix-cap:(review|ci|conflict)$/ : null)?.exec(via)?.[1]
  return kind === undefined ? null : (kind as FixWhy)
}

// fixWhyOf: why the record is in fixing, which the fixer's prompt and the fix_requested note read:
// the newest transition of its life, up to its seq, that sent it toward a fixer (sentToFix). A
// retry inside fixing (U1's free re-run, U2's second attempt, X1's triage retry) and a resume (T1)
// are their own seqs with their own vias, so they keep the reason the fixing began with. null when
// no such transition is in the ledger (a rebuild, a pruned ledger).
export function fixWhyOf(state: State, r: IssueRecord): FixWhy | null {
  let newest: { seq: number; why: FixWhy } | null = null
  for (const e of state.ledger) {
    if (e.kind !== 'transition' || e.status !== 'done' || e.outcome?.kind !== 'transition') continue
    const p = keyParts(e.key)
    if (p === null || p.issue !== r.issue || p.life !== r.life || p.seq === null || p.seq > r.seq) continue
    const why = sentToFix(e.outcome.to, e.outcome.via)
    if (why !== null && (newest === null || p.seq > newest.seq)) newest = { seq: p.seq, why }
  }
  return newest?.why ?? null
}

// leftoversOf: the leftovers files the life's slot ops saved (10.2), newest first: each prepare's,
// and each free's, which a parked or released life's slot left. A retry's or a resumed step's
// prompt names the newest (5.1). A free is keyed by its lease (keys.ts freeKey), so a file is the
// life's by its own name, which the tool builds from the lease's holder: <N>-<life>-...
export function leftoversOf(ledger: readonly LedgerEntry[], r: Pick<IssueRecord, 'issue' | 'life'>): string[] {
  const prefix = `${r.issue}-${r.life}-`
  return ledger
    .flatMap(e => {
      const o = e.outcome
      if (e.kind !== 'slot' || e.status !== 'done' || o?.kind !== 'slot' || typeof o.leftovers !== 'string') return []
      return (o.leftovers.split('/').at(-1) ?? '').startsWith(prefix) ? [{ file: o.leftovers, at: e.endedAt ?? e.startedAt }] : []
    })
    .sort((a, b) => b.at - a.at)
    .map(x => x.file)
}

// timeoutOf: a running step's timeout (4.4).
export function timeoutOf(ctx: V2Ctx, step: AgentStep): Ms {
  return ctx.config.stateTimeoutMs[step]
}

// triggerOf: what a transition from this entry's result re-checks: the entry, as plan saw it.
export function triggerOf(e: LedgerEntry): Trigger {
  return { kind: 'entry', key: e.key, status: e.status, startedAt: e.startedAt }
}

const isAgentStep = (step: StepKind | null): step is AgentStep => step !== null && (AGENT_STEPS as readonly string[]).includes(step)

// causeOf: the cause outside the issue of an unknown that ended now (5.1), each from a fact the
// loop holds, never inferred: the step's entry started before this module load and was lost
// (load); the record's lease is gone (slot); a rate limit, or a tier that stops new work (usage);
// the step-unknown breaker open when it ended, or tripped by this unknown (breaker). null: none.
export function causeOf(ctx: V2Ctx, r: IssueRecord, entry: LedgerEntry | null, why: UnknownWhy): OutsideCause | null {
  const { state } = ctx
  if (entry !== null && entry.status === 'lost' && entry.startedAt < state.loadedAt) return 'load'
  if (ctx.v2.sources.leases.ok && leaseOf(ctx, r) === null && r.state !== 'queued') return 'slot'
  if (WHY_CAUSE[why] !== undefined) return WHY_CAUSE[why] ?? null
  if (ctx.tier === 'stop-new' || ctx.tier === 'stop-all') return 'usage'
  const at = entry?.endedAt ?? state.now
  if (stepBreaker(state.ledger, at) !== null) return 'breaker'
  if (isAgentStep(r.step)) {
    // this unknown, as its transition would record it: does it trip the breaker?
    const probe: LedgerEntry = {
      key: `probe/${r.issue}`,
      kind: 'transition',
      class: 'free',
      rule: 'S4',
      issue: r.issue,
      run: null,
      pr: null,
      head: null,
      status: 'done',
      attempts: 1,
      startedAt: state.now,
      endedAt: state.now,
      outcome: { kind: 'transition', row: 'U2', event: 'unknown', cause: null, from: r.state, to: r.state, step: r.step, stored: true },
    }
    if (stepBreaker([...state.ledger, probe], state.now) !== null) return 'breaker'
  }
  return null
}

// unknownOf: an unknown for the table, with why, a reason and its outside cause: the one given, a
// fact the caller holds (5.1), else causeOf's.
export function unknownOf(ctx: V2Ctx, r: IssueRecord, entry: LedgerEntry | null, why: UnknownWhy, reason: string, cause?: OutsideCause): TableEvent {
  return { kind: 'unknown', why, reason: reason.length > 300 ? `${reason.slice(0, 297)}...` : reason, cause: cause ?? causeOf(ctx, r, entry, why) ?? undefined }
}

// asEventData: the fields of a step's answer the rows read, each of its own type (table.ts
// EventData); anything else is left out.
export function asEventData(x: unknown): EventData {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return {}
  const o = x as Record<string, unknown>
  const out: EventData = {}
  for (const k of ['text', 'question', 'brief', 'head', 'patch', 'instructions', 'closedAt', 'note'] as const) {
    const v = o[k]
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  if (typeof o.pr === 'number' && Number.isInteger(o.pr) && o.pr > 0) out.pr = o.pr
  if (typeof o.commits === 'boolean') out.commits = o.commits
  if (Array.isArray(o.notes) && o.notes.every(n => typeof n === 'string')) out.notes = [...(o.notes as string[])]
  return out
}

// resultEvent: a step's result as the table reads it. A triage's valid answer is the `triage`
// event with its choice; any other step's ok and not-ok carry the answer's fields (EventData), and
// a not-ok's reason is the step's code (table.ts NOT_OK_REASONS).
export function resultEvent(ctx: V2Ctx, r: IssueRecord, entry: LedgerEntry, step: StepKind, result: StepResult): TableEvent {
  if (result.event === 'unknown') return unknownOf(ctx, r, entry, result.why ?? 'bad-answer', result.reason ?? 'no usable answer')
  const data: EventData = { ...asEventData(result.data), ...(result.head === null ? {} : { head: result.head }) }
  if (step === 'triage') {
    if (result.event !== 'ok' || result.choice === null) return unknownOf(ctx, r, entry, 'bad-answer', 'the triage gave no choice')
    return { kind: 'triage', choice: result.choice, reason: result.reason ?? undefined, data: { ...data, text: data.text ?? result.reason ?? undefined } }
  }
  if (result.event === 'ok') return { kind: 'ok', data }
  return { kind: 'not-ok', reason: result.reason ?? undefined, data }
}

// stepEvent: an ended agent step's entry as the table reads it: its recorded result, or the
// generic agent unknown (4.2): lost or failed with no result, timed out.
export function stepEvent(ctx: V2Ctx, r: IssueRecord, e: LedgerEntry, step: StepKind): TableEvent {
  if (e.status === 'done') {
    const o = e.outcome
    if (o?.kind === 'step') return resultEvent(ctx, r, e, step, o.result)
    return unknownOf(ctx, r, e, 'bad-answer', `${e.key} ended with no result`)
  }
  const said = e.summary ?? e.status
  if (e.status === 'timed-out') return unknownOf(ctx, r, e, 'timeout', said)
  // an agent the loop stopped (a stop-agent names it) is `stopped`, not a death the loop did not cause
  const stop = stoppedBy(ctx.state.ledger, e)
  const dead = (): TableEvent => (stop !== null ? unknownOf(ctx, r, e, 'stopped', `${said} (the loop stopped it: ${stop.key})`) : unknownOf(ctx, r, e, 'agent-dead', said))
  if (e.status === 'lost') return dead()
  // failed: the agent list saw it fail or killed; a job file not written or a refusal (a loop bug)
  // is a CLI result outside the step's outcomes; anything else kept the agent from starting
  if (/^agent (failed|killed)/.test(said)) return dead()
  if (/could not be written|^refused/.test(said)) return unknownOf(ctx, r, e, 'cli', said)
  return unknownOf(ctx, r, e, 'spawn', said)
}

// --- the generic agent step (S2, S5) ---------------------------------------------------------------------

// notesFor: what the step's agent is told: the record's notes for this seq, then the owner's notes
// for the issue (or every issue) made in this life (`/factory note`).
export function notesFor(ctx: V2Ctx, r: IssueRecord): string[] {
  const lifeStart = lifeAt(r.life) ?? 0
  const owner = ctx.state.control.notes.filter(n => (n.issue === null || n.issue === r.issue) && n.at >= lifeStart).map(n => `owner: ${n.text}`)
  return [...r.notes, ...owner]
}

// markerOf: the step marker the slot's git dir carries (10.2). The slot executor sets loopDir, the
// loop's own folder, which plan does not know.
export function markerOf(ctx: V2Ctx, r: IssueRecord, step: AgentStep): StepMarker {
  return {
    v: 1,
    repo: ctx.state.repo,
    issue: r.issue,
    life: r.life,
    seq: r.seq,
    step,
    role: STEP_ROLE[step],
    branch: r.branch,
    pr: r.pr,
    gateCommands: [...ctx.config.gateCommands],
    gateTimeoutMs: ctx.config.gateTimeoutMs,
    loopDir: '',
    scratch: '',
  }
}

export type AgentOpts = {
  step: AgentStep
  // the step attempt's key (default stepKey: one per seq and attempt; review's is by patch and round)
  key?: string
  // the slot's preparation for it (default prepareKey: one per seq and attempt; a reviewer after
  // another of its seq gets its own, keys.ts reviewPrepareKey)
  prepare?: string
  // the rule that starts it (S2; S5 for triage)
  rule?: string
}

// slotLost: how the attempt's slot is gone, or null: with the pool's leases read, the record holds
// no lease, or not the one the attempt's prepare (done) ran in.
function slotLost(ctx: V2Ctx, slot: Lease | null, prep: LedgerEntry | undefined): string | null {
  if (!ctx.v2.sources.leases.ok) return null
  const o = prep?.status === 'done' && prep.outcome?.kind === 'slot' ? prep.outcome : null
  if (slot === null) return `is gone${o?.path ? ` (${o.path})` : ''}`
  if (o !== null && o.lease !== null && o.lease !== slot.lease) return `is gone: it was prepared on lease ${o.lease}, and the record now holds ${slot.lease} (${slot.path})`
  return null
}

// agentStep: one agent step of the record, generic over its kind (S2): the slot prepared for the
// attempt (10.2), then the agent spawned in it (10.3); running while either runs, with the step's
// timeout counted from the start of the running entry (4.4); then the result its entry recorded,
// or the generic agent unknown. A prepare that ended without done is the attempt's unknown
// (cli): it is part of the attempt, one per key. Nothing starts while env.start is false, so a held
// step has no running entry and no clock.
//
// The attempt's slot gone (slotLost) ends it at once, unknown with the cause `slot` (5.1's free
// re-run): a running agent then (agent-dead), so the new seq's entry actions stop it rather than let
// it write on, for up to the step's timeout, in a slot the pool may give another issue (property 6);
// a done prepare whose agent has not started (spawn), so no agent starts in a slot that was never
// prepared for it (10.2). The next attempt prepares the slot W1 leases.
export function agentStep(env: StepEnv, opts: AgentOpts): StepRead {
  const { ctx, r } = env
  const step = opts.step
  const key = opts.key ?? stepKey(r, step, r.attempt)
  const prep = opts.prepare ?? prepareKey(r, r.attempt)
  const rule = opts.rule ?? (step === 'triage' ? 'S5' : 'S2')
  const timeoutMs = timeoutOf(ctx, step)
  const e = ctx.byKey.get(key)
  const p = ctx.byKey.get(prep)
  const lost = slotLost(ctx, env.slot, p)
  if (e !== undefined) {
    if (e.status === 'running' && lost !== null) {
      return { kind: 'result', event: unknownOf(ctx, r, e, 'agent-dead', `the slot of ${step} ${lost}; its agent is stopped`, 'slot'), trigger: triggerOf(e) }
    }
    if (e.status === 'running') return { kind: 'running', since: e.startedAt, timeoutMs, key }
    // a step key is one attempt (maxAttempts 1): whatever it ended with is the attempt's result
    return { kind: 'result', event: stepEvent(ctx, r, e, step), trigger: triggerOf(e) }
  }
  if (p?.status === 'running') return { kind: 'running', since: p.startedAt, timeoutMs, key: prep }
  if (p !== undefined && p.status !== 'done') {
    return { kind: 'result', event: unknownOf(ctx, r, p, 'cli', `the slot could not be prepared for ${step}: ${p.summary ?? p.status}`), trigger: triggerOf(p) }
  }
  if (p !== undefined && lost !== null) {
    return { kind: 'result', event: unknownOf(ctx, r, p, 'spawn', `the slot prepared for ${step} ${lost}; ${step} never started`, 'slot'), trigger: triggerOf(p) }
  }
  if (!env.start) return { kind: 'held', why: env.hold ?? `${step} is held` }
  const slot = env.slot
  if (slot === null) return { kind: 'held', why: `${step} waits for its slot (W1)` }
  if (p === undefined) {
    want(ctx, {
      kind: 'slot',
      op: 'prepare',
      key: prep,
      class: 'free',
      rule,
      reason: `prepare the slot for ${step} attempt ${r.attempt}`,
      issue: r.issue,
      life: r.life,
      path: slot.path,
      lease: slot.lease,
      branch: r.branch,
      marker: markerOf(ctx, r, step),
      keepScratch: false,
      maxAttempts: 1,
    })
    return { kind: 'held', why: '' }
  }
  want(ctx, {
    kind: 'agent-step',
    key,
    class: STEP_CLASS[step],
    rule,
    reason: `${step} attempt ${r.attempt}`,
    issue: r.issue,
    step,
    life: r.life,
    seq: r.seq,
    attempt: r.attempt,
    branch: r.branch,
    slot: slot.path,
    notes: notesFor(ctx, r),
  })
  return { kind: 'held', why: '' }
}

// The design, build, fix and triage steps as the generic agent step; units with more to read
// (U5's work steps) give their own plan in rules-work.ts.
export const agentPlan =
  (step: AgentStep): StepPlan =>
  env =>
    agentStep(env, { step })

// leaseStep: queued's step (4.2): ok once a lease with the record's holder exists, which W1
// leases (10.1); until then the record waits, told on queued's period (E6).
export const leaseStep: StepPlan = ({ ctx, slot }) => {
  if (slot !== null) return { kind: 'result', event: { kind: 'ok' }, trigger: { kind: 'fact', fact: `lease:${slot.lease}` } }
  if (!ctx.v2.sources.leases.ok) return { kind: 'held', why: 'queued: the pool was not read, so no lease is known' }
  return { kind: 'waiting', why: 'queued: waits for a slot (W1)' }
}

// notBuiltStep: the plan of a step whose unit is not built yet: held, and the skip line says so.
export function notBuiltStep(step: StepKind, unit: string): StepPlan {
  return () => ({ kind: 'held', why: `the ${step} step is not built yet (${unit})` })
}
