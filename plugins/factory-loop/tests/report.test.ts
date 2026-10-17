// The factory report (#712): the tables, the order, the last five merges, the durations, the
// digest, the What cut and the title book. Pure.
import { describe, expect, test } from 'claude-code/testing'

import { duration, reportOf, titleBook, whatOf } from '../hooks/report'
import { lifeOf } from '../hooks/v2/keys'
import { madeRecord } from '../hooks/v2/table'
import type { IssueRecord } from '../hooks/v2/types'
import { MIN, NOW } from './fixtures'

const HOUR = 60 * MIN
const REPO = 'o/r'

// a record claimed `claimedAgo` before NOW, in the state since `since`
function rec(n: number, claimedAgo: number, over: Partial<IssueRecord> = {}): IssueRecord {
  const life = lifeOf(NOW - claimedAgo)
  return { ...madeRecord({ issue: n, life, branch: `issue-${n}`, pr: null, others: [] }, NOW - claimedAgo), seq: 3, since: NOW - 20 * MIN, state: 'building', step: 'build', ...over }
}
const merged = (n: number, claimedAgo: number, sinceAgo: number, over: Partial<IssueRecord> = {}) =>
  rec(n, claimedAgo, { state: 'closed', step: null, why: 'merged', since: NOW - sinceAgo, ...over })

const link = (n: number) => `[#${n}](https://github.com/${REPO}/issues/${n})`

describe('reportOf', () => {
  test('the tables from a recorded state', () => {
    const records = [
      rec(3, 30 * MIN, { state: 'reviewing', approvedPatch: 'abc', since: NOW - 5 * MIN }),
      rec(1, 3 * HOUR, { state: 'designing', since: NOW - 59 * MIN }),
      rec(2, 2 * HOUR, { state: 'parked', question: 'which API?', since: NOW - 96 * MIN }),
      ...[10, 11, 12, 13, 14, 15, 16].map((n, i) => merged(n, 10 * HOUR, (i + 1) * HOUR, { fixes: i % 2 })),
    ]
    const titles = { 1: 'Factory loop: add the report | tables', 2: 'A very long title that goes on and on past the limit', 3: 'Short', 10: 'T10', 11: 'T11', 12: 'T12', 13: 'T13', 14: 'T14' }
    const r = reportOf(records, titles, NOW, REPO)
    expect(r.text).toBe(
      [
        '### In flight (3)',
        '| Issue | What | Stage | In stage | Since claim |',
        '| --- | --- | --- | --- | --- |',
        `| ${link(1)} | add the report \\| tables | designing | 59m | 3h0m |`,
        `| ${link(2)} | A very long title that goes on and on past the limit | parked (owner question) | 1h36m | 2h0m |`.replace('A very long title that goes on and on past the limit', 'A very long title that goes on and on'),
        `| ${link(3)} | Short | reviewing (approved, heading to merge) | 5m | 30m |`,
        '',
        '### Merged',
        '| Issue | What | Claim to merge | Fix rounds |',
        '| --- | --- | --- | --- |',
        `| ${link(10)} | T10 | 9h0m | 0 |`,
        `| ${link(11)} | T11 | 8h0m | 1 |`,
        `| ${link(12)} | T12 | 7h0m | 0 |`,
        `| ${link(13)} | T13 | 6h0m | 1 |`,
        `| ${link(14)} | T14 | 5h0m | 0 |`,
      ].join('\n'),
    )
  })

  test('only the five newest merges appear, newest first; a dropped record never does', () => {
    const sinces = [50, 10, 70, 30, 60, 20, 40]
    const records = [...sinces.map((m, i) => merged(100 + i, 5 * HOUR, m * MIN)), merged(200, HOUR, MIN, { why: 'dropped' }), merged(201, HOUR, 2 * MIN, { why: 'merged-by-hand' })]
    const text = reportOf(records, {}, NOW, REPO).text as string
    const order = [...text.matchAll(/issues\/(\d+)\)/g)].map(m => Number(m[1]))
    expect(order).toEqual([201, 101, 105, 103, 106])
    expect(text).not.toContain('/issues/200)')
  })

  test('a record with no readable life sorts last in flight and shows no claim time', () => {
    const odd = rec(5, HOUR, { life: '!' })
    const text = reportOf([odd, rec(6, 2 * HOUR)], {}, NOW, REPO).text as string
    expect([...text.matchAll(/issues\/(\d+)\)/g)].map(m => Number(m[1]))).toEqual([6, 5])
    expect(text).toContain(`| ${link(5)} |  | building | 20m |  |`)
  })

  test('no records, or only dropped ones, give no text', () => {
    expect(reportOf([], {}, NOW, REPO).text).toBeNull()
    expect(reportOf([merged(1, HOUR, MIN, { why: 'dropped' }), rec(2, HOUR, { state: 'queued' })], {}, NOW, REPO).text).toBeNull()
  })

  test('the digest changes with a stage or a merge and not with time', () => {
    const base = [rec(1, HOUR), merged(2, 2 * HOUR, HOUR)]
    const d = reportOf(base, {}, NOW, REPO).digest
    expect(reportOf(base, {}, NOW + 30 * MIN, REPO).digest).toBe(d)
    expect(reportOf([{ ...base[0], seq: 4 }, base[1]], {}, NOW, REPO).digest).not.toBe(d)
    expect(reportOf([{ ...base[0], state: 'fixing' }, base[1]], {}, NOW, REPO).digest).not.toBe(d)
    expect(reportOf([...base, merged(3, 2 * HOUR, 2 * HOUR)], {}, NOW, REPO).digest).not.toBe(d)
  })
})

describe('duration', () => {
  test('formats', () => {
    expect([0, 59_000, 3 * MIN, 59 * MIN, HOUR, 96 * MIN, 25 * HOUR].map(duration)).toEqual(['0s', '59s', '3m', '59m', '1h0m', '1h36m', '1d1h'])
  })
})

describe('whatOf', () => {
  test('cut at a word boundary, prefix dropped, pipe escaped, missing is empty', () => {
    expect(whatOf('Factory loop: Post the report to the issue thread every ten minutes')).toBe('Post the report to the issue thread')
    expect(whatOf('a | b')).toBe('a \\| b')
    expect(whatOf('x'.repeat(60))).toBe('x'.repeat(40))
    expect(whatOf(undefined)).toBe('')
  })
})

describe('titleBook', () => {
  test('an issue read with a title fills it, and an issue with no record drops out', () => {
    const reads = new Map([
      [1, { facts: { title: 'One' } }],
      [2, { facts: null }],
      [9, { facts: { title: 'Nine' } }],
    ])
    const prev = { 2: 'Two', 3: 'Three' }
    expect(titleBook(prev, reads, [{ issue: 1 }, { issue: 2 }])).toEqual({ 1: 'One', 2: 'Two' })
    expect(titleBook(undefined, new Map(), [{ issue: 1 }])).toEqual({})
  })
})
