// The merge queue's release hold (docs/factory-loop/v2/SPEC.md 9.1, 7.2): while a release bump PR's
// head is inside its window (at most `releaseHold` from the head's anchor) and its checks are not
// red, the head plans no Q2 and its step is held; Q1 and the records behind it go on. The
// `releasePrs` source (sources-release.ts) and the hold's interventions are tested here too.
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
import type { IssueRecord, V2State } from '../hooks/v2/types'
import { anchorOf } from '../hooks/v2/release-hold-types'
import type { ReleasePr } from '../hooks/v2/release-hold-types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const CFG = config({ mode: 'act', maxInFlightIssues: 3, releaseBranchPrefix: 'chore/release-', releaseHoldMs: 45 * MIN })
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

const BUMP = sha('b')
const bump = (pr: number, ageMin: number, over: Partial<ReleasePr> = {}): ReleasePr => ({ pr, branch: 'chore/release-v1.2.3', createdAt: NOW - ageMin * MIN, head: BUMP, committedAt: null, checkStart: null, checks: 'pending', failed: [], ...over })

// world: two ready records (1 the head), the bump PRs as the source read them.
function world(releasePrs: ReleasePr[] | undefined, over: Partial<State> = {}, v2: Partial<V2State> = {}, left: Record<number, 'merged' | 'closed'> = {}): State {
  const records = [rec(1, { seqAt: NOW - 30 * MIN }), rec(2, { seqAt: NOW - 20 * MIN })]
  const prs = records.map(r => view(r))
  return {
    ...baseState(over),
    v2: {
      ...emptyV2State(NOW, records),
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK, releasePrs: OK, main: OK },
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
    const until = new Date(NOW - 3 * MIN + 45 * MIN).toISOString().slice(11, 16)
    expect(said(r, 1)).toEqual([`merge queue: held for release PR #900 until ${until} UTC`])
    expect(said(r, 2)).toEqual(['merge queue: waits behind #1 (2 of 2)'])
    expect(of(r, 1).filter(a => a.kind === 'tell')).toEqual([])
    expect(s.v2?.records.map(x => x.seqAt)).toEqual([NOW - 30 * MIN, NOW - 20 * MIN])
  })

  test('#1035: a bump PR opened 11 minutes ago with pending checks still holds the head; at 46 minutes from its anchor the head merges', () => {
    expect(kinds(plan(world([bump(900, 11)])))).toEqual([])
    expect(said(plan(world([bump(900, 11)])), 1)[0]).toContain('held for release PR #900')
    expect(kinds(plan(world([bump(900, 46)])))).toEqual([['queue-merge', 1]])
    // green checks keep holding too
    expect(kinds(plan(world([bump(900, 11, { checks: 'green' })])))).toEqual([])
    // a head with no checks read is held as pending
    expect(kinds(plan(world([bump(900, 11, { checks: null })])))).toEqual([])
  })

  test('a PR gone from the list, or none read, lets Q2 merge the head on that pass', () => {
    expect(kinds(plan(world([])))).toEqual([['queue-merge', 1]])
    expect(kinds(plan(world(undefined)))).toEqual([['queue-merge', 1]])
  })

  test('the window runs from the latest of createdAt, the head commit time and the earliest check start; a missing piece is left out', () => {
    // opened 40 minutes ago: 5 minutes of window left; a head committed 2 minutes ago holds until 2+45
    expect(kinds(plan(world([bump(900, 40)])))).toEqual([])
    const committed = plan(world([bump(900, 40, { committedAt: NOW - 2 * MIN })]))
    expect(said(committed, 1)).toEqual([`merge queue: held for release PR #900 until ${new Date(NOW - 2 * MIN + 45 * MIN).toISOString().slice(11, 16)} UTC`])
    // checks that started 1 minute ago move the anchor later; one that started before the commit does not
    expect(said(plan(world([bump(900, 40, { committedAt: NOW - 2 * MIN, checkStart: NOW - MIN })])), 1)[0]).toContain(new Date(NOW - MIN + 45 * MIN).toISOString().slice(11, 16))
    expect(said(plan(world([bump(900, 40, { committedAt: NOW - 2 * MIN, checkStart: NOW - 30 * MIN })])), 1)[0]).toContain(new Date(NOW - 2 * MIN + 45 * MIN).toISOString().slice(11, 16))
    expect(anchorOf(bump(900, 40))).toBe(NOW - 40 * MIN)
  })

  test('failed or cancelled checks end the hold on that pass: the head merges', () => {
    expect(kinds(plan(world([bump(900, 3, { checks: 'red', failed: ['ci'] })])))).toEqual([['queue-merge', 1]])
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
    const r = plan(world([bump(900, 8), bump(901, 2, { branch: 'chore/release-v1.2.4', head: sha('e') })]))
    expect(said(r, 1)[0]).toContain('#901')
  })
})

describe('the hold:release interventions (v2 SPEC 7.2)', () => {
  const done = (fact: string): LedgerEntry => entry(interventionKey(fact), 'event', { issue: null, startedAt: NOW - MIN, endedAt: NOW - MIN + 100 })
  const START = releaseFact(900, BUMP, 'start')
  const END = releaseFact(900, BUMP, 'end')
  const tellKey = `tell:release-hold:900:${BUMP.slice(0, 12)}`
  const tells = (r: PlanResult) => r.actions.filter(a => a.kind === 'tell' && a.wake === 'release-hold')
  const headOf = (r: PlanResult) => ivs(r).map(a => (a.kind === 'event' && a.event.state === 'intervention' ? a.event.head : undefined))

  test('the start is one loop intervention on the bump PR and its head, naming the branch and the held heads', () => {
    const r = plan(world([bump(900, 3)]))
    expect(causes(r)).toEqual(['loop hold:release'])
    const a = ivs(r)[0]
    expect(a?.key).toBe(interventionKey(START))
    expect(START).toBe(`hold/release/pr900/h${'b'.repeat(12)}/start`)
    expect(a?.kind === 'event' && a.event.state === 'intervention' ? [a.event.pr, a.event.issue, a.event.fact, a.event.head] : []).toEqual([900, null, START, BUMP])
    expect(a?.kind === 'event' && a.event.state === 'intervention' ? a.event.reason : '').toContain('#1, #2')
  })

  test('the start is logged once: not again from the ledger, nor from the event log', () => {
    expect(causes(plan(world([bump(900, 3)], { ledger: [done(START)] })))).toEqual([])
    const logged = [`intervention loop hold:release ${START}`]
    expect(causes(plan(world([bump(900, 3)], {}, { logged })))).toEqual([])
  })

  test('the end is merged or closed when the PR left the list, with the state read, once', () => {
    const start = done(START)
    for (const how of ['merged', 'closed'] as const) {
      const r = plan(world([], { ledger: [start] }, {}, { 900: how }))
      expect(causes(r)).toEqual([`loop hold:release-${how}`])
      expect(ivs(r)[0]?.key).toBe(interventionKey(END))
      expect(causes(plan(world([], { ledger: [start, done(END)] }, {}, { 900: how })))).toEqual([])
    }
    // a restart between the start and the end: the ledger holds the start, the cache is empty, the end waits for the read
    expect(causes(plan(world([], { ledger: [start] })))).toEqual([])
  })

  test('the end is a timeout when the head is still open after its window, once, with one owner item naming the PR, branch, head, minutes and checks', () => {
    const start = done(START)
    const r = plan(world([bump(900, 46)], { ledger: [start] }))
    expect(causes(r)).toEqual(['loop hold:release-timeout'])
    expect(tells(r).map(t => (t.kind === 'tell' ? [t.key, t.fields] : null))).toEqual([[tellKey, { pr: '900', branch: 'chore/release-v1.2.3', head: BUMP, minutes: '46', checks: 'pending' }]])
    // a second pass, both logged: neither is planned again
    const again = plan(world([bump(900, 46)], { ledger: [start, done(END), entry(tellKey, 'tell')] }))
    expect(causes(again)).toEqual([])
    expect(tells(again)).toEqual([])
    // an open PR inside its window has no end and no tell yet
    const inside = plan(world([bump(900, 5)], { ledger: [start] }))
    expect(causes(inside)).toEqual([])
    expect(tells(inside)).toEqual([])
    // green checks past the window time out too
    expect(causes(plan(world([bump(900, 46, { checks: 'green' })], { ledger: [start] })))).toEqual(['loop hold:release-timeout'])
  })

  test('red checks end the hold the same pass as failed, naming the failed checks, with no owner item', () => {
    for (const failed of [['ci'], ['lint']]) {
      const r = plan(world([bump(900, 3, { checks: 'red', failed })], { ledger: [done(START)] }))
      expect(causes(r)).toEqual(['loop hold:release-failed'])
      const a = ivs(r)[0]
      expect(a?.kind === 'event' && a.event.state === 'intervention' ? [a.event.reason.includes(failed[0] ?? ''), a.event.failed_jobs, a.event.head] : []).toEqual([true, failed, BUMP])
      expect(tells(r)).toEqual([])
    }
    // red on first sight: no window starts
    expect(causes(plan(world([bump(900, 3, { checks: 'red' })])))).toEqual([])
  })

  test('a push ends the old window as pushed and starts one for the new head, each once, with the head set', () => {
    const NEW = sha('f')
    const r = plan(world([bump(900, 40, { head: NEW, committedAt: NOW - 2 * MIN })], { ledger: [done(START)] }))
    expect(causes(r)).toEqual(['loop hold:release', 'loop hold:release-pushed'])
    expect(ivs(r).map(a => a.key)).toEqual([interventionKey(releaseFact(900, NEW, 'start')), interventionKey(END)])
    expect(headOf(r)).toEqual([NEW, BUMP.slice(0, 12)])
    expect(kinds(r)).toEqual([])
    const second = plan(world([bump(900, 40, { head: NEW, committedAt: NOW - 2 * MIN })], { ledger: [done(START), done(END), done(releaseFact(900, NEW, 'start'))] }))
    expect(causes(second)).toEqual([])
  })

  test('upgrade: a start in the old form with no end is ended once (merged, closed, timeout) and never started again in the old form', () => {
    const old = done('hold/release/pr900/start')
    const oldEnd = interventionKey('hold/release/pr900/end')
    for (const how of ['merged', 'closed'] as const) {
      const r = plan(world([], { ledger: [old] }, {}, { 900: how }))
      expect(causes(r)).toEqual([`loop hold:release-${how}`])
      expect(ivs(r)[0]?.key).toBe(oldEnd)
      expect(causes(plan(world([], { ledger: [old, done('hold/release/pr900/end')] }, {}, { 900: how })))).toEqual([])
    }
    const timeout = plan(world([bump(900, 46)], { ledger: [old] }))
    expect(causes(timeout)).toEqual(['loop hold:release-timeout'])
    expect(ivs(timeout)[0]?.key).toBe(oldEnd)
    // inside the window the old hold stays open, and only the new form starts
    const inside = plan(world([bump(900, 3)], { ledger: [old] }))
    expect(ivs(inside).map(a => a.key)).toEqual([interventionKey(START)])
  })

  test('no start for a PR first seen after its window', () => {
    expect(causes(plan(world([bump(900, 46)])))).toEqual([])
    expect(tells(plan(world([bump(900, 46)])))).toEqual([])
  })
})

describe('the releasePrs source (sources-release.ts, v2 SPEC 2.4)', () => {
  const LIST = (items: unknown[]) => JSON.stringify(items)
  const item = (number: number, headRefName: string, minAgo: number, isCrossRepository = false, headRefOid = BUMP) => ({ number, headRefName, headRefOid, createdAt: new Date(NOW - minAgo * MIN).toISOString(), isCrossRepository })
  const commits = (head: string, minAgo: number) => JSON.stringify({ headRefOid: head, commits: [{ oid: sha('9'), committedDate: new Date(NOW - 90 * MIN).toISOString() }, { oid: head, committedDate: new Date(NOW - minAgo * MIN).toISOString() }] })
  const check = (bucket: string, startedMinAgo: number | null, name = 'ci') => ({ name, state: bucket.toUpperCase(), bucket, startedAt: startedMinAgo === null ? '0001-01-01T00:00:00Z' : new Date(NOW - startedMinAgo * MIN).toISOString(), completedAt: '0001-01-01T00:00:00Z', link: `https://github.com/${REPO}/actions/runs/9001/job/1` })
  // the bump PR's world: a list, the head's commits and checks
  const gh = (o: { list?: unknown[]; view?: string; checks?: unknown[] | 'fail' } = {}) => (argv: string[]) => {
    if (argv[2] === 'list') return { stdout: LIST(o.list ?? [item(900, 'chore/release-v1.2.3', 3)]) }
    if (argv[2] === 'view') return { stdout: o.view ?? commits(BUMP, 2) }
    if (argv[2] === 'checks') return o.checks === 'fail' ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 8, stdout: JSON.stringify(o.checks ?? [check('pending', 1)]) }
    return { stdout: '[]' }
  }

  function ctxOf(reply: (argv: string[]) => { exitCode?: number; stdout?: string; stderr?: string }, over: Partial<SourceCtx> = {}, cfg = CFG, records: IssueRecord[] = [rec(1)]) {
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

  test('the parser keeps only same-repo PRs on the prefix, with their head, and says nothing for a shape it does not know', () => {
    const text = LIST([item(1, 'chore/release-v1.0.0', 3), item(2, 'chore/release-v1.0.1', 3, true), item(3, 'issue-9', 3)])
    expect(parseReleasePrs(text, 'chore/release-')?.map(p => [p.pr, p.head])).toEqual([[1, BUMP]])
    expect(parseReleasePrs('not json', 'chore/release-')).toBeNull()
    expect(parseReleasePrs(LIST([{ number: 1 }]), 'chore/release-')).toBeNull()
  })

  test('one gh pr list with headRefOid, one pr view for the head commit, one pr checks per bump PR; none again before prEveryMs', async () => {
    const { ctx, argvs } = ctxOf(gh())
    const first = await readReleasePrs(ctx, EMPTY_RELEASE)
    expect(argvs).toEqual([
      ['gh', 'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid,createdAt,isCrossRepository'],
      ['gh', 'pr', 'view', '900', '--repo', REPO, '--json', 'headRefOid,commits'],
      ['gh', 'pr', 'checks', '900', '--repo', REPO, '--json', 'name,state,bucket,startedAt,completedAt,link'],
    ])
    expect(first.read.prs.map(p => [p.pr, p.head, p.committedAt, p.checks])).toEqual([[900, BUMP, NOW - 2 * MIN, 'pending']])
    expect(first.read.prs[0]?.checkStart).toBe(NOW - MIN)
    expect(first.source.ok).toBe(true)
    const soon = ctxOf(() => ({ stdout: '[]' }), { now: NOW + 10_000 })
    const again = await readReleasePrs(soon.ctx, first.read)
    expect(soon.argvs).toEqual([])
    expect(again.read.prs.map(p => p.pr)).toEqual([900])
  })

  test('the head commit is read once per head: the same head reads checks only, a new head reads the commit again', async () => {
    const first = await readReleasePrs(ctxOf(gh()).ctx, EMPTY_RELEASE)
    const same = ctxOf(gh({ checks: [check('pass', 5), check('skipping', 4, 'lint')] }), { now: NOW + HOUR })
    const green = await readReleasePrs(same.ctx, first.read)
    expect(same.argvs.map(a => a[2])).toEqual(['list', 'checks'])
    expect(green.read.prs[0]).toMatchObject({ committedAt: NOW - 2 * MIN, checks: 'green' })
    const NEW = sha('f')
    const moved = ctxOf(gh({ list: [item(900, 'chore/release-v1.2.3', 3, false, NEW)], view: commits(NEW, 1), checks: [] }), { now: NOW + 2 * HOUR })
    const pushed = await readReleasePrs(moved.ctx, green.read)
    expect(moved.argvs.map(a => a[2])).toEqual(['list', 'view', 'checks'])
    // a new head with no check reported is pending, with no start
    expect(pushed.read.prs[0]).toMatchObject({ head: NEW, committedAt: NOW - MIN, checks: 'pending', checkStart: null })
  })

  test('checks are red on a fail or cancel bucket (naming it), pending on a running one, green on pass and skipping', async () => {
    for (const [checks, state, failed] of [
      [[check('pass', 5), check('fail', 4, 'lint')], 'red', ['lint']],
      [[check('cancel', 4, 'build'), check('pending', 3)], 'red', ['build']],
      [[check('pass', 5), check('pending', 3)], 'pending', []],
      [[], 'pending', []],
      [[check('pass', 5), check('skipping', 3)], 'green', []],
    ] as const) {
      const r = await readReleasePrs(ctxOf(gh({ checks: [...checks] })).ctx, EMPTY_RELEASE)
      expect([r.read.prs[0]?.checks, r.read.prs[0]?.failed]).toEqual([state, failed])
    }
  })

  test('a failed list read keeps the last reading and shows the failure', async () => {
    const kept: ReleaseCache = { ...EMPTY_RELEASE, prs: [bump(900, 3)], at: NOW - 5 * MIN }
    for (const reply of [{ exitCode: 1, stdout: '' }, { stdout: 'garbage' }]) {
      const { ctx } = ctxOf(() => reply)
      const r = await readReleasePrs(ctx, kept)
      expect(r.read.prs.map(p => p.pr)).toEqual([900])
      expect(r.source.ok).toBe(false)
    }
  })

  test('a failed head or checks read keeps the last reading of the same head; a new head with none is unread (held as pending)', async () => {
    const kept: ReleaseCache = { ...EMPTY_RELEASE, prs: [bump(900, 3, { committedAt: NOW - 2 * MIN, checkStart: NOW - MIN, checks: 'green' })], at: NOW - 5 * MIN }
    const r = await readReleasePrs(ctxOf(gh({ checks: 'fail' })).ctx, kept)
    expect(r.read.prs[0]).toMatchObject({ committedAt: NOW - 2 * MIN, checkStart: NOW - MIN, checks: 'green' })
    expect(r.source.ok).toBe(true)
    const NEW = sha('f')
    const bad = (argv: string[]) => (argv[2] === 'list' ? { stdout: LIST([item(900, 'chore/release-v1.2.3', 3, false, NEW)]) } : { exitCode: 1, stdout: '' })
    const fresh = await readReleasePrs(ctxOf(bad).ctx, kept)
    expect(fresh.read.prs[0]).toMatchObject({ head: NEW, committedAt: null, checkStart: null, checks: null })
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

  test('a restart (empty cache) finds the PR to read from a ledger start with no end, in the new and the old key form', async () => {
    for (const fact of [releaseFact(900, BUMP, 'start'), 'hold/release/pr900/start']) {
      const start = entry(interventionKey(fact), 'event', { issue: null, startedAt: NOW - MIN, endedAt: NOW - MIN + 100 })
      const { ctx } = ctxOf(argv => (argv[2] === 'view' ? { stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z' }) } : { stdout: '[]' }), { state: baseState({ ledger: [start] }) })
      expect((await readReleasePrs(ctx, EMPTY_RELEASE)).read.left).toEqual({ 900: 'merged' })
    }
  })
})

describe('the release settings (Appendix A)', () => {
  test('the defaults: no prefix, 45 minutes', () => {
    const c = loadConfig()
    expect([c.config.releaseBranchPrefix, c.config.releaseHoldMs]).toEqual([null, 45 * MIN])
  })

  test('a later layer wins, releaseHold takes a duration or 0, and a bad value is one problem that falls back', () => {
    const c = loadConfig({ releaseBranchPrefix: 'a/', releaseHold: '20m' }, { releaseBranchPrefix: 'chore/release-', releaseHold: 0 })
    expect([c.config.releaseBranchPrefix, c.config.releaseHoldMs, c.problems]).toEqual(['chore/release-', 0, []])
    const bad = loadConfig({ releaseBranchPrefix: '', releaseHold: 'soon' })
    expect([bad.config.releaseBranchPrefix, bad.config.releaseHoldMs]).toEqual([null, 45 * MIN])
    expect(bad.problems.length).toBe(2)
    expect(loadConfig({ releaseBranchPrefix: 5 }).problems.length).toBe(1)
  })
})
