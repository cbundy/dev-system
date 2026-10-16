// The reviewer interface and its registry (docs/factory-loop/v2/SPEC.md 8.2, 8.3), and what the
// loop makes of a review's result: the PR comment, the `reviewed` event, the fixer's notes, and the
// fixer's dispositions as `verdict` events (7.1, section 15).
//
// - Review is one swappable step: the `reviewer` setting picks an implementation from REVIEWERS by
//   its id. A Reviewer is pure: spawn gives the agent type, the model and the prompt it needs
//   (the prompt's kind, which prompts-review.ts renders, and the input), read gives the result a
//   contract-checked answer means, or null. The interim one is `adjudicator`: the merge
//   adjudicator's judgement in a definition of its own, agents/reviewer.md (8.3). The owner's A/B
//   test can run any implementation on frozen base and head pairs outside the loop; a new one is
//   an entry here and a setting, nothing more.
// - steps-review.ts spawns and reads it; rules-review.ts plans the writes built here, each a keyed
//   `comment` or `event` action that act-state.ts runs (act-review.ts adds no executor of its own).
//
// Pure: the plan imports this, so nothing here may run a command, read a file or read a clock.
import type { ReusedEvent, ReviewedEvent } from './events'
import { short } from './keys'
import { STEP_AGENT, type Model } from './types'

// --- the interface (8.2) ------------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info'
export type Bump = 'patch' | 'minor' | 'major'
export type Finding = { id: string; severity: Severity; file: string; line: number | null; text: string }
export type ReviewResult = { verdict: 'approve' | 'changes'; findings: Finding[]; summary: string; bump: Bump }

// One earlier round of the PR: the review's answer and the answer of the fixer that followed it.
export type PriorRound = { round: number; answerPath: string; fixerPath?: string }

export type ReviewInput = {
  issue: number
  brief: string | null
  pr: number
  base: string
  head: string
  patch: string
  round: number
  prior: PriorRound[]
  notes: string[]
}

// What a reviewer starts: its agent type (the loop spawns the review step's own, types.ts
// STEP_AGENT), its model, and its prompt's kind with the input.
export type AgentSpec = { agentType: string; model: Model; prompt: string; input: ReviewInput }

export interface Reviewer {
  id: string
  spawn(input: ReviewInput): AgentSpec
  read(answer: unknown): ReviewResult | null
}

const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info']
const BUMPS: readonly Bump[] = ['patch', 'minor', 'major']

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function findingOf(v: unknown): Finding | null {
  const o = record(v)
  if (o === null) return null
  const severity = SEVERITIES.find(s => s === o.severity)
  const line = o.line === null || o.line === undefined ? null : o.line
  if (typeof o.id !== 'string' || severity === undefined || typeof o.file !== 'string' || typeof o.text !== 'string') return null
  if (line !== null && !(typeof line === 'number' && Number.isInteger(line) && line > 0)) return null
  return { id: o.id, severity, file: o.file, line: line as number | null, text: o.text }
}

// readReview: a review answer in the `review` contract's checked shape (contracts-review.mjs) as a
// result: changes with at least one error finding, approve with none; null for anything else.
export function readReview(answer: unknown): ReviewResult | null {
  const o = record(answer)
  if (o === null || !Array.isArray(o.findings) || typeof o.summary !== 'string') return null
  const findings = o.findings.map(findingOf)
  const bump = BUMPS.find(b => b === o.bump)
  if (findings.some(f => f === null) || bump === undefined) return null
  const errors = (findings as Finding[]).filter(f => f.severity === 'error').length
  if (o.verdict === 'changes' && errors > 0) return { verdict: 'changes', findings: findings as Finding[], summary: o.summary, bump }
  if (o.verdict === 'approve' && errors === 0) return { verdict: 'approve', findings: findings as Finding[], summary: o.summary, bump }
  return null
}

// --- the registry -------------------------------------------------------------------------------------

export type ReviewerOpts = { model: Model }

// The interim reviewer (8.3): the merge adjudicator's judgement, given the brief and the PR's whole
// diff, in agents/reviewer.md; its prompt is prompts-review.ts's `adjudicator`.
function adjudicator(opts: ReviewerOpts): Reviewer {
  return {
    id: 'adjudicator',
    spawn: input => ({ agentType: STEP_AGENT.review, model: opts.model, prompt: 'adjudicator', input }),
    read: readReview,
  }
}

export const REVIEWERS: Readonly<Record<string, (opts: ReviewerOpts) => Reviewer>> = { adjudicator }

// reviewerOf: the reviewer the setting names, or null when the registry has none by that id.
export function reviewerOf(id: string, opts: ReviewerOpts): Reviewer | null {
  const make = Object.hasOwn(REVIEWERS, id) ? REVIEWERS[id] : undefined
  return make === undefined ? null : make(opts)
}

// --- a recorded review ----------------------------------------------------------------------------------

// What the review step records as its result's data (steps-review.ts): the result, and what it
// reviewed: the round, the patch and head, the PR, the reviewer's id and its answer file.
export type ReviewData = ReviewResult & { round: number; patch: string; head: string; pr: number; reviewer: string; answer: string }

// reviewDataOf: a result's data as ReviewData, or null when it is not one (an unknown, a step that
// recorded none).
export function reviewDataOf(data: unknown): ReviewData | null {
  const o = record(data)
  if (o === null) return null
  const result = readReview(o)
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v)
  const str = (v: unknown) => typeof v === 'string' && v !== ''
  if (result === null || !int(o.round) || !int(o.pr) || !str(o.patch) || !str(o.head) || !str(o.reviewer) || !str(o.answer)) return null
  return { ...result, round: o.round as number, patch: o.patch as string, head: o.head as string, pr: o.pr as number, reviewer: o.reviewer as string, answer: o.answer as string }
}

// answerName: where a step key's answer file is, under the loop dir (steps.ts stepAnswerPath, named
// the same way), for an event whose step recorded no path of its own.
export function answerName(key: string): string {
  return `answers/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.answer.json`
}

// --- the PR comment (8.3) -------------------------------------------------------------------------------

// The comment executor caps a body at 4 000 characters (prompts.ts neutral); the comment keeps
// within this, so its last line is never cut.
export const COMMENT_MAX = 3800
const LINE_MAX = 600

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

const RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 }

// ordered: the findings, errors first, each severity in the reviewer's order.
function ordered(findings: readonly Finding[]): Finding[] {
  return findings.map((f, i) => ({ f, i })).sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i).map(x => x.f)
}

function where(f: Finding): string {
  if (f.file === '') return ''
  return ` \`${f.file}${f.line === null ? '' : `:${f.line}`}\``
}

// reviewComment: one review result as the PR comment the loop posts: the verdict, the summary and
// the findings, errors first, within COMMENT_MAX; findings past it are counted, not shown.
export function reviewComment(d: ReviewData): string {
  const verdict = d.verdict === 'approve' ? 'approved' : 'changes requested'
  const counts = SEVERITIES.map(s => {
    const n = d.findings.filter(f => f.severity === s).length
    return `${n} ${s}${n === 1 ? '' : 's'}`
  }).join(', ')
  const head = [
    `**Factory loop review, round ${d.round}: ${verdict}**`,
    '',
    `Patch ${short(d.patch)} at head ${short(d.head)}, reviewer ${d.reviewer}, suggested release ${d.bump}; ${counts}.`,
    '',
    clip(d.summary, 1500),
  ]
  const lines = [...head]
  const findings = ordered(d.findings)
  if (findings.length > 0) lines.push('', 'Findings:')
  let shown = 0
  for (const f of findings) {
    const line = `- **${f.severity}** ${f.id}${where(f)}: ${clip(f.text, LINE_MAX)}`
    const tail = findings.length - shown - 1 > 0 ? 60 : 0
    if (lines.join('\n').length + line.length + 1 + tail > COMMENT_MAX) break
    lines.push(line)
    shown += 1
  }
  if (shown < findings.length) lines.push(`- ... and ${findings.length - shown} more finding${findings.length - shown === 1 ? '' : 's'} not shown here`)
  return lines.join('\n')
}

// --- the notes a fixer gets (T9, T10) -------------------------------------------------------------------

// A record keeps at most 8 notes (table.ts NOTES_MAX), the last ones: these come to at most that.
export const FIX_NOTES_MAX = 8
const NOTE_MAX = 900

// fixNotes: what a fixer is told: a lead line, then the items, each clipped, within FIX_NOTES_MAX;
// items past it are counted in the last line, with where to find them.
export function fixNotes(lead: string, items: readonly string[], rest: string): string[] {
  const room = FIX_NOTES_MAX - 1
  if (items.length <= room) return [lead, ...items].map(n => clip(n, NOTE_MAX))
  return [lead, ...items.slice(0, room - 1), `... and ${items.length - room + 1} more: ${rest}`].map(n => clip(n, NOTE_MAX))
}

// reviewNotes: a changes review as the fixer's lines: each finding by id, errors first, so the
// fixer gives a disposition for each (fixed, or declined with its reason). Lines of the same
// weight as an error (the PR's failed checks, when CI is red too) go right after the errors and
// before the warnings and infos, so fixNotes cuts a warning before one of them.
export function reviewNotes(d: ReviewData, withErrors: readonly string[] = []): string[] {
  const line = (f: Finding) => `${f.id} [${f.severity}]${f.file === '' ? '' : ` ${f.file}${f.line === null ? '' : `:${f.line}`}`}: ${f.text}`
  const findings = ordered(d.findings)
  const errors = findings.filter(f => f.severity === 'error')
  return [...errors.map(line), ...withErrors, ...findings.filter(f => f.severity !== 'error').map(line)]
}

export function reviewLead(d: ReviewData): string {
  return `review round ${d.round} asked for changes on patch ${short(d.patch)}: fix each error finding, or decline it with your reason; every finding is in ${d.answer}`
}

// --- the events (7.1) -----------------------------------------------------------------------------------

export type ReviewedAt = { issue: number; branch: string; pr: number; head: string; round: number; patch: string; reviewer: string; answer: string }

// reviewedEvent: the `reviewed` event of one review attempt: its verdict and counts, or `unknown`
// for an attempt that gave no valid answer.
export function reviewedEvent(at: ReviewedAt, d: ReviewData | null): ReviewedEvent {
  const count = (s: Severity) => (d === null ? 0 : d.findings.filter(f => f.severity === s).length)
  return {
    state: 'reviewed',
    issue: at.issue,
    branch: at.branch,
    pr: at.pr,
    head: at.head,
    verdict: d === null ? 'unknown' : d.verdict,
    round: at.round,
    patch: at.patch,
    errors: count('error'),
    warnings: count('warning'),
    infos: count('info'),
    reviewer: at.reviewer,
    answer: at.answer,
  }
}

// One finding a fixer handled: fixed, or declined with its reason.
export type Disposition = { id: string; fixed: boolean; reason: string }

const FIXED_WORDS: readonly string[] = ['fixed', 'correct']
const DECLINED_WORDS: readonly string[] = ['declined', 'wrong']

function dispositionOf(v: unknown): Disposition | null {
  const o = record(v)
  if (o === null || typeof o.id !== 'string' || o.id.trim() === '') return null
  const word = typeof o.disposition === 'string' ? o.disposition.toLowerCase() : null
  const fixed = typeof o.fixed === 'boolean' ? o.fixed : word !== null && FIXED_WORDS.includes(word) ? true : word !== null && DECLINED_WORDS.includes(word) ? false : null
  if (fixed === null) return null
  return { id: o.id.trim(), fixed, reason: typeof o.reason === 'string' ? o.reason : '' }
}

// dispositionsOf: what a fix step's result data says of each finding it handled: its
// `dispositions` (or `findings`), each { id, fixed: boolean | disposition: fixed|declined, reason };
// entries in neither shape are left out.
export function dispositionsOf(data: unknown): Disposition[] {
  const o = record(data)
  const list = o === null ? null : Array.isArray(o.dispositions) ? o.dispositions : Array.isArray(o.findings) ? o.findings : null
  if (list === null) return []
  const out: Disposition[] = []
  for (const v of list) {
    const d = dispositionOf(v)
    if (d !== null && !out.some(x => x.id === d.id)) out.push(d)
  }
  return out
}

// A verdict note within one event row's note (events.ts NOTE_MAX).
const VERDICT_NOTE_MAX = 500

// verdictEvent: a fixer's disposition as the reviewer false-positive query reads it (section 15):
// `CORRECT: <id> <reason>` for a finding it fixed, `WRONG: <id> <reason>` for one it declined;
// events.ts logs it with actor fixer.
export function verdictEvent(at: { issue: number; branch: string; pr: number | null; head: string | null }, d: Disposition): ReusedEvent {
  const note = clip(`${d.fixed ? 'CORRECT' : 'WRONG'}: ${d.id} ${d.reason === '' ? (d.fixed ? 'fixed' : 'declined') : d.reason}`, VERDICT_NOTE_MAX)
  return { state: 'verdict', issue: at.issue, branch: at.branch, pr: at.pr, head: at.head, note }
}
