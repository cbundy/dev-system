// Pure parsers for what observe reads: each turns one command's output into typed values,
// or reports that it could not. No I/O here, so the tests and the replay harness (plain
// Node) drive them directly. Types only are imported.
import type { Bump, Checkout, Milestone, Pool, Stage, Usage } from './types'

const STAGES: readonly Stage[] = [
  'queued',
  'designing',
  'implementing',
  'in pipeline',
  'parked',
  'waiting',
  'ready to merge',
  'merged',
  'closed without merge',
]

export function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

// --- callum-flow-factory-state --format json ------------------------------------------------

export type FactoryIssue = {
  number: number
  stage: Stage
  stageSince: number | null
  holder: string | null
  run: string | null
  pr: number | null
  stuck: string | null
  // the lease end of a claim the tool shows lapsed (its detail `claim lapsed at <ISO>`), else null
  lapsedAt: number | null
  ended: boolean
  github: { open: boolean | null; labels: string[] | null } | null
}

// An event type the image's readers skipped (the report's top-level skipped_events): `derived` when
// the derivation behind the report left it out.
export type SkippedEvent = { type: string; version: number; count: number; derived: boolean }
export type Factory = { at: number; issues: FactoryIssue[]; skipped: SkippedEvent[] }

// skippedOf: the report's skipped_events; [] when absent (an older image) or not an array, and a
// malformed entry is dropped.
function skippedOf(raw: unknown): SkippedEvent[] {
  if (!Array.isArray(raw)) return []
  const out: SkippedEvent[] = []
  for (const e of raw as Record<string, unknown>[]) {
    if (e === null || typeof e !== 'object') continue
    if (typeof e.type !== 'string' || !Number.isInteger(e.type_version) || typeof e.count !== 'number') continue
    out.push({ type: e.type, version: e.type_version as number, count: e.count, derived: e.derived === true })
  }
  return out
}

// derivedSkipError: why a report whose derivation skipped events is not read, or null when none was.
export function derivedSkipError(skipped: SkippedEvent[]): string | null {
  const d = skipped.filter(s => s.derived)
  if (d.length === 0) return null
  return `the image's readers are older than this loop: skipped derived events ${d.map(s => `${s.type} v${s.version} x${s.count}`).join(', ')}`
}

// sameRepo: two owner/name strings are the same repo whatever their casing (GitHub names are case-insensitive,
// and callum-flow-factory-state lower-cases the repos it reports).
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// factoryStateError: why a report from a tool that exited 0 cannot be used for the repo (rule G2's blind tell,
// at most 300 characters).
export function factoryStateError(json: string, repo: string): string {
  let doc: { at?: unknown; repos?: unknown }
  try {
    doc = JSON.parse(json)
  } catch {
    return 'factory-state report is not JSON'
  }
  if (doc === null || typeof doc !== 'object') return 'factory-state report is not JSON'
  if (isoMs(doc.at) === null) return 'factory-state report has no valid at'
  const repos = Array.isArray(doc.repos) ? doc.repos.flatMap((r: { repo?: unknown }) => (typeof r?.repo === 'string' ? [r.repo] : [])) : []
  return `factory-state report has no entry for ${repo} (repos: ${repos.length === 0 ? 'none' : repos.join(', ')})`.slice(0, 300)
}

// parseFactoryState: the repo's live and recently ended issues, or null when the document is
// not a factory-state report for that repo.
export function parseFactoryState(json: string, repo: string): Factory | null {
  let doc: { at?: unknown; skipped_events?: unknown; repos?: { repo?: unknown; issues?: unknown[]; recent?: unknown[] }[] }
  try {
    doc = JSON.parse(json)
  } catch {
    return null
  }
  const at = isoMs(doc.at)
  const entry = Array.isArray(doc.repos) ? doc.repos.find(r => typeof r?.repo === 'string' && sameRepo(r.repo, repo)) : undefined
  if (at === null || entry === undefined) return null
  const issues: FactoryIssue[] = []
  const take = (list: unknown[] | undefined, ended: boolean) => {
    for (const raw of list ?? []) {
      const i = raw as Record<string, unknown>
      const stage = i.stage as Stage
      if (typeof i.issue !== 'number' || !STAGES.includes(stage)) continue
      const stuck = i.stuck as { rule?: unknown } | null
      const gh = i.github as { state?: unknown; labels?: unknown } | null
      issues.push({
        number: i.issue,
        stage,
        stageSince: isoMs(i.entered_at),
        holder: typeof i.holder === 'string' ? i.holder : null,
        run: typeof i.run === 'string' ? i.run : null,
        pr: typeof i.pr === 'number' ? i.pr : null,
        stuck: stuck !== null && typeof stuck === 'object' && typeof stuck.rule === 'string' ? stuck.rule : null,
        lapsedAt: typeof i.detail === 'string' ? isoMs(/^claim lapsed at (\S+)/.exec(i.detail)?.[1]) : null,
        ended,
        github:
          gh !== null && typeof gh === 'object'
            ? {
                open: gh.state === 'open' ? true : gh.state === 'closed' ? false : null,
                labels: Array.isArray(gh.labels) ? gh.labels.filter((l): l is string => typeof l === 'string') : null,
              }
            : null,
      })
    }
  }
  take(entry.issues, false)
  take(entry.recent, true)
  return { at, issues, skipped: skippedOf(doc.skipped_events) }
}

// --- dev-query --csv ---------------------------------------------------------------------

// parseCsv: RFC 4180 rows (quoted fields may hold commas, quotes and newlines), header first.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const header = rows.shift()
  if (header === undefined) return []
  return rows
    .filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

// --- callum-flow-issue-read --json <N> ------------------------------------------------------

export type IssueFacts = {
  open: boolean
  labels: string[]
  blockedBy: number | null
  // the open issues waiting on this one (issue_dependencies_summary.blocking)
  blocking: number | null
  subIssues: number | null
  title: string
  // the open issues of this repo that this one blocks (the reader's `blocking` list); null: not read
  blockingList: number[] | null
  // the newest closed_at among its listed closed blockers, any repo; null: none listed or not read
  blockersClosedAt: Ms | null
  // the parent's number when the parent is in this repo, else null
  parent: number | null
  // the parent's other sub-issues in this repo, itself left out; null: not read or no parent here
  siblings: { number: number; open: boolean }[] | null
  // the body's version, the reader's `body_sha` of --issues (16 hex); absent from the per-issue read and from an older image
  bodyVersion?: string
}

type Node = { number: number; repo: string; state: string }
const nodesOf = (v: unknown): Node[] | null =>
  Array.isArray(v) && v.every(n => n !== null && typeof n === 'object' && typeof n.number === 'number' && typeof n.repo === 'string' && typeof n.state === 'string')
    ? (v as Node[])
    : null

function factsOf(issue: unknown, repo?: string): IssueFacts | null {
  if (issue === null || typeof issue !== 'object') return null
  const i = issue as { body_sha?: unknown; number?: unknown; blocking?: unknown; blocked_by?: unknown; parent?: unknown; state?: unknown; labels?: unknown; title?: unknown; issue_dependencies_summary?: { blocked_by?: unknown; blocking?: unknown }; sub_issues_summary?: { total?: unknown } }
  const deps = i.issue_dependencies_summary
  const subs = i.sub_issues_summary
  const blocking = repo === undefined ? null : nodesOf(i.blocking)
  const blockedBy = Array.isArray(i.blocked_by) ? (i.blocked_by as { state?: unknown; closed_at?: unknown }[]) : null
  const closed = (blockedBy ?? []).flatMap(b => (b?.state === 'closed' && typeof b.closed_at === 'string' ? [isoMs(b.closed_at)] : []))
  const closedAts = closed.filter((t): t is number => typeof t === 'number')
  const par = i.parent !== null && typeof i.parent === 'object' ? (i.parent as Node & { sub_issues?: unknown }) : null
  const here = repo !== undefined && par !== null && typeof par.repo === 'string' && sameRepo(par.repo, repo)
  const sibs = here ? nodesOf(par.sub_issues) : null
  return {
    open: i.state === 'open',
    labels: Array.isArray(i.labels) ? i.labels.map((l: { name?: unknown }) => String(l?.name ?? '')).filter(Boolean) : [],
    blockedBy: typeof deps?.blocked_by === 'number' ? deps.blocked_by : null,
    blocking: typeof deps?.blocking === 'number' ? deps.blocking : null,
    subIssues: typeof subs?.total === 'number' ? subs.total : null,
    title: typeof i.title === 'string' ? i.title : '',
    blockingList: blocking === null ? null : blocking.filter(n => n.state === 'open' && repo !== undefined && sameRepo(n.repo, repo)).map(n => n.number),
    blockersClosedAt: closedAts.length > 0 ? Math.max(...closedAts) : null,
    parent: here ? par.number : null,
    siblings: sibs === null ? null : sibs.filter(n => repo !== undefined && sameRepo(n.repo, repo) && n.number !== i.number).map(n => ({ number: n.number, open: n.state === 'open' })),
    ...(typeof i.body_sha === 'string' && /^[0-9a-f]{16}$/.test(i.body_sha) ? { bodyVersion: i.body_sha } : {}),
  }
}

export function parseIssueRead(json: string): IssueFacts | null {
  try {
    return factsOf(JSON.parse(json)?.issue)
  } catch {
    return null
  }
}

// parseIssuesRead: callum-flow-issue-read --json --issues <N,...>: each trusted issue's facts (the
// same mapping as parseIssueRead), the numbers refused as untrusted, the numbers GitHub does not know.
export type IssuesRead = { facts: Map<number, IssueFacts>; refused: number[]; missing: number[] }

export function parseIssuesRead(json: string, repo?: string): IssuesRead | null {
  try {
    const o = JSON.parse(json)
    const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every(n => Number.isInteger(n)) ? (v as number[]) : null)
    const refused = nums(o?.refused)
    const missing = nums(o?.missing)
    if (!Array.isArray(o?.issues) || refused === null || missing === null) return null
    const facts = new Map<number, IssueFacts>()
    for (const item of o.issues) {
      const f = factsOf(item, repo)
      if (f === null || !Number.isInteger(item.number)) return null
      facts.set(item.number, f)
    }
    return { facts, refused, missing }
  } catch {
    return null
  }
}

// parseBrief: the newest '## Design brief' comment among an issue's trusted comments
// (callum-flow-issue-read --json <N> --comments), by its heading only.
export function parseBrief(json: string): { url: string; at: number } | null {
  try {
    const comments = JSON.parse(json)?.comments
    if (!Array.isArray(comments)) return null
    let best: { url: string; at: number } | null = null
    for (const c of comments) {
      if (typeof c?.body !== 'string' || !c.body.trimStart().startsWith('## Design brief')) continue
      const at = isoMs(c.created_at)
      const url = typeof c.html_url === 'string' ? c.html_url : null
      if (at === null || url === null) continue
      if (best === null || at > best.at) best = { url, at }
    }
    return best
  } catch {
    return null
  }
}

// parseSubIssues: a tracker's open sub-issues on this repo, ascending, from its timeline
// (`callum-flow-issue-read --json --timeline <N>`: {events, stripped}), by replaying its
// sub_issue_added and sub_issue_removed events in order, as the replay harness does (D-35).
// Each event carries the sub-issue as GitHub returns it now, so its state is current. Only
// trusted actors' events reach here: the reader drops the rest.
export function parseSubIssues(json: string, repo: string): number[] | null {
  try {
    const events = JSON.parse(json)?.events
    if (!Array.isArray(events)) return null
    const subs = new Map<number, boolean>()
    const timed = events
      .filter((e: { created_at?: unknown }) => isoMs(e?.created_at) !== null)
      .sort((a: { created_at: string }, b: { created_at: string }) => (isoMs(a.created_at) ?? 0) - (isoMs(b.created_at) ?? 0))
    for (const e of timed) {
      const sub = e.sub_issue
      if (typeof sub?.number !== 'number') continue
      const where = sub.repository?.full_name
      if (typeof where === 'string' && !sameRepo(where, repo)) continue
      if (e.event === 'sub_issue_added') subs.set(sub.number, sub.state === 'open')
      else if (e.event === 'sub_issue_removed') subs.delete(sub.number)
    }
    return [...subs.entries()]
      .filter(([, open]) => open)
      .map(([n]) => n)
      .sort((a, b) => a - b)
  } catch {
    return null
  }
}

// parseQueue: the open issue numbers of `callum-flow-issue-read --json --list --label <L>`.
export function parseQueue(json: string): number[] | null {
  try {
    const issues = JSON.parse(json)?.issues
    if (!Array.isArray(issues)) return null
    return issues
      .map((i: { number?: unknown }) => i?.number)
      .filter((n: unknown): n is number => typeof n === 'number')
      .sort((a: number, b: number) => a - b)
  } catch {
    return null
  }
}

// --- queue-watch.sh --once ------------------------------------------------------------------

// parseQueueOnce: the one line `queue-watch.sh --once` prints (v2 SPEC 13.3.4),
// `queue known=<n1,n2|none> now=<n1,n2|none>`, as ascending issue numbers; null for anything
// else, so a garbled read is a failed source, never an empty queue.
export function parseQueueOnce(text: string): { known: number[]; now: number[] } | null {
  const m = /^queue known=(none|[1-9]\d*(?:,[1-9]\d*)*) now=(none|[1-9]\d*(?:,[1-9]\d*)*)$/.exec(text.trim())
  if (m?.[1] === undefined || m[2] === undefined) return null
  const list = (v: string) => (v === 'none' ? [] : [...new Set(v.split(',').map(Number))].sort((a, b) => a - b))
  return { known: list(m[1]), now: list(m[2]) }
}

// --- usage-check.sh -------------------------------------------------------------------------

export function parseUsage(line: string): Usage {
  const field = (name: string) => line.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`))?.[1]
  if (line.startsWith('usage=unavailable') || field('five_hour') === undefined) {
    return { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true }
  }
  const pct = (name: string) => {
    const n = Number(field(name))
    return Number.isFinite(n) ? n : null
  }
  return {
    fiveHour: pct('five_hour'),
    sevenDay: pct('seven_day'),
    fiveHourResetsAt: isoMs(field('resets_at') ?? ''),
    sevenDayResetsAt: isoMs(field('seven_day_resets_at') ?? ''),
    unavailable: false,
  }
}

// --- treehouse status --json ------------------------------------------------------------------

// parsePool: the worktree pool. `treehouse status --json` lists the slots that exist; the
// pool grows up to maxTrees (treehouse.toml), so a slot not yet made counts as free. Whether a
// slot's tree is dirty is not in the listing, nor the branch of a lease whose slot was detached
// (`branch: ""`).
export function parsePool(json: string, maxTrees: number): Pool | null {
  try {
    const list = JSON.parse(json)
    if (!Array.isArray(list)) return null
    const slots = list.map(raw => {
      const w = raw as Record<string, unknown>
      const branch = typeof w.branch === 'string' && w.branch !== '' ? w.branch : null
      return {
        path: String(w.path ?? ''),
        branch,
        state: String(w.status ?? 'unknown'),
        dirty: null,
        busy: Array.isArray(w.processes) && w.processes.length > 0,
        lease: typeof w.lease_id === 'string' && w.lease_id !== '' ? w.lease_id : null,
        leasedAt: isoMs(w.leased_at),
        leaseBranch: branch,
      }
    })
    const free = slots.filter(s => s.state === 'available').length + Math.max(0, maxTrees - slots.length)
    return { free, total: Math.max(maxTrees, slots.length), slots }
  } catch {
    return null
  }
}

// changedPath: the path of one `git status --porcelain=v2` line that is a tracked change; null for
// a header, an untracked or ignored file or a blank line; undefined for a line that does not read.
// Ordinary (1), renamed (2, then a score and `<path>\t<orig>`) and unmerged (u) entries carry 8,
// 9 and 10 fields before the path.
function changedPath(line: string): string | null | undefined {
  if (line === '' || line.startsWith('#') || line.startsWith('? ') || line.startsWith('! ')) return null
  const fields = line.startsWith('1 ') ? 8 : line.startsWith('2 ') ? 9 : line.startsWith('u ') ? 10 : null
  if (fields === null) return undefined
  return line.split(' ').slice(fields).join(' ').split('\t')[0] ?? ''
}

// --- the main checkout (#544) -------------------------------------------------------------------

// parseCheckout: origin's default branch, from `git symbolic-ref --short refs/remotes/origin/HEAD`
// (`origin/main`), and the checkout's branch, commit and changed tracked paths, from `git status
// --porcelain=v2 --branch --untracked-files=no` (`# branch.head (detached)` when detached, then
// one line per changed path; untracked files are allowed), and the upstream (`# branch.upstream`) and
// ahead and behind counts (`# branch.ab +A -B`), null when absent; null when either does not read.
export function parseCheckout(originHead: string, status: string): Checkout | null {
  const defaultBranch = originHead.trim().match(/^origin\/(\S+)$/)?.[1]
  if (defaultBranch === undefined) return null
  let branch: string | null | undefined
  let head: string | null = null
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  const dirty: string[] = []
  for (const line of status.split('\n')) {
    const header = line.match(/^# branch\.(oid|head) (.+)$/)
    if (header?.[1] === 'head') branch = header[2] === '(detached)' ? null : (header[2] ?? null)
    else if (header?.[1] === 'oid') head = header[2] === '(initial)' ? null : (header[2] ?? null)
    const up = line.match(/^# branch\.upstream (\S+)$/)
    if (up !== null) upstream = up[1] ?? null
    const ab = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
    if (ab !== null) {
      ahead = Number(ab[1])
      behind = Number(ab[2])
    }
    const path = changedPath(line)
    if (path === undefined) return null
    if (path !== null) dirty.push(path)
  }
  return branch === undefined ? null : { branch, head, defaultBranch, dirty, upstream, ahead, behind }
}

// --- callum-flow-milestone show next -----------------------------------------------------------

// parseMilestone: counts of the Next release milestone's open and closed items, and its
// Expected bump; null when the repo has not opted in (the command prints nothing for it).
export function parseMilestone(text: string): Milestone | null {
  if (!/Next release/i.test(text)) return null
  let open = 0
  let closed = 0
  const openIssues: number[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^#(\d+)\s+(open|closed)\s+(issue\s)?/)
    if (m?.[2] === 'open') {
      open++
      if (m[3] !== undefined) openIssues.push(Number(m[1]))
    } else if (m?.[2] === 'closed') closed++
  }
  const bump = text.match(/Expected:\s*(patch|minor|major)\b/)?.[1] as Bump | undefined
  return { open, closed, openIssues, expected: bump ?? null }
}

// --- the last release and the oldest merge since it --------------------------------------------

// parseReleaseTag: the tag of `gh release view --json tagName`; null when it is not that shape.
export function parseReleaseTag(text: string): string | null {
  try {
    const tag: unknown = JSON.parse(text)?.tagName
    return typeof tag === 'string' && tag.trim() !== '' ? tag.trim() : null
  } catch {
    return null
  }
}

// parseCommitDate: the one ISO date line `gh api .../commits/<tag> --jq .commit.committer.date`
// prints, as epoch ms; null when it is not a date.
export function parseCommitDate(text: string): number | null {
  const t = text.trim()
  if (!/^\d{4}-\d\d-\d\dT/.test(t)) return null
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? null : ms
}

// parseTagCommit: the two lines `gh api .../commits/<tag> --jq '.sha,.commit.committer.date'`
// prints: the commit sha, then its date as epoch ms; null when it is not that.
export function parseTagCommit(text: string): { sha: string; at: number } | null {
  const [sha, date, ...rest] = text.trim().split('\n').map((l) => l.trim())
  if (rest.length > 0 || !/^[0-9a-f]{7,64}$/.test(sha ?? '')) return null
  const at = parseCommitDate(date ?? '')
  return at === null ? null : { sha, at }
}

// parseOldestMerge: the earliest mergedAt of `gh pr list --state merged --json mergedAt,mergeCommit`,
// as epoch ms, leaving out the PR whose merge commit is `skipSha` (the release's own bump PR);
// undefined when the output is not a list of that shape, null when no PR is left.
export function parseOldestMerge(text: string, skipSha?: string): number | null | undefined {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  let oldest: number | null = null
  for (const p of list) {
    const ms = typeof p?.mergedAt === 'string' ? Date.parse(p.mergedAt) : Number.NaN
    if (Number.isNaN(ms)) return undefined
    if (skipSha !== undefined && p?.mergeCommit?.oid === skipSha) continue
    if (oldest === null || ms < oldest) oldest = ms
  }
  return oldest
}
