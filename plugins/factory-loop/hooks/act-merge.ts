// The gate and merge executors (SPEC 5.5, 6.1, 6.2, 7.4): guard, update-behind, fast-forward
// (#551), update-checkout (#555), fix-linkage, merge (then callum-flow-rollout), rollout for a hand merge (D-29), respond,
// which drives a parked gate with a detached `no-mistakes axi respond`, and env-retry, the one
// detached rerun (#537). They decide nothing (plan did): each runs its catalogue row's commands
// through ctx.cmd and reads the CLI's own lines and exit codes (images/base/callum-flow-merge-guard,
// callum-flow-merge, callum-flow-rollout, callum-flow-fix-linkage). The argv and the reading of
// the output are pure functions below, so tests, the replay harness and the argv safety test use
// them without the engine.
import { detailOf, rateLimited, respondLogPath } from './exec'
import type { EventFields, Exec, ExecCtx, Executor, ExtraEntry, RunInit, RunResult } from './exec'
import { guardSeq } from './plan'
import type { Action, ActionKind, GuardFail, LedgerEntry, Outcome, Pool, Rollout, Slot } from './types'

const SEC = 1000
const SUMMARY_MAX = 200

// The action shapes these executors read (a member's kind can be shared, so by its fields).
export type GateAction = Extract<Action, { kind: 'guard' | 'update-behind' }>
export type FastForwardAction = Extract<Action, { kind: 'fast-forward' }>
export type UpdateCheckoutAction = Extract<Action, { kind: 'update-checkout' }>
export type MergeAction = Extract<Action, { kind: 'merge' }>
export type RespondAction = Extract<Action, { kind: 'respond' }>

// Each command's timeout (SPEC 6.1). The catalogue has no row for a lone rollout read: it is
// one issue read, like close-issue. A respond's launch is 30 s, its slot lease like a
// release-worktree's.
export const MERGE_TIMEOUT_MS = {
  guard: 300 * SEC,
  'update-behind': 300 * SEC,
  'fast-forward': 120 * SEC,
  'update-checkout': 120 * SEC,
  'fix-linkage': 120 * SEC,
  merge: 600 * SEC,
  rollout: 60 * SEC,
  respond: 30 * SEC,
  lease: 120 * SEC,
} as const

// The exit recorded for a command that never exited: it could not start, or it outlived its
// timeout and was ended. Either counts as failed (SPEC 10.1).
export const NO_EXIT = -1

// How long the respond launch waits before it reads its log back: long enough for "no active
// run to respond to" or a usage error, well inside the 30 s launch timeout. The environment's
// FACTORY_LOOP_RESPOND_SETTLE_S overrides it (the launch script's test runs it for real).
export const RESPOND_SETTLE_S = 5

// The lease holder recorded on a slot the loop leases for a respond (treehouse get --lease).
export const LEASE_HOLDER = 'factory-loop'

// The last line the detached respond's wrapper appends to its log once it exits.
const EXITED = /^factory-loop: respond exited (\d+)\s*$/m

// --- argv (SPEC 6.1) ---------------------------------------------------------------------------

export function guardArgv(a: Pick<GateAction, 'pr' | 'run'>): string[] {
  return ['callum-flow-merge-guard', String(a.pr), '--run', a.run]
}

// The guard's one writing mode: a proved rebase of a PR that is only behind its base (#476).
export function updateBehindArgv(a: Pick<GateAction, 'pr' | 'run'>): string[] {
  return ['callum-flow-merge-guard', String(a.pr), '--update-behind', '--run', a.run]
}

export function fixLinkageArgv(a: { pr: number }): string[] {
  return ['callum-flow-fix-linkage', String(a.pr)]
}

// callum-flow-merge runs the guard again inside it and merges only on a pass, with the head the
// guard verified (--match-head-commit), so the loop can never merge without the guard.
export function mergeArgv(a: Pick<MergeAction, 'pr' | 'run'>): string[] {
  return ['callum-flow-merge', String(a.pr), '--run', a.run]
}

export function rolloutArgv(issue: number): string[] {
  return ['callum-flow-rollout', String(issue)]
}

// respondArgv: the respond itself (SPEC 6.1, I-51 to I-53): the action and only the flags its
// adjudicator gave. Never --run (respond targets the run of the branch the directory has
// checked out, I-94) and never --yes. Values go as --flag=value, one argv entry each, so a value
// that starts with a dash or holds quotes and spaces reaches the flag whole.
export function respondArgv(a: RespondAction): string[] {
  const argv = ['no-mistakes', 'axi', 'respond', '--action', a.action]
  const flag = (name: string, value: string | null) => {
    if (value !== null && value.trim() !== '') argv.push(`--${name}=${value}`)
  }
  // the gate plan judged: if the run moved on meanwhile, respond refuses rather than answer the
  // next gate (a gate with no step name is the one awaiting approval)
  flag('step', a.step)
  if (a.action === 'fix') {
    flag('findings', a.findings)
    flag('instructions', a.instructions)
    flag('add-finding', a.addFinding)
  } else if (a.action === 'approve' && a.step === 'test') {
    // no-mistakes takes --reason only on the test step: anywhere else it is a usage error
    flag('reason', a.approveReason)
  }
  return argv
}

// The one rerun the loop runs (rule P2a, #537): the pipeline again on the run's own head, from
// the slot on its branch, with no flag at all. The argv safety tests allow exactly this argv,
// from the env-retry executor, and nothing else that reruns.
export const ENV_RETRY_ARGV: readonly string[] = ['no-mistakes', 'rerun']

// A fresh slot for a respond when no slot has the run's branch: leased durably, with no
// subshell, its path on stdout (treehouse get --help). Empty stdin keeps any prompt from waiting.
export const LEASE_ARGV: readonly string[] = ['treehouse', 'get', '--lease', '--lease-holder', LEASE_HOLDER]

// git switch refuses a branch another worktree has checked out, so a stale pool reading can
// never put two slots on one run's branch.
export function switchArgv(branch: string): string[] {
  return ['git', 'switch', branch]
}

export function returnArgv(path: string): string[] {
  return ['treehouse', 'return', path]
}

// The respond launch, run with `sh -c` (the one shell the executors use, for a detached
// launch): $1 the slot, $2 the run's branch, $3 the log, the rest the respond's argv. It refuses
// a slot that is not on the branch, since respond would drive another branch's run. The respond
// runs under nohup with its output in the log and stdin closed, so the launch returns at once
// and the respond outlives it; its wrapper appends the exit code when it ends. After the settle
// the launch prints the log, so the read-back is this command's stdout.
export const LAUNCH_SCRIPT = [
  'cd -- "$1" || exit 3',
  'branch=$2 log=$3',
  'shift 3',
  'head=$(git symbolic-ref --short -q HEAD)',
  'if [ "$head" != "$branch" ]; then echo "factory-loop: the slot is on ${head:-a detached HEAD}, not $branch"; exit 3; fi',
  'mkdir -p -- "${log%/*}" || exit 3',
  `nohup sh -c '"$@"; echo "factory-loop: respond exited $?"' respond "$@" > "$log" 2>&1 < /dev/null &`,
  `sleep "\${FACTORY_LOOP_RESPOND_SETTLE_S:-${RESPOND_SETTLE_S}}"`,
  'cat -- "$log"',
].join('\n')

export function launchArgv(slot: string, branch: string, log: string, respond: readonly string[]): string[] {
  return ['sh', '-c', LAUNCH_SCRIPT, 'factory-loop-respond', slot, branch, log, ...respond]
}

// The fast-forward (rules M1, M2, #551), run with `sh -c` from the main checkout: $1 the run's
// branch, $2 the run's head. The pipeline commits in its own checkout and pushes, so the
// implementer's worktree sits behind the branch by exactly those commits and the guard fails
// `head`. This moves each worktree on the branch to the run's head, only when origin's branch
// is that head (fetched fresh), the worktree's head is an ancestor of it and nothing tracked is
// uncommitted, and only by `git merge --ff-only`, so no commit or change can be lost. Untracked
// files stay (a fast-forward that would overwrite one fails by itself). The merge runs none of the
// repo's git hooks (a post-merge npm install could outlast the timeout). The main checkout (the
// first worktree listed) is never moved (SPEC 5.2 G5): one left behind on the run's branch is
// refused, and G5 tells the owner. Every worktree is checked before any moves. It answers, with
// exit 0, a `FORWARDED <from> <to> <path>` line per worktree moved, `CURRENT <head>` when none
// lagged, or `REFUSED <why>`; anything else is a failure.
export const FF_SCRIPT = [
  'branch=$1 head=$2',
  'git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" || { echo "factory-loop: cannot fetch origin/$branch" >&2; exit 1; }',
  'origin=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}")',
  'if [ "$origin" != "$head" ]; then echo "REFUSED origin/$branch is ${origin:-unknown}, not the run head $head"; exit 0; fi',
  'list=$(git worktree list --porcelain) || exit 1',
  `main=$(printf '%s\\n' "$list" | awk '/^worktree / { print substr($0, 10); exit }')`,
  `paths=$(printf '%s\\n' "$list" | awk -v b="refs/heads/$branch" '/^worktree / { p = substr($0, 10) } /^branch / && substr($0, 8) == b { print p }')`,
  `nl=$(printf '\\n_') lag=`,
  'nl=${nl%_}',
  'IFS=$nl',
  'set -f',
  'for p in $paths; do',
  `  at=$(git -C "$p" rev-parse --verify --quiet 'HEAD^{commit}') || { echo "REFUSED cannot read the head of $p"; exit 0; }`,
  '  [ "$at" = "$head" ] && continue',
  '  [ "$p" != "$main" ] || { echo "REFUSED $p is the main worktree, which the loop never moves"; exit 0; }',
  '  st=$(git -C "$p" status --porcelain --untracked-files=no) || { echo "REFUSED cannot read the status of $p"; exit 0; }',
  '  [ -z "$st" ] || { echo "REFUSED $p has uncommitted changes"; exit 0; }',
  '  git merge-base --is-ancestor "$at" "$head" || { echo "REFUSED $p at $at has commits not on origin/$branch"; exit 0; }',
  '  lag=$lag$p$nl',
  'done',
  '[ -n "$lag" ] || { echo "CURRENT $head"; exit 0; }',
  'for p in $lag; do',
  '  at=$(git -C "$p" rev-parse --verify --quiet HEAD) || exit 1',
  '  git -C "$p" -c core.hooksPath=/dev/null merge --ff-only --quiet "$head" >&2 || { echo "factory-loop: the fast-forward of $p failed" >&2; exit 1; }',
  '  echo "FORWARDED $at $head $p"',
  'done',
].join('\n')

export function fastForwardArgv(branch: string, head: string): string[] {
  return ['sh', '-c', FF_SCRIPT, 'factory-loop-fast-forward', branch, head]
}

// The main checkout's update (rule H5, #555), run with `sh -c` from the main checkout: $1 origin's
// default branch. Agents begin there, so it follows origin: fetched fresh, and moved only by
// `git merge --ff-only`, only in the main worktree (not a linked one the session runs in), only
// while it is on that branch with nothing tracked uncommitted and its head an ancestor of
// origin's, so no commit or change can be lost. Untracked files stay, as in the fast-forward. Its
// branch and head are read again just before the merge, whose own ref update holds only while
// HEAD is still the head it read (SPEC 13 keeps the instant between). The merge runs none of the
// repo's git hooks (a post-merge npm install could outlast the timeout). It answers, with exit 0,
// `UPDATED <from> <to>`, `CURRENT <head>`, or `REFUSED <why>` (plan tells the owner); anything
// else is a failure.
export const CHECKOUT_SCRIPT = [
  'default=$1',
  'gitdir=$(git rev-parse --path-format=absolute --git-dir) && common=$(git rev-parse --path-format=absolute --git-common-dir) || { echo "factory-loop: cannot tell whether this is the main worktree" >&2; exit 1; }',
  '[ "$gitdir" = "$common" ] || { echo "REFUSED $(git rev-parse --show-toplevel) is a linked worktree, not the main checkout"; exit 0; }',
  'git fetch --quiet origin "+refs/heads/$default:refs/remotes/origin/$default" || { echo "factory-loop: cannot fetch origin/$default" >&2; exit 1; }',
  'origin=$(git rev-parse --verify --quiet "refs/remotes/origin/$default^{commit}") || { echo "factory-loop: cannot read origin/$default" >&2; exit 1; }',
  'branch=$(git symbolic-ref --quiet --short HEAD) || { echo "REFUSED the main checkout is detached"; exit 0; }',
  '[ "$branch" = "$default" ] || { echo "REFUSED the main checkout is on $branch, not $default"; exit 0; }',
  `at=$(git rev-parse --verify --quiet 'HEAD^{commit}') || { echo "REFUSED cannot read the head of the main checkout"; exit 0; }`,
  '[ "$at" != "$origin" ] || { echo "CURRENT $at"; exit 0; }',
  'st=$(git status --porcelain --untracked-files=no) || { echo "REFUSED cannot read the status of the main checkout"; exit 0; }',
  '[ -z "$st" ] || { echo "REFUSED the main checkout has uncommitted changes"; exit 0; }',
  'git merge-base --is-ancestor "$at" "$origin" || { echo "REFUSED the main checkout at $at has commits not on origin/$default"; exit 0; }',
  `[ "$(git symbolic-ref --quiet --short HEAD)" = "$default" ] && [ "$(git rev-parse --verify --quiet 'HEAD^{commit}')" = "$at" ] || { echo "factory-loop: the main checkout moved during its update" >&2; exit 1; }`,
  'git -c core.hooksPath=/dev/null merge --ff-only --quiet "$origin" >&2 || { echo "factory-loop: the fast-forward of the main checkout failed" >&2; exit 1; }',
  'echo "UPDATED $at $origin"',
].join('\n')

export function updateCheckoutArgv(branch: string): string[] {
  return ['sh', '-c', CHECKOUT_SCRIPT, 'factory-loop-update-checkout', branch]
}

// argvsOf: every command an action of these kinds can run, in order, for the argv safety test
// (SPEC 6.1) and the replay; null for a kind this module does not run. A respond lists both the
// slot it found and the lease path, with `<slot>` standing for the leased slot's path.
export function argvsOf(action: Action, loopDir: string, attempt = 1): string[][] | null {
  switch (action.kind) {
    case 'guard':
      return [guardArgv(action)]
    case 'update-behind':
      return [updateBehindArgv(action)]
    case 'fast-forward':
      return [fastForwardArgv(action.branch, action.head)]
    case 'update-checkout':
      return [updateCheckoutArgv(action.branch)]
    case 'fix-linkage':
      return [fixLinkageArgv(action)]
    case 'merge':
      return action.issue === null ? [mergeArgv(action)] : [mergeArgv(action), rolloutArgv(action.issue)]
    case 'rollout':
      return action.issue === null ? [] : [rolloutArgv(action.issue)]
    case 'respond': {
      const log = respondLogPath(loopDir, action.key, attempt)
      return [[...LEASE_ARGV], switchArgv(action.branch), returnArgv('<slot>'), launchArgv('<slot>', action.branch, log, respondArgv(action))]
    }
    case 'env-retry': {
      const log = respondLogPath(loopDir, action.key, attempt)
      return [[...LEASE_ARGV], switchArgv(action.branch), returnArgv('<slot>'), launchArgv('<slot>', action.branch, log, ENV_RETRY_ARGV)]
    }
    default:
      return null
  }
}

// --- reading the CLIs' output (SPEC 6.2) --------------------------------------------------------

// parseGuard: each `GUARD <name> FAIL <reason>` line as { name, reason }, and each
// `GUARD test-weakening WARN ...` line whole, as plan hands it to the adjudicator (SPEC 6.2).
// The head PASS line on a patch proof, VERIFIED and WEAKENED lines are not failures.
export function parseGuard(text: string): { fails: GuardFail[]; warns: string[] } {
  const fails: GuardFail[] = []
  const warns: string[] = []
  for (const line of lines(text)) {
    const fail = /^GUARD (\S+) FAIL(?: (.*))?$/.exec(line)
    if (fail?.[1] !== undefined) fails.push({ name: fail[1], reason: (fail[2] ?? '').trim() })
    else if (line.startsWith('GUARD test-weakening WARN ')) warns.push(line)
  }
  return { fails, warns }
}

export type UpdateBehind = {
  result: 'updated' | 'fail' | 'skip'
  branch: string | null
  from: string | null
  to: string | null
  line: string
}

// parseUpdateBehind: the guard's --update-behind line: `UPDATED pr= branch= from= to= run=
// gated_patch= rebased_from=` (from is the PR head it replaced, to the head it pushed),
// `UPDATE-BEHIND FAIL <why>; fall back to a full re-gate: ...` or `UPDATE-BEHIND SKIP <why>`.
// An UPDATED line without both heads is not one.
export function parseUpdateBehind(text: string): UpdateBehind | null {
  for (const line of lines(text)) {
    if (line.startsWith('UPDATED ')) {
      const f = fields(line)
      const from = f.get('from') || null
      const to = f.get('to') || null
      if (from === null || to === null) return null
      return { result: 'updated', branch: f.get('branch') || null, from, to, line }
    }
    if (line.startsWith('UPDATE-BEHIND FAIL ')) return { result: 'fail', branch: null, from: null, to: null, line }
    if (line.startsWith('UPDATE-BEHIND SKIP ')) return { result: 'skip', branch: null, from: null, to: null, line }
  }
  return null
}

export type FastForward = { result: 'forwarded' | 'current' | 'refused'; line: string }

// parseFastForward: the fast-forward's answer (FF_SCRIPT): every FORWARDED line, joined, else
// its one CURRENT or REFUSED line; null when it printed none.
export function parseFastForward(text: string): FastForward | null {
  const said = lines(text)
  const moved = said.filter(l => l.startsWith('FORWARDED '))
  if (moved.length > 0) return { result: 'forwarded', line: moved.join('; ') }
  const one = said.find(l => l.startsWith('CURRENT ') || l.startsWith('REFUSED '))
  if (one === undefined) return null
  return { result: one.startsWith('CURRENT ') ? 'current' : 'refused', line: one }
}

export type UpdateCheckout = { result: 'updated' | 'current' | 'refused'; line: string }

// parseUpdateCheckout: the main checkout update's one answer line (CHECKOUT_SCRIPT); null when it
// printed none.
export function parseUpdateCheckout(text: string): UpdateCheckout | null {
  const line = lines(text).find(l => /^(UPDATED|CURRENT|REFUSED) /.test(l))
  if (line === undefined) return null
  return { result: line.startsWith('UPDATED ') ? 'updated' : line.startsWith('CURRENT ') ? 'current' : 'refused', line }
}

export type Linkage = { result: 'match' | 'skip' | 'repaired' | 'mismatch'; line: string }

// parseFixLinkage: callum-flow-fix-linkage's one stdout line: MATCH or SKIP (nothing to do),
// REPAIRED, or `MISMATCH ... after-fix` when the repaired body still does not verify.
export function parseFixLinkage(text: string): Linkage | null {
  for (const line of lines(text)) {
    const word = /^(MATCH|SKIP|REPAIRED|MISMATCH)\b/.exec(line)?.[1]
    if (word !== undefined) return { result: word.toLowerCase() as Linkage['result'], line }
  }
  return null
}

export type RolloutRead =
  | { rollout: Rollout; source: string; line: string }
  | { rollout: null; problem: 'conflict' | 'invalid' | 'unreadable' | 'unknown'; line: string }

// parseRollout: callum-flow-rollout's one line: `ROLLOUT <merge|run-it|keep-open> source=<brief|body>`,
// or `ROLLOUT conflict|invalid|unreadable <reason>` (exit 1).
export function parseRollout(text: string): RolloutRead {
  const line = lines(text).find(l => l.startsWith('ROLLOUT ')) ?? ''
  const ok = /^ROLLOUT (merge|run-it|keep-open) source=(\S+)$/.exec(line)
  if (ok?.[1] !== undefined && ok[2] !== undefined) return { rollout: ok[1] as Rollout, source: ok[2], line }
  const bad = /^ROLLOUT (conflict|invalid|unreadable)\b/.exec(line)?.[1] as 'conflict' | 'invalid' | 'unreadable' | undefined
  return { rollout: null, problem: bad ?? 'unknown', line }
}

// parseCloseIssue: the issue callum-flow-merge says to close by hand: a closing PR on a
// non-default base, where GitHub registers no closing reference.
export function parseCloseIssue(text: string): number | null {
  const n = /^Close issue #(\d+) by hand\b/m.exec(text)?.[1]
  return n === undefined ? null : Number(n)
}

// mergeRefusal: the line callum-flow-merge prints when GitHub (or the harness) refused a merge
// the guard passed: the head moved, a branch rule, or another refusal; null when it printed none.
export function mergeRefusal(stderr: string): string | null {
  const re = /^callum-flow-merge: (head moved since the check|GitHub refused|the guard verified no head sha)/
  return lines(stderr).find(l => re.test(l)) ?? null
}

// guardKeyAfter: the key of a guard outcome recorded beside a merge: one past this PR and head's
// highest guard key, as plan numbers them (SPEC M1), and never a key the ledger already holds.
export function guardKeyAfter(ledger: readonly LedgerEntry[], pr: number, head: string): string {
  const held = new Set(ledger.map(e => e.key))
  let n = Math.max(0, ...ledger.filter(e => e.kind === 'guard' && e.pr === pr && e.head === head).map(e => guardSeq(e.key))) + 1
  while (held.has(`guard:${pr}:${head}:${n}`)) n++
  return `guard:${pr}:${head}:${n}`
}

// slotFor: the pool slot with the run's branch checked out (I-94), a held slot before an
// available one, then by path; null when no slot has it.
export function slotFor(pool: Pool | null, branch: string): Slot | null {
  const on = (pool?.slots ?? []).filter(s => s.branch === branch && s.path !== '')
  const rank = (s: Slot) => (s.state === 'available' ? 1 : 0)
  return [...on].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))[0] ?? null
}

// leasedPath: the slot path `treehouse get --lease` printed (its last stdout line), or null.
export function leasedPath(stdout: string): string | null {
  const path = lines(stdout).pop() ?? ''
  return path.startsWith('/') ? path : null
}

// respondProblem: why a respond launch did not take, from the launch's exit and the log it read
// back after the settle, or null when it is running. Respond fails "no active run to respond to"
// silently when the directory's branch has no parked run (implement-issue SKILL); any other
// respond that already exited non-zero is an immediate error.
export function respondProblem(r: RunResult): string | null {
  const log = lines(r.stdout)
  const said = log.filter(l => !EXITED.test(l))
  if (r.exitCode !== 0) return said.pop() || lines(r.stderr).pop() || `the launch exited ${r.exitCode}`
  if (log.some(l => /no active run to respond to/i.test(l))) return 'no active run to respond to'
  const exited = EXITED.exec(r.stdout)?.[1]
  if (exited !== undefined && exited !== '0') return `respond exited ${exited}${said.length > 0 ? `: ${said[said.length - 1]}` : ''}`
  return null
}

// validBranch: a branch name the respond can switch to and name as an argument: no leading dash,
// no spaces or shell-special characters (the loop works only issue-<N> branches, SPEC 11.5).
export function validBranch(branch: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(branch)
}

// --- the executors ----------------------------------------------------------------------------

const guard: Executor = async (ctx, action) => {
  if (action.kind !== 'guard') return wrongKind('guard', action)
  const argv = guardArgv(action)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS.guard)
  if (!('exitCode' in r)) return r
  const { fails, warns } = parseGuard(r.stdout)
  // exit 1 with no FAIL line means the guard could not run at all: failed, not an empty pass
  if (r.exitCode !== 0 && !(r.exitCode === 1 && fails.length > 0)) return failure(argv, r)
  const outcome: Outcome = { kind: 'guard', fails, warns }
  const said = fails.length === 0 ? 'pass' : `FAIL ${fails.map(f => f.name).join(', ')}`
  return { status: 'done', outcome, summary: clip(`guard PR #${action.pr} at ${short(action.head)}: ${said}${warnNote(warns)}`) }
}

// update-behind (rules M2, M2a, M2b): UPDATED and FAIL are answers; SKIP is a failed attempt, so
// plan retries it after updateBehindRetryMs and tells the owner once the attempts run out.
const updateBehind: Executor = async (ctx, action) => {
  if (action.kind !== 'update-behind') return wrongKind('update-behind', action)
  const argv = updateBehindArgv(action)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS['update-behind'])
  if (!('exitCode' in r)) return r
  const u = parseUpdateBehind(r.stdout)
  const expected = u === null ? null : u.result === 'updated' ? 0 : 1
  if (u === null || r.exitCode !== expected) return failure(argv, r)
  const outcome: Outcome = { kind: 'update-behind', result: u.result, from: u.from, to: u.to, line: u.line }
  if (u.result === 'skip') {
    const exec: Extract<Exec, { status: 'failed' }> = { status: 'failed', outcome, summary: clip(u.line) }
    if (rateLimited(r.stderr)) exec.rateLimited = true
    return exec
  }
  if (u.result === 'fail') return { status: 'done', outcome, summary: clip(u.line) }
  // the pushed head is history the event log must hold (SPEC 7.4); the push already happened,
  // so a failed log is noted, never a failed attempt
  const logged = await event(ctx, 'rebased_behind', { issue: action.issue, run: action.run, branch: u.branch, pr: action.pr, head: u.to })
  return { status: 'done', outcome, summary: clip(`rebased PR #${action.pr} ${short(u.from)} -> ${short(u.to)}${logged}`) }
}

// fast-forward (rules M1, M2, #551): FORWARDED, CURRENT and REFUSED are answers, logged with
// both heads; a refusal goes to the judge (plan reads it). Only a sha and a branch the loop
// works reach the script.
const fastForward: Executor = async (ctx, action) => {
  if (action.kind !== 'fast-forward') return wrongKind('fast-forward', action)
  if (!validBranch(action.branch)) return refused(`branch ${JSON.stringify(action.branch)} is not one to fast-forward`)
  if (!/^[0-9a-f]{7,64}$/.test(action.head)) return refused(`head ${JSON.stringify(action.head)} is not a commit`)
  const argv = fastForwardArgv(action.branch, action.head)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS['fast-forward'])
  if (!('exitCode' in r)) return r
  const f = parseFastForward(r.stdout)
  if (r.exitCode !== 0 || f === null) return failure(argv, r)
  return { status: 'done', outcome: { kind: 'fast-forward', result: f.result, line: f.line }, summary: clip(`PR #${action.pr}: ${f.line}`) }
}

// update-checkout (rule H5, #555): UPDATED, CURRENT and REFUSED are answers, logged with both
// commits; plan tells the owner of a refusal. Only a branch name reaches the script.
const updateCheckout: Executor = async (ctx, action) => {
  if (action.kind !== 'update-checkout') return wrongKind('update-checkout', action)
  if (!validBranch(action.branch)) return refused(`branch ${JSON.stringify(action.branch)} is not one to update`)
  const argv = updateCheckoutArgv(action.branch)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS['update-checkout'])
  if (!('exitCode' in r)) return r
  const u = parseUpdateCheckout(r.stdout)
  if (r.exitCode !== 0 || u === null) return failure(argv, r)
  return { status: 'done', outcome: { kind: 'update-checkout', result: u.result, line: u.line }, summary: clip(`main checkout: ${u.line}`) }
}

// fix-linkage (rule M2): MATCH, SKIP and REPAIRED end it; a repair that still does not verify
// is an answer too, so the guard runs again and a second linkage FAIL tells the owner.
const fixLinkage: Executor = async (ctx, action) => {
  if (action.kind !== 'fix-linkage') return wrongKind('fix-linkage', action)
  const argv = fixLinkageArgv(action)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS['fix-linkage'])
  if (!('exitCode' in r)) return r
  const l = parseFixLinkage(r.stdout)
  if (r.exitCode === 0) return { status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: clip(l?.line ?? `linkage of PR #${action.pr} fine`) }
  if (r.exitCode === 1 && l?.result === 'mismatch') {
    return { status: 'done', outcome: { kind: 'cli', exit: 1, detail: l.line }, summary: clip(`still mismatched: ${l.line}`) }
  }
  return failure(argv, r)
}

// merge (rules M5, M6, M7): merged, then the issue's rollout; a guard FAIL that the merge's own
// guard printed is recorded as this head's next guard outcome, so rule M2 handles it next pass
// (SPEC 5.5); a refusal by GitHub or the harness goes to the owner (M6).
const merge: Executor = async (ctx, action) => {
  if (action.kind !== 'merge') return wrongKind('merge', action)
  const argv = mergeArgv(action)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS.merge)
  if (!('exitCode' in r)) return r
  if (r.exitCode === 0) {
    const closeIssue = parseCloseIssue(r.stdout)
    const read = action.issue === null ? null : await readRollout(ctx, action.issue)
    const rollout = read?.rollout ?? null
    const line = lines(r.stdout).find(l => l.startsWith('Close issue #')) ?? `merged PR #${action.pr} at ${short(action.head)}`
    const outcome: Outcome = { kind: 'merge', result: 'merged', rollout, closeIssue, line }
    const unread = read !== null && 'problem' in read ? `; rollout unread: ${read.problem}` : ''
    return { status: 'done', outcome, summary: clip(`merged PR #${action.pr}, rollout ${rollout ?? 'unknown'}${closeIssue === null ? '' : `, close #${closeIssue} by hand`}${unread}`) }
  }
  if (r.exitCode === 1) {
    const { fails, warns } = parseGuard(r.stdout)
    const first = fails[0]
    if (first !== undefined) {
      const line = `GUARD ${first.name} FAIL ${first.reason}`
      const extra: ExtraEntry = {
        key: guardKeyAfter(ctx.state.ledger, action.pr, action.head),
        kind: 'guard',
        issue: action.issue,
        run: action.run,
        pr: action.pr,
        head: action.head,
        outcome: { kind: 'guard', fails, warns },
      }
      // a failed attempt, not a refusal: once M2 clears the FAIL, plan merges again (M5)
      return {
        status: 'failed',
        outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line },
        summary: clip(`not merged, the guard failed: ${fails.map(f => f.name).join(', ')}`),
        extra: [extra],
      }
    }
    const refusal = mergeRefusal(r.stderr)
    if (refusal !== null && !rateLimited(r.stderr)) {
      return { status: 'done', outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line: refusal }, summary: clip(refusal) }
    }
  }
  return failure(argv, r)
}

// rollout (rule M7 for a hand merge, D-29): the merged issue's rollout, read as the merge
// executor reads it. A hand merge prints no close_issue, so none is recorded.
const rollout: Executor = async (ctx, action) => {
  if (action.kind !== 'rollout') return wrongKind('rollout', action)
  if (action.issue === null) return refused('a rollout read names no issue')
  const argv = rolloutArgv(action.issue)
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS.rollout)
  if (!('exitCode' in r)) return r
  const read = parseRollout(r.stdout)
  if (r.exitCode !== 0 || read.rollout === null) return failure(argv, r, read.line)
  return { status: 'done', outcome: { kind: 'rollout', rollout: read.rollout, closeIssue: null }, summary: clip(read.line) }
}

// respond (rules P3, P3a; SPEC 6.1, I-51 to I-53, I-94): launched detached from the slot that has
// the run's branch checked out, or from a slot leased for it, and read back after a settle. A
// clean launch is done: the run moving settles it, and rule P3a retries a respond that left the
// gate where it was respondSettleMs after the launch.
const respond: Executor = async (ctx, action) => {
  if (action.kind !== 'respond') return wrongKind('respond', action)
  if (!validBranch(action.branch)) return refused(`branch ${JSON.stringify(action.branch)} is not one respond can switch to`)
  const log = respondLogPath(ctx.rt.loopDir, ctx.entry.key, ctx.entry.attempts)
  const found = slotFor(ctx.state.pool, action.branch)
  let slot = found?.path ?? null
  if (slot === null) {
    const leased = await leaseSlot(ctx, action.branch)
    if (typeof leased !== 'string') return leased
    slot = leased
  }
  const argv = launchArgv(slot, action.branch, log, respondArgv(action))
  const r = await run(ctx, argv, MERGE_TIMEOUT_MS.respond)
  if (!('exitCode' in r)) return r
  const outcome: Outcome = { kind: 'respond', slot, log }
  const problem = respondProblem(r)
  if (problem !== null) return { status: 'failed', outcome, summary: clip(`respond --action ${action.action} in ${slot}: ${problem}`) }
  // a review fix counts toward the review cap through this event (rule P1, I-52)
  const logged = action.logReview ? await event(ctx, 'fix_requested', { issue: action.issue, run: action.run, branch: action.branch, note: 'review' }) : ''
  const where = found === null ? `leased ${slot}` : slot
  return { status: 'done', outcome, summary: clip(`respond --action ${action.action} on ${action.step ?? 'its gate'} launched in ${where}${logged}`) }
}

// env-retry (rule P2a, #537): the rerun, launched detached like a respond and read back after the
// settle. Only rule P2a's action for a resume round, on its first attempt: anything else is
// refused before a command runs. A clean launch is done; the new run it starts settles it.
const envRetry: Executor = async (ctx, action) => {
  if (action.kind !== 'env-retry') return wrongKind('env-retry', action)
  if (action.rule !== 'P2a' || !/^env-retry:.+:r\d+$/.test(action.key)) return refused(`env-retry ${action.key} is not rule P2a's, after an owner resume`)
  if (ctx.entry.attempts > 1) return refused(`env-retry ${action.key} runs once per resume`)
  if (!validBranch(action.branch)) return refused(`branch ${JSON.stringify(action.branch)} is not one env-retry can switch to`)
  const log = respondLogPath(ctx.rt.loopDir, ctx.entry.key, ctx.entry.attempts)
  const found = slotFor(ctx.state.pool, action.branch)
  let slot = found?.path ?? null
  if (slot === null) {
    const leased = await leaseSlot(ctx, action.branch)
    if (typeof leased !== 'string') return leased
    slot = leased
  }
  const r = await run(ctx, launchArgv(slot, action.branch, log, ENV_RETRY_ARGV), MERGE_TIMEOUT_MS.respond)
  if (!('exitCode' in r)) return r
  const outcome: Outcome = { kind: 'respond', slot, log }
  // the launch's wrapper names every command it runs "respond"
  const problem = respondProblem(r)?.replace(/^respond exited/, 'exited')
  if (problem !== undefined) return { status: 'failed', outcome, summary: clip(`env-retry of ${short(action.head)} in ${slot}: ${problem}`) }
  const where = found === null ? `leased ${slot}` : slot
  return { status: 'done', outcome, summary: clip(`env-retry of ${short(action.head)} on ${action.branch} launched in ${where}`) }
}

// leaseSlot: a fresh slot on the run's branch, or why there is none. A slot leased but not
// switched goes straight back to the pool: the housekeeping rule that returns slots (H3) only
// sees slots on an issue's branch.
async function leaseSlot(ctx: ExecCtx, branch: string): Promise<string | Exec> {
  const got = await run(ctx, [...LEASE_ARGV], MERGE_TIMEOUT_MS.lease, '')
  if (!('exitCode' in got)) return got
  const path = got.exitCode === 0 ? leasedPath(got.stdout) : null
  if (path === null) return failure([...LEASE_ARGV], got, got.exitCode === 0 ? 'treehouse printed no slot path' : undefined)
  const switched = await run(ctx, switchArgv(branch), MERGE_TIMEOUT_MS.lease, undefined, path)
  if ('exitCode' in switched && switched.exitCode === 0) return path
  await run(ctx, returnArgv(path), MERGE_TIMEOUT_MS.lease, '')
  const why = 'exitCode' in switched ? lines(switched.stderr).pop() || `exit ${switched.exitCode}` : switched.summary
  return { status: 'failed', outcome: { kind: 'cli', exit: 'exitCode' in switched ? switched.exitCode : NO_EXIT, detail: why }, summary: clip(`no slot on ${branch}: ${why}`) }
}

// readRollout: the rollout after a merge. The merge already happened, so a read that fails is
// noted in the outcome as unknown, never a failed (and so retried) merge.
async function readRollout(ctx: ExecCtx, issue: number): Promise<RolloutRead> {
  const r = await run(ctx, rolloutArgv(issue), MERGE_TIMEOUT_MS.rollout)
  if (!('exitCode' in r)) return { rollout: null, problem: 'unreadable', line: r.summary }
  const read = parseRollout(r.stdout)
  // a resolved line comes only with exit 0
  if (r.exitCode !== 0 && read.rollout !== null) return { rollout: null, problem: 'unknown', line: read.line }
  return read
}

export const mergeExecutors: Partial<Record<ActionKind, Executor>> = {
  guard,
  'update-behind': updateBehind,
  'fast-forward': fastForward,
  'update-checkout': updateCheckout,
  'fix-linkage': fixLinkage,
  merge,
  rollout,
  respond,
  'env-retry': envRetry,
}

// --- helpers -----------------------------------------------------------------------------------

// run: one command through ctx.cmd; a command that cannot start or outlives its timeout is a
// failed attempt with no exit (SPEC 10.1).
async function run(ctx: ExecCtx, argv: string[], timeoutMs: number, stdin?: string, cwd?: string): Promise<RunResult | Exec> {
  const init: RunInit = { timeoutMs }
  if (stdin !== undefined) init.stdin = stdin
  if (cwd !== undefined) init.cwd = cwd
  try {
    return await ctx.cmd(argv, init)
  } catch (err) {
    return { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${label(argv)}: ${message(err)}`) }
  }
}

// failure: a command that exited with a failure: its exit and detail in the outcome (SPEC
// 10.1). Exit 2 from the image's own CLIs is a usage error, a loop bug never retried; a GitHub
// rate limit in stderr is flagged for the driver's backoff (SPEC 10.2).
export function failure(argv: readonly string[], r: RunResult, said?: string): Exec {
  const line = said || lines(r.stderr).pop() || lines(r.stdout).pop() || ''
  const exec: Extract<Exec, { status: 'failed' }> = {
    status: 'failed',
    outcome: { kind: 'cli', exit: r.exitCode, detail: detailOf(r) },
    summary: clip(`${label(argv)}: exit ${r.exitCode}${line === '' ? '' : `: ${line}`}`),
  }
  if (r.exitCode === 2 && (argv[0] ?? '').startsWith('callum-flow-')) exec.noRetry = true
  if (rateLimited(r.stderr)) exec.rateLimited = true
  return exec
}

// event: one factory event; '' when it was logged, else a note for the summary. The command it
// follows already acted, so a failed log never fails the attempt.
async function event(ctx: ExecCtx, state: string, f: EventFields): Promise<string> {
  try {
    await ctx.event(state, f)
    return ''
  } catch (err) {
    return `; ${state} not logged: ${message(err)}`
  }
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function wrongKind(kind: ActionKind, action: Action): Exec {
  return refused(`the ${kind} executor got a ${action.kind} action`)
}

function warnNote(warns: readonly string[]): string {
  return warns.length === 0 ? '' : `, ${warns.length} test-weakening WARN`
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
}

// fields: the key=value tokens of one line.
function fields(line: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const token of line.split(/\s+/)) {
    const i = token.indexOf('=')
    if (i > 0) out.set(token.slice(0, i), token.slice(i + 1))
  }
  return out
}

function label(argv: readonly string[]): string {
  if (argv[0] === 'sh') return argv[3] === 'factory-loop-fast-forward' ? 'fast-forward' : argv[3] === 'factory-loop-update-checkout' ? 'update-checkout' : 'respond launch'
  return argv.slice(0, argv[0] === 'treehouse' || argv[0] === 'git' ? 2 : 1).join(' ')
}

function short(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 7)
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
