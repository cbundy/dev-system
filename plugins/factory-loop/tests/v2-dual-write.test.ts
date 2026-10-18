// Dual write (docs/factory-loop/v2/SPEC.md 4.1, 2.4): observe's once-per-load probe and read of the new
// event log (act mode), and H1's dualWriteRules, which logs each record's stage the new
// log lacks once.
import { describe, expect, test } from 'claude-code/testing'

import { emptyCache } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { lifeOf, transitionKey } from '../hooks/v2/keys'
import { emptyV2State, observeV2 } from '../hooks/v2/observe'
import type { V2Readers } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { seenIn } from '../hooks/v2/sources-dualwrite'
import { madeRecord } from '../hooks/v2/table'
import type { IssueRecord, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, OTHER, PLUGIN_ROOT, config, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const LIFE = lifeOf(NOW - 2 * 60 * MIN)
const OK = { ok: true, at: NOW }
const CFG = config({ mode: 'act', maxInFlightIssues: 3 })

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, state: 'building', step: 'build', since: NOW - 20 * MIN, ...over }
}
const closedRec = (n: number) => rec(n, { state: 'closed', step: null, why: 'merged', since: NOW - 10 * MIN, seqAt: NOW - 10 * MIN })

function world(records: IssueRecord[], dualWrite: V2State['dualWrite'], ledger: LedgerEntry[] = []): State {
  const s = baseState()
  const base = emptyV2State(NOW, records)
  return { ...s, ledger: [...s.ledger, ...ledger], v2: { ...base, sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK }, dualWrite } }
}
const dwActions = (s: State): Extract<Action, { kind: 'event' }>[] => planV2(s, CFG).actions.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.key.startsWith('dual-write:'))
const on = (seen: string[] = []) => ({ readAt: NOW, seen: new Set(seen) })

describe('dualWriteRules (H1)', () => {
  test('off: no dual-write action', () => {
    expect(dwActions(world([rec(7)], null))).toEqual([])
  })

  test('on with nothing seen: one event per record behind the read, closed ones too, with the record\'s own seq and its transition entry\'s row and from', () => {
    const a = rec(7)
    const b = closedRec(8)
    const t = entry(transitionKey(a), 'event', { issue: 7, outcome: { kind: 'transition', row: 'T4', from: 'designing' } as never })
    const acts = dwActions(world([a, b], on(), [t]))
    expect(acts.map(x => x.key).sort()).toEqual([`dual-write:7:${LIFE}:3`, `dual-write:8:${LIFE}:3`])
    const forA = acts.find(x => x.issue === 7)
    expect(forA).toMatchObject({ rule: 'H1', class: 'free', event: { state: 'transition', record: a, row: 'T4', from: 'designing', via: 'dual-write' } })
    expect(acts.find(x => x.issue === 8)).toMatchObject({ event: { record: b, row: 'H1', from: null, via: 'dual-write' } })
  })

  test('every action writes the new log only (target new), and nothing else sets a target', () => {
    const acts = dwActions(world([rec(7), closedRec(8)], on()))
    expect(acts).toHaveLength(2)
    for (const a of acts) expect(a.target).toBe('new')
    const others = planV2(world([rec(7)], on()), CFG).actions.filter(a => a.kind === 'event' && !a.key.startsWith('dual-write:'))
    for (const a of others) expect((a as { target?: string }).target).toBeUndefined()
  })

  test('the second load: the record in seen plans nothing', () => {
    const first = dwActions(world([rec(7)], on()))
    expect(first).toHaveLength(1)
    expect(dwActions(world([rec(7)], on([`7:${LIFE}:3`])))).toEqual([])
  })

  test('a closed record alone (no live record) is still wanted', () => {
    expect(dwActions(world([closedRec(8)], on()))).toHaveLength(1)
  })

  test('a record whose triple is seen: none; a newer seq than the log\'s: one', () => {
    expect(dwActions(world([rec(7)], on([`7:${LIFE}:3`])))).toEqual([])
    expect(dwActions(world([rec(7, { seq: 4 })], on([`7:${LIFE}:3`])))).toHaveLength(1)
  })

  test('a record that transitioned after the read: none (the dual-writing image wrote both logs)', () => {
    expect(dwActions(world([rec(7, { seqAt: NOW })], on()))).toEqual([])
    expect(dwActions(world([rec(7, { seqAt: NOW + MIN })], on()))).toEqual([])
  })

  test('with the actions\' ledger entries done: none', () => {
    const first = dwActions(world([rec(7)], on()))
    const ledger = first.map(a => entry(a.key, 'event', { issue: 7, startedAt: NOW - 2 * MIN, endedAt: NOW - MIN }))
    expect(dwActions(world([rec(7)], on(), ledger))).toEqual([])
  })
})

describe('seenIn', () => {
  const line = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
    JSON.stringify({ envelope: 1, type: 'transition', type_version: 1, repo: REPO, device: DEVICE, issue: 7, data: { life: LIFE, seq: 3, table_row: 'T1', from_state: null, to_state: 'queued', via: 's0', seq_at: '2026-10-15T09:00:00.000Z', state_since: '2026-10-15T09:00:00.000Z', resume_to: null, branch: 'b', pr: null, head: null, approved_patch: null, brief_url: null, step: null, attempt: 0, cut: false, triages: 0, fixes: 0, round: 0, question: null, why: null, notes: [], pr_closed_at: null, lives: 1, ...data }, ...over })
  test('keeps this device and repo\'s transitions; skips the rest and garbage without throwing', () => {
    const text = [
      line(),
      line({ device: OTHER }),
      line({ repo: 'o/other' }),
      line({ type: 'claimed', data: {} }),
      '{not json',
      line({}, { seq: 'x' }),
      '',
    ].join('\n')
    expect([...seenIn(text, DEVICE, REPO)]).toEqual([`7:${LIFE}:3`])
  })
})

describe('observeV2 dual write (2.4)', () => {
  const runtime = (mode: Runtime['mode']): Runtime => ({
    mode, repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: {}, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config(), configProblems: [],
  })
  const readers: V2Readers = {
    prs: async ctx => ({ read: { prs: [] }, source: OK, heads: ctx.heads }),
    interventions: async () => ({ read: { companion: [], controlDigest: null, configDigest: null }, source: OK }),
  }
  const NEW_LOG = '/events/factory/cbundy__dev-system.jsonl'
  const goodLine = JSON.stringify({ envelope: 1, type: 'transition', type_version: 1, repo: REPO, device: DEVICE, issue: 7, data: JSON.parse(JSON.stringify({ life: LIFE, seq: 3, table_row: 'T1', from_state: null, to_state: 'queued', via: 's0', seq_at: '2026-10-15T09:00:00.000Z', state_since: '2026-10-15T09:00:00.000Z', resume_to: null, branch: 'b', pr: null, head: null, approved_patch: null, brief_url: null, step: null, attempt: 0, cut: false, triages: 0, fixes: 0, round: 0, question: null, why: null, notes: [], pr_closed_at: null, lives: 1 })) })
  const otherDevice = JSON.stringify({ ...JSON.parse(goodLine), device: OTHER })
  const otherRepo = JSON.stringify({ ...JSON.parse(goodLine), repo: 'o/x' })
  const notTransition = JSON.stringify({ envelope: 1, type: 'claimed', type_version: 1, repo: REPO, device: DEVICE, issue: 7, data: {} })

  function harness(probe: { exitCode: number; stdout: string } | Error, files: Record<string, string> = { [NEW_LOG]: [goodLine, otherDevice, otherRepo, notTransition, 'garbage'].join('\n') }) {
    const runs: string[][] = []
    // the dual write's reads; the wind-down request's (every pass reads it) is no part of them
    const reads: string[] = []
    const run = async (argv: string[]) => {
      runs.push(argv)
      if (argv[0] === 'callum-flow-event') {
        if (probe instanceof Error) throw probe
        return { ...probe, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const io: Io = { now: async () => NOW, run, readFile: async (p: string) => (p.includes('/wind-down.') || reads.push(p), files[p] ?? null), sessionLimits: async () => [], agents: async () => [] }
    const cache = emptyCache()
    const pass = (rt: Runtime) => observeV2({ io, rt, cache: cache.v2, run, state: baseState(), stored: { records: [], heads: null, error: null }, poolJson: null, github: cache.github, backoff: false, limited: () => false, readers })
    return { runs, reads, pass, cache }
  }
  const probes = (runs: string[][]) => runs.filter(a => a[0] === 'callum-flow-event')

  test('act mode: the probe runs once, the log is read once, and seen holds only the matching transition', async () => {
    const h = harness({ exitCode: 0, stdout: `${NEW_LOG}\n` })
    const r = await h.pass(runtime('act'))
    expect(probes(h.runs)).toEqual([['callum-flow-event', '--new-only', '--new-path', '--repo', REPO]])
    expect(r.v2.dualWrite).toEqual({ readAt: NOW, seen: new Set([`7:${LIFE}:3`]) })
    expect(r.v2.sources.dualWrite.ok).toBe(true)
    await h.pass(runtime('act'))
    expect(probes(h.runs)).toHaveLength(1)
    expect(h.reads).toEqual([NEW_LOG])
  })

  test('an image that dual-writes but lacks --new-only answers the probe with exit 2: off, so H1 plans nothing', async () => {
    const h = harness({ exitCode: 2, stdout: '' })
    const r = await h.pass(runtime('act'))
    expect(r.v2.dualWrite).toBeNull()
    expect(dwActions(world([rec(7)], r.v2.dualWrite))).toEqual([])
  })

  test('an older image (exit 2): off, the source ok, no read', async () => {
    const h = harness({ exitCode: 2, stdout: '' })
    const r = await h.pass(runtime('act'))
    expect(r.v2.dualWrite).toBeNull()
    expect(r.v2.sources.dualWrite.ok).toBe(true)
    expect(h.reads).toEqual([])
    await h.pass(runtime('act'))
    expect(probes(h.runs)).toHaveLength(1)
  })

  test('a thrown probe: the dualWrite source fails, the others do not, and it retries when the read is due', async () => {
    const h = harness(new Error('boom'))
    const r = await h.pass(runtime('act'))
    expect(r.v2.dualWrite).toBeNull()
    expect(r.v2.sources.dualWrite.ok).toBe(false)
    expect(r.v2.sources.store.ok).toBe(true)
    expect(r.v2.sources.prs.ok).toBe(true)
    await h.pass(runtime('act'))
    expect(probes(h.runs)).toHaveLength(1)
    const later = harness(new Error('boom'))
    later.cache.v2.dualWrite = null
    await later.pass(runtime('act'))
    expect(later.cache.v2.dualWrite?.read.error).not.toBeNull()
    later.cache.v2.dualWrite = { at: NOW - 24 * 60 * MIN * 60, read: later.cache.v2.dualWrite?.read as never }
    await later.pass(runtime('act'))
    expect(probes(later.runs)).toHaveLength(2)
  })

  test('a missing file is an empty log', async () => {
    const h = harness({ exitCode: 0, stdout: NEW_LOG }, {})
    const r = await h.pass(runtime('act'))
    expect(r.v2.dualWrite).toEqual({ readAt: NOW, seen: new Set() })
  })

  test('observe mode: no probe, dualWrite null', async () => {
    for (const rt of [runtime('observe')]) {
      const h = harness({ exitCode: 0, stdout: NEW_LOG })
      const r = await h.pass(rt)
      expect(probes(h.runs)).toEqual([])
      expect(r.v2.dualWrite).toBeNull()
      expect(h.reads).toEqual([])
    }
  })
})
