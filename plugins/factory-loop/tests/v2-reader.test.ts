// G2's reader-behind owner item (v2/rules-reader.ts) and the blind tell a failing image read leads to.
import { describe, expect, test } from 'claude-code/testing'

import type { Action, PlanResult, State } from '../hooks/types'
import type { SkippedEvent } from '../hooks/parse'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { MIN, NOW, config, entry, state as baseState } from './fixtures'

const CFG = config({ mode: 'act' })
const OK = { ok: true, at: NOW }
const skip = (type: string, version: number, count: number, derived = false): SkippedEvent => ({ type, version, count, derived })

function world(skipped: SkippedEvent[] | undefined): State {
  const s = baseState()
  const v2 = { ...emptyV2State(NOW, []), sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK, releasePrs: OK, main: OK } }
  return { ...s, factory: { at: NOW, issues: [], ...(skipped === undefined ? {} : { skipped }) } as never, v2 }
}
type Tell = Extract<Action, { kind: 'tell' }>
const tells = (r: PlanResult, wake: string): Tell[] => r.actions.filter((a): a is Tell => a.kind === 'tell' && a.wake === wake)

describe('G2: reader-behind', () => {
  test('non-derived skips plan one owner item keyed by the sorted types, with the total', () => {
    const p = planV2(world([skip('other', 2, 1), skip('mystery', 1, 3)]), CFG)
    const t = tells(p, 'reader-behind')
    expect(t.map(a => [a.key, a.rule, a.class, a.fields])).toEqual([['tell:reader-behind:mystery v1,other v2', 'G2', 'owner', { types: 'mystery v1,other v2', count: '4' }]])
    expect(p.owner).toBeGreaterThanOrEqual(1)
  })

  test('a ledger entry with that key plans no second one; a new type makes a new key', () => {
    const s = world([skip('mystery', 1, 3), skip('other', 2, 1)])
    const done = { ...s, ledger: [...s.ledger, entry('tell:reader-behind:mystery v1,other v2', 'tell', { wake: 'reader-behind', startedAt: NOW - MIN, endedAt: NOW - MIN })] }
    expect(tells(planV2(done, CFG), 'reader-behind')).toEqual([])
    const grown = { ...done, factory: { ...done.factory!, skipped: [skip('mystery', 1, 3), skip('other', 2, 1), skip('third', 1, 1)] } }
    expect(tells(planV2(grown, CFG), 'reader-behind').map(a => a.key)).toEqual(['tell:reader-behind:mystery v1,other v2,third v1'])
  })

  test('no skips, an empty list or an older cached value plan nothing', () => {
    expect(tells(planV2(world([]), CFG), 'reader-behind')).toEqual([])
    expect(tells(planV2(world(undefined), CFG), 'reader-behind')).toEqual([])
  })
})

describe('G2: a failing image read tells the owner why', () => {
  test('a factory-state exit naming an unknown event leads to tell(blind) with that error after blindNoticeAfterMs', () => {
    const error = 'unknown factory event: queue_snapshot v1'
    const s = world([])
    const blind = { ...s, sources: { ...s.sources, factory: { ok: false, at: NOW - 16 * MIN, error } } }
    const p = planV2(blind, CFG)
    const t = tells(p, 'blind')
    expect(t.map(a => a.fields)).toEqual([{ since: String(NOW - 16 * MIN), error }])
    expect(p.owner).toBe(1)
    const early = { ...s, sources: { ...s.sources, factory: { ok: false, at: NOW - 5 * MIN, error } } }
    expect(tells(planV2(early, CFG), 'blind')).toEqual([])
  })
})
