// The `pr` executor (docs/factory-loop/v2/SPEC.md 3.5, 8.1, 9.3, appendix B). One branch and one PR
// per issue for life, written only by the loop:
// - op ensure, the reviewing step's first part: list the branch's PRs (every state), use an open
//   one, reopen a closed unmerged one, or create one; then write the loop's body when the PR's
//   differs from it, so an adopted PR's linkage is the loop's own. Open PRs come before closed
//   ones, the one plan named first within each. A reopen GitHub refuses (the head branch was
//   deleted or recreated, or another PR is open on the same head and base) moves on to the next
//   PR, then to a new one, so a PR that cannot be reopened never stalls the record. A re-run finds
//   the PR it made, so it never makes a second (totality/T-04).
// - op body: the loop's body written again, after a linkage FAIL at the merge (9.3).
// The body follows the issue's Rollout (`callum-flow-rollout`): `Closes #N` for merge, `Refs #N`
// for run-it and keep-open. Every free-text part goes through neutral() (prompts.ts), which caps it
// and rewrites closing keywords (D-56), so only the loop's own line links an issue. A PR is used
// only when it is by a trusted author (callum-flow-issue-read refuses another with exit 3) and its
// head is the record's branch in this repo. Executors decide nothing: plan did.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, ExecCtx, Executor, RunResult } from '../exec'
import { neutral } from '../prompts'
import type { Action, ActionKind } from '../types'
import * as ARGV from './argv'

const SEC = 1000
const GH_MS = 60 * SEC
const SUMMARY_MAX = 200
const TITLE_MAX = 72
const BRANCH = /^[A-Za-z0-9._/-]+$/
const BRIEF_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+#issuecomment-\d+$/

type PrAction = Extract<Action, { kind: 'pr' }>
export type Linkage = 'Closes' | 'Refs'

// --- the body (8.1) ------------------------------------------------------------------------------------

// footer: the body's last line, by which the loop knows a body as its own.
export function footer(issue: number): string {
  return `Opened by the factory loop for #${issue}.`
}

// prTitle: the builder's title as one line within 72 characters, closing keywords rewritten; the
// issue's number when it gave none.
export function prTitle(title: string, issue: number): string {
  const line = neutral(title).split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  const t = line === '' ? `Work on #${issue}` : line
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3)}...` : t
}

export type BodyInput = { issue: number; summary: string; linkage: Linkage; brief: string | null; evidence: string | null }

// prBody: the loop's own body: the summary, the one linkage line, the brief, the evidence, and the
// footer.
export function prBody(b: BodyInput): string {
  const summary = neutral(b.summary)
  const evidence = b.evidence === null ? '' : neutral(b.evidence)
  return [
    ...(summary === '' ? [] : [summary, '']),
    `${b.linkage} #${b.issue}`,
    '',
    ...(b.brief !== null && BRIEF_URL.test(b.brief) ? [`Design brief: ${b.brief}`, ''] : []),
    ...(evidence === '' ? [] : ['## Evidence', evidence, '']),
    footer(b.issue),
  ].join('\n')
}

// bodyWork: the work a body keeps when the action brings none (an adopted PR, which no builder of
// this life described, or a record rebuilt without its build's entry): the loop's own summary and
// evidence of a body it wrote, else the PR's own text as the summary.
export function bodyWork(body: string, issue: number): { summary: string; evidence: string | null } {
  const text = body.replace(/\r\n?/g, '\n').trim()
  if (!text.endsWith(footer(issue))) return { summary: text, evidence: null }
  const m = new RegExp(`^([\\s\\S]*?)(?:^|\\n\\n)(?:Closes|Refs) #${issue}\\n([\\s\\S]*)$`).exec(text.slice(0, -footer(issue).length))
  const evidence = /\n## Evidence\n([\s\S]*)$/.exec(m?.[2] ?? '')?.[1]?.trim() ?? ''
  return { summary: m?.[1]?.trim() ?? '', evidence: evidence === '' ? null : evidence }
}

const same = (a: string, b: string) => a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim()

// rolloutLinkage: the linkage line `callum-flow-rollout`'s answer asks for, or null when it gave no
// Rollout.
export function rolloutLinkage(stdout: string): Linkage | null {
  const line = stdout.split('\n').find(l => l.startsWith('ROLLOUT ')) ?? ''
  const m = /^ROLLOUT (merge|run-it|keep-open) source=\S+$/.exec(line.trim())
  if (m === null) return null
  return m[1] === 'merge' ? 'Closes' : 'Refs'
}

// --- reads ------------------------------------------------------------------------------------------------

export type Listed = { pr: number; state: 'OPEN' | 'CLOSED' | 'MERGED' }

// listedPrs: the branch's PRs of `gh pr list --json number,state,headRefOid`, newest first; null
// when the list does not read.
export function listedPrs(json: string): Listed[] | null {
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const out: Listed[] = []
  for (const raw of list) {
    const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const state = o.state === 'OPEN' || o.state === 'CLOSED' || o.state === 'MERGED' ? o.state : null
    if (typeof o.number === 'number' && Number.isInteger(o.number) && o.number > 0 && state !== null) out.push({ pr: o.number, state })
  }
  return out.sort((a, b) => b.pr - a.pr)
}

export type PrRead = { open: boolean; merged: boolean; body: string; ref: string | null; repo: string | null }

// prRead: the REST pull of `callum-flow-issue-read --json --pr <n>`, or null when not in its shape.
export function prRead(json: string): PrRead | null {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return null
  }
  const pr = doc !== null && typeof doc === 'object' ? (doc as { pr?: unknown }).pr : undefined
  if (pr === null || typeof pr !== 'object') return null
  const o = pr as Record<string, unknown>
  if (o.state !== 'open' && o.state !== 'closed') return null
  const head = o.head !== null && typeof o.head === 'object' ? (o.head as Record<string, unknown>) : {}
  const repo = head.repo !== null && typeof head.repo === 'object' ? (head.repo as Record<string, unknown>).full_name : null
  return { open: o.state === 'open', merged: o.merged === true, body: typeof o.body === 'string' ? o.body : '', ref: typeof head.ref === 'string' ? head.ref : null, repo: typeof repo === 'string' ? repo : null }
}

// createdPr: the PR number in `gh pr create`'s output (its URL), or null.
export function createdPr(stdout: string, repo: string): number | null {
  const m = new RegExp(`https://github\\.com/${repo.replace(/[.]/g, '\\.')}/pull/(\\d+)`, 'i').exec(stdout)
  return m?.[1] === undefined ? null : Number(m[1])
}

// --- commands ---------------------------------------------------------------------------------------------

type Run = { ok: true; r: RunResult } | { ok: false; exec: Exec }

// run: one command through ctx.cmd; a throw (it could not start, or outlived its timeout) is a
// failed attempt.
async function run(ctx: ExecCtx, argv: string[], stdin?: string): Promise<Run> {
  try {
    return { ok: true, r: await ctx.cmd(argv, stdin === undefined ? { timeoutMs: GH_MS } : { timeoutMs: GH_MS, stdin }) }
  } catch (err) {
    return { ok: false, exec: { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${message(err)}`) } }
  }
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

function failed(summary: string, detail?: string): Exec {
  return detail === undefined ? { status: 'failed', summary: clip(summary) } : { status: 'failed', outcome: { kind: 'cli', exit: 0, detail: detail.slice(0, 2000) }, summary: clip(summary) }
}

// linkageOf: the issue's Rollout as the body's linkage line.
async function linkageOf(ctx: ExecCtx, issue: number): Promise<{ linkage: Linkage } | { exec: Exec }> {
  const argv = ARGV.rolloutArgv(issue)
  const ran = await run(ctx, argv)
  if (!ran.ok) return { exec: ran.exec }
  const linkage = ran.r.exitCode === 0 ? rolloutLinkage(ran.r.stdout) : null
  if (linkage === null) return { exec: ran.r.exitCode === 0 ? failed(`callum-flow-rollout ${issue} gave no Rollout`, ran.r.stdout) : commandFailure(argv, ran.r) }
  return { linkage }
}

// readPr: one PR as the reader gives it; null for a PR by an untrusted author (exit 3).
async function readPr(ctx: ExecCtx, pr: number): Promise<{ read: PrRead | null } | { exec: Exec }> {
  const argv = ARGV.prReadArgv(pr)
  const ran = await run(ctx, argv)
  if (!ran.ok) return { exec: ran.exec }
  if (ran.r.exitCode === 3) return { read: null }
  if (ran.r.exitCode !== 0) return { exec: commandFailure(argv, ran.r) }
  const read = prRead(ran.r.stdout)
  return read === null ? { exec: failed(`PR #${pr} did not read`, ran.r.stdout) } : { read }
}

// writeBody: the loop's body over the PR's.
async function writeBody(ctx: ExecCtx, pr: number, body: string): Promise<Exec | null> {
  const argv = ARGV.prBodyArgv(ctx.rt.repo, pr)
  const ran = await run(ctx, argv, body)
  if (!ran.ok) return ran.exec
  return ran.r.exitCode === 0 ? null : commandFailure(argv, ran.r)
}

function done(pr: number, created: boolean, reopened: boolean, summary: string): Exec {
  return { status: 'done', outcome: { kind: 'pr', pr, created, reopened }, summary: clip(summary) }
}

// --- the executor -----------------------------------------------------------------------------------------

// candidates: the branch's PRs that may be used, in order: open ones, then closed unmerged ones,
// the one plan named first within each, then newest first (8.1: an open PR is used; a closed,
// unmerged one is reopened).
export function candidates(listed: readonly Listed[], named: number | null): Listed[] {
  const rank = (l: Listed) => (l.state === 'OPEN' ? 0 : 2) + (l.pr === named ? 0 : 1)
  return listed.filter(x => x.state !== 'MERGED').sort((x, y) => rank(x) - rank(y) || y.pr - x.pr)
}

// A failed command that may pass when tried again: GitHub or the network down, a timeout, a rate
// limit. Any other failure of a reopen is GitHub refusing that PR.
const PASSING = /\bHTTP (?:5\d\d|429)\b|error connecting|timed? ?out|connection (?:reset|refused)|\bEOF\b|rate limit|TLS handshake/i

// refusedReopen: why GitHub refused to reopen the PR, or null when the failure may pass on a retry.
export function refusedReopen(r: RunResult): string | null {
  const text = `${r.stderr}\n${r.stdout}`
  if (PASSING.test(text)) return null
  const line = (r.stderr.trim() || r.stdout.trim()).split('\n').pop()?.trim() ?? ''
  return line === '' ? `exit ${r.exitCode}` : line
}

async function ensure(ctx: ExecCtx, a: PrAction, n: number): Promise<Exec> {
  const listArgv = ARGV.branchPrsArgv(ctx.rt.repo, a.branch)
  const listedRun = await run(ctx, listArgv)
  if (!listedRun.ok) return listedRun.exec
  if (listedRun.r.exitCode !== 0) return commandFailure(listArgv, listedRun.r)
  const listed = listedPrs(listedRun.r.stdout)
  if (listed === null) return failed(`the PRs of ${a.branch} did not read`, listedRun.r.stdout)
  // the linkage is read once, before the first write
  let link: Linkage | null = null
  const linkage = async (): Promise<Linkage | Exec> => {
    if (link !== null) return link
    const got = await linkageOf(ctx, n)
    if ('exec' in got) return got.exec
    link = got.linkage
    return link
  }
  const refusals: string[] = []
  for (const l of candidates(listed, a.pr)) {
    const r = await readPr(ctx, l.pr)
    if ('exec' in r) return r.exec
    if (r.read === null || r.read.merged || r.read.ref !== a.branch || (r.read.repo !== null && r.read.repo.toLowerCase() !== ctx.rt.repo.toLowerCase())) continue
    const lk = await linkage()
    if (typeof lk !== 'string') return lk
    let reopened = false
    if (!r.read.open) {
      const argv = ARGV.prReopenArgv(ctx.rt.repo, l.pr)
      const ran = await run(ctx, argv)
      if (!ran.ok) return ran.exec
      if (ran.r.exitCode !== 0) {
        const why = refusedReopen(ran.r)
        if (why === null) return commandFailure(argv, ran.r)
        refusals.push(`#${l.pr} not reopened: ${why}`)
        continue
      }
      reopened = true
    }
    return used(ctx, a, n, l.pr, r.read, lk, reopened)
  }
  const lk = await linkage()
  if (typeof lk !== 'string') return lk
  const body = prBody({ issue: n, summary: a.summary, linkage: lk, brief: a.brief, evidence: a.evidence })
  const argv = ARGV.prCreateArgv(ctx.rt.repo, a.base, a.branch, prTitle(a.title, n))
  const made = await run(ctx, argv, body)
  if (!made.ok) return made.exec
  if (made.r.exitCode !== 0) return commandFailure(argv, made.r)
  const pr = createdPr(made.r.stdout, ctx.rt.repo)
  if (pr === null) return failed(`gh pr create printed no PR of ${ctx.rt.repo}`, made.r.stdout)
  const tail = refusals.length === 0 ? '' : `; ${refusals.join('; ')}`
  return done(pr, true, false, `opened PR #${pr} for #${n} on ${a.branch} (${lk} #${n})${tail}`)
}

// used: an open or reopened PR made the loop's: its body written when it differs.
async function used(ctx: ExecCtx, a: PrAction, n: number, pr: number, read: PrRead, linkage: Linkage, reopened: boolean): Promise<Exec> {
  const work = a.summary.trim() === '' ? bodyWork(read.body, n) : a
  const body = prBody({ issue: n, summary: work.summary, linkage, brief: a.brief, evidence: work.evidence })
  const how = reopened ? 'reopened' : 'uses'
  if (same(read.body, body)) return done(pr, false, reopened, `${how} PR #${pr} for #${n}; its body is the loop's`)
  const wrote = await writeBody(ctx, pr, body)
  if (wrote !== null) return wrote
  return done(pr, false, reopened, `${how} PR #${pr} for #${n}; the loop's body written (${linkage} #${n})`)
}

// body: the loop's body written again over the PR's (a linkage FAIL at the merge, 9.3).
async function rewrite(ctx: ExecCtx, a: PrAction, n: number): Promise<Exec> {
  if (a.pr === null) return refused(`${a.key}: a body rewrite names no PR`)
  const link = await linkageOf(ctx, n)
  if ('exec' in link) return link.exec
  let work: { summary: string; evidence: string | null } = a
  if (a.summary.trim() === '') {
    const r = await readPr(ctx, a.pr)
    if ('exec' in r) return r.exec
    if (r.read === null) return refused(`PR #${a.pr} is by an untrusted author`)
    work = bodyWork(r.read.body, n)
  }
  const wrote = await writeBody(ctx, a.pr, prBody({ issue: n, summary: work.summary, linkage: link.linkage, brief: a.brief, evidence: work.evidence }))
  if (wrote !== null) return wrote
  return done(a.pr, false, false, `the loop's body written on PR #${a.pr} (${link.linkage} #${n})`)
}

const pr: Executor = async (ctx, action) => {
  if (action.kind !== 'pr') return refused(`the pr executor got a ${action.kind} action`)
  if (action.issue === null) return refused(`${action.key} names no issue`)
  if (!BRANCH.test(action.branch) || !BRANCH.test(action.base)) return refused(`${action.key}: the branch or the base is not a branch name`)
  return action.op === 'ensure' ? ensure(ctx, action, action.issue) : rewrite(ctx, action, action.issue)
}

export const executors: Partial<Record<ActionKind, Executor>> = { pr }

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
