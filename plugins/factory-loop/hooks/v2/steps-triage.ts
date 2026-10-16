// How the triage step runs and reads its answer (docs/factory-loop/v2/SPEC.md 5.2): the one
// bounded triage call of the unknown path (rows U3 and T6), a reader in the issue's slot, on
// triageModel, with the last two results of the step and their files (prompts-triage.ts); its
// answer (contracts-triage.mjs) is the `triage` event's choice, which rows X1 to X5 take. The
// generic agent step (steps.ts) spawns it and reads the answer; the table reads the result
// (rules-agent.ts resultEvent).
import { answerPath } from '../exec'
import type { ExecCtx } from '../exec'
import type { LedgerEntry } from '../types'
import { keyParts } from './keys'
import { triagePrompt } from './prompts-triage'
import type { TriageInput, TriageResult } from './prompts-triage'
import { lifePr } from './rules-review'
import type { AgentStepAction, StepModule } from './steps'
import { STATE_STEP, TRIAGE_CHOICES } from './types'
import type { AgentStep, IssueRecord, StepResult } from './types'

// The files steps.ts keeps for a step attempt: its record, its answer and its agent's last words
// (steps.ts stepRecordPath and stepAnswerPath, exec.ts answerPath), named the same way.
const fileName = (key: string) => key.replace(/[^A-Za-z0-9._-]+/g, '_')

export function stepFiles(loopDir: string, key: string): string[] {
  return [`${loopDir}/spawns/${fileName(key)}.json`, `${loopDir}/answers/${fileName(key)}.answer.json`, answerPath(loopDir, key)]
}

// The entries whose results triage reads: the step's attempts, its slot's preparation, and the
// merge queue's and CI's own actions; never a triage's own.
const RESULT_KINDS: readonly string[] = ['agent-step', 'slot', 'queue-update', 'queue-merge', 'ci-rerun']
const RESULTS = 2
const ERROR_MAX = 2000

function isResult(e: LedgerEntry): boolean {
  if (!RESULT_KINDS.includes(e.kind) || e.status === 'running') return false
  if (e.kind === 'agent-step') return e.step !== 'triage'
  return e.kind !== 'slot' || /\/prepare\/a\d+$/.test(e.key)
}

// errorOf: what went wrong, as the entry recorded it: a step's reason, a command's output, the
// guard's lines.
function errorOf(e: LedgerEntry): string | null {
  const o = e.outcome
  if (o?.kind === 'step') return o.result.reason
  if (o?.kind === 'cli') return o.detail ?? null
  if (o?.kind === 'queue') return o.lines.join('\n') || null
  return null
}

// resultsOf: the last results of the record's life, newest first, with the loop's files on each.
export function resultsOf(ctx: ExecCtx, r: Pick<IssueRecord, 'issue' | 'life'>): TriageResult[] {
  const loopDir = ctx.rt.loopDir
  return ctx.state.ledger
    .filter(e => {
      const p = keyParts(e.key)
      return p !== null && p.issue === r.issue && p.life === r.life && isResult(e)
    })
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, RESULTS)
    .map(e => {
      const seq = keyParts(e.key)?.seq ?? null
      const files = e.kind === 'agent-step' ? stepFiles(loopDir, e.key) : []
      if (seq !== null) files.push(`${loopDir}/leftovers/${r.issue}-${r.life}-s${seq}-*.patch (uncommitted work an attempt left, if any)`)
      if (e.kind === 'agent-step' && (e.step === 'build' || e.step === 'fix')) files.push(`${loopDir}/companion.jsonl (the stop gate's runs: lines with cause gate-pass, gate-fail or gate-unknown, and this step's issue and seq)`)
      const error = errorOf(e)
      return { key: e.key, kind: e.step ?? e.kind, status: e.status, summary: e.summary ?? '', error: error === null ? null : error.slice(0, ERROR_MAX), files }
    })
}

// triageInput: what the prompt names, from the state the pass planned from; why not, when the
// record is not in it (a loop bug).
export function triageInput(ctx: ExecCtx, action: AgentStepAction, place: TriageInput['place']): TriageInput | string {
  const r = (ctx.state.v2?.records ?? []).find(x => x.issue === action.issue && x.life === action.life)
  if (r === undefined) return `#${action.issue} has no record of life ${action.life} in the state the pass planned from`
  const config = ctx.rt.config
  // the life's PR: the record's, else the one this life's ensure opened (8.1)
  const pr = lifePr(ctx.state.ledger, r)
  const pv = pr === null ? undefined : ctx.state.v2?.prs.prs.find(p => p.pr === pr)
  const prState = r.state === 'reviewing' || r.state === 'merge-queue'
  const review = ctx.state.ledger
    .filter(e => e.kind === 'agent-step' && e.step === 'review' && e.status === 'done' && keyParts(e.key)?.life === r.life && e.issue === r.issue)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  const merge = ctx.state.ledger
    .filter(e => e.kind === 'queue-merge' && keyParts(e.key)?.life === r.life && e.issue === r.issue && e.outcome?.kind === 'queue')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  const guard = merge?.outcome?.kind === 'queue' ? merge.outcome.lines.filter(l => /\bFAIL\b/.test(l)) : []
  return {
    repo: ctx.rt.repo,
    issue: r.issue,
    slot: action.slot,
    state: r.state,
    step: STATE_STEP[r.state],
    attempt: r.attempt,
    triages: r.triages,
    maxTriages: config.maxTriages,
    fixes: r.fixes,
    fixCap: config.reviewFixCap,
    round: r.round,
    brief: r.brief,
    branch: r.branch,
    head: r.head,
    pr,
    results: resultsOf(ctx, r),
    checks: prState ? (pv?.checks ?? []).map(c => ({ name: c.name, bucket: c.bucket, link: c.link })) : null,
    mergeable: pv?.mergeable ?? null,
    reviewAnswer: review === undefined ? null : stepFiles(ctx.rt.loopDir, review.key)[1] ?? null,
    guard,
    notes: action.notes,
    fixValid: (r.head !== null || pr !== null) && r.fixes < config.reviewFixCap,
    place,
  }
}

// The checked answer's meaning: ok, with the choice, its reason, and the instructions or the
// question for the row that takes it.
export function triageResult(answer: unknown): StepResult {
  const a = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {}
  const choice = TRIAGE_CHOICES.find(c => c === a.choice) ?? null
  const reason = typeof a.reason === 'string' ? a.reason : null
  const data = { text: reason ?? undefined, instructions: typeof a.instructions === 'string' ? a.instructions : undefined, question: typeof a.question === 'string' ? a.question : undefined }
  if (choice === null) return { event: 'unknown', reason: 'the triage answer has no choice', why: 'bad-answer', head: null, choice: null, data: null }
  return { event: 'ok', reason, why: null, head: null, choice, data }
}

const triage: StepModule = {
  step: 'triage',
  contract: 'triage',
  spawn: async (ctx, action, place) => {
    const input = triageInput(ctx, action, place)
    if (typeof input === 'string') return input
    const model = ctx.rt.config.triageModel.trim()
    return { prompt: triagePrompt(input), model: model === '' ? null : model, data: null }
  },
  result: async (_ctx, _record, answer) => triageResult(answer),
}

export const STEPS: Partial<Record<AgentStep, StepModule>> = { triage }
