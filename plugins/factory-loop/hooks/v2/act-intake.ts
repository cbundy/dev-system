// The `intake-stamp` executor (docs/factory-loop/v2/SPEC.md 13.4, epic #995, issue #1152): rule I1's
// real run of the intake reader, whose dry run is driver-stamp.ts (both share v2/intake.ts).
//
// - run: read the issue and the repo's top level, record the try { version, running } in
//   stamps:<repo> BEFORE the reader is spawned (so a crash, timeout, failure or drop never respawns the
//   same body version), then spawn the reader (INTAKE_AGENT, model intakeModel, named
//   intake-<N>-<version>). The entry runs on until the reader's turn ends.
// - the end (intakeFinish, called by act-between.ts intakeAnswered when the turn completes): the answer
//   is parsed and checked (parseIntakeAnswer); the outcome (ok, dropped, failed) is the try's. Only ok
//   writes the stamp and sets labels (intake-labels.ts: the owner wins); a dropped or failed stamp
//   leaves the stamp factors at 0.
// - settle: a run that timed out or was lost: the agent is stopped if it still runs and the try is
//   recorded failed with the reason (rules-intake.ts).
//
// Every finished try writes exactly one intake_stamp v1 event (mode run) with the run's token totals,
// null when the transcript cannot be read. Executors decide nothing: plan did.
import { rateLimited } from '../exec'
import type { Exec, ExecCtx, Executor } from '../exec'
import { parseIssueRead } from '../parse'
import type { Action, ActionKind, LedgerEntry } from '../types'
import * as ARGV from './argv'
import { AREA_LABEL, NEEDS_DECISION, NEEDS_DECISION_LABEL, planLabels } from './intake-labels'
import type { LabelPlan } from './intake-labels'
import { INTAKE_AGENT, parseIntakeAnswer, readIssue, topLevelListing } from './intake'
import type { IntakeResult } from './contracts-intake.mjs'
import { intakeKey, intakeRunOf } from './keys'
import { intakePrompt } from './prompts-intake'
import { NO_TOKENS, readStepTokens } from './step-tokens'
import type { TokenFields } from './step-tokens'
import { withOwned, withStamp, withTry, stampStoreFromStore } from './stamps'
import type { LabelGroup, StampStore, TryOutcome } from './stamps'

const SEC = 1000
const GH_MS = 60 * SEC
const SUMMARY_MAX = 200
const REASON_MAX = 200

type IntakeAction = Extract<Action, { kind: 'intake-stamp' }>
type Run = { issue: number; version: string }

const clip = (text: string, max = SUMMARY_MAX): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text)
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const refused = (why: string): Exec => ({ status: 'failed', summary: clip(`refused: ${why}`), noRetry: true })

// peek: the value stamps:<repo> holds now, through the store's queued read-modify-write; null when there is no store.
async function peek(ctx: ExecCtx): Promise<StampStore | null> {
  const update = ctx.io.v2?.updateStamps
  if (update === undefined) return null
  let seen: unknown = null
  await update(raw => {
    seen = raw
    return null
  })
  return stampStoreFromStore(seen)
}

// The event's tokens: the run's transcript totals, null when it cannot be read (or the run has no agent).
async function tokensOf(ctx: ExecCtx, entry: LedgerEntry | undefined): Promise<{ fields: TokenFields; problem: string | null }> {
  const { configDir, sessionCwd } = ctx.rt
  if (entry === undefined || entry.agentId === undefined || configDir === undefined || sessionCwd === undefined) return { fields: NO_TOKENS, problem: null }
  return readStepTokens(ctx.io, ctx.cmd, { configDir, sessionCwd, session: entry.session ?? '', agentId: entry.agentId })
}

// What one finished try tells: the checked answer when there is one, the labels and the reason.
type Told = {
  outcome: Exclude<TryOutcome, 'running'>
  result: IntakeResult | null
  reason: string | null
  labelsSet: string[]
  labelsKept: string[]
}

// eventOf: the intake_stamp v1 event of a finished try.
function eventOf(ctx: ExecCtx, run: Run, told: Told, tokens: TokenFields): Record<string, unknown> {
  const r = told.result
  return {
    version: run.version,
    mode: 'run',
    outcome: told.outcome,
    area: r?.area ?? null,
    needs_owner: r?.needsOwner ?? null,
    reason: told.reason,
    touches: r?.touches ?? [],
    dropped: r?.dropped ?? [],
    labels_set: told.labelsSet,
    labels_kept: told.labelsKept,
    model: ctx.rt.config.intakeModel,
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    cache_read_tokens: tokens.cache_read_tokens,
    cache_creation_tokens: tokens.cache_creation_tokens,
  }
}

// logTry: the one event of a finished try; the problem, if any, for the summary.
async function logTry(ctx: ExecCtx, run: Run, told: Told, entry: LedgerEntry | undefined): Promise<string> {
  const tokens = await tokensOf(ctx, entry)
  try {
    await ctx.event('intake_stamp', eventOf(ctx, run, told, tokens.fields), { issue: run.issue })
  } catch (err) {
    return `event not written: ${message(err)}`
  }
  return tokens.problem === null ? '' : `tokens: ${tokens.problem}`
}

// --- failing a try without an answer ----------------------------------------------------------------

// failTry: the try of this version, still running, recorded failed with the reason, and its one event.
// 'unchanged' when the try is not running any more (it ended already: nothing is written twice), 'unsaved'
// when the store would not take it (nothing is logged; I1 settles it later).
async function failTry(ctx: ExecCtx, run: Run, reason: string, entry: LedgerEntry | undefined): Promise<'failed' | 'unchanged' | 'unsaved'> {
  const update = ctx.io.v2?.updateStamps
  if (update === undefined) return 'unsaved'
  const at = await ctx.io.now()
  const r = await update(raw => {
    const cur = stampStoreFromStore(raw).tries[String(run.issue)]
    if (cur === undefined || cur.version !== run.version || cur.outcome !== 'running') return null
    return withTry(raw, run.issue, { version: run.version, outcome: 'failed', at, reason })
  })
  if (!r.saved) return 'unsaved'
  if (!r.changed) return 'unchanged'
  await logTry(ctx, run, { outcome: 'failed', result: null, reason, labelsSet: [], labelsKept: [] }, entry)
  return 'failed'
}

// --- run ----------------------------------------------------------------------------------------------

function defaultBranch(ctx: ExecCtx): string | null {
  const c = ctx.state.checkout
  return c === null || 'error' in c || c.defaultBranch === '' ? null : c.defaultBranch
}

async function run(ctx: ExecCtx, action: IntakeAction): Promise<Exec> {
  const issue = action.issue
  if (issue === null) return refused(`${action.key} names no issue`)
  if (ctx.rt.config.intakeStamp !== 'on') return refused('intakeStamp is off, so no reader is started')
  if (ctx.io.v2?.updateStamps === undefined) return refused('no store to record the try in')
  if (action.key !== intakeKey(issue, action.version)) return refused(`${action.key} is not the key of #${issue} at ${action.version}`)
  const target: Run = { issue, version: action.version }
  const exec = (argv: string[]) => ctx.cmd(argv, { timeoutMs: GH_MS })
  const read = await readIssue(exec, issue)
  if (!read.ok) return { status: 'failed', summary: clip(`#${issue}: ${read.why}`), ...(rateLimited(read.why) ? { rateLimited: true } : {}) }
  const base = defaultBranch(ctx)
  const listing = base === null ? null : await topLevelListing(exec, base)
  const prompt = intakePrompt({ issue, text: read.text, listing, areas: ctx.rt.config.intakeAreas })
  // the try first: whatever happens to the reader, this version is not tried again
  const at = await ctx.io.now()
  let already = false
  const recorded = await ctx.io.v2.updateStamps(raw => {
    if (stampStoreFromStore(raw).tries[String(issue)]?.version === action.version) {
      already = true
      return null
    }
    return withTry(raw, issue, { version: action.version, outcome: 'running', at })
  })
  if (already) return { status: 'done', summary: `#${issue} at ${action.version} was tried already` }
  if (!recorded.saved || !recorded.changed) return { status: 'failed', summary: clip(`#${issue}: the try could not be recorded, so no reader was started`) }
  const input = { subagentType: INTAKE_AGENT, prompt, description: `Stamp #${issue}`, name: `intake-${issue}-${action.version}`, model: ctx.rt.config.intakeModel }
  let spawned: { agentId?: string; deny?: string }
  try {
    spawned = await ctx.io.spawnAgent(input)
  } catch (err) {
    spawned = { deny: `the spawn threw: ${message(err)}` }
  }
  if (spawned.agentId === undefined || spawned.agentId === '') {
    const why = spawned.deny ?? 'started with no agent id'
    await failTry(ctx, target, 'spawn-failed', undefined)
    return { status: 'failed', summary: clip(`${INTAKE_AGENT} for #${issue}: ${why}`) }
  }
  return { status: 'running', agentId: spawned.agentId, summary: clip(`${INTAKE_AGENT} started for #${issue} (${action.version}): ${spawned.agentId}`) }
}

// --- settle -------------------------------------------------------------------------------------------

async function settle(ctx: ExecCtx, action: IntakeAction): Promise<Exec> {
  const issue = action.issue
  if (issue === null) return refused(`${action.key} names no issue`)
  const why = action.why ?? 'lost'
  const target: Run = { issue, version: action.version }
  const entry = ctx.state.ledger.find(e => e.key === intakeKey(issue, action.version))
  let stop = ''
  // the reader still at work is stopped (only an agent of the loop that its entry still runs)
  if (entry !== undefined && entry.status === 'running' && entry.agentId !== undefined) {
    try {
      const r = await ctx.io.stopAgent(entry.agentId)
      stop = r.stopped ? `; stopped ${entry.agentId}` : `; not stopped ${entry.agentId}: ${r.error ?? 'no reason given'}`
    } catch (err) {
      stop = `; not stopped ${entry.agentId}: ${message(err)}`
    }
  }
  const r = await failTry(ctx, target, why, entry)
  if (r === 'unsaved') return { status: 'failed', summary: clip(`#${issue}: the failed try could not be recorded${stop}`) }
  return { status: 'done', summary: clip(`#${issue} at ${action.version}: ${why}${r === 'unchanged' ? ' (the try had ended already)' : ''}${stop}`) }
}

// --- the end of a run -----------------------------------------------------------------------------------

// labelsOf: the issue's labels now, through the reader; null when they cannot be read.
async function labelsOf(ctx: ExecCtx, issue: number): Promise<string[] | null> {
  try {
    const r = await ctx.cmd(['callum-flow-issue-read', '--json', String(issue)], { timeoutMs: GH_MS })
    return r.exitCode === 0 ? (parseIssueRead(r.stdout)?.labels ?? null) : null
  } catch {
    return null
  }
}

// applyLabels: the plan's commands. A label the repo lacks is made first, never with --force. What went
// wrong is named in `problems`; the labels that did not land are not the loop's.
async function applyLabels(ctx: ExecCtx, issue: number, plan: LabelPlan): Promise<{ set: string[]; stored: string[]; problems: string[] }> {
  const problems: string[] = []
  let set = [...plan.add]
  let stored = [...plan.stored]
  const repo = ctx.rt.repo
  if (plan.add.length > 0) {
    for (const name of plan.add) {
      const look = name === NEEDS_DECISION ? NEEDS_DECISION_LABEL : AREA_LABEL
      const made = await ctx.cmd(ARGV.labelMakeArgv(repo, { name, ...look }), { timeoutMs: GH_MS }).catch(err => ({ exitCode: 1, stdout: '', stderr: message(err) }))
      if (made.exitCode !== 0 && !/already exists/i.test(made.stderr + made.stdout)) problems.push(`label ${name} not made: ${clip(made.stderr.trim(), 100)}`)
    }
    const added = await ctx.cmd(ARGV.labelsAddArgv(repo, issue, plan.add), { timeoutMs: GH_MS }).catch(err => ({ exitCode: 1, stdout: '', stderr: message(err) }))
    if (added.exitCode !== 0) {
      problems.push(`labels not added: ${clip(added.stderr.trim(), 100)}`)
      set = []
      stored = stored.filter(l => !plan.add.includes(l))
    }
  }
  if (plan.remove.length > 0) {
    const removed = await ctx.cmd(ARGV.labelClearArgv(repo, issue, plan.remove), { timeoutMs: GH_MS }).catch(err => ({ exitCode: 1, stdout: '', stderr: message(err) }))
    if (removed.exitCode !== 0) {
      problems.push(`labels not removed: ${clip(removed.stderr.trim(), 100)}`)
      stored = [...stored, ...plan.remove]
    }
  }
  return { set, stored, problems }
}

const reasonOf = (r: IntakeResult): string | null => {
  const text = r.kind === 'failed' ? (r.problems[0] ?? 'no answer') : r.reason
  return text === null ? null : clip(text, REASON_MAX)
}

// intakeFinish: the end of a run, once its reader's turn ended: the entry is the run's, running. Never
// throws. Its Exec ends the entry: done once the try is stored (whatever the outcome), failed when the store
// would not take it (I1 then settles the try, which writes the event).
export async function intakeFinish(ctx: ExecCtx, entry: LedgerEntry, answer: { answer: string; reason: string }): Promise<Exec> {
  try {
    return await finish(ctx, entry, answer)
  } catch (err) {
    return { status: 'failed', summary: clip(`${entry.key}: the end of the run threw: ${message(err)}`) }
  }
}

async function finish(ctx: ExecCtx, entry: LedgerEntry, answer: { answer: string; reason: string }): Promise<Exec> {
  const key = intakeRunOf(entry.key)
  if (key === null) return refused(`${entry.key} is no intake run`)
  const { issue, version } = key
  const target: Run = { issue, version }
  const update = ctx.io.v2?.updateStamps
  if (update === undefined) return refused('no store to record the outcome in')
  const store = await peek(ctx)
  const cur = store?.tries[String(issue)]
  if (store === null || cur === undefined || cur.version !== version || cur.outcome !== 'running') {
    return { status: 'done', summary: clip(`#${issue} at ${version}: the answer came after the try ended; dropped`) }
  }
  const result = answer.reason === 'answer' ? parseIntakeAnswer(answer.answer, ctx.rt.config.intakeAreas) : null
  const told: Told =
    result === null
      ? { outcome: 'failed', result: null, reason: clip(`ended without an answer (${answer.reason})`, REASON_MAX), labelsSet: [], labelsKept: [] }
      : { outcome: result.kind, result, reason: reasonOf(result), labelsSet: [], labelsKept: [] }
  const problems: string[] = []
  let stamp: { area: string; needsOwner: boolean; touches: string[]; stored: string[] } | null = null
  let owned: LabelGroup[] = []
  if (result !== null && result.kind === 'ok' && result.area !== null && result.needsOwner !== null && result.touches !== null) {
    const prev = store.stamps[String(issue)] ?? null
    const current = await labelsOf(ctx, issue)
    let stored = prev?.labels ?? []
    if (current === null) problems.push('labels not read, so none set')
    else {
      const plan = planLabels({ current, prev, owned: store.owned[String(issue)] ?? [], area: result.area, needsOwner: result.needsOwner })
      const applied = await applyLabels(ctx, issue, plan)
      stored = applied.stored
      owned = plan.owned
      told.labelsSet = applied.set
      told.labelsKept = plan.kept
      problems.push(...applied.problems)
    }
    stamp = { area: result.area, needsOwner: result.needsOwner, touches: result.touches, stored }
  }
  const at = await ctx.io.now()
  const saved = await update(raw => {
    const now = stampStoreFromStore(raw).tries[String(issue)]
    if (now === undefined || now.version !== version || now.outcome !== 'running') return null
    let next: Record<string, unknown> = withTry(raw, issue, { version, outcome: told.outcome, at, ...(told.reason === null || told.outcome !== 'failed' ? {} : { reason: told.reason }) })
    if (stamp !== null) next = withStamp(next, issue, { version, area: stamp.area, needsOwner: stamp.needsOwner, touches: stamp.touches, at, labels: stamp.stored })
    if (owned.length > 0) next = withOwned(next, issue, owned)
    return next
  })
  if (!saved.saved) return { status: 'failed', summary: clip(`#${issue} at ${version}: ${told.outcome}, but the store would not take it`) }
  if (!saved.changed) return { status: 'done', summary: clip(`#${issue} at ${version}: the try ended before the answer was stored; dropped`) }
  const logged = await logTry(ctx, target, told, entry)
  if (logged !== '') problems.push(logged)
  const set = told.labelsSet.length > 0 ? `; set ${told.labelsSet.join(', ')}` : ''
  const kept = told.labelsKept.length > 0 ? `; kept ${told.labelsKept.join(', ')}` : ''
  return { status: 'done', summary: clip(`#${issue} at ${version}: ${told.outcome}${set}${kept}${problems.length > 0 ? `; ${problems.join('; ')}` : ''}`) }
}

// --- the executor -------------------------------------------------------------------------------------

export const intakeExecutor: Executor = async (ctx, action) => {
  if (action.kind !== 'intake-stamp') return refused(`the intake-stamp executor got a ${action.kind} action`)
  return action.op === 'settle' ? settle(ctx, action) : run(ctx, action)
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'intake-stamp': intakeExecutor }
