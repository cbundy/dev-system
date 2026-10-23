// The types of upstream-check.mjs.
import type { GhRunner } from './wait-check.mjs'
import type { UpstreamRequest } from './upstream-answer.mjs'

export const READ_TIMEOUT_MS: number
export const UNTRUSTED_EXIT: number
export function commentArgv(url: string): string[]
export function issueBodyArgv(issue: number): string[]
export function checkUpstreamAuthority(upstream: UpstreamRequest, job: { repo: string; issue: number }, runner: GhRunner): Promise<{ problems: string[]; unchecked: string[] }>
