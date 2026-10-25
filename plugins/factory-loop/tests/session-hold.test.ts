// A stopped main session holds the loop's work (hooks/session-hold.ts): the match is pinned to the
// engine's refusal text, the hold shows in the title and `/factory status`, and its two
// interventions are planned once each.
import { describe, expect, test } from 'claude-code/testing'

import { EMPTY_CONTROL } from '../hooks/config'
import { statusText } from '../hooks/control'
import { S } from '../hooks/driver-state'
import { titleOf } from '../hooks/foundation'
import { SESSION_STOPPED, clearHeld, heldSince, holdView, markHeld } from '../hooks/session-hold'
import type { HoldView } from '../hooks/session-hold'
import type { Action } from '../hooks/types'
import { planV2 } from '../hooks/v2/plan'
import { emptyV2State } from '../hooks/v2/observe'
import { NOW, config, state } from './fixtures'

const STOPPED = 'the session was stopped and nobody has sent input since'

describe('the stopped-session match', () => {
  test('matches the engine\'s text, in a spawn deny and a submit error, and nothing else', () => {
    expect(SESSION_STOPPED.test(STOPPED)).toBe(true)
    expect(SESSION_STOPPED.test(`refused: ${STOPPED}`)).toBe(true)
    expect(SESSION_STOPPED.test('not allowed')).toBe(false)
    expect(SESSION_STOPPED.test('the session was stopped')).toBe(false)
  })
})

describe('the hold', () => {
  test('the first refusal sets the start, each is counted, and the first success ends it', () => {
    S.held = null
    S.resumed = null
    expect(heldSince()).toBeNull()
    markHeld(NOW, 'a', 'spawn')
    markHeld(NOW + 5, 'b')
    markHeld(NOW + 9, 'c', 'spawn')
    expect(heldSince()).toBe(NOW)
    expect(holdView().held).toMatchObject({ since: NOW, spawns: 2, wakes: 1, what: 'a' })
    clearHeld(NOW + 60_000)
    expect(heldSince()).toBeNull()
    expect(holdView().resumed).toEqual({ since: NOW, until: NOW + 60_000, spawns: 2, wakes: 1 })
    S.resumed = null
  })
})

const frame = { repo: 'o/r', counts: null, observe: false, blind: false, before: [], tier: 'normal' as const, after: [], atCap: false, capped: [], backoff: false, owner: 0 }

describe('what the owner sees', () => {
  test('the title and the status line say since when', () => {
    const at = Date.UTC(2026, 9, 25, 14, 7)
    expect(titleOf({ ...frame, held: at })).toContain('held: session stopped since 14:07')
    expect(titleOf({ ...frame, held: null })).not.toContain('held')
    const last = { pass: 3, at, mode: 'act' as const, tier: 'normal' as const, title: 't', actions: 0, owner: 0, held: { since: at } }
    expect(statusText(last, EMPTY_CONTROL, at)).toContain('Agents held and wakes undelivered since 14:07: the session is stopped; send any message to resume.')
    expect(statusText({ ...last, held: null }, EMPTY_CONTROL, at)).not.toContain('held')
  })
})

describe('the interventions', () => {
  const events = (hold: HoldView) => {
    const s = state({ hold })
    const planned = planV2({ ...s, v2: emptyV2State(NOW, []) }, config({ mode: 'act' }))
    return planned.actions.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.key.startsWith('iv/') && a.key.includes('session'))
  }
  const causesOf = (hold: HoldView) => events(hold).map(a => (a.event as { cause: string }).cause)
  test('a hold logs hold:session-stopped once, keyed on its start; its end adds hold:session-resumed', () => {
    const held = { since: NOW, spawns: 2, wakes: 0, what: STOPPED }
    const started = events({ held, resumed: null })
    expect(started.map(a => (a.event as { cause: string }).cause)).toEqual(['hold:session-stopped'])
    const again = events({ held: { ...held, spawns: 9 }, resumed: null })
    expect(again[0]?.key).toBe(started[0]?.key)
    const ended = events({ held: null, resumed: { since: NOW, until: NOW + 120_000, spawns: 2, wakes: 1 } })
    expect(ended.map(a => (a.event as { cause: string }).cause)).toEqual(['hold:session-stopped', 'hold:session-resumed'])
    expect(ended[0]?.key).toBe(started[0]?.key)
    expect((ended[1]?.event as { reason: string }).reason).toContain('2 min')
  })
  test('no hold, no event', () => {
    expect(causesOf({ held: null, resumed: null })).toEqual([])
  })
})
