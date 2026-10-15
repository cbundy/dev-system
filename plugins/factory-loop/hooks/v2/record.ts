// The records rebuilt from this device's `transition` events (docs/factory-loop/v2/SPEC.md 3.3):
// the newest per issue over REBUILD_DAYS, every record field read from its note by events.ts, the
// one seam that writes and parses v2's events (7.1). Act mode rebuilds when the store holds no
// records; observe mode and the shadow read the store's, else this. A step in flight is not
// rebuilt: S2 starts the same attempt again, and an agent step first looks for an answer already
// recorded for its key (10.8). A record closed more than RECORD_KEEP_MS ago is left out, as the
// store prunes it.
//
// Pure: the events come in as values.
import type { FactoryEvent } from '../derive'
import * as events from './events'
import type { TransitionEvent } from './events'
import { lifeAt } from './keys'
import type { IssueRecord } from './types'

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

// A transition event's parser: its row read back into the event, or null when it is not one.
export type TransitionParser = (row: Pick<FactoryEvent, 'state' | 'issue' | 'branch' | 'pr' | 'head' | 'note'>) => TransitionEvent | null

// events.ts's parser (build unit U4 fills events.ts beside this unit): until it is there, nothing
// is rebuilt.
const PARSE = (events as unknown as { parseTransition?: TransitionParser }).parseTransition

// recordsFromEvents: the newest record per issue among this device's transition events: of its
// newest life, its highest seq (a transition logged again after a re-claim, 4.1, carries the same
// seq); closed records past the store's keep time are left out.
export function recordsFromEvents(list: readonly FactoryEvent[], device: string, parse: TransitionParser | undefined = PARSE): IssueRecord[] {
  if (parse === undefined) return []
  const newest = new Map<number, { record: IssueRecord; ts: number }>()
  for (const e of list) {
    if (e.state !== 'transition' || (e.device !== null && e.device !== device)) continue
    let t: TransitionEvent | null
    try {
      t = parse(e)
    } catch {
      t = null
    }
    if (t === null) continue
    const r = t.record
    const seen = newest.get(r.issue)
    if (seen === undefined || newer(r, e.ts, seen.record, seen.ts)) newest.set(r.issue, { record: r, ts: e.ts })
  }
  const at = Math.max(0, ...list.map(e => e.ts))
  return [...newest.values()]
    .map(x => x.record)
    .filter(r => r.state !== 'closed' || at - r.since <= KEEP_MS)
    .sort((a, b) => a.issue - b.issue)
}

// newer: a's record is newer than b's: a later life, then a higher seq, then a later event.
function newer(a: IssueRecord, aTs: number, b: IssueRecord, bTs: number): boolean {
  const la = lifeAt(a.life) ?? 0
  const lb = lifeAt(b.life) ?? 0
  if (la !== lb) return la > lb
  if (a.seq !== b.seq) return a.seq > b.seq
  return aTs >= bTs
}
