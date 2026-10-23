// The `split` executor (docs/factory-loop/v2/SPEC.md 8.7, appendix B): one child of a designer's
// split per action, every write of it idempotent, so a retry never makes a second child or a second
// link (the designer is a reader, and a retried v1 designer made duplicate sub-issues):
// 1. the child is found again by the hidden key in its body (<!-- factory-loop:<ledger key> -->,
//    among the open issues by trusted authors), or created with it;
// 2. it is linked under its parent as a sub-issue, unless the parent's sub-issues hold it already;
// 3. it is linked as blocked by each issue plan named (a sibling, or an existing issue of the repo),
//    unless already; a blocker that is closed is skipped (nothing to wait for), one that is a pull
//    request is refused;
// 4. it is labelled ready when the designer asked, once every link exists, so S1 claims it only
//    when its blockers are closed. A not-ready child gets no label here: plan claims it (rules-work.ts
//    parkClaim) and the claim parks it on its open decision.
// The outcome names the child, which the parent's release follow-up lists (rules-entry.ts).
// Executors decide nothing: plan did.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, ExecCtx, Executor, RunResult } from '../exec'
import { neutral } from '../prompts'
import type { Action, ActionKind } from '../types'
import { hiddenKey } from './act-state'
import * as ARGV from './argv'
import { neutralBody } from './prompts-work'

const SEC = 1000
const GH_MS = 60 * SEC
const LIST_MS = 120 * SEC
const SUMMARY_MAX = 200
const TITLE_MAX = 120

type SplitAction = Extract<Action, { kind: 'split' }>

// --- text and reads ---------------------------------------------------------------------------------

// childTitle: one line within 120 characters, closing keywords rewritten.
export function childTitle(title: string): string {
  const t = neutral(title).split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3)}...` : t
}

// childBody: the child's body, made safe (prompts-work.ts neutralBody), its parent named without a
// closing keyword, and its hidden key last.
export function childBody(body: string, parent: number, key: string): string {
  return `${neutralBody(body)}\n\nPart of #${parent}, split by the factory loop.\n\n${hiddenKey(key)}\n`
}

// foundChild: the open issue whose body carries the key, from `callum-flow-issue-read --json --list`:
// its number and REST id; null when none does; undefined when the list is not in its shape.
export function foundChild(json: string, key: string): { number: number; id: number } | null | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return undefined
  }
  const issues = doc !== null && typeof doc === 'object' ? (doc as { issues?: unknown }).issues : undefined
  if (!Array.isArray(issues)) return undefined
  const marker = hiddenKey(key)
  for (const raw of issues) {
    const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof o.body === 'string' && o.body.includes(marker) && typeof o.number === 'number' && typeof o.id === 'number') return { number: o.number, id: o.id }
  }
  return null
}

// issueId: the REST id of `callum-flow-issue-read --json <n>`, or null.
export function issueId(json: string): number | null {
  try {
    const issue = (JSON.parse(json) as { issue?: { id?: unknown } }).issue
    return typeof issue?.id === 'number' && Number.isInteger(issue.id) && issue.id > 0 ? issue.id : null
  } catch {
    return null
  }
}

// blockerOf: what `callum-flow-issue-read --json <n>` says of an issue: its REST id, whether it is
// open, and whether it is a pull request; null when it is not in that shape.
export function blockerOf(json: string): { id: number; open: boolean; pr: boolean } | null {
  try {
    const issue = (JSON.parse(json) as { issue?: { id?: unknown; state?: unknown; pull_request?: unknown } }).issue
    if (typeof issue?.id !== 'number' || !Number.isInteger(issue.id) || issue.id <= 0) return null
    if (issue.state !== 'open' && issue.state !== 'closed') return null
    return { id: issue.id, open: issue.state === 'open', pr: issue.pull_request !== undefined && issue.pull_request !== null }
  } catch {
    return null
  }
}

// createdIssue: the issue number in `gh issue create`'s output (its URL), or null.
export function createdIssue(stdout: string, repo: string): number | null {
  const m = new RegExp(`https://github\\.com/${repo.replace(/[.]/g, '\\.')}/issues/(\\d+)`, 'i').exec(stdout)
  return m?.[1] === undefined ? null : Number(m[1])
}

// ids: the ids `gh api ... --jq '.[].id'` printed, one a line; null when a line is not one.
export function ids(stdout: string): number[] | null {
  const out: number[] = []
  for (const line of stdout.split('\n').map(l => l.trim()).filter(l => l !== '')) {
    if (!/^\d+$/.test(line)) return null
    out.push(Number(line))
  }
  return out
}

// --- commands ---------------------------------------------------------------------------------------------

type Run = { ok: true; r: RunResult } | { ok: false; exec: Exec }

async function run(ctx: ExecCtx, argv: string[], stdin?: string, timeoutMs = GH_MS, env?: Record<string, string>): Promise<Run> {
  try {
    return { ok: true, r: await ctx.cmd(argv, { timeoutMs, ...(stdin === undefined ? {} : { stdin }), ...(env === undefined ? {} : { env }) }) }
  } catch (err) {
    return { ok: false, exec: { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${message(err)}`) } }
  }
}

// ok: a command that must exit 0; its stdout, or the failed attempt.
export async function ok(ctx: ExecCtx, argv: string[], stdin?: string, timeoutMs = GH_MS, env?: Record<string, string>): Promise<{ out: string } | { exec: Exec }> {
  const ran = await run(ctx, argv, stdin, timeoutMs, env)
  if (!ran.ok) return { exec: ran.exec }
  return ran.r.exitCode === 0 ? { out: ran.r.stdout } : { exec: commandFailure(argv, ran.r) }
}

export function failed(summary: string, detail: string): Exec {
  return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail: detail.slice(0, 2000) }, summary: clip(summary) }
}

export function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

// idOf: an issue's REST id, through the reader.
export async function idOf(ctx: ExecCtx, issue: number): Promise<{ id: number } | { exec: Exec }> {
  const r = await ok(ctx, ARGV.issueReadArgv(issue))
  if ('exec' in r) return r
  const id = issueId(r.out)
  return id === null ? { exec: failed(`the id of #${issue} did not read`, r.out) } : { id }
}

// blockerIdOf: a blocker's REST id when it is open; null when it is closed (no link to make); a
// pull request is refused, since only an issue can block.
async function blockerIdOf(ctx: ExecCtx, issue: number): Promise<{ id: number | null } | { exec: Exec }> {
  const r = await ok(ctx, ARGV.issueReadArgv(issue))
  if ('exec' in r) return r
  const b = blockerOf(r.out)
  if (b === null) return { exec: failed(`the state of #${issue} did not read`, r.out) }
  if (b.pr) return { exec: refused(`#${issue} is a pull request, not an issue`) }
  return { id: b.open ? b.id : null }
}

// childOf: the child, found by its hidden key or created.
async function childOf(ctx: ExecCtx, a: SplitAction): Promise<{ number: number; id: number; made: boolean } | { exec: Exec }> {
  const listed = await ok(ctx, ARGV.openIssuesArgv(), undefined, LIST_MS)
  if ('exec' in listed) return listed
  const found = foundChild(listed.out, a.key)
  if (found === undefined) return { exec: failed('the open issues did not read', listed.out) }
  if (found !== null) return { ...found, made: false }
  const title = childTitle(a.child.title)
  if (title === '') return { exec: refused(`${a.key}: the child has no title`) }
  const created = await ok(ctx, ARGV.issueCreateArgv(ctx.rt.repo, title), childBody(a.child.body, a.parent, a.key))
  if ('exec' in created) return created
  const number = createdIssue(created.out, ctx.rt.repo)
  if (number === null) return { exec: failed(`gh issue create printed no issue of ${ctx.rt.repo}`, created.out) }
  const id = await idOf(ctx, number)
  return 'exec' in id ? id : { number, id: id.id, made: true }
}

// linked: a POST link made unless the read of existing links already holds the id.
export async function linked(ctx: ExecCtx, read: string[], id: number, post: string[]): Promise<{ added: boolean } | { exec: Exec }> {
  const held = await ok(ctx, read)
  if ('exec' in held) return held
  const have = ids(held.out)
  if (have === null) return { exec: failed(`${read.slice(0, 3).join(' ')} did not read`, held.out) }
  if (have.includes(id)) return { added: false }
  const r = await ok(ctx, post)
  return 'exec' in r ? r : { added: true }
}

const split: Executor = async (ctx, action) => {
  if (action.kind !== 'split') return refused(`the split executor got a ${action.kind} action`)
  const repo = ctx.rt.repo
  const child = await childOf(ctx, action)
  if ('exec' in child) return child.exec
  const sub = await linked(ctx, ARGV.subIssuesReadArgv(repo, action.parent), child.id, ARGV.subIssueArgv(repo, action.parent, child.id))
  if ('exec' in sub) return sub.exec
  const skipped: number[] = []
  for (const blocker of action.blockedBy) {
    const id = await blockerIdOf(ctx, blocker)
    if ('exec' in id) return id.exec
    if (id.id === null) {
      skipped.push(blocker)
      continue
    }
    const link = await linked(ctx, ARGV.blockersReadArgv(repo, child.number), id.id, ARGV.blockedByArgv(repo, child.number, id.id))
    if ('exec' in link) return link.exec
  }
  if (action.child.ready) {
    const label = await ok(ctx, ARGV.childReadyArgv(repo, child.number, ctx.rt.config.readyLabel))
    if ('exec' in label) return label.exec
  }
  const how = child.made ? 'made' : 'found'
  const linkedTo = action.blockedBy.filter(n => !skipped.includes(n))
  const after = (linkedTo.length === 0 ? '' : `, blocked by ${linkedTo.map(n => `#${n}`).join(' ')}`) + skipped.map(n => `, #${n} is closed, not linked`).join('')
  return { status: 'done', outcome: { kind: 'split', child: child.number }, summary: clip(`${how} #${child.number} under #${action.parent}${after}${action.child.ready ? ', ready' : ', parks on the owner'}`) }
}

// link: a waiting record's issue linked as blocked by one it waits on (row T16's entry action):
// the same idempotent link as a split child's, so a retry never makes a second. A closed blocker is
// skipped (nothing to wait for), and a pull request is no blocker, so a wait on one is no link
// (the wait itself still holds); both end the action done.
const link: Executor = async (ctx, action) => {
  if (action.kind !== 'link') return refused(`the link executor got a ${action.kind} action`)
  if (action.issue === null) return refused('the link action names no issue')
  const repo = ctx.rt.repo
  const blocker = await blockerIdOf(ctx, action.blocker)
  if ('exec' in blocker) {
    // a pull request is no blocker: the wait holds without a link
    if (blocker.exec.noRetry === true && /pull request/.test(blocker.exec.summary ?? '')) return { status: 'done', summary: clip(`#${action.blocker} is a pull request, not linked`) }
    return blocker.exec
  }
  if (blocker.id === null) return { status: 'done', summary: clip(`#${action.blocker} is closed, not linked`) }
  const made = await linked(ctx, ARGV.blockersReadArgv(repo, action.issue), blocker.id, ARGV.blockedByArgv(repo, action.issue, blocker.id))
  if ('exec' in made) return made.exec
  return { status: 'done', summary: clip(`${made.added ? 'linked' : 'found linked'} #${action.issue} as blocked by #${action.blocker}`) }
}

export const executors: Partial<Record<ActionKind, Executor>> = { split, link }

export function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
