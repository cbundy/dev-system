// The types of contracts-review.mjs. contract.mjs imports its CONTRACTS.
import type { V2Contract } from '../contract.mjs'

export const VERDICTS: readonly ['approve', 'changes']
export const SEVERITIES: readonly ['error', 'warning', 'info']
export const BUMPS: readonly ['patch', 'minor', 'major']
export const FIELDS: readonly ['verdict', 'findings', 'summary', 'bump']
export const FINDING_FIELDS: readonly ['id', 'severity', 'file', 'line', 'text']
export const LIMITS: Readonly<{ findings: number; text: number; summary: number; file: number }>
// The checked answer: texts trimmed, file '' for a finding about no one file.
export type ReviewFinding = { id: string; severity: (typeof SEVERITIES)[number]; file: string; line: number | null; text: string }
export type ReviewAnswer = { verdict: (typeof VERDICTS)[number]; findings: ReviewFinding[]; summary: string; bump: (typeof BUMPS)[number] }
export const CONTRACTS: Readonly<Record<'review', V2Contract>>
