// hooks/factory-state-map.ts: the one place a fabriek-factory-state row becomes a v2 state.
import { describe, expect, test } from 'claude-code/testing'
import { LIVE_STATES, stateOfRow } from '../hooks/factory-state-map'
import { ISSUE_STATES } from '../hooks/v2/types'

describe('the sets', () => {
  test('the live states are the ones that hold or wait on a claim, all of them real states', () => {
    expect(LIVE_STATES).toEqual(['designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting'])
    for (const s of LIVE_STATES) expect(ISSUE_STATES).toContain(s)
  })
})

describe('stateOfRow', () => {
  test('a row with a valid state gives it', () => {
    for (const state of ISSUE_STATES) expect(stateOfRow({ state })?.state).toBe(state)
    expect(stateOfRow({ state: 'fixing' })).toEqual({ state: 'fixing', merged: false })
  })

  test('a row with only an old stage word has no state: null', () => {
    for (const stage of ['queued', 'implementing', 'in pipeline', 'ready to merge', 'merged', 'closed without merge']) expect(stateOfRow({ stage })).toBeNull()
  })

  test('a state the plugin does not know, or none, gives null', () => {
    expect(stateOfRow({ state: 'mystery' })).toBeNull()
    expect(stateOfRow({})).toBeNull()
    expect(stateOfRow({ state: 7 })).toBeNull()
  })

  test('a claim whose lease lapsed is queued, though its state is still designing', () => {
    expect(stateOfRow({ state: 'designing', detail: 'claim lapsed at 2026-10-10T10:00:00.000Z' })).toEqual({ state: 'queued', merged: false })
    expect(stateOfRow({ state: 'designing', detail: 'ready' })?.state).toBe('designing')
  })

  test('an ended row (GitHub closed it before the view saw it) is closed, and merged only by its why', () => {
    expect(stateOfRow({ state: 'building', ended: true })).toEqual({ state: 'closed', merged: false })
    expect(stateOfRow({ state: 'building', ended: true, detail: 'closed on GitHub' })).toEqual({ state: 'closed', merged: false })
    expect(stateOfRow({ state: 'building', ended: true, why: 'merged' })).toEqual({ state: 'closed', merged: true })
  })

  test('a closed row is merged by its why: merged, merged-by-hand and done; any other why, or none, is not', () => {
    for (const why of ['merged', 'merged-by-hand', 'done']) expect(stateOfRow({ state: 'closed', why })?.merged).toBe(true)
    for (const why of ['dropped', 'split', 'closed-on-github', 'claim-lost']) expect(stateOfRow({ state: 'closed', why })?.merged).toBe(false)
    expect(stateOfRow({ state: 'closed' })?.merged).toBe(false)
  })

  test('a live row is never merged', () => {
    expect(stateOfRow({ state: 'building', why: 'merged' })?.merged).toBe(false)
  })
})
