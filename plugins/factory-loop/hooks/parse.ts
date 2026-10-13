// Pure parsers for what observe reads: each turns one command's output into typed values,
// or reports that it could not. No I/O here, so the tests and the replay harness (plain
// Node) drive them directly. Types only are imported.
import type { Bump, Milestone, Pool, Stage, Usage } from './types'

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
// slot's tree is dirty is not in the listing: observe asks git for the slots it might release.
export function parsePool(json: string, maxTrees: number): Pool | null {
  try {
    const list = JSON.parse(json)
    if (!Array.isArray(list)) return null
    const slots = list.map(raw => {
      const w = raw as Record<string, unknown>
      return {
        path: String(w.path ?? ''),
        branch: typeof w.branch === 'string' && w.branch !== '' ? w.branch : null,
        state: String(w.status ?? 'unknown'),
        dirty: null,
        busy: Array.isArray(w.processes) && w.processes.length > 0,
      }
    })
    const free = slots.filter(s => s.state === 'available').length + Math.max(0, maxTrees - slots.length)
    return { free, total: Math.max(maxTrees, slots.length), slots }
  } catch {
    return null
  }
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
