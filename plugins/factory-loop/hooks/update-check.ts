// The restart precheck of `update` (#1345): before an update is accepted, ask the workspace whether
// it could restart itself (`dev-restart-self --check`: credentials only, no request, answers in
// milliseconds). Exit 1 means it could not and the update is refused with the reason; anything
// else (an image too old to know --check, a command that is missing or too slow) leaves the update
// as it was, with a note that the credentials were not checked.

export type CheckRun = (argv: string[], opts: { timeoutMs: number }) => Promise<{ exitCode: number; stderr: string; timedOut?: boolean }>

export type RestartCheck = { kind: 'ok' } | { kind: 'missing'; reason: string } | { kind: 'unchecked'; why: string }

// inside the op's 2 s bound (TOOL_ANSWER_MS): a slower check would make the op late and unwritten
export const CHECK_TIMEOUT_MS = 1000

const PREFIX = 'dev-restart-self: '

export async function restartCheck(run: CheckRun): Promise<RestartCheck> {
  let r: Awaited<ReturnType<CheckRun>>
  try {
    r = await run(['dev-restart-self', '--check'], { timeoutMs: CHECK_TIMEOUT_MS })
  } catch (err) {
    return { kind: 'unchecked', why: `the check could not run (${String(err).slice(0, 120)})` }
  }
  if (r.timedOut === true) return { kind: 'unchecked', why: `the check did not answer within ${CHECK_TIMEOUT_MS / 1000} s` }
  if (r.exitCode === 0) return { kind: 'ok' }
  if (r.exitCode === 1) {
    const last = r.stderr.trim().split('\n').pop()?.trim() ?? ''
    const reason = last.startsWith(PREFIX) ? last.slice(PREFIX.length) : last
    return { kind: 'missing', reason: reason === '' ? 'dev-restart-self --check found no credentials' : reason }
  }
  if (r.exitCode === 2) return { kind: 'unchecked', why: "this image's dev-restart-self has no --check" }
  return { kind: 'unchecked', why: `the check exited ${r.exitCode}` }
}

// The words of the two outcomes that change the answer.
export const refusedText = (reason: string): string => `Not changed: this workspace cannot restart itself: ${reason}`
export const uncheckedText = (why: string): string => ` Credentials unchecked: ${why}.`
