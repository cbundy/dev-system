// The types of wait-check.mjs.
export const READ_TIMEOUT_MS: number

export type GhResult = { code: number | null; stdout: string; stderr: string }
export type GhRunner = (argv: string[]) => Promise<GhResult>
export type WaitCondition = { kind: string; issue?: number; pr?: number; sha?: string; repo?: string }

export function statusOf(result: GhResult | null): 'yes' | 'no' | 'unknown'
export function commitArgv(repo: string, sha: string): string[]
export function releaseArgv(repo: string): string[]
export function issueArgv(repo: string, n: number): string[]
export function prArgv(repo: string, n: number): string[]
export function checkWait(
  conditions: readonly WaitCondition[],
  repo: string,
  runner: GhRunner,
): Promise<{ problems: string[]; unchecked: string[] }>
