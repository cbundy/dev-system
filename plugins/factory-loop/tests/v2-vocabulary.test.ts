// v2's vocabulary (docs/factory-loop/v2/SPEC.md 3, appendices B to D) and what observe reads for it
// (2.4): the key families and their codec (the one test that asserts exact keys, 17.1), the closed
// lists, the labels, the store's records and heads, the pool's leases by holder, the order GitHub
// reads take, the trusted comments, the event seam's columns, and observeV2 itself.
import { describe, expect, test } from 'claude-code/testing'

import { emptyCache } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import { eventArgv } from '../hooks/v2/events'
import * as K from '../hooks/v2/keys'
import {
  commentsOf,
  emptyV2State,
  headsFromStore,
  headsToStore,
  holderOf,
  leasesOf,
  observeV2,
  readOrder,
  recordOf,
  recordsFromStore,
  recordsToStore,
} from '../hooks/v2/observe'
import type { V2Readers, V2Stored } from '../hooks/v2/observe'
import {
  AGENT_STEPS,
  ALL_FACTORY_LABELS,
  FACTORY_LABELS,
  REJECTED_LABEL,
  ISSUE_STATES,
  SLOT_STATES,
  STATE_STEP,
  STEP_AGENT,
  STEP_CLASS,
  STEP_ROLE,
  V2_ACTION_KINDS,
  V2_OWNER_TELLS,
  V2_RULES,
  labelOf,
} from '../hooks/v2/types'
import type { IssueRecord } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

function runtimeOf(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP_DIR,
    sink: null,
    env: {},
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: config(),
    configProblems: [],
  }
}

const DAY = 24 * 60 * MIN
const LIFE = 'ss1x2k'
const R = { issue: 571, life: LIFE, seq: 7 }

function record(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    issue: 571,
    life: LIFE,
    seq: 7,
    seqAt: NOW - MIN,
    state: 'reviewing',
    since: NOW - MIN,
    resumeTo: null,
    branch: 'issue-571',
    pr: 621,
    head: 'abc1234',
    approvedPatch: null,
    brief: 'https://github.com/cbundy/dev-system/issues/571#issuecomment-1',
    step: 'review',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 1,
    round: 2,
    question: null,
    why: null,
    notes: ['the owner: keep it small'],
    prClosedAt: null,
    wait: null,
    lives: 1,
    ...over,
  }
}

describe('the key families (v2 SPEC appendix C)', () => {
  test('every family builds the appendix\'s own example', () => {
    expect(K.claimKey(571, LIFE)).toBe('i571/claim/ss1x2k')
    expect(K.reclaimKey(R, 'ss2a9q')).toBe('i571/lss1x2k/claim/ss2a9q')
    expect(K.transitionKey(R)).toBe('i571/lss1x2k/s7/t')
    expect(['label', 'stop', 'kill', 'comment', 'event/transition'].map(a => K.entryKey(R, a as K.EntryAction))).toEqual([
      'i571/lss1x2k/s7/label',
      'i571/lss1x2k/s7/stop',
      'i571/lss1x2k/s7/kill',
      'i571/lss1x2k/s7/comment',
      'i571/lss1x2k/s7/event/transition',
    ])
    expect(K.stepKey(R, 'build', 1)).toBe('i571/lss1x2k/s7/build/a1')
    expect(K.prepareKey(R, 1)).toBe('i571/lss1x2k/s7/prepare/a1')
    expect(K.stepKey({ ...R, seq: 9 }, 'triage', 1)).toBe('i571/lss1x2k/s9/triage/a1')
    expect(K.reviewKey(R, '3fa2c1d9e', 2, 1)).toBe('i571/lss1x2k/review/3fa2c1d/r2/a1')
    expect(K.prKey({ ...R, seq: 8 }, 'ensure')).toBe('i571/lss1x2k/s8/pr/ensure')
    expect(K.prKey({ ...R, seq: 12 }, 'body', 1)).toBe('i571/lss1x2k/s12/pr/body/a1')
    expect(K.childKey({ issue: 600, life: 'ss0q1z', seq: 3 }, 'b')).toBe('i600/lss0q1z/s3/child/b')
    expect(K.rerunKey(R, 2, '18342299123')).toBe('i571/lss1x2k/rerun/r2/18342299123')
    expect(K.queueKey(R, 'update', '9e01b77aa')).toBe('i571/lss1x2k/queue/update/9e01b77')
    expect(K.queueKey(R, 'merge', '4c2d8aa00')).toBe('i571/lss1x2k/queue/merge/4c2d8aa')
    expect(K.leaseKey(R, 1)).toBe('i571/lss1x2k/lease/1')
    expect(K.freeKey('L1')).toBe('slot/L1/free')
    expect(K.followKey(R, 'rollout')).toBe('i571/lss1x2k/follow/rollout')
    expect(K.reconcileKey(571, LIFE, 'label')).toBe('i571/reconcile/ss1x2k/label')
    expect(K.interventionKey(K.transitionKey(R))).toBe('iv/i571/lss1x2k/s7/t')
    expect(K.interventionKey(K.rerunKey(R, 2, '18342299123'))).toBe('iv/i571/lss1x2k/rerun/r2/18342299123')
    expect(K.interventionKey(K.factKey('push', 'i571', 'ss3b0c'))).toBe('iv/push/i571/ss3b0c')
  })

  test('a life is the claim\'s time in base-36 seconds, and reads back to the second', () => {
    for (const at of [NOW, NOW + 999, 0, NOW + 400 * DAY]) {
      const life = K.lifeOf(at)
      expect(/^[0-9a-z]+$/.test(life)).toBe(true)
      expect(K.lifeAt(life)).toBe(Math.floor(at / 1000) * 1000)
    }
    expect(K.lifeOf(NOW)).not.toBe(K.lifeOf(NOW + 1000))
    expect(K.lifeAt('S1X')).toBeNull()
    expect(K.lifeAt('')).toBeNull()
  })

  test('the codec reads back a life-scoped key\'s issue, life and seq; v2 keys are slash-separated, never v1\'s colons', () => {
    const keys = [K.transitionKey(R), K.stepKey(R, 'fix', 2), K.reviewKey(R, 'abcdef0', 3, 1), K.leaseKey(R, 2), K.queueKey(R, 'merge', 'abcdef0'), K.reclaimKey(R, 'zz')]
    for (const key of keys) {
      const parts = K.keyParts(key)
      expect({ key, issue: parts?.issue, life: parts?.life }).toEqual({ key, issue: 571, life: LIFE })
      expect(key.includes(':')).toBe(false)
    }
    expect(K.keyParts(K.transitionKey(R))).toEqual({ issue: 571, life: LIFE, seq: 7, rest: 't' })
    expect(K.keyParts(K.leaseKey(R, 2))).toEqual({ issue: 571, life: LIFE, seq: null, rest: 'lease/2' })
    for (const other of ['claim:571:new', 'i571/claim/ss1x2k', 'slot/L1/free', 'iv/push/i571/x', 'tell:parked:1']) expect(K.keyParts(other)).toBeNull()
    // two lives, or two seqs, of one issue never share a key
    expect(new Set([K.transitionKey(R), K.transitionKey({ ...R, seq: 8 }), K.transitionKey({ ...R, life: 'ss1x2l' })]).size).toBe(3)
  })
})

describe('the closed lists (v2 SPEC 3.1, 4.2, appendices B, D, 14.1)', () => {
  test('every state has its step, every agent step its role, class and loop-owned agent; slot states hold slots', () => {
    expect(ISSUE_STATES).toEqual(['queued', 'designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting', 'closed'])
    expect(SLOT_STATES).toEqual(['designing', 'building', 'reviewing', 'fixing', 'merge-queue'])
    for (const s of ISSUE_STATES) expect(s in STATE_STEP).toBe(true)
    for (const step of AGENT_STEPS) {
      expect([STEP_ROLE[step], STEP_CLASS[step], STEP_AGENT[step].startsWith('factory-loop:')]).toEqual([
        step === 'build' || step === 'fix' ? 'writer' : 'reader',
        step === 'design' || step === 'build' ? 'develop' : 'drive',
        true,
      ])
    }
    expect(V2_ACTION_KINDS).toHaveLength(13)
    expect(V2_RULES).toHaveLength(21)
    expect(V2_OWNER_TELLS).toEqual(['parked', 'breaker', 'stalled', 'checkout', 'workspace', 'rejected', 'keep-open-blocks', 'reopened', 'records-shadow', 'facts-shadow', 'wait-unreadable'])
  })

  test('the eight labels, one per state but closed, with appendix D\'s colours', () => {
    expect(Object.values(FACTORY_LABELS).map(l => [l.name, l.color])).toEqual([
      ['factory:queued', 'c5def5'],
      ['factory:designing', 'bfd4f2'],
      ['factory:building', '0e8a16'],
      ['factory:reviewing', 'fbca04'],
      ['factory:fixing', 'd93f0b'],
      ['factory:merge-queue', '5319e7'],
      ['factory:parked', 'b60205'],
      ['factory:waiting', 'fef2c0'],
    ])
    for (const s of ISSUE_STATES) expect(labelOf(s)).toBe(s === 'closed' ? null : `factory:${s}`)
    expect(FACTORY_LABELS.parked.description).toBe('Factory loop: waits on the owner; remove this label to resume')
    expect(FACTORY_LABELS.waiting.description).toBe('Factory loop: waits on a condition the loop checks; it resumes by itself')
  })

  test('factory:rejected is a ninth label the loop makes, and no state\'s (6.4, appendix D)', () => {
    expect([REJECTED_LABEL.name, REJECTED_LABEL.color]).toEqual(['factory:rejected', '6a737d'])
    expect(ALL_FACTORY_LABELS.map(l => l.name)).toEqual([...Object.values(FACTORY_LABELS).map(l => l.name), 'factory:rejected'])
    for (const s of ISSUE_STATES) expect(labelOf(s)).not.toBe(REJECTED_LABEL.name)
  })
})

describe('the store\'s records and heads (v2 SPEC 3.3, 2.4)', () => {
  test('records round-trip the store; a record that does not read is dropped, and a value that is no records is none', () => {
    const records = [record(), record({ issue: 572, state: 'parked', step: null, question: 'which one?', resumeTo: 'designing' })]
    const stored = recordsToStore(records, NOW)
    expect(stored).toEqual({ v: 1, savedAt: NOW, records })
    expect(recordsFromStore(JSON.parse(JSON.stringify(stored)))).toEqual(records)
    const bad = [{ ...record(), state: 'merging' }, { ...record(), seq: -1 }, { ...record(), notes: [1] }, { ...record(), pr: 0 }, null, 'x']
    expect(recordsFromStore({ v: 1, savedAt: NOW, records: [...bad, record({ issue: 9 })] })).toEqual([record({ issue: 9 })])
    for (const none of [undefined, null, [], { v: 2, records: [] }, { v: 1 }]) expect(recordsFromStore(none)).toBeNull()
    expect(recordOf({ ...record(), extra: 1 })).toEqual(record())
    // a record stored before its life count reads as a first life; a count below 1 does not read
    const { lives: _lives, ...uncounted } = record({ lives: 2 })
    expect(recordOf(uncounted)).toEqual(record({ lives: 1 }))
    expect(recordOf({ ...record(), lives: 0 })).toBeNull()
  })

  test('a stored wait reads back with its repo on issue-closed and tag-contains; without it as before; a repo on pr-merged or a bad repo makes the record unreadable', () => {
    const w = (wait: unknown[]) => ({ ...record({ state: 'waiting', step: null, resumeTo: 'designing' }), wait })
    const withRepo = [{ kind: 'issue-closed', issue: 5, repo: 'o/n' }, { kind: 'tag-contains', sha: '35bb655', repo: 'o/n' }]
    expect(recordOf(w(withRepo))?.wait).toEqual(withRepo)
    const plain = [{ kind: 'issue-closed', issue: 5 }, { kind: 'pr-merged', pr: 6 }]
    expect(recordOf(w(plain))?.wait).toEqual(plain)
    expect(recordOf(w([{ kind: 'issue-closed', issue: 5, repo: null }]))?.wait).toEqual([{ kind: 'issue-closed', issue: 5 }])
    for (const bad of [{ kind: 'pr-merged', pr: 6, repo: 'o/n' }, { kind: 'issue-closed', issue: 5, repo: 'Owner/n' }, { kind: 'issue-closed', issue: 5, repo: 'x' }, { kind: 'tag-contains', sha: '35bb655', repo: 3 }]) {
      expect(recordOf(w([bad]))).toBeNull()
    }
  })

  test('a closed record goes from the store 7 days after it closed; an open one stays, whatever its age', () => {
    const old = record({ issue: 1, state: 'closed', why: 'merged', since: NOW - 8 * DAY })
    const recent = record({ issue: 2, state: 'closed', why: 'dropped', since: NOW - 6 * DAY })
    const parked = record({ issue: 3, state: 'parked', since: NOW - 30 * DAY })
    expect(recordsToStore([old, recent, parked], NOW).records.map(r => r.issue)).toEqual([2, 3])
  })

  test('heads round-trip; an entry that does not read is dropped', () => {
    const heads = { abc1234: { pr: 621, at: NOW - MIN } }
    expect(headsFromStore(JSON.parse(JSON.stringify(headsToStore(heads))))).toEqual(heads)
    expect(headsFromStore({ v: 1, heads: { abc1234: { pr: 621, at: NOW }, 'not a sha': { pr: 1, at: 1 }, def5678: { pr: 0, at: 1 } } })).toEqual({ abc1234: { pr: 621, at: NOW } })
    expect(headsFromStore(undefined)).toBeNull()
  })
})

describe('what observe reads for v2 (v2 SPEC 2.4)', () => {
  test('the pool\'s leases by holder: the loop finds its own by factory-loop:<N>:<life>, and infers nothing', () => {
    const json = JSON.stringify([
      { path: '/s/1', status: 'leased', branch: '', lease_id: 'L1', lease_holder: holderOf(571, LIFE), processes: [{ pid: 1 }] },
      { path: '/s/2', status: 'leased', branch: 'issue-9', lease_id: 'L2', lease_holder: '', processes: [] },
      { path: '/s/3', status: 'available', branch: '', lease_id: '', lease_holder: '' },
    ])
    expect(leasesOf(json)).toEqual([
      { path: '/s/1', lease: 'L1', holder: 'factory-loop:571:ss1x2k', issue: 571, life: LIFE, status: 'leased', busy: true },
      { path: '/s/2', lease: 'L2', holder: '', issue: null, life: null, status: 'leased', busy: false },
    ])
    expect(leasesOf('nope')).toBeNull()
    expect(leasesOf('{}')).toBeNull()
  })

  test('GitHub reads take the merge queue\'s head first, then reviewing and the queue, then parked, then the rest; a closed record not at all', () => {
    const records = [
      record({ issue: 1, state: 'building', seqAt: NOW - 9 * MIN }),
      record({ issue: 2, state: 'parked', seqAt: NOW - 8 * MIN }),
      record({ issue: 3, state: 'merge-queue', step: 'queue', seqAt: NOW - 3 * MIN }),
      record({ issue: 4, state: 'merge-queue', step: 'queue', seqAt: NOW - 5 * MIN }),
      record({ issue: 5, state: 'reviewing', seqAt: NOW - 1 * MIN }),
      record({ issue: 6, state: 'closed', why: 'merged' }),
      record({ issue: 7, state: 'merge-queue', step: 'triage', seqAt: NOW - 10 * MIN }),
    ]
    expect(readOrder(records)).toEqual([4, 7, 3, 5, 2, 1])
    expect(readOrder([])).toEqual([])
  })

  test('the trusted comments, oldest first; a reply that does not read is none', () => {
    const json = JSON.stringify({
      comments: [
        { body: 'second', created_at: '2026-10-13T03:05:00Z', html_url: 'u2' },
        { body: 'first', created_at: '2026-10-13T03:01:00Z' },
        { body: 7, created_at: '2026-10-13T03:02:00Z' },
      ],
      stripped: 1,
    })
    expect(commentsOf(json)).toEqual([
      { body: 'first', at: Date.parse('2026-10-13T03:01:00Z'), url: null },
      { body: 'second', at: Date.parse('2026-10-13T03:05:00Z'), url: 'u2' },
    ])
    expect(commentsOf('{}')).toBeNull()
  })

  test('observeV2: the store\'s records, the leases, the reads, and a parked record\'s comments once a read newer than its park lacks the label', async () => {
    const parked = record({ issue: 80, state: 'parked', step: null, since: NOW - 30 * MIN, question: 'which API?' })
    const runs: string[][] = []
    const run = async (argv: string[]) => {
      runs.push(argv)
      if (argv[0] === 'callum-flow-issue-read') return { exitCode: 0, stdout: JSON.stringify({ comments: [{ body: 'use the old one', created_at: new Date(NOW - MIN).toISOString() }] }), stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const rt: Runtime = {
      mode: 'observe',
      repo: REPO,
      device: DEVICE,
      runSource: 'local',
      poolSize: 16,
      cwd: '/work',
      loopDir: LOOP_DIR,
      sink: null,
      env: {},
      toolsDir: TOOLS,
      pluginRoot: PLUGIN_ROOT,
      config: config(),
      configProblems: [],
    }
    const io: Io = { now: async () => NOW, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), readFile: async () => null, sessionLimits: async () => [], agents: async () => [] }
    const cache = emptyCache()
    cache.github.set(80, { at: NOW - 5 * MIN, value: { facts: { open: true, labels: ['bug'], blockedBy: 0, subIssues: 0, title: 'x' }, trusted: true, brief: null } })
    const pool = JSON.stringify([{ path: '/s/1', status: 'leased', lease_id: 'L1', lease_holder: holderOf(80, LIFE) }])
    const input = { io, rt, cache: cache.v2, run, state: state(), stored: { records: [parked], heads: null, error: null }, poolJson: pool, github: cache.github, backoff: false, limited: () => false }
    const r = await observeV2(input)
    expect(r.v2).toMatchObject({ records: [parked], recordsFrom: 'store', leases: [{ path: '/s/1', issue: 80, life: LIFE }], reads: { 80: { at: NOW - 5 * MIN, open: true, labels: ['bug'] } } })
    expect(r.v2.comments).toEqual({ 80: [{ body: 'use the old one', at: NOW - MIN, url: null }] })
    expect(r.v2.sources).toMatchObject({ store: { ok: true }, leases: { ok: true }, comments: { ok: true }, prs: { ok: true } })
    expect(runs).toEqual([['callum-flow-issue-read', '--json', '80', '--comments']])
    // read once per issue read: the next pass takes them from memory
    await observeV2(input)
    expect(runs).toHaveLength(1)
    // a read from before the park, or one with the label, reads no comments
    const labelled = emptyCache()
    labelled.github.set(80, { at: NOW - 5 * MIN, value: { facts: { open: true, labels: ['factory:parked'], blockedBy: 0, subIssues: 0, title: 'x' }, trusted: true, brief: null } })
    expect((await observeV2({ ...input, cache: labelled.v2, github: labelled.github })).v2.comments).toEqual({})
    expect(runs).toHaveLength(1)
    // the tripwire's base: the first read that did not fail, kept while nothing changes
    expect(r.v2.checkoutBase).toEqual({ checkout: state().checkout, at: NOW })
    expect((await observeV2(input)).v2.checkoutBase).toEqual({ checkout: state().checkout, at: NOW })
  })

  test('observeV2 reads GitHub in 2.4\'s order with budgets of its own: the PRs (at most K records) first, then the parked comments; none during a backoff or after a rate limit', async () => {
    const parked = record({ issue: 80, state: 'parked', step: null, since: NOW - 30 * MIN, question: 'which API?' })
    const head = record({ issue: 81, state: 'merge-queue', step: 'queue', pr: 900 })
    const log: string[] = []
    const budgets: number[] = []
    const run = async (argv: string[]) => {
      // the dual-write probe is not a GitHub read (v2-dual-write.test.ts), so this order leaves it out
      if (argv[0] !== 'callum-flow-event') log.push(argv.join(' '))
      return { exitCode: 0, stdout: JSON.stringify({ comments: [] }), stderr: '' }
    }
    const readers: V2Readers = {
      prs: async ctx => {
        budgets.push(ctx.prBudget)
        if (ctx.prBudget > 0) await ctx.run(['callum-flow-issue-read', '--json', '--pr', '900'])
        return { read: { prs: [] }, source: { ok: true, at: NOW }, heads: ctx.heads }
      },
      interventions: async () => ({ read: { companion: [], controlDigest: null, configDigest: null }, source: { ok: true, at: NOW } }),
    }
    const rt = (k: number | null): Runtime => ({ ...runtimeOf(), config: config({ maxInFlightIssues: k }) })
    const io: Io = { now: async () => NOW, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), readFile: async () => null, sessionLimits: async () => [], agents: async () => [] }
    const cacheOf = () => {
      const c = emptyCache()
      c.github.set(80, { at: NOW - 5 * MIN, value: { facts: { open: true, labels: [], blockedBy: 0, subIssues: 0, title: 'x' }, trusted: true, brief: null } })
      return c
    }
    // a busy pass: v1's issue reads took their 12 (observe.ts) before these, and take nothing of them
    const busy = cacheOf()
    const input = { io, rt: rt(3), cache: busy.v2, run, state: state(), stored: { records: [parked, head], heads: null, error: null }, poolJson: null, github: busy.github, backoff: false, limited: () => false, readers }
    const r = await observeV2(input)
    expect(budgets).toEqual([3])
    expect(log).toEqual(['callum-flow-issue-read --json --pr 900', 'callum-flow-issue-read --json 80 --comments'])
    expect(r.v2.sources).toMatchObject({ prs: { ok: true }, comments: { ok: true }, interventions: { ok: true } })
    // with no cap on K, the pool bounds the PR reads
    await observeV2({ ...input, rt: rt(null), cache: cacheOf().v2 })
    expect(budgets.at(-1)).toBe(16)
    // a backoff, or a rate limit met this pass, holds them all
    for (const held of [{ backoff: true, limited: () => false }, { backoff: false, limited: () => true }]) {
      log.length = 0
      const c = cacheOf()
      const h = await observeV2({ ...input, ...held, cache: c.v2, github: c.github })
      expect(budgets.at(-1)).toBe(0)
      expect(log).toEqual([])
      expect(h.v2.sources.comments).toEqual({ ok: false, at: null, error: 'GitHub rate limit' })
    }
  })

  test('observeV2 keeps the store\'s three cases apart: not read (no records, the store source failed, no rebuild), absent (a rebuild reads the event log) and an empty list (no records)', async () => {
    const io: Io = { now: async () => NOW, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), readFile: async () => null, sessionLimits: async () => [], agents: async () => [] }
    const runs: string[][] = []
    const base = { io, rt: { ...runtimeOf(), config: config() }, run: async (argv: string[]) => (runs.push(argv), { exitCode: 0, stdout: '', stderr: '' }), state: state(), poolJson: null, backoff: false, limited: () => false }
    const of = async (stored: V2Stored) => {
      const c = emptyCache()
      return (await observeV2({ ...base, cache: c.v2, github: c.github, stored })).v2
    }
    const failed = await of({ records: null, heads: null, error: `records:${REPO} could not be read: the store is down` })
    expect(failed).toMatchObject({ records: [], recordsFrom: 'none', sources: { store: { ok: false, error: `records:${REPO} could not be read: the store is down` } } })
    expect(await of({ records: null, heads: null, error: null })).toMatchObject({ records: [], recordsFrom: 'none', sources: { store: { ok: true } } })
    expect(await of({ records: [], heads: null, error: null })).toMatchObject({ records: [], recordsFrom: 'store', sources: { store: { ok: true } } })
    // only the absent key reads this device's transition events for a rebuild (v2/record.ts)
    expect(runs.filter(a => a[0] === 'dev-query')).toHaveLength(1)
  })

  test('with no store records and no rebuild built yet, there are no records, and a state built outside a pass reads nothing', () => {
    expect(emptyV2State(NOW)).toMatchObject({ records: [], recordsFrom: 'none', leases: [], sources: { leases: { ok: false } } })
    expect(emptyV2State(NOW, [record()]).recordsFrom).toBe('store')
  })
})

describe('the event seam (v2 SPEC 7.1; its format is tested in v2-events.test.ts)', () => {
  test('an event carries its issue, branch, PR and head in its own columns, and a note', () => {
    const transition = eventArgv({ state: 'transition', record: record(), row: 'T5', from: 'building', via: 'ok' })
    expect(transition.slice(0, 10)).toEqual(['callum-flow-event', 'transition', '--issue', '571', '--branch', 'issue-571', '--pr', '621', '--head', 'abc1234'])
    expect(transition.slice(10, 11)).toEqual(['--note'])
    expect(transition[11]).toMatch(/^row=T5 life=\S+ seq=\d+ from=building to=reviewing /)
    expect(eventArgv({ state: 'intervention', who: 'loop', cause: 'triage', reason: 'second unknown', issue: 571, life: LIFE, pr: null, fact: 'i571/lss1x2k/s7/t' })).toEqual([
      'callum-flow-event', 'intervention', '--issue', '571', '--note', `who=loop cause=triage life=${LIFE} fact=i571/lss1x2k/s7/t reason=second%20unknown`,
    ])
    expect(eventArgv({ state: 'fix_requested', issue: 571, branch: 'issue-571', pr: 621, head: null, note: 'review' }).slice(-2)).toEqual(['--note', 'review'])
  })
})
