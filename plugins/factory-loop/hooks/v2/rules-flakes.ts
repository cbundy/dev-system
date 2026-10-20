// The flake row (docs/factory-loop/v2/SPEC.md 8.5): once a ci-rerun's run has settled, the second
// `intervention` row for the re-run's fact says whether the re-run turned the run green (a CI flake)
// or the run failed again (not a flake), with the head and the job and test names the executor read
// from the failed jobs' log (act-ci.ts). Written once, however often the view is read: its key is
// iv/<rerun key>/flake, and events.ts onceKey tells it from the first row of the same fact. Pure.
import { gate, skip } from '../foundation'
import type { CheckRun } from './sources-prs'
import { intervention, logOnce } from './events'
import { interventionKey, keyParts, short } from './keys'
import { lifePr } from './rules-review'
import type { V2Ctx } from './types'

export function flakeRules(ctx: V2Ctx): void {
  for (const r of ctx.v2.records) {
    const pr = lifePr(ctx.state.ledger, r)
    const view = pr === null ? undefined : ctx.v2.prs.prs.find(v => v.pr === pr && v.issue === r.issue)
    if (view === undefined || view.head === null) continue
    for (const entry of ctx.state.ledger) {
      if (entry.kind !== 'ci-rerun' || entry.status !== 'done') continue
      const p = keyParts(entry.key)
      const runId = p === null ? null : /^rerun\/r\d+\/(\d+)$/.exec(p.rest)?.[1]
      if (p === null || p.issue !== r.issue || p.life !== r.life || runId === undefined || runId === null) continue
      // a refused check never ran: it is neither failed nor settled
      const checks = view.checks.filter(c => c.runId === runId && c.bucket !== 'refused')
      if (checks.length === 0) continue
      const since = (c: CheckRun) => c.completedAt !== null && c.completedAt >= entry.startedAt
      const bad = (c: CheckRun) => c.bucket === 'fail' || c.bucket === 'cancel'
      // decided once the run has no check going, shows a check that ended since the re-run began, and no
      // failed check still has its result from before it
      if (checks.some(c => c.bucket === 'pending') || !checks.some(since) || checks.some(c => bad(c) && !since(c))) continue
      const again = checks.filter(bad)
      const flaky = again.length === 0
      const head = view.head
      const reason = flaky ? `ci flake: run ${runId} passed on its re-run on ${short(head)}` : `not a flake: ${again.map(c => c.name).join(', ')} failed again after the re-run on ${short(head)}`
      const o = entry.outcome
      const names = o?.kind === 'cli' ? o : null
      const event = {
        ...intervention('loop', 'ci-rerun', entry.key, reason, { issue: r.issue, life: r.life, pr: view.pr }),
        flaky,
        failed_tests: names?.failedTests ?? null,
        failed_jobs: names?.failedJobs ?? null,
        head,
      }
      const key = interventionKey(`${entry.key}/flake`)
      const g = gate(ctx, key, 'event')
      if (g === 'go') ctx.out.push({ kind: 'event', key, class: 'free', rule: entry.rule, reason: `intervention: loop ci-rerun (${flaky ? 'flake' : 'not a flake'})`, issue: r.issue, ...logOnce(ctx.v2.logged, event) })
      else if (g === 'exhausted') skip(ctx, entry.rule, r.issue, `exhausted: ${key}: the flake row is not logged`)
    }
  }
}
