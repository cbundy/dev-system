// The GitHub source of one observe pass: the facts of the issues due this pass, read with ONE
// `fabriek-issue-read --json --issues <N,...>` call (cbundy/dev-system#922) instead of one
// call per issue (each costing 2-3 API calls). A reader that does not know `--issues` (an image
// older than this plugin) exits 2: the pass then falls back to one single read per issue. A
// designing issue of this device also gets its `--comments` read, for its design brief.
import { parseBrief, parseIssueRead, parseIssuesRead } from './parse'
import type { GithubIssue } from './state'

type Timed<T> = { at: number; value: T }
type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
type Opts = { repo: string; cache: Map<number, Timed<GithubIssue>>; now: number; designing: Set<number>; limited: () => boolean }

const READER = 'fabriek-issue-read'

// readIssues: reads the due issues into opts.cache; false when any read failed or a rate limit
// ended the pass's reads. A failed read keeps the last value (and its old time).
export async function readIssues(run: Run, due: number[], opts: Opts): Promise<boolean> {
  if (due.length === 0) return true
  // a rate limit seen this pass ends the pass's GitHub reads: each would only hit it again
  if (opts.limited()) return false
  let ok = true
  try {
    const r = await run([READER, '--json', '--issues', due.join(',')])
    if (r.exitCode === 2) return await readEach(run, due, opts)
    const read = r.exitCode === 0 ? parseIssuesRead(r.stdout, opts.repo) : null
    if (read === null) return false
    const asked = new Set(due)
    for (const n of read.refused) {
      if (asked.has(n)) opts.cache.set(n, { at: opts.now, value: { facts: null, trusted: false, brief: null } })
    }
    for (const [n, facts] of read.facts) {
      if (!asked.has(n)) continue
      opts.cache.set(n, { at: opts.now, value: { facts, trusted: true, brief: opts.cache.get(n)?.value.brief ?? null } })
    }
    // a number not answered at all (missing, or absent) keeps its last value
    ok = due.every(n => read.facts.has(n) || read.refused.includes(n))
  } catch {
    return false
  }
  for (const n of due) if (opts.designing.has(n) && isTrusted(opts, n)) ok = (await readBrief(run, n, opts)) && ok
  return ok
}

const isTrusted = (opts: Opts, n: number) => opts.cache.get(n)?.value.trusted === true

async function readBrief(run: Run, n: number, opts: Opts): Promise<boolean> {
  if (opts.limited()) return false
  try {
    const c = await run([READER, '--json', String(n), '--comments'])
    const cur = opts.cache.get(n)
    if (c.exitCode === 0 && cur !== undefined) cur.value.brief = parseBrief(c.stdout)
  } catch {
    // the brief stays as it was
  }
  return true
}

// readEach: one single read per issue, as before --issues existed.
async function readEach(run: Run, due: number[], opts: Opts): Promise<boolean> {
  let ok = true
  for (const n of due) {
    if (opts.limited()) return false
    try {
      const r = await run([READER, '--json', String(n)])
      if (r.exitCode === 3) {
        opts.cache.set(n, { at: opts.now, value: { facts: null, trusted: false, brief: null } })
        continue
      }
      const facts = r.exitCode === 0 ? parseIssueRead(r.stdout) : null
      if (facts === null) {
        ok = false
        continue
      }
      let brief = opts.cache.get(n)?.value.brief ?? null
      if (opts.designing.has(n)) {
        const c = await run([READER, '--json', String(n), '--comments'])
        if (c.exitCode === 0) brief = parseBrief(c.stdout)
      }
      opts.cache.set(n, { at: opts.now, value: { facts, trusted: true, brief } })
    } catch {
      ok = false
    }
  }
  return ok
}
