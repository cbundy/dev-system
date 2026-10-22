import { describe, expect, test } from 'claude-code/testing'
import { emptyContradicted } from '../hooks/observe-queue'
import type { GithubIssue } from '../hooks/state'

const gh = (open: boolean, labels: string[], trusted = true): { at: number; value: GithubIssue } => ({
  at: 0,
  value: { trusted, brief: null, facts: { open, labels, blockedBy: null, blocking: null, subIssues: null, title: 't', blockingList: null, blockersClosedAt: null, parent: null, siblings: null } },
})

describe('emptyContradicted', () => {
  const live = new Map([[1, gh(true, ['ready'])], [2, gh(true, ['ready'])]])
  test('a non-empty read or an empty previous list contradicts nothing', () => {
    expect(emptyContradicted([1, 2], [1], live, 'ready')).toEqual([])
    expect(emptyContradicted([], [], live, 'ready')).toEqual([])
  })
  test('closed, unlabelled, untrusted and unread members are not contradictions', () => {
    expect(emptyContradicted([1], [], new Map([[1, gh(false, ['ready'])]]), 'ready')).toEqual([])
    expect(emptyContradicted([1], [], new Map([[1, gh(true, ['bug'])]]), 'ready')).toEqual([])
    expect(emptyContradicted([1], [], new Map([[1, gh(true, ['ready'], false)]]), 'ready')).toEqual([])
    expect(emptyContradicted([1], [], new Map(), 'ready')).toEqual([])
  })
  test('open, trusted, labelled members are named; a mix names only those', () => {
    expect(emptyContradicted([1, 2], [], live, 'ready')).toEqual([1, 2])
    const mix = new Map([[1, gh(true, ['ready'])], [2, gh(false, ['ready'])], [3, gh(true, [])]])
    expect(emptyContradicted([1, 2, 3, 4], [], mix, 'ready')).toEqual([1])
  })
})
