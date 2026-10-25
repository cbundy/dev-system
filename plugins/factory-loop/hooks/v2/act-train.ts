// The merge train's executors (docs/factory-loop/v2/SPEC.md 9.8, appendix B), `queue-train`, one try
// per key. All of them run git from the main checkout and touch no working tree, no checked out branch
// and no branch of a pull request:
// - build: fetches the tips of the head's branch (H') and of the record's branch (N) into FETCH_HEAD
//   only, and checks each is still the sha the plan read (a moved branch is the drop `head-moved`, a
//   done try with no train); `git merge-tree --write-tree H' N` makes the merged tree T (exit 1, a
//   conflict, is the drop `conflict`); `git commit-tree T -p H' -p N` makes the train commit, with a
//   fixed author, committer and date so a retried build makes the very same commit and its push is a
//   no-op; `git push origin <sha>:refs/heads/factory-train/i<N>-<T7>` is what starts CI on it. The
//   outcome records T, the train commit and the three shas it was built from.
// - delete: removes one train branch from origin once its train ended (merged, or dropped for a
//   reason its key names); one already gone is done.
// - sweep: removes every `factory-train/*` branch on origin but the ones the plan names as kept (the
//   live trains'): what a crash left, and what a failed delete left.
// Only a branch under the `factory-train/` prefix is ever deleted. Executors decide nothing: plan did.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, ExecCtx, Executor, RunResult } from '../exec'
import type { ActionKind } from '../types'
import * as ARGV from './argv'
import { TRAIN_PREFIX } from './train-types'
import type { TrainAction, TrainDrop, TrainOutcome } from './train-types'

const SEC = 1000
const GIT_MS = 60 * SEC
const PUSH_MS = 2 * 60 * SEC
const SUMMARY_MAX = 200
// the identity and date of every train commit: fixed, so the same inputs make the same commit
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'factory-loop',
  GIT_AUTHOR_EMAIL: 'factory-loop@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'factory-loop',
  GIT_COMMITTER_EMAIL: 'factory-loop@users.noreply.github.com',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
}
// the most branches one delete command names
const DELETE_CHUNK = 20

type Run = { ok: true; r: RunResult } | { ok: false; exec: Exec }

async function run(ctx: ExecCtx, argv: string[], timeoutMs: number, env?: Record<string, string>): Promise<Run> {
  try {
    return { ok: true, r: await ctx.cmd(argv, env === undefined ? { timeoutMs } : { timeoutMs, env }) }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, exec: { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: why.slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${why}`) } }
  }
}

const done = (outcome: TrainOutcome, summary: string): Exec => ({ status: 'done', outcome, summary: clip(summary) })

// tipOf: the sha a branch of origin points at now; why not (it is gone, or the fetch failed).
async function tipOf(ctx: ExecCtx, branch: string): Promise<{ sha: string } | { gone: true } | { fail: Exec }> {
  const f = await run(ctx, ARGV.trainFetchArgv(branch), GIT_MS)
  if (!f.ok) return { fail: f.exec }
  if (f.r.exitCode !== 0) return /couldn't find remote ref/i.test(f.r.stderr) ? { gone: true } : { fail: commandFailure(ARGV.trainFetchArgv(branch), f.r) }
  const p = await run(ctx, ARGV.fetchHeadArgv(), GIT_MS)
  if (!p.ok) return { fail: p.exec }
  const sha = p.r.stdout.trim()
  return p.r.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? { sha } : { fail: commandFailure(ARGV.fetchHeadArgv(), p.r) }
}

const build: Executor = async (ctx, action) => {
  if (action.kind !== 'queue-train' || action.op !== 'build') return refused(`the queue-train build executor got a ${action.kind} action`)
  const base = { kind: 'train', op: 'build', headIssue: action.headIssue, head: action.head, rider: action.rider, main: action.main } as const
  const dropped = (drop: TrainDrop, why: string): Exec => done({ ...base, tree: null, train: null, branch: null, drop }, `PR #${action.pr}: no train (${drop}): ${why}`)
  // both tips are what the plan read, or the train would test something nobody asked for
  for (const [branch, sha, what] of [
    [action.headBranch, action.head, `the head #${action.headPr}`],
    [action.branch, action.rider, `PR #${action.pr}`],
  ] as const) {
    const tip = await tipOf(ctx, branch)
    if ('fail' in tip) return tip.fail
    if ('gone' in tip) return dropped('head-moved', `${what}'s branch ${branch} is gone`)
    if (tip.sha !== sha) return dropped('head-moved', `${what} is at ${tip.sha.slice(0, 7)}, not ${sha.slice(0, 7)}`)
  }
  const mt = await run(ctx, ARGV.mergeTreeArgv(action.head, action.rider), GIT_MS)
  if (!mt.ok) return mt.exec
  if (mt.r.exitCode === 1) return dropped('conflict', `merging ${action.rider.slice(0, 7)} onto ${action.head.slice(0, 7)} conflicts`)
  const tree = mt.r.stdout.split('\n')[0]?.trim() ?? ''
  if (mt.r.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(tree)) return commandFailure(ARGV.mergeTreeArgv(action.head, action.rider), mt.r)
  const message = `factory train: PR #${action.pr} on #${action.headPr}\n\nTests #${action.pr} (${action.rider.slice(0, 7)}) on the updated head of #${action.headPr} (${action.head.slice(0, 7)}) and main ${action.main.slice(0, 7)}. Deleted by the loop once used or dropped.`
  const ct = await run(ctx, ARGV.commitTreeArgv(tree, action.head, action.rider, message), GIT_MS, COMMIT_ENV)
  if (!ct.ok) return ct.exec
  const sha = ct.r.stdout.trim()
  if (ct.r.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return commandFailure(ARGV.commitTreeArgv(tree, action.head, action.rider, '...'), ct.r)
  const branch = `${TRAIN_PREFIX}i${action.issue ?? 0}-${tree.slice(0, 7)}`
  const push = await run(ctx, ARGV.pushTrainArgv(sha, branch), PUSH_MS)
  if (!push.ok) return push.exec
  if (push.r.exitCode !== 0) return commandFailure(ARGV.pushTrainArgv(sha, branch), push.r)
  return done({ ...base, tree, train: sha, branch, drop: null }, `PR #${action.pr}: train ${sha.slice(0, 7)} pushed as ${branch}, tree ${tree.slice(0, 7)}`)
}

// removeBranches: deletes train branches from origin; a branch already gone is not a failure.
async function removeBranches(ctx: ExecCtx, branches: readonly string[]): Promise<Exec | null> {
  for (let i = 0; i < branches.length; i += DELETE_CHUNK) {
    const argv = ARGV.deleteTrainArgv(branches.slice(i, i + DELETE_CHUNK))
    const r = await run(ctx, argv, PUSH_MS)
    if (!r.ok) return r.exec
    if (r.r.exitCode !== 0 && !/remote ref does not exist|unable to delete .*does not exist/i.test(`${r.r.stderr}\n${r.r.stdout}`)) return commandFailure(argv, r.r)
  }
  return null
}

const remove: Executor = async (ctx, action) => {
  if (action.kind !== 'queue-train' || action.op !== 'delete') return refused(`the queue-train delete executor got a ${action.kind} action`)
  if (!action.branch.startsWith(TRAIN_PREFIX)) return refused(`${action.branch} is not a train branch`)
  const failed = await removeBranches(ctx, [action.branch])
  if (failed !== null) return failed
  return done({ kind: 'train', op: 'delete', branch: action.branch, end: action.end }, `deleted ${action.branch} (${action.end})`)
}

const sweep: Executor = async (ctx, action) => {
  if (action.kind !== 'queue-train' || action.op !== 'sweep') return refused(`the queue-train sweep executor got a ${action.kind} action`)
  const ls = await run(ctx, ARGV.lsTrainArgv(TRAIN_PREFIX), GIT_MS)
  if (!ls.ok) return ls.exec
  if (ls.r.exitCode !== 0) return commandFailure(ARGV.lsTrainArgv(TRAIN_PREFIX), ls.r)
  const found = ls.r.stdout
    .split('\n')
    .map(l => /^[0-9a-f]+\s+refs\/heads\/(\S+)$/.exec(l.trim())?.[1])
    .filter((b): b is string => b !== undefined && b.startsWith(TRAIN_PREFIX))
  const stale = found.filter(b => !action.keep.includes(b))
  const failed = stale.length === 0 ? null : await removeBranches(ctx, stale)
  if (failed !== null) return failed
  return done({ kind: 'train', op: 'sweep', removed: stale, kept: action.keep }, stale.length === 0 ? 'no stale train branch on origin' : `removed ${stale.length} stale train branches: ${stale.join(', ')}`)
}

// The one executor of the kind: its op picks the path.
const train: Executor = async (ctx, action) => {
  if (action.kind !== 'queue-train') return refused(`the queue-train executor got a ${action.kind} action`)
  const a: TrainAction = action
  return a.op === 'build' ? build(ctx, a) : a.op === 'delete' ? remove(ctx, a) : sweep(ctx, a)
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'queue-train': train }

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 3)}...` : t
}
