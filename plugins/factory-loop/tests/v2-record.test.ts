// The records rebuilt from this device's `transition` events (docs/factory-loop/v2/SPEC.md 3.3,
// 17.1 property 18): the query reads this device's transition events in the columns the event rows
// are read in; the rebuild keeps the newest record per issue (its newest life, then its highest
// seq), never another device's, and leaves out a record closed past the store's keep time. The
// note's codec is events.ts's: any history of transitions rebuilds the records it left.
import { describe, expect, test } from 'claude-code/testing'

import type { FactoryEvent } from '../hooks/derive'
import { eventsFromRows } from '../hooks/derive'
import { eventNote, parseTransition } from '../hooks/v2/events'
import type { TransitionEvent } from '../hooks/v2/events'
import { lifeOf } from '../hooks/v2/keys'
import { checkIdsOf, checkNote } from '../hooks/v2/prompts-work'
import { NEW_REBUILD_SQL, REBUILD_DAYS, REBUILD_SQL, recordsFromEvents, recordsFromNewRows } from '../hooks/v2/record'
import type { TransitionParser } from '../hooks/v2/record'
import { parkedTell } from '../hooks/v2/rules-entry'
import { madeRecord, nextRecord, normalize, rowFor, viaOf } from '../hooks/v2/table'
import type { IssueRecord, TableEvent } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, OTHER, config, transitionRow } from './fixtures'

const DAY = 24 * 60 * MIN
const CFG = config()

// A test's own codec: the record as JSON in the note. The selection is what these tests check;
// the real note's codec is events.ts's.
const encode = (t: TransitionEvent) => JSON.stringify(t)
const parse: TransitionParser = row => {
  try {
    return row.note === null ? null : (JSON.parse(row.note) as TransitionEvent)
  } catch {
    return null
  }
}

function eventOf(t: TransitionEvent, ts: number, device: string | null = DEVICE, note = encode(t)): FactoryEvent {
  return { ts, state: 'transition', issue: t.record.issue, run: null, branch: t.record.branch, pr: t.record.pr, head: t.record.head, note, actor: null, device }
}

const LIFE = lifeOf(NOW - 3 * DAY)
const record = (n: number, over: Partial<IssueRecord> = {}): IssueRecord => ({ ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 3 * DAY), ...over })
const t = (r: IssueRecord, row = 'T1'): TransitionEvent => ({ state: 'transition', record: r, row, from: null, via: row.toLowerCase() })

describe('the rebuild query (v2 SPEC 3.3)', () => {
  test('it reads this device\'s transition events of the repo over the rebuild window, in the columns the event rows are read in', () => {
    const sql = REBUILD_SQL ?? ''
    expect(sql).toContain(":'repo'")
    expect(sql).toContain("device = :'device'")
    expect(sql).toContain("state = 'transition'")
    expect(sql).toContain("make_interval(days => :'days'::int)")
    expect(sql).toMatch(/order by ts, seq/)
    expect(REBUILD_DAYS).toBe(90)
    for (const column of ['ts', 'state', 'issue', 'run_id', 'branch', 'pr', 'head', 'note', 'actor', 'device']) expect(sql).toContain(column)
    // a row as dev-query prints it reads into an event
    const rows = [{ ts: '2026-10-13T02:00:00.000Z', state: 'transition', issue: '7', run_id: '', branch: 'issue-7', pr: '', head: '', note: 'x', actor: '', device: DEVICE }]
    expect(eventsFromRows(rows)).toEqual([{ ts: NOW - 60 * MIN, state: 'transition', issue: 7, run: null, branch: 'issue-7', pr: null, head: null, note: 'x', actor: null, device: DEVICE }])
  })
})

describe('recordsFromEvents (v2 SPEC 3.3)', () => {
  test('the newest record per issue: its newest life, then its highest seq; a transition logged again after a re-claim counts once', () => {
    const a1 = record(7, { seq: 1 })
    const a2 = record(7, { seq: 2, state: 'designing', step: 'design' })
    const a3 = record(7, { seq: 3, state: 'building', step: 'build' })
    const newer = record(7, { life: lifeOf(NOW - DAY), seq: 1 })
    const b = record(8, { seq: 4, state: 'parked', step: null, question: 'q' })
    const list = [eventOf(t(a1), NOW - 3 * DAY), eventOf(t(a3), NOW - 2 * DAY), eventOf(t(a2), NOW - 2 * DAY - MIN), eventOf(t(b), NOW - DAY), eventOf(t(b, 'H1'), NOW - DAY + MIN)]
    expect(recordsFromEvents(list, DEVICE, parse)).toEqual([a3, b])
    expect(recordsFromEvents([...list, eventOf(t(newer), NOW - DAY)], DEVICE, parse)).toEqual([newer, b])
  })

  test('a same-seq `dual-write` re-log appended to an old store\'s events rebuilds the same records', () => {
    const a = record(7, { seq: 3, state: 'building', step: 'build' })
    const closed = record(8, { seq: 5, state: 'closed', step: null, why: 'merged', since: NOW - DAY })
    const list = [eventOf(t(a), NOW - 2 * DAY), eventOf(t(closed), NOW - DAY)]
    const relog = [eventOf({ ...t(a), via: 'dual-write' }, NOW - MIN), eventOf({ ...t(closed), via: 'dual-write' }, NOW - MIN)]
    expect(recordsFromEvents([...list, ...relog], DEVICE, parse)).toEqual(recordsFromEvents(list, DEVICE, parse))
  })

  test('another device\'s events, other states and notes that do not parse are left out; a record closed past the keep time goes', () => {
    const mine = record(9, { seq: 2 })
    const theirs = record(10, { seq: 5 })
    const closedLong = record(11, { seq: 6, state: 'closed', step: null, why: 'merged', since: NOW - 9 * DAY })
    const closedNow = record(12, { seq: 6, state: 'closed', step: null, why: 'dropped', since: NOW - DAY })
    const list = [
      eventOf(t(mine), NOW - 2 * DAY),
      eventOf(t(theirs), NOW - 2 * DAY, OTHER),
      { ...eventOf(t(mine), NOW - DAY), state: 'loop' },
      eventOf(t(record(13)), NOW - DAY, DEVICE, 'not a note'),
      eventOf(t(closedLong), NOW - 9 * DAY),
      eventOf(t(closedNow), NOW - DAY),
    ]
    expect(recordsFromEvents(list, DEVICE, parse)).toEqual([mine, closedNow])
    expect(recordsFromEvents([], DEVICE, parse)).toEqual([])
  })

  test('property 18 over events.ts\'s own codec: any history of transitions rebuilds the records it left', () => {
    // a history the table makes: a claim, its lease, the design, a build that cannot, a triage
    // retry, a timeout, a second triage retry, the build
    const triage: TableEvent = { kind: 'triage', choice: 'retry', reason: 'flaky', data: { instructions: 'once more' } }
    const steps: TableEvent[] = [
      { kind: 'ok' },
      { kind: 'ok', data: { brief: 'https://github.com/cbundy/dev-system/issues/7#issuecomment-1' } },
      { kind: 'not-ok', reason: 'cannot', data: { text: 'no API' } },
      triage,
      { kind: 'timeout' },
      triage,
      { kind: 'ok', data: { head: '9e01b77c0ffee000000000000000000000000001' } },
    ]
    let r = madeRecord({ issue: 7, life: LIFE, branch: 'issue-7', pr: null, others: [] }, NOW - 3 * DAY)
    const list: FactoryEvent[] = [eventOf(t(r, 'S0'), NOW - 3 * DAY, DEVICE, noteOf(t(r, 'S0')))]
    steps.forEach((e, i) => {
      const row = rowFor(r, e, CFG)
      const from = r.state
      const via = viaOf(row, normalize(r, e))
      r = nextRecord(r, row, e, NOW - 3 * DAY + (i + 1) * MIN)
      const ev: TransitionEvent = { state: 'transition', record: r, row: row.id, from, via }
      list.push(eventOf(ev, NOW - 3 * DAY + (i + 1) * MIN, DEVICE, noteOf(ev)))
      // the rebuild's default parser is events.ts's own, and each note reads back to its event
      expect(recordsFromEvents(list, DEVICE)).toEqual([r])
      expect(parseTransition(list.at(-1) as FactoryEvent)).toEqual(ev)
    })
    expect(r).toMatchObject({ state: 'reviewing', round: 1 })
  })

  test('a record rebuilt from its note is the record, its free text whole: a CI fixer gets every failed check, the next build the whole triage instruction, a reminder the whole question (drill R4-O5)', () => {
    const checks = [checkNote('lint', 'https://github.com/o/r/actions/runs/41/job/1'), checkNote('test (node 22)', 'https://github.com/o/r/actions/runs/41/job/2')]
    const instruction = `make the slug test deterministic first, then ${'keep each change small and say why in its commit. '.repeat(18)}`.trim()
    const question = `which of these APIs should the client use? ${'one option, with its trade-offs spelled out at length. '.repeat(30)}`.trim()
    const fixing = record(7, { seq: 9, state: 'fixing', step: 'fix', pr: 12, head: 'abc1234', fixes: 1, notes: [instruction, ...checks] })
    const parked = record(8, { seq: 4, state: 'parked', step: null, resumeTo: 'designing', question, notes: [instruction] })
    const list = [fixing, parked].map(r => eventOf(t(r), NOW - DAY, DEVICE, noteOf(t(r))))
    const rebuilt = recordsFromEvents(list, DEVICE)
    expect(rebuilt).toEqual([fixing, parked])
    expect(checkIdsOf(rebuilt[0]?.notes ?? [])).toEqual(['check:41-1', 'check:41-2'])
    const tell = parkedTell(rebuilt[1] as IssueRecord, 2)
    expect(tell.kind === 'tell' ? tell.context[0] : '').toBe(`question: ${question}`)
  })
})

describe('the rebuild from the new store (recordsFromNewRows, source new)', () => {
  const A = record(7, { seq: 3, state: 'building', step: 'build', head: 'abc1234', notes: ['one', 'two'], wait: [{ kind: 'issue-closed', issue: 5 }, { kind: 'pr-merged', pr: 9 }, { kind: 'tag-contains', sha: 'abc1234' }] })
  const B = record(8, { seq: 4, state: 'parked', step: null, resumeTo: 'designing', question: 'q?', approvedPatch: 'p1', cut: true, prClosedAt: '2026-10-12T00:00:00Z', brief: 'https://example.test/b' })
  const C = record(9, { seq: 5, state: 'closed', step: null, why: 'merged', since: NOW - DAY, pr: 12, lives: 2 })

  test('the query reads this device\'s transition events of the repo from event_store, with the envelope columns and data, in ts, device, device_seq order', () => {
    expect(NEW_REBUILD_SQL).toContain('from factory.event_store')
    expect(NEW_REBUILD_SQL).toContain("repo = :'repo'")
    expect(NEW_REBUILD_SQL).toContain("device = :'device'")
    expect(NEW_REBUILD_SQL).toContain("type = 'transition'")
    expect(NEW_REBUILD_SQL).toContain("make_interval(days => :'days'::int)")
    expect(NEW_REBUILD_SQL).toMatch(/order by ts, device, device_seq/)
    for (const column of ['envelope', 'event_id', 'type_version', 'repo', 'device', 'actor', 'session_id', 'issue', 'device_seq', 'data']) expect(NEW_REBUILD_SQL).toContain(column)
  })

  test('the translated rows give the same records as the old rows of the same transitions', () => {
    const list = [A, B, C].map(r => eventOf(t(r), NOW - 2 * DAY, DEVICE, noteOf(t(r))))
    const rows = [A, B, C].map(r => transitionRow(r, NOW - 2 * DAY))
    expect(recordsFromNewRows(rows)).toEqual(recordsFromEvents(list, DEVICE))
    expect(recordsFromNewRows(rows)).toEqual([A, B, C])
  })

  test('a payload without conflicts, or with null, reads 0; one with a count keeps it', () => {
    const D = record(10, { seq: 2, state: 'fixing', step: 'fix', pr: 12, conflicts: 2 })
    const row = transitionRow(D, NOW - DAY)
    expect(recordsFromNewRows([row])).toEqual([D])
    const data = JSON.parse(row.data) as Record<string, unknown>
    const { conflicts: _c, ...without } = data
    expect(recordsFromNewRows([{ ...row, data: JSON.stringify(without) }])).toEqual([{ ...D, conflicts: 0 }])
    expect(recordsFromNewRows([{ ...row, data: JSON.stringify({ ...data, conflicts: null }) }])).toEqual([{ ...D, conflicts: 0 }])
  })

  test('a payload without env_blocked reads null; one with it keeps the reasons', () => {
    const D = record(10, { seq: 2, state: 'fixing', step: 'fix', pr: 12, envBlocked: 'r1-1: no browser' })
    const row = transitionRow(D, NOW - DAY)
    expect((JSON.parse(row.data) as Record<string, unknown>).env_blocked).toBe('r1-1: no browser')
    expect(recordsFromNewRows([row])).toEqual([D])
    const { env_blocked: _e, ...without } = JSON.parse(row.data) as Record<string, unknown>
    expect(recordsFromNewRows([{ ...row, data: JSON.stringify(without) }])).toEqual([{ ...D, envBlocked: null }])
  })

  test('the newest life, then the highest seq wins; a record closed past the keep time goes', () => {
    const older = { ...A, seq: 2 }
    const newerLife = record(7, { life: lifeOf(NOW - DAY), seq: 1 })
    const gone = record(11, { seq: 6, state: 'closed', step: null, why: 'merged', since: NOW - 9 * DAY })
    const rows = [transitionRow(A, NOW - DAY), transitionRow(older, NOW - 2 * DAY), transitionRow(B, NOW - DAY), transitionRow(gone, NOW - 9 * DAY), transitionRow(newerLife, NOW - DAY + MIN), transitionRow(C, NOW - DAY)]
    expect(recordsFromNewRows(rows)).toEqual([newerLife, B, C])
  })

  test('a row of an unknown version fails the whole read, naming its event_id and the source, and none is skipped', () => {
    const rows = [transitionRow(A, NOW - DAY), transitionRow(B, NOW - DAY, { type_version: '9' }, 'ev-bad-version'), transitionRow(C, NOW - DAY)]
    expect(() => recordsFromNewRows(rows)).toThrow(/source new: event ev-bad-version: .*unknown factory event: transition v9/)
  })

  test('an unknown type, a payload the shared reader refuses and a payload the loop cannot read each fail the read with their event_id', () => {
    const good = transitionRow(A, NOW - DAY)
    const data = JSON.parse(good.data as string) as Record<string, unknown>
    const without = { ...data }
    delete without.attempt
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...good, event_id: 'e-type', type: 'claimed' }, /e-type: unknown type claimed/],
      [{ ...good, event_id: 'e-missing', data: JSON.stringify(without) }, /e-missing: .*field attempt is missing/],
      [{ ...good, event_id: 'e-type-of', data: JSON.stringify({ ...data, seq: 'x' }) }, /e-type-of: .*field seq must be integer/],
      [{ ...good, event_id: 'e-json', data: '{nope' }, /e-json: data is not JSON/],
      [{ ...good, event_id: 'e-state', data: JSON.stringify({ ...data, to_state: 'sleeping' }) }, /e-state: state is not one the loop knows/],
      [{ ...good, event_id: 'e-ts', data: JSON.stringify({ ...data, seq_at: 'yesterday' }) }, /e-ts: seq_at or state_since does not read/],
      [{ ...good, event_id: 'e-issue', issue: '' }, /e-issue: issue is missing/],
    ]
    for (const [row, message] of cases) expect(() => recordsFromNewRows([transitionRow(B, NOW - DAY), row])).toThrow(message)
  })
})

// noteOf: the old format's note of a transition (events.ts keeps the builder for the old source).
function noteOf(e: TransitionEvent): string {
  return eventNote(e)
}
