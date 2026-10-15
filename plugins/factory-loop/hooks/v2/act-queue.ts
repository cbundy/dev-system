// The merge queue's executors (docs/factory-loop/v2/SPEC.md 9.2, 9.3, appendix B), one try per key:
// - `queue-update` runs `gh pr update-branch <p> --repo R`: GitHub merges main into the head's
//   branch, rewriting no history. It applies the update in the background, so the executor reads
//   the PR's head until it moves (30 s) and records the new head, a head the loop produced (4.1).
//   A refusal for a conflict is an answer, not a fault: done, with no head and class conflict
//   (the step's not-ok). A head that did not move, or any other failure, fails with no class
//   (unknown). An update GitHub finds needless (already up to date) is done at the head as read.
// - `queue-merge` runs `callum-flow-merge <p> --patch <approved patch>`: the guard inside it checks
//   only the loop's facts, and the merge matches the head the guard verified. Merged is done. A
//   refusal with a class is the guard's answer, so it is done too, not merged, with the guard's
//   FAIL lines and their class (9.3; of several, the one whose outcome decides most), or the class
//   a refusal's merge state names. A merge cut off, or refused with no reason, is read back from
//   the PR, so one that merged anyway is done: the loop's own merge, never taken for a hand merge;
//   one that did not fails with no class.
// Only a failure with no class is `failed`, so the foundation's executor breaker counts broken
// commands, never the queue's ordinary refusals (9.1: the queue moves on).
// Executors decide nothing: plan did.
import { commandFailure, NO_EXIT } from '../act-cli'
import { detailOf, rateLimited } from '../exec'
import type { Exec, ExecCtx, Executor, RunResult } from '../exec'
import type { ActionKind } from '../types'
import * as ARGV from './argv'
import { pullOf } from './sources-prs'
import type { Pull } from './sources-prs'
import { GUARD_CLASSES } from './types'
import type { GuardClass, V2Outcome } from './types'

const SEC = 1000
const UPDATE_MS = 60 * SEC
const READ_MS = 60 * SEC
// the guard reads the PR, its checks, linkage and Rollout and fetches for the patch id; the merge
// itself, its event and the milestone follow
const MERGE_MS = 10 * 60 * SEC
// how long GitHub's background update may take to move the head (9.2), read every POLL_S seconds
const MOVE_MS = 30 * SEC
const POLL_S = 2
const PAUSE_MS = 10 * SEC
const SUMMARY_MAX = 200
const LINE_MAX = 500
const LINES_MAX = 20

// The order a merge's FAIL classes decide in when the guard prints several: what only the owner can
// change, then what sends the PR back (a changed patch to review, a conflict to a fixer), then what
// the queue does itself (the body, an update, the checks), and a fact not read last.
const CLASS_ORDER: readonly GuardClass[] = ['policy', 'patch', 'conflict', 'linkage', 'behind', 'checks', 'read']

type Run = { ok: true; r: RunResult } | { ok: false; exec: Exec }

// run: one command through ctx.cmd; a throw (it could not start, or outlived its timeout) is a
// failed attempt.
async function run(ctx: ExecCtx, argv: string[], timeoutMs: number): Promise<Run> {
  try {
    return { ok: true, r: await ctx.cmd(argv, { timeoutMs }) }
  } catch (err) {
    return { ok: false, exec: { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${message(err)}`) } }
  }
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function outcome(op: 'update' | 'merge', head: string | null, failClass: GuardClass | null, lines: string[], merged = false): V2Outcome {
  return { kind: 'queue', op, merged, head, failClass, lines }
}

// linesOf: a command's output, as the outcome keeps it: its non-empty lines, each and in all capped.
export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(0, LINES_MAX)
    .map(l => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 3)}...` : l))
}

// failLines: every FAIL line of the guard in a command's output, whole and uncapped.
export function failLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^GUARD \S+ FAIL /.test(l))
}

// failClassOf: the class of the guard's FAIL lines (9.4, `GUARD <name> FAIL <reason> class=<c>`),
// the first of CLASS_ORDER among them; null when no line carries a class.
export function failClassOf(lines: readonly string[]): GuardClass | null {
  const found = new Set<GuardClass>()
  for (const line of lines) {
    const m = /^GUARD \S+ FAIL .* class=([a-z]+)$/.exec(line)
    const cls = GUARD_CLASSES.find(c => c === m?.[1])
    if (cls !== undefined) found.add(cls)
  }
  return CLASS_ORDER.find(c => found.has(c)) ?? null
}

// refusalClass: what callum-flow-merge says of a merge GitHub refused after the guard passed: the
// merge state it read back (BEHIND goes back to Q1, DIRTY to a fixer); null for any other.
export function refusalClass(stderr: string): GuardClass | null {
  const state = /merge state ([A-Z_]+)/.exec(stderr)?.[1]
  return state === 'BEHIND' ? 'behind' : state === 'DIRTY' ? 'conflict' : null
}

// --- queue-update (9.2) -----------------------------------------------------------------------------------

async function readPull(ctx: ExecCtx, pr: number): Promise<Pull | string> {
  const r = await run(ctx, ARGV.prReadArgv(pr), READ_MS)
  if (!r.ok) return r.exec.summary
  if (r.r.exitCode !== 0) return `the PR read exited ${r.r.exitCode}`
  return pullOf(r.r.stdout) ?? 'the PR read does not parse'
}

// headMoved: the PR's head once it is not `from`, read every POLL_S seconds for MOVE_MS (and no
// more reads than that allows, whatever the clock says); null with the last reason when it did
// not move.
async function headMoved(ctx: ExecCtx, pr: number, from: string): Promise<{ head: string | null; why: string }> {
  const start = await ctx.io.now()
  let why = 'the head did not move'
  for (let reads = 0; reads <= MOVE_MS / (POLL_S * SEC); reads++) {
    const pull = await readPull(ctx, pr)
    if (typeof pull === 'string') why = pull
    else if (pull.head !== null && pull.head !== from) return { head: pull.head, why: '' }
    else why = 'the head did not move'
    if ((await ctx.io.now()) - start >= MOVE_MS) break
    await run(ctx, ARGV.pollPauseArgv(POLL_S), PAUSE_MS)
  }
  return { head: null, why }
}

const update: Executor = async (ctx, action) => {
  if (action.kind !== 'queue-update') return refused(`the queue-update executor got a ${action.kind} action`)
  const argv = ARGV.updateBranchArgv(ctx.rt.repo, action.pr)
  const r = await run(ctx, argv, UPDATE_MS)
  if (!r.ok) return r.exec
  const said = `${r.r.stdout}\n${r.r.stderr}`
  if (r.r.exitCode !== 0) {
    if (!/conflict/i.test(said)) return commandFailure(argv, r.r)
    return { status: 'done', outcome: outcome('update', null, 'conflict', linesOf(detailOf(r.r))), summary: clip(`PR #${action.pr}: the update onto ${short(action.base)} conflicts`) }
  }
  if (/up.to.date/i.test(said)) return { status: 'done', outcome: outcome('update', action.head, null, linesOf(said)), summary: clip(`PR #${action.pr} is up to date at ${short(action.head)}`) }
  const moved = await headMoved(ctx, action.pr, action.head)
  if (moved.head === null) {
    return { status: 'failed', outcome: outcome('update', null, null, [moved.why]), summary: clip(`PR #${action.pr}: updated, but its head did not move from ${short(action.head)} in ${MOVE_MS / SEC} s: ${moved.why}`) }
  }
  return { status: 'done', outcome: outcome('update', moved.head, null, linesOf(said)), summary: clip(`PR #${action.pr} updated onto ${short(action.base)}: ${short(action.head)} -> ${short(moved.head)}`) }
}

// --- queue-merge (9.3) -------------------------------------------------------------------------------------

const merge: Executor = async (ctx, action) => {
  if (action.kind !== 'queue-merge') return refused(`the queue-merge executor got a ${action.kind} action`)
  const argv = ARGV.queueMergeArgv(action.pr, action.patch)
  const r = await run(ctx, argv, MERGE_MS)
  if (r.ok && r.r.exitCode === 0) {
    return { status: 'done', outcome: outcome('merge', action.head, null, linesOf(`${r.r.stdout}\n${r.r.stderr}`), true), summary: clip(`PR #${action.pr} merged at ${short(action.head)}`) }
  }
  // exit 2: a usage error (a guard without --patch), never a fact of the PR
  if (r.ok && r.r.exitCode === 2) return { ...commandFailure(argv, r.r), noRetry: true }
  // the class is read from every FAIL line, whole, before the outcome caps what it keeps
  const fails = r.ok ? failLines(r.r.stdout) : []
  const cls = failClassOf(fails) ?? (r.ok ? refusalClass(r.r.stderr) : null)
  const detail = r.ok ? detailOf(r.r) : r.exec.summary
  const kept = fails.length > 0 ? linesOf(fails.join('\n')) : linesOf(detail).slice(-3)
  const summary = clip(`PR #${action.pr} not merged at ${short(action.head)}${cls === null ? '' : ` (${cls})`}: ${kept[0] ?? 'no reason given'}`)
  // a refusal with a class is the guard's answer: done, not merged
  if (cls !== null) return { status: 'done', outcome: outcome('merge', action.head, cls, kept), summary }
  // cut off, or refused with no reason: whether it merged anyway is the PR's to say
  const pull = await readPull(ctx, action.pr)
  if (typeof pull !== 'string' && pull.state === 'merged' && pull.mergedHead === action.head) {
    return { status: 'done', outcome: outcome('merge', action.head, null, ['merged, as the PR reads back'], true), summary: clip(`PR #${action.pr} merged at ${short(action.head)} (read back)`) }
  }
  const exec: Extract<Exec, { status: 'failed' }> = { status: 'failed', outcome: outcome('merge', action.head, null, kept), summary }
  if (r.ok && rateLimited(r.r.stderr)) exec.rateLimited = true
  return exec
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'queue-update': update, 'queue-merge': merge }

function short(sha: string): string {
  return sha.slice(0, 7)
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 3)}...` : t
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
