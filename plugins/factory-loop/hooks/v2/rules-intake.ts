// I1: the intake stamp's run (docs/factory-loop/v2/SPEC.md 13.4, epic #995). While `intakeStamp` is on
// it plans, for each open, trusted issue in the ready queue (the filters S1 uses before its blocked and
// claim checks, rules-claim.ts readyProblem) whose current body version has not been tried, one
// `intake-stamp` run: the reader of v2/intake.ts on that body. Each (issue, body version) is tried at most
// once: the executor records the try before it spawns (act-intake.ts), and an edited body is a new version.
//
// - Order and cap: ascending issue number, and at most STAMP_RUNNING runs at once, counted from the
//   ledger's running runs and this pass's own.
// - A try still `running` whose run timed out (STAMP_TIMEOUT_MS), or whose entry ended lost or failed,
//   or is gone, is settled: one `settle` action stops the agent and records the try failed.
// - It claims nothing and changes nothing S1 reads: S1's choice and order are computed before this rule,
//   and the only effect on them is the score factors a stamp feeds (score.ts).
// - Nothing is planned while GitHub is in backoff. The caller (plan.ts) runs it only while the records are
//   read, and this rule only while the switch is on.
//
// Pure: the time is state.now.
import { skip, want } from '../foundation'
import type { LedgerEntry } from '../types'
import { intakeKey, intakeRunOf, intakeSettleKey } from './keys'
import { readyProblem } from './rules-claim'
import { STAMP_TIMEOUT_MS } from './stamps'
import type { V2Ctx } from './types'

// the runs at once
export const STAMP_RUNNING = 2

// why a try never ended, as the try's reason and the event carry it
export type SettleWhy = 'timeout' | 'lost' | 'spawn-failed'

// settleWhy: how a try that is still running ended, from its run's entry; null while the run goes on.
export function settleWhy(entry: LedgerEntry | undefined, now: number): SettleWhy | null {
  if (entry === undefined) return 'lost'
  switch (entry.status) {
    case 'running':
      return now - entry.startedAt >= STAMP_TIMEOUT_MS ? 'timeout' : null
    case 'timed-out':
      return 'timeout'
    case 'failed':
      return 'spawn-failed'
    default:
      // lost, or done with its try still running (the answer was never stored)
      return 'lost'
  }
}

export function intakeRules(ctx: V2Ctx): void {
  const { state, config } = ctx
  if (config.intakeStamp !== 'on') return
  if (state.githubBackoffUntil !== null && state.now < state.githubBackoffUntil) return
  const tries = ctx.v2.stampTries ?? {}
  const byKey = new Map(state.ledger.map(e => [e.key, e]))
  const settled = new Set<string>()
  // a running try whose run is over
  for (const [issue, t] of Object.entries(tries)) {
    if (t.outcome !== 'running') continue
    const n = Number(issue)
    const why = settleWhy(byKey.get(intakeKey(n, t.version)), state.now)
    if (why === null) continue
    settled.add(intakeKey(n, t.version))
    want(ctx, {
      kind: 'intake-stamp',
      op: 'settle',
      key: intakeSettleKey(n, t.version),
      class: 'free',
      rule: 'I1',
      reason: `the stamp of ${t.version} did not end: ${why}`,
      issue: n,
      version: t.version,
      why,
    })
  }
  // a running run whose try a newer body version replaced: it still counts toward the cap, so it is stopped
  // at the timeout too (the settle leaves the newer try alone)
  for (const e of state.ledger) {
    const run = e.kind === 'intake-stamp' && e.status === 'running' ? intakeRunOf(e.key) : null
    if (run === null || settled.has(e.key) || tries[String(run.issue)]?.version === run.version) continue
    if (settleWhy(e, state.now) !== 'timeout') continue
    want(ctx, {
      kind: 'intake-stamp',
      op: 'settle',
      key: intakeSettleKey(run.issue, run.version),
      class: 'free',
      rule: 'I1',
      reason: `the stamp of ${run.version}, replaced by a newer body version, did not end: timeout`,
      issue: run.issue,
      version: run.version,
      why: 'timeout',
    })
  }
  const issues = new Map(state.issues.map(i => [i.number, i]))
  let running = state.ledger.filter(e => e.kind === 'intake-stamp' && e.status === 'running' && intakeRunOf(e.key) !== null).length
  for (const n of [...state.queue].sort((a, b) => a - b)) {
    const issue = issues.get(n)
    if (readyProblem(config, issue) !== null || issue === undefined) continue
    const version = issue.bodyVersion
    if (version === null) {
      skip(ctx, 'I1', n, 'no-body-version')
      continue
    }
    if (tries[String(n)]?.version === version) {
      skip(ctx, 'I1', n, 'tried')
      continue
    }
    if (running >= STAMP_RUNNING) {
      skip(ctx, 'I1', n, 'cap')
      continue
    }
    const got = want(ctx, {
      kind: 'intake-stamp',
      op: 'run',
      key: intakeKey(n, version),
      class: 'develop',
      rule: 'I1',
      reason: `ready and not stamped at body version ${version}`,
      issue: n,
      version,
      maxAttempts: 2,
    })
    if (got === 'go') running += 1
  }
}
