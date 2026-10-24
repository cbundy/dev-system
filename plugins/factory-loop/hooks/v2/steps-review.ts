// How the review step's reviewer runs and reads its answer (docs/factory-loop/v2/SPEC.md 8.2 to
// 8.4): the Reviewer the `reviewer` setting picks (reviewer.ts), a reader in the issue's slot on
// reviewerModel, its prompt (prompts-review.ts) and its contract (contracts-review.mjs). The
// generic agent step (steps.ts) spawns it and reads the answer; the plan (rules-review.ts) keys it
// by patch and round, joins its result with the CI half and plans its writes.
//
// - spawn builds the ReviewInput from the state the pass planned from: the record, the PR the
//   life's ensure named, the PR's head and patch, whose short form the key carries, and the round
//   the key names; the PR's earlier rounds with the reviewer's and the fixer's answer files; the
//   notes. Without any of them it refuses: the plan starts a reviewer only once it has them, so a
//   refusal is a loop bug, and the attempt fails, never retried.
// - The job's data carries the round (the contract checks finding ids by it), and what was
//   reviewed: the patch, the head, the PR and the reviewer's id, which the result carries on.
// - result: approve is ok, changes is not-ok `changes`; the data is reviewer.ts ReviewData, which
//   the plan reads for the PR comment, the `reviewed` event and the fixer's notes. An answer the
//   reviewer cannot read is unknown (bad-answer).
import type { ExecCtx } from '../exec'
import type { LedgerEntry } from '../types'
import { keyParts, scratchOf, short } from './keys'
import { REVIEW_PROMPTS } from './prompts-review'
import { UI_CAPTURE_KINDS, reviewerOf, uiCaptureKind } from './reviewer'
import type { PriorRound, ReviewInput, UiCaptureKind } from './reviewer'
import { baseOf, lifePr } from './rules-review'
import type { AgentStepAction, StepModule, StepRecord } from './steps'
import { stepFiles } from './steps-triage'
import { STEP_AGENT, unknownResult } from './types'
import type { AgentStep, IssueRecord, StepResult } from './types'

// The rest of a review key within its life (keys.ts reviewKey): review/<patch7>/r<round>/a<k>.
const REVIEW_REST = /^review\/([0-9a-f]+)\/r(\d+)\/a(\d+)$/

function reviewKeyOf(key: string): { patch7: string; round: number } | null {
  const m = REVIEW_REST.exec(keyParts(key)?.rest ?? '')
  return m === null ? null : { patch7: m[1] as string, round: Number(m[2]) }
}

function lifeOf(ledger: readonly LedgerEntry[], r: Pick<IssueRecord, 'issue' | 'life'>, step: AgentStep): LedgerEntry[] {
  return ledger.filter(e => {
    const p = keyParts(e.key)
    return e.kind === 'agent-step' && e.step === step && p !== null && p.issue === r.issue && p.life === r.life
  })
}

// answerOf: a step key's answer file (steps.ts stepAnswerPath; steps.ts imports this module, so
// the path comes through steps-triage.ts stepFiles, named the same way).
const answerOf = (loopDir: string, key: string) => stepFiles(loopDir, key)[1] as string

// priorOf: the PR's earlier rounds of this life: each round's newest review that gave a verdict,
// with the answer of the first fixer that started after it.
export function priorOf(ctx: ExecCtx, r: Pick<IssueRecord, 'issue' | 'life'>, round: number): PriorRound[] {
  const ledger = ctx.state.ledger
  const loopDir = ctx.rt.loopDir
  const fixes = lifeOf(ledger, r, 'fix')
    .filter(e => e.status === 'done')
    .sort((a, b) => a.startedAt - b.startedAt)
  const byRound = new Map<number, LedgerEntry>()
  for (const e of lifeOf(ledger, r, 'review')) {
    const k = reviewKeyOf(e.key)
    if (k === null || k.round >= round || e.status !== 'done' || e.outcome?.kind !== 'step' || e.outcome.result.event === 'unknown') continue
    const seen = byRound.get(k.round)
    if (seen === undefined || (e.endedAt ?? 0) > (seen.endedAt ?? 0)) byRound.set(k.round, e)
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, e]) => {
      const fixer = fixes.find(f => f.startedAt >= (e.endedAt ?? e.startedAt))
      const prior: PriorRound = { round: n, answerPath: answerOf(loopDir, e.key) }
      if (fixer !== undefined) prior.fixerPath = answerOf(loopDir, fixer.key)
      return prior
    })
}

// reviewInput: what the reviewer is given, from the state the pass planned from; why not, when it
// lacks something the plan had (a loop bug).
export function reviewInput(ctx: ExecCtx, action: AgentStepAction): ReviewInput | string {
  const r = (ctx.state.v2?.records ?? []).find(x => x.issue === action.issue && x.life === action.life)
  if (r === undefined) return `#${action.issue} has no record of life ${action.life} in the state the pass planned from`
  const key = reviewKeyOf(action.key)
  if (key === null) return `${action.key} is not a review key (review/<patch>/r<round>/a<k>)`
  // the life's PR: the plan starts a reviewer only once its ensure is done
  const pr = lifePr(ctx.state.ledger, r)
  if (pr === null) return `#${action.issue} has no PR to review: its ensure is not done`
  const pv = (ctx.state.v2?.prs.prs ?? []).find(p => p.pr === pr)
  if (pv === undefined || pv.head === null || pv.patch === null) return `PR #${pr} has no head and patch in the state the pass planned from`
  if (short(pv.patch) !== key.patch7) return `PR #${pr}'s patch is ${short(pv.patch)}, not the ${key.patch7} its review key names`
  return {
    issue: r.issue,
    brief: r.brief,
    pr,
    base: baseOf(ctx.state),
    head: pv.head,
    patch: pv.patch,
    round: key.round,
    prior: priorOf(ctx, r, key.round),
    notes: action.notes,
    uiCapture: ctx.rt.config.uiCapture,
  }
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// reviewResult: a checked answer's meaning, with what was reviewed (the step record's data) and
// where the answer is.
export function reviewResult(ctx: ExecCtx, rec: StepRecord, answer: unknown): StepResult {
  const data = record(rec.data) ?? {}
  const id = typeof data.reviewer === 'string' ? data.reviewer : ctx.rt.config.reviewer
  const reviewer = reviewerOf(id, { model: ctx.rt.config.reviewerModel })
  if (reviewer === null) return unknownResult('bad-answer', `no reviewer named ${id} reads this answer`)
  const result = reviewer.read(answer)
  if (result === null) return unknownResult('bad-answer', `the ${id} reviewer could not read the answer`)
  const reviewed = { round: data.round, patch: data.patch, head: data.head, pr: data.pr, reviewer: id, answer: rec.answerFile, ...(UI_CAPTURE_KINDS.includes(data.uiCapture as UiCaptureKind) ? { uiCapture: data.uiCapture } : {}) }
  const summary = result.summary.replace(/\s+/g, ' ').trim()
  return {
    event: result.verdict === 'approve' ? 'ok' : 'not-ok',
    reason: result.verdict === 'approve' ? null : 'changes',
    why: null,
    head: null,
    choice: null,
    data: { ...result, ...reviewed, text: summary.length > 300 ? `${summary.slice(0, 297)}...` : summary },
  }
}

const review: StepModule = {
  step: 'review',
  contract: 'review',
  spawn: async (ctx, action, place) => {
    const input = reviewInput(ctx, action)
    if (typeof input === 'string') return input
    const reviewer = reviewerOf(ctx.rt.config.reviewer, { model: ctx.rt.config.reviewerModel })
    if (reviewer === null) return `the reviewer setting names no reviewer: ${ctx.rt.config.reviewer}`
    const spec = reviewer.spawn(input)
    if (spec.agentType !== STEP_AGENT.review) return `the ${reviewer.id} reviewer asks for ${spec.agentType}; the review step spawns ${STEP_AGENT.review}`
    const prompt = Object.hasOwn(REVIEW_PROMPTS, spec.prompt) ? REVIEW_PROMPTS[spec.prompt] : undefined
    if (prompt === undefined) return `no review prompt is named ${spec.prompt}`
    return {
      prompt: prompt(spec.input, { repo: ctx.rt.repo, branch: action.branch, slot: action.slot, scratch: scratchOf(ctx.rt.loopDir, action.issue, action.life, action.seq), place }),
      model: spec.model,
      data: { round: input.round, patch: input.patch, head: input.head, pr: input.pr, reviewer: reviewer.id, uiCapture: uiCaptureKind(input.uiCapture) },
    }
  },
  result: async (ctx, rec, answer) => reviewResult(ctx, rec, answer),
}

export const STEPS: Partial<Record<AgentStep, StepModule>> = { review }
