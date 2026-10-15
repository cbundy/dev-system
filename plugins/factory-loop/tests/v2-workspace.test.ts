// The loop's side of the companion plugin (docs/factory-loop/v2/SPEC.md 10.3, 10.5, 10.9): the
// slot line each agent step's prompt opens with, the Bash timeout the loop's session start sets,
// and the workspace rail: without the companion's handshake for this session every agent step is
// held with the skip line `workspace`, and the owner is told once (tell(workspace)). The plans are
// driven through planV2 itself; actions are found by kind, never by literal keys.
import { describe, expect, test } from 'claude-code/testing'

import { readWorkspace } from '../hooks/rails'
import { companionLines } from '../hooks/v2/sources-interventions'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { lifeOf, prepareKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES } from '../hooks/v2/types'
import type { IssueRecord, Lease, V2State } from '../hooks/v2/types'
import { WORKSPACE_GRACE_MS, handshakePath, withSlotLine, workspaceRead } from '../hooks/v2/workspace'
import type { WorkspaceRead } from '../hooks/v2/workspace'
import { MIN, NOW, config, entry, state as baseState } from './fixtures'

const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 120 * MIN)
const SESSION = 'session-1'
const OK = { ok: true, at: NOW }
const UP: WorkspaceRead = { session: SESSION, ok: true, version: '0.38.2' }
const DOWN: WorkspaceRead = workspaceRead(null, SESSION)

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, state: 'building', step: 'build', since: NOW - 20 * MIN, ...over }
}

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })

// world: these records, each in a slot state holding its slot, every v2 source read, and the rail
// as given (absent: not read).
function world(records: IssueRecord[], workspace: WorkspaceRead | undefined, over: Partial<State> = {}): State {
  const v2: V2State = { ...emptyV2State(NOW, records), sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK }, leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor) }
  if (workspace !== undefined) v2.workspace = workspace
  return { ...baseState(over), v2 }
}

const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })
const plan = (s: State): PlanResult => planV2(s, CFG)
const of = (r: PlanResult, n: number): Action[] => r.actions.filter(a => a.issue === n && a.kind !== 'title')
const said = (r: PlanResult, n: number | null) => r.skipped.filter(s => s.issue === n).map(s => s.why)
const tells = (r: PlanResult) => r.actions.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell' && a.wake === 'workspace')
const prepared = (r: IssueRecord): LedgerEntry => entry(prepareKey(r, r.attempt), 'slot', { issue: r.issue, maxAttempts: 1, startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN })

describe('the slot line (v2 SPEC 10.3)', () => {
  test('a step\'s prompt opens with its slot, once; another slot\'s line is replaced; no slot leaves it alone', () => {
    expect(withSlotLine('You are the builder.', '/slots/3')).toBe('factory-slot: /slots/3\nYou are the builder.')
    expect(withSlotLine('factory-slot: /slots/3\nYou are the builder.', '/slots/3')).toBe('factory-slot: /slots/3\nYou are the builder.')
    expect(withSlotLine('factory-slot: /slots/9\nYou are the builder.', '/slots/3')).toBe('factory-slot: /slots/3\nYou are the builder.')
    expect(withSlotLine('You are the judge.', undefined)).toBe('You are the judge.')
  })
})

describe('the handshake (v2 SPEC 10.9)', () => {
  test('it passes only for this session\'s own file', () => {
    expect(workspaceRead(JSON.stringify({ v: 1, session: SESSION, version: '0.38.2' }), SESSION)).toEqual(UP)
    expect(DOWN).toMatchObject({ ok: false, why: expect.stringContaining('not loaded') })
    expect(workspaceRead(JSON.stringify({ session: 'other' }), SESSION)).toMatchObject({ ok: false, why: expect.stringContaining('other') })
    expect(workspaceRead('{', SESSION).ok).toBe(false)
  })

  test('the rail reads this session\'s file under the loop\'s base directory; a read that throws reads as none', async () => {
    const read: string[] = []
    const io = {
      readFile: async (path: string) => {
        read.push(path)
        return JSON.stringify({ v: 1, session: SESSION })
      },
    }
    expect((await readWorkspace(io, '/cfg/factory-loop/cbundy__dev-system', SESSION)).ok).toBe(true)
    expect(read).toEqual(['/cfg/factory-loop/workspace/session-1.json'])
    expect(handshakePath('/cfg/factory-loop', 'a/b c')).toBe('/cfg/factory-loop/workspace/a_b_c.json')
    const failing = { readFile: async () => Promise.reject(new Error('EIO')) }
    expect((await readWorkspace(failing, '/cfg/factory-loop/cbundy__dev-system', SESSION)).ok).toBe(false)
  })
})

describe('the workspace rail holds agent steps (v2 SPEC 10.9)', () => {
  test('without the companion no slot is prepared and no agent starts; the skip line says workspace', () => {
    const r = rec(91, { state: 'designing', step: 'design' })
    const held = plan(world([r], DOWN))
    expect(of(held, 91).filter(a => a.kind === 'slot' || a.kind === 'agent-step')).toEqual([])
    expect(said(held, 91)).toEqual([expect.stringMatching(/^workspace: /)])
    // the slot already prepared: the agent still waits
    const ready = withLedger(world([r], DOWN), [prepared(r)])
    expect(of(plan(ready), 91).filter(a => a.kind === 'agent-step')).toEqual([])
    // with the companion, the same plans go ahead
    expect(of(plan(world([r], UP)), 91)).toEqual([expect.objectContaining({ kind: 'slot', op: 'prepare' })])
    expect(of(plan(withLedger(world([r], UP), [prepared(r)])), 91)).toEqual([expect.objectContaining({ kind: 'agent-step', step: 'design', slot: '/slots/91' })])
  })

  test('every agent step is held, triage included; a record that is not at an agent step is not', () => {
    const records = [rec(92, { step: 'triage', triages: 1 }), rec(93, { state: 'fixing', step: 'fix' }), rec(94, { state: 'queued', step: 'lease' })]
    const r = plan(world(records, DOWN))
    for (const n of [92, 93]) expect(said(r, n)).toEqual([expect.stringMatching(/^workspace: /)])
    // queued's step is no agent's: W1 leases its slot while the rail fails, and with the slot there
    // it moves on to designing
    expect(of(r, 94)).toEqual([expect.objectContaining({ kind: 'slot', op: 'lease', rule: 'W1' })])
    const leased = world([records[2] as IssueRecord], DOWN)
    leased.v2 = { ...(leased.v2 as V2State), leases: [leaseFor(records[2] as IssueRecord)] }
    expect(of(plan(leased), 94)).toEqual([expect.objectContaining({ kind: 'transition', row: 'T1' })])
  })

  test('a rail that was not read holds nothing', () => {
    const r = rec(95, { state: 'designing', step: 'design' })
    expect(of(plan(world([r], undefined)), 95)).toEqual([expect.objectContaining({ kind: 'slot', op: 'prepare' })])
    expect(tells(plan(world([r], undefined)))).toEqual([])
  })

  test('the owner is told once per session, after the grace, as an owner item', () => {
    const r = rec(96, { state: 'designing', step: 'design' })
    // the companion's session.start may land after the loop's first pass: no tell yet
    const early = plan(world([r], DOWN, { loadedAt: NOW - MIN }))
    expect(tells(early)).toEqual([])
    expect(said(early, null)).toContainEqual(expect.stringMatching(/^workspace: told after/))
    const late = plan(world([r], DOWN, { loadedAt: NOW - WORKSPACE_GRACE_MS }))
    const [tell] = tells(late)
    expect(tell).toMatchObject({ kind: 'tell', wake: 'workspace', class: 'owner', issue: null, fields: { session: SESSION } })
    expect(late.owner).toBeGreaterThan(0)
    // told: not again in this session
    const told = withLedger(world([r], DOWN), [entry(tell?.key ?? 'none', 'tell', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN, wake: 'workspace' })])
    expect(tells(plan(told))).toEqual([])
    // nothing to tell while the companion is there
    expect(tells(plan(world([r], UP)))).toEqual([])
  })
})

describe('the Bash timeout (v2 SPEC 10.5)', () => {
  test('the loop\'s session start gives every agent it starts a 10-minute Bash timeout', async ($, on) => {
    const set: [string, string | undefined][] = []
    on('env.set', ($$, e) => {
      set.push([e.name, e.value])
      return { value: undefined }
    })
    on('session.start', ($$, e) => ({ cwd: e.cwd }))
    // a session no person reaches: the loop itself does not start, the timeout is set all the same
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    expect(set).toEqual([
      ['BASH_DEFAULT_TIMEOUT_MS', '600000'],
      ['BASH_MAX_TIMEOUT_MS', '600000'],
    ])
  })
})

describe('the companion\'s log, as the loop reads it (v2 SPEC 7.2)', () => {
  test('each refusal and gate-unknown line the companion appends is one fact for the interventions', () => {
    // the lines exactly as plugins/factory-loop-workspace/hooks/register.ts logLine writes them
    const at = new Date(NOW - MIN).toISOString()
    const text = [
      { at, issue: 571, life: 'ss1x2k', seq: 7, cause: 'guard:write', reason: 'Write: /w/x is outside your slot /slots/3: write only inside it' },
      { at, issue: 571, life: 'ss1x2k', seq: 7, cause: 'guard:push', reason: 'Bash: a push to main is refused' },
      { at, issue: 571, life: 'ss1x2k', seq: 7, cause: 'guard:command', reason: 'Bash: gh pr create is refused' },
      { at, issue: 571, life: 'ss1x2k', seq: 8, cause: 'gate-unknown', reason: 'the stop gate could not run: `npm test` did not finish' },
    ]
      .map(l => JSON.stringify(l))
      .join('\n')
    const lines = companionLines(`${text}\n`, NOW)
    expect(lines.map(l => [l.cause, l.issue, l.life, l.seq, l.at])).toEqual([
      ['guard:write', 571, 'ss1x2k', 7, NOW - MIN],
      ['guard:push', 571, 'ss1x2k', 7, NOW - MIN],
      ['guard:command', 571, 'ss1x2k', 7, NOW - MIN],
      ['gate-unknown', 571, 'ss1x2k', 8, NOW - MIN],
    ])
  })
})
