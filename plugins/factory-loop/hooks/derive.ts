// What the factory event log says, turned into what plan reads: per-issue and per-run facts,
// pipeline runs, and a ledger derived from what a device already did (v2 SPEC 13.7.5). Pure: the events
// come in as values. The keys of derived entries are the ones plan would have used, so plan sees
// the work as done. The loop's own `loop` events (D-09) carry its ledger entries, so a lost store
// is rebuilt from them.
import { ACTION_KINDS } from './config'
import { iso } from './v2/event-native'
import type { Factory, FactoryIssue } from './parse'
import type { ActionClass, Bump, LedgerEntry, LedgerStatus, Outcome, Rollout, RunState, RunView } from './types'

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

// The events plan and the derivation need, for one repo, up to :'at', over :'days' days, v2's
// three states among them (v2 SPEC 7.1; v2/record.ts rebuilds records from `transition`). Run
// through `dev-query --csv -v repo=.. -v at=.. -v days=..` with the SQL on stdin.
export const EVENTS_SQL = `select
  to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
  state, issue, run_id, branch, pr, head, note, actor, device
from factory.events
where repo = :'repo'
  and ts <= :'at'::timestamptz
  and ts > :'at'::timestamptz - make_interval(days => :'days'::int)
  and state in ('ready', 'claimed', 'renewed', 'reclaimed', 'closed', 'delegated', 'verdict',
    'fix_requested', 'parked', 'failed', 'merge_ready', 'head_mismatch', 'conflict', 'ci_stalled',
    'merged', 'abandoned', 'superseded', 'rebased_behind', 'loop', 'transition', 'reviewed', 'intervention')
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
  // per issue, its newest `reclaimed` event: a sweep or a release gave the claim back (v2 H1)
  reclaimed: Map<number, number>
  // per issue, its newest `ready` event
  readyAt: Map<number, number>
}

// factsOf: what plan reads from the log (v2 SPEC 13.3.3 `facts`).
export function factsOf(events: FactoryEvent[]): Facts {
  const facts: Facts = {
    briefs: new Map(),
    reviewFixes: new Map(),
    verdicts: new Map(),
    superseded: new Set(),
    pipeline: new Map(),
    answered: new Map(),
    reclaimed: new Map(),
    readyAt: new Map(),
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
    } else if (e.state === 'reclaimed' && e.issue !== null) {
      facts.reclaimed.set(e.issue, Math.max(facts.reclaimed.get(e.issue) ?? 0, e.ts))
    } else if (e.state === 'ready' && e.issue !== null) {
      facts.readyAt.set(e.issue, Math.max(facts.readyAt.get(e.issue) ?? 0, e.ts))
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
// (v2 SPEC 13.7.5): claims, heartbeats, sweeps, the rollouts of merges, and every entry the loop logged
// in a `loop` event (the latest per key), which wins over what the other events suggest.
export function deriveLedger(events: FactoryEvent[], device: string): LedgerEntry[] {
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
    } else if (e.state === 'merged' && e.issue !== null) {
      // the event carries no rollout, but the device that merged ran its follow-ups then (and for
      // a merge noted with no PR, the owner's hand merge, the device saw it), so the rollout counts
      // as handled: rule M7 must not take a rebuilt merge for one whose rollout read failed
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
  }

  for (const e of [...own].sort((a, b) => a.ts - b.ts)) {
    const entry = e.state === 'loop' ? entryFromLoop(e) : null
    if (entry !== null) put(entry)
  }
  return [...out.values()].sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : 1))
}

// --- the loop's own events (v2 SPEC 13.7.4, 13.7.5, D-09) ------------------------------------------------

// The note stays short enough for one event row; free text (instructions, verdict lines, the
// report's summary) is left out: plan needs none of it to rebuild a hold exactly. A wake's reason
// is the one exception: it is carried as the last token, one line, shortened to fit and dropped
// before the outcome is (loopNote), for the event log's decision_reason.
export const LOOP_NOTE_MAX = 500
const REASON_MAX = 200
// below this many characters a shortened reason says too little to keep
const REASON_FLOOR = 20

const STATUSES: readonly LedgerStatus[] = ['running', 'done', 'failed', 'timed-out', 'lost']
const CLASSES: readonly ActionClass[] = ['free', 'owner', 'drive', 'develop', 'start']
const ROLLOUTS: readonly Rollout[] = ['merge', 'run-it', 'keep-open']
const BUMPS: readonly Bump[] = ['patch', 'minor', 'major']

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
// attempts=<n>`, then class, rule, the start and end times, the agent id and wake name when set,
// and `out=<outcome kind>` with the outcome fields plan reads. The entry's issue, run, PR and
// head are not carried (loopEntryArgv). A wake's non-empty reason ends the note as
// `reason=<one line, at most 200 characters>`; when the note would pass LOOP_NOTE_MAX the reason is
// shortened (ending `...`, never inside a percent-encoded sequence), then dropped when fewer than
// REASON_FLOOR characters fit, and the outcome is dropped only when it is too long without it.
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
  if (entry.agentId !== undefined) head.push(`agentId=${enc(entry.agentId)}`)
  if (entry.wake !== undefined) head.push(`wake=${enc(entry.wake)}`)
  const base = [...head, ...outcomeTokens(entry.outcome)].join(' ')
  // too long for one row: the entry is kept without its outcome, as if it had none parsed
  if (base.length > LOOP_NOTE_MAX) return head.join(' ')
  const o = entry.outcome
  if (o === undefined || o.kind !== 'wake' || typeof o.reason !== 'string') return base
  const line = Array.from(o.reason.replace(/\s+/g, ' ').trim())
  if (line.length === 0) return base
  const withReason = (chars: string[], cut: boolean) => `${base} reason=${enc(chars.join('') + (cut ? '...' : ''))}`
  const whole = line.length <= REASON_MAX ? withReason(line, false) : withReason(line.slice(0, REASON_MAX - 3), true)
  if (whole.length <= LOOP_NOTE_MAX) return whole
  // enc grows a character by at most 6, so scan down from the longest cut that could fit
  for (let n = Math.min(line.length, REASON_MAX - 3) - 1; n >= REASON_FLOOR; n--) {
    const note = withReason(line.slice(0, n), true)
    if (note.length <= LOOP_NOTE_MAX) return note
  }
  return base
}

// loopEntryArgv: the native call that logs an entry as a `loop_entry` event (v2 SPEC 13.7.4): its
// issue as --issue and the data the translator makes of loopNote(entry), with loopData merged on top
// the way an old line's --data was. Null for a judge, which the event type has no kind for. The
// run, PR and head are not carried.
export function loopEntryArgv(entry: LedgerEntry): string[] | null {
  if (entry.kind === 'judge') return null
  // the translator reads the string `none` as null
  const str = (v: string | undefined) => (v === undefined || v === 'none' ? null : v)
  const data: Record<string, unknown> = {}
  const o = entry.outcome
  const note = loopNote(entry)
  // loopNote drops the whole outcome from a note too long for one row, and then there is no decision
  if (entry.kind === 'task' && o !== undefined && o.kind === 'wake' && note.split(' ').includes('out=wake')) {
    const decision = str(o.decision)
    if (decision !== null) {
      data.decision = decision
      const word = note.split(' ').find(w => w.startsWith('reason='))
      if (word !== undefined) data.decision_reason = (str(dec(word.slice('reason='.length))) ?? '').slice(0, 200) || null
    } else data.decision = null
  }
  Object.assign(data, {
    kind: entry.kind,
    key: str(entry.key),
    status: entry.status,
    attempts: entry.attempts,
    class: entry.class,
    rule: str(entry.rule),
    started_at: iso(entry.startedAt),
    ended_at: entry.endedAt === null ? null : iso(entry.endedAt),
    agent_id: str(entry.agentId),
    wake: str(entry.wake),
    ...entry.loopData,
  })
  const argv = ['callum-flow-event', '--type', 'loop_entry', '--data', JSON.stringify(data)]
  if (entry.issue !== null) argv.push('--issue', String(entry.issue))
  return argv
}

function outcomeTokens(o: Outcome | undefined): string[] {
  if (o === undefined) return []
  switch (o.kind) {
    case 'cli':
      return ['out=cli', `exit=${o.exit}`]
    case 'claim':
      return ['out=claim', `result=${o.result}`]
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
    default:
      // v2's outcomes: v2 rebuilds its records from their transition events, and its agent steps
      // are never rebuilt (entryFromLoop)
      return []
  }
}

// entryFromLoop: the ledger entry a `loop` event carries (loopNote's inverse), or null when the
// event is not one or its note does not parse. Left-out free text comes back empty. A v2 agent
// step's event is for the trail only and is never rebuilt (v2 SPEC 3.3): its result is not in the
// note, so a rebuilt done entry would hold its key with no result to read; left out, S2 dispatches
// the key again and the executor takes the answer already recorded for it (10.8).
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
  if (kind === undefined || kind === 'agent-step' || status === undefined || klass === undefined || key === undefined) return null
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
