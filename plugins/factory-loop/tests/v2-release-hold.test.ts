// The merge queue's release hold (docs/factory-loop/v2/SPEC.md 9.1, 7.2): while a release bump PR
// is open within `releaseHold` of its creation, the head plans no Q2 and its step is held; Q1 and
// the records behind it go on. The `releasePrs` source (sources-release.ts) and the hold's two
// interventions are tested here too.
import { describe, expect, test } from 'claude-code/testing'

import type { Runtime } from '../hooks/observe'
import { loadConfig } from '../hooks/config'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { interventionKey, lifeOf } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import type { SourceCtx } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { releaseFact } from '../hooks/v2/rules-release-hold'
import { EMPTY_RELEASE, parseReleasePrs, readReleasePrs } from '../hooks/v2/sources-release'
import type { ReleaseCache } from '../hooks/v2/sources-release'
import type { PrView } from '../hooks/v2/sources-prs'
import { madeRecord } from '../hooks/v2/table'
import type { IssueRecord, ReleasePr, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const CFG = config({ mode: 'act', maxInFlightIssues: 3, releaseBranchPrefix: 'chore/release-', releaseHoldMs: 10 * MIN })
const LIFE = lifeOf(NOW - 2 * HOUR)
const sha = (c: string) => c.repeat(40)
const HEAD = sha('a')
const PATCH = sha('c')
const MAIN = sha('d')
const OK = { ok: true, at: NOW }

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - HOUR),
    seq: 5,
    seqAt: NOW - 20 * MIN,
    since: NOW - 20 * MIN,
    state: 'merge-queue',
    step: 'queue',
    pr: 600 + n,
    head: HEAD,
    approvedPatch: PATCH,
    round: 1,
    ...over,
  }
}

function view(r: IssueRecord, over: Partial<PrView> = {}): PrView {
  const check = { name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: NOW - 5 * MIN, completedAt: NOW - 2 * MIN, runId: '9001', link: `https://github.com/${REPO}/actions/runs/9001/job/1` }
  return { pr: r.pr ?? 0, issue: r.issue, state: 'open', head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: MAIN, baseRef: 'main', labels: [], checks: [check], patch: PATCH, readAt: NOW, ...over }
}

const bump = (pr: number, ageMin: number, over: Partial<ReleasePr> = {}): ReleasePr => ({ pr, branch: 'chore/release-v1.2.3', createdAt: NOW - ageMin * MIN, ...over })

// world: two ready records (1 the head), the bump PRs as the source read them.
function world(releasePrs: ReleasePr[] | undefined, over: Partial<State> = {}, v2: Partial<V2State> = {}, left: Record<number, 'merged' | 'closed'> = {}): State {
  const records = [rec(1, { seqAt: NOW - 30 * MIN }), rec(2, { seqAt: NOW - 20 * MIN })]
  const prs = records.map(r => view(r))
  return {
    ...baseState(over),
    v2: {
      ...emptyV2State(NOW, records),
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK, releasePrs: OK },
      prs: { prs, main: { branch: 'main', sha: MAIN } },
      heads: { [HEAD]: { pr: 601, at: NOW - 15 * MIN } },
      reads: Object.fromEntries(records.map(r => [r.issue, { at: NOW, open: true, labels: [] as string[] }])),
      ...(releasePrs === undefined ? {} : { releasePrs: { prs: releasePrs, left } }),
      ...v2,
    },
  }
}

const plan = (s: State, cfg = CFG): PlanResult => planV2(s, cfg)
const of = (r: PlanResult, n: number): Action[] => r.actions.filter(a => a.issue === n && a.kind !== 'title')
const said = (r: PlanResult, n: number) => r.skipped.filter(s => s.issue === n).map(s => s.why)
const queueActions = (r: PlanResult) => r.actions.filter((a): a is Extract<Action, { kind: 'queue-update' | 'queue-merge' }> => a.kind === 'queue-update' || a.kind === 'queue-merge')
const kinds = (r: PlanResult) => queueActions(r).map(a => [a.kind, a.issue])
const ivs = (r: PlanResult) => r.actions.flatMap(a => (a.kind === 'event' && a.event.state === 'intervention' && a.event.cause.startsWith('hold:release') ? [a] : []))
const causes = (r: PlanResult) => ivs(r).map(a => (a.kind === 'event' ? `${a.event.who} ${a.event.state === 'intervention' ? a.event.cause : ''}` : ''))

describe('the release hold on Q2 (v2 SPEC 9.1)', () => {
  test('a bump PR opened 3 minutes ago holds the head: no queue-merge, the step is held with the release line, the record behind keeps its waiting line', () => {
    const s = world([bump(900, 3)])
    const r = plan(s)
    expect(kinds(r)).toEqual([])
    const until = new Date(NOW - 3 * MIN + 10 * MIN).toISOString().slice(11, 16)
    expect(said(r, 1)).toEqual([`merge queue: held for release PR #900 until ${until} UTC`])
    expect(said(r, 2)).toEqual(['merge queue: waits behind #1 (2 of 2)'])
    expect(of(r, 1).filter(a => a.kind === 'tell')).toEqual([])
    expect(s.v2?.records.map(x => x.seqAt)).toEqual([NOW - 30 * MIN, NOW - 20 * MIN])
  })

  test('the same PR at 11 minutes old, or gone from the list, lets Q2 merge the head on that pass', () => {
    expect(kinds(plan(world([bump(900, 11)])))).toEqual([['queue-merge', 1]])
    expect(kinds(plan(world([])))).toEqual([['queue-merge', 1]])
    expect(kinds(plan(world(undefined)))).toEqual([['queue-merge', 1]])
  })

  test('a cross-repository PR is never listed, and a branch outside the prefix holds nothing', () => {
    expect(kinds(plan(world([bump(900, 3, { branch: 'feature/x' })])))).toEqual([['queue-merge', 1]])
  })

  test('the prefix unset, or releaseHold 0, holds nothing', () => {
    const s = world([bump(900, 3)])
    expect(kinds(plan(s, config({ ...CFG, releaseBranchPrefix: null })))).toEqual([['queue-merge', 1]])
    expect(kinds(plan(s, config({ ...CFG, releaseHoldMs: 0 })))).toEqual([['queue-merge', 1]])
  })

  test('during the hold a behind head still gets its Q1 update', () => {
    const s = world([bump(900, 3)])
    const records = s.v2?.records ?? []
    const behind = records.map(rr => view(rr, { mergeable: 'behind' }))
    const r = plan({ ...s, v2: { ...(s.v2 as V2State), prs: { prs: behind, main: { branch: 'main', sha: MAIN } } } })
    expect(kinds(r)).toEqual([['queue-update', 1]])
  })

  test('the latest end of the windows in force names the hold', () => {
    const r = plan(world([bump(900, 8), bump(901, 2, { branch: 'chore/release-v1.2.4' })]))
    expect(said(r, 1)[0]).toContain('#901')
  })
})

describe('the hold:release interventions (v2 SPEC 7.2)', () => {
  const done = (fact: string): LedgerEntry => entry(interventionKey(fact), 'event', { issue: null, startedAt: NOW - MIN, endedAt: NOW - MIN + 100 })

  test('the start is one loop intervention on the bump PR, naming the branch and the held heads', () => {
    const r = plan(world([bump(900, 3)]))
    expect(causes(r)).toEqual(['loop hold:release'])
    const a = ivs(r)[0]
    expect(a?.key).toBe(interventionKey(releaseFact(900, 'start')))
    expect(a?.kind === 'event' && a.event.state === 'intervention' ? [a.event.pr, a.event.issue, a.event.fact] : []).toEqual([900, null, releaseFact(900, 'start')])
    expect(a?.kind === 'event' && a.event.state === 'intervention' ? a.event.reason : '').toContain('#1, #2')
  })

  test('the start is logged once: not again from the ledger, nor from the event log', () => {
    const fact = releaseFact(900, 'start')
    expect(causes(plan(world([bump(900, 3)], { ledger: [done(fact)] })))).toEqual([])
    const logged = [`intervention loop hold:release ${fact}`]
    expect(causes(plan(world([bump(900, 3)], {}, { logged })))).toEqual([])
  })

  test('the end is merged or closed when the PR left the list, with the state read, once', () => {
    const start = done(releaseFact(900, 'start'))
    for (const how of ['merged', 'closed'] as const) {
      const r = plan(world([], { ledger: [start] }, {}, { 900: how }))
      expect(causes(r)).toEqual([`loop hold:release-${how}`])
      expect(ivs(r)[0]?.key).toBe(interventionKey(releaseFact(900, 'end')))
      expect(causes(plan(world([], { ledger: [start, done(releaseFact(900, 'end'))] }, {}, { 900: how })))).toEqual([])
    }
    // a restart between the start and the end: the ledger holds the start, the cache is empty, the end waits for the read
    expect(causes(plan(world([], { ledger: [start] })))).toEqual([])
  })

  test('the end is a timeout when the PR is still open after its window, once', () => {
    const start = done(releaseFact(900, 'start'))
    const r = plan(world([bump(900, 11)], { ledger: [start] }))
    expect(causes(r)).toEqual(['loop hold:release-timeout'])
    expect(causes(plan(world([bump(900, 11)], { ledger: [start, done(releaseFact(900, 'end'))] })))).toEqual([])
    // an open PR inside its window has no end yet
    expect(causes(plan(world([bump(900, 5)], { ledger: [start] })))).toEqual([])
  })

  test('no start for a PR first seen after its window', () => {
    expect(causes(plan(world([bump(900, 11)])))).toEqual([])
  })
})

describe('the releasePrs source (sources-release.ts, v2 SPEC 2.4)', () => {
  const LIST = (items: unknown[]) => JSON.stringify(items)
  const item = (number: number, headRefName: string, minAgo: number, isCrossRepository = false) => ({ number, headRefName, createdAt: new Date(NOW - minAgo * MIN).toISOString(), isCrossRepository })

  function ctxOf(reply: (argv: string[]) => { exitCode?: number; stdout?: string }, over: Partial<SourceCtx> = {}, cfg = CFG, records: IssueRecord[] = [rec(1)]) {
    const argvs: string[][] = []
    const rt: Runtime = { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: cfg, configProblems: [] }
    const ctx: SourceCtx = {
      now: NOW,
      rt,
      run: async argv => {
        argvs.push([...argv])
        return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
      },
      readFile: async () => null,
      state: baseState(),
      records,
      heads: {},
      prBudget: 3,
      limited: () => false,
      unread: [],
      kept: [],
      tag: null,
      ...over,
    }
    return { ctx, argvs }
  }

  test('the parser keeps only same-repo PRs on the prefix, and says nothing for a shape it does not know', () => {
    const text = LIST([item(1, 'chore/release-v1.0.0', 3), item(2, 'chore/release-v1.0.1', 3, true), item(3, 'issue-9', 3)])
    expect(parseReleasePrs(text, 'chore/release-')?.map(p => p.pr)).toEqual([1])
    expect(parseReleasePrs('not json', 'chore/release-')).toBeNull()
    expect(parseReleasePrs(LIST([{ number: 1 }]), 'chore/release-')).toBeNull()
  })

  test('one gh pr list with the fields it needs, the PRs kept, and the list not read again before prEveryMs', async () => {
    const { ctx, argvs } = ctxOf(() => ({ stdout: LIST([item(900, 'chore/release-v1.2.3', 3)]) }))
    const first = await readReleasePrs(ctx, EMPTY_RELEASE)
    expect(argvs).toEqual([['gh', 'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,createdAt,isCrossRepository']])
    expect(first.read.prs.map(p => p.pr)).toEqual([900])
    expect(first.source.ok).toBe(true)
    const soon = ctxOf(() => ({ stdout: '[]' }), { now: NOW + 10_000 })
    const again = await readReleasePrs(soon.ctx, first.read)
    expect(soon.argvs).toEqual([])
    expect(again.read.prs.map(p => p.pr)).toEqual([900])
  })

  test('a failed read keeps the last reading and shows the failure', async () => {
    const kept: ReleaseCache = { ...EMPTY_RELEASE, prs: [bump(900, 3)], at: NOW - 5 * MIN }
    for (const reply of [{ exitCode: 1, stdout: '' }, { stdout: 'garbage' }]) {
      const { ctx } = ctxOf(() => reply)
      const r = await readReleasePrs(ctx, kept)
      expect(r.read.prs.map(p => p.pr)).toEqual([900])
      expect(r.source.ok).toBe(false)
    }
  })

  test('no read runs with no merge-queue record, the setting off, or a GitHub backoff', async () => {
    const reply = () => ({ stdout: '[]' })
    const none = ctxOf(reply, {}, CFG, [rec(1, { state: 'reviewing', step: 'review' })])
    expect((await readReleasePrs(none.ctx, EMPTY_RELEASE)).read.prs).toEqual([])
    expect(none.argvs).toEqual([])
    for (const cfg of [config({ ...CFG, releaseBranchPrefix: null }), config({ ...CFG, releaseHoldMs: 0 })]) {
      const off = ctxOf(reply, {}, cfg)
      await readReleasePrs(off.ctx, EMPTY_RELEASE)
      expect(off.argvs).toEqual([])
    }
    const backoff = ctxOf(reply, { state: baseState({ githubBackoffUntil: NOW + 5 * MIN }) })
    await readReleasePrs(backoff.ctx, EMPTY_RELEASE)
    expect(backoff.argvs).toEqual([])
    const limited = ctxOf(reply, { limited: () => true })
    await readReleasePrs(limited.ctx, EMPTY_RELEASE)
    expect(limited.argvs).toEqual([])
  })

  test('a PR that left the list is read once for how it ended; a read that failed is tried again', async () => {
    const kept: ReleaseCache = { ...EMPTY_RELEASE, prs: [bump(900, 3)], at: NOW - 5 * MIN }
    const view = (state: string) => (argv: string[]) => (argv[2] === 'view' ? { stdout: JSON.stringify({ state, mergedAt: state === 'MERGED' ? '2026-10-18T10:00:00Z' : null }) } : { stdout: '[]' })
    for (const [state, how] of [['MERGED', 'merged'], ['CLOSED', 'closed']] as const) {
      const { ctx, argvs } = ctxOf(view(state))
      const r = await readReleasePrs(ctx, kept)
      expect(argvs.map(a => a.slice(0, 3))).toEqual([['gh', 'pr', 'list'], ['gh', 'pr', 'view']])
      expect(argvs[1]).toEqual(['gh', 'pr', 'view', '900', '--repo', REPO, '--json', 'state,mergedAt'])
      expect(r.read.left).toEqual({ 900: how })
    }
    const failing = ctxOf(argv => (argv[2] === 'view' ? { exitCode: 1 } : { stdout: '[]' }))
    const first = await readReleasePrs(failing.ctx, kept)
    expect(first.read.left).toEqual({})
    expect(first.read.gone).toEqual([900])
    const later = ctxOf(view('MERGED'), { now: NOW + MIN })
    expect((await readReleasePrs(later.ctx, first.read)).read.left).toEqual({ 900: 'merged' })
  })

  test('a restart (empty cache) finds the PR to read from the ledger start with no end', async () => {
    const start = entry(interventionKey(releaseFact(900, 'start')), 'event', { issue: null, startedAt: NOW - MIN, endedAt: NOW - MIN + 100 })
    const { ctx } = ctxOf(argv => (argv[2] === 'view' ? { stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z' }) } : { stdout: '[]' }), { state: baseState({ ledger: [start] }) })
    expect((await readReleasePrs(ctx, EMPTY_RELEASE)).read.left).toEqual({ 900: 'merged' })
  })
})

describe('the release settings (Appendix A)', () => {
  test('the defaults: no prefix, 10 minutes', () => {
    const c = loadConfig()
    expect([c.config.releaseBranchPrefix, c.config.releaseHoldMs]).toEqual([null, 10 * MIN])
  })

  test('a later layer wins, releaseHold takes a duration or 0, and a bad value is one problem that falls back', () => {
    const c = loadConfig({ releaseBranchPrefix: 'a/', releaseHold: '20m' }, { releaseBranchPrefix: 'chore/release-', releaseHold: 0 })
    expect([c.config.releaseBranchPrefix, c.config.releaseHoldMs, c.problems]).toEqual(['chore/release-', 0, []])
    const bad = loadConfig({ releaseBranchPrefix: '', releaseHold: 'soon' })
    expect([bad.config.releaseBranchPrefix, bad.config.releaseHoldMs]).toEqual([null, 10 * MIN])
    expect(bad.problems.length).toBe(2)
    expect(loadConfig({ releaseBranchPrefix: 5 }).problems.length).toBe(1)
  })
})
