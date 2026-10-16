// The types of contracts-work.mjs. contract.mjs imports its CONTRACTS.
import type { V2Contract } from '../contract.mjs'

export const DESIGN_KINDS: readonly ['brief', 'question', 'split']
export const BUILD_RESULTS: readonly ['built', 'cannot']
export const FIX_RESULTS: readonly ['fixed', 'declined']
export const DISPOSITIONS: readonly ['fixed', 'declined']
export const ROLLOUTS: readonly ['merge', 'run-it', 'keep-open']
export const LIMITS: Readonly<{
  brief: number
  question: number
  childTitle: number
  childBody: number
  title: number
  summary: number
  evidence: number
  reason: number
  findingReason: number
  fixSummary: number
}>
export const CHILDREN: Readonly<{ min: number; max: number }>
export const CHILD_KEY: RegExp
export function rolloutOf(brief: string): string | null

// The checked answers: every field present, absent texts null, lists [].
export type DesignChild = { key: string; title: string; body: string; blockedBy: string[]; ready: boolean }
export type DesignAnswer = { kind: (typeof DESIGN_KINDS)[number]; brief: string | null; question: string | null; children: DesignChild[] }
export type BuildAnswer = { result: (typeof BUILD_RESULTS)[number]; head: string | null; title: string | null; summary: string | null; evidence: string | null; reason: string | null }
export type FixFinding = { id: string; disposition: (typeof DISPOSITIONS)[number]; reason: string }
export type FixAnswer = { result: (typeof FIX_RESULTS)[number]; head: string | null; summary: string; evidence: string | null; findings: FixFinding[] }

export const CONTRACTS: Readonly<Record<'design-v2' | 'build' | 'fix', V2Contract>>
