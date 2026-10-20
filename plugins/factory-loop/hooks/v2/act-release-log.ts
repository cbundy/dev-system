// The `released` executor (docs/factory-loop/v2/SPEC.md 11, appendix B): rule O4 logs a new release tag by
// running `callum-flow-released <tag> --repo <repo> --source <source>`, which writes the `released`
// event once per tag. Exit 0 is done (written, or skipped as a duplicate); exit 1 failed and the
// ledger's retry runs it again; exit 2 is a usage error, never retried. An image without the tool ends it
// done, since nothing can log the tag there and a stalled tell would only nag. Executors decide
// nothing: plan did.
import { NO_EXIT } from '../act-cli'
import type { Executor } from '../exec'
import type { ActionKind } from '../types'
import { clip, message, refused } from './act-split'

export const RELEASED_TIMEOUT_MS = 5 * 60 * 1000
const MISSING_SUMMARY = 'callum-flow-released is not on this image'

// missing: a command that could not start because the tool is not there (a throw naming ENOENT or "not
// found"), or the shell's exit 127.
function missing(text: string): boolean {
  return /ENOENT|not found|no such file/i.test(text)
}

const released: Executor = async (ctx, action) => {
  if (action.kind !== 'released') return refused(`the released executor got a ${action.kind} action`)
  const argv = ['callum-flow-released', action.tag, '--repo', ctx.rt.repo, '--source', action.source]
  let r
  try {
    r = await ctx.cmd(argv, { timeoutMs: RELEASED_TIMEOUT_MS })
  } catch (err) {
    if (missing(message(err))) return { status: 'done', outcome: { kind: 'cli', exit: 127, detail: message(err).slice(0, 2000) }, summary: MISSING_SUMMARY }
    return { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`callum-flow-released: ${message(err)}`) }
  }
  if (r.exitCode === 0) return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: clip(`logged ${action.tag} (source ${action.source})`) }
  if (r.exitCode === 127) return { status: 'done', outcome: { kind: 'cli', exit: 127 }, summary: MISSING_SUMMARY }
  const detail = (r.stderr.trim() || r.stdout.trim()).slice(0, 2000)
  const line = detail.split('\n').pop() ?? ''
  return {
    status: 'failed',
    outcome: { kind: 'cli', exit: r.exitCode, detail },
    summary: clip(`callum-flow-released: exit ${r.exitCode}${line === '' ? '' : `: ${line}`}`),
    ...(r.exitCode === 2 ? { noRetry: true } : {}),
  }
}

export const executors: Partial<Record<ActionKind, Executor>> = { released }
