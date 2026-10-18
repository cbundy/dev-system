// The event action's target (cbundy/dev-system#825): H1's backfill writes the new log only, so
// eventArgv adds --new-only for target 'new' and the event executor passes the target through.
import { describe, expect, test } from 'claude-code/testing'

import type { ExecCtx } from '../hooks/exec'
import type { Action } from '../hooks/types'
import { executors } from '../hooks/v2/act-state'
import { eventArgv } from '../hooks/v2/events'
import { lifeOf } from '../hooks/v2/keys'
import { madeRecord } from '../hooks/v2/table'
import { NOW } from './fixtures'

const LIFE = lifeOf(NOW)
const record = madeRecord({ issue: 7, life: LIFE, branch: 'issue-7', pr: null, others: [] }, NOW)
const ev = { state: 'transition' as const, record, row: 'H1', from: null, via: 'dual-write' as const }

describe('eventArgv target', () => {
  test('target new ends with --new-only; no target, and every other event, has no such flag', () => {
    const plain = eventArgv(ev)
    expect(plain).not.toContain('--new-only')
    expect(plain[1]).toBe('transition')
    expect(eventArgv(ev, {})).toEqual(plain)
    const newOnly = eventArgv(ev, { target: 'new' })
    expect(newOnly[newOnly.length - 1]).toBe('--new-only')
    expect(newOnly.slice(0, -1)).toEqual(plain)
  })
})

describe('the event executor', () => {
  const act = (target?: 'new'): Extract<Action, { kind: 'event' }> =>
    ({ kind: 'event', key: 'dual-write:7', class: 'free', rule: 'H1', reason: 'r', issue: 7, event: ev, ...(target === undefined ? {} : { target }) }) as never
  async function argvOf(a: Extract<Action, { kind: 'event' }>): Promise<string[]> {
    const seen: string[][] = []
    const ctx = { cmd: async (argv: string[]) => (seen.push(argv), { exitCode: 0, stdout: '', stderr: '' }) } as unknown as ExecCtx
    const r = await executors.event?.(ctx, a)
    expect(r?.status).toBe('done')
    expect(seen).toHaveLength(1)
    return seen[0] as string[]
  }
  test('target new runs callum-flow-event with --new-only; without a target it writes both logs as before', async () => {
    expect(await argvOf(act('new'))).toEqual(eventArgv(ev, { target: 'new' }))
    expect(await argvOf(act())).toEqual(eventArgv(ev))
    expect(await argvOf(act())).not.toContain('--new-only')
  })
})
