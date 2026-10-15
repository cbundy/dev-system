// How the designer's, the builder's and the fixer's steps run and read their answers
// (docs/factory-loop/v2/SPEC.md 4.2, 5.1, 7.1, 8.7, 9.7, 10.8): their prompts (prompts-work.ts),
// their contracts (contracts-work.mjs: design-v2, build, fix) and what an answer means.
//
// - design: a brief is ok, a question or a split is not-ok; the plan side (rules-work.ts) posts the
//   brief and makes the split's children before the result counts. A reader: nothing is read on
//   origin.
// - build: the builder runs on the model `callum-flow-implementer-route` picks, which also logs
//   `implementer_routed` (7.1). `cannot` is not-ok at once. `built` is ok only when origin's
//   branch, read directly (`git ls-remote`), has commits beyond the base and holds the answered
//   head (it is the head or an ancestor of it); no branch, or none beyond the base, is not-ok
//   (no-commit); a head origin does not hold is unknown, and so is any failed read (10.8), never
//   not-ok.
// - fix: ok is a new head on origin's branch, new against the head the attempt's slot was prepared
//   at; a fix that says it pushed while origin did not move is unknown. Every finding declined is
//   not-ok (declined) from the answer alone, whatever origin did, the reasons going to the notes
//   of the next round (T12): the next round's review and CI see anything pushed anyway. So a
//   declined answer is never ok, and `says` and the result always agree.
// build and fix give `says` (steps.ts StepModule), so a writer's not-ok ends its step when read
// while its ok waits for the turn's end and the stop gate (10.8).
import type { ExecCtx } from '../exec'
import type { LedgerEntry, State } from '../types'
import * as ARGV from './argv'
import type { BuildAnswer, DesignAnswer, FixAnswer } from './contracts-work.mjs'
import { keyParts, prepareKey } from './keys'
import { buildPrompt, checkIdsOf, designPrompt, fixPrompt } from './prompts-work'
import type { FixInput, FixWhy, Prior, WorkInput } from './prompts-work'
import type { AgentStepAction, StepModule, StepRecord } from './steps'
import { stepFiles } from './steps-triage'
import { SLOT_STATES, unknownResult } from './types'
import type { AgentStep, IssueRecord, StepResult } from './types'

const SEC = 1000
const ROUTE_MS = 60 * SEC
const GIT_MS = 60 * SEC
const FETCH_MS = 120 * SEC
const REASON_MAX = 2000
const MODEL = /^[A-Za-z0-9._-]+$/

// --- models (copies of act-agents.ts routedModel and modelLabelOf, a v1 module) ---------------------

// routedModel: callum-flow-implementer-route prints exactly one line, the model alias; anything
// else is null.
export function routedModel(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  const only = lines.length === 1 ? lines[0] : undefined
  return only !== undefined && MODEL.test(only) ? only : null
}

// modelLabelOf: the issue's `model:<alias>` label (lower case, the first in sorted order), the
// owner's pick for the designer and the fixer; null for none.
export function modelLabelOf(state: State, issue: number): string | null {
  const labels = (state.issues.find(i => i.number === issue)?.labels ?? [])
    .map(l => l.toLowerCase())
    .filter(l => l.startsWith('model:'))
    .sort()
  const first = labels[0]?.slice('model:'.length)
  return first !== undefined && MODEL.test(first) ? first : null
}

// --- what a prompt names -------------------------------------------------------------------------------

// baseOf: origin's default branch, as the main checkout's read names it; main when unread.
export function baseOf(state: State): string {
  const c = state.checkout
  return c !== null && 'defaultBranch' in c && c.defaultBranch !== '' ? c.defaultBranch : 'main'
}

// recordOf: the record the action's step is of, in the state the pass planned from; why not, when
// it is not there (a loop bug).
function recordOf(ctx: ExecCtx, action: AgentStepAction): IssueRecord | string {
  const r = (ctx.state.v2?.records ?? []).find(x => x.issue === action.issue && x.life === action.life)
  return r ?? `#${action.issue} has no record of life ${action.life} in the state the pass planned from`
}

// priorOf: the newest earlier attempt of this step in the record's current state (a retry, a free
// re-run, a triage's retry), with how it ended and the loop's files about it (5.1); null for a
// first attempt.
export function priorOf(ctx: ExecCtx, r: IssueRecord, step: AgentStep, key: string): Prior | null {
  const e = ctx.state.ledger
    .filter(x => x.kind === 'agent-step' && x.step === step && x.key !== key && x.status !== 'running' && x.startedAt >= r.since)
    .filter(x => {
      const p = keyParts(x.key)
      return p !== null && p.issue === r.issue && p.life === r.life
    })
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0]
  if (e === undefined) return null
  const o = e.outcome
  const reason = o?.kind === 'step' ? o.result.reason : o?.kind === 'cli' ? (o.detail ?? null) : null
  const ended = o?.kind === 'step' ? `${e.status} (${o.result.event}${o.result.why === null ? '' : `: ${o.result.why}`})` : e.status
  return { key: e.key, status: ended, summary: e.summary ?? '', reason: reason === null ? null : reason.slice(0, REASON_MAX), files: stepFiles(ctx.rt.loopDir, e.key) }
}

// workInput: what every work prompt names, for this attempt.
function workInput(ctx: ExecCtx, action: AgentStepAction, r: IssueRecord, place: WorkInput['place']): WorkInput {
  return {
    repo: ctx.rt.repo,
    issue: r.issue,
    slot: action.slot,
    branch: action.branch,
    base: baseOf(ctx.state),
    head: r.head,
    pr: r.pr,
    brief: r.brief,
    attempt: action.attempt,
    notes: action.notes,
    prior: priorOf(ctx, r, action.step, action.key),
    leftovers: `${ctx.rt.loopDir}/leftovers/${r.issue}-${r.life}-s${action.seq}-*.patch`,
    place,
  }
}

// inFlightOf: the other records in a slot state, by issue, with their branches.
function inFlightOf(state: State, issue: number): { issue: number; branch: string }[] {
  return (state.v2?.records ?? []).filter(r => r.issue !== issue && SLOT_STATES.includes(r.state)).map(r => ({ issue: r.issue, branch: r.branch }))
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

// fixWhyOf: why the record is in fixing: the newest transition of its life, up to its seq, that
// sent it toward a fixer (sentToFix). A retry inside fixing (U1's free re-run, U2's second
// attempt, X1's triage retry) and a resume (T1) are their own seqs with their own vias, so they
// keep the reason the fixing began with. null when no such transition is in the ledger (a
// rebuild, a pruned ledger).
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

// latestReview: the life's newest done review, whose answer a fixer reads.
function latestReview(state: State, r: IssueRecord): LedgerEntry | null {
  return (
    state.ledger
      .filter(e => e.kind === 'agent-step' && e.step === 'review' && e.status === 'done' && e.issue === r.issue && keyParts(e.key)?.life === r.life)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0] ?? null
  )
}

// errorFindings: the ids of the review's error findings, each of which the fixer must give a
// disposition: the review result's findings (its contract's outcome, 8.2) with severity error, or
// every finding when they carry no severity. [] when the result has none in that shape.
export function errorFindings(review: LedgerEntry | null): string[] {
  const data = review?.outcome?.kind === 'step' ? review.outcome.result.data : null
  const list = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as { findings?: unknown }).findings : undefined
  if (!Array.isArray(list)) return []
  const findings = list.flatMap(f => {
    const o = f !== null && typeof f === 'object' ? (f as Record<string, unknown>) : {}
    return typeof o.id === 'string' ? [{ id: o.id, severity: typeof o.severity === 'string' ? o.severity : null }] : []
  })
  const graded = findings.some(f => f.severity !== null)
  return findings.filter(f => !graded || f.severity === 'error').map(f => f.id)
}

// findingsFor: the ids the fixer must give a disposition each: the review's error findings when a
// review sent it, the failed checks the record's notes name when red CI did (T9 copies the
// ending step's notes, each failed check's made by checkNote), else none.
function findingsFor(why: FixWhy | null, review: LedgerEntry | null, notes: readonly string[]): string[] {
  if (why === 'review') return errorFindings(review)
  return why === 'ci' ? checkIdsOf(notes) : []
}

// fixInput: the fixer's input. The failed checks come only from the record's notes, which the
// not-ok result that sent it to fixing gave (T9): the PR source covers reviewing and the merge
// queue alone (2.4), so it holds no current view of a record in fixing.
function fixInput(ctx: ExecCtx, action: AgentStepAction, r: IssueRecord, place: WorkInput['place']): FixInput {
  const why = fixWhyOf(ctx.state, r)
  const review = latestReview(ctx.state, r)
  return {
    ...workInput(ctx, action, r, place),
    round: r.round,
    why,
    reviewAnswer: review === null ? null : (stepFiles(ctx.rt.loopDir, review.key)[1] ?? null),
    findings: findingsFor(why, review, r.notes),
  }
}

// --- origin, read directly (10.8) ------------------------------------------------------------------------

type Ran = { ok: true; exit: number; out: string; err: string } | { ok: false; why: string }

async function git(ctx: ExecCtx, argv: string[], cwd: string, timeoutMs = GIT_MS): Promise<Ran> {
  try {
    const r = await ctx.cmd(argv, { cwd, timeoutMs })
    return { ok: true, exit: r.exitCode, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, why: `${argv.slice(0, 2).join(' ')}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function failure(r: Extract<Ran, { ok: true }>, argv: string[]): string {
  const line = (r.err.trim() || r.out.trim()).split('\n').pop() ?? ''
  return `${argv.slice(0, 2).join(' ')}: exit ${r.exit}${line === '' ? '' : `: ${line}`}`
}

// originHead: the branch's head on origin (`git ls-remote origin refs/heads/<branch>`): the sha,
// null when origin has no such branch, or why the read failed.
export async function originHead(ctx: ExecCtx, branch: string, cwd: string): Promise<{ sha: string | null } | { failed: string }> {
  const argv = ARGV.lsRemoteArgv(branch)
  const r = await git(ctx, argv, cwd)
  if (!r.ok) return { failed: r.why }
  if (r.exit !== 0) return { failed: failure(r, argv) }
  for (const line of r.out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/heads/${branch}` && sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return { sha }
  }
  if (r.out.trim() !== '') return { failed: `git ls-remote: an answer not in its shape: ${r.out.trim().slice(0, 120)}` }
  return { sha: null }
}

// holds: origin's commits fetched into the slot, then whether the answered commit is the head or
// one of its ancestors; why not, or why the reads failed (cli).
async function holds(ctx: ExecCtx, slot: string, answered: string, head: string): Promise<{ held: boolean } | { failed: string }> {
  const fetch = ARGV.fetchArgv()
  const f = await git(ctx, fetch, slot, FETCH_MS)
  if (!f.ok) return { failed: f.why }
  if (f.exit !== 0) return { failed: failure(f, fetch) }
  if (head.startsWith(answered)) return { held: true }
  const argv = ARGV.isAncestorArgv(answered, head)
  const a = await git(ctx, argv, slot)
  if (!a.ok) return { failed: a.why }
  // 1: not an ancestor; 128: a commit origin does not have
  if (a.exit === 1 || (a.exit === 128 && /not a valid|bad object|unknown revision/i.test(a.err))) return { held: false }
  return a.exit === 0 ? { held: true } : { failed: failure(a, argv) }
}

// beyond: how many commits the head has beyond origin's default branch, or why the read failed.
async function beyond(ctx: ExecCtx, slot: string, base: string, head: string): Promise<{ count: number } | { failed: string }> {
  const argv = ARGV.beyondBaseArgv(base, head)
  const r = await git(ctx, argv, slot)
  if (!r.ok) return { failed: r.why }
  if (r.exit !== 0) return { failed: failure(r, argv) }
  const n = Number(r.out.trim())
  return Number.isInteger(n) && n >= 0 ? { count: n } : { failed: `git rev-list: a count not in its shape: ${r.out.trim().slice(0, 60)}` }
}

const ok = (head: string, data: unknown): StepResult => ({ event: 'ok', reason: null, why: null, head, choice: null, data })
const notOk = (reason: string, data: unknown): StepResult => ({ event: 'not-ok', reason, why: null, head: null, choice: null, data })

// --- the three steps --------------------------------------------------------------------------------------

function asDesign(answer: unknown): DesignAnswer | null {
  const a = answer as Partial<DesignAnswer> | null
  return a !== null && typeof a === 'object' && (a.kind === 'brief' || a.kind === 'question' || a.kind === 'split') ? (a as DesignAnswer) : null
}

// designResult: the checked design answer's meaning (8.7), with the answer as the data the plan
// side reads.
export function designResult(answer: unknown): StepResult {
  const a = asDesign(answer)
  if (a === null) return unknownResult('bad-answer', 'the design answer has no kind')
  if (a.kind === 'brief') return { event: 'ok', reason: null, why: null, head: null, choice: null, data: a }
  return notOk(a.kind, { ...a, text: a.kind === 'question' ? a.question : `split into ${a.children.length} children` })
}

// buildResult: a build answer, its head confirmed on origin (10.8).
export async function buildResult(ctx: ExecCtx, record: StepRecord, answer: unknown): Promise<StepResult> {
  const a = answer as BuildAnswer
  if (a.result === 'cannot') return notOk('cannot', { ...a, text: a.reason ?? 'the builder cannot finish' })
  if (a.result !== 'built' || a.head === null) return unknownResult('bad-answer', 'the build answer is neither built with a head nor cannot')
  if (record.slot === null) return unknownResult('cli', 'the build step has no slot to read origin from')
  const base = baseOf(ctx.state)
  const read = await originHead(ctx, record.branch, record.slot)
  if ('failed' in read) return unknownResult('cli', `origin's ${record.branch} did not read: ${read.failed}`)
  if (read.sha === null) return notOk('no-commit', { ...a, text: `origin has no branch ${record.branch}: nothing was pushed` })
  const held = await holds(ctx, record.slot, a.head, read.sha)
  if ('failed' in held) return unknownResult('cli', `origin's ${record.branch} did not read: ${held.failed}`)
  const count = await beyond(ctx, record.slot, base, read.sha)
  if ('failed' in count) return unknownResult('cli', `origin's ${record.branch} did not read: ${count.failed}`)
  if (count.count === 0) return notOk('no-commit', { ...a, text: `origin's ${record.branch} has no commit beyond origin/${base}` })
  if (!held.held) return unknownResult('bad-answer', `the answered head ${a.head.slice(0, 12)} is not on origin's ${record.branch}, whose head is ${read.sha.slice(0, 12)}: it was not pushed`)
  return ok(read.sha, a)
}

// startedAt: the head the attempt's slot was prepared at (10.2), the base a fix's new head is new
// against; else the PR's head as last read, else the head a writer last confirmed.
function startedAt(state: State, record: StepRecord): string | null {
  const prep = state.ledger.find(e => e.key === prepareKey(record, record.attempt))
  const head = prep?.outcome?.kind === 'slot' ? prep.outcome.head : null
  if (head !== null) return head
  const r = (state.v2?.records ?? []).find(x => x.issue === record.issue && x.life === record.life)
  const pv = r?.pr === null || r?.pr === undefined ? undefined : state.v2?.prs.prs.find(p => p.pr === r.pr)
  return pv?.head ?? r?.head ?? null
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

// declines: a fix answer's declined findings, as notes for the next review round (T12).
export function declines(a: FixAnswer): string[] {
  return a.findings.filter(f => f.disposition === 'declined').map(f => `the fixer declined ${f.id}: ${f.reason}`)
}

// fixResult: a fix answer's meaning. Declined is not-ok from the answer alone, as `says` reads it
// before the turn ends; fixed is ok only with a new head on origin that holds the answered one
// (10.8).
export async function fixResult(ctx: ExecCtx, record: StepRecord, answer: unknown): Promise<StepResult> {
  const a = answer as FixAnswer
  if (a.result === 'declined') return notOk('declined', { ...a, notes: declines(a), text: a.summary })
  if (a.result !== 'fixed' || a.head === null) return unknownResult('bad-answer', 'the fix answer is neither fixed with a head nor declined')
  if (record.slot === null) return unknownResult('cli', 'the fix step has no slot to read origin from')
  const read = await originHead(ctx, record.branch, record.slot)
  if ('failed' in read) return unknownResult('cli', `origin's ${record.branch} did not read: ${read.failed}`)
  if (read.sha === null) return unknownResult('cli', `origin has no branch ${record.branch}`)
  const before = startedAt(ctx.state, record)
  if (before !== null && sameSha(read.sha, before)) {
    return unknownResult('bad-answer', `the fixer says it pushed ${a.head.slice(0, 12)}, but origin's ${record.branch} is still at ${read.sha.slice(0, 12)}`)
  }
  const held = await holds(ctx, record.slot, a.head, read.sha)
  if ('failed' in held) return unknownResult('cli', `origin's ${record.branch} did not read: ${held.failed}`)
  if (!held.held) return unknownResult('bad-answer', `the answered head ${a.head.slice(0, 12)} is not on origin's ${record.branch}, whose head is ${read.sha.slice(0, 12)}: it was not pushed`)
  return ok(read.sha, { ...a, notes: declines(a) })
}

const says = (field: 'result', notOkValues: readonly string[]) => (answer: unknown) => {
  const v = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>)[field] : undefined
  return typeof v === 'string' && notOkValues.includes(v) ? 'not-ok' : 'ok'
}

const model = (text: string | null) => (text === null || text.trim() === '' ? null : text.trim())

const design: StepModule = {
  step: 'design',
  contract: 'design-v2',
  spawn: async (ctx, action, place) => {
    const r = recordOf(ctx, action)
    if (typeof r === 'string') return r
    // a reader applies no leftovers patch: it changes nothing in its slot
    const prompt = designPrompt({ ...workInput(ctx, action, r, place), leftovers: null, inFlight: inFlightOf(ctx.state, r.issue) })
    return { prompt, model: model(modelLabelOf(ctx.state, r.issue)), data: null }
  },
  result: async (_ctx, _record, answer) => designResult(answer),
}

// The builder's model: the route's answer (an issue's model label first, then the comparison's
// split); the route logs implementer_routed (7.1). A route that fails is the attempt's failure.
async function routed(ctx: ExecCtx, issue: number): Promise<string> {
  const argv = ARGV.implementerRouteArgv(issue)
  let out: string
  try {
    const r = await ctx.cmd(argv, { timeoutMs: ROUTE_MS })
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr.trim() || r.stdout.trim()).split('\n').pop() ?? ''}`)
    out = r.stdout
  } catch (err) {
    throw new Error(`callum-flow-implementer-route ${issue}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const m = routedModel(out)
  if (m === null) throw new Error(`callum-flow-implementer-route ${issue} printed no model`)
  return m
}

const build: StepModule = {
  step: 'build',
  contract: 'build',
  spawn: async (ctx, action, place) => {
    const r = recordOf(ctx, action)
    if (typeof r === 'string') return r
    let m: string
    try {
      m = await routed(ctx, r.issue)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    return { prompt: buildPrompt(workInput(ctx, action, r, place)), model: m, data: null }
  },
  result: buildResult,
  says: says('result', ['cannot']),
}

const fix: StepModule = {
  step: 'fix',
  contract: 'fix',
  spawn: async (ctx, action, place) => {
    const r = recordOf(ctx, action)
    if (typeof r === 'string') return r
    const input = fixInput(ctx, action, r, place)
    return { prompt: fixPrompt(input), model: model(modelLabelOf(ctx.state, r.issue)), data: input.findings.length === 0 ? null : { findings: input.findings } }
  },
  result: fixResult,
  says: says('result', ['declined']),
}

export const STEPS: Partial<Record<AgentStep, StepModule>> = { design, build, fix }
