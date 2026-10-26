// The event action has no target (cbundy/dev-system#1141): every event the loop builds is a native
// call, which writes the new log only, so H1's backfill needs no --new-only and eventArgv takes no
// option. The event executor runs the argv events.ts builds, as it is.
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

describe('eventArgv has no target', () => {
  test('a transition is a native call with its issue and no --new-only, --note or column flag', () => {
    const argv = eventArgv(ev)
    expect(argv.slice(0, 4)).toEqual(['fabriek-event', '--type', 'transition', '--data'])
    expect(argv.slice(5)).toEqual(['--issue', '7'])
    for (const flag of ['--new-only', '--note', '--branch', '--pr', '--head']) expect(argv).not.toContain(flag)
    expect(eventArgv.length).toBe(1)
  })
})

describe('the event executor', () => {
  const act: Extract<Action, { kind: 'event' }> = { kind: 'event', key: 'dual-write:7', class: 'free', rule: 'H1', reason: 'r', issue: 7, event: ev } as never
  test('runs the argv events.ts builds, and a refusal is a failure never retried', async () => {
    const seen: string[][] = []
    const ok = { cmd: async (argv: string[]) => (seen.push(argv), { exitCode: 0, stdout: '', stderr: '' }) } as unknown as ExecCtx
    const r = await executors.event?.(ok, act)
    expect(r?.status).toBe('done')
    expect(seen).toEqual([eventArgv(ev)])
    const refused = { cmd: async () => ({ exitCode: 2, stdout: '', stderr: 'fabriek-event: unknown type' }) } as unknown as ExecCtx
    expect(await executors.event?.(refused, act)).toMatchObject({ status: 'failed', noRetry: true })
  })
})
