// The types of rollout-check.mjs.
import type { GhRunner } from './wait-check.mjs'

export const READ_TIMEOUT_MS: number
export function issueBodyArgv(issue: number): string[]
export function hasRunItHeading(body: string): boolean
export function conflictReason(issue: number): string
export function checkRollout(brief: string, issue: number, runner: GhRunner): Promise<{ problems: string[]; unchecked: string[] }>
