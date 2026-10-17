// The types of contracts-triage.mjs. contract.mjs imports its CONTRACTS.
import type { V2Contract } from '../contract.mjs'
import type { QuestionParts } from './question.mjs'

export const CHOICES: readonly ['retry', 'fix', 'redesign', 'park', 'drop']
export const FIELDS: readonly ['choice', 'reason', 'instructions', 'question', 'context', 'options', 'recommendation']
export const LIMITS: Readonly<{ reason: number; instructions: number; question: number }>
// The checked answer: absent texts are null.
export type TriageAnswer = { choice: (typeof CHOICES)[number]; reason: string; instructions: string | null; question: string | null } & QuestionParts
export const CONTRACTS: Readonly<Record<'triage', V2Contract>>
