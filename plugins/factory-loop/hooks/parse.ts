// Pure parsers for what observe reads: each turns one command's output into typed values,
// or reports that it could not. No I/O here, so the tests and the replay harness (plain
// Node) drive them directly. Types only are imported.
import type { Bump, Checkout, Milestone, Pool, RunState, Stage, Usage } from './types'

const STAGES: readonly Stage[] = [
  'queued',
  'designing',
  'implementing',
  'in pipeline',
  'parked',
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

export type Factory = { at: number; issues: FactoryIssue[] }

// parseFactoryState: the repo's live and recently ended issues, or null when the document is
// not a factory-state report for that repo.
export function parseFactoryState(json: string, repo: string): Factory | null {
  let doc: { at?: unknown; repos?: { repo?: unknown; issues?: unknown[]; recent?: unknown[] }[] }
  try {
    doc = JSON.parse(json)
  } catch {
    return null
  }
  const at = isoMs(doc.at)
  const entry = Array.isArray(doc.repos) ? doc.repos.find(r => r.repo === repo) : undefined
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
  return { at, issues }
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
}

export function parseIssueRead(json: string): IssueFacts | null {
  try {
    const issue = JSON.parse(json)?.issue
    if (issue === null || typeof issue !== 'object') return null
    const deps = issue.issue_dependencies_summary
    const subs = issue.sub_issues_summary
    return {
      open: issue.state === 'open',
      labels: Array.isArray(issue.labels) ? issue.labels.map((l: { name?: unknown }) => String(l?.name ?? '')).filter(Boolean) : [],
      blockedBy: typeof deps?.blocked_by === 'number' ? deps.blocked_by : null,
      blocking: typeof deps?.blocking === 'number' ? deps.blocking : null,
      subIssues: typeof subs?.total === 'number' ? subs.total : null,
      title: typeof issue.title === 'string' ? issue.title : '',
    }
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
      if (typeof where === 'string' && where.toLowerCase() !== repo.toLowerCase()) continue
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

// parseQueueOnce: the one line `queue-watch.sh --once` prints (SPEC 3.4),
// `queue known=<n1,n2|none> now=<n1,n2|none>`, as ascending issue numbers; null for anything
// else, so a garbled read is a failed source, never an empty queue.
export function parseQueueOnce(text: string): { known: number[]; now: number[] } | null {
  const m = /^queue known=(none|[1-9]\d*(?:,[1-9]\d*)*) now=(none|[1-9]\d*(?:,[1-9]\d*)*)$/.exec(text.trim())
  if (m?.[1] === undefined || m[2] === undefined) return null
  const list = (v: string) => (v === 'none' ? [] : [...new Set(v.split(',').map(Number))].sort((a, b) => a - b))
  return { known: list(m[1]), now: list(m[2]) }
}

// --- pipeline-watch.sh --once ---------------------------------------------------------------

// One branch's newest run that is not completed, as `pipeline-watch.sh --once` reports it.
export type PipelineRun = {
  state: RunState
  branch: string
  // a ULID, or 'unknown' for a run no source knows the id of
  run: string
  head: string | null
  // the gate a parked run waits at, or the step a failed run failed (null: not known)
  step: string | null
  // the state's own detail, as the watcher logs it in its event's note: head-mismatch's
  // 'run=<sha> branch=<sha>[ worktree=<sha>]', ci-stalled's 'reason=<r>'
  detail: string | null
  pr: number | null
}

const RUN_STATES: readonly RunState[] = [
  'merge-ready',
  'head-mismatch',
  'conflict',
  'ci-stalled',
  'parked',
  'failed',
  'cancelled',
  'running',
  'pending',
]
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const SHA = /^[0-9a-f]{4,64}$/i

// parsePipelineLine: one line, `<state> <branch> <run-id>[ key=value...] head=<sha>`, split on
// single spaces. The pairs come in a fixed order: the state's own detail (head-mismatch:
// run=, branch= and an optional worktree=; ci-stalled: reason=no-workflow|no-checks), then
// step= (parked and failed only), then an optional pr=. A SHA or step of 'unknown' reads as
// null. Null for a line that breaks any of it: a watcher the loop does not understand must not
// be read as some other state.
export function parsePipelineLine(line: string): PipelineRun | null {
  const tokens = line.split(' ')
  if (tokens.length < 4 || tokens.includes('')) return null
  const [state, branch, run] = tokens as [string, string, string]
  const last = tokens[tokens.length - 1] as string
  const kind = RUN_STATES.find(s => s === state)
  if (kind === undefined || (run !== 'unknown' && !ULID.test(run)) || !last.startsWith('head=')) return null
  const sha = (v: string | undefined) => (v === undefined ? undefined : v === 'unknown' ? null : SHA.test(v) ? v : undefined)
  const head = sha(last.slice('head='.length))
  if (head === undefined) return null

  const pairs = tokens.slice(3, -1)
  let at = 0
  // take: the next pair's value when its key is `key`, else undefined (the pair stays)
  const take = (key: string) => {
    const pair = pairs[at]
    if (pair === undefined || !pair.startsWith(`${key}=`) || pair.length === key.length + 1) return undefined
    at++
    return pair.slice(key.length + 1)
  }
  let detail: string | null = null
  if (kind === 'head-mismatch') {
    const own = [take('run'), take('branch')]
    const worktree = take('worktree')
    if (worktree !== undefined) own.push(worktree)
    if (own.some(v => sha(v) === undefined)) return null
    detail = pairs.slice(0, at).join(' ')
  } else if (kind === 'ci-stalled') {
    const reason = take('reason')
    if (reason !== 'no-workflow' && reason !== 'no-checks') return null
    detail = `reason=${reason}`
  }
  let step: string | null = null
  if (kind === 'parked' || kind === 'failed') {
    const value = take('step')
    if (value === undefined) return null
    step = value === 'unknown' ? null : value
  }
  const pr = take('pr')
  if (pr !== undefined && !/^[1-9]\d*$/.test(pr)) return null
  // anything left over is a pair this grammar does not have
  if (at !== pairs.length) return null
  return { state: kind, branch, run, head, step, detail, pr: pr === undefined ? null : Number(pr) }
}

// parsePipelineOnce: every line of one `pipeline-watch.sh --once` poll, and the lines that
// broke the grammar (observe fails the source on any: SPEC 3.3). A branch it does not print
// has no run in flight.
export function parsePipelineOnce(text: string): { runs: PipelineRun[]; bad: string[] } {
  const runs: PipelineRun[] = []
  const bad: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parsePipelineLine(line)
    if (parsed === null) bad.push(line)
    else runs.push(parsed)
  }
  return { runs, bad }
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
// (`branch: ""`): observe asks git for the slots it might release (#563).
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

// parseReflog: the branches a slot's checkouts moved to since its lease began (ms), newest first,
// from `git reflog show --date=unix --format=%gd%x09%gs HEAD`: `HEAD@{<unix seconds>}<tab>checkout:
// moving from <a> to <b>`, or a rebase's `... returning to refs/heads/<b>`. Only destinations
// count: the lease's agent moved there itself (its `checkout -b` or `switch`, which its later
// detach leaves behind), while a branch the slot only moved from may be an earlier lease's, left
// checked out when this one began. A detached HEAD and a commit id are no branch, and entries
// before the lease are an earlier lease's (#563), allowing REFLOG_SLACK_S: `treehouse get --lease
// -b` checks the branch out before it records `leased_at`. null when a line does not read.
const REFLOG_SLACK_S = 2
export function parseReflog(text: string, since: number): string[] | null {
  const branches: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const m = line.match(/^HEAD@\{(\d+)\}\t(.*)$/)
    if (m === null) return null
    if (Number(m[1]) < Math.floor(since / 1000) - REFLOG_SLACK_S) continue
    const subject = m[2] ?? ''
    const to = subject.match(/^checkout: moving from \S+ to (\S+)$/)?.[1] ?? subject.match(/ returning to refs\/heads\/(\S+)$/)?.[1]
    if (to !== undefined && to !== 'HEAD' && !/^[0-9a-f]{7,64}$/.test(to)) branches.push(to)
  }
  return branches
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

// parseDirty: whether `git status --porcelain=v2 --untracked-files=normal` lists a tracked change
// or an untracked file (a pool slot's tree, rule H3): `treehouse return` counts both as uncommitted
// changes and keeps the slot, but not an ignored one (`!`, listed only with --ignored). null when
// a line does not read.
export function parseDirty(status: string): boolean | null {
  let dirty = false
  for (const line of status.split('\n')) {
    if (line.startsWith('? ')) {
      dirty = true
      continue
    }
    const path = changedPath(line)
    if (path === undefined) return null
    if (path !== null) dirty = true
  }
  return dirty
}

// --- the main checkout (#544) -------------------------------------------------------------------

// parseCheckout: origin's default branch, from `git symbolic-ref --short refs/remotes/origin/HEAD`
// (`origin/main`), and the checkout's branch, commit and changed tracked paths, from `git status
// --porcelain=v2 --branch --untracked-files=no` (`# branch.head (detached)` when detached, then
// one line per changed path; untracked files are allowed); null when either does not read.
export function parseCheckout(originHead: string, status: string): Checkout | null {
  const defaultBranch = originHead.trim().match(/^origin\/(\S+)$/)?.[1]
  if (defaultBranch === undefined) return null
  let branch: string | null | undefined
  let head: string | null = null
  const dirty: string[] = []
  for (const line of status.split('\n')) {
    const header = line.match(/^# branch\.(oid|head) (.+)$/)
    if (header?.[1] === 'head') branch = header[2] === '(detached)' ? null : (header[2] ?? null)
    else if (header?.[1] === 'oid') head = header[2] === '(initial)' ? null : (header[2] ?? null)
    const path = changedPath(line)
    if (path === undefined) return null
    if (path !== null) dirty.push(path)
  }
  return branch === undefined ? null : { branch, head, defaultBranch, dirty }
}

// --- callum-flow-milestone show next -----------------------------------------------------------

// parseMilestone: counts of the Next release milestone's open and closed items, and its
// Expected bump; null when the repo has not opted in (the command prints nothing for it).
export function parseMilestone(text: string): Milestone | null {
  if (!/Next release/i.test(text)) return null
  let open = 0
  let closed = 0
  for (const line of text.split('\n')) {
    const m = line.match(/^#\d+\s+(open|closed)\s/)
    if (m?.[1] === 'open') open++
    else if (m?.[1] === 'closed') closed++
  }
  const bump = text.match(/Expected:\s*(patch|minor|major)\b/)?.[1] as Bump | undefined
  return { open, closed, expected: bump ?? null }
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
