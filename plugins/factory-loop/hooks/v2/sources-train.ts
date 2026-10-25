// The `train` source (docs/factory-loop/v2/SPEC.md 2.4, 9.8): what the rules need of a live train, read
// only while one is live and the `mergeTrain` setting is on (otherwise nothing is read), bounded like
// the PR reads:
// - the check runs of each train commit (`gh api repos/R/commits/<sha>/check-runs`), every prEveryMs;
// - the tree of a commit (`gh api repos/R/commits/<sha> --jq .commit.tree.sha`), read once, for the head's
//   updated commit H' and for main's head once main is not the sha the train was built on: the
//   loop's check that the head's merge left main on H''s tree. A commit's tree never changes, so a
//   read stands.
// A read that failed keeps the last reading of the same commit. None is read during a GitHub backoff
// or after a rate limit.
//
// Pure parsing and a few reads; the cache lives in observe.ts's V2Cache.
import type { RunResult } from '../exec'
import type { Ms } from '../types'
import { commitChecksArgv, commitTreeReadArgv } from './argv'
import type { SourceCtx } from './observe'
import { trainsOf } from './rules-train'
import type { CheckRun } from './sources-prs'
import { EMPTY_TRAIN } from './train-types'
import type { TrainRead } from './train-types'

const timeOf = (v: unknown): Ms | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)

// bucketOf: a check run's bucket as `gh pr checks` names it: pass, skipping, fail, cancel, or pending.
function bucketOf(status: unknown, conclusion: unknown): CheckRun['bucket'] {
  if (status !== 'completed') return 'pending'
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'pass'
    case 'skipped':
      return 'skipping'
    case 'cancelled':
      return 'cancel'
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'stale':
    case 'startup_failure':
      return 'fail'
    default:
      return 'pending'
  }
}

// checkRunsOf: the check runs of a commit from `gh api repos/R/commits/<sha>/check-runs?per_page=100`;
// null when the output does not parse or lists fewer runs than total_count (fail closed). A commit no
// workflow ran on is an empty list.
export function checkRunsOf(r: RunResult): CheckRun[] | null {
  if (r.exitCode !== 0) return null
  let doc: unknown
  try {
    doc = JSON.parse(r.stdout)
  } catch {
    return null
  }
  const o = doc !== null && typeof doc === 'object' ? (doc as { total_count?: unknown; check_runs?: unknown }) : {}
  if (!Array.isArray(o.check_runs) || typeof o.total_count !== 'number' || o.check_runs.length < o.total_count) return null
  const out: CheckRun[] = []
  for (const raw of o.check_runs as unknown[]) {
    const c = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof c.name !== 'string') return null
    const link = typeof c.html_url === 'string' && c.html_url !== '' ? c.html_url : null
    out.push({
      name: c.name,
      state: typeof c.conclusion === 'string' ? c.conclusion.toUpperCase() : typeof c.status === 'string' ? c.status.toUpperCase() : '',
      bucket: bucketOf(c.status, c.conclusion),
      startedAt: timeOf(c.started_at),
      completedAt: timeOf(c.completed_at),
      runId: /\/actions\/runs\/(\d+)/.exec(link ?? '')?.[1] ?? null,
      link,
    })
  }
  return out
}

// treeOf: the tree sha `--jq .commit.tree.sha` printed; null when it is not one.
export function treeOf(r: RunResult): string | null {
  const t = r.stdout.trim()
  return r.exitCode === 0 && /^[0-9a-f]{40}$/.test(t) ? t : null
}

// readTrain: the new reading. main: main's head as the prs source read it.
export async function readTrain(ctx: SourceCtx, kept: TrainRead, main: string | null): Promise<TrainRead> {
  const { rt, now } = ctx
  const live = rt.config.mergeTrain ? trainsOf(ctx.state.ledger) : []
  if (live.length === 0) return EMPTY_TRAIN
  const s = ctx.state
  const blocked = (s.githubBackoffUntil !== null && now < s.githubBackoffUntil) || ctx.limited()
  const due = kept.at === null || now - kept.at >= rt.config.prEveryMs
  const checks: TrainRead['checks'] = {}
  for (const t of live) checks[t.train] = kept.checks[t.train] ?? null
  // the commits whose trees the rules compare: only once main is not what a train was built on
  const wanted = new Set(live.flatMap(t => (main !== null && !main.startsWith(t.main) && !t.main.startsWith(main) ? [t.head, main] : [])))
  const trees: TrainRead['trees'] = {}
  for (const sha of wanted) trees[sha] = kept.trees[sha] ?? null
  let at = kept.at
  let error: string | null = null
  const read = async (argv: string[]): Promise<RunResult | null> => {
    if (blocked || ctx.limited()) return null
    try {
      return await ctx.run(argv)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return null
    }
  }
  if (due) {
    for (const t of live) {
      const r = await read(commitChecksArgv(rt.repo, t.train))
      const list = r === null ? null : checkRunsOf(r)
      if (list !== null) checks[t.train] = list
      else if (r !== null) error = `the check runs of the train ${t.train.slice(0, 7)} were not read`
    }
    at = blocked ? at : now
  }
  for (const sha of wanted) {
    if (trees[sha] !== null) continue
    const r = await read(commitTreeReadArgv(rt.repo, sha))
    const tree = r === null ? null : treeOf(r)
    if (tree !== null) trees[sha] = tree
    else if (r !== null) error = `the tree of ${sha.slice(0, 7)} was not read`
  }
  return { checks, trees, at, source: error === null ? { ok: true, at: at ?? now } : { ok: false, at: null, error } }
}
