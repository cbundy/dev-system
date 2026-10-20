// The records rebuilt from this device's `transition` events (docs/factory-loop/v2/SPEC.md 3.3):
// the newest per issue over REBUILD_DAYS, every record field read from its note by events.ts, the
// one seam that writes and parses v2's events (7.1). Act mode rebuilds when the store holds no
// records; observe mode reads the store's, else this. A step in flight is not
// rebuilt: S2 starts the same attempt again, and an agent step first looks for an answer already
// recorded for its key (10.8). A record closed more than RECORD_KEEP_MS ago is left out, as the
// store prunes it.
//
// Pure: the events come in as values.
import type { FactoryEvent } from '../derive'
import { readEvent } from './event-reader'
import { parseTransition } from './events'
import type { TransitionEvent } from './events'
import { lifeAt } from './keys'
import { partsOfData } from './park-parts'
import { CLOSED_WHYS, ISSUE_STATES, STEP_KINDS } from './types'
import type { IssueRecord, IssueState, WaitCondition } from './types'

export const REBUILD_DAYS = 90
const KEEP_MS = 7 * 86_400_000

// The dev-query SQL that reads the events a rebuild needs, with the variables repo, device, at and
// days: this device's `transition` events of the repo, oldest first, in the columns derive.ts
// eventsFromRows reads.
export const REBUILD_SQL: string | null = `select
  to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
  state, issue, run_id, branch, pr, head, note, actor, device
from factory.events
where repo = :'repo'
  and device = :'device'
  and state = 'transition'
  and ts <= :'at'::timestamptz
  and ts > :'at'::timestamptz - make_interval(days => :'days'::int)
order by ts, seq;
`

// The same read from the new store (factory.event_store, `dev-query --factory --csv`): the envelope
// columns and the payload as `data`, in the order a rebuild keeps (ts, device, device_seq). Variables
// as REBUILD_SQL's. Not the event_log view: the payload fields a rebuild needs are not all lifted
// into columns (approved_patch, cut, wait, pr_closed_at are not x-column).
export const NEW_REBUILD_SQL = `select
  envelope, event_id,
  to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
  type, type_version, repo, device, actor, session_id, issue, base_image, dev_image, template_version,
  plugin_version, device_seq, data
from factory.event_store
where repo = :'repo'
  and device = :'device'
  and type = 'transition'
  and ts <= :'at'::timestamptz
  and ts > :'at'::timestamptz - make_interval(days => :'days'::int)
order by ts, device, device_seq;
`

// A transition event's parser: its row read back into the event, or null when it is not one.
export type TransitionParser = (row: Pick<FactoryEvent, 'state' | 'issue' | 'branch' | 'pr' | 'head' | 'note'>) => TransitionEvent | null

// recordsFromEvents: the newest record per issue among this device's transition events: of its
// newest life, its highest seq (a transition logged again after a re-claim, 4.1, carries the same
// seq); closed records past the store's keep time are left out. The note is read by events.ts's
// parser; a test may pass its own.
export function recordsFromEvents(list: readonly FactoryEvent[], device: string, parse: TransitionParser = parseTransition): IssueRecord[] {
  const found: { record: IssueRecord; ts: number }[] = []
  for (const e of list) {
    if (e.state !== 'transition' || (e.device !== null && e.device !== device)) continue
    let t: TransitionEvent | null
    try {
      t = parse(e)
    } catch {
      t = null
    }
    if (t !== null) found.push({ record: t.record, ts: e.ts })
  }
  return newestRecords(found, Math.max(0, ...list.map(e => e.ts)))
}

// newestRecords: the newest record per issue of the found ones, those closed past the keep time at
// `at` left out, by issue.
function newestRecords(found: readonly { record: IssueRecord; ts: number }[], at: number): IssueRecord[] {
  const newest = new Map<number, { record: IssueRecord; ts: number }>()
  for (const f of found) {
    const seen = newest.get(f.record.issue)
    if (seen === undefined || newer(f.record, f.ts, seen.record, seen.ts)) newest.set(f.record.issue, f)
  }
  return [...newest.values()]
    .map(x => x.record)
    .filter(r => r.state !== 'closed' || at - r.since <= KEEP_MS)
    .sort((a, b) => a.issue - b.issue)
}

// recordsFromNewRows: the same records from the rows of NEW_REBUILD_SQL. Nothing is skipped: a row of
// an unknown type or version, or whose payload the shared reader or the record's own checks refuse,
// throws an Error that names its event_id and the source `new`, so the whole read fails.
export function recordsFromNewRows(rows: readonly Record<string, string>[]): IssueRecord[] {
  const found: { record: IssueRecord; ts: number }[] = []
  for (const row of rows) {
    try {
      found.push(recordOfRow(row))
    } catch (err) {
      throw new Error(`source new: event ${row.event_id ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    }
  }
  return newestRecords(found, Math.max(0, ...found.map(f => f.ts)))
}

const isState = (v: unknown): v is IssueState => ISSUE_STATES.some(s => s === v)

function recordOfRow(row: Record<string, string>): { record: IssueRecord; ts: number } {
  const ts = Date.parse(row.ts ?? '')
  if (Number.isNaN(ts)) throw new Error('ts does not read')
  if (row.type !== 'transition') throw new Error(`unknown type ${row.type ?? ''}`)
  let data: unknown
  try {
    data = JSON.parse(row.data ?? '')
  } catch {
    throw new Error('data is not JSON')
  }
  const e = readEvent({ envelope: Number(row.envelope), type: row.type, type_version: Number(row.type_version), data })
  const d = e.data
  const issue = row.issue === undefined || row.issue === '' ? NaN : Number(row.issue)
  if (!Number.isInteger(issue)) throw new Error('issue is missing')
  const to = d.to_state
  const resumeTo = d.resume_to
  const step = d.step
  const why = d.why
  if (!isState(to) || (resumeTo !== null && !isState(resumeTo))) throw new Error('state is not one the loop knows')
  if (step !== null && !STEP_KINDS.some(s => s === step)) throw new Error(`step ${String(step)} is not one the loop knows`)
  if (why !== null && !CLOSED_WHYS.some(w => w === why)) throw new Error(`why ${String(why)} is not one the loop knows`)
  const seqAt = Date.parse(String(d.seq_at))
  const since = Date.parse(String(d.state_since))
  if (Number.isNaN(seqAt) || Number.isNaN(since)) throw new Error('seq_at or state_since does not read')
  const record: IssueRecord = {
    issue,
    life: d.life as string,
    seq: d.seq as number,
    seqAt,
    state: to,
    since,
    resumeTo,
    branch: d.branch as string,
    pr: d.pr as number | null,
    head: d.head as string | null,
    approvedPatch: d.approved_patch as string | null,
    brief: d.brief_url as string | null,
    step: step as IssueRecord['step'],
    attempt: d.attempt as number,
    cut: d.cut as boolean,
    triages: d.triages as number,
    fixes: d.fixes as number,
    round: d.round as number,
    question: d.question as string | null,
    parts: partsOfData(d),
    wait: d.wait as WaitCondition[] | null,
    why: why as IssueRecord['why'],
    notes: d.notes as string[],
    prClosedAt: d.pr_closed_at as string | null,
    lives: d.lives as number,
  }
  return { record, ts }
}

// newer: a's record is newer than b's: a later life, then a higher seq, then a later event.
function newer(a: IssueRecord, aTs: number, b: IssueRecord, bTs: number): boolean {
  const la = lifeAt(a.life) ?? 0
  const lb = lifeAt(b.life) ?? 0
  if (la !== lb) return la > lb
  if (a.seq !== b.seq) return a.seq > b.seq
  return aTs >= bTs
}
