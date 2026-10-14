// buildState: what observe read, assembled into the State plan takes (SPEC 3.1, 3.2). Pure,
// so the pass driver, the shadow run and the replay harness build state the same way.
import type { Facts } from './derive'
import { runsFromEvents } from './derive'
import type { Factory, IssueFacts, PipelineRun } from './parse'
import { issueFromBranch } from './plan'
import type {
  AgentView,
  Brief,
  Checkout,
  Control,
  IssueView,
  LedgerEntry,
  Milestone,
  Pool,
  RunView,
  Source,
  SourceName,
  State,
  Usage,
} from './types'

export type GithubIssue = { facts: IssueFacts | null; trusted: boolean; brief: Brief | null }

export type Observed = {
  now: number
  repo: string
  device: string
  loadedAt: number
  sources: Record<SourceName, Source>
  factory: Factory | null
  facts: Facts | null
  // runSource local: the pipeline watcher's runs (runsFromWatch); null for runSource events
  // (built here from the event log)
  runs: RunView[] | null
  queue: number[] | null
  github: Map<number, GithubIssue>
  // each tracker's open sub-issues, direct ones only, from its timeline (parseSubIssues): read
  // for trackers named in control.only and nested trackers among their sub-issues (D-35)
  timelines: Map<number, number[]>
  usage: Usage | null
  pool: Pool | null
  agents: AgentView[]
  milestone: Milestone | null
  ledger: LedgerEntry[]
  control: Control
  lastTitle: string | null
  githubBackoffUntil: number | null
  // config trackerTitle: a title matching it marks a tracker
  trackerTitle: string
  // the main checkout (#544); the replay harness leaves it out: not read
  checkout?: Checkout | null
}

const UNAVAILABLE: Usage = { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true }

// How deep trackers nest under a tracker named in `only` before observe stops reading them.
export const TRACKER_DEPTH = 3

// subIssuesOf: a tracker's open sub-issues, those of nested trackers included, ascending; null
// when its timeline was not read. Nesting is followed TRACKER_DEPTH levels deep, and a loop in
// the links is cut.
export function subIssuesOf(n: number, timelines: Map<number, number[]>, depth = TRACKER_DEPTH, seen: number[] = []): number[] | null {
  const direct = timelines.get(n)
  if (direct === undefined) return null
  const all = new Set<number>()
  for (const sub of direct) {
    if (sub === n || seen.includes(sub)) continue
    all.add(sub)
    const nested = depth > 1 ? subIssuesOf(sub, timelines, depth - 1, [...seen, n]) : null
    for (const m of nested ?? []) if (m !== n) all.add(m)
  }
  return [...all].sort((a, b) => a - b)
}

// --- runSource local: pipeline-watch.sh --once (SPEC 3.3, 3.4) -----------------------------

// A watcher line with when observe first saw that run in that state, at that head and step.
export type SeenRun = PipelineRun & { since: number }

// seenRuns: this poll's lines, each keeping the `since` of the same run in the same state, head
// and step in the last poll, else seen now. A run the poll no longer prints is dropped, so one
// that comes back starts over. Without a step (the watcher could not read one), `since` is what
// tells two parks on one head apart (plan's gateOf), so it must hold across passes.
export function seenRuns(prev: readonly SeenRun[], lines: readonly PipelineRun[], now: number): SeenRun[] {
  return lines.map(line => {
    const same = prev.find(
      p => p.branch === line.branch && p.run === line.run && p.state === line.state && p.head === line.head && p.step === line.step,
    )
    return { ...line, since: same?.since ?? now }
  })
}

// runsFromWatch: the watcher's runs as plan reads them: the issue from the branch name (issue-<N>),
// and review rounds, verdicts and supersession from the event log, as runsFromEvents does. A run
// with no known id has no facts. Sorted by issue, then branch, so the digest does not move with
// the watcher's order.
export function runsFromWatch(seen: readonly SeenRun[], facts: Facts | null): RunView[] {
  return seen
    .map(s => {
      const known = s.run !== 'unknown' && facts !== null
      return {
        branch: s.branch,
        issue: issueFromBranch(s.branch),
        run: s.run,
        state: s.state,
        head: s.head,
        step: s.step,
        detail: s.detail,
        pr: s.pr,
        since: s.since,
        reviewFixRounds: known ? (facts.reviewFixes.get(s.run) ?? 0) : 0,
        verdicts: known ? (facts.verdicts.get(s.run) ?? []) : [],
        superseded: known ? facts.superseded.has(s.run) : false,
      }
    })
    .sort((a, b) => (a.issue ?? 0) - (b.issue ?? 0) || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
}

export function buildState(o: Observed): State {
  const tracker = new RegExp(o.trackerTitle, 'i')
  // the replay harness (plain JS) may leave the timelines out
  const timelines = o.timelines ?? new Map<number, number[]>()
  const numbers = new Set<number>()
  for (const issue of o.factory?.issues ?? []) numbers.add(issue.number)
  for (const n of o.queue ?? []) numbers.add(n)
  for (const entry of o.ledger) if (entry.issue !== null) numbers.add(entry.issue)
  // the issues `only` names, and the sub-issues a tracker among them stands for (D-35)
  for (const n of o.control.only) {
    numbers.add(n)
    for (const sub of subIssuesOf(n, timelines) ?? []) numbers.add(sub)
  }

  const issues: IssueView[] = [...numbers]
    .sort((a, b) => a - b)
    .map(n => {
      const f = o.factory?.issues.find(i => i.number === n && !i.ended) ?? o.factory?.issues.find(i => i.number === n)
      const g = o.github.get(n)
      return {
        number: n,
        stage: f?.stage ?? null,
        stageSince: f?.stageSince ?? null,
        holder: f?.holder ?? null,
        run: f?.run ?? null,
        pr: f?.pr ?? null,
        stuck: f?.stuck ?? null,
        open: g?.facts?.open ?? f?.github?.open ?? null,
        trusted: g === undefined ? null : g.trusted,
        labels: g?.facts?.labels ?? f?.github?.labels ?? null,
        blockedBy: g?.facts?.blockedBy ?? null,
        subIssues: g?.facts?.subIssues ?? null,
        epic: g?.facts ? tracker.test(g.facts.title) : null,
        subIssueList: subIssuesOf(n, timelines),
        brief: g?.brief ?? null,
        delegatedBrief: o.facts?.briefs.get(n) ?? null,
      }
    })

  const runs = o.runs ?? (o.factory !== null && o.facts !== null ? runsFromEvents(o.factory, o.facts) : [])
  return {
    now: o.now,
    repo: o.repo,
    device: o.device,
    loadedAt: o.loadedAt,
    sources: o.sources,
    usage: o.usage ?? UNAVAILABLE,
    issues,
    queue: o.queue ?? [],
    runs,
    pool: o.pool,
    agents: o.agents,
    milestone: o.milestone,
    ledger: o.ledger,
    control: o.control,
    lastTitle: o.lastTitle,
    githubBackoffUntil: o.githubBackoffUntil,
    checkout: o.checkout ?? null,
  }
}

// digestOf: a short hash of the state without its clock readings, so a pass that saw nothing
// new is easy to spot in the decision log (SPEC 12). FNV-1a over a stable rendering.
export function digestOf(state: State): string {
  const { now: _now, sources, lastTitle: _title, ...rest } = state
  const quiet = { ...rest, sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.ok])) }
  let hash = 0x811c9dc5
  for (const ch of stable(quiet)) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
