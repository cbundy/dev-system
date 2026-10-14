// The types of contract.mjs, the agents' answer contract that the loop and bin/factory-answer
// share (#561). tests/factory-loop-answer.test.js checks that this file declares exactly the
// module's exports.
import type { AdjudicatorAction, AdjudicatorPurpose, AgentType, Bump, MergeFlag, Outcome } from './types'

export type AdjudicatorOutcome = Extract<Outcome, { kind: 'adjudicator' }>
export type DesignResult = Exclude<Extract<Outcome, { kind: 'designer' }>, { unparsed: true }>
export type HandoffOutcome = Extract<Outcome, { kind: 'handoff' }>
export type AnswerOutcome = AdjudicatorOutcome | DesignResult | HandoffOutcome
export type HandoffFields = { run: string | null; head: string | null; commit: string | null; gated: boolean; branch: string | null; pr: number | null }
// What a check gives: the outcome the text contract would, or every problem at once, so the
// model fixes them in one more try.
export type Check<O> = { ok: true; outcome: O } | { ok: false; problems: string[] }
export type Contract = 'verdict' | 'design' | 'handoff'
// What checking an answer needs beside it: the contract, the review's purpose (a verdict), the
// repo and issue a brief must be on (a design), the branch a fixer was sent to (a handoff).
export type Job = { contract: Contract; purpose: AdjudicatorPurpose | null; repo: string; issue: number | null; branch: string | null }

export const VERDICTS: readonly ['CORRECT', 'WRONG', 'NIT', 'ENV', 'DUP']
export const BUMPS: readonly Bump[]
export const FLAGS: readonly MergeFlag[]
export const ACTIONS_FOR: Readonly<Record<AdjudicatorPurpose, readonly AdjudicatorAction['type'][]>>
export const FINDING_ID: RegExp
export const HANDOFF_SHAPES: Readonly<{ run: RegExp; sha: RegExp; branch: RegExp }>
export const TEXT_MAX: number
export const CONTRACT_OF: Readonly<Record<AgentType, Contract>>

export function isBriefUrl(url: string, repo: string, issue?: number | null): boolean
export function gatedWithoutRun(fields: Pick<HandoffFields, 'run' | 'gated'>): boolean
export function handoffOutcome(fields: HandoffFields, namedBranch: string | null): HandoffOutcome

export function checkVerdict(input: unknown, purpose: AdjudicatorPurpose): Check<AdjudicatorOutcome>
export function checkDesign(input: unknown, repo: string, issue: number | null): Check<DesignResult>
export function checkHandoff(input: unknown, namedBranch: string | null): Check<HandoffOutcome>
export function checkAnswer(job: Job, input: unknown): Check<AnswerOutcome>

export const ANSWER_SUFFIX: '.answer.json'
export const JOB_SUFFIX: '.job.json'
export const ANSWER_NAME: RegExp
export const LOOP_DIR_NAME: RegExp
export function jobPathOf(answerPath: string): string | null
export function jobText(job: Job): string
export function parseJob(body: string): Job | string
export function answerText(job: Job, input: unknown): Check<string>
export function parseAnswer(body: string, contract: Contract): Check<unknown>
