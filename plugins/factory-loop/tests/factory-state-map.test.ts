// hooks/factory-state-map.ts: the one place a callum-flow-factory-state row becomes a v2 state.
import { describe, expect, test } from 'claude-code/testing'
import { LIVE_STATES, STAGE_STATE, stateOfRow } from '../hooks/factory-state-map'
import { ISSUE_STATES } from '../hooks/v2/types'

describe('the sets', () => {
  test('the live states are the ones that hold or wait on a claim, all of them real states', () => {
    expect(LIVE_STATES).toEqual(['designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting'])
    for (const s of LIVE_STATES) expect(ISSUE_STATES).toContain(s)
  })

  test('the fallback maps each old stage word to its state', () => {
    expect(STAGE_STATE).toEqual({
      queued: 'queued',
      designing: 'designing',
      implementing: 'building',
      'in pipeline': 'reviewing',
      parked: 'parked',
      waiting: 'waiting',
      'ready to merge': 'merge-queue',
      merged: 'closed',
      'closed without merge': 'closed',
    })
  })
})

describe('stateOfRow', () => {
  test('a row with a valid state gives it, whatever its stage says', () => {
    for (const state of ISSUE_STATES) expect(stateOfRow({ state, stage: 'queued' })?.state).toBe(state)
    expect(stateOfRow({ state: 'fixing', stage: 'in pipeline' })).toEqual({ state: 'fixing', merged: false })
  })

  test('a row from an older image, with only a stage, is read through the fallback', () => {
    for (const [stage, state] of Object.entries(STAGE_STATE)) expect(stateOfRow({ stage })?.state).toBe(state)
    expect(stateOfRow({ stage: 'merged' })).toEqual({ state: 'closed', merged: true })
    expect(stateOfRow({ stage: 'closed without merge' })).toEqual({ state: 'closed', merged: false })
  })

  test('a state the plugin does not know falls back to the stage; neither valid gives null', () => {
    expect(stateOfRow({ state: 'mystery', stage: 'implementing' })?.state).toBe('building')
    expect(stateOfRow({ state: 'mystery', stage: 'mystery' })).toBeNull()
    expect(stateOfRow({})).toBeNull()
    expect(stateOfRow({ state: 7, stage: null })).toBeNull()
  })

  test('a claim whose lease lapsed is queued, though its state is still designing (the tool shows the stage queued)', () => {
    expect(stateOfRow({ state: 'designing', stage: 'queued', detail: 'claim lapsed at 2026-10-10T10:00:00.000Z' })).toEqual({ state: 'queued', merged: false })
    expect(stateOfRow({ stage: 'queued', detail: 'claim lapsed at 2026-10-10T10:00:00.000Z' })?.state).toBe('queued')
    expect(stateOfRow({ state: 'designing', stage: 'designing', detail: 'ready' })?.state).toBe('designing')
  })

  test('an ended row (GitHub closed it before the view saw it) is closed, and not merged, whatever its state', () => {
    expect(stateOfRow({ state: 'building', stage: 'closed without merge', ended: true })).toEqual({ state: 'closed', merged: false })
    expect(stateOfRow({ state: 'building', stage: 'merged', ended: true, detail: 'closed on GitHub' })).toEqual({ state: 'closed', merged: true })
  })

  test('a closed row is merged by its why: merged, merged-by-hand and done; any other why is not', () => {
    for (const why of ['merged', 'merged-by-hand', 'done']) expect(stateOfRow({ state: 'closed', why, stage: 'merged' })?.merged).toBe(true)
    for (const why of ['dropped', 'split', 'closed-on-github', 'claim-lost']) expect(stateOfRow({ state: 'closed', why, stage: 'closed without merge' })?.merged).toBe(false)
    // a why outranks the stage
    expect(stateOfRow({ state: 'closed', why: 'dropped', stage: 'merged' })?.merged).toBe(false)
    // no why: the stage decides
    expect(stateOfRow({ state: 'closed', stage: 'merged' })?.merged).toBe(true)
    expect(stateOfRow({ state: 'closed', stage: 'closed without merge' })?.merged).toBe(false)
  })

  test('a live row is never merged', () => {
    expect(stateOfRow({ state: 'building', why: 'merged', stage: 'implementing' })?.merged).toBe(false)
  })
})
