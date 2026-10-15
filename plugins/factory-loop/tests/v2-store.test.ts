// v2's store keys in the pass driver (hooks/v2/store.ts; docs/factory-loop/v2/SPEC.md 2.3, 3.3):
// a read keeps a failed read, an absent key and stored records apart, and a record change is kept
// in memory only once the store took it, so a transition retried after a failed write stores the
// new seq.
import { describe, expect, test } from 'claude-code/testing'

import { recordsToStore } from '../hooks/v2/observe'
import { loadV2, newV2Live, readStoredV2, storedV2, v2IoOf } from '../hooks/v2/store'
import type { V2Live, V2StoreIo } from '../hooks/v2/store'
import type { IssueRecord } from '../hooks/v2/types'
import { MIN, NOW } from './fixtures'
import { REPO } from './host'

const KEY = `records:${REPO}`

function record(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    issue: 470,
    life: 'tbq3k0',
    seq: 4,
    seqAt: NOW - 10 * MIN,
    state: 'building',
    since: NOW - 10 * MIN,
    resumeTo: null,
    branch: 'issue-470',
    pr: null,
    head: null,
    approvedPatch: null,
    brief: null,
    step: 'build',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 0,
    round: 0,
    question: null,
    why: null,
    notes: [],
    prClosedAt: null,
    ...over,
  }
}

// A store whose reads and writes can be made to fail.
function storeOf(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))
  const s = {
    values,
    failGet: false,
    failSet: false,
    io: {
      get: async (key: string) => {
        if (s.failGet) throw new Error('the store is down')
        return values.get(key)
      },
      set: async (key: string, value: unknown) => {
        if (s.failSet) throw new Error('the store is full')
        values.set(key, JSON.parse(JSON.stringify(value)))
      },
      now: async () => NOW,
    } satisfies V2StoreIo,
  }
  return s
}

// The driver's queued write, as register.ts afterSaves runs it: false when the write threw.
const write = async (save: () => Promise<void>) => {
  try {
    await save()
    return true
  } catch {
    return false
  }
}

// The transition executor's compare-and-store (3.3), as U2 builds it: from seq 4 to 5, only while
// the record is still at 4.
const toSeq5 = (records: readonly IssueRecord[]) => (records.some(r => r.issue === 470 && r.seq === 4) ? records.map(r => (r.issue === 470 ? { ...r, seq: 5, state: 'reviewing' as const, step: 'review' as const } : r)) : null)

describe('loading the records (v2 SPEC 3.3)', () => {
  test('a failed read loads nothing and says why; an absent key loads none, which a rebuild may fill; stored records, an empty list included, are the truth', async () => {
    const failed = storeOf({ [KEY]: recordsToStore([record()], NOW) })
    failed.failGet = true
    const live = newV2Live()
    await loadV2(live, failed.io, REPO)
    expect(live).toMatchObject({ loaded: false, error: `${KEY} could not be read: the store is down`, records: [] })
    expect(await storedV2(live, failed.io, REPO)).toEqual({ records: null, heads: null, files: null, error: `${KEY} could not be read: the store is down` })
    expect(await readStoredV2(failed.io, REPO)).toEqual({ records: null, heads: null, files: null, error: `${KEY} could not be read: the store is down` })
    // the store back: the next pass loads it
    failed.failGet = false
    expect(await storedV2(live, failed.io, REPO)).toEqual({ records: [record()], heads: null, files: null, error: null })

    const bad = storeOf({ [KEY]: { v: 9, records: 'x' } })
    expect(await readStoredV2(bad.io, REPO)).toMatchObject({ records: null, error: `${KEY} holds no stored records: fix or remove it` })

    const absent = newV2Live()
    await loadV2(absent, storeOf().io, REPO)
    expect(absent).toMatchObject({ loaded: true, absent: true, records: [] })
    expect(await storedV2(absent, storeOf().io, REPO)).toEqual({ records: null, heads: null, files: null, error: null })

    const empty = newV2Live()
    const none = storeOf({ [KEY]: recordsToStore([], NOW) })
    await loadV2(empty, none.io, REPO)
    expect(await storedV2(empty, none.io, REPO)).toEqual({ records: [], heads: null, files: null, error: null })
  })
})

describe('the owner\'s files as the loop last read or wrote them (v2 SPEC 7.2)', () => {
  test('files:<repo> loads beside the records and goes to observe; a value that does not read is none kept', async () => {
    const files = { v: 1, control: { digest: 'abc', text: '{}' }, workspace: null, settings: null, edits: [{ what: 'control', at: NOW, issues: [], detail: 'the OFF file was created' }], off: true }
    const store = storeOf({ [KEY]: recordsToStore([], NOW), [`files:${REPO}`]: files })
    const live = newV2Live()
    await loadV2(live, store.io, REPO)
    expect(live.files).toEqual(files)
    expect(await storedV2(live, store.io, REPO)).toMatchObject({ files })
    expect(await readStoredV2(store.io, REPO)).toMatchObject({ files })
    const bad = storeOf({ [`files:${REPO}`]: { v: 2 } })
    expect(await readStoredV2(bad.io, REPO)).toMatchObject({ files: null })
  })
})

describe('changing the records (v2 SPEC 3.3, V2Io)', () => {
  const loaded = async (store: ReturnType<typeof storeOf>): Promise<V2Live> => {
    const live = newV2Live()
    await loadV2(live, store.io, REPO)
    return live
  }

  test('a write the store refuses changes nothing, in memory or the store; the transition retried stores the new seq', async () => {
    const store = storeOf({ [KEY]: recordsToStore([record()], NOW - MIN) })
    const live = await loaded(store)
    const io = v2IoOf(live, store.io, { ready: () => true, write, ping: () => undefined })
    store.failSet = true
    expect(await io.updateRecords(toSeq5)).toEqual({ changed: false, saved: false })
    expect(io.records().map(r => r.seq)).toEqual([4])
    expect((store.values.get(KEY) as { records: IssueRecord[] }).records.map(r => r.seq)).toEqual([4])
    // the retry's compare still finds seq 4, and this time the store takes seq 5
    store.failSet = false
    expect(await io.updateRecords(toSeq5)).toEqual({ changed: true, saved: true })
    expect(io.records().map(r => [r.seq, r.state])).toEqual([[5, 'reviewing']])
    expect((store.values.get(KEY) as { records: IssueRecord[] }).records.map(r => r.seq)).toEqual([5])
    // the compare now finds the record moved, and changes nothing
    expect(await io.updateRecords(toSeq5)).toEqual({ changed: false, saved: false })
  })

  test('with the records not loaded, or the ledger not this session\'s, or a write that may not run, nothing changes', async () => {
    const down = storeOf({ [KEY]: recordsToStore([record()], NOW - MIN) })
    down.failGet = true
    const unloaded = await loaded(down)
    expect(await v2IoOf(unloaded, down.io, { ready: () => true, write, ping: () => undefined }).updateRecords(toSeq5)).toEqual({ changed: false, saved: false })
    const store = storeOf({ [KEY]: recordsToStore([record()], NOW - MIN) })
    const live = await loaded(store)
    expect(await v2IoOf(live, store.io, { ready: () => false, write, ping: () => undefined }).updateRecords(toSeq5)).toEqual({ changed: false, saved: false })
    // another session took the act lock: the driver's write does not run
    expect(await v2IoOf(live, store.io, { ready: () => true, write: async () => false, ping: () => undefined }).updateRecords(toSeq5)).toEqual({ changed: false, saved: false })
    expect(live.records.map(r => r.seq)).toEqual([4])
    expect((store.values.get(KEY) as { records: IssueRecord[] }).records.map(r => r.seq)).toEqual([4])
  })
})
