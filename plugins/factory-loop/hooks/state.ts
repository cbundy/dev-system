// buildState: what observe read, assembled into the State plan takes (SPEC 3.1, 3.2). Pure,
// so the pass driver, the shadow run and the replay harness build state the same way.
import type { Facts } from './derive'
import { runsFromEvents } from './derive'
import type { Factory, IssueFacts } from './parse'
import type {
  AgentView,
  Brief,
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
  // runSource local: the pipeline watcher's runs; null for runSource events (built here)
  runs: RunView[] | null
  queue: number[] | null
  github: Map<number, GithubIssue>
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
}

const UNAVAILABLE: Usage = { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true }

export function buildState(o: Observed): State {
  const tracker = new RegExp(o.trackerTitle, 'i')
  const numbers = new Set<number>()
  for (const issue of o.factory?.issues ?? []) numbers.add(issue.number)
  for (const n of o.queue ?? []) numbers.add(n)
  for (const entry of o.ledger) if (entry.issue !== null) numbers.add(entry.issue)

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
  }
}
