// The `ci-rerun` executor (docs/factory-loop/v2/SPEC.md 8.5, appendix B): the one re-run of a
// failed or cancelled check per round, `gh run rerun <run id> --failed --repo R`, which re-runs the
// run's failed jobs only. The review step plans it (rules-review.ts) once the run has finished,
// keyed by round and run id, so a check is re-run once per round however often the plan sees it
// fail; the queue's head does the same for its checks (U7). The plan reads the re-run's result
// from the check runs it reads next; a done re-run is a `ci-rerun` intervention
// (rules-interventions.ts). Executors decide nothing: plan did.
//
// A failure is one of two kinds. GitHub's own refusal of the re-run (a 4xx answer: gh words a 403
// as "cannot be rerun") is never retried, and its summary starts with RERUN_REFUSED, so the plan
// counts the check failed. Anything else (a timeout, a 5xx, a rate limit, a 401 from a lapsed
// token, no network) is transient: retried with backoff, then a stalled effect, never a red check.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, Executor } from '../exec'
import { rateLimited } from '../exec'
import type { ActionKind } from '../types'
import * as ARGV from './argv'
import { RERUN_REFUSED } from './rules-review'

// gh's own call: a few seconds; a minute is ample
const GH_MS = 60_000
const SUMMARY_MAX = 200

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// refusedBy: GitHub's answer when it refused the re-run itself: gh's words for a 403, or an HTTP
// 4xx other than 401 (credentials) and 429 (a rate limit); null for anything transient.
export function refusedBy(stderr: string): string | null {
  if (rateLimited(stderr)) return null
  const lines = stderr.split('\n').map(l => l.trim())
  return lines.find(l => /cannot be rerun|\bHTTP 4(?!01\b|29\b)\d\d\b/.test(l)) ?? null
}

const ciRerun: Executor = async (ctx, action): Promise<Exec> => {
  if (action.kind !== 'ci-rerun') return { status: 'failed', summary: `refused: the ci-rerun executor got a ${action.kind} action`, noRetry: true }
  // a run id is GitHub's number; anything else could be read as an option
  if (!/^[1-9]\d*$/.test(action.runId)) return { status: 'failed', summary: clip(`refused: ${action.runId} is not a run id`), noRetry: true }
  const argv = ARGV.runRerunArgv(ctx.rt.repo, action.runId)
  try {
    const r = await ctx.cmd(argv, { timeoutMs: GH_MS })
    if (r.exitCode !== 0) {
      const no = refusedBy(r.stderr)
      const failed = commandFailure(argv, r)
      if (no === null || failed.status !== 'failed') return failed
      return { ...failed, summary: clip(`${RERUN_REFUSED} of run ${action.runId}: ${no}`), noRetry: true }
    }
  } catch (err) {
    return { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${message(err)}`) }
  }
  return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: clip(`re-ran the failed jobs of run ${action.runId} (PR #${action.pr}, round ${action.round})`) }
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'ci-rerun': ciRerun }
