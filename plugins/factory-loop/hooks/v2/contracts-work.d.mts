// The types of contracts-work.mjs. contract.mjs imports its CONTRACTS.
import type { V2Contract } from '../contract.mjs'
import type { DoneEvidence } from './done-answer.mjs'
import type { QuestionParts } from './question.mjs'

export const DESIGN_KINDS: readonly ['brief', 'question', 'split', 'wait', 'done']
export const BUILD_RESULTS: readonly ['built', 'cannot']
export const FIX_RESULTS: readonly ['fixed', 'declined', 'unchanged']
export const DISPOSITIONS: readonly ['fixed', 'declined']
export const ROLLOUTS: readonly ['merge', 'run-it', 'keep-open']
export const LIMITS: Readonly<{
  brief: number
  question: number
  childTitle: number
  childBody: number
  childWhy: number
  splitReason: number
  waitReason: number
  title: number
  summary: number
  evidence: number
  reason: number
  findingReason: number
  fixSummary: number
}>
export const REASON_KEYS: readonly ['why_split', 'why_count', 'why_parts', 'why_order']
export const WAIT_CONDITIONS: Readonly<{ min: number; max: number }>
export const WAIT_KINDS: readonly ['issue-closed', 'pr-merged', 'tag-contains']
export const CHILDREN: Readonly<{ min: number; max: number }>
export const CHILD_KEY: RegExp
export function rolloutOf(brief: string): string | null
export function rolloutReasonOf(brief: string): string | null

// The checked answers: every field present, absent texts null, lists [].
// blockedBy: sibling keys, or "#<N>" for an existing issue of the repo
export type DesignChild = { key: string; title: string; why: string; body: string; blockedBy: string[]; ready: boolean; decision: string | null; decisionParts?: ParkParts }
export type SplitReasons = Record<(typeof REASON_KEYS)[number], string>
export type WaitCondition = { kind: 'issue-closed'; issue: number; repo?: string } | { kind: 'pr-merged'; pr: number } | { kind: 'tag-contains'; sha: string; repo?: string }
// conditions and reason are present for a wait; evidence and reason for a done close
export type DesignAnswer = {
  kind: (typeof DESIGN_KINDS)[number]
  brief: string | null
  question: string | null
  reasons: SplitReasons | null
  children: DesignChild[]
  conditions?: WaitCondition[]
  reason?: string
  // a done close: the evidence that the work is merged (with reason)
  evidence?: DoneEvidence
} & QuestionParts
export type BuildAnswer = { result: (typeof BUILD_RESULTS)[number]; head: string | null; title: string | null; summary: string | null; evidence: string | null; reason: string | null }
export type FixFinding = { id: string; disposition: (typeof DISPOSITIONS)[number]; reason: string }
export type FixAnswer = { result: (typeof FIX_RESULTS)[number]; head: string | null; summary: string; evidence: string | null; findings: FixFinding[] }

export const CONTRACTS: Readonly<Record<'design-v2' | 'build' | 'fix', V2Contract>>
