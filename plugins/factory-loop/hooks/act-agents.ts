// The agent executors (SPEC 6.1): `spawn` (designer, adjudicator, fixer) and `delegate` (route,
// the `delegated` event, then the implementer), and onAgentAnswer and onToolAnswer, which read
// an agent's answer, from its turn.complete (the file it recorded with the answer script, #561,
// else its text) or its answer tool (#548), into the outcome plan reads next pass. They decide
// nothing (plan did): the prompt comes from prompts.ts and the reading of the answer from
// replies.ts and contract.mjs, all pure, and readAnswer, readScriptAnswer and readToolAnswer
// below are pure too, so tests and the replay harness drive them without the engine. Every
// answer in text is saved whole first (exec.ts answerPath), so a judge(report) or judge(handoff)
// wake points the model at the file (SPEC 7.2); a tool call's input is saved once the call has
// its answer (#558).
import { TOOL_OF } from './agent-tools'
import { CONTRACT_OF, checkAnswer, jobPathOf, jobText, parseAnswer } from './contract.mjs'
import type { AnswerOutcome, Check, Job } from './contract.mjs'
import { ANSWER_SCRIPT, answerPath, detailOf, rateLimited, scriptAnswerPath } from './exec'
import type { AgentAnswer, EventFields, Exec, ExecCtx, Executor, RunResult, SpawnInput } from './exec'
import type { Runtime } from './observe'
import { descriptionOf, nameOf, promptOf, scriptShaped } from './prompts'
import type { AgentAction, InFlight, PromptEnv, ScriptPlace } from './prompts'
import { isBriefUrl, readAdjudicator, readDesigner, readHandoff } from './replies'
import type { ActionKind, AdjudicatorPurpose, AgentStatus, AgentType, AnswerChannel, LedgerEntry, State } from './types'

// callum-flow-implementer-route's timeout (SPEC 6.1: route 60 s).
export const ROUTE_TIMEOUT_MS = 60_000
// The exit recorded for a command that never exited (it could not start, or timed out).
const NO_EXIT = -1
const SUMMARY_MAX = 200
const PURPOSES: readonly AdjudicatorPurpose[] = ['gate', 'weakening', 'merge']
const CHANNELS: readonly AnswerChannel[] = ['script', 'tool', 'text']
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
  // the channel the prompt asks for (config answerChannel), and for the script channel the
  // script and this attempt's answer file (#561)
  channel?: AnswerChannel
  script?: ScriptPlace | null
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
  const env: PromptEnv = { repo: opts.repo, modelOverride: opts.modelOverride, inFlight: opts.inFlight, notes: opts.notes ?? [], channel: opts.channel ?? 'text', script: opts.script ?? null }
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
// carry it; a fixer that reports another one supersedes the old run), the adjudicator's purpose,
// and the channel the prompt asked for, with the answer file it named for the script (#561), so
// a repair message asks again the way the agent was first asked. The prompt is kept for the
// owner, beside the answer.
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
  channel: AnswerChannel
  answerFile: string | null
  prompt: string
}

export function spawnRecordPath(loopDir: string, key: string): string {
  return `${loopDir}/spawns/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`
}

function recordOf(action: AgentAction, input: SpawnInput, attempt: number, script: ScriptPlace | null, channel: AnswerChannel): SpawnRecord {
  const spawn = action.kind === 'spawn' ? action : null
  return {
    key: action.key,
    attempt,
    agent: action.kind === 'delegate' ? 'implementer' : action.agent,
    purpose: spawn?.agent === 'adjudicator' ? spawn.purpose : null,
    issue: action.issue,
    run: spawn !== null && spawn.agent !== 'designer' ? spawn.run : null,
    branch: namedBranchOf(action),
    subagentType: input.subagentType,
    model: input.model ?? null,
    channel,
    answerFile: script?.file ?? null,
    prompt: input.prompt,
  }
}

// namedBranchOf: the branch a spawn names (an adjudicator's or fixer's), or null.
function namedBranchOf(action: AgentAction): string | null {
  const spawn = action.kind === 'spawn' ? action : null
  return spawn !== null && spawn.agent !== 'designer' && spawn.branch !== '' ? spawn.branch : null
}

// parseRecord: a saved spawn record's branch, purpose and channel, or null when it does not read.
// A record from before the channel was kept names none.
export function parseRecord(text: string | null): (Pick<SpawnRecord, 'branch' | 'purpose'> & { channel: AnswerChannel | null }) | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    if (v === null || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    return {
      branch: typeof r.branch === 'string' && r.branch !== '' ? r.branch : null,
      purpose: PURPOSES.find(p => p === r.purpose) ?? null,
      channel: CHANNELS.find(c => c === r.channel) ?? null,
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
  // the channel the spawn's prompt asked for (its record), null when not known
  channel?: AnswerChannel | null
}
// problem: what kept an answer from being read (no machine line), for the repair message (#548)
export type AnswerRead = { exec: Exec; events: AgentEvent[]; problem: string | null }
// How an answer came: recorded with the answer script, through the tool, or in text.
export type AnswerVia = 'script' | 'tool' | 'text'

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

// jobOf: what checking this entry's answer needs, from what the loop knows itself (the entry, its
// spawn record and the runtime): the contract of its agent, the review's purpose, the repo and
// issue a brief must be on, the branch a fixer was sent to. Every structured answer is checked
// against it (contract.mjs checkAnswer), never against anything the agent wrote; null when the
// loop cannot tell which review an adjudicator's is.
export function jobOf(entry: LedgerEntry, type: AgentType, info: AnswerInfo): Job | null {
  const purpose = type === 'adjudicator' ? (purposeOfKey(entry.key) ?? info.purpose) : null
  if (type === 'adjudicator' && purpose === null) return null
  return { contract: CONTRACT_OF[type], purpose, repo: info.repo, issue: entry.issue, branch: type === 'fixer' ? info.branch : null }
}

// readToolAnswer: an agent's answer through its tool (agent-tools.ts), read as readAnswer reads
// its text: the same outcome and events, or why the call is refused (another agent's tool, an
// input that breaks the contract), which the agent reads and corrects. Pure.
export function readToolAnswer(entry: LedgerEntry, tool: string, input: unknown, info: AnswerInfo): AnswerRead | { refused: string } {
  const type = agentOf(entry)
  if (type === null) return { refused: `${entry.key} ran no agent` }
  if (tool !== TOOL_OF[type]) return { refused: `${tool} is not the answer of a ${type}: call ${TOOL_OF[type]} instead` }
  const job = jobOf(entry, type, info)
  if (job === null) return { refused: 'the loop cannot tell which review this is: reply in your output contract instead' }
  const check = checkAnswer(job, input)
  return check.ok ? doneRead(entry, type, check.outcome, info, 'tool') : { refused: `${check.problems.join('; ')}. Correct the call and call ${tool} again` }
}

// readScriptAnswer: the file an agent recorded with the answer script (#561), read and checked
// again against the job the loop knows (jobOf), never the job file beside it, so it means exactly
// what the same answer through the tool or in text means: the same outcome and events, or what
// is wrong with it, for the repair message. Pure.
export function readScriptAnswer(entry: LedgerEntry, body: string, info: AnswerInfo): AnswerRead | { problem: string } {
  const type = agentOf(entry)
  if (type === null) return { problem: `${entry.key} ran no agent` }
  const job = jobOf(entry, type, info)
  if (job === null) return { problem: 'the factory loop cannot tell which review this is' }
  const file = parseAnswer(body, job.contract)
  const check: Check<AnswerOutcome> = file.ok ? checkAnswer(job, file.outcome) : file
  return check.ok ? doneRead(entry, type, check.outcome, info, 'script') : { problem: `the answer recorded with the answer script does not pass its checks: ${check.problems.join('; ')}` }
}

// doneRead: a read outcome as a done Exec and the events it logs, whichever channel gave it; an
// answer through the tool or the script says so in its summary.
function doneRead(entry: LedgerEntry, type: AgentType, outcome: AnswerOutcome, info: AnswerInfo, via: AnswerVia): AnswerRead {
  const who = (inner: string[]) => {
    const all = via === 'text' ? inner : [...inner, via]
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
// What goes between an agent's final message and the answer it recorded with the answer script.
export const SCRIPT_RECORD = '--- the answer recorded with the answer script ---'

// scriptPlaceOf: the answer script and the answer file of an entry's attempt (#561): the paths a
// spawn's prompt names, and the only answer file read for that attempt.
export function scriptPlaceOf(rt: Pick<Runtime, 'pluginRoot' | 'loopDir'>, entry: Pick<LedgerEntry, 'key' | 'attempts' | 'startedAt'>): ScriptPlace {
  return { bin: `${rt.pluginRoot}/${ANSWER_SCRIPT}`, file: scriptAnswerPath(rt.loopDir, entry) }
}

// What an agent's turn.complete gave: the Exec to record, the problem for the repair message,
// how the answer came (via: the answer script's file, else its text), what kept a recorded file
// out (scriptProblem, for the decision log), and the channel its spawn was asked on (null: not
// known, so the setting's).
export type AnswerTaken = { exec: Exec; problem: string | null; via: 'script' | 'text'; scriptProblem?: string; channel: AnswerChannel | null }

// onAgentAnswer: an agent of the loop finished (its turn.complete). Its text is saved whole
// first. Then the answer it recorded with the answer script (#561) is read, only at the path
// issued for this attempt (scriptPlaceOf), and checked again; with none there, or one that fails
// its checks, its text is read as before. The events the outcome logs go out; the driver records
// the Exec, or first sends the agent the repair message for the problem (act.ts agentAnswered).
// An answer from the script follows the text in the saved file, under SCRIPT_RECORD. The reply
// to a repair goes after the answer it repairs, never over it: a designer's report is what
// judge(report) reads (rule D3), and the reply is a line at most. A failed save or event is
// noted in the summary but keeps the reading: re-running an agent costs far more.
export async function onAgentAnswer(ctx: ExecCtx, entry: LedgerEntry, answer: AgentAnswer): Promise<AnswerTaken> {
  const notes: string[] = []
  const path = answerPath(ctx.rt.loopDir, entry.key)
  let said: string | null = null
  try {
    const before = entry.reminded === true ? await ctx.io.readFile(path) : null
    said = before === null ? answer.answer : `${before.replace(/\n*$/, '')}\n\n${REPAIR_REPLY}\n\n${answer.answer}`
    await ctx.io.writeFile(path, said)
  } catch (err) {
    notes.push(`answer not saved: ${message(err)}`)
  }
  const info = await answerInfoOf(ctx, entry)
  const recorded = await scriptAnswerOf(ctx, entry)
  const script = recorded === null ? null : readScriptAnswer(entry, recorded.body, info)
  const channel = info.channel ?? null
  if (recorded !== null && script !== null && 'exec' in script) {
    if (said !== null) {
      try {
        await ctx.io.writeFile(path, `${said.replace(/\n*$/, '')}\n\n${SCRIPT_RECORD}\n\n${recorded.body.replace(/\n*$/, '')}\n`)
      } catch (err) {
        notes.push(`recorded answer not saved: ${message(err)}`)
      }
    }
    notes.push(...(await logEvents(ctx, script.events)))
    return { exec: noted(script.exec, notes), problem: null, via: 'script', channel }
  }
  const read = readAnswer(entry, answer, info)
  notes.push(...(await logEvents(ctx, read.events)))
  const scriptProblem = script !== null && !('exec' in script) ? script.problem : undefined
  const problem = read.problem === null || scriptProblem === undefined ? read.problem : `${scriptProblem}; and the reply: ${read.problem}`
  const out: AnswerTaken = { exec: noted(read.exec, notes), problem, via: 'text', channel }
  if (scriptProblem !== undefined) out.scriptProblem = scriptProblem
  return out
}

// scriptAnswerOf: the answer file at the path issued for this attempt, or null when there is none
// (the agent recorded nothing, or was asked on another channel). Nothing at any other path is
// read: who answered is the path.
async function scriptAnswerOf(ctx: ExecCtx, entry: LedgerEntry): Promise<{ body: string } | null> {
  try {
    const body = await ctx.io.readFile(scriptPlaceOf(ctx.rt, entry).file)
    return body === null ? null : { body }
  } catch {
    return null
  }
}

// scriptAnswered: the answer an agent of the loop recorded with the answer script, for an agent
// the agent list shows ended or gone before its turn.complete was read (act.ts actPass, #561): read
// and checked as onAgentAnswer reads it, saved under SCRIPT_RECORD (after an answer it repairs),
// its events logged, and the Exec to finish its entry with. Null when there is none or it fails
// its checks, and the entry is lost as before.
export async function scriptAnswered(ctx: ExecCtx, entry: LedgerEntry): Promise<Exec | null> {
  const recorded = await scriptAnswerOf(ctx, entry)
  if (recorded === null) return null
  const script = readScriptAnswer(entry, recorded.body, await answerInfoOf(ctx, entry))
  if (!('exec' in script)) return null
  const notes = ['read before its turn.complete']
  const path = answerPath(ctx.rt.loopDir, entry.key)
  try {
    const before = entry.reminded === true ? await ctx.io.readFile(path) : null
    const record = `${SCRIPT_RECORD}\n\n${recorded.body.replace(/\n*$/, '')}\n`
    await ctx.io.writeFile(path, before === null ? record : `${before.replace(/\n*$/, '')}\n\n${record}`)
  } catch (err) {
    notes.push(`recorded answer not saved: ${message(err)}`)
  }
  notes.push(...(await logEvents(ctx, script.events)))
  return noted(script.exec, notes)
}

// repairAskOf: the channel a repair message asks on (act.ts agentAnswered), with the answer
// script's place on the script channel: the channel the spawn's record names, the script only
// while this attempt's job file stands beside its answer file, since the script refuses an answer
// file without one. With no channel named (no record, or one from before the channel was kept) or
// no job file, text, the channel always read.
export async function repairAskOf(ctx: Pick<ExecCtx, 'io' | 'rt'>, entry: LedgerEntry, channel: AnswerChannel | null): Promise<{ channel: AnswerChannel; script: ScriptPlace | null }> {
  if (channel !== 'script') return { channel: channel ?? 'text', script: null }
  const place = scriptPlaceOf(ctx.rt, entry)
  const job = jobPathOf(place.file)
  let body: string | null = null
  try {
    body = job === null ? null : await ctx.io.readFile(job)
  } catch {
    body = null
  }
  return body === null ? { channel: 'text', script: null } : { channel: 'script', script: place }
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
  let record: ReturnType<typeof parseRecord> = null
  try {
    record = parseRecord(await ctx.io.readFile(spawnRecordPath(ctx.rt.loopDir, entry.key)))
  } catch {
    // no record
  }
  const branch = record?.branch ?? (entry.run === null ? null : (ctx.state.runs.find(r => r.run === entry.run)?.branch ?? null))
  return { repo: ctx.rt.repo, branch, purpose: record?.purpose ?? null, channel: record?.channel ?? null }
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

// scriptFor: on the script channel (config answerChannel, the default), the answer script and
// this attempt's answer file, once the job file the script checks against stands beside it; null
// when the channel is another, or the paths are not ones a prompt may carry, or the job file
// cannot be written, and the prompt then asks for text. The script channel is a TEMPORARY
// WORKAROUND (#561, DECISIONS D-74) for the registered answer tools (#548), which an agent the
// loop spawns from its timer cannot reach on Claude Code 2.1.296 and 2.1.299 (#560).
async function scriptFor(ctx: ExecCtx, action: AgentAction): Promise<ScriptPlace | null> {
  if (ctx.rt.config.answerChannel !== 'script') return null
  const place = scriptPlaceOf(ctx.rt, ctx.entry)
  const job = jobPathOf(place.file)
  if (job === null || !scriptShaped(place)) return null
  const type: AgentType = action.kind === 'delegate' ? 'implementer' : action.agent
  const purpose = action.kind === 'spawn' && action.agent === 'adjudicator' ? action.purpose : null
  try {
    await ctx.io.writeFile(job, jobText({ contract: CONTRACT_OF[type], purpose, repo: ctx.rt.repo, issue: action.issue, branch: type === 'fixer' ? namedBranchOf(action) : null }))
  } catch {
    return null
  }
  return place
}

// start: write the answer script's job file (on the script channel) and the spawn record, then
// spawn. A deny, a throw or a start with no agent id is a failed attempt; a started agent runs on,
// and its turn.complete ends the entry.
async function start(ctx: ExecCtx, action: AgentAction, model: string | null, env: Omit<PromptEnv, 'repo'>): Promise<Exec> {
  const script = await scriptFor(ctx, action)
  const channel: AnswerChannel = script !== null ? 'script' : ctx.rt.config.answerChannel === 'tool' ? 'tool' : 'text'
  const input = spawnInputOf(action, { repo: ctx.rt.repo, attempt: ctx.entry.attempts, model, channel, script, ...env })
  let saved = true
  try {
    const record = recordOf(action, input, ctx.entry.attempts, script, channel)
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
