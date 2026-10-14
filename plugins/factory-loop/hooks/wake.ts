// Waking the model and reading its answers (SPEC 8, 9.2, 10.8; DECISIONS D-04, D-25, D-26).
// A judge, task or tell is one prompt the loop submits: a machine-shaped first line, plain-text
// detail lines, and the judge skill's pointer last (SPEC 8.1). The model answers a judge or a
// task with an `ANSWER <id> <decision>` block in its final message, or with the answer tool
// (D-04); a tell is delivered when its own turn completes (D-25). Only the executor touches the
// engine: everything else is a pure function over the ledger that returns the updates for the
// driver to apply (ledger.ts finish) and the prompts for it to submit, so the tests and the
// replay harness drive it without the engine. What must survive a reload is on the wake's ledger
// entry: its id (wakeId), the turn it started (turnId), whether its reminder went out
// (reminded), and its first line (summary), which the reminder repeats.
import type { ToolSpec } from 'claude-code'

import { WAKE_POINTER, answerPath } from './exec'
import type { Executor } from './exec'
import type { Action, ActionKind, Config, LedgerEntry, LedgerStatus, Ms, Outcome, WakeKind } from './types'

const MIN = 60_000
const HOUR = 60 * MIN
// ledger.ts keeps this much of a summary; a wake's summary is its first line (see lineSummary)
export const WAKE_SUMMARY_MAX = 300
// a reason or instructions past this is cut: answers are short (SPEC 8.4)
const VALUE_MAX = 2000
// a reminder repeats at most this many of the reasons the last answer was refused
const REFUSALS_SHOWN = 3

const HEADS: Record<WakeKind, string> = { judge: 'JUDGE', task: 'TASK', tell: 'TELL' }
const KINDS: Record<string, WakeKind> = { JUDGE: 'judge', TASK: 'task', TELL: 'tell' }
// first-line fields the loop sets itself
const RESERVED = ['id', 'repo', 'reminder']

export type WakeAction = Extract<Action, { kind: WakeKind }>

// A transition of one wake's entry, for the driver to apply with ledger.ts
// finish(ledger, update.key, update, now); structurally a ledger.ts Completion.
export type WakeUpdate = {
  key: string
  status: LedgerStatus
  outcome?: Outcome
  summary?: string
  wakeId?: string
  turnId?: string
  reminded?: boolean
  // an attempt given back (orphanedWakes)
  attempts?: number
}

export function isWakeAction(action: Action): action is WakeAction {
  return action.kind === 'judge' || action.kind === 'task' || action.kind === 'tell'
}

function wakeKind(kind: ActionKind): WakeKind | null {
  return kind === 'judge' || kind === 'task' || kind === 'tell' ? kind : null
}

// --- the prompt (SPEC 8.1) -------------------------------------------------------------------

// A first-line value holds no spaces: whitespace is percent-encoded.
function value(v: string): string {
  return v.replace(/\s/g, c => encodeURIComponent(c))
}

// wakeLine: `<JUDGE|TASK|TELL> <name> id=<id> repo=<owner/name> key=value ...`, the fields in
// plan's order. repo= lets the model build issue and PR links (the skill's TELL format).
export function wakeLine(action: WakeAction, id: string, repo: string): string {
  const parts = [HEADS[action.kind], value(action.wake), `id=${value(id)}`, `repo=${value(repo)}`]
  for (const [k, v] of Object.entries(action.fields)) {
    if (!RESERVED.includes(k)) parts.push(`${k.replace(/[^\w-]/g, '_')}=${value(v)}`)
  }
  return parts.join(' ')
}

// wakeDetails: the detail lines the executor adds after plan's context, so the model reads files
// rather than pasted reports: the agent's saved answer for judge(report) and judge(handoff)
// (SPEC 7.2, act-agents.ts writes it), and every respond log of the run for task(respond-stuck)
// (D-37), from its respond entries in the ledger.
export function wakeDetails(action: WakeAction, loopDir: string, ledger: readonly LedgerEntry[]): string[] {
  const entry = action.fields.entry
  if (action.kind === 'judge' && (action.wake === 'report' || action.wake === 'handoff') && entry !== undefined) {
    return [`saved answer: ${answerPath(loopDir, entry)}`]
  }
  if (action.kind === 'task' && action.wake === 'respond-stuck') {
    const run = action.fields.run
    const logs = ledger
      .filter(e => e.kind === 'respond' && run !== undefined && e.run === run)
      .sort((a, b) => a.startedAt - b.startedAt)
      .flatMap(e => (e.outcome?.kind === 'respond' ? [e.outcome.log] : []))
    return [...new Set(logs)].map(log => `respond log: ${log}`)
  }
  return []
}

// wakePrompt: the first line, each detail as its own plain-text line (a value with line breaks
// becomes several), then the skill pointer as the last line (SPEC 8.1).
export function wakePrompt(first: string, details: readonly string[]): string {
  const lines = details.flatMap(d => d.split(/\r?\n/)).filter(l => l.trim() !== '')
  return [first, ...lines, WAKE_POINTER].join('\n')
}

// lineSummary: the first line as the running entry's summary, which a reminder repeats after a
// reload. A line longer than the ledger keeps is cut after its last whole field.
export function lineSummary(first: string): string {
  if (first.length <= WAKE_SUMMARY_MAX) return first
  const cut = first.lastIndexOf(' ', WAKE_SUMMARY_MAX)
  return cut > 0 ? first.slice(0, cut) : first.slice(0, WAKE_SUMMARY_MAX)
}

// The executor for judge, task and tell (SPEC 6.1): submit the prompt and run on until the
// answer, the delivery or the timeout. Submit starts a turn of its own once the session is idle.
// A prompt the engine refused or dropped started no turn, so it is skipped, no attempt counted,
// and plan asks again next pass (a wake gets one attempt, which a drop must not use up).
const wake: Executor = async (ctx, action) => {
  if (!isWakeAction(action)) return { status: 'failed', summary: `not a wake: ${action.kind}`, noRetry: true }
  const id = ctx.wakeId()
  const first = wakeLine(action, id, ctx.rt.repo)
  const details = [...action.context, ...wakeDetails(action, ctx.rt.loopDir, ctx.state.ledger)]
  try {
    await ctx.io.submit(wakePrompt(first, details))
  } catch (err) {
    return { status: 'skipped', summary: `submit failed: ${String(err).slice(0, 200)}` }
  }
  return { status: 'running', wakeId: id, summary: lineSummary(first) }
}

export const wakeExecutors: Partial<Record<ActionKind, Executor>> = { judge: wake, task: wake, tell: wake }

// --- answers (SPEC 8.2) ----------------------------------------------------------------------

// What each wake may answer, and the field a decision needs (SPEC 8.2's table). A tell takes no
// answer. A judge or task whose name this table lacks may only hold, with a reason (the skill:
// `reason: unknown wake <name>`).
export type DecisionNeed = 'reason' | 'instructions' | 'fields' | null
const TASK_DECISIONS: Record<string, DecisionNeed> = { done: null, failed: 'reason', hold: null }
export const WAKE_DECISIONS: Record<'judge' | 'task', Record<string, Record<string, DecisionNeed>>> = {
  judge: {
    sequence: { merge: null, hold: 'reason' },
    'guard-fail': { fixer: 'instructions', wait: null, hold: 'reason' },
    cancelled: { redrive: null, drop: 'reason' },
    handoff: { ok: null, fixer: 'instructions', hold: 'reason' },
    report: { parsed: 'fields', hold: null },
  },
  task: { redrive: TASK_DECISIONS, 'run-it': TASK_DECISIONS, release: TASK_DECISIONS, 'respond-stuck': TASK_DECISIONS },
}
const UNKNOWN_WAKE: Record<string, DecisionNeed> = { hold: 'reason' }

function decisionsOf(kind: 'judge' | 'task', name: string): Record<string, DecisionNeed> {
  const table = WAKE_DECISIONS[kind]
  return Object.hasOwn(table, name) ? (table[name] ?? UNKNOWN_WAKE) : UNKNOWN_WAKE
}

// allowedDecisions: the decisions a wake of this kind and name accepts; none for a tell.
export function allowedDecisions(kind: WakeKind, name: string): string[] {
  return kind === 'tell' ? [] : Object.keys(decisionsOf(kind, name))
}

// One `ANSWER <id> <decision>` block as written; checkAnswer validates it.
export type AnswerBlock = {
  id: string
  decision: string
  reason: string | null
  instructions: string | null
  // the raw `fields:` value, one line of JSON
  fields: string | null
}

export type ParsedAnswers = { blocks: AnswerBlock[]; problems: string[] }

const ANSWER_LINE = /^ANSWER\s+(\S+)\s+(\S+)$/
const KEY_LINE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/

// An ANSWER line the model wrapped in backticks or bold reads the same.
function bare(line: string): string {
  return line.replace(/^[`*]+|[`*]+$/g, '').trim()
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

// parseAnswers: every ANSWER block in a turn's final text, wherever it sits. A block is the
// `ANSWER <id> <decision>` line and the `key: value` lines after it (reason, instructions,
// fields); a blank line, the end, or any other line (a code fence, prose) ends it. The first
// value of a key counts. An ANSWER line of another shape and an unknown key are named in
// problems, for the decision log.
export function parseAnswers(text: string): ParsedAnswers {
  const lines = text.split(/\r?\n/).map(l => l.trim())
  const blocks: AnswerBlock[] = []
  const problems: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = bare(lines[i] ?? '')
    if (!/^ANSWER\b/.test(line)) continue
    const m = ANSWER_LINE.exec(line)
    if (m === null) {
      problems.push(`not an ANSWER line: ${clip(line)}`)
      continue
    }
    const block: AnswerBlock = { id: m[1] ?? '', decision: m[2] ?? '', reason: null, instructions: null, fields: null }
    for (let j = i + 1; j < lines.length; j++) {
      const kv = KEY_LINE.exec(lines[j] ?? '')
      if (kv === null) break
      i = j
      const key = (kv[1] ?? '').toLowerCase()
      const v = (kv[2] ?? '').trim()
      if (key === 'reason' || key === 'instructions' || key === 'fields') {
        if (block[key] === null && v !== '') block[key] = v
      } else {
        problems.push(`ANSWER ${block.id}: unknown key ${clip(key, 40)}`)
      }
    }
    blocks.push(block)
  }
  return { blocks, problems }
}

// An answer from either channel: a parsed block, or the answer tool's input.
export type AnswerInput = {
  id: string
  decision: string
  reason?: string | null
  instructions?: string | null
  // a block's raw JSON line, or the tool's object
  fields?: unknown
}

export type Checked = { ok: true; update: WakeUpdate } | { ok: false; problem: string }

type WakeFields = Extract<Outcome, { kind: 'wake' }>['fields']

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function text(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t === '' ? null : t.slice(0, VALUE_MAX)
}

// fieldsOf: the fields as the outcome keeps them (strings, numbers, booleans, null, lists of
// numbers), null when there are none, or a string saying what is wrong.
function fieldsOf(raw: unknown): WakeFields | null | string {
  if (raw === undefined || raw === null || raw === '') return null
  let v = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return 'fields is not one line of JSON'
    }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'fields must be a JSON object'
  const out: WakeFields = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || typeof x === 'string' || typeof x === 'boolean' || finite(x)) out[k] = x
    else if (Array.isArray(x) && x.every(finite)) out[k] = x
    else return `fields.${clip(k, 40)} must be a string, number, boolean, null or a list of numbers`
  }
  return out
}

// A brief is a comment URL on the wake's issue of this repo (SPEC 7.2, as the designer's
// RESULT line; replies.ts isBriefUrl is the same rule).
function briefOk(url: string, repo: string, issue: number | null): boolean {
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)#issuecomment-\d+$/.exec(url)
  if (m === null || (m[1] ?? '').toLowerCase() !== repo.toLowerCase()) return false
  return issue === null || Number(m[2]) === issue
}

// reportProblem: what is wrong with judge(report)'s `parsed` fields, or null. All three are
// needed: a missing pendingDecision could delegate a design that waits on the owner.
function reportProblem(fields: WakeFields | null, repo: string, issue: number | null): string | null {
  if (fields === null) return 'parsed needs fields: brief, created, pendingDecision'
  const { brief, created, pendingDecision } = fields
  if (brief === undefined || (brief !== null && (typeof brief !== 'string' || !briefOk(brief, repo, issue)))) {
    return `fields.brief must be null or a comment URL on ${repo} issue ${issue ?? '<N>'}`
  }
  if (!Array.isArray(created) || !created.every(n => Number.isInteger(n) && n > 0)) {
    return 'fields.created must be a list of issue numbers ([] for none)'
  }
  if (typeof pendingDecision !== 'boolean') return 'fields.pendingDecision must be true or false'
  if (brief === null && created.length === 0) return 'parsed needs a brief or created issues; with neither, answer hold'
  return null
}

function isOpenWake(e: LedgerEntry): boolean {
  return e.status === 'running' && wakeKind(e.kind) !== null
}

// checkAnswer: an answer against the ledger. The id must be an open judge or task, the decision
// one its kind and name allow, with the field that decision needs; fields must be one JSON
// object of plain values. A refused answer leaves the wake open, and the problem goes to the
// decision log (and into the reminder). `via` says which channel answered, for the summary.
export function checkAnswer(ledger: readonly LedgerEntry[], input: AnswerInput, repo: string, via: 'block' | 'tool' = 'block'): Checked {
  const id = input.id.trim().replace(/^id=/, '')
  const decision = input.decision.trim().toLowerCase()
  const refuse = (why: string): Checked => ({ ok: false, problem: `ANSWER ${clip(id, 40)} ${clip(decision, 40)}: ${why}` })
  const entry = ledger.find(e => e.wakeId === id && isOpenWake(e))
  if (entry === undefined) {
    const seen = ledger.find(e => e.wakeId === id)
    return refuse(seen === undefined ? 'no wake has this id' : `that wake is not open (${seen.status})`)
  }
  const kind = wakeKind(entry.kind)
  if (kind === null || kind === 'tell') return refuse('a TELL takes no answer')
  const name = entry.wake ?? ''
  const allowed = decisionsOf(kind, name)
  if (!Object.hasOwn(allowed, decision)) return refuse(`${HEADS[kind]} ${name} allows ${Object.keys(allowed).join(', ')}`)
  const need = allowed[decision] ?? null
  const reason = text(input.reason)
  const instructions = text(input.instructions)
  if (need === 'reason' && reason === null) return refuse('needs a reason')
  if (need === 'instructions' && instructions === null) return refuse('needs instructions')
  const fields = fieldsOf(input.fields)
  if (typeof fields === 'string') return refuse(fields)
  if (need === 'fields') {
    const bad = reportProblem(fields, repo, entry.issue)
    if (bad !== null) return refuse(bad)
  }
  const outcome: Outcome = { kind: 'wake', decision, reason, instructions, bump: null, bumpReason: null, fields: fields ?? {} }
  const summary = `answered ${decision}${via === 'tool' ? ' (tool)' : ''}${reason === null ? '' : `: ${reason}`}`
  return { ok: true, update: { key: entry.key, status: 'done', outcome, summary } }
}

// --- turns (SPEC 8.2, 10.8) ------------------------------------------------------------------

const HEAD_LINE = /^(JUDGE|TASK|TELL) (\S+) id=(\S+)(?: |$)/

// onTurnStart: a turn whose text starts with a wake's first line (a reminder's too) is that
// wake's turn; its id goes on the entry, so the turn's end is told apart from the owner's chat.
// Submit can start the turn before the executor returns, while the entry has no wake id yet:
// then the one such running entry of that kind and name is it, and the update sets both ids.
export function onTurnStart(ledger: readonly LedgerEntry[], text: string, turnId: string): WakeUpdate | null {
  const m = HEAD_LINE.exec(text.trimStart())
  const kind = KINDS[m?.[1] ?? '']
  const name = m?.[2]
  const id = m?.[3]
  if (kind === undefined || name === undefined || id === undefined) return null
  const open = ledger.filter(e => e.status === 'running' && e.kind === kind && e.wake !== undefined && value(e.wake) === name)
  const pending = open.filter(e => e.wakeId === undefined)
  const entry = open.find(e => e.wakeId === id) ?? (pending.length === 1 ? pending[0] : undefined)
  return entry === undefined ? null : { key: entry.key, status: 'running', wakeId: id, turnId }
}

// A main-loop turn as its turn.complete gives it; agentId is set on an agent's turn.
export type TurnEnd = { turnId: string; answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; agentId?: string }

export type TurnOutcome = { updates: WakeUpdate[]; prompts: string[]; problems: string[] }

// reminderLine: the wake's first line again with ` reminder=1`, from the summary the executor
// left on its entry; an entry without it (an older build) gets the head, the repo and its ids.
export function reminderLine(entry: LedgerEntry, repo: string): string {
  const kind = wakeKind(entry.kind) ?? 'judge'
  const head = `${HEADS[kind]} ${value(entry.wake ?? 'unknown')} id=${value(entry.wakeId ?? '')}`
  const summary = entry.summary ?? ''
  if (summary === head || summary.startsWith(`${head} `)) return `${summary} reminder=1`
  const ids: [string, string | number | null][] = [['issue', entry.issue], ['pr', entry.pr], ['run', entry.run], ['head', entry.head]]
  const known = ids.flatMap(([k, v]) => (v === null ? [] : [`${k}=${value(String(v))}`]))
  return [head, `repo=${value(repo)}`, ...known, 'reminder=1'].join(' ')
}

// onTurnComplete: a main-loop turn ended (an agent's turn is act-agents.ts's). Every valid
// ANSWER block in its text closes its wake, whichever turn it came in. Then the open wakes this
// turn belonged to: a tell is delivered once its turn said something (D-25); a judge or task
// that is still open gets exactly one reminder, which repeats why its answer was refused, and
// after that waits for its timeout (SPEC 8.2, 10.8).
export function onTurnComplete(ledger: readonly LedgerEntry[], turn: TurnEnd, repo: string): TurnOutcome {
  const out: TurnOutcome = { updates: [], prompts: [], problems: [] }
  if (turn.agentId !== undefined) return out
  const parsed = parseAnswers(turn.answer)
  out.problems.push(...parsed.problems)
  const refused: string[] = [...parsed.problems]
  let current = [...ledger]
  for (const block of parsed.blocks) {
    const checked = checkAnswer(current, block, repo)
    if (!checked.ok) {
      out.problems.push(checked.problem)
      refused.push(checked.problem)
      continue
    }
    const { update } = checked
    out.updates.push(update)
    // a second block for the same id finds it answered
    current = current.map(e => (e.key === update.key ? { ...e, status: update.status } : e))
  }
  for (const entry of current) {
    if (!isOpenWake(entry) || entry.turnId !== turn.turnId) continue
    const label = `${HEADS[wakeKind(entry.kind) ?? 'judge']} ${entry.wake ?? ''} ${entry.wakeId ?? ''}`
    if (entry.kind === 'tell') {
      if (turn.reason === 'answer' && turn.answer.trim() !== '') out.updates.push({ key: entry.key, status: 'done', summary: 'delivered' })
      else out.problems.push(`${label}: its turn ended (${turn.reason}) with nothing said; it waits for its timeout`)
      continue
    }
    if (entry.reminded === true) {
      out.problems.push(`${label}: no answer after its reminder; it waits for its timeout`)
      continue
    }
    out.updates.push({ key: entry.key, status: 'running', reminded: true })
    const why = refused.slice(0, REFUSALS_SHOWN).map(p => `not accepted: ${p}`)
    out.prompts.push(wakePrompt(reminderLine(entry, repo), why))
  }
  return out
}

// --- timeouts (SPEC 8.2, 10.8) ---------------------------------------------------------------

function duration(ms: Ms): string {
  if (ms > 0 && ms % HOUR === 0) return `${ms / HOUR}h`
  if (ms > 0 && ms % MIN === 0) return `${ms / MIN}m`
  return `${Math.round(ms / 1000)}s`
}

// fallback: an open wake that will get no answer, ended as its timeout ends it. It never acts: a
// judge is done with decision hold (plan holds on it), a task is timed-out (plan tells the owner,
// task-timeout), a tell is timed-out (dropped). why: what ended it; undelivered: the same for a tell.
function fallback(e: LedgerEntry, kind: WakeKind, why: string, undelivered: string): WakeUpdate {
  if (kind === 'judge') {
    const reason = `${why}, so the loop holds`
    const outcome: Outcome = { kind: 'wake', decision: 'hold', reason, instructions: null, bump: null, bumpReason: null, fields: {} }
    return { key: e.key, status: 'done', outcome, summary: `timed out: ${reason}` }
  }
  if (kind === 'task') return { key: e.key, status: 'timed-out', summary: `timed out: ${why}` }
  return { key: e.key, status: 'timed-out', summary: `dropped: ${undelivered}` }
}

// expireWakes: the open wakes past config.wakeTimeoutMs for their kind, counted from the submit,
// ended by their fallback.
export function expireWakes(ledger: readonly LedgerEntry[], now: Ms, config: Config): WakeUpdate[] {
  const out: WakeUpdate[] = []
  for (const e of ledger) {
    const kind = wakeKind(e.kind)
    if (kind === null || e.status !== 'running') continue
    const limit = config.wakeTimeoutMs[kind]
    if (now - e.startedAt < limit) continue
    out.push(fallback(e, kind, `no answer within ${duration(limit)}`, `not delivered within ${duration(limit)}`))
  }
  return out
}

// orphanedWakes: the open wakes no one can answer any more (SPEC 7.5): one another session
// submitted, or one that records no session (an older build, or rebuilt from the event log) and
// started before this load. Its prompt went with that session, so it is lost at once with its
// attempt given back, as a late drop is (D-55): it holds no other wake (O2) until its timeout,
// and its rule decides again next pass. A module reload within one session keeps its wakes.
export function orphanedWakes(ledger: readonly LedgerEntry[], session: string, loadedAt: Ms): WakeUpdate[] {
  const out: WakeUpdate[] = []
  for (const e of ledger) {
    if (wakeKind(e.kind) === null || e.status !== 'running') continue
    const gone = e.session === undefined ? e.startedAt < loadedAt : session !== '' && e.session !== session
    if (!gone) continue
    const why = e.session === undefined ? 'it was open before this load' : 'its session ended'
    out.push({ key: e.key, status: 'lost', attempts: Math.max(0, e.attempts - 1), summary: `lost: ${why}` })
  }
  return out
}

// --- the answer tool (SPEC 8.2, D-04) --------------------------------------------------------

// mcp__factory-loop__answer: the same answer as the block. The block is the primary channel (a
// turn that starts during a plugin reload lacks the tool), so the tool waits behind ToolSearch
// and costs the prompt nothing.
export const ANSWER_TOOL: ToolSpec = {
  name: 'answer',
  description:
    "Answer the factory loop's open JUDGE or TASK wake, as the ANSWER block in your final message " +
    'does (send one or the other, never both). id: the wake line\'s id= value; decision: one the ' +
    'factory-loop:judge skill allows for that wake; reason and instructions: one line each; fields: ' +
    "judge report's object { brief, created, pendingDecision }.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "the wake line's id= value" },
      decision: { type: 'string', description: 'a decision the wake allows' },
      reason: { type: 'string', description: 'one line, for the owner' },
      instructions: { type: 'string', description: "one line, for the agent's prompt" },
      fields: { type: 'object', description: 'judge report: { brief, created, pendingDecision }' },
    },
    required: ['id', 'decision'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export type ToolReply = { ok: boolean; text: string; update: WakeUpdate | null }

// answerTool: the tool's handler, through checkAnswer. `text` is what the tool answers; the
// driver applies `update`. Only the main conversation answers a wake: a call from inside an
// agent's loop (tool.call's agentId) is refused, as an agent's ANSWER block is ignored.
export function answerTool(ledger: readonly LedgerEntry[], input: unknown, repo: string, from: { agentId?: string } = {}): ToolReply {
  const no = (why: string): ToolReply => ({ ok: false, text: `Not recorded: ${why}.`, update: null })
  if (from.agentId !== undefined) return no('only the main conversation answers a wake')
  const o = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  if (o === null || typeof o.id !== 'string' || typeof o.decision !== 'string') return no('id and decision are required, as text')
  for (const key of ['reason', 'instructions'] as const) {
    if (o[key] !== undefined && o[key] !== null && typeof o[key] !== 'string') return no(`${key} must be text`)
  }
  const reason = typeof o.reason === 'string' ? o.reason : null
  const instructions = typeof o.instructions === 'string' ? o.instructions : null
  const checked = checkAnswer(ledger, { id: o.id, decision: o.decision, reason, instructions, fields: o.fields }, repo, 'tool')
  if (!checked.ok) return no(checked.problem)
  const outcome = checked.update.outcome
  const decision = outcome?.kind === 'wake' ? outcome.decision : o.decision
  return { ok: true, text: `Recorded: ${o.id.trim()} ${decision}. No ANSWER block is needed.`, update: checked.update }
}
