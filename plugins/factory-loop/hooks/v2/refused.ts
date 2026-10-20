// What a refused check is (docs/factory-loop/v2/SPEC.md 8.5, "Refused jobs"): a GitHub Actions job
// GitHub did not start because of the account (failed payments, a spending limit), which
// sources-prs.ts classifies from the job and its annotation. It is neither red nor green: the review
// step (rules-review.ts) and the merge queue's head (steps-queue.ts) hold on it, and rules-refused.ts
// tells the owner and re-runs the refused runs. Pure; kept apart from rules-refused.ts so the two CI
// halves can import it without a cycle through rules-review.ts.
import type { CheckRun } from './sources-prs'

// jobIdOf: the job id in a check's link (.../actions/runs/<run>/job/<job>), which is the id of its
// check run; null for a link that names no job.
export function jobIdOf(link: string | null | undefined): string | null {
  return /\/actions\/runs\/\d+\/job\/(\d+)/.exec(link ?? '')?.[1] ?? null
}

export const isRefused = (c: CheckRun): boolean => c.bucket === 'refused'

const name = (c: CheckRun) => c.name.replace(/\s+/g, ' ').slice(0, 120)

// refusedLine: the skip line of a head held on refused checks: each job, its run and GitHub's message.
export function refusedLine(who: string, head: string, checks: readonly CheckRun[]): string {
  const shown = checks.slice(0, 3).map(c => `"${name(c)}" (run ${c.runId ?? 'none'}, job ${jobIdOf(c.link) ?? 'none'}): ${c.refusedWhy ?? 'GitHub did not start it'}`)
  const more = checks.length > shown.length ? `, and ${checks.length - shown.length} more` : ''
  return `${who}: GitHub did not start ${shown.join('; ')}${more} on ${head.slice(0, 7)}; that is the account, not the code, so it holds and the loop re-runs it once Actions runs again`
}
