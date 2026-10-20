// The claim score (hooks/v2/score.ts, docs/factory-loop/v2/SPEC.md 3.5): each factor on its own,
// the comparator and the failed-lives count. The backtests over docs/spikes/queue-scoring read files,
// which plugin tests cannot: tests/factory-loop-score-backtest.test.js.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/config'
import type { IssueView } from '../hooks/types'
import { lifeOf } from '../hooks/v2/keys'
import { failedLivesBefore } from '../hooks/v2/lives'
import { releaseKey } from '../hooks/v2/release'
import { FACTORS, claimableAt, compareRanked, score, scoreReason } from '../hooks/v2/score'
import type { Factor, QueueScoreWeights, ScoreCtx } from '../hooks/v2/score'
import { madeRecord } from '../hooks/v2/table'
import type { IssueRecord } from '../hooks/v2/types'
import { NOW, entry, issue } from './fixtures'

const HOUR = 3_600_000
const W = DEFAULT_CONFIG.queueScore

function ctx(over: Partial<ScoreCtx> = {}): ScoreCtx {
  return { now: NOW, weights: W, priorityLabel: 'priority', held: new Set(), blocking: () => null, failedLives: () => 0, ...over }
}

const pointsOf = (r: ReturnType<typeof score>) => Object.fromEntries(r.factors.map(f => [f.name, f.points]))

describe('the factors, one by one', () => {
  test('priority-label and bug: their weights, compared without regard to case; no labels read gives nothing', () => {
    expect(pointsOf(score(issue(1, { labels: ['ready', 'Priority', 'bug'] }), ctx()))).toEqual({ 'priority-label': 30, bug: 25 })
    expect(score(issue(1, { labels: ['ready'] }), ctx())).toEqual({ score: 0, factors: [] })
    expect(score(issue(1, { labels: null }), ctx())).toEqual({ score: 0, factors: [] })
    const [label, bug] = FACTORS as [Factor, Factor]
    expect(label(issue(1, { labels: null }), ctx())).toBeNull()
    expect(bug(issue(1, { labels: null }), ctx())).toBeNull()
    expect(pointsOf(score(issue(1, { labels: ['ready', 'urgent'] }), ctx({ priorityLabel: 'urgent' })))).toEqual({ 'priority-label': 30 })
  })

  test('unblocks: 10 a direct, 5 a transitive, capped at 40; null and empty add nothing', () => {
    const one = score(issue(1, { blockingList: [2] }), ctx())
    expect(pointsOf(one)).toEqual({ unblocks: 10 })
    const five = score(issue(1, { blockingList: [2, 3, 4, 5, 6] }), ctx())
    expect(pointsOf(five)).toEqual({ unblocks: 40 })
    expect(score(issue(1, { blockingList: [] }), ctx()).factors).toEqual([])
    expect(FACTORS[2]?.(issue(1, { blockingList: null }), ctx())).toBeNull()
    expect(score(issue(1, { blockingList: null }), ctx()).factors).toEqual([])
  })

  test('unblocks walks the chain breadth first: a chain and a diamond count each issue once, the issue itself and the direct ones never', () => {
    const graph: Record<number, number[]> = { 2: [3], 3: [4], 4: [1], 10: [11, 12], 11: [13], 12: [13, 11], 13: [] }
    const blocking = (n: number) => graph[n] ?? null
    // chain 1 -> 2 -> 3 -> 4 -> back to 1: 1 direct, 2 transitive (3, 4); 1 itself is left out
    expect(pointsOf(score(issue(1, { blockingList: [2] }), ctx({ blocking })))).toEqual({ unblocks: 10 + 2 * 5 })
    // diamond 10 -> {11, 12} -> 13: 2 direct, 1 transitive though two paths reach it; 11 under 12 is direct already
    expect(pointsOf(score(issue(10, { blockingList: [11, 12] }), ctx({ blocking })))).toEqual({ unblocks: 20 + 5 })
    // an issue missing from the graph adds nothing further
    expect(pointsOf(score(issue(1, { blockingList: [99] }), ctx({ blocking })))).toEqual({ unblocks: 10 })
  })

  test('closes-epic, nearly-closes-epic and epic-started', () => {
    const sib = (open: boolean, n = 50) => ({ number: n, open })
    expect(pointsOf(score(issue(1, { parent: 9, siblings: [sib(false), sib(false, 51)] }), ctx()))).toEqual({ 'closes-epic': 20, 'epic-started': 10 })
    expect(pointsOf(score(issue(1, { parent: 9, siblings: [sib(false), sib(true, 51)] }), ctx()))).toEqual({ 'nearly-closes-epic': 10, 'epic-started': 10 })
    expect(pointsOf(score(issue(1, { parent: 9, siblings: [sib(true), sib(true, 51)] }), ctx()))).toEqual({})
    // a sibling in the factory counts as started
    expect(pointsOf(score(issue(1, { parent: 9, siblings: [sib(true), sib(true, 51)] }), ctx({ held: new Set([51]) })))).toEqual({ 'epic-started': 10 })
    // an only child closes its epic and has not started it
    expect(pointsOf(score(issue(1, { parent: 9, siblings: [] }), ctx()))).toEqual({ 'closes-epic': 20 })
    // facts not read: nothing
    expect(score(issue(1, { parent: null, siblings: null }), ctx()).factors).toEqual([])
    expect(FACTORS[3]?.(issue(1, { parent: 9, siblings: null }), ctx())).toBeNull()
    expect(FACTORS[4]?.(issue(1, { parent: null, siblings: [] }), ctx())).toBeNull()
  })

  test('waiting: 2 an hour from the later of ready and the newest closed blocker, capped at 20', () => {
    const at = (h: number, over: Partial<IssueView> = {}) => issue(1, { readyAt: NOW - h * HOUR, ...over })
    expect(pointsOf(score(at(3), ctx()))).toEqual({ waiting: 6 })
    expect(pointsOf(score(at(1.4), ctx()))).toEqual({ waiting: 2 })
    expect(pointsOf(score(at(0.4), ctx()))).toEqual({})
    expect(pointsOf(score(at(100), ctx()))).toEqual({ waiting: 20 })
    // the blockers closed later than `ready`
    expect(pointsOf(score(at(10, { blockersClosedAt: NOW - 2 * HOUR }), ctx()))).toEqual({ waiting: 4 })
    expect(claimableAt(at(10, { blockersClosedAt: NOW - 2 * HOUR }))).toBe(NOW - 2 * HOUR)
    expect(claimableAt(issue(1))).toBeNull()
    expect(FACTORS[5]?.(issue(1), ctx())).toBeNull()
    expect(score(issue(1), ctx()).factors).toEqual([])
  })

  test('failed-lives: -10 a life, capped at -30', () => {
    expect(pointsOf(score(issue(1), ctx({ failedLives: () => 1 })))).toEqual({ 'failed-lives': -10 })
    expect(pointsOf(score(issue(1), ctx({ failedLives: () => 7 })))).toEqual({ 'failed-lives': -30 })
    expect(score(issue(1), ctx({ failedLives: () => 2 })).score).toBe(-20)
  })

  test('the weights are settings; a zero weight scores nothing; a factor added to the list scores with the rest', () => {
    const w: QueueScoreWeights = { ...W, bug: 0, priorityLabel: 7 }
    expect(score(issue(1, { labels: ['bug', 'priority'] }), ctx({ weights: w }))).toEqual({ score: 7, factors: [{ name: 'priority-label', points: 7 }] })
    const extra: Factor = () => ({ name: 'extra', points: 3 })
    expect(score(issue(1), ctx(), [...FACTORS, extra])).toEqual({ score: 3, factors: [{ name: 'extra', points: 3 }] })
  })
})

describe('the order and the reason', () => {
  test('a higher score wins, then the oldest claimable, then the lowest number; no time sorts last among equals', () => {
    const r = (issue: number, s: number, claimable: number | null) => ({ issue, score: s, claimableAt: claimable })
    const sorted = [r(5, 10, 100), r(3, 20, 500), r(4, 10, 50), r(2, 10, null), r(1, 10, null), r(6, 10, 50)].sort(compareRanked)
    expect(sorted.map(x => x.issue)).toEqual([3, 4, 6, 5, 1, 2])
  })

  test('the reason text: the score, then each factor with its sign', () => {
    expect(scoreReason({ score: 0, factors: [] })).toBe('score 0')
    expect(scoreReason({ score: 45, factors: [{ name: 'priority-label', points: 30 }, { name: 'bug', points: 25 }, { name: 'failed-lives', points: -10 }] })).toBe('score 45: priority-label +30, bug +25, failed-lives -10')
  })
})

describe('failedLivesBefore', () => {
  const life = (h: number) => lifeOf(NOW - h * HOUR)
  const closed = (n: number, h: number, why: IssueRecord['why'], over: Partial<IssueRecord> = {}): IssueRecord => ({
    ...madeRecord({ issue: n, life: life(h), branch: `issue-${n}`, pr: null, others: [] }, NOW - h * HOUR),
    state: 'closed',
    step: null,
    why,
    ...over,
  })
  test('counts earlier lives that did not end merged, merged, merged by hand and done excepted', () => {
    const records = [closed(1, 9, 'dropped'), closed(1, 8, 'merged'), closed(1, 7, 'merged-by-hand'), closed(1, 6, 'done'), closed(1, 5, 'closed-on-github'), closed(2, 5, 'dropped')]
    expect(failedLivesBefore(records, [], 1)).toBe(2)
    expect(failedLivesBefore(records, [], 2)).toBe(1)
    expect(failedLivesBefore(records, [], 3)).toBe(0)
  })

  test('an R1 release counts as failed, and the count starts again after a rejection', () => {
    const claim = life(4)
    const release = entry(releaseKey(1, claim, 'requeue'), 'label', { issue: 1, rule: 'R1' })
    const ghost = failedLivesBefore([closed(1, 9, 'dropped')], [release], 1)
    expect(ghost).toBe(2)
    const rejected = entry(releaseKey(1, life(6), 'reject'), 'label', { issue: 1, rule: 'R1' })
    expect(failedLivesBefore([closed(1, 9, 'dropped'), closed(1, 8, 'dropped')], [rejected, release], 1)).toBe(1)
  })
})
