// The types of done-check.mjs.
import type { GhRunner } from './wait-check.mjs'
import type { DoneEvidence } from './done-answer.mjs'

export const READ_TIMEOUT_MS: number
export function donePrArgv(repo: string, n: number): string[]
export function defaultBranchArgv(repo: string): string[]
export function compareArgv(repo: string, base: string, sha: string): string[]
export function checkDone(evidence: DoneEvidence, repo: string, runner: GhRunner): Promise<{ problems: string[]; unchecked: string[] }>
