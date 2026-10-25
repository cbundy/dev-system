// github.json (github-health.ts): which command failures count as a GitHub API error, the list the
// loop keeps, and the file an acting pass writes.
import { describe, expect, test } from 'claude-code/testing'
import { GITHUB_ERRORS_MAX, errorsWithin, githubApiError, healthFileOf, noteRun, priorErrors, resetGithubHealth, writeGithubHealth } from '../hooks/github-health'
import type { HealthIo } from '../hooks/github-health'
import { WIND_DOWN_WRITE_SCRIPT } from '../hooks/v2/wind-down-files'
import { MIN, NOW } from './fixtures'

const HOUR = 60 * MIN
const fail = (stderr: string, exitCode = 1) => ({ exitCode, stderr })


describe('githubApiError', () => {
  for (const [name, stderr] of [
    ['an HTTP 502', 'gh: HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/issues/1)'],
    ['an HTTP 503 from the GraphQL client', 'non-200 OK status code: 503 Service Unavailable body: "<html>"'],
    ['an HTTP 429', 'HTTP 429: Too Many Requests (https://api.github.com/graphql)'],
    ['a rate limit', 'gh: API rate limit exceeded for user ID 1. (HTTP 403)'],
    ['a secondary rate limit', 'You have exceeded a secondary rate limit. Please wait a few minutes (HTTP 403)'],
    ['Bad credentials', 'gh: Bad credentials (HTTP 401)'],
    ['an HTTP 401', 'HTTP 401: Unauthorized (https://api.github.com/user)'],
    ['a connection failure', 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'],
    ['a TLS failure', 'Post "https://api.github.com/graphql": tls: handshake failure'],
    ['a dial failure', 'Get "https://api.github.com/rate_limit": dial tcp: lookup api.github.com: no such host'],
  ] as const) test(`counts ${name}`, () => expect(githubApiError(fail(stderr))).toBe(true))

  for (const [name, stderr] of [
    ['an HTTP 404', 'gh: Not Found (HTTP 404)'],
    ['an HTTP 422', 'gh: Validation Failed (HTTP 422)'],
    ['a failure that is not about GitHub', 'fatal: not a git repository'],
    ['an empty stderr', ''],
  ] as const) test(`does not count ${name}`, () => expect(githubApiError(fail(stderr))).toBe(false))

  test('does not count a command that exited 0, whatever it printed', () => {
    expect(githubApiError({ exitCode: 0, stderr: 'HTTP 502: Bad Gateway' })).toBe(false)
  })
})

describe('the error list', () => {
  test('noteRun counts once per failed command and hands the result back', () => {
    resetGithubHealth()
    const bad = { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' }
    expect(noteRun(bad, NOW)).toBe(bad)
    noteRun({ exitCode: 0, stdout: '', stderr: '' }, NOW)
    noteRun({ exitCode: 1, stdout: '', stderr: 'HTTP 404' }, NOW)
    const io = recorder()
    return writeGithubHealth(io, '/loop', 'o/r', NOW + 1).then(() => {
      expect(body(io).errors).toEqual([new Date(NOW).toISOString()])
    })
  })

  test('entries older than an hour drop out, the newest 2000 stay, oldest first', () => {
    expect(errorsWithin([NOW - HOUR - 1, NOW - HOUR, NOW - HOUR + 1, NOW - 5, NOW + 10], NOW)).toEqual([NOW - HOUR + 1, NOW - 5])
    const many = Array.from({ length: GITHUB_ERRORS_MAX + 50 }, (_, i) => NOW - 4_000_000 + i * 1000).filter(t => NOW - t < HOUR)
    expect(many.length).toBeGreaterThan(0)
    const dense = Array.from({ length: GITHUB_ERRORS_MAX + 50 }, (_, i) => NOW - 3_000_000 + i)
    const kept = errorsWithin(dense, NOW)
    expect(kept).toHaveLength(GITHUB_ERRORS_MAX)
    expect(kept[0]).toBe(dense[50])
    expect(kept.at(-1)).toBe(dense.at(-1))
  })

  test('priorErrors keeps a prior file\'s in-hour entries and nothing from an unusable one', () => {
    const iso = (t: number) => new Date(t).toISOString()
    const good = JSON.stringify({ v: 1, repo: 'o/r', at: iso(NOW), errors: [iso(NOW - 2 * HOUR), iso(NOW - 10 * MIN), 'x', 7] })
    expect(priorErrors(good, NOW)).toEqual([NOW - 10 * MIN])
    for (const raw of [null, '{not json', '[1]', JSON.stringify({ v: 2, errors: [iso(NOW)] }), JSON.stringify({ v: 1, errors: 'x' })]) expect(priorErrors(raw, NOW)).toEqual([])
  })
})

function recorder(prior: string | null = null, exitCode = 0): HealthIo & { calls: { argv: string[]; stdin?: string }[]; reads: string[] } {
  const calls: { argv: string[]; stdin?: string }[] = []
  const reads: string[] = []
  return {
    calls,
    reads,
    run: async (argv, init) => (calls.push({ argv, stdin: init.stdin }), { exitCode, stderr: exitCode === 0 ? '' : 'no space' }),
    read: async path => (reads.push(path), prior),
  }
}
const body = (io: { calls: { stdin?: string }[] }, n = 0) => JSON.parse(io.calls[n]?.stdin ?? '{}') as { v: number; repo: string; at: string; errors: string[] }

describe('writeGithubHealth', () => {
  test('runs the atomic write script over github.json with {v, repo, at, errors} on stdin', async () => {
    resetGithubHealth()
    const io = recorder()
    noteRun({ exitCode: 1, stdout: '', stderr: 'HTTP 429' }, NOW - MIN)
    expect(await writeGithubHealth(io, '/loop', 'o/r', NOW)).toEqual([])
    expect(io.calls[0]?.argv).toEqual(['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'github-health', healthFileOf('/loop')])
    expect(healthFileOf('/loop')).toBe('/loop/github.json')
    expect(io.calls[0]?.stdin?.endsWith('}\n')).toBe(true)
    expect(body(io)).toEqual({ v: 1, repo: 'o/r', at: new Date(NOW).toISOString(), errors: [new Date(NOW - MIN).toISOString()] })
  })

  test('the first write carries over the prior file\'s in-hour entries; later writes do not read it again', async () => {
    resetGithubHealth()
    const iso = (t: number) => new Date(t).toISOString()
    const prior = JSON.stringify({ v: 1, repo: 'o/r', at: iso(NOW - MIN), errors: [iso(NOW - 2 * HOUR), iso(NOW - 30 * MIN)] })
    const io = recorder(prior)
    noteRun({ exitCode: 1, stdout: '', stderr: 'HTTP 502' }, NOW - 5 * MIN)
    await writeGithubHealth(io, '/loop', 'o/r', NOW)
    expect(body(io).errors).toEqual([iso(NOW - 30 * MIN), iso(NOW - 5 * MIN)])
    await writeGithubHealth(io, '/loop', 'o/r', NOW + 31 * MIN)
    expect(io.reads).toEqual(['/loop/github.json'])
    expect(body(io, 1).errors).toEqual([iso(NOW - 5 * MIN)])
  })

  test('a failed write and a throw are each one github health problem, and never throw', async () => {
    resetGithubHealth()
    const failed = await writeGithubHealth(recorder(null, 1), '/loop', 'o/r', NOW)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith('github health: write failed (exit 1')
    const threw = await writeGithubHealth({ run: async () => Promise.reject(new Error('boom')), read: async () => null }, '/loop', 'o/r', NOW)
    expect(threw).toEqual(['github health: write failed (boom)'])
  })
})
