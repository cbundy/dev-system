// The v2 executors (docs/factory-loop/v2/SPEC.md 2.2, appendix B), one map from each module that
// runs actions. act.ts joins them to EXECUTORS, so every action kind has an executor; its
// dispatcher takes executorOf, which prefers these, so a module here may also give a shared kind
// (a claim, a heartbeat) its own behaviour. Every new kind of appendix B must have one here
// (tests/v2-switch.test.ts).
import { rateLimited } from '../exec'
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'
import { executors as ci } from './act-ci'
import { executors as pr } from './act-pr'
import { executors as queue } from './act-queue'
import { executors as review } from './act-review'
import { executors as slots } from './act-slots'
import { executors as split } from './act-split'
import { executors as state } from './act-state'
import { executors as tracker } from './act-tracker'
import { pollPauseArgv } from './argv'
import { executors as steps } from './steps'

export const V2_EXECUTORS: Partial<Record<ActionKind, Executor>> = { ...state, ...pr, ...split, ...tracker, ...review, ...ci, ...queue, ...slots, ...steps }

// The pauses, in seconds, before an attempt that failed on a GitHub blip runs again (5.1).
const BLIP_PAUSES_S: readonly number[] = [5, 15]

// transientGitHub: GitHub's transient answers in a command's output (5.1): a 5xx (gh's `HTTP 502`,
// git's `returned error: 503`, or its name), GraphQL's "Something went wrong", a gateway or
// connection timeout. Never a rate limit, whose backoff holds GitHub (v2 SPEC 13.10 item 2); credentials, a
// 404, a validation error and a refusal do not read this way.
function transientGitHub(text: string): boolean {
  if (rateLimited(text)) return false
  return /\bHTTP 5\d\d\b|returned error: 5\d\d\b|Something went wrong|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error|context deadline exceeded|i\/o timeout|TLS handshake timeout|connection reset by peer/i.test(text)
}

// blip: an attempt that failed on a transient GitHub error, as its result tells it (its summary,
// the command's output, the lines it kept).
function blip(exec: Exec): boolean {
  if (exec.status !== 'failed' || exec.noRetry === true || exec.rateLimited === true) return false
  const o = exec.outcome
  return transientGitHub([exec.summary, o?.kind === 'cli' ? o.detail : '', o?.kind === 'queue' ? o.lines.join('\n') : ''].join('\n'))
}

// executorOf: what a kind runs: its own executor here, else the shared one's (act-cli.ts,
// act-merge.ts, wake.ts), run again after
// each pause of BLIP_PAUSES_S while it fails on a GitHub blip (5.1), so a blip never ends a step
// unknown or holds an effect. Running one again is safe: each reads what a try before it did (a
// comment's hidden key, the PR its ensure opened, a child's key, the head an update moved, read
// back even when GitHub finds it up to date, the PR a merge merged) before it acts or records,
// as the ledger's own retries need.
export function executorOf(kind: ActionKind, shared: Partial<Record<ActionKind, Executor>>): Executor | undefined {
  const run = V2_EXECUTORS[kind] ?? shared[kind]
  if (run === undefined) return undefined
  return async (ctx, action) => {
    for (const pause of BLIP_PAUSES_S) {
      const exec = await run(ctx, action)
      if (!blip(exec)) return exec
      await ctx.cmd(pollPauseArgv(pause), { timeoutMs: (pause + 10) * 1000 }).catch(() => undefined)
    }
    return run(ctx, action)
  }
}
