// S1's starved notice (docs/factory-loop/v2/SPEC.md 14.1): the pass verdict, the spell's tell and its
// key, the roots and why each is not moving (rules-starved.ts), and the bounded read of the blockers
// (sources-blockers.ts).
import { describe, expect, test } from 'claude-code/testing'

import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { followKey, lifeOf } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import type { SourceCtx } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { rootsOf, whyOf } from '../hooks/v2/rules-starved'
import { MAX_DEPTH, MAX_READS, blockedByOf, readBlockers } from '../hooks/v2/sources-blockers'
import { madeRecord } from '../hooks/v2/table'
import type { BlockerNode, BlockerTree, IssueRecord, V2State } from '../hooks/v2/types'
import { MIN, NOW, config, control, entry, issue, state as baseState } from './fixtures'
import { REPO } from './host'

const HOUR = 60 * MIN
const DAY = 24 * HOUR
const OK = { ok: true, at: NOW }
const CFG = config({ mode: 'act', maxInFlightIssues: 3, skipLabels: ['skip-factory'] })
const LIFE = lifeOf(NOW - 5 * HOUR)

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 4 * HOUR), seq: 3, seqAt: NOW - 3 * HOUR, state: 'building', step: 'build', since: NOW - 3 * HOUR, ...over }
}

const node = (over: Partial<BlockerNode> = {}): BlockerNode => ({ open: true, labels: ['ready'], title: null, blockers: [], foreign: [], read: 'ok', ...over })
const tree = (nodes: Record<number, BlockerNode>, since: number, over: Partial<BlockerTree> = {}): BlockerTree => ({ since, period: 0, readAt: NOW, nodes, truncated: false, error: null, ...over })

// blockedQueue: three ready issues, each blocked by one open issue.
const BLOCKED = [issue(10, { blockedBy: 1 }), issue(11, { blockedBy: 1 }), issue(12, { blockedBy: 1 })]

function world(over: Partial<State> = {}, v2: Partial<V2State> = {}, records: IssueRecord[] = []): State {
  const s = baseState({ queue: [10, 11, 12], issues: BLOCKED, ...over })
  return { ...s, v2: { ...emptyV2State(NOW, records), sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK, releasePrs: OK }, ...v2 } }
}

// the classic: 10 and 11 wait on 20, 12 on 30
const NODES: Record<number, BlockerNode> = {
  10: node({ blockers: [20] }),
  11: node({ blockers: [20] }),
  12: node({ blockers: [30] }),
  20: node({ title: 'Release the thing', labels: ['ready'] }),
  30: node({ title: 'A idea', labels: ['enhancement'] }),
}
const merged20 = rec(20, { state: 'closed', step: null, why: 'merged', since: NOW - 2 * HOUR })
const runIt = (r: IssueRecord, rollout: string): LedgerEntry => entry(followKey(r, 'rollout'), 'rollout', { issue: r.issue, outcome: { kind: 'rollout', rollout, closeIssue: null } as never })

const SINCE = NOW - 61 * MIN
const starvedTree = (since = SINCE, nodes = NODES) => ({ starvedSince: since, blockers: tree(nodes, since) })
const tells = (r: PlanResult): Extract<Action, { kind: 'tell' }>[] => r.actions.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell' && a.wake === 'starved')
const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })

describe('S1: the starved verdict and its tell', () => {
  const full = () => withLedger(world({ release: { tag: 'v1', oldest: NOW - 5 * HOUR } }, starvedTree(), [merged20]), [runIt(merged20, 'run-it')])

  test('a blocked queue with nothing in flight, 61 minutes in: one owner tell that names each root and why', () => {
    const p = planV2(full(), CFG)
    expect(p.starved).toBe(true)
    expect(tells(p)).toEqual([
      expect.objectContaining({
        key: `tell:starved:${SINCE}:0`,
        rule: 'S1',
        fields: { since: new Date(SINCE).toISOString(), minutes: '61', period: '0', queue: '3', blocked: '3', roots: '20,30', why: '20=run-it-unreleased,30=not-ready' },
        context: [
          '#20 Release the thing: waiting on its Run it, and its merge is in no release yet - blocks 2 ready issues (#10 #11)',
          '#30 A idea: not ready - blocks 1 ready issue (#12)',
        ],
      }),
    ])
    expect(p.owner).toBe(1)
  })

  test('59 minutes in: starved, but no tell yet', () => {
    const p = planV2(world({}, starvedTree(NOW - 59 * MIN)), CFG)
    expect(p.starved).toBe(true)
    expect(tells(p)).toEqual([])
  })

  test('with no spell recorded (its first pass) the pass is starved and tells nothing', () => {
    const p = planV2(world(), CFG)
    expect(p.starved).toBe(true)
    expect(tells(p)).toEqual([])
  })

  test('the tell is once per spell and period: the ledger holds its key; 25 h on it tells again with period 1; a new spell tells under its own key', () => {
    const key = `tell:starved:${SINCE}:0`
    const sent = entry(key, 'tell', { status: 'done' })
    expect(tells(planV2(withLedger(full(), [sent]), CFG))).toEqual([])
    const later = { ...full(), now: NOW + 25 * HOUR }
    later.v2 = { ...later.v2!, blockers: tree(NODES, SINCE, { period: 1 }) }
    expect(tells(planV2(withLedger(later, [sent]), CFG)).map(a => a.key)).toEqual([`tell:starved:${SINCE}:1`])
    // the tree of the earlier period is not the tree of this one: no tell on it
    const stale = { ...full(), now: NOW + 25 * HOUR }
    const p = planV2(stale, CFG)
    expect(tells(p)).toEqual([])
    expect(p.skipped.filter(x => x.rule === 'S1' && x.why.includes('blockers not read yet'))).toHaveLength(1)
    // a spell that began later (after a pass that was not starved) is its own
    const again = world({}, starvedTree(NOW - 90 * MIN))
    expect(tells(planV2(withLedger(again, [sent]), CFG)).map(a => a.key)).toEqual([`tell:starved:${NOW - 90 * MIN}:0`])
  })

  test('the blockers not read yet (a backoff): no tell, and the skip says so', () => {
    const p = planV2(world({}, { starvedSince: SINCE }), CFG)
    expect(p.starved).toBe(true)
    expect(tells(p)).toEqual([])
    expect(p.skipped).toContainEqual({ rule: 'S1', issue: null, why: `starved since ${new Date(SINCE).toISOString()}: blockers not read yet` })
  })

  describe('not starved', () => {
    const run = (s: State, cfg = CFG) => planV2(s, cfg)
    test('an unblocked issue is claimed', () => {
      const p = run(world({ issues: [issue(10), issue(11, { blockedBy: 1 })], queue: [10, 11] }, starvedTree()))
      expect(p.starved).toBe(false)
      expect(tells(p)).toEqual([])
    })
    test('work in flight (a building record)', () => {
      expect(run(world({}, starvedTree(), [rec(99)])).starved).toBe(false)
    })
    test('a parked record holds no capacity: still starved', () => {
      expect(run(world({}, starvedTree(), [rec(99, { state: 'parked', step: null, question: 'which?' })])).starved).toBe(true)
    })
    test('the owner stops new work, names an issue in only, or the tier stops new work', () => {
      expect(run(world({ control: control({ noNewWork: true }) }, starvedTree())).starved).toBe(false)
      expect(run(world({ control: control({ only: [10] }) }, starvedTree())).starved).toBe(false)
      expect(run(world({ usage: { fiveHour: 99, sevenDay: 99, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } }, starvedTree())).starved).toBe(false)
    })
    test('an empty queue', () => {
      expect(run(world({ queue: [], issues: [] }, starvedTree())).starved).toBe(false)
    })
    test('an issue held only by capacity or by the claims per pass', () => {
      const s = world({ issues: [issue(10)], queue: [10] }, starvedTree())
      expect(run(s, { ...CFG, maxInFlightIssues: 0 }).starved).toBe(false)
      expect(run(s, { ...CFG, maxStartsPerPass: 0 }).starved).toBe(false)
    })
    test('a failed queue or github source is unknown, and the other sources failing change nothing', () => {
      const s = world({}, starvedTree())
      expect(run({ ...s, sources: { ...s.sources, queue: { ok: false, at: null, error: 'x' } } }).starved).toBeNull()
      expect(run({ ...s, sources: { ...s.sources, github: { ok: false, at: null, error: 'x' } } }).starved).toBeNull()
    })
  })

  describe('why a root is not moving', () => {
    // one queue issue (10), blocked by 20; the root's own facts decide
    const one = (rootNode: BlockerNode, records: IssueRecord[] = [], ledger: LedgerEntry[] = [], over: Partial<State> = {}) => {
      const nodes = { 10: node({ blockers: [20] }), 20: rootNode }
      const s = withLedger(world({ queue: [10], issues: [issue(10, { blockedBy: 1 })], ...over }, starvedTree(SINCE, nodes), records), ledger)
      const t = tells(planV2(s, CFG))
      return { fields: t[0]?.fields, line: t[0]?.context[0] }
    }
    test('parked on the owner, with the question', () => {
      const r = one(node(), [rec(20, { state: 'parked', step: null, question: 'Which API?\n\n#### Options' })])
      expect(r.fields).toMatchObject({ roots: '20', why: '20=parked' })
      expect(r.line).toContain('#20 untitled: parked on the owner: Which API? - blocks 1 ready issue (#10)')
    })
    test('waiting on a tag-contains reads as a release', () => {
      const r = one(node(), [rec(20, { state: 'waiting', step: null, wait: [{ kind: 'tag-contains', sha: 'abc1234' }], resumeTo: 'designing' })])
      expect(r.fields?.why).toBe('20=release')
      expect(r.line).toContain('waiting on no release tag contains abc1234 yet')
    })
    test('waiting on an issue, and any other live record', () => {
      expect(one(node(), [rec(20, { state: 'waiting', step: null, wait: [{ kind: 'issue-closed', issue: 57 }], resumeTo: 'designing' })]).fields?.why).toBe('20=waiting')
      // a record in any other live state holds capacity, so such a pass is not starved; the reason is still the words
      const ctx = { v2: { records: [rec(20)] }, byKey: new Map(), state: { release: null }, config: CFG } as never
      expect(whyOf(ctx, new Map(), { ref: '#20', issue: 20, blocks: [10] }, new Map())).toEqual({ code: 'in-factory', text: 'in the factory as building' })
    })
    test('a run-it merge: released or the release unknown', () => {
      const m = rec(20, { state: 'closed', step: null, why: 'merged', since: NOW - HOUR })
      expect(one(node(), [m], [runIt(m, 'run-it')], { release: { tag: 'v1', oldest: NOW - 30 * MIN } }).fields?.why).toBe('20=run-it')
      expect(one(node(), [m], [runIt(m, 'run-it')], { release: { tag: 'v1', oldest: null } }).fields?.why).toBe('20=run-it')
      const unknown = one(node(), [m], [runIt(m, 'run-it')])
      expect(unknown.line).toContain('waiting on its Run it, release state unknown')
    })
    test('a keep-open rollout', () => {
      const m = rec(20, { state: 'closed', step: null, why: 'merged', since: NOW - HOUR })
      const r = one(node(), [m], [runIt(m, 'keep-open')])
      expect(r.fields?.why).toBe('20=keep-open')
      expect(r.line).toContain('kept open by its rollout (keep-open): only a person closes it')
    })
    test('factory labels with no record here', () => {
      expect(one(node({ labels: ['factory:parked'] })).fields?.why).toBe('20=parked')
      expect(one(node({ labels: ['factory:waiting'] })).fields?.why).toBe('20=waiting')
      expect(one(node({ labels: ['factory:building', 'ready'] })).fields?.why).toBe('20=other-device')
    })
    test('ready but skipped by a filter: the filter says why', () => {
      const nodes = { 10: node({ blockers: [20] }), 20: node({ labels: ['ready', 'skip-factory'] }) }
      const issues = [issue(10, { blockedBy: 1 }), issue(20, { labels: ['ready', 'skip-factory'] })]
      const t = tells(planV2(world({ queue: [10, 20], issues }, starvedTree(SINCE, nodes)), CFG))[0]
      expect(t?.fields.why).toBe('20=skipped')
      expect(t?.context).toEqual(['#20 untitled: label skip-factory - blocks 1 ready issue (#10)', '#20: label skip-factory'])
    })
    test('a foreign blocker, a refused read, a failed read, a branch the walk never reached', () => {
      expect(one(node({ foreign: ['o/n#5'] })).fields).toMatchObject({ roots: 'o/n#5', why: 'o/n#5=foreign' })
      expect(one(node({ foreign: ['o/n#5'] })).line).toContain('o/n#5: in another repo, not read - blocks 1 ready issue (#10)')
      expect(one(node({ read: 'refused', labels: [] })).line).toContain('untrusted author, not read')
      expect(one(node({ read: 'failed', labels: [] })).line).toContain('its read failed')
      const nodes = { 10: node({ blockers: [20] }) }
      const t = tells(planV2(world({ queue: [10], issues: [issue(10, { blockedBy: 1 })] }, starvedTree(SINCE, nodes)), CFG))
      expect(t[0]?.fields).toMatchObject({ roots: '20', why: '20=cap' })
      expect(t[0]?.context[0]).toContain('the walk stopped here (cap)')
    })
    test('a truncated tree says so', () => {
      const p = planV2(world({}, { starvedSince: SINCE, blockers: tree(NODES, SINCE, { truncated: true }) }), CFG)
      expect(tells(p)[0]?.fields.truncated).toBe('yes')
    })
    test('a failed tree read: roots unread, a line for the error and the direct blocker counts', () => {
      const p = planV2(world({}, { starvedSince: SINCE, blockers: tree({}, SINCE, { error: 'every read failed' }) }), CFG)
      expect(tells(p)[0]).toMatchObject({ fields: { roots: 'unread' }, context: ['roots: not read (every read failed)', '#10: blocked by 1 open issue', '#11: blocked by 1 open issue', '#12: blocked by 1 open issue'] })
    })
    test('a queue issue held by something other than a blocker has its own line; ten roots at most', () => {
      const q = [10, 11, ...Array.from({ length: 12 }, (_, i) => 100 + i)]
      const nodes: Record<number, BlockerNode> = { 10: node({ blockers: q.slice(2).map(n => n + 100) }) }
      for (const n of q.slice(2)) nodes[n + 100] = node({ labels: [] })
      const issues = [issue(10, { blockedBy: 12 }), issue(11, { labels: ['ready', 'skip-factory'] })]
      const t = tells(planV2(world({ queue: [10, 11], issues }, starvedTree(SINCE, nodes)), CFG))[0]
      expect(t?.context.filter(l => l.startsWith('#2'))).toHaveLength(10)
      expect(t?.context).toContain('and 2 more')
      expect(t?.context.at(-1)).toBe('#11: label skip-factory')
      expect(t?.fields.roots?.split(',')).toHaveLength(12)
    })
  })
})

describe('rootsOf: the walk', () => {
  test('a cycle ends each member as a root and never loops', () => {
    const nodes = new Map<number, BlockerNode>([
      [40, node({ blockers: [41] })],
      [41, node({ blockers: [40] })],
    ])
    expect(rootsOf(nodes, [40]).map(r => r.ref)).toEqual(['#40', '#41'])
  })
  test('a chain ends at its last issue; a shared root counts every issue it blocks', () => {
    const nodes = new Map<number, BlockerNode>([
      [1, node({ blockers: [2] })],
      [2, node({ blockers: [3] })],
      [3, node()],
      [4, node({ blockers: [2] })],
    ])
    expect(rootsOf(nodes, [1, 4])).toEqual([{ ref: '#3', issue: 3, blocks: [1, 4] }])
  })
})

describe('the blockers read (sources-blockers.ts)', () => {
  const ISSUE = (n: number, blocked: { number: number; repo?: string; state?: string }[], over: object = {}) =>
    JSON.stringify({ issue: { number: n, title: `T${n}`, state: 'open', labels: [{ name: 'ready' }], issue_dependencies_summary: { blocked_by: blocked.length }, sub_issues_summary: { total: 0 }, ...over }, blocked_by: blocked.map(b => ({ repo: REPO, state: 'open', ...b })), blocking: [], stripped: 0 })
  const AFTER = 60 * MIN
  const SPELL = { since: NOW - 61 * MIN, afterMs: AFTER }

  function ctx(answers: Record<number, string | { exitCode: number }>, over: Partial<SourceCtx> = {}, queue = [10, 11], issues = queue.map(n => issue(n, { blockedBy: 1 }))) {
    const ran: number[] = []
    const c = {
      now: NOW,
      rt: { repo: REPO },
      state: { queue, issues },
      limited: () => false,
      run: async (argv: string[]) => {
        const n = Number(argv[2])
        ran.push(n)
        const a = answers[n]
        if (a === undefined) return { exitCode: 1, stdout: '', stderr: 'HTTP 502' }
        return typeof a === 'string' ? { exitCode: 0, stdout: a, stderr: '' } : { exitCode: a.exitCode, stdout: '', stderr: '' }
      },
      ...over,
    } as unknown as SourceCtx
    return { c, ran }
  }

  test('blockedByOf: open blockers of this repo, foreign ones as refs, closed ones dropped', () => {
    expect(blockedByOf(ISSUE(1, [{ number: 2 }, { number: 3, state: 'closed' }, { number: 4, repo: 'o/n' }]), REPO)).toEqual({ local: [2], foreign: ['o/n#4'] })
    expect(blockedByOf('{}', REPO)).toBeNull()
    expect(blockedByOf('nope', REPO)).toBeNull()
  })

  test('nothing is read with no spell or before the notice is due; the kept tree stands', async () => {
    const a = ctx({})
    expect(await readBlockers(a.c, null, null, false)).toBeNull()
    expect(await readBlockers(a.c, null, { since: NOW - 59 * MIN, afterMs: AFTER }, false)).toBeNull()
    expect(a.ran).toEqual([])
  })

  test('it follows this repo\'s open blockers from the blocked queue issues: a foreign or closed one is never read', async () => {
    const a = ctx({ 10: ISSUE(10, [{ number: 20 }, { number: 21, repo: 'o/n' }]), 11: ISSUE(11, [{ number: 20 }]), 20: ISSUE(20, [{ number: 22, state: 'closed' }]) })
    const t = await readBlockers(a.c, null, SPELL, false)
    expect(a.ran).toEqual([10, 11, 20])
    expect(t).toMatchObject({ since: SPELL.since, period: 0, readAt: NOW, truncated: false, error: null })
    expect(t?.nodes[10]).toEqual({ open: true, labels: ['ready'], title: 'T10', blockers: [20], foreign: ['o/n#21'], read: 'ok' })
    expect(t?.nodes[20]?.blockers).toEqual([])
  })

  test('only blocked queue issues start the walk', async () => {
    const a = ctx({ 11: ISSUE(11, []) }, {}, [10, 11], [issue(10), issue(11, { blockedBy: 1 })])
    await readBlockers(a.c, null, SPELL, false)
    expect(a.ran).toEqual([11])
  })

  test('once per (spell, period): the next pass keeps the tree; the next period reads again; a new spell reads again', async () => {
    const a = ctx({ 10: ISSUE(10, []), 11: ISSUE(11, []) })
    const first = await readBlockers(a.c, null, SPELL, false)
    expect(a.ran).toEqual([10, 11])
    const again = await readBlockers({ ...a.c, now: NOW + MIN } as SourceCtx, first, SPELL, false)
    expect(again).toBe(first)
    expect(a.ran).toHaveLength(2)
    const next = await readBlockers({ ...a.c, now: NOW + DAY } as SourceCtx, first, SPELL, false)
    expect(next?.period).toBe(1)
    expect(a.ran).toHaveLength(4)
    await readBlockers(a.c, first, { since: NOW - 62 * MIN, afterMs: AFTER }, false)
    expect(a.ran).toHaveLength(6)
  })

  test('nothing is read during a backoff or after a rate limit; the spell\'s kept tree stands', async () => {
    const a = ctx({ 10: ISSUE(10, []) })
    expect(await readBlockers(a.c, null, SPELL, true)).toBeNull()
    const limited = ctx({ 10: ISSUE(10, []) }, { limited: () => true })
    expect(await readBlockers(limited.c, null, SPELL, false)).toBeNull()
    const kept = tree({}, SPELL.since, { period: -1 })
    expect(await readBlockers(limited.c, kept, SPELL, false)).toBe(kept)
    expect(a.ran.concat(limited.ran)).toEqual([])
  })

  test('a rate limit mid-walk stops it and marks the tree truncated', async () => {
    let calls = 0
    const a = ctx({ 10: ISSUE(10, [{ number: 20 }]), 11: ISSUE(11, []), 20: ISSUE(20, []) }, { limited: () => calls++ >= 2 })
    const t = await readBlockers(a.c, null, SPELL, false)
    expect(a.ran).toEqual([10])
    expect(t?.truncated).toBe(true)
  })

  test('it stops at 40 reads, 8 levels, and walks a cycle once', async () => {
    const queue = Array.from({ length: MAX_READS + 5 }, (_, i) => 100 + i)
    const wide = ctx(Object.fromEntries(queue.map(n => [n, ISSUE(n, [])])), {}, queue, queue.map(n => issue(n, { blockedBy: 1 })))
    const t = await readBlockers(wide.c, null, SPELL, false)
    expect(wide.ran).toHaveLength(MAX_READS)
    expect(t?.truncated).toBe(true)
    const chain = ctx(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, ISSUE(i + 1, [{ number: i + 2 }])])), {}, [1], [issue(1, { blockedBy: 1 })])
    const deep = await readBlockers(chain.c, null, SPELL, false)
    expect(chain.ran).toHaveLength(MAX_DEPTH)
    expect(deep?.truncated).toBe(true)
    const loop = ctx({ 1: ISSUE(1, [{ number: 2 }]), 2: ISSUE(2, [{ number: 1 }]) }, {}, [1], [issue(1, { blockedBy: 1 })])
    const cyc = await readBlockers(loop.c, null, SPELL, false)
    expect(loop.ran).toEqual([1, 2])
    expect(cyc?.truncated).toBe(false)
  })

  test('a refused read (exit 3) and a failed one end their branch; every read failing is an error', async () => {
    const a = ctx({ 10: { exitCode: 3 } as never, 11: ISSUE(11, [{ number: 20 }]) })
    const t = await readBlockers(a.c, null, SPELL, false)
    expect(t?.nodes[10]?.read).toBe('refused')
    expect(t?.nodes[20]?.read).toBe('failed')
    expect(t?.error).toBeNull()
    const none = await readBlockers(ctx({}).c, null, SPELL, false)
    expect(none?.error).toBe('every read failed')
    expect(Object.values(none?.nodes ?? {}).every(v => v.read === 'failed')).toBe(true)
  })
})
