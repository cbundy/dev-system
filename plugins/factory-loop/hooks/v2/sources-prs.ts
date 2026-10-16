// The `prs` source (docs/factory-loop/v2/SPEC.md 2.4): for each record in reviewing or the merge
// queue whose life has a PR (rules-review.ts lifePr: the record's, else the one the life's done
// ensure named, 8.1, so a PR the ensure just opened is read on the next pass), the PR
// (callum-flow-issue-read --json --pr <n>: state, merged, merged head, closedAt, head,
// mergeable_state, author), its check runs (gh pr checks <n> --repo R --json
// name,state,bucket,startedAt,completedAt,link, the run id from the link) and, when the head moved,
// its patch id (8.4: callum-flow-patch-id <head> <default branch>, kept per head, so it is computed
// once); main's head on origin when a merge-queue PR shows behind, for Q1's key (9.2); and the time
// observe first saw each head (heads:<repo>), whose entries go when their PR closes or its record
// does. Reads go in 2.4's order, the queue's head first, then the other records in reviewing and
// the merge queue, for at most ctx.prBudget records (K, a budget of its own; none during a GitHub
// backoff), and stop at a rate limit met this pass (ctx.limited). A PR whose read fails in any
// part (the PR, its checks, its patch id) is left out and listed in `unread` with why (and whether
// the reader refused it for an untrusted author, exit 3): only its own record waits on it, never
// the others, so the source fails only when `cut` says why reads stopped before every record was
// read. The rules read a missing PR as not read, never as a fact, except an untrusted author's,
// which is one (9.3, policy).
import type { RunResult } from '../exec'
import type { LedgerEntry, Ms, Source } from '../types'
import { lsRemoteArgv, patchIdArgv, prChecksArgv, prReadArgv } from './argv'
import type { SourceCtx } from './observe'
import { queueOf } from './rules-queue'
import { lifePr } from './rules-review'
import type { HeadSeen, IssueRecord } from './types'

export type CheckRun = {
  name: string
  state: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  startedAt: number | null
  completedAt: number | null
  runId: string | null
  link: string | null
}

export type PrView = {
  pr: number
  issue: number
  state: 'open' | 'closed' | 'merged'
  head: string | null
  mergedHead: string | null
  closedAt: string | null
  mergeable: string | null
  author: string | null
  checks: CheckRun[]
  patch: string | null
  readAt: number
}

// A PR whose read was tried this pass and failed: why, and whether the reader refused it because
// its author is not trusted (callum-flow-issue-read exit 3).
export type PrUnread = { pr: number; issue: number; why: string; untrusted: boolean }

// main: the default branch and its head on origin, read when a merge-queue PR shows behind (sha
// null when that read failed); absent when nothing needed it. unread: the PRs tried that did not
// read. cut: why the reads stopped before every record's PR was tried (a GitHub rate limit, or no
// budget during a backoff); absent when none was left untried.
export type PrsRead = { prs: PrView[]; main?: { branch: string; sha: string | null } | null; unread?: PrUnread[]; cut?: string }

export const EMPTY_PRS: PrsRead = { prs: [] }

const READ_MS = 60_000
// a patch id fetches the head and main first
const PATCH_MS = 120_000

// --- parsing what the CLIs print ----------------------------------------------------------------------

// The REST pull object as callum-flow-issue-read --json --pr prints it ({ pr, stripped }), read
// for what the loop needs; null when it does not read.
export type Pull = { state: PrView['state']; head: string | null; mergedHead: string | null; closedAt: string | null; mergeable: string | null; author: string | null; base: string | null }

export function pullOf(json: string): Pull | null {
  let o: Record<string, unknown>
  try {
    const top = JSON.parse(json) as Record<string, unknown> | null
    const pr = top?.pr
    if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) return null
    o = pr as Record<string, unknown>
  } catch {
    return null
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const sub = (v: unknown, k: string): unknown => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined)
  if (o.state !== 'open' && o.state !== 'closed') return null
  const head = str(sub(o.head, 'sha'))
  const merged = o.merged === true || str(o.merged_at) !== null
  return {
    state: merged ? 'merged' : o.state,
    head,
    mergedHead: merged ? head : null,
    closedAt: str(o.closed_at),
    mergeable: str(o.mergeable_state)?.toLowerCase() ?? null,
    author: str(sub(o.user, 'login')),
    base: str(sub(o.base, 'ref')),
  }
}

const BUCKETS: readonly CheckRun['bucket'][] = ['pass', 'fail', 'pending', 'skipping', 'cancel']

// timeOf: a check's start or end; GitHub gives the zero time for one not started or not done.
function timeOf(v: unknown): Ms | null {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(t) && t > 0 ? t : null
}

// checksOf: the head's check runs from `gh pr checks --json`, which exits 8 while one is pending
// and 1 when one failed, so the output decides, not the exit; a head with no check yet is an
// empty list. null when it does not read.
export function checksOf(r: RunResult): CheckRun[] | null {
  let list: unknown
  try {
    list = JSON.parse(r.stdout)
  } catch {
    return /no checks reported/i.test(`${r.stderr}\n${r.stdout}`) ? [] : null
  }
  if (!Array.isArray(list)) return null
  const out: CheckRun[] = []
  for (const raw of list) {
    const c = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof c.name !== 'string') return null
    const link = typeof c.link === 'string' && c.link !== '' ? c.link : null
    out.push({
      name: c.name,
      state: typeof c.state === 'string' ? c.state : '',
      // a bucket gh does not name waits, bounded like any pending check
      bucket: BUCKETS.find(b => b === c.bucket) ?? 'pending',
      startedAt: timeOf(c.startedAt),
      completedAt: timeOf(c.completedAt),
      runId: /\/actions\/runs\/(\d+)/.exec(link ?? '')?.[1] ?? null,
      link,
    })
  }
  return out
}

// shaOf: the head `git ls-remote origin refs/heads/<branch>` prints, or null.
export function shaOf(stdout: string, branch: string): string | null {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/heads/${branch}` && sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) return sha
  }
  return null
}

// --- one pass's reads ----------------------------------------------------------------------------------

// The patch ids computed, by repo, base and head: a head's patch id is fixed once its merge base
// is, so it is computed when the head moves and kept while the head is.
const PATCHES = new Map<string, string>()

// prRecords: the records whose PR the source reads, each with its life's PR (lifePr), in 2.4's
// order: the queue's head, then the other records in reviewing and the merge queue, oldest seq
// first.
export function prRecords(records: readonly IssueRecord[], paused: readonly number[], ledger: readonly LedgerEntry[]): (IssueRecord & { pr: number })[] {
  const head = queueOf(records, paused)[0]
  const rank = (r: IssueRecord) => (r === head ? 0 : 1)
  return records
    .filter(r => r.state === 'reviewing' || r.state === 'merge-queue')
    .sort((a, b) => rank(a) - rank(b) || a.seqAt - b.seqAt || a.issue - b.issue)
    .flatMap(r => {
      const pr = lifePr(ledger, r)
      return pr === null ? [] : [{ ...r, pr }]
    })
}

// readPrs: the PRs of the records that have one, main's head when a merge-queue PR is behind, and
// the heads first seen, updated.
export async function readPrs(ctx: SourceCtx): Promise<{ read: PrsRead; source: Source; heads: Record<string, HeadSeen> }> {
  const now = ctx.now
  const want = prRecords(ctx.records, ctx.state.control.paused, ctx.state.ledger)
  const checkout = ctx.state.checkout
  const defaultBranch = checkout !== null && !('error' in checkout) ? checkout.defaultBranch : null
  const prs: PrView[] = []
  const unread: PrUnread[] = []
  let cut: string | undefined
  // each PR's base, the default branch's name when the main checkout's read failed
  const bases: (string | null)[] = []
  if (want.length > 0 && ctx.prBudget <= 0) cut = 'GitHub rate limit: no PR is read this pass'
  for (const r of want.slice(0, Math.max(0, ctx.prBudget))) {
    if (ctx.limited()) {
      cut = 'a GitHub rate limit met this pass ended the PR reads'
      break
    }
    const v = await readOne(ctx, r, defaultBranch)
    if ('why' in v) {
      unread.push({ pr: r.pr, issue: r.issue, why: v.why, untrusted: v.untrusted })
      continue
    }
    prs.push(v.view)
    bases.push(v.base)
  }
  let main: PrsRead['main'] = null
  const behind = prs.findIndex(v => v.state === 'open' && v.mergeable === 'behind' && want.some(r => r.pr === v.pr && r.state === 'merge-queue'))
  const branch = defaultBranch ?? bases[behind] ?? null
  if (behind >= 0 && branch !== null && !ctx.limited()) {
    const r = await ctx.run(lsRemoteArgv(branch), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    // a sha that did not read holds that head alone (rules-queue.ts update)
    main = { branch, sha: r.exitCode === 0 ? shaOf(r.stdout, branch) : null }
  }
  const heads = headsOf(ctx.heads, ctx.records, prs, now, ctx.state.ledger)
  for (const k of [...PATCHES.keys()]) {
    const sha = k.split(' ').at(-1) ?? ''
    if (heads[sha] === undefined) PATCHES.delete(k)
  }
  const source: Source = cut === undefined ? { ok: true, at: now } : { ok: false, at: now, error: cut }
  const read: PrsRead = { prs, main }
  if (unread.length > 0) read.unread = unread
  if (cut !== undefined) read.cut = cut
  return { read, source, heads }
}

// readOne: one record's PR: the PR itself, and for an open one its checks and its head's patch id.
async function readOne(ctx: SourceCtx, r: IssueRecord & { pr: number }, defaultBranch: string | null): Promise<{ view: PrView; base: string | null } | { why: string; untrusted: boolean }> {
  const failed = (why: string, untrusted = false) => ({ why, untrusted })
  const read = await ctx.run(prReadArgv(r.pr), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (read.exitCode === 3) return failed('not by a trusted author (callum-flow-issue-read exit 3)', true)
  if (read.exitCode !== 0) return failed(`callum-flow-issue-read exit ${read.exitCode}: ${lastLine(read)}`)
  const pull = pullOf(read.stdout)
  if (pull === null) return failed('the PR read does not parse')
  let checks: CheckRun[] = []
  let patch: string | null = null
  if (pull.state === 'open') {
    const c = await ctx.run(prChecksArgv(ctx.rt.repo, r.pr), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    const parsed = checksOf(c)
    if (parsed === null) return failed(`gh pr checks exit ${c.exitCode}: ${lastLine(c)}`)
    checks = parsed
    const base = defaultBranch ?? pull.base
    if (pull.head !== null && base !== null) {
      const p = await patchOf(ctx, pull.head, base)
      if (typeof p !== 'string') return failed(p.why)
      patch = p
    }
  }
  const view: PrView = { pr: r.pr, issue: r.issue, state: pull.state, head: pull.head, mergedHead: pull.mergedHead, closedAt: pull.closedAt, mergeable: pull.mergeable, author: pull.author, checks, patch, readAt: ctx.now }
  return { view, base: pull.base }
}

async function patchOf(ctx: SourceCtx, head: string, base: string): Promise<string | { why: string }> {
  const key = `${ctx.rt.repo} ${base} ${head}`
  const kept = PATCHES.get(key)
  if (kept !== undefined) return kept
  const r = await ctx.run(patchIdArgv(head, base), undefined, PATCH_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const id = r.stdout.trim()
  if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) return { why: `the patch id of ${head.slice(0, 7)} did not compute: ${lastLine(r) || `exit ${r.exitCode}`}` }
  PATCHES.set(key, id)
  return id
}

// headsOf: the heads first seen (2.4): an open PR's head the first time it is read; a head goes
// when its PR is read closed or merged, or its record closed (a closed record stays in the store
// for a week). A record's PR is its life's (lifePr). A head whose PR no record names stays:
// records that could not be read are no reason to forget when a head was first seen.
export function headsOf(before: Readonly<Record<string, HeadSeen>>, records: readonly IssueRecord[], prs: readonly PrView[], now: Ms, ledger: readonly LedgerEntry[]): Record<string, HeadSeen> {
  const prsOf = (rs: IssueRecord[]) => rs.flatMap(r => lifePr(ledger, r) ?? [])
  const live = new Set(prsOf(records.filter(r => r.state !== 'closed')))
  const closed = new Set(prsOf(records.filter(r => r.state === 'closed')).filter(pr => !live.has(pr)))
  const ended = new Set(prs.filter(v => v.state !== 'open').map(v => v.pr))
  const out: Record<string, HeadSeen> = {}
  for (const [sha, h] of Object.entries(before)) if (!closed.has(h.pr) && !ended.has(h.pr)) out[sha] = h
  for (const v of prs) if (v.state === 'open' && v.head !== null && out[v.head] === undefined) out[v.head] = { pr: v.pr, at: now }
  return out
}

function lastLine(r: { stdout: string; stderr: string }): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n').pop()?.slice(0, 200) ?? ''
}
