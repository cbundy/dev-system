// What the factory event log says, turned into what plan reads: per-issue and per-run facts,
// pipeline runs (for runSource events: the shadow run and the replay), and a ledger derived
// from what a device already did (SPEC 7.5). Pure: the events come in as values. The keys of
// derived entries are the ones plan would have used, so plan sees the work as done. The loop's
// own `loop` events (D-09) carry its ledger entries, so a lost store is rebuilt from them.
import { ACTION_KINDS } from './config'
import type { Factory, FactoryIssue } from './parse'
import type {
  ActionClass,
  AdjudicatorAction,
  AgentType,
  Bump,
  LedgerEntry,
  LedgerStatus,
  MergeFlag,
  MergeReport,
  Outcome,
  Rollout,
  RunState,
  RunView,
} from './types'

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
    'merged', 'abandoned', 'superseded', 'rebased_behind', 'loop')
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
// can miss. The step is unknown here: the log does not record it, so a parked run's `since` is
// its park's time, which tells its gates apart (plan's gateOf).
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
      since: (state === 'parked' ? lastPark?.ts : undefined) ?? last?.ts ?? issue.stageSince,
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
// (SPEC 7.5): claims, heartbeats, sweeps, designers in flight, delegations, adjudicated gates
// and their responds, merges and rebase-only updates, and every entry the loop logged in a
// `loop` event (the latest per key), which wins over what the other events suggest.
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
      // the event carries no rollout, but the device that merged ran its follow-ups then, so it
      // counts as read: rule M7 must not take a rebuilt merge for one whose rollout read failed
      if (e.issue !== null) {
        put({
          ...base,
          key: `rollout:${e.issue}`,
          kind: 'rollout',
          issue: e.issue,
          pr: e.pr,
          startedAt: e.ts,
          endedAt: e.ts,
          outcome: { kind: 'rollout', rollout: null, closeIssue: null },
        })
      }
    } else if (e.state === 'merged' && e.issue !== null) {
      // a merge noted with no PR (the owner's hand merge, logged by the device): the device saw
      // it, so its rollout counts as handled (rule M7)
      put({
        ...base,
        key: `rollout:${e.issue}`,
        kind: 'rollout',
        issue: e.issue,
        startedAt: e.ts,
        endedAt: e.ts,
        outcome: { kind: 'rollout', rollout: null, closeIssue: null },
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
      const at = `${park.run}:park@${park.ts}:${park.head}`
      const answeredAt = (verdicts[verdicts.length - 1] as FactoryEvent).ts
      const common = { ...base, issue: park.issue, run: park.run, head: park.head, startedAt: park.ts, endedAt: answeredAt }
      put({
        ...common,
        key: `adjudicate:${at}`,
        kind: 'spawn',
        agent: 'adjudicator',
        class: 'drive',
        outcome: { kind: 'adjudicator', verdicts: verdicts.map(v => v.note ?? ''), action, report: null },
      })
      put({ ...common, key: `respond:${at}:${action.type}`, kind: 'respond', class: 'drive', startedAt: answeredAt })
    }
  }

  for (const e of [...own].sort((a, b) => a.ts - b.ts)) {
    const entry = e.state === 'loop' ? entryFromLoop(e) : null
    if (entry !== null) put(entry)
  }
  return [...out.values()].sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : 1))
}

// --- the loop's own events (SPEC 7.4, 7.5, D-09) ------------------------------------------------

// The note stays short enough for one event row; free text (reasons, instructions, verdict
// lines, the report's summary) is left out: plan needs none of it to rebuild a hold exactly.
export const LOOP_NOTE_MAX = 500

const STATUSES: readonly LedgerStatus[] = ['running', 'done', 'failed', 'timed-out', 'lost']
const CLASSES: readonly ActionClass[] = ['free', 'owner', 'drive', 'develop', 'start']
const AGENT_TYPES: readonly AgentType[] = ['designer', 'implementer', 'adjudicator', 'fixer']
const ROLLOUTS: readonly Rollout[] = ['merge', 'run-it', 'keep-open']
const BUMPS: readonly Bump[] = ['patch', 'minor', 'major']
const FLAGS: readonly MergeFlag[] = ['image', 'template', 'restart', 'run-it']

// A value holds no spaces: '%' and whitespace are percent-encoded, so URLs stay readable.
const enc = (v: string) => v.replace(/[%\s]/g, c => encodeURIComponent(c))
const dec = (v: string) => {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}
const opt = (v: string | null) => (v === null ? 'none' : enc(v))
const list = (v: readonly (string | number)[]) => (v.length === 0 ? 'none' : v.join(','))
const yn = (v: boolean) => (v ? 'yes' : 'no')

// loopNote: a ledger entry as a `loop` event's note: `kind=<kind> key=<key> status=<status>
// attempts=<n>`, then class, rule, the start and end times, the agent type, agent id and wake
// name when set, and `out=<outcome kind>` with the outcome fields plan reads. The entry's
// issue, run, PR and head travel in the event's own columns (loopEventArgs). A guard outcome is
// not carried: a lost guard simply runs again (rule M1).
export function loopNote(entry: LedgerEntry): string {
  const head = [
    `kind=${entry.kind}`,
    `key=${enc(entry.key)}`,
    `status=${entry.status}`,
    `attempts=${entry.attempts}`,
    `class=${entry.class}`,
    `rule=${enc(entry.rule)}`,
    `started=${entry.startedAt}`,
  ]
  if (entry.endedAt !== null) head.push(`ended=${entry.endedAt}`)
  if (entry.agent !== undefined) head.push(`agent=${entry.agent}`)
  if (entry.agentId !== undefined) head.push(`agentId=${enc(entry.agentId)}`)
  if (entry.wake !== undefined) head.push(`wake=${enc(entry.wake)}`)
  const full = [...head, ...outcomeTokens(entry.outcome)].join(' ')
  // too long for one row: the entry is kept without its outcome, as if it had none parsed
  return full.length <= LOOP_NOTE_MAX ? full : head.join(' ')
}

// loopEventArgs: the callum-flow-event arguments that log an entry: its issue, run, PR and head
// as columns, and loopNote as the note.
export function loopEventArgs(entry: LedgerEntry): string[] {
  const args = ['loop']
  if (entry.issue !== null) args.push('--issue', String(entry.issue))
  if (entry.run !== null) args.push('--run', entry.run)
  if (entry.pr !== null) args.push('--pr', String(entry.pr))
  if (entry.head !== null) args.push('--head', entry.head)
  args.push('--note', loopNote(entry))
  return args
}

function outcomeTokens(o: Outcome | undefined): string[] {
  if (o === undefined) return []
  switch (o.kind) {
    case 'cli':
      return ['out=cli', `exit=${o.exit}`]
    case 'claim':
      return ['out=claim', `result=${o.result}`]
    case 'designer':
      return 'unparsed' in o
        ? ['out=designer', 'unparsed=yes']
        : ['out=designer', `brief=${opt(o.brief)}`, `created=${list(o.created)}`, `pending=${yn(o.pendingDecision)}`]
    case 'adjudicator':
      return ['out=adjudicator', `action=${o.action.type}`, ...(o.report === null ? [] : [`bump=${o.report.bump}`, `flags=${list(o.report.flags)}`])]
    case 'handoff':
      return ['out=handoff', `notgated=${yn(o.notGated)}`, `run=${opt(o.run)}`, `head=${opt(o.head)}`, `branch=${opt(o.newBranch)}`]
    case 'guard':
    case 'respond':
      // a lost guard re-runs (M1), and a respond settles by the run moving (P3a)
      return []
    case 'update-behind':
      return ['out=update-behind', `result=${o.result}`, `from=${opt(o.from)}`, `to=${opt(o.to)}`]
    case 'merge':
      return ['out=merge', `result=${o.result}`, `rollout=${o.rollout ?? 'none'}`, `close=${o.closeIssue ?? 'none'}`]
    case 'rollout':
      return ['out=rollout', `rollout=${o.rollout ?? 'none'}`, `close=${o.closeIssue ?? 'none'}`]
    case 'wake': {
      const f = o.fields
      return [
        'out=wake',
        `decision=${enc(o.decision)}`,
        ...(o.bump === null ? [] : [`bump=${o.bump}`]),
        ...('brief' in f ? [`brief=${opt(typeof f.brief === 'string' ? f.brief : null)}`] : []),
        ...(Array.isArray(f.created) ? [`created=${list(f.created)}`] : []),
        ...(typeof f.pendingDecision === 'boolean' ? [`pending=${yn(f.pendingDecision)}`] : []),
      ]
    }
  }
}

// entryFromLoop: the ledger entry a `loop` event carries (loopNote's inverse), or null when the
// event is not one or its note does not parse. Left-out free text comes back empty.
export function entryFromLoop(e: FactoryEvent): LedgerEntry | null {
  if (e.state !== 'loop' || e.note === null) return null
  const f = new Map<string, string>()
  for (const token of e.note.split(' ')) {
    const i = token.indexOf('=')
    if (i > 0) f.set(token.slice(0, i), token.slice(i + 1))
  }
  const kind = ACTION_KINDS.find(k => k === f.get('kind'))
  const status = STATUSES.find(s => s === f.get('status'))
  const klass = CLASSES.find(c => c === f.get('class'))
  const key = f.get('key')
  const attempts = Number(f.get('attempts'))
  const startedAt = Number(f.get('started'))
  const ended = f.get('ended')
  if (kind === undefined || kind === 'guard' || status === undefined || klass === undefined || key === undefined) return null
  if (!Number.isInteger(attempts) || attempts < 0 || !Number.isFinite(startedAt)) return null
  const entry: LedgerEntry = {
    key: dec(key),
    kind,
    class: klass,
    rule: dec(f.get('rule') ?? 'loop'),
    issue: e.issue,
    run: e.run,
    pr: e.pr,
    head: e.head,
    status,
    attempts,
    startedAt,
    endedAt: ended !== undefined && Number.isFinite(Number(ended)) ? Number(ended) : status === 'running' ? null : e.ts,
  }
  const agent = AGENT_TYPES.find(a => a === f.get('agent'))
  if (agent !== undefined) entry.agent = agent
  const agentId = f.get('agentId')
  if (agentId !== undefined) entry.agentId = dec(agentId)
  const wake = f.get('wake')
  if (wake !== undefined) entry.wake = dec(wake)
  const outcome = outcomeOf(f)
  if (outcome !== undefined) entry.outcome = outcome
  return entry
}

function outcomeOf(f: Map<string, string>): Outcome | undefined {
  const none = (v: string | undefined) => (v === undefined || v === 'none' ? null : dec(v))
  const nums = (v: string | undefined) => (v === undefined || v === 'none' ? [] : v.split(',').map(Number).filter(n => Number.isInteger(n)))
  const rollout = ROLLOUTS.find(r => r === f.get('rollout')) ?? null
  const close = Number(f.get('close'))
  const closeIssue = Number.isInteger(close) && close > 0 ? close : null
  const bump = BUMPS.find(b => b === f.get('bump')) ?? null
  switch (f.get('out')) {
    case 'cli': {
      const exit = Number(f.get('exit'))
      return Number.isInteger(exit) ? { kind: 'cli', exit } : undefined
    }
    case 'claim': {
      const result = f.get('result')
      return result === 'claimed' || result === 'lost' ? { kind: 'claim', result } : undefined
    }
    case 'designer':
      return f.get('unparsed') === 'yes'
        ? { kind: 'designer', unparsed: true }
        : { kind: 'designer', brief: none(f.get('brief')), created: nums(f.get('created')), pendingDecision: f.get('pending') === 'yes' }
    case 'adjudicator': {
      const action = actionOf(f.get('action'))
      if (action === undefined) return undefined
      const flags = (none(f.get('flags'))?.split(',') ?? []).flatMap(x => FLAGS.filter(flag => flag === x))
      const report: MergeReport | null = bump === null ? null : { summary: '', bump, bumpReason: '', flags }
      return { kind: 'adjudicator', verdicts: [], action, report }
    }
    case 'handoff':
      return { kind: 'handoff', notGated: f.get('notgated') === 'yes', run: none(f.get('run')), head: none(f.get('head')), newBranch: none(f.get('branch')) }
    case 'update-behind': {
      const result = f.get('result')
      if (result !== 'updated' && result !== 'fail' && result !== 'skip') return undefined
      return { kind: 'update-behind', result, from: none(f.get('from')), to: none(f.get('to')), line: '' }
    }
    case 'merge': {
      const result = f.get('result')
      if (result !== 'merged' && result !== 'refused') return undefined
      return { kind: 'merge', result, rollout, closeIssue, line: '' }
    }
    case 'rollout':
      return { kind: 'rollout', rollout, closeIssue }
    case 'wake': {
      const decision = f.get('decision')
      if (decision === undefined) return undefined
      const fields: Record<string, string | number | boolean | number[] | null> = {}
      if (f.has('brief')) fields.brief = none(f.get('brief'))
      if (f.has('created')) fields.created = nums(f.get('created'))
      if (f.has('pending')) fields.pendingDecision = f.get('pending') === 'yes'
      return { kind: 'wake', decision: dec(decision), reason: null, instructions: null, bump, bumpReason: null, fields }
    }
    default:
      return undefined
  }
}

function actionOf(type: string | undefined): AdjudicatorAction | undefined {
  switch (type) {
    case 'approve':
      return { type, reason: null }
    case 'fix':
      return { type, findings: null, instructions: null, addFinding: null }
    case 'skip':
    case 'merge':
      return { type }
    case 'escalate':
      return { type, why: '' }
    case 'fixer':
      return { type, instructions: '' }
    case 'hold':
      return { type, reason: '' }
    default:
      return undefined
  }
}
