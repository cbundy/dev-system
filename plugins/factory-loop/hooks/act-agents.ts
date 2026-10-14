// The agent executors (SPEC 6.1): `spawn` (designer, adjudicator, fixer) and `delegate` (route,
// the `delegated` event, then the implementer), and onAgentAnswer and onToolAnswer, which read
// an agent's answer, from its turn.complete or its answer tool (#548), into the outcome plan
// reads next pass. They decide nothing (plan did): the prompt comes from prompts.ts and the
// reading of the reply from replies.ts and agent-tools.ts, all pure, and readAnswer and
// readToolAnswer below are pure too, so tests and the replay harness drive them without the
// engine. Every answer in text is saved whole first (exec.ts answerPath), so a judge(report) or
// judge(handoff) wake points the model at the file (SPEC 7.2); a tool call's input is saved once
// the call has its answer (#558).
import { TOOL_OF, checkDesign, checkHandoff, checkVerdict } from './agent-tools'
import type { ToolCheck } from './agent-tools'
import { answerPath, detailOf, rateLimited } from './exec'
import type { AgentAnswer, EventFields, Exec, ExecCtx, Executor, RunResult, SpawnInput } from './exec'
import { descriptionOf, nameOf, promptOf } from './prompts'
import type { AgentAction, InFlight, PromptEnv } from './prompts'
import { isBriefUrl, readAdjudicator, readDesigner, readHandoff } from './replies'
import type { AdjudicatorOutcome, DesignResult, HandoffOutcome } from './replies'
import type { ActionKind, AdjudicatorPurpose, AgentStatus, AgentType, LedgerEntry, State } from './types'

// callum-flow-implementer-route's timeout (SPEC 6.1: route 60 s).
export const ROUTE_TIMEOUT_MS = 60_000
// The exit recorded for a command that never exited (it could not start, or timed out).
const NO_EXIT = -1
const SUMMARY_MAX = 200
const PURPOSES: readonly AdjudicatorPurpose[] = ['gate', 'weakening', 'merge']
const MODEL = /^[A-Za-z0-9._-]+$/

// --- pure helpers ------------------------------------------------------------------------------

// agentOf: the agent an entry ran: its spawn's type; a delegate's is the implementer.
export function agentOf(entry: LedgerEntry): AgentType | null {
  if (entry.kind === 'delegate') return 'implementer'
  return entry.kind === 'spawn' ? (entry.agent ?? null) : null
}

// purposeOfKey: an adjudicator's purpose, from plan's key families (adjudicate:,
// adjudicate-weakening:, adjudicate-merge:).
export function purposeOfKey(key: string): AdjudicatorPurpose | null {
  if (key.startsWith('adjudicate-merge:')) return 'merge'
  if (key.startsWith('adjudicate-weakening:')) return 'weakening'
  if (key.startsWith('adjudicate:')) return 'gate'
  return null
}

// routedModel: callum-flow-implementer-route prints exactly one line, the model alias the
// implementer runs on (images/base/callum-flow-implementer-route); anything else is null.
export function routedModel(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  const only = lines.length === 1 ? lines[0] : undefined
  return only !== undefined && MODEL.test(only) ? only : null
}

// modelLabelOf: the issue's `model:<alias>` label (lower-cased, the first in sorted order, as
// plan reads it), which the implementer passes on to the sub-agents it spawns.
export function modelLabelOf(state: State, issue: number | null): string | null {
  const labels = (state.issues.find(i => i.number === issue)?.labels ?? [])
    .map(l => l.toLowerCase())
    .filter(l => l.startsWith('model:'))
    .sort()
  const first = labels[0]?.slice('model:'.length)
  return first !== undefined && MODEL.test(first) ? first : null
}

// inFlightOf: the other issues' current branches, for the designer (orchestrator skill step 2).
export function inFlightOf(state: State, issue: number | null): InFlight[] {
  return state.runs
    .filter(r => !r.superseded && r.issue !== issue)
    .map(r => ({ branch: r.branch, issue: r.issue }))
    .sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
}

export type SpawnOptions = {
  repo: string
  attempt: number
  // the model to run on: the issue's label for a spawn, the route's answer for a delegate
  model: string | null
  modelOverride: string | null
  inFlight: InFlight[]
  notes?: readonly string[]
  // config answerTools: the prompt asks for the agent's answer tool first (#560)
  answerTools?: boolean
}

// notesOf: the owner's notes for an issue, and those for every issue, oldest first (SPEC 4.3).
export function notesOf(state: State, issue: number | null): string[] {
  return state.control.notes.filter(note => note.issue === null || note.issue === issue).map(note => note.text)
}

// The agent type each agent is spawned as. The callum-flow adjudicator and designer list their
// tools, and an agent calls nothing its list leaves out, so they could never reach their answer
// tools (#548): the loop spawns its own copies of them (agents/*.md), the same definitions with
// ToolSearch and the answer tool added to `tools:`, which tests/factory-loop-agents.test.js keeps
// in step. The implementer and fixer list no tools, so they inherit every one.
export const SUBAGENT_OF: Record<AgentType, string> = {
  adjudicator: 'factory-loop:adjudicator',
  designer: 'factory-loop:designer',
  implementer: 'callum-flow:implementer',
  fixer: 'callum-flow:fixer',
}

// spawnInputOf: what $.agent.spawn gets: the agent's type, its prompt, and the issue in the
// description and name (D-11). No model leaves the agent's frontmatter model in charge.
export function spawnInputOf(action: AgentAction, opts: SpawnOptions): SpawnInput {
  const type: AgentType = action.kind === 'delegate' ? 'implementer' : action.agent
  const env: PromptEnv = { repo: opts.repo, modelOverride: opts.modelOverride, inFlight: opts.inFlight, notes: opts.notes ?? [], answerTools: opts.answerTools === true }
  const input: SpawnInput = {
    subagentType: SUBAGENT_OF[type],
    prompt: promptOf(action, env),
    description: descriptionOf(action),
    name: nameOf(action, opts.attempt),
  }
  if (opts.model !== null && MODEL.test(opts.model)) input.model = opts.model
  return input
}

// --- what a spawn leaves for its answer -----------------------------------------------------------

// The spawn record: written before the spawn, read back with the answer. It holds what the
// ledger entry has no field for: the branch the spawn named (the adjudicator's verdict events
// carry it; a fixer that reports another one supersedes the old run) and the adjudicator's
// purpose. The prompt is kept for the owner, beside the answer.
export type SpawnRecord = {
  key: string
  attempt: number
  agent: AgentType
  purpose: AdjudicatorPurpose | null
  issue: number | null
  run: string | null
  branch: string | null
  subagentType: string
  model: string | null
  prompt: string
}

export function spawnRecordPath(loopDir: string, key: string): string {
  return `${loopDir}/spawns/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`
}

function recordOf(action: AgentAction, input: SpawnInput, attempt: number): SpawnRecord {
  const spawn = action.kind === 'spawn' ? action : null
  const branch = spawn !== null && spawn.agent !== 'designer' && spawn.branch !== '' ? spawn.branch : null
  return {
    key: action.key,
    attempt,
    agent: action.kind === 'delegate' ? 'implementer' : action.agent,
    purpose: spawn?.agent === 'adjudicator' ? spawn.purpose : null,
    issue: action.issue,
    run: spawn !== null && spawn.agent !== 'designer' ? spawn.run : null,
    branch,
    subagentType: input.subagentType,
    model: input.model ?? null,
    prompt: input.prompt,
  }
}

// parseRecord: a saved spawn record's branch and purpose, or null when it does not read.
export function parseRecord(text: string | null): Pick<SpawnRecord, 'branch' | 'purpose'> | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    if (v === null || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    return {
      branch: typeof r.branch === 'string' && r.branch !== '' ? r.branch : null,
      purpose: PURPOSES.find(p => p === r.purpose) ?? null,
    }
  } catch {
    return null
  }
}

// --- reading an answer --------------------------------------------------------------------------

export type AgentEvent = { state: string; fields: EventFields }
export type AnswerInfo = {
  repo: string
  // the branch the spawn named (spawn record, else the run's branch in the state)
  branch: string | null
  // the spawn record's purpose, when the key does not say
  purpose: AdjudicatorPurpose | null
}
// problem: what kept an answer from being read (no machine line), for the repair message (#548)
export type AnswerRead = { exec: Exec; events: AgentEvent[]; problem: string | null }
type AgentOutcome = DesignResult | AdjudicatorOutcome | HandoffOutcome

// readAnswer: an agent's answer as an Exec, and the events its outcome logs (SPEC 7.3, 7.4):
// - a turn that ended in error, aborted or refused is a failed attempt (SPEC 10.4);
// - the designer's report is done, parsed or { unparsed: true } (rule D3 sends that one to the
//   model);
// - the adjudicator's reply is done with its verdict lines, each logged as a `verdict` event,
//   or a failed attempt when it does not parse (rule P2 retries);
// - an implementer's or fixer's handoff is done with its fields, or failed when it does not
//   parse; a fixer that reports a branch other than the one it was sent to supersedes the old
//   run (I-39).
// A reply with no machine line says why, in its summary and in problem.
export function readAnswer(entry: LedgerEntry, answer: AgentAnswer, info: AnswerInfo): AnswerRead {
  const type = agentOf(entry)
  const who = `${type ?? entry.kind} #${entry.issue ?? '?'}`
  const failed = (summary: string, problem: string | null = null, noRetry = false): AnswerRead => ({
    exec: noRetry ? { status: 'failed', summary: clip(summary), noRetry } : { status: 'failed', summary: clip(summary) },
    events: [],
    problem,
  })
  if (type === null) return failed(`${entry.key}: no agent entry`, null, true)
  if (answer.reason !== 'answer') return failed(`${who}: its turn ended: ${answer.reason}`)
  if (type === 'designer') {
    const r = readDesigner(answer.answer, info.repo, entry.issue)
    if (typeof r !== 'string') return doneRead(entry, type, r, info, 'text')
    const exec: Exec = { status: 'done', outcome: { kind: 'designer', unparsed: true }, summary: clip(`${who}: ${r}; the report is saved for judge(report)`) }
    return { exec, events: [], problem: r }
  }
  if (type === 'adjudicator') {
    const purpose = purposeOfKey(entry.key) ?? info.purpose
    if (purpose === null) return failed(`${who}: ${entry.key} names no adjudicator purpose`, null, true)
    const r = readAdjudicator(answer.answer, purpose)
    return typeof r === 'string' ? failed(`${who}: the ${purpose} reply does not parse: ${r}`, r) : doneRead(entry, type, r, info, 'text')
  }
  const r = readHandoff(answer.answer, type === 'fixer' ? info.branch : null)
  return typeof r === 'string' ? failed(`${who}: the handoff does not parse: ${r}`, r) : doneRead(entry, type, r, info, 'text')
}

// readToolAnswer: an agent's answer through its tool (agent-tools.ts), read as readAnswer reads
// its text: the same outcome and events, or why the call is refused (another agent's tool, an
// input that breaks the contract), which the agent reads and corrects. Pure.
export function readToolAnswer(entry: LedgerEntry, tool: string, input: unknown, info: AnswerInfo): AnswerRead | { refused: string } {
  const type = agentOf(entry)
  if (type === null) return { refused: `${entry.key} ran no agent` }
  if (tool !== TOOL_OF[type]) return { refused: `${tool} is not the answer of a ${type}: call ${TOOL_OF[type]} instead` }
  let check: ToolCheck<AgentOutcome>
  if (type === 'designer') check = checkDesign(input, info.repo, entry.issue)
  else if (type === 'adjudicator') {
    const purpose = purposeOfKey(entry.key) ?? info.purpose
    if (purpose === null) return { refused: 'the loop cannot tell which review this is: reply in your output contract instead' }
    check = checkVerdict(input, purpose)
  } else check = checkHandoff(input, type === 'fixer' ? info.branch : null)
  return check.ok ? doneRead(entry, type, check.outcome, info, 'tool') : { refused: `${check.problems.join('; ')}. Correct the call and call ${tool} again` }
}

// doneRead: a read outcome as a done Exec and the events it logs, whichever channel gave it; a
// tool answer says so in its summary.
function doneRead(entry: LedgerEntry, type: AgentType, outcome: AgentOutcome, info: AnswerInfo, via: 'text' | 'tool'): AnswerRead {
  const who = (inner: string[]) => {
    const all = via === 'tool' ? [...inner, 'tool'] : inner
    return `${type} #${entry.issue ?? '?'}${all.length === 0 ? '' : ` (${all.join(', ')})`}`
  }
  const done = (summary: string, events: AgentEvent[] = []): AnswerRead => ({ exec: { status: 'done', outcome, summary: clip(summary) }, events, problem: null })
  if (outcome.kind === 'designer') {
    return done(`${who([])}: brief ${outcome.brief ?? 'none'}, created ${outcome.created.join(',') || 'none'}, pending decision ${outcome.pendingDecision ? 'yes' : 'no'}`)
  }
  if (outcome.kind === 'adjudicator') {
    const purpose = purposeOfKey(entry.key) ?? info.purpose ?? 'gate'
    const events = outcome.verdicts.map(line => ({
      state: 'verdict',
      fields: { issue: entry.issue, run: entry.run, branch: info.branch, note: line },
    }))
    const report = outcome.report === null ? '' : `, bump ${outcome.report.bump}, flags ${outcome.report.flags.join(',') || 'none'}`
    const n = outcome.verdicts.length
    return done(`${who([purpose])}: ACTION ${outcome.action.type}, ${n} verdict line${n === 1 ? '' : 's'}${report}`, events)
  }
  const named = type === 'fixer' ? info.branch : null
  const events: AgentEvent[] = []
  if (type === 'fixer' && outcome.newBranch !== null && named !== null && entry.run !== null) {
    events.push({ state: 'superseded', fields: { issue: entry.issue, run: entry.run, note: `by ${outcome.newBranch}` } })
  }
  const parts = [`run ${outcome.run ?? 'none'}`, `head ${outcome.head ?? 'none'}`]
  if (outcome.notGated) parts.push('NOT GATED')
  if (outcome.newBranch !== null) parts.push(`branch ${outcome.newBranch}`)
  return done(`${who([])}: ${parts.join(', ')}`, events)
}

// --- an interim answer (#545) ----------------------------------------------------------------

// One row of the agent list as the interim check reads it.
export type ListedLoop = { id: string; status: AgentStatus; parentId?: string }

const AT_WORK: readonly AgentStatus[] = ['pending', 'running', 'waiting']

// interim: an answer that ended its turn with no machine line (the designer's RESULT, the
// adjudicator's reply, a handoff's RESULT or NOT GATED), which an agent still at work may give
// before its final one. A turn that failed, and an answer read as a loop bug, are never interim.
export function interim(answer: AgentAnswer, exec: Exec): boolean {
  if (answer.reason !== 'answer') return false
  if (exec.status === 'failed') return exec.noRetry !== true
  return exec.status === 'done' && exec.outcome?.kind === 'designer' && 'unparsed' in exec.outcome
}

// stillAtWork: the agent list shows the agent holding background work (`waiting`), or a
// sub-agent it started still at work. Its own `running` proves nothing at its turn.complete: an
// agent that just ended is listed so until the engine marks it idle or completed.
export function stillAtWork(agents: readonly ListedLoop[], id: string): boolean {
  return agents.some(a => (a.id === id && a.status === 'waiting') || (a.parentId === id && AT_WORK.includes(a.status)))
}

// What goes between an answer and the reply to its repair message in the saved file.
export const REPAIR_REPLY = "--- the reply to the factory loop's repair message ---"

// onAgentAnswer: an agent of the loop finished (its turn.complete). The answer is saved whole,
// then read, and the events its outcome logs go out; the driver records the Exec, or first sends
// the agent the repair message for the problem (act.ts agentAnswered). The reply to a repair goes
// after the answer it repairs, never over it: a designer's report is what judge(report) reads
// (rule D3), and the reply is a line at most. A failed save or event is noted in the summary but
// keeps the reading: re-running an agent costs far more.
export async function onAgentAnswer(ctx: ExecCtx, entry: LedgerEntry, answer: AgentAnswer): Promise<{ exec: Exec; problem: string | null }> {
  const notes: string[] = []
  const path = answerPath(ctx.rt.loopDir, entry.key)
  try {
    const before = entry.reminded === true ? await ctx.io.readFile(path) : null
    await ctx.io.writeFile(path, before === null ? answer.answer : `${before.replace(/\n*$/, '')}\n\n${REPAIR_REPLY}\n\n${answer.answer}`)
  } catch (err) {
    notes.push(`answer not saved: ${message(err)}`)
  }
  const read = readAnswer(entry, answer, await answerInfoOf(ctx, entry))
  notes.push(...(await logEvents(ctx, read.events)))
  return { exec: noted(read.exec, notes), problem: read.problem }
}

// onToolAnswer: an agent of the loop called its answer tool, read against its spawn record. A
// call the contract refuses changes nothing. An accepted one has its input saved (as JSON) before
// the driver records it, so a pass that acts on the answer (judge(handoff) points the model at the
// saved answer) finds it there; a call then refused for time leaves the file to the text answer,
// which writes it again. It gives the Exec the driver records at once, as for an answer in text,
// and `after`, what follows once the call has its answer (#558): its events logged, through the
// ExecCtx it is handed; notes on what failed, for the decision log.
export async function onToolAnswer(
  ctx: ExecCtx,
  entry: LedgerEntry,
  tool: string,
  input: unknown,
): Promise<{ exec: Exec; after: (later: ExecCtx) => Promise<string[]> } | { refused: string }> {
  const read = readToolAnswer(entry, tool, input, await answerInfoOf(ctx, entry))
  if ('refused' in read) return read
  const saved: string[] = []
  try {
    await ctx.io.writeFile(answerPath(ctx.rt.loopDir, entry.key), JSON.stringify({ tool, input }, null, 2))
  } catch (err) {
    saved.push(`answer not saved: ${message(err)}`)
  }
  const after = async (later: ExecCtx): Promise<string[]> => [...saved, ...(await logEvents(later, read.events))]
  return { exec: read.exec, after }
}

// answerInfoOf: what reading an answer needs beside the entry: the branch and purpose its spawn
// record names. With no record, the run's branch in the state stands in.
async function answerInfoOf(ctx: ExecCtx, entry: LedgerEntry): Promise<AnswerInfo> {
  let record: Pick<SpawnRecord, 'branch' | 'purpose'> | null = null
  try {
    record = parseRecord(await ctx.io.readFile(spawnRecordPath(ctx.rt.loopDir, entry.key)))
  } catch {
    // no record
  }
  const branch = record?.branch ?? (entry.run === null ? null : (ctx.state.runs.find(r => r.run === entry.run)?.branch ?? null))
  return { repo: ctx.rt.repo, branch, purpose: record?.purpose ?? null }
}

// logEvents: the events an outcome logs; a note when some could not be.
async function logEvents(ctx: ExecCtx, events: readonly AgentEvent[]): Promise<string[]> {
  let missed = 0
  for (const e of events) {
    try {
      await ctx.event(e.state, e.fields)
    } catch {
      missed += 1
    }
  }
  return missed > 0 ? [`${missed} of ${events.length} events not logged`] : []
}

function noted(exec: Exec, notes: readonly string[]): Exec {
  return notes.length === 0 ? exec : { ...exec, summary: clip(`${exec.summary}; ${notes.join('; ')}`) }
}

// --- the executors --------------------------------------------------------------------------------

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

// start: write the spawn record, then spawn. A deny, a throw or a start with no agent id is a
// failed attempt; a started agent runs on, and its turn.complete ends the entry.
async function start(ctx: ExecCtx, action: AgentAction, model: string | null, env: Omit<PromptEnv, 'repo'>): Promise<Exec> {
  const input = spawnInputOf(action, { repo: ctx.rt.repo, attempt: ctx.entry.attempts, model, answerTools: ctx.rt.config.answerTools, ...env })
  let saved = true
  try {
    const record = recordOf(action, input, ctx.entry.attempts)
    await ctx.io.writeFile(spawnRecordPath(ctx.rt.loopDir, action.key), JSON.stringify(record, null, 2))
  } catch {
    saved = false
  }
  let r: { agentId?: string; deny?: string }
  try {
    r = await ctx.io.spawnAgent(input)
  } catch (err) {
    return { status: 'failed', summary: clip(`${input.subagentType}: the spawn threw: ${message(err)}`) }
  }
  if (typeof r.deny === 'string') return { status: 'failed', summary: clip(`${input.subagentType} denied: ${r.deny}`) }
  if (r.agentId === undefined || r.agentId === '') return { status: 'failed', summary: `${input.subagentType}: started with no agent id` }
  const on = input.model === undefined ? '' : ` (${input.model})`
  const note = saved ? '' : '; spawn record not saved'
  return { status: 'running', agentId: r.agentId, summary: clip(`${input.subagentType}${on} started for #${action.issue}: ${r.agentId}${note}`) }
}

// spawn: the designer, an adjudicator or a fixer, on the issue's model label when it has one.
const spawn: Executor = async (ctx, action) => {
  if (action.kind !== 'spawn') return refused(`the spawn executor got a ${action.kind} action`)
  if (action.issue === null) return refused(`${action.key} names no issue`)
  const inFlight = action.agent === 'designer' ? inFlightOf(ctx.state, action.issue) : []
  return start(ctx, action, action.model, { modelOverride: action.model, inFlight, notes: notesOf(ctx.state, action.issue) })
}

// delegate: `callum-flow-implementer-route <N>`, then `callum-flow-event delegated --issue <N>
// --note "brief <url>"`, then the implementer on the routed model (SPEC 6.1, I-32). A route
// that fails, or prints no model, ends it before anything is logged.
const delegate: Executor = async (ctx, action) => {
  if (action.kind !== 'delegate') return refused(`the delegate executor got a ${action.kind} action`)
  const n = action.issue
  if (n === null) return refused(`${action.key} names no issue`)
  // a brief travels as its URL only (I-33); anything else here is a loop bug
  if (!isBriefUrl(action.brief, ctx.rt.repo)) return refused(`${action.key}: the brief is not a comment URL on ${ctx.rt.repo}`)
  const argv = ['callum-flow-implementer-route', String(n)]
  let r: RunResult
  try {
    r = await ctx.cmd(argv, { timeoutMs: ROUTE_TIMEOUT_MS })
  } catch (err) {
    return { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv[0]}: ${message(err)}`) }
  }
  if (r.exitCode !== 0) return routeFailure(r)
  const model = routedModel(r.stdout)
  if (model === null) {
    const detail = `printed no model: ${JSON.stringify(r.stdout.trim().slice(0, 200))}`
    return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail }, summary: clip(`${argv[0]} ${detail}`) }
  }
  try {
    await ctx.event('delegated', { issue: n, note: `brief ${action.brief}` })
  } catch (err) {
    return eventFailure('delegated', err)
  }
  return start(ctx, action, model, { modelOverride: modelLabelOf(ctx.state, n), inFlight: [], notes: notesOf(ctx.state, n) })
}

// Exit 2 is the route's usage error, a loop bug never retried (SPEC 10.1).
function routeFailure(r: RunResult): Exec {
  const line = lastLine(r.stderr) || lastLine(r.stdout)
  const exec: Extract<Exec, { status: 'failed' }> = {
    status: 'failed',
    outcome: { kind: 'cli', exit: r.exitCode, detail: detailOf(r) },
    summary: clip(`callum-flow-implementer-route: exit ${r.exitCode}${line === '' ? '' : `: ${line}`}`),
  }
  if (r.exitCode === 2) exec.noRetry = true
  if (rateLimited(r.stderr)) exec.rateLimited = true
  return exec
}

// callum-flow-event exits non-zero only on a usage error (exit 2), never retried.
function eventFailure(state: string, err: unknown): Exec {
  const code = typeof err === 'object' && err !== null ? (err as { exitCode?: unknown }).exitCode : undefined
  const exit = typeof code === 'number' ? code : NO_EXIT
  const exec: Extract<Exec, { status: 'failed' }> = {
    status: 'failed',
    outcome: { kind: 'cli', exit, detail: message(err).slice(0, 2000) },
    summary: clip(`event ${state}: ${message(err)}`),
  }
  if (exit === 2) exec.noRetry = true
  return exec
}

export const agentExecutors: Partial<Record<ActionKind, Executor>> = { spawn, delegate }

// --- small text helpers ---------------------------------------------------------------------

function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '')
      .pop() ?? ''
  )
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
