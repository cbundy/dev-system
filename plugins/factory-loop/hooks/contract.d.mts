// The types of contract.mjs, the agents' answer contract that the loop and bin/factory-answer
// share (#561). tests/factory-loop-answer.test.js checks that this file declares exactly the
// module's exports.

// What a check gives: the outcome the text contract would, or every problem at once, so the
// model fixes them in one more try.
export type Check<O> = { ok: true; outcome: O } | { ok: false; problems: string[] }
export type V2ContractName = 'design-v2' | 'build' | 'fix' | 'review' | 'triage'
export type Contract = V2ContractName
// What checking an answer needs beside it: the contract, the repo and issue and branch
// the job is for, and whatever else its contract's check needs (data).
export type Job = { contract: Contract; purpose: null; repo: string; issue: number | null; branch: string | null; data?: Record<string, unknown> }
// A v2 contract (v2/contracts-*.mjs): its check, and the answer script's summary of what it
// recorded.
export type V2Contract = { check: (input: unknown, job: Job) => Check<unknown>; summary: (input: unknown) => string }

export const V2_CONTRACTS: Readonly<Record<V2ContractName, V2Contract>>


export function checkAnswer(job: Job, input: unknown): Check<unknown>
export function answerSummary(contract: Contract, input: unknown): string

export const ANSWER_SUFFIX: '.answer.json'
export const JOB_SUFFIX: '.job.json'
export const ANSWER_NAME: RegExp
export const LOOP_DIR_NAME: RegExp
export function loopBaseOf(configDir: string): string
export function loopDirOf(configDir: string, repo: string): string
export function jobPathOf(answerPath: string): string | null
export function jobText(job: Job): string
export function parseJob(body: string): Job | string
export function answerText(job: Job, input: unknown): Check<string>
export function parseAnswer(body: string, contract: Contract): Check<unknown>
