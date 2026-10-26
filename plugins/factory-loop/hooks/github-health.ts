// github.json (cbundy/dev-system#1305): the GitHub API errors this loop hit in the last hour, for the
// heartbeat (images/base/heartbeat-loop, which writes the count to factory.workers.github_errors_1h).
// driver-io's io() and actIo() hand every in-process command's result to noteRun; an acting pass
// writes the list beside settings.json. Agents' own gh calls (a builder pushing, fabriek-issue-read)
// never pass through here and are not counted.
import { rateLimited } from './exec'
import type { RunResult } from './exec'
import { WIND_DOWN_WRITE_SCRIPT } from './v2/wind-down-files'

export const GITHUB_HEALTH_VERSION = 1
export const GITHUB_ERROR_WINDOW_MS = 3_600_000
export const GITHUB_ERRORS_MAX = 2000

// githubApiError: whether a command's result shows GitHub refusing or failing the call. It counts a
// non-zero exit whose stderr shows: a rate limit (rateLimited), HTTP 5xx (gh's "HTTP 502" or the
// GraphQL client's "non-200 OK status code: 502"), HTTP 429, HTTP 401 or Bad credentials, or a
// connection, TLS or DNS failure reaching api.github.com. A 404, a 422 and any other answer GitHub
// gave on purpose (the app asked for something that is not there or not allowed), and a failure that
// is not about GitHub, are not counted.
export function githubApiError(r: Pick<RunResult, 'exitCode' | 'stderr'>): boolean {
  if (r.exitCode === 0) return false
  const e = r.stderr
  return (
    rateLimited(e) ||
    /HTTP (5\d\d|429|401)\b/.test(e) ||
    /non-200 OK status code: 5\d\d/.test(e) ||
    /Bad credentials/i.test(e) ||
    /error connecting to api\.github\.com/i.test(e) ||
    /(dial tcp|tls:|TLS|connection (refused|reset)|i\/o timeout|no such host|EOF)[^\n]*api\.github\.com|api\.github\.com[^\n]*(dial tcp|tls:|TLS handshake|connection (refused|reset)|i\/o timeout|no such host|EOF)/i.test(e)
  )
}

// the errors of this process (epoch ms), oldest first, and whether the prior file was carried over
let errors: number[] = []
let carried = false

export function resetGithubHealth(): void {
  errors = []
  carried = false
}

// noteRun: counts one command, once, when its result is a GitHub API error. Returns the result.
export function noteRun(r: RunResult, nowMs: number): RunResult {
  if (githubApiError(r)) errors.push(nowMs)
  return r
}

// errorsWithin: the epoch-ms times within the window before nowMs, oldest first, at most the newest max.
export function errorsWithin(list: readonly number[], nowMs: number, windowMs = GITHUB_ERROR_WINDOW_MS, max = GITHUB_ERRORS_MAX): number[] {
  const kept = list.filter(t => Number.isFinite(t) && t <= nowMs && nowMs - t < windowMs).sort((a, b) => a - b)
  return kept.length > max ? kept.slice(kept.length - max) : kept
}

export function healthFileOf(loopDir: string): string {
  return `${loopDir}/github.json`
}

// priorErrors: the in-window entries of a prior github.json text (none for anything unreadable).
export function priorErrors(raw: string | null, nowMs: number): number[] {
  if (raw === null) return []
  try {
    const v = JSON.parse(raw) as { v?: unknown; errors?: unknown }
    if (v === null || typeof v !== 'object' || v.v !== GITHUB_HEALTH_VERSION || !Array.isArray(v.errors)) return []
    return errorsWithin(v.errors.map(e => (typeof e === 'string' ? Date.parse(e) : Number.NaN)), nowMs)
  } catch {
    return []
  }
}

export type HealthIo = {
  run: (argv: string[], init: { stdin?: string; timeoutMs: number }) => Promise<{ exitCode: number; stderr: string }>
  read: (path: string) => Promise<string | null>
}

// writeGithubHealth: the file lands whole or not at all. The first write of a process carries over the
// prior file's entries still within the hour, so a plugin reload does not reset the count. Returns the
// problems for the decision log; a failed write never fails the pass.
export async function writeGithubHealth(io: HealthIo, loopDir: string, repo: string, nowMs: number): Promise<string[]> {
  try {
    const file = healthFileOf(loopDir)
    if (!carried) {
      const prior = priorErrors(await io.read(file).catch(() => null), nowMs)
      errors = [...new Set([...prior, ...errors])]
      carried = true
    }
    errors = errorsWithin(errors, nowMs)
    const body = { v: GITHUB_HEALTH_VERSION, repo, at: new Date(nowMs).toISOString(), errors: errors.map(t => new Date(t).toISOString()) }
    const r = await io.run(['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'github-health', file], { stdin: `${JSON.stringify(body)}\n`, timeoutMs: 10_000 })
    return r.exitCode === 0 ? [] : [`github health: write failed (exit ${r.exitCode}${r.stderr.trim() === '' ? '' : `: ${r.stderr.trim().slice(0, 200)}`})`]
  } catch (e) {
    return [`github health: write failed (${e instanceof Error ? e.message : String(e)})`]
  }
}
