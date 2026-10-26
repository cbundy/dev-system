// The queue snapshot's pure half (hooks/queue-snapshot.ts): the fingerprint, the fold, the heartbeat,
// the top-50 cap and the payload against its strict schema.
import { describe, expect, test } from 'claude-code/testing'

import { FOLD_MS, HEARTBEAT_MS, decide, fingerprint, freshBook, nextSnapshot, resetSnapshots, snapshotArgv, snapshotData, snapshotFailed, takeProblem } from '../hooks/queue-snapshot'
import type { SnapshotBook } from '../hooks/queue-snapshot'
import { validateStrict } from '../hooks/v2/event-reader'
import type { QueueRow, QueueView, Why } from '../hooks/v2/queue-view'

const row = (issue: number, rank: number, over: Partial<QueueRow> = {}): QueueRow => ({ issue, rank, score: 10, factors: [{ name: 'waiting', points: 10 }], claimable: true, why: null, ...over })
const view = (rows: QueueRow[] = [row(1, 1), row(2, 2)], over: Partial<QueueView> = {}): QueueView => ({ rows, considered: rows.length, free_slots: 2, priority: [], only: [], serial: false, noNewWork: false, ...over })
const T0 = 1_000_000_000_000

describe('fingerprint', () => {
  const base = () => view()
  test('a score or factor change alone keeps it', () => {
    const v = view([row(1, 1, { score: 99, factors: [{ name: 'bug', points: 99 }] }), row(2, 2, { score: null, factors: null })])
    expect(fingerprint(v)).toBe(fingerprint(base()))
  })
  const cases: Array<[string, QueueView]> = [
    ['a rank swap', view([row(2, 1), row(1, 2)])],
    ['a claimability flip', view([row(1, 1, { claimable: false, why: 'no_slot' }), row(2, 2)])],
    ['a why change', view([row(1, 1), row(2, 2, { claimable: false, why: 'blocked' })])],
    ['a free_slots change', view(undefined, { free_slots: 1 })],
    ['a priority change', view(undefined, { priority: [2] })],
    ['an only change', view(undefined, { only: [2] })],
    ['serial', view(undefined, { serial: true })],
    ['no new work', view(undefined, { noNewWork: true })],
  ]
  for (const [name, v] of cases) {
    test(`${name} gives a new one`, () => {
      expect(fingerprint(v)).not.toBe(fingerprint(base()))
    })
  }
})

// run: the passes (at, view, claimed) through decide; what each wrote
function run(steps: Array<[number, QueueView, boolean?]>): Array<{ at: number; write: string; folded: number } | null> {
  let book: SnapshotBook = freshBook()
  return steps.map(([at, v, claimed]) => {
    const d = decide(book, v, T0 + at * 1000, claimed ?? false)
    book = d.book
    return 'hold' in d.decision ? null : { at, write: d.decision.write, folded: d.decision.folded }
  })
}
const variant = (n: number) => view([row(1, 1), row(2, 2)], { free_slots: n })

describe('folding and the heartbeat', () => {
  test('changes at 0, 10, 20, 30 s write at 0, hold to 50 s and write the 30 s view at 60 s with folded 3', () => {
    const got = run([[0, variant(0)], [10, variant(1)], [20, variant(2)], [30, variant(3)], [40, variant(3)], [50, variant(3)], [60, variant(3)], [65, variant(3)]])
    expect(got).toEqual([{ at: 0, write: 'changed', folded: 1 }, null, null, null, null, null, { at: 60, write: 'changed', folded: 3 }, null])
  })
  test('a held change that reverts still counts and writes', () => {
    expect(run([[0, variant(0)], [10, variant(1)], [20, variant(0)], [60, variant(0)]])).toEqual([{ at: 0, write: 'changed', folded: 1 }, null, null, { at: 60, write: 'changed', folded: 2 }])
  })
  test('the first pass after a load writes changed with folded 1', () => {
    expect(run([[0, view([])]])).toEqual([{ at: 0, write: 'changed', folded: 1 }])
  })
  test('no change: one heartbeat with folded 0 at 15:00 and none before', () => {
    const got = run([[0, variant(0)], [(HEARTBEAT_MS - 1000) / 1000, variant(0)], [HEARTBEAT_MS / 1000, variant(0)], [HEARTBEAT_MS / 1000 + 5, variant(0)]])
    expect(got).toEqual([{ at: 0, write: 'changed', folded: 1 }, null, { at: 900, write: 'heartbeat', folded: 0 }, null])
  })
  test('a quiet day of 5 s passes writes 96 heartbeats beside the changes', () => {
    const steps: Array<[number, QueueView]> = []
    for (let s = 0; s < 86_400; s += 5) steps.push([s, variant(s === 40_000 || s === 70_000 ? 1 : 0)])
    const got = run(steps).filter(x => x !== null)
    expect(got.filter(x => x?.write === 'heartbeat').length).toBeGreaterThanOrEqual(94)
    expect(got.filter(x => x?.write === 'heartbeat').length).toBeLessThanOrEqual(96)
    // the first pass, then each of the two one-pass changes and its return
    expect(got.filter(x => x?.write === 'changed')).toHaveLength(5)
    expect(got.length).toBeLessThanOrEqual(100)
  })
  test('a pass with a claim 20 s after a write writes at once as changed', () => {
    const got = run([[0, variant(0)], [20, variant(1), true], [30, variant(1)]])
    expect(got).toEqual([{ at: 0, write: 'changed', folded: 1 }, { at: 20, write: 'changed', folded: 1 }, null])
  })
  test('the fold is a minute', () => {
    expect(FOLD_MS).toBe(60_000)
  })
})

describe('the payload', () => {
  const many = (n: number): QueueView => {
    const whys: Array<Why | null> = ['blocked', 'held', null, 'blocked']
    return view(Array.from({ length: n }, (_, i) => { const why = whys[i % whys.length] ?? null; return row(i + 1, i + 1, { claimable: why === null, why }) }), { free_slots: null })
  }
  for (const n of [0, 3, 120]) {
    test(`${n} candidates validate against queue_snapshot.v1.json (strict)`, () => {
      const data = snapshotData(many(n), T0 + 123, 'changed', 1)
      expect(validateStrict('queue_snapshot', 1, data)).toEqual([])
      expect(data.considered).toBe(n)
      expect(data.candidates).toHaveLength(Math.min(n, 50))
    })
  }
  test('120 candidates: 50 rows in rank order, the rest counted by why in order of first appearance', () => {
    const data = snapshotData(many(120), T0, 'changed', 1)
    expect(data.candidates.map(c => c.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    // row 51 is index 50: the cycle blocked, held, null, blocked puts null first; 70 rows -> null 18, blocked 35, held 17
    expect(data.rest).toEqual([{ why: null, count: 18 }, { why: 'blocked', count: 35 }, { why: 'held', count: 17 }])
    expect(data.rest.reduce((a, r) => a + r.count, 0)).toBe(70)
  })
  test('50 or fewer: no rest; taken_at is the plan time to the second', () => {
    const data = snapshotData(many(50), T0 + 999, 'heartbeat', 0)
    expect(data.rest).toEqual([])
    expect(data.taken_at).toBe(new Date(T0).toISOString())
    expect(data.taken_at).toMatch(/\.000Z$/)
  })
  test('the argv is the native write', () => {
    const data = snapshotData(view(), T0, 'changed', 1)
    expect(snapshotArgv(data)).toEqual(['fabriek-event', '--type', 'queue_snapshot', '--data', JSON.stringify(data)])
  })
  test('a score the rule did not read is null, with null factors', () => {
    const data = snapshotData(view([row(1, 1, { score: null, factors: null, claimable: false, why: 'unknown' })]), T0, 'changed', 1)
    expect(validateStrict('queue_snapshot', 1, data)).toEqual([])
  })
})

describe('the module book', () => {
  test('a failed write counts as written, leaves one problem and writes nothing more until a change', () => {
    resetSnapshots()
    expect(nextSnapshot(view(), T0, false)).not.toBeNull()
    snapshotFailed('exit 1')
    expect(takeProblem()).toBe('queue snapshot: write failed: exit 1')
    expect(takeProblem()).toBeNull()
    expect(nextSnapshot(view(), T0 + 5_000, false)).toBeNull()
    expect(nextSnapshot(view(), T0 + 120_000, false)).toBeNull()
    expect(nextSnapshot(variant(0), T0 + 125_000, false)).not.toBeNull()
    resetSnapshots()
  })
})
