// The agent steps (docs/factory-loop/v2/SPEC.md 4.2, 5.1, 10.3, 10.8), generic over their kinds:
// the `agent-step` executor, and the reading of a step's answer into the result plan reads. Each
// step kind is a StepModule of steps-work.ts (design, build, fix), steps-review.ts (review) or
// steps-triage.ts (triage): its agent's prompt and model, its answer contract
// (v2/contracts-*.mjs, through contract.mjs) and what a checked answer means.
//
// - The executor first looks for a valid answer already recorded for its key (10.8), then writes
//   the answer script's job file and the step's record, and spawns the step's own agent type
//   (types.ts STEP_AGENT) with the answer script on the prompt: agents answer with the script only
//   (D-74). A spawn refused or failed is a failed attempt, which plan reads as unknown.
// - An answer ends the step when it is read (10.8): at the agent's turn end, every pass while the
//   entry runs, and before the agent list marks it lost. A writer's ok is taken only at its turn's
//   end, so the stop gate has its say first. One repair message goes to an agent that ended its
//   turn without a valid answer (D-68); a second miss is unknown (bad-answer).
// - Every read result is a done entry with the outcome { kind: 'step', step, result }, unknown
//   ones included, so plan reads why; a turn that ended in error, aborted or refused is unknown
//   (rate-limited for a 429, api for another API error, else agent-dead), unless a valid answer
//   was recorded before it, which is the result (a writer's ok excepted: the stop gate never ran).
// act.ts applies what these give to the live ledger, as it does for v1's agents.
import { V2_CONTRACTS, jobPathOf, jobText, parseAnswer } from '../contract.mjs'
import type { Job, V2Contract, V2ContractName } from '../contract.mjs'
import { ANSWER_SCRIPT, answerPath } from '../exec'
import type { AgentAnswer, Exec, ExecCtx, Executor } from '../exec'
import { scriptShaped } from '../prompts'
import type { ScriptPlace } from '../prompts'
import type { Action, ActionKind, LedgerEntry } from '../types'
import { STEPS as QUEUE } from './steps-queue'
import { STEPS as REVIEW } from './steps-review'
import { STEPS as TRIAGE } from './steps-triage'
import { STEPS as WORK } from './steps-work'
import { AGENT_STEPS, STEP_AGENT, STEP_ROLE, unknownResult } from './types'
import type { AgentStep, Role, StepResult, UnknownWhy } from './types'

const SUMMARY_MAX = 200
// a spawn record or answer file is a few KiB; anything far past this is not one of ours
const RECORD_MAX = 256 * 1024

export type AgentStepAction = Extract<Action, { kind: 'agent-step' }>

// What a step module gives for one attempt: the prompt (which names the answer script and file it
// is handed), the model (null: the agent's own), and the data its contract's check needs.
export type StepSpawn = { prompt: string; model: string | null; data: Record<string, unknown> | null }

// What the executor keeps beside the answer (spawns/<key>.json), so the answer is read and
// checked at the turn's end, after a reload, or by the next pass, the same way.
export type StepRecord = {
  v: 2
  key: string
  issue: number
  step: AgentStep
  life: string
  seq: number
  attempt: number
  branch: string
  slot: string | null
  role: Role
  subagentType: string
  model: string | null
  contract: V2ContractName
  data: Record<string, unknown> | null
  answerFile: string
  prompt: string
}

// One step kind (steps-*.ts). spawn: what to start for this attempt, or why it cannot (a loop
// bug: the attempt fails, never retried). result: what a checked answer means; a writer's reads
// its head on origin (10.8), and a failed read is unknown, never not-ok. says: what a checked
// answer claims of itself, pure and before any read of origin; a writer's module gives it, so its
// not-ok ends the step when read while its ok waits for the turn's end (a writer's module without
// it has every answer wait).
export type StepModule = {
  step: AgentStep
  contract: V2ContractName
  spawn: (ctx: ExecCtx, action: AgentStepAction, place: ScriptPlace) => Promise<StepSpawn | string>
  result: (ctx: ExecCtx, record: StepRecord, answer: unknown) => Promise<StepResult>
  says?: (answer: unknown) => 'ok' | 'not-ok'
}

export const STEP_MODULES: Partial<Record<AgentStep, StepModule>> = { ...WORK, ...REVIEW, ...TRIAGE, ...QUEUE }

// What the step machinery reads steps and answers by: the step modules and the contracts, the
// real ones but in a test, which hands its own.
export type StepDeps = { modules: Partial<Record<AgentStep, StepModule>>; contracts: Readonly<Record<string, V2Contract>> }
export const STEP_DEPS: StepDeps = { modules: STEP_MODULES, contracts: V2_CONTRACTS }

// --- paths and records ------------------------------------------------------------------------------

const fileName = (key: string) => key.replace(/[^A-Za-z0-9._-]+/g, '_')

// stepAnswerPath: where a step's agent records its answer with the answer script: one file per
// key, and a step key is one attempt, so a re-dispatch of the key finds an answer already there.
export function stepAnswerPath(loopDir: string, key: string): string {
  return `${loopDir}/answers/${fileName(key)}.answer.json`
}

export function stepRecordPath(loopDir: string, key: string): string {
  return `${loopDir}/spawns/${fileName(key)}.json`
}

// parseStepRecord: a step record's text, or null when it is not one.
export function parseStepRecord(text: string | null, contracts: StepDeps['contracts'] = V2_CONTRACTS): StepRecord | null {
  if (text === null || text.length > RECORD_MAX) return null
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (o === null || typeof o !== 'object' || o.v !== 2) return null
    const step = AGENT_STEPS.find(s => s === o.step)
    const contract = Object.keys(contracts).find(c => c === o.contract) as V2ContractName | undefined
    const str = (v: unknown) => typeof v === 'string' && v !== ''
    const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0
    const data = o.data === null || (typeof o.data === 'object' && !Array.isArray(o.data)) ? (o.data as Record<string, unknown> | null) : undefined
    if (step === undefined || contract === undefined || data === undefined) return null
    if (!str(o.key) || !int(o.issue) || !str(o.life) || !int(o.seq) || !int(o.attempt) || !str(o.branch) || !str(o.subagentType) || !str(o.answerFile)) return null
    if (o.role !== 'writer' && o.role !== 'reader') return null
    return {
      v: 2,
      key: String(o.key),
      issue: Number(o.issue),
      step,
      life: String(o.life),
      seq: Number(o.seq),
      attempt: Number(o.attempt),
      branch: String(o.branch),
      slot: typeof o.slot === 'string' ? o.slot : null,
      role: o.role,
      subagentType: String(o.subagentType),
      model: typeof o.model === 'string' ? o.model : null,
      contract,
      data,
      answerFile: String(o.answerFile),
      prompt: typeof o.prompt === 'string' ? o.prompt : '',
    }
  } catch {
    return null
  }
}

// --- results ----------------------------------------------------------------------------------------

function doneWith(step: AgentStep, result: StepResult, summary: string): Exec {
  return { status: 'done', outcome: { kind: 'step', step, result }, summary: clip(summary) }
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function describe(result: StepResult): string {
  const tail = result.reason === null ? '' : `: ${result.reason}`
  return result.event === 'unknown' ? `unknown (${result.why ?? 'unknown'})${tail}` : `${result.event}${tail}`
}

// The answer an entry's agent recorded, checked against its record's contract, or the problem.
async function recordedAnswer(ctx: ExecCtx, record: StepRecord, deps: StepDeps): Promise<{ answer: unknown } | { problem: string } | null> {
  let body: string | null
  try {
    body = await ctx.io.readFile(record.answerFile)
  } catch {
    body = null
  }
  if (body === null) return null
  const job: Job = { contract: record.contract, purpose: null, repo: ctx.rt.repo, issue: record.issue, branch: record.branch }
  if (record.data !== null) job.data = record.data
  const file = parseAnswer(body, record.contract)
  const contract = deps.contracts[record.contract]
  if (contract === undefined) return { problem: `no contract ${record.contract} checks this answer` }
  const check = file.ok ? contract.check(file.outcome, job) : file
  return check.ok ? { answer: check.outcome } : { problem: `the answer recorded with the answer script does not pass its checks: ${check.problems.join('; ')}` }
}

async function recordOf(ctx: ExecCtx, key: string, deps: StepDeps): Promise<StepRecord | null> {
  try {
    return parseStepRecord(await ctx.io.readFile(stepRecordPath(ctx.rt.loopDir, key)), deps.contracts)
  } catch {
    return null
  }
}

// resultOf: a recorded answer as its step's result, through its module.
async function resultOf(ctx: ExecCtx, record: StepRecord, answer: unknown, deps: StepDeps): Promise<StepResult> {
  const module = deps.modules[record.step]
  if (module === undefined) return unknownResult('bad-answer', `no module reads a ${record.step} answer`)
  try {
    return await module.result(ctx, record, answer)
  } catch (err) {
    return unknownResult('cli', `the ${record.step} answer could not be read: ${message(err)}`)
  }
}

// waitsForGate: a writer's answer that says ok (or whose module cannot say) is taken only at its
// turn's normal end, so the stop gate has its say first (10.6, 10.8). It is decided on the answer
// itself, before the module reads origin, so nothing runs for it until then.
function waitsForGate(record: StepRecord, answer: unknown, deps: StepDeps): boolean {
  if (record.role !== 'writer') return false
  const says = deps.modules[record.step]?.says
  if (says === undefined) return true
  try {
    return says(answer) !== 'not-ok'
  } catch {
    return true
  }
}

// stepRecorded: the result of a valid answer already recorded for this entry's attempt, as the
// Exec that finishes it; null when there is none. Before the turn's end (a pass's read, or an
// agent the list shows gone), a writer's ok is not taken yet: it waits for the stop gate.
export async function stepRecorded(ctx: ExecCtx, entry: LedgerEntry, atTurnEnd: boolean, deps: StepDeps = STEP_DEPS): Promise<Exec | null> {
  const record = await recordOf(ctx, entry.key, deps)
  if (record === null) return null
  const read = await recordedAnswer(ctx, record, deps)
  if (read === null || 'problem' in read) return null
  if (!atTurnEnd && waitsForGate(record, read.answer, deps)) return null
  const result = await resultOf(ctx, record, read.answer, deps)
  return doneWith(record.step, result, `${record.step} #${record.issue}: ${describe(result)}${atTurnEnd ? '' : ' (read before its turn ended)'}`)
}

// The running agent steps a pass reads the answers of (10.8): each one whose answer is recorded
// ends when it is read, a writer's ok excepted, which waits for its turn's end. act.ts applies
// each Exec to the live ledger while its entry still runs as read.
export async function stepAnswers(entries: readonly LedgerEntry[], ctxOf: (entry: LedgerEntry) => ExecCtx, deps: StepDeps = STEP_DEPS): Promise<{ entry: LedgerEntry; exec: Exec }[]> {
  const out: { entry: LedgerEntry; exec: Exec }[] = []
  for (const entry of entries.filter(e => e.kind === 'agent-step' && e.status === 'running')) {
    const exec = await stepRecorded(ctxOf(entry), entry, false, deps)
    if (exec !== null) out.push({ entry, exec })
  }
  return out
}

// agentTypeOf: a recorded agent type, plugin:name, or null.
function agentTypeOf(text: string | undefined): `${string}:${string}` | null {
  return text !== undefined && /^[\w-]+:[\w-]+$/.test(text) ? (text as `${string}:${string}`) : null
}

// What an agent's turn end gave (act.ts agentAnswered): the Exec to finish the entry with, or,
// with a problem and a repair message, the one more ask before it (D-68).
export type StepTaken = { exec: Exec; problem: string | null; repair: string | null; subagentType: `${string}:${string}` }

// A rate limit (a 429 or the usage window), as a turn's last words name it: unknown
// (rate-limited), which plan reads as the outside cause `usage`, a free re-run (5.1). Any other API
// error (a 5xx, overloaded) is unknown (api) and counts as unexplained (5.3).
const RATE_LIMIT = /\b429\b|rate.?limit|usage limit|too many requests/i
const API_ERROR = /\b(500|502|503|504|529)\b|overloaded|API Error/i
const WORDS_MAX = 120

// lostTurn: the unknown of a turn that ended in error, aborted or refused, with an excerpt of its
// last words, so triage and the decision log see what it said.
function lostTurn(answer: AgentAnswer): StepResult {
  const why: UnknownWhy = RATE_LIMIT.test(answer.answer) ? 'rate-limited' : API_ERROR.test(answer.answer) ? 'api' : 'agent-dead'
  const words = answer.answer.replace(/\s+/g, ' ').trim()
  const excerpt = words.length > WORDS_MAX ? `${words.slice(0, WORDS_MAX - 3)}...` : words
  return unknownResult(why, `its turn ended: ${answer.reason}${excerpt === '' ? '' : `: ${excerpt}`}`)
}

// stepAnswered: an agent step's turn ended. Its final words are saved for the owner and the
// triage (exec.ts answerPath), then its recorded answer is read.
export async function stepAnswered(ctx: ExecCtx, entry: LedgerEntry, answer: AgentAnswer, deps: StepDeps = STEP_DEPS): Promise<StepTaken> {
  const record = await recordOf(ctx, entry.key, deps)
  const step = record?.step ?? entry.step ?? 'build'
  const subagentType = agentTypeOf(record?.subagentType) ?? STEP_AGENT[step]
  const notes: string[] = []
  try {
    await ctx.io.writeFile(answerPath(ctx.rt.loopDir, entry.key), answer.answer)
  } catch (err) {
    notes.push(`answer not saved: ${message(err)}`)
  }
  const note = (exec: Exec): Exec => (notes.length === 0 ? exec : { ...exec, summary: clip(`${exec.summary}; ${notes.join('; ')}`) })
  if (record === null) return { exec: refused(`${entry.key}: no step record to read its answer by`), problem: null, repair: null, subagentType }
  const read = await recordedAnswer(ctx, record, deps)
  if (answer.reason !== 'answer') {
    // a valid answer recorded before the turn ended in error is the result (10.8), but a writer's
    // ok, which the stop gate never passed
    const kept = read !== null && 'answer' in read && !waitsForGate(record, read.answer, deps) ? read : null
    const result = kept !== null ? await resultOf(ctx, record, kept.answer, deps) : lostTurn(answer)
    const tail = kept !== null ? ` (recorded before its turn ended: ${answer.reason})` : ''
    return { exec: note(doneWith(step, result, `${step} #${record.issue}: ${describe(result)}${tail}`)), problem: null, repair: null, subagentType }
  }
  if (read !== null && 'answer' in read) {
    const result = await resultOf(ctx, record, read.answer, deps)
    return { exec: note(doneWith(step, result, `${step} #${record.issue}: ${describe(result)}`)), problem: null, repair: null, subagentType }
  }
  const problem = read === null ? 'no answer was recorded with the answer script' : read.problem
  const result = unknownResult('bad-answer', problem)
  const place: ScriptPlace = { bin: `${ctx.rt.pluginRoot}/${ANSWER_SCRIPT}`, file: record.answerFile }
  const repair = `Your answer was not recorded: ${problem}. Record it now with \`${place.bin} --to ${place.file}\` and the JSON object your prompt asks for, then end your turn.`
  return { exec: note(doneWith(step, result, `${step} #${record.issue}: ${describe(result)}`)), problem, repair, subagentType }
}

// --- the executor -----------------------------------------------------------------------------------

const TITLE: Record<AgentStep, string> = { design: 'Design', build: 'Build', review: 'Review', fix: 'Fix', triage: 'Triage' }

// stepExecutor: the agent-step executor: one attempt of an agent step, in the record's slot.
export const stepExecutor = (deps: StepDeps = STEP_DEPS): Executor => async (ctx, action) => {
  if (action.kind !== 'agent-step') return refused(`the agent-step executor got a ${action.kind} action`)
  if (action.issue === null) return refused(`${action.key} names no issue`)
  const module = deps.modules[action.step]
  if (module === undefined) return refused(`no module runs the ${action.step} step`)
  const place: ScriptPlace = { bin: `${ctx.rt.pluginRoot}/${ANSWER_SCRIPT}`, file: stepAnswerPath(ctx.rt.loopDir, action.key) }
  const jobFile = jobPathOf(place.file)
  if (jobFile === null || !scriptShaped(place)) return refused(`the answer script or file of ${action.key} is not a plain absolute path`)
  // an answer already recorded for this key is the result (10.8)
  const earlier = await stepRecorded(ctx, ctx.entry, true, deps)
  if (earlier !== null) return earlier
  const spawn = await module.spawn(ctx, action, place)
  if (typeof spawn === 'string') return refused(spawn)
  const job: Job = { contract: module.contract, purpose: null, repo: ctx.rt.repo, issue: action.issue, branch: action.branch }
  if (spawn.data !== null) job.data = spawn.data
  const subagentType = STEP_AGENT[action.step]
  const record: StepRecord = {
    v: 2,
    key: action.key,
    issue: action.issue,
    step: action.step,
    life: action.life,
    seq: action.seq,
    attempt: action.attempt,
    branch: action.branch,
    slot: action.slot,
    role: STEP_ROLE[action.step],
    subagentType,
    model: spawn.model,
    contract: module.contract,
    data: spawn.data,
    answerFile: place.file,
    prompt: spawn.prompt,
  }
  try {
    await ctx.io.writeFile(jobFile, jobText(job))
    await ctx.io.writeFile(stepRecordPath(ctx.rt.loopDir, action.key), JSON.stringify(record, null, 2))
  } catch (err) {
    return { status: 'failed', summary: clip(`${action.key}: its job file or record could not be written: ${message(err)}`) }
  }
  const input: { subagentType: string; prompt: string; description: string; name: string; model?: string } = {
    subagentType,
    prompt: spawn.prompt,
    description: `${TITLE[action.step]} #${action.issue}`,
    name: `${action.step}-${action.issue}-s${action.seq}-a${action.attempt}`,
  }
  if (spawn.model !== null) input.model = spawn.model
  let r: { agentId?: string; deny?: string }
  try {
    r = await ctx.io.spawnAgent(input)
  } catch (err) {
    return { status: 'failed', summary: clip(`${subagentType}: the spawn threw: ${message(err)}`) }
  }
  if (typeof r.deny === 'string') return { status: 'failed', summary: clip(`${subagentType} denied: ${r.deny}`) }
  if (r.agentId === undefined || r.agentId === '') return { status: 'failed', summary: `${subagentType}: started with no agent id` }
  return { status: 'running', agentId: r.agentId, summary: clip(`${subagentType} started for #${action.issue} (${action.key}): ${r.agentId}`) }
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'agent-step': stepExecutor() }

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
