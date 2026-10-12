// What the factory event log says, turned into what plan reads: per-issue and per-run facts,
// pipeline runs (for runSource events: the shadow run and the replay), and a ledger derived
// from what a device already did (SPEC 7.5). Pure: the events come in as values. The keys of
// derived entries are the ones plan would have used, so plan sees the work as done.
import type { Factory, FactoryIssue } from './parse'
import type { AdjudicatorAction, LedgerEntry, RunState, RunView } from './types'

export type FactoryEvent = {
  ts: number
  state: string
  issue: number | null
  run: string | null
  branch: string | null
  pr: number | null
  head: string | null
  note: string | null
  actor: string | null
  device: string | null
}

// The events plan and the derivation need, for one repo, up to :'at', over :'days' days.
// Run through `dev-query --csv -v repo=.. -v at=.. -v days=..` with the SQL on stdin.
export const EVENTS_SQL = `select
  to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
  state, issue, run_id, branch, pr, head, note, actor, device
from factory.events
where repo = :'repo'
  and ts <= :'at'::timestamptz
  and ts > :'at'::timestamptz - make_interval(days => :'days'::int)
  and state in ('ready', 'claimed', 'renewed', 'reclaimed', 'closed', 'delegated', 'verdict',
    'fix_requested', 'parked', 'failed', 'merge_ready', 'head_mismatch', 'conflict', 'ci_stalled',
    'merged', 'abandoned', 'superseded', 'rebased_behind')
order by ts, seq;
`

const PIPELINE = ['parked', 'failed', 'merge_ready', 'head_mismatch', 'conflict', 'ci_stalled']

export function eventsFromRows(rows: Record<string, string>[]): FactoryEvent[] {
  const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v))
  const str = (v: string | undefined) => (v === undefined || v === '' ? null : v)
  const events: FactoryEvent[] = []
  for (const r of rows) {
    const ts = Date.parse(r.ts ?? '')
    if (Number.isNaN(ts) || !r.state) continue
    events.push({
      ts,
      state: r.state,
      issue: num(r.issue),
      run: str(r.run_id),
      branch: str(r.branch),
      pr: num(r.pr),
      head: str(r.head),
      note: str(r.note),
      actor: str(r.actor),
      device: str(r.device),
    })
  }
  return events.sort((a, b) => a.ts - b.ts)
}

export type Facts = {
  briefs: Map<number, string>
  reviewFixes: Map<string, number>
  verdicts: Map<string, string[]>
  superseded: Set<string>
  pipeline: Map<string, FactoryEvent[]>
  // per run, when a gate of it was last answered (a verdict or a review fix)
  answered: Map<string, number>
}

// factsOf: what plan reads from the log (SPEC 3.3 `facts`).
export function factsOf(events: FactoryEvent[]): Facts {
  const facts: Facts = {
    briefs: new Map(),
    reviewFixes: new Map(),
    verdicts: new Map(),
    superseded: new Set(),
    pipeline: new Map(),
    answered: new Map(),
  }
  for (const e of events) {
    if (e.state === 'delegated' && e.issue !== null) {
      const url = e.note?.match(/https:\/\/github\.com\/\S+\/issues\/\d+#issuecomment-\d+/)?.[0]
      if (url !== undefined) facts.briefs.set(e.issue, url)
    } else if (e.state === 'fix_requested' && e.run !== null && e.note === 'review') {
      facts.reviewFixes.set(e.run, (facts.reviewFixes.get(e.run) ?? 0) + 1)
    } else if (e.state === 'verdict' && e.run !== null && e.note !== null) {
      const list = facts.verdicts.get(e.run) ?? []
      list.push(e.note)
      facts.verdicts.set(e.run, list.slice(-20))
    } else if (e.state === 'superseded' && e.run !== null) {
      facts.superseded.add(e.run)
    }
    if ((e.state === 'verdict' || e.state === 'fix_requested') && e.run !== null) {
      facts.answered.set(e.run, Math.max(facts.answered.get(e.run) ?? 0, e.ts))
    }
    if ((PIPELINE.includes(e.state) || e.state === 'merged') && e.branch !== null) {
      const list = facts.pipeline.get(e.branch) ?? []
      list.push(e)
      facts.pipeline.set(e.branch, list)
    }
  }
  return facts
}

function branchOf(facts: Facts, run: string): string | null {
  for (const [branch, list] of facts.pipeline) if (list.some(e => e.run === run)) return branch
  return null
}

const RUN_STATE: Record<string, RunState> = {
  merge_ready: 'merge-ready',
  head_mismatch: 'head-mismatch',
  conflict: 'conflict',
  ci_stalled: 'ci-stalled',
}

// runsFromEvents: each live issue's current run as plan sees it, from the mirror's stage
// refined by the watcher's events: merge-ready, head-mismatch, conflict, ci-stalled and
// cancelled, which the mirror cannot tell apart, and a park not yet answered, which the mirror
// can miss. The step is unknown here: the log does not record it.
export function runsFromEvents(factory: Factory, facts: Facts): RunView[] {
  const runs: RunView[] = []
  for (const issue of factory.issues) {
    if (issue.ended) continue
    // The mirror syncs every few minutes: a run the watcher has already seen for the issue, newer
    // than the mirror's, is the current one (ULIDs sort by creation time).
    const seen = [...facts.pipeline.values()]
      .flat()
      .filter(e => e.issue === issue.number && e.run !== null && e.run !== 'unknown' && !facts.superseded.has(e.run))
      .map(e => e.run as string)
    const run = [issue.run, ...seen].filter((r): r is string => r !== null).sort().pop()
    if (run === undefined) continue
    const branch = branchOf(facts, run)
    if (branch === null) continue
    const events = (facts.pipeline.get(branch) ?? []).filter(e => e.run === run || e.run === 'unknown')
    const last = events[events.length - 1]
    const lastPark = [...events].reverse().find(e => e.state === 'parked')
    // a run newer than the mirror's has no mirror stage yet: the watcher's events decide
    const stageOf = run === issue.run ? issue : { ...issue, stage: 'in pipeline' as const }
    const state = runState(stageOf, last, lastPark, facts.answered.get(run) ?? 0)
    if (state === null) continue
    runs.push({
      branch,
      issue: issue.number,
      run,
      state,
      head: last?.head ?? null,
      step: null,
      detail: state === 'ci-stalled' || state === 'head-mismatch' ? (last?.note ?? null) : null,
      pr: issue.pr,
      since: last?.ts ?? issue.stageSince,
      reviewFixRounds: facts.reviewFixes.get(run) ?? 0,
      verdicts: facts.verdicts.get(run) ?? [],
      superseded: facts.superseded.has(run),
    })
  }
  return runs.sort((a, b) => (a.issue ?? 0) - (b.issue ?? 0))
}

function runState(
  issue: FactoryIssue,
  last: FactoryEvent | undefined,
  lastPark: FactoryEvent | undefined,
  answeredAt: number,
): RunState | null {
  switch (issue.stage) {
    case 'parked':
      return 'parked'
    case 'in pipeline': {
      const refined = last === undefined ? undefined : RUN_STATE[last.state]
      // a refinement counts only while it is newer than the run's last park
      if (refined !== undefined && (lastPark === undefined || last!.ts > lastPark.ts)) return refined
      // The mirror keeps a run's latest row only, so a past park, or one it has not synced yet,
      // shows as running: a park the log shows no answer to is still waiting.
      if (lastPark !== undefined && last === lastPark && answeredAt < lastPark.ts) return 'parked'
      return 'running'
    }
    case 'ready to merge':
      // a completed run with an open PR: a green run left unmerged is the loop's to merge
      return 'merge-ready'
    case 'implementing':
      if (last?.state !== 'failed') return null
      return last.note === 'cancelled' ? 'cancelled' : 'failed'
    default:
      return null
  }
}

// deriveLedger: the ledger entries a device's own events prove, keyed as plan keys them
// (SPEC 7.5). Only what is observable: claims, heartbeats, sweeps, designers in flight,
// delegations, adjudicated gates and their responds, merges and rebase-only updates.
export function deriveLedger(events: FactoryEvent[], factory: Factory, facts: Facts, device: string): LedgerEntry[] {
  const out = new Map<string, LedgerEntry>()
  const put = (entry: LedgerEntry) => out.set(entry.key, entry)
  const base = { class: 'free' as const, rule: 'derived', issue: null, run: null, pr: null, head: null, status: 'done' as const, attempts: 1 }
  const own = events.filter(e => e.device === device)

  const lastOf = (pred: (e: FactoryEvent) => boolean) => [...own].reverse().find(pred)
  const beat = lastOf(e => e.state === 'renewed')
  if (beat !== undefined) put({ ...base, key: 'heartbeat:derived', kind: 'heartbeat', startedAt: beat.ts, endedAt: beat.ts })
  const sweep = lastOf(e => e.actor === 'sweep')
  if (sweep !== undefined) put({ ...base, key: 'sweep:derived', kind: 'sweep', startedAt: sweep.ts, endedAt: sweep.ts })

  for (const e of own) {
    if (e.state === 'claimed' && e.issue !== null) {
      put({
        ...base,
        key: `claim:${e.issue}:derived:${e.ts}`,
        kind: 'claim',
        class: 'start',
        issue: e.issue,
        startedAt: e.ts,
        endedAt: e.ts,
        outcome: { kind: 'claim', result: 'claimed' },
      })
    } else if (e.state === 'delegated' && e.issue !== null) {
      const brief = facts.briefs.get(e.issue)
      if (brief !== undefined) {
        put({ ...base, key: `delegate:${e.issue}:${brief}`, kind: 'delegate', class: 'develop', issue: e.issue, startedAt: e.ts, endedAt: e.ts })
      }
    } else if (e.state === 'merged' && e.pr !== null) {
      put({
        ...base,
        key: `merge:${e.pr}:${e.head ?? 'unknown'}`,
        kind: 'merge',
        issue: e.issue,
        pr: e.pr,
        head: e.head,
        startedAt: e.ts,
        endedAt: e.ts,
        outcome: { kind: 'merge', result: 'merged', rollout: null, closeIssue: null, line: 'derived' },
      })
    } else if (e.state === 'rebased_behind' && e.pr !== null && e.branch !== null) {
      const before = [...(facts.pipeline.get(e.branch) ?? [])].reverse().find(p => p.ts < e.ts && p.head !== null && p.head !== e.head)
      const from = before?.head ?? null
      if (from !== null) {
        put({
          ...base,
          key: `update-behind:${e.pr}:${from}`,
          kind: 'update-behind',
          issue: e.issue,
          pr: e.pr,
          head: from,
          startedAt: e.ts,
          endedAt: e.ts,
          outcome: { kind: 'update-behind', result: 'updated', from, to: e.head, line: 'derived' },
        })
      }
    }
  }

  // A designer is in flight for each issue this device holds in design: no action is due.
  for (const issue of factory.issues) {
    if (issue.ended || issue.stage !== 'designing' || issue.holder !== device) continue
    const life = issue.stageSince ?? 0
    put({ ...base, key: `design:${issue.number}:${life}`, kind: 'spawn', agent: 'designer', class: 'develop', issue: issue.number, status: 'running', startedAt: life, endedAt: null })
  }

  // Each gate the device adjudicated: the park it answered, its verdicts, and the respond.
  for (const list of facts.pipeline.values()) {
    const parks = list.filter(e => e.state === 'parked' && e.run !== null && e.device === device)
    for (let i = 0; i < parks.length; i++) {
      const park = parks[i] as FactoryEvent
      const until = parks[i + 1]?.ts ?? Number.POSITIVE_INFINITY
      const inPark = (e: FactoryEvent) => e.run === park.run && e.ts >= park.ts && e.ts < until
      const verdicts = own.filter(e => e.state === 'verdict' && inPark(e))
      if (verdicts.length === 0) continue
      const fixed = own.find(e => e.state === 'fix_requested' && inPark(e))
      const action: AdjudicatorAction = fixed
        ? { type: 'fix', findings: null, instructions: null, addFinding: null }
        : { type: 'approve', reason: null }
      const at = `${park.run}:null:${park.head}`
      const answeredAt = (verdicts[verdicts.length - 1] as FactoryEvent).ts
      const common = { ...base, issue: park.issue, run: park.run, head: park.head, startedAt: park.ts, endedAt: answeredAt }
      put({
        ...common,
        key: `adjudicate:${at}`,
        kind: 'spawn',
        agent: 'adjudicator',
        class: 'drive',
        outcome: { kind: 'adjudicator', verdicts: verdicts.map(v => v.note ?? ''), action },
      })
      put({ ...common, key: `respond:${at}:${action.type}`, kind: 'respond', class: 'drive', startedAt: answeredAt })
    }
  }
  return [...out.values()].sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : 1))
}
