// The loop's side of the companion plugin (docs/factory-loop/v2/SPEC.md 10.3, 10.5, 10.9): the
// slot line each agent step's prompt opens with, the Bash timeout the loop's session start sets,
// and the workspace rail: without a fresh handshake from the companion for this session every
// agent step is held with the skip line `workspace`, and the owner is told once (tell(workspace)). The plans are
// driven through planV2 itself; actions are found by kind, never by literal keys.
import { describe, expect, test } from 'claude-code/testing'

import { companionLines } from '../hooks/v2/sources-interventions'
import { HANDSHAKE_STALE_MS, readWorkspace, workspaceRead } from '../hooks/v2/sources-workspace'
import type { Action, LedgerEntry, Ms, PlanResult, State } from '../hooks/types'
import { lifeOf, prepareKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES } from '../hooks/v2/types'
import type { IssueRecord, Lease, V2State } from '../hooks/v2/types'
import { WORKSPACE_GRACE_MS, handshakePath, processIdOf, withSlotLine } from '../hooks/v2/workspace'
import type { WorkspaceRead } from '../hooks/v2/workspace'
import { MIN, NOW, config, entry, state as baseState } from './fixtures'

const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 120 * MIN)
const SESSION = 'session-1'
const OK = { ok: true, at: NOW }
// this process's id, its pid and start time; the companion's last beat was a minute ago
const PROCESS = '4242:342070008'
const UP: WorkspaceRead = { session: SESSION, process: PROCESS, ok: true, version: '0.38.2' }
const DOWN: WorkspaceRead = workspaceRead(null, SESSION, PROCESS, NOW)
const handshake = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, session: SESSION, process: PROCESS, version: '0.38.2', at: new Date(NOW - MIN).toISOString(), ...over })

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
    expect(workspaceRead(handshake(), SESSION, PROCESS, NOW)).toEqual(UP)
    expect(DOWN).toMatchObject({ ok: false, why: expect.stringContaining('not loaded') })
    expect(workspaceRead(handshake({ session: 'other' }), SESSION, PROCESS, NOW)).toMatchObject({ ok: false, why: expect.stringContaining('other') })
    expect(workspaceRead('{', SESSION, PROCESS, NOW).ok).toBe(false)
  })

  test('a stale handshake for this same session reads as missing', () => {
    // the companion stopped beating in this process: a reload without it, or a beat that stopped
    const old = workspaceRead(handshake({ at: new Date(NOW - HANDSHAKE_STALE_MS - 1).toISOString() }), SESSION, PROCESS, NOW)
    expect(old).toMatchObject({ ok: false, why: expect.stringContaining('stale') })
    expect(workspaceRead(handshake({ at: new Date(NOW - HANDSHAKE_STALE_MS).toISOString() }), SESSION, PROCESS, NOW).ok).toBe(true)
    // no time, or one that does not read: stale
    expect(workspaceRead(handshake({ at: undefined }), SESSION, PROCESS, NOW)).toMatchObject({ ok: false, why: expect.stringContaining('no time') })
    expect(workspaceRead(handshake({ at: 'yesterday' }), SESSION, PROCESS, NOW).ok).toBe(false)
  })

  test('a restart without the companion: the old process\'s handshake, 20 s old, does not pass (R4-F3)', () => {
    // the session resumed under its id in a new process without the companion; the old process's
    // companion wrote its last beat 20 s ago
    const old = handshake({ process: '4100:341000000', at: new Date(NOW - 20_000).toISOString() })
    expect(workspaceRead(old, SESSION, PROCESS, NOW)).toMatchObject({ ok: false, why: expect.stringContaining('written by another one') })
    // with the companion, its first beat replaces the old file
    expect(workspaceRead(handshake(), SESSION, PROCESS, NOW).ok).toBe(true)
    // a process that cannot read its own id takes no handshake
    expect(workspaceRead(handshake(), SESSION, undefined, NOW).ok).toBe(false)
  })

  test('a process is named by its pid and start time, from /proc/self/stat, which no child inherits', () => {
    // the command name may hold spaces and parentheses; the start time is field 22
    const stat = '4242 (claude (x) y) S 1 4242 4242 0 -1 4194560 52005 150552 0 2 67 12 101 54 20 0 24 0 342070008 5783855104'
    expect(processIdOf(stat)).toBe(PROCESS)
    // the same pid started later is another process
    expect(processIdOf(stat.replace('342070008', '342099999'))).not.toBe(PROCESS)
    expect(processIdOf(null)).toBeUndefined()
    expect(processIdOf('')).toBeUndefined()
    expect(processIdOf('4242 (claude) S 1')).toBeUndefined()
  })

  test('a stale handshake holds agent steps as a missing one does', () => {
    const r = rec(97, { state: 'designing', step: 'design' })
    const stale = workspaceRead(handshake({ at: new Date(NOW - 10 * MIN).toISOString() }), SESSION, PROCESS, NOW)
    const held = plan(world([r], stale))
    expect(of(held, 97).filter(a => a.kind === 'slot' || a.kind === 'agent-step')).toEqual([])
    expect(said(held, 97)).toEqual([expect.stringMatching(/^workspace: .*stale/)])
  })

  test('the rail reads this session\'s file under the loop\'s base directory; a read that throws reads as none', async () => {
    const read: string[] = []
    const io = {
      readFile: async (path: string) => {
        read.push(path)
        return handshake()
      },
    }
    expect((await readWorkspace(io, '/cfg/factory-loop/cbundy__dev-system', SESSION, PROCESS, NOW)).ok).toBe(true)
    expect(read).toEqual(['/cfg/factory-loop/workspace/session-1.json'])
    expect(handshakePath('/cfg/factory-loop', 'a/b c')).toBe('/cfg/factory-loop/workspace/a_b_c.json')
    const failing = { readFile: async () => Promise.reject(new Error('EIO')) }
    expect((await readWorkspace(failing, '/cfg/factory-loop/cbundy__dev-system', SESSION, PROCESS, NOW)).ok).toBe(false)
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

  test('the owner is told once per process, after the grace, as an owner item', () => {
    const r = rec(96, { state: 'designing', step: 'design' })
    // the companion's session.start may land after the loop's first pass: no tell yet
    const early = plan(world([r], DOWN, { loadedAt: NOW - MIN }))
    expect(tells(early)).toEqual([])
    expect(said(early, null)).toContainEqual(expect.stringMatching(/^workspace: told after/))
    const late = plan(world([r], DOWN, { loadedAt: NOW - WORKSPACE_GRACE_MS }))
    const [tell] = tells(late)
    expect(tell).toMatchObject({ kind: 'tell', wake: 'workspace', class: 'owner', issue: null, fields: { session: SESSION } })
    expect(late.owner).toBeGreaterThan(0)
    // told: not again in this process
    const told = withLedger(world([r], DOWN), [entry(tell?.key ?? 'none', 'tell', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN, wake: 'workspace' })])
    expect(tells(plan(told))).toEqual([])
    // nothing to tell while the companion is there
    expect(tells(plan(world([r], UP)))).toEqual([])
  })

  test('each restart without the companion in one resumed session is told once and logged once (R5-F1)', () => {
    const r = rec(98, { state: 'designing', step: 'design' })
    const era = entry('i98/l1/s1/transition', 'transition', { issue: 98, startedAt: NOW - 60 * MIN })
    const told = (key: string, at: Ms) => entry(key, 'tell', { status: 'done', startedAt: at, endedAt: at, wake: 'workspace' })
    const down = (process: string) => workspaceRead(null, SESSION, process, NOW)
    // the first outage, in one process, is told once
    const [first] = tells(plan(withLedger(world([r], down('4100:341000000')), [era])))
    expect(first).toBeDefined()
    const once = withLedger(world([r], down('4100:341000000')), [era, told(first?.key ?? 'none', NOW - 30 * MIN)])
    expect(tells(plan(once))).toEqual([])
    // the supervisor restarts the same conversation in a new process, again without the companion:
    // this outage is told too, once
    const later = withLedger(world([r], DOWN), [era, told(first?.key ?? 'none', NOW - 30 * MIN)])
    const [second] = tells(plan(later))
    expect(second).toMatchObject({ kind: 'tell', wake: 'workspace' })
    expect(second?.key).not.toBe(first?.key)
    const both = withLedger(world([r], DOWN), [era, told(first?.key ?? 'none', NOW - 30 * MIN), told(second?.key ?? 'none', NOW - 5 * MIN)])
    const after = plan(both)
    expect(tells(after)).toEqual([])
    // each tell is one workspace intervention
    expect(after.actions.filter(a => a.kind === 'event' && a.reason === 'intervention: loop workspace')).toHaveLength(2)
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

  test('a gate that passed or failed is in the log but is no intervention (7.2)', () => {
    const at = new Date(NOW - MIN).toISOString()
    const text = [
      { at, issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-fail', reason: 'the stop gate refused the finish: `npm test` exited 1', head: 'abc', ms: 9000, command: 'npm test', exitCode: 1 },
      { at, issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-pass', reason: 'the stop gate passed', head: 'def', ms: 7600 },
    ]
      .map(l => JSON.stringify(l))
      .join('\n')
    expect(companionLines(`${text}\n`, NOW)).toEqual([])
  })
})
