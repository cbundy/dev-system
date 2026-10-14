// The types of answer-cases.mjs, the table of answers both ends of the answer script are held to.
import type { Job } from '../hooks/contract.mjs'

export type JobName = 'gate' | 'weakening' | 'merge' | 'designer' | 'implementer' | 'fixer'
export type AnswerCase = { name: string; job: JobName; input: unknown; problems: readonly string[] }

export const JOBS: Readonly<Record<JobName, Job>>
export const CASES: readonly AnswerCase[]
