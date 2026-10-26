// The `flakes` source (docs/factory-loop/v2/SPEC.md 2.4, 8.5 rule F1): the flakes of the last
// flakeWindowDays and the repo's open flake bugs. One flake is a gate flake (a gate_run pass row
// with `flaky` true, once per issue, life, seq and started_at) or a CI flake (a ci-rerun
// intervention row with `flaky` true, once per issue and fact), as docs/metrics.md section 2d
// counts them; this read gives one row per flake per test with the event id of the flake's first
// row. The bugs are the open issues by trusted authors carrying the flaky label, read through the
// reader (which drops an untrusted author's issue), with the marker and flake ids in each body.
// Read in act mode only, on the githubEveryMs cadence, and again at once after an action of F1's
// own ended. A missing factory URL (dev-query exit 77) is no flakes; any other failure fails the
// source, and F1 plans nothing.
import { parseCsv } from '../parse'
import type { Ms, Source } from '../types'
import type { SourceCtx } from './observe'

const DAY = 86_400_000

// One flake of one test. `hash` is the first 16 hex digits of the sha256 of the test's exact name (the query computes it; a hooks module may not import node:crypto).
export type Flake = { id: string; source: 'gate' | 'ci'; issue: number | null; head: string | null; at: Ms; test: string; job: string | null; hash: string }
// An open flake bug: its hash (null: no marker), whether it is labelled ready, and the ids of the flakes its body names.
export type FlakeBug = { number: number; hash: string | null; ready: boolean; known: string[] }
export type FlakesRead = { flakes: Flake[]; bugs: FlakeBug[] }
export type FlakesCache = { at: Ms | null; read: FlakesRead | null; source: Source | null }
export const EMPTY_FLAKES: FlakesCache = { at: null, read: null, source: null }

export const FLAKY_LABEL = 'flaky'

const MARKER = /<!-- factory-loop:flake:([0-9a-f]{16}) -->/
const KNOWN = /<!-- factory-loop:flake-bug\/[0-9a-f]{16}\/c\/([0-9a-f-]{36}) -->/g

// The per-flake rows of docs/metrics.md section 2d ("the bug rule's read"): the test of a saved
// query there, which tests/metrics-flakes.test.js runs against PostgreSQL; the two must match.
export const FLAKES_SQL = `WITH gate AS (
  SELECT repo, issue, life, seq, started_at, max(head) AS head, min(ts) AS passed_at,
    (array_agg(event_id ORDER BY ts, device, device_seq))[1] AS event_id,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'gate_run' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, life, seq, started_at
), ci AS (
  SELECT repo, issue, coalesce(fact, event_id::text) AS fact, max(head) AS head, min(ts) AS passed_at,
    (array_agg(event_id ORDER BY ts, device, device_seq))[1] AS event_id,
    (array_agg(failed_jobs ORDER BY ts, device, device_seq))[1] AS jobs,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'intervention' AND cause = 'ci-rerun' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, coalesce(fact, event_id::text)
), flakes AS (
  SELECT 'gate' AS source, event_id, issue, head, passed_at, NULL::text AS job,
    CASE WHEN jsonb_typeof(tests) = 'array' THEN tests ELSE '[]'::jsonb END AS tests
  FROM gate
  UNION ALL
  SELECT 'ci', event_id, issue, head, passed_at,
    (SELECT string_agg(j, ', ' ORDER BY j)
       FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(jobs) = 'array' THEN jobs ELSE '[]'::jsonb END) AS j),
    CASE WHEN jsonb_typeof(tests) = 'array' THEN tests ELSE '[]'::jsonb END
  FROM ci
)
SELECT f.event_id, f.source, f.issue, f.head,
  to_char(f.passed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS passed_at, t.test, f.job,
  left(encode(sha256(convert_to(t.test, 'UTF8')), 'hex'), 16) AS hash
FROM flakes f
CROSS JOIN LATERAL jsonb_array_elements_text(f.tests) AS t(test)
ORDER BY f.passed_at, f.event_id, t.test;
`

// flakesFromRows: the flakes of FLAKES_SQL's rows; a row that does not read is dropped.
export function flakesFromRows(rows: readonly Record<string, string>[]): Flake[] {
  const out: Flake[] = []
  for (const r of rows) {
    const id = r.event_id ?? ''
    const at = Date.parse(r.passed_at ?? '')
    const test = r.test ?? ''
    if (!/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(at) || test === '' || (r.source !== 'gate' && r.source !== 'ci')) continue
    const hash = r.hash ?? ''
    if (!/^[0-9a-f]{16}$/.test(hash)) continue
    const issue = Number(r.issue)
    out.push({ id, source: r.source, issue: Number.isInteger(issue) && issue > 0 ? issue : null, head: r.head === undefined || r.head === '' ? null : r.head, at, test, job: r.job === undefined || r.job === '' ? null : r.job, hash })
  }
  return out
}

// bugsFromJson: the open flake bugs of `fabriek-issue-read --json --list --label flaky`; null
// when the output is not that list. An issue with no marker is kept with a null hash (it is
// labelled flaky by someone else and counts against nothing).
export function bugsFromJson(json: string): FlakeBug[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return null
  }
  const issues = doc !== null && typeof doc === 'object' ? (doc as { issues?: unknown }).issues : undefined
  if (!Array.isArray(issues)) return null
  const out: FlakeBug[] = []
  for (const raw of issues) {
    const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof o.number !== 'number' || !Number.isInteger(o.number) || typeof o.body !== 'string') continue
    const labels = Array.isArray(o.labels) ? o.labels.map(l => (typeof l === 'string' ? l : (l as { name?: unknown } | null)?.name)).filter((l): l is string => typeof l === 'string') : []
    out.push({ number: o.number, hash: MARKER.exec(o.body)?.[1] ?? null, ready: labels.some(l => l.toLowerCase() === 'ready'), known: [...o.body.matchAll(KNOWN)].map(m => m[1] as string) })
  }
  return out
}

const failedRead = (why: string): { source: Source; read: null } => ({ source: { ok: false, at: null, error: why }, read: null })

// readFlakes: one read, the flakes then (when some test has enough of them) the bugs.
export async function readFlakes(ctx: SourceCtx, min: number): Promise<{ source: Source; read: FlakesRead | null }> {
  const { rt, now } = ctx
  const since = new Date(now - rt.config.flakeWindowDays * DAY).toISOString()
  let flakes: Flake[]
  try {
    const r = await ctx.run(['dev-query', '--factory', '--csv', '-v', `repo=${rt.repo}`, '-v', `since=${since}`], FLAKES_SQL)
    if (r.exitCode === 77) return { source: { ok: true, at: now }, read: { flakes: [], bugs: [] } }
    if (r.exitCode !== 0) return failedRead(`the flakes read failed: exit ${r.exitCode}`)
    flakes = flakesFromRows(parseCsv(r.stdout))
  } catch (err) {
    return failedRead(`the flakes read failed: ${String(err).slice(0, 200)}`)
  }
  const per = new Map<string, number>()
  for (const f of flakes) per.set(f.hash, (per.get(f.hash) ?? 0) + 1)
  if (![...per.values()].some(n => n >= min)) return { source: { ok: true, at: now }, read: { flakes, bugs: [] } }
  try {
    const r = await ctx.run(['fabriek-issue-read', '--json', '--list', '--label', FLAKY_LABEL, '--state', 'open'])
    const bugs = r.exitCode === 0 ? bugsFromJson(r.stdout) : null
    if (bugs === null) return failedRead(`the flake bugs read failed: exit ${r.exitCode}`)
    return { source: { ok: true, at: now }, read: { flakes, bugs } }
  } catch (err) {
    return failedRead(`the flake bugs read failed: ${String(err).slice(0, 200)}`)
  }
}

// readFlakesCached: the cadence: act mode only, every githubEveryMs, at once after an action of F1's
// own ended since the last read, and none during a GitHub backoff or after a rate limit.
export async function readFlakesCached(ctx: SourceCtx, cache: FlakesCache, blocked: boolean): Promise<FlakesCache> {
  const { now, rt } = ctx
  if (rt.mode !== 'act') return { at: null, read: null, source: { ok: true, at: now } }
  const own = Math.max(-Infinity, ...ctx.state.ledger.flatMap(e => (e.kind === 'flake-bug' || e.key.startsWith('flake-bug/') ? [e.endedAt ?? e.startedAt] : [])))
  const due = cache.at === null || now - cache.at >= rt.config.githubEveryMs || own >= cache.at
  if (!due || blocked) return cache.source === null ? { ...cache, source: { ok: true, at: now } } : cache
  const r = await readFlakes(ctx, rt.config.flakeBugMin)
  return { at: now, read: r.read, source: r.source }
}

