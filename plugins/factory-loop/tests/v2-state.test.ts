// The record's rules under planner v2 (docs/factory-loop/v2/SPEC.md 3, 4, 5, 11, 14.1): S1's claims
// and S0's record, H1's heartbeat and re-claims, a seq's entry actions, S2's steps, the table's
// events in 4.1's order, parking and resuming, and the plan's properties (17.1 properties 3, 5, 6,
// 11, 16, 18); then the record's executors (act-state.ts) and the triage step (contracts,
// prompt, result). Plans are driven through planV2 itself, over States built here; actions are
// found by kind and by the key codec (keys.ts), never by literal keys.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { V2_CONTRACTS } from '../hooks/contract.mjs'
import type { ActIo, ExecCtx, SpawnInput } from '../hooks/exec'
import { onLoad, start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { applied, commentBody, hiddenKey, issueBranch, labelArgvs, openPrsOf, postedUrl, recordStale, triggerStale } from '../hooks/v2/act-state'
import { eventArgv } from '../hooks/v2/events'
import { claimKey, entryKey, followKey, interventionKey, lifeKey, lifeOf, prKey, prepareKey, reclaimKey, reviewKey, seqKey, stepKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State, recordOf } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { COMMAND_RULE, triagePrompt } from '../hooks/v2/prompts-triage'
import type { TriageInput } from '../hooks/v2/prompts-triage'
import { resultsOf, stepFiles, triageInput, triageResult } from '../hooks/v2/steps-triage'
import { stepAnswerPath, stepRecordPath } from '../hooks/v2/steps'
import { parkText } from '../hooks/v2/park-text'
import { renderQuestion } from '../hooks/v2/question.mjs'
import { madeRecord, rowFor, nextRecord } from '../hooks/v2/table'
import { FACTORY_LABELS, SLOT_STATES } from '../hooks/v2/types'
import type { IssueRecord, Lease, StepResult, V2Io, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, OTHER, PLUGIN_ROOT, config, control, entry, issue, running, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const CFG = config({ mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 2 * HOUR)
const HEAD = '9e01b77c0ffee000000000000000000000000001'
const BRIEF = (n: number) => `https://github.com/${REPO}/issues/${n}#issuecomment-${1000 + n}`

// rec: a record of one life, settled at seq 3 in building unless the test says otherwise.
function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, state: 'building', step: 'build', since: NOW - 20 * MIN, ...over }
}

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })

const OK = { ok: true, at: NOW }

// world: a quiet factory with these records, each in a slot state holding its slot, every v2
// source read.
function world(records: IssueRecord[], over: Partial<State> = {}, v2: Partial<V2State> = {}): State {
  const s = baseState(over)
  const base = emptyV2State(NOW, records)
  return {
    ...s,
    v2: {
      ...base,
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK },
      leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor),
      // the merge queue holds a record whose labels were not read, so each queued one has its issue read
      reads: Object.fromEntries(records.filter(r => r.state === 'merge-queue').map(r => [r.issue, { at: NOW, open: true, labels: [] as string[] }])),
      ...v2,
    },
  }
}

const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })

const plan = (s: State, cfg = CFG): PlanResult => planV2(s, cfg)
const of = (r: PlanResult, n: number | null): Action[] => r.actions.filter(a => a.issue === n && a.kind !== 'title')
const kinds = (r: PlanResult, n: number) => of(r, n).map(a => (a.kind === 'label' ? `label ${a.op}` : a.kind === 'event' ? `event ${a.event.state}` : a.kind === 'slot' ? `slot ${a.op}` : a.kind))
const said = (r: PlanResult, n: number | null) => r.skipped.filter(s => s.issue === n).map(s => s.why)
const transitionOf = (r: PlanResult, n: number) => r.actions.find((a): a is Extract<Action, { kind: 'transition' }> => a.kind === 'transition' && a.issue === n)
// ivs: the interventions planned for an issue (rules-interventions.ts, v2 SPEC 7.2), by who and cause
const ivs = (r: PlanResult, n: number) => of(r, n).flatMap(a => (a.kind === 'event' && a.event.state === 'intervention' ? [`${a.event.who} ${a.event.cause}`] : []))

// done: a ledger entry that ended well, of this record's issue.
function done(key: string, kind: LedgerEntry['kind'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(key, kind, { startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, ...over })
}

// stepDone: a done agent step of the record's current seq and attempt, with its result.
function stepDone(r: IssueRecord, step: 'design' | 'build' | 'review' | 'fix' | 'triage', result: Partial<StepResult>, over: Partial<LedgerEntry> = {}): LedgerEntry {
  const full: StepResult = { event: 'ok', reason: null, why: null, head: null, choice: null, data: null, ...result }
  return done(stepKey(r, step, r.attempt), 'agent-step', { issue: r.issue, class: step === 'design' || step === 'build' ? 'develop' : 'drive', step, agentId: 'agent-1', outcome: { kind: 'step', step, result: full }, ...over })
}

// designed: a designer's brief answer (contracts-work.mjs design-v2) and its comment, posted with
// the brief's URL as the comment's detail: the design step is ok once both are there (U5,
// rules-work.ts).
const DESIGN = { kind: 'brief', brief: '## Design brief (designer, 2026-10-13)', question: null, children: [] }
function designed(r: IssueRecord, url: string): LedgerEntry[] {
  return [stepDone(r, 'design', { event: 'ok', data: DESIGN }), done(entryKey(r, 'comment'), 'comment', { issue: r.issue, outcome: { kind: 'cli', exit: 0, detail: url } })]
}

// transitioned: the record's seq as a transition left it: its entry, by this row from a state.
function transitioned(r: IssueRecord, row: string, from: IssueRecord['state'] | null, via = row.toLowerCase()): LedgerEntry {
  return done(transitionKey(r), 'transition', { issue: r.issue, outcome: { kind: 'transition', row, event: 'ok', cause: null, from, to: r.state, step: null, stored: true, via } })
}

// ivLogged: the intervention a seq's transition is, once logged (keyed iv/<its transition key>)
const ivLogged = (r: IssueRecord): LedgerEntry => done(interventionKey(transitionKey(r)), 'event', { issue: r.issue })

// --- S1: claims (v2 SPEC 14.1, 3.5) ---------------------------------------------------------------------

describe('S1: claims', () => {
  test('ready issues are claimed in priority then number order, up to K counting queued and in-flight records, never parked ones; the cap shows in the title', () => {
    const records = [rec(10, { state: 'parked', step: null, question: 'which API?', resumeTo: 'building' }), rec(11)]
    const s = world(records, { queue: [5, 3, 4, 7], issues: [issue(5), issue(3), issue(4), issue(7)], control: control({ priority: [7] }) })
    const r = plan(s)
    expect(r.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([7, 3])
    for (const a of r.actions.filter(a => a.kind === 'claim')) expect(a).toMatchObject({ class: 'start', rule: 'S1', key: claimKey(a.issue as number, lifeOf(NOW)) })
    expect(said(r, 4)).toEqual(['capacity: 3 of 3 queued or in flight'])
    expect(said(r, 5)).toEqual(['capacity: 3 of 3 queued or in flight'])
    expect(r.atCap).toBe(true)
    expect(r.title).toContain('at cap')
  })

  test('a priority-labelled issue is claimed after the owner list and before the rest, and the claim names its tier', () => {
    const issues = [issue(1), issue(2), issue(3, { labels: ['ready', 'priority'] }), issue(4)]
    const cfg = { ...CFG, maxInFlightIssues: null, maxStartsPerPass: 10 }
    const claims = (r: ReturnType<typeof plan>) => r.actions.filter(a => a.kind === 'claim')
    const r = plan(world([], { queue: [1, 2, 3, 4], issues }), cfg)
    expect(claims(r).map(a => a.issue)).toEqual([3, 1, 2, 4])
    expect(claims(r).map(a => a.reason)).toEqual([
      'ready and unblocked (order: score 30: priority-label +30)',
      'ready and unblocked (order: score 0)',
      'ready and unblocked (order: score 0)',
      'ready and unblocked (order: score 0)',
    ])
    // the owner's priority list goes first, then the label
    const listed = plan(world([], { queue: [1, 2, 4], issues: [issue(1), issue(2, { labels: ['ready', 'priority'] }), issue(4)], control: control({ priority: [4] }) }), cfg)
    expect(claims(listed).map(a => [a.issue, a.reason])).toEqual([
      [4, 'ready and unblocked (order: owner priority)'],
      [2, 'ready and unblocked (order: score 30: priority-label +30)'],
      [1, 'ready and unblocked (order: score 0)'],
    ])
    // `only` wins: the label never widens it
    const only = plan(world([], { queue: [1, 2], issues: [issue(1), issue(2, { labels: ['ready', 'priority'] })], control: control({ only: [1] }) }), cfg)
    expect(claims(only).map(a => [a.issue, a.reason])).toEqual([[1, 'ready and unblocked (order: owner only)']])
    expect(said(only, 2)).toEqual(['owner: only #1'])
    // the case is ignored, and the label is a setting
    const upper = plan(world([], { queue: [1, 2], issues: [issue(1), issue(2, { labels: ['ready', 'Priority'] })] }), cfg)
    expect(claims(upper).map(a => a.issue)).toEqual([2, 1])
    const urgent = world([], { queue: [1, 2, 3], issues: [issue(1), issue(2, { labels: ['ready', 'priority'] }), issue(3, { labels: ['ready', 'urgent'] })] })
    expect(claims(plan(urgent, { ...cfg, priorityLabel: 'urgent' })).map(a => a.issue)).toEqual([3, 1, 2])
  })

  test('the intake factors (#995): off, stamps and paths change nothing; on, the reason shows area-factory +20, needs-owner -40 and overlap -15', () => {
    const cfg = { ...CFG, maxInFlightIssues: null, maxStartsPerPass: 10 }
    const claims = (r: ReturnType<typeof plan>) => r.actions.filter(a => a.kind === 'claim').map(a => [a.issue, a.reason])
    const issues = [issue(1), issue(2, { labels: ['ready', 'area:factory'] }), issue(3, { labels: ['ready', 'needs-decision'] }), issue(4)]
    const stamp = { version: 'v1', area: 'factory', needsOwner: false, touches: ['plugins/x'], at: NOW, labels: [] }
    const stamps = { '2': stamp, '3': stamp, '4': stamp }
    const bare = world([], { queue: [1, 2, 3, 4], issues })
    const withFacts = world([], { queue: [1, 2, 3, 4], issues }, { stamps, inFlightPaths: { 9: ['plugins'] } })
    const baseline = plan(bare, cfg)
    expect(claims(plan(withFacts, cfg))).toEqual(claims(baseline))
    expect(claims(plan(withFacts, { ...cfg, intakeStamp: 'off' }))).toEqual(claims(baseline))
    expect(claims(baseline).map(c => c[1])).toEqual(Array(4).fill('ready and unblocked (order: score 0)'))
    // on: area first, then the unscored, the one held back by overlap and the one that needs the owner last
    const on = plan(withFacts, { ...cfg, intakeStamp: 'on' })
    expect(claims(on)).toEqual([
      [2, 'ready and unblocked (order: score 5: area-factory +20, overlap -15)'],
      [1, 'ready and unblocked (order: score 0)'],
      [4, 'ready and unblocked (order: score -15: overlap -15)'],
      [3, 'ready and unblocked (order: score -55: needs-owner -40, overlap -15)'],
    ])
  })

  test('the rest go by score: a bug that unblocks outranks a priority label, a tie goes to the oldest claimable then the lowest number; the owner lists stay first; every claim carries its score', () => {
    const cfg = { ...CFG, maxInFlightIssues: null, maxStartsPerPass: 10 }
    const claims = (r: ReturnType<typeof plan>) => r.actions.filter((a): a is Extract<Action, { kind: 'claim' }> => a.kind === 'claim')
    const issues = [
      issue(1),
      issue(2, { readyAt: NOW - 2 * HOUR }),
      issue(3, { labels: ['ready', 'priority'] }),
      issue(4, { labels: ['ready', 'bug'], blockingList: [90, 91] }),
      issue(5, { labels: ['ready', 'priority', 'bug'] }),
      issue(6, { labels: ['ready'] }),
    ]
    const r = plan(world([], { queue: [1, 2, 3, 4, 5, 6], issues }), cfg)
    expect(claims(r).map(a => [a.issue, a.reason, a.score])).toEqual([
      [5, 'ready and unblocked (order: score 55: priority-label +30, bug +25)', { score: 55, factors: [{ name: 'priority-label', points: 30 }, { name: 'bug', points: 25 }] }],
      [4, 'ready and unblocked (order: score 45: bug +25, unblocks +20)', { score: 45, factors: [{ name: 'bug', points: 25 }, { name: 'unblocks', points: 20 }] }],
      [3, 'ready and unblocked (order: score 30: priority-label +30)', { score: 30, factors: [{ name: 'priority-label', points: 30 }] }],
      [2, 'ready and unblocked (order: score 4: waiting +4)', { score: 4, factors: [{ name: 'waiting', points: 4 }] }],
      [1, 'ready and unblocked (order: score 0)', { score: 0, factors: [] }],
      [6, 'ready and unblocked (order: score 0)', { score: 0, factors: [] }],
    ])
    // the owner's priority list stays first and in its order, though the rest outscore it
    const listed = claims(plan(world([], { queue: [1, 2, 3, 4, 5, 6], issues, control: control({ priority: [6, 1] }) }), cfg))
    expect(listed.map(a => [a.issue, a.reason])).toEqual([
      [6, 'ready and unblocked (order: owner priority)'],
      [1, 'ready and unblocked (order: owner priority)'],
      [5, 'ready and unblocked (order: score 55: priority-label +30, bug +25)'],
      [4, 'ready and unblocked (order: score 45: bug +25, unblocks +20)'],
      [3, 'ready and unblocked (order: score 30: priority-label +30)'],
      [2, 'ready and unblocked (order: score 4: waiting +4)'],
    ])
    expect(listed.every(a => a.score !== undefined)).toBe(true)
    // `only` is its own tier, scored too
    const only = claims(plan(world([], { queue: [1, 5], issues, control: control({ only: [1] }) }), cfg))
    expect(only.map(a => [a.issue, a.reason, a.score])).toEqual([[1, 'ready and unblocked (order: owner only)', { score: 0, factors: [] }]])
  })

  test('the score reads what the pass knows: a sibling in the factory starts the epic, earlier lives that did not merge count against, and the block graph walks the chain', () => {
    const cfg = { ...CFG, maxInFlightIssues: null, maxStartsPerPass: 10 }
    const claims = (r: ReturnType<typeof plan>) => r.actions.filter((a): a is Extract<Action, { kind: 'claim' }> => a.kind === 'claim')
    const epic = { parent: 9, siblings: [{ number: 60, open: true }, { number: 61, open: true }] }
    const issues = [issue(10, epic), issue(11, { blockingList: [20] })]
    const s = world([rec(60)], { queue: [10, 11], issues: [...issues, issue(60)] })
    const started = claims(plan(s, cfg))
    expect(started.find(a => a.issue === 10)?.score).toEqual({ score: 10, factors: [{ name: 'epic-started', points: 10 }] })
    const chain = claims(plan({ ...s, blockGraph: { 20: [21, 22], 21: [22], 22: [] } }, cfg))
    expect(chain.find(a => a.issue === 11)?.score).toEqual({ score: 20, factors: [{ name: 'unblocks', points: 20 }] })
    expect(claims(plan(s, cfg)).find(a => a.issue === 11)?.score).toEqual({ score: 10, factors: [{ name: 'unblocks', points: 10 }] })
    const failed = rec(12, { life: lifeOf(NOW - 5 * HOUR), state: 'closed', step: null, why: 'dropped' })
    const again = claims(plan(world([failed], { queue: [12], issues: [issue(12)] }), cfg))
    expect(again[0]?.score).toEqual({ score: -10, factors: [{ name: 'failed-lives', points: -10 }] })
    expect(again[0]?.reason).toBe('ready and unblocked (order: score -10: failed-lives -10)')
  })

  test('the priority label only orders: the capacity, the filters and unread labels apply as to any issue', () => {
    const cap = plan(world([rec(60), rec(61)], { queue: [5, 9], issues: [issue(5), issue(9, { labels: ['ready', 'priority'] })] }))
    expect(cap.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([9])
    expect(said(cap, 5)).toEqual(['capacity: 3 of 3 queued or in flight'])
    const issues = [
      issue(11, { labels: ['ready', 'priority'], blockedBy: 1 }),
      issue(12, { labels: ['ready', 'priority'], subIssues: 2 }),
      issue(13, { labels: ['ready', 'priority', 'parked'] }),
      issue(14, { labels: null }),
      issue(15),
    ]
    const r = plan(world([], { queue: [11, 12, 13, 14, 15], issues }), { ...CFG, skipLabels: ['parked'], maxInFlightIssues: null })
    expect(r.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([15])
    expect([11, 12, 13, 14].map(n => said(r, n)[0])).toEqual(['blocked by 1 open issue', 'tracker (has sub-issues)', 'label parked', 'labels unknown'])
  })

  test('the claim filters: closed, untrusted, not ready, a skip label, blocked, a tracker, another device\'s live work, skipped, paused, or in the factory already', () => {
    const issues = [
      issue(21, { open: false }),
      issue(22, { trusted: false }),
      issue(23, { labels: ['enhancement'] }),
      issue(24, { labels: ['ready', 'parked'] }),
      issue(25, { blockedBy: 2 }),
      issue(26, { subIssues: 3 }),
      issue(27, { epic: true }),
      issue(28, { holder: OTHER, stage: 'designing' }),
      issue(29),
      issue(30),
      issue(31),
    ]
    const s = world([rec(31)], { queue: issues.map(i => i.number), issues, control: control({ skip: [29], paused: [30] }) })
    const r = plan(s, { ...CFG, skipLabels: ['parked'], maxInFlightIssues: null })
    // #31 listed ready beside its record is never a new claim, and the label list alone is no
    // lapse either: H1 reads a lapse from facts (the factory source, a `reclaimed` event)
    expect(r.actions.filter(a => a.kind === 'claim').map(a => [a.issue, a.rule])).toEqual([])
    expect(Object.fromEntries(issues.map(i => [i.number, said(r, i.number).find(w => !w.startsWith('building'))]))).toEqual({
      21: 'closed',
      22: 'untrusted author',
      23: 'no ready label',
      24: 'label parked',
      25: 'blocked by 2 open issues',
      26: 'tracker (has sub-issues)',
      27: 'tracker (title)',
      28: `another device holds it (${OTHER})`,
      29: 'owner: skip',
      30: 'owner: paused',
      31: 'in the factory as building',
    })
  })

  test('a drop applies to its life: a dropped issue whose ready label came back is claimed again; a failed claim retries under its own key; a lost one waits until the issue is queued again', () => {
    const old = lifeOf(NOW - 5 * HOUR)
    const dropped = rec(40, { life: old, state: 'closed', step: null, why: 'dropped', since: NOW - 3 * HOUR })
    const failed = entry(claimKey(41, old), 'claim', { issue: 41, class: 'start', status: 'failed', attempts: 1, startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN })
    const lost = done(claimKey(42, old), 'claim', { issue: 42, startedAt: NOW - 5 * MIN, outcome: { kind: 'claim', result: 'lost' } })
    const s = withLedger(world([dropped], { queue: [40, 41, 42], issues: [issue(40), issue(41), issue(42)], control: control({ dropped: [{ issue: 40, at: NOW - 3 * HOUR }] }) }), [failed, lost])
    const r = plan(s, { ...CFG, maxInFlightIssues: null })
    // #40 had a life that ended dropped, so failed-lives -10 puts it after #41
    expect(r.actions.filter(a => a.kind === 'claim').map(a => [a.issue, a.key])).toEqual([
      [41, claimKey(41, old)],
      [40, claimKey(40, lifeOf(NOW))],
    ])
    expect(said(r, 42)).toContain('another device holds it')
    // queued again after the lost claim: a new claim
    const requeued = { ...s, issues: [issue(40), issue(41), issue(42, { stageSince: NOW - MIN })] }
    expect(plan(requeued, { ...CFG, maxInFlightIssues: null }).actions.filter(a => a.kind === 'claim').map(a => a.issue)).toContain(42)
  })

  test('a claim that may hold the issue (posted, then the adoption failed; or lost to a reload) is finished whatever the queue says, holds its place under the cap, and is told once its attempts are used up', () => {
    const life = lifeOf(NOW - 10 * MIN)
    const posted = entry(claimKey(43, life), 'claim', { issue: 43, class: 'start', status: 'failed', attempts: 1, startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN, outcome: { kind: 'claim', result: 'claimed' }, summary: 'claimed #43, but the PRs to adopt did not read' })
    const lost = entry(claimKey(44, life), 'claim', { issue: 44, class: 'start', status: 'lost', attempts: 1, startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN })
    // the claim took `ready` off, so the queue no longer lists either; the cap is full with them
    const s = withLedger(world([rec(45)], { queue: [46], issues: [issue(43, { labels: ['enhancement'] }), issue(44, { labels: ['enhancement'] }), issue(46)], control: control({ noNewWork: false }) }), [posted, lost])
    const r = plan(s)
    expect(r.actions.filter(a => a.kind === 'claim').map(a => [a.issue, a.key, a.class, a.rule])).toEqual([
      [43, posted.key, 'free', 'S1'],
      [44, lost.key, 'free', 'S1'],
    ])
    expect(said(r, 46)).toEqual(['capacity: 3 of 3 queued or in flight'])
    // finishing is not new work: no owner hold or tier keeps it from running
    const held = plan({ ...s, control: control({ noNewWork: true }) })
    expect(held.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([43, 44])
    // the claim tool failed before it posted anything: the queue path retries it while it is ready
    const plain = withLedger(world([], { queue: [], issues: [issue(47)] }), [entry(claimKey(47, life), 'claim', { issue: 47, class: 'start', status: 'failed', attempts: 1, startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN, outcome: { kind: 'cli', exit: 1 } })])
    expect(plan(plain).actions.filter(a => a.kind === 'claim')).toEqual([])
    // used up: told once, and it no longer holds a place (R1 releases it)
    const spent = withLedger(world([], { queue: [], issues: [issue(43, { labels: ['enhancement'] })] }), [{ ...posted, attempts: 9 }])
    const told = plan(spent)
    expect(told.actions.filter(a => a.kind === 'claim')).toEqual([])
    expect(said(told, 43)).toEqual([`exhausted: ${posted.key}`])
    expect(of(told, 43)).toEqual([expect.objectContaining({ kind: 'tell', wake: 'stalled' })])
    // done at last: S0 makes the record from it
    const finished = withLedger(world([], { queue: [], issues: [issue(43, { labels: ['enhancement'] })] }), [{ ...posted, status: 'done', attempts: 2, endedAt: NOW - MIN, outcome: { kind: 'adopt', branch: 'issue-43', pr: null, others: [] } }])
    expect(transitionOf(plan(finished), 43)).toMatchObject({ row: 'S0', next: { issue: 43, life, state: 'queued' } })
  })

  test('no new work, a stopping tier, serial and Slow each hold claims with a skip line naming the limit; a claim in flight holds its place under the cap', () => {
    const q = { queue: [50, 51], issues: [issue(50), issue(51)] }
    expect(said(plan(world([], { ...q, control: control({ noNewWork: true }) })), 50)).toEqual(['owner: no new work'])
    expect(said(plan(world([], { ...q, usage: { fiveHour: 92, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } })), 50)).toEqual(['tier stop-new'])
    expect(said(plan(world([rec(52)], { ...q, control: control({ serial: true }) })), 50)).toEqual(['owner: one at a time'])
    const slow = world([], { ...q, usage: { fiveHour: 86, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } })
    const r = plan(slow)
    expect(r.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([50])
    expect(said(r, 51)).toEqual(['slow: one claim per pass'])
    const recent = withLedger(slow, [done(claimKey(49, lifeOf(NOW - 5 * MIN)), 'claim', { issue: 49, startedAt: NOW - 5 * MIN, outcome: { kind: 'claim', result: 'lost' } })])
    expect(said(plan(recent), 50)).toEqual(['slow: too soon after the last claim'])
    // a claim running holds its place: K 1, one in flight, nothing more
    const inFlight = withLedger(world([], q), [entry(claimKey(53, lifeOf(NOW - MIN)), 'claim', { issue: 53, status: 'running', endedAt: null, startedAt: NOW - MIN })])
    expect(said(plan(inFlight, { ...CFG, maxInFlightIssues: 1 }), 50)).toEqual(['capacity: 1 of 1 queued or in flight'])
  })
})

// --- S0: a record from its done claim (3.3, 3.5) ----------------------------------------------------------

describe('S0: the record a done claim makes', () => {
  test('a done claim makes its queued record: the life, the adopted PR\'s branch and number, a lease that leads to review; the transition re-checks the claim; a lost claim makes none', () => {
    const key = claimKey(60, LIFE)
    const s = withLedger(world([], { queue: [61], issues: [issue(61)] }), [
      done(key, 'claim', { issue: 60, outcome: { kind: 'adopt', branch: 'feat/issue-60-x', pr: 660, others: [659] } }),
      done(claimKey(62, LIFE), 'claim', { issue: 62, outcome: { kind: 'claim', result: 'lost' } }),
    ])
    const r = plan(s, { ...CFG, maxInFlightIssues: 1 })
    const t = transitionOf(r, 60)
    expect(t).toMatchObject({ rule: 'S1', row: 'S0', event: 'ok', from: null, trigger: { kind: 'claim', key }, via: 'adopt' })
    expect(t?.next).toMatchObject({ issue: 60, life: LIFE, seq: 1, state: 'queued', step: 'lease', branch: 'feat/issue-60-x', pr: 660, resumeTo: 'reviewing', since: NOW, seqAt: NOW })
    expect(t?.next.notes).toEqual([expect.stringContaining('#659')])
    expect(transitionOf(r, 62)).toBeUndefined()
    // the claim waiting for its record holds its place under the cap
    expect(said(r, 61)).toEqual(['capacity: 1 of 1 queued or in flight'])
    // once its record exists, nothing more is made
    const made = madeRecord({ issue: 60, life: LIFE, branch: 'feat/issue-60-x', pr: 660, others: [] }, NOW - MIN)
    expect(transitionOf(plan(withLedger(world([made]), s.ledger.slice(-2))), 60)).toBeUndefined()
  })
})

// --- S7: a split child parked on its open decision (8.7) ----------------------------------------------------

describe('S7: a done claim that carries a park makes the parked record', () => {
  const park = { question: 'Which API shape?\n\n#### Options\n\n- [ ] **A** - One call\n- [ ] **B** - Two calls', parent: 300 }
  const key = claimKey(61, LIFE)
  const claimed = done(key, 'claim', { issue: 61, outcome: { kind: 'claim', result: 'claimed', park } })

  test('the record is parked at once with the question and resumeTo designing; the entry items post the park comment, set the label and tell the owner', () => {
    const t = transitionOf(plan(withLedger(world([]), [claimed])), 61)
    expect(t).toMatchObject({ rule: 'S1', row: 'S7', event: 'ok', from: null, trigger: { kind: 'claim', key }, via: 'split-decision' })
    expect(t?.next).toMatchObject({ issue: 61, life: LIFE, seq: 1, state: 'parked', step: null, resumeTo: 'designing', question: park.question, notes: [expect.stringContaining('#300')] })
    if (t === undefined) return
    const entered = plan(withLedger(world([t.next]), [claimed, transitioned(t.next, 'S7', null, 'split-decision')]))
    const items = of(entered, 61)
    const comment = items.find(a => a.kind === 'comment')
    expect(comment).toMatchObject({ on: 'issue', number: 61, body: expect.stringContaining('**Decision needed:** Which API shape?') })
    expect(comment?.kind === 'comment' ? comment.body : '').toContain('It parked when #300 was split, and a resume goes on with designing.')
    expect(items.find(a => a.kind === 'label' && a.op === 'set')).toMatchObject({ label: 'factory:parked' })
    expect(items.find(a => a.kind === 'tell')).toMatchObject({ wake: 'parked', class: 'owner', fields: { issue: '61', from: 'designing' } })
  })

  test('a resume (the label off, or /factory resume) takes it to queued then designing, the owner\'s answer a note', () => {
    const t = transitionOf(plan(withLedger(world([]), [claimed])), 61)
    if (t === undefined) throw new Error('no S7 transition')
    const parked = { ...t.next, seq: 1, seqAt: NOW - 2 * HOUR, since: NOW - 2 * HOUR }
    const settled = [claimed, transitioned(parked, 'S7', null, 'split-decision'), done(entryKey(parked, 'event/transition'), 'event', { issue: 61 }), done(entryKey(parked, 'label'), 'label', { issue: 61, endedAt: NOW - 2 * HOUR + MIN }), done(entryKey(parked, 'comment'), 'comment', { issue: 61, endedAt: NOW - 2 * HOUR + 2 * MIN }), done(entryKey(parked, 'tell'), 'tell', { issue: 61, class: 'owner', wake: 'parked' })]
    const r = plan(withLedger(world([parked], { control: control({ resumed: [{ subject: 'issue:61', at: NOW - MIN, note: 'B, two calls' }] }) }), settled))
    const queued = transitionOf(r, 61)
    expect(queued).toMatchObject({ row: 'P1', via: 'unpark:op', next: { state: 'queued', step: 'lease', resumeTo: 'designing', question: null, notes: ['B, two calls'] } })
    const lease = queued === undefined ? null : rowFor(queued.next, { kind: 'ok' }, CFG)
    expect(lease).toMatchObject({ id: 'T1', next: 'resumeTo' })
  })

  test('a lost claim makes no record; a claim without a park still makes S0\'s queued record', () => {
    const lost = done(key, 'claim', { issue: 61, outcome: { kind: 'claim', result: 'lost' } })
    expect(transitionOf(plan(withLedger(world([]), [lost])), 61)).toBeUndefined()
    const plain = done(key, 'claim', { issue: 61, outcome: { kind: 'claim', result: 'claimed' } })
    const t = transitionOf(plan(withLedger(world([]), [plain])), 61)
    expect(t).toMatchObject({ row: 'S0', via: 'claim', next: { state: 'queued', step: 'lease', resumeTo: null, question: null } })
  })
})

// --- entry actions (4.5) ------------------------------------------------------------------------------------

describe('a seq\'s entry actions (v2 SPEC 4.5)', () => {
  test('a new seq logs its transition first, then writes its label; the seven labels are made first, once per load; the step waits until they are done', () => {
    const r = rec(70, { state: 'designing', step: 'design', seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    const s = withLedger(world([r]), [transitioned(r, 'T1', 'queued', 'lease')])
    const first = plan(s)
    expect(kinds(first, 70)).toEqual(['event transition', 'label set'])
    const [log, label] = of(first, 70)
    expect(log).toMatchObject({ kind: 'event', event: { state: 'transition', record: r, row: 'T1', from: 'queued', via: 'lease' } })
    expect(label).toMatchObject({ kind: 'label', op: 'set', label: 'factory:designing' })
    const ensure = first.actions.findIndex(a => a.kind === 'label' && a.op === 'ensure')
    expect(ensure).toBeGreaterThanOrEqual(0)
    expect(ensure).toBeLessThan(first.actions.indexOf(log as Action))
    expect(said(first, 70)).toEqual([`its transition event of seq 4 is not logged yet`])
    // the label made, the event logged: the step starts, its slot prepared first
    const settled = withLedger(s, [done(entryKey(r, 'event/transition'), 'event', { issue: 70 }), done(entryKey(r, 'label'), 'label', { issue: 70 })])
    const next = plan(settled)
    expect(kinds(next, 70)).toEqual(['slot prepare'])
    // with no label left to write, none is made
    expect(next.actions.some(a => a.kind === 'label')).toBe(false)
  })

  test('the events a row logs beside transition: entering building, fixing and the merge queue logs only the transition (no delegated, fix_requested or merge_ready), a drop logs abandoned; a park posts its question and tells the owner', () => {
    const build = rec(71, { brief: BRIEF(71), seq: 5, seqAt: NOW - MIN, since: NOW - MIN })
    const fix = rec(72, { state: 'fixing', step: 'fix', seq: 6, seqAt: NOW - MIN, since: NOW - MIN })
    const queue = rec(73, { state: 'merge-queue', step: 'queue', pr: 773, head: HEAD, seq: 7, seqAt: NOW - MIN, since: NOW - MIN })
    const drop = rec(74, { state: 'closed', step: null, why: 'dropped', notes: ['dropped'], seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    const park = rec(75, { state: 'parked', step: null, question: 'which API?', resumeTo: 'designing', seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    const s = withLedger(world([build, fix, queue, drop, park]), [
      transitioned(build, 'T2', 'designing', 'brief'),
      transitioned(fix, 'T9', 'reviewing', 'fix:ci'),
      transitioned(queue, 'T8', 'reviewing', 'approve'),
      transitioned(drop, 'E1', 'building', 'drop'),
      transitioned(park, 'T3', 'designing', 'question'),
    ])
    const r = plan(s)
    const notes = (n: number) => of(r, n).flatMap(a => (a.kind === 'event' && a.event.state !== 'transition' && 'note' in a.event ? [`${a.event.state}: ${a.event.note}`] : []))
    for (const n of [71, 72, 73]) expect([n, notes(n)]).toEqual([n, []])
    for (const n of [71, 72, 73]) expect(of(r, n).filter(a => a.kind === 'event' && a.event.state !== 'intervention').map(a => (a.kind === 'event' ? a.event.state : ''))).toEqual(['transition'])
    expect(of(r, 71).some(a => a.key.includes('event/delegated'))).toBe(false)
    expect(of(r, 72).some(a => a.key.includes('event/fix_requested'))).toBe(false)
    expect(of(r, 73).some(a => a.key.includes('event/merge_ready'))).toBe(false)
    expect(notes(74)).toEqual(['abandoned: dropped'])
    expect(kinds(r, 74)).toEqual(['event transition', 'label clear', 'event abandoned'])
    // a park is an intervention by the loop, logged beside its entry actions; so is a fixer for red
    // CI; the planned work (a brief, an approval, a drop) is none (v2 SPEC 7.2)
    expect(kinds(r, 75)).toEqual(['event transition', 'label set', 'comment', 'tell', 'event intervention'])
    expect(ivs(r, 75)).toEqual(['loop park'])
    expect(ivs(r, 72)).toEqual(['loop fix:ci'])
    for (const n of [71, 73, 74]) expect([n, ivs(r, n)]).toEqual([n, []])
    const comment = of(r, 75).find(a => a.kind === 'comment')
    expect(comment).toMatchObject({ on: 'issue', number: 75, body: expect.stringContaining('which API?') })
    expect((comment as Extract<Action, { kind: 'comment' }>).body).toContain('/factory resume 75')
    expect(of(r, 75).find(a => a.kind === 'tell')).toMatchObject({ wake: 'parked', class: 'owner', fields: { issue: '75', from: 'designing' } })
    expect(r.owner).toBeGreaterThanOrEqual(1)
  })

  test('an entry into building, fixing or the merge queue, a resume\'s T1 included, logs only its transition (the delegated, fix_requested and merge_ready events are no longer written)', () => {
    const fix = rec(81, { state: 'fixing', step: 'fix', fixes: 1, pr: 781, seq: 21, seqAt: NOW - MIN, since: NOW - MIN })
    const queue = rec(82, { state: 'merge-queue', step: 'queue', pr: 782, head: HEAD, round: 2, seq: 9, seqAt: NOW - MIN, since: NOW - MIN })
    const triage = rec(83, { state: 'fixing', step: 'fix', fixes: 2, pr: 783, seq: 7, seqAt: NOW - MIN, since: NOW - 10 * MIN })
    const s = withLedger(world([fix, queue, triage]), [
      // #81 parked at the fix cap for a conflict, then resumed: the T1 into fixing
      transitioned({ ...fix, seq: 18, state: 'parked' }, 'T10', 'merge-queue', 'fix-cap:conflict'),
      transitioned({ ...fix, seq: 20, state: 'queued' }, 'P1', 'parked', 'unpark:label'),
      transitioned(fix, 'T1', 'queued', 'lease'),
      // #82 resumed into the merge queue
      transitioned(queue, 'T1', 'queued', 'lease'),
      // #83: a triage in fixing chose a fixer (X2 enters fixing from fixing)
      transitioned({ ...triage, seq: 5 }, 'T9', 'reviewing', 'fix:ci'),
      transitioned(triage, 'X2', 'fixing', 'triage:fix'),
    ])
    const r = plan(s)
    const notes = (n: number) => of(r, n).flatMap(a => (a.kind === 'event' && a.event.state !== 'transition' && a.event.state !== 'intervention' && 'note' in a.event ? [`${a.event.state}: ${a.event.note}`] : []))
    expect([notes(81), notes(82), notes(83)]).toEqual([[], [], []])
    for (const n of [81, 82, 83]) expect(of(r, n).filter(a => a.kind === 'event' && a.event.state !== 'intervention').map(a => a.key.split('/').slice(-2).join('/'))).toEqual(['event/transition'])
  })

  test('a closed record ends its claim at once: once its entry actions are done the sweep is due, so a merged or closed issue is not live until the next timed sweep (R4-O1)', () => {
    const sweeps = (p: PlanResult) => p.actions.filter(a => a.kind === 'sweep').map(a => a.rule)
    const sweep = (startedAt: number) => entry('sweep:1', 'sweep', { startedAt, endedAt: startedAt + 2_000 })
    const ended = (key: string, kind: LedgerEntry['kind'], issue: number, over: Partial<LedgerEntry> = {}) => done(key, kind, { issue, startedAt: NOW - 25_000, endedAt: NOW - 20_000, ...over })
    // a close on GitHub (E2), stored a minute ago; its entry actions ended 20 s ago
    const r = rec(84, { state: 'closed', step: null, why: 'closed-on-github', seq: 9, seqAt: NOW - MIN, since: NOW - MIN })
    const at = (sweptAt: number, extra: LedgerEntry[] = []) => withLedger(world([r]), [transitioned(r, 'E2', 'building', 'issue-closed'), sweep(sweptAt), ...extra])
    const settled = [ended(entryKey(r, 'event/transition'), 'event', 84), ended(entryKey(r, 'label'), 'label', 84)]
    // the close's events are not logged yet: the sweep waits for them
    expect(sweeps(plan(at(NOW - 5 * MIN)))).toEqual([])
    // logged: the sweep is due, though its period has not passed; so too when the last sweep began
    // after the close was stored but before its events were logged (it could not see them)
    expect([sweeps(plan(at(NOW - 5 * MIN, settled))), sweeps(plan(at(NOW - 40_000, settled)))]).toEqual([['H2'], ['H2']])
    // a sweep that began after the close's events were logged saw it: no second one
    expect(sweeps(plan(at(NOW - 10_000, settled)))).toEqual([])
    // a merge (T13) whose log was lost: the sweep waits for the merged fact and the rollout's
    // follow-ups too, not the transition alone, so its `closed` never comes first (R3-F1)
    const m = rec(85, { state: 'closed', step: null, why: 'merged', pr: 785, seq: 9, seqAt: NOW - MIN, since: NOW - MIN })
    const merged = (over: Partial<LedgerEntry> = {}) => ended(entryKey(m, 'event/merged'), 'event', 85, over)
    const rollout = ended(followKey(m, 'rollout'), 'rollout', 85, { outcome: { kind: 'rollout', rollout: null, closeIssue: null } })
    const logged = [ended(entryKey(m, 'event/transition'), 'event', 85), ended(entryKey(m, 'label'), 'label', 85)]
    const mergedAt = (extra: LedgerEntry[]) => withLedger(world([m]), [transitioned(m, 'T13', 'merge-queue', 'merged'), sweep(NOW - 5 * MIN), ...logged, ...extra])
    expect([
      sweeps(plan(mergedAt([merged({ status: 'running', endedAt: null }), rollout]))),
      sweeps(plan(mergedAt([merged()]))),
      sweeps(plan(mergedAt([merged(), rollout]))),
    ]).toEqual([[], [], ['H2']])
  })

  test('a closed record\'s follow-ups: a hand merge logs merged when the factory has none, reads the rollout, then a later milestone for run-it; a split releases its parent with its children; another device\'s claim keeps its labels', () => {
    const merged = rec(76, { state: 'closed', step: null, why: 'merged-by-hand', pr: 776, seq: 8, seqAt: NOW - MIN, since: NOW - MIN })
    const split = rec(77, { state: 'closed', step: null, why: 'split', seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    const lost = rec(78, { state: 'closed', step: null, why: 'claim-lost', seq: 5, seqAt: NOW - MIN, since: NOW - MIN })
    const child = (k: string, n: number) => done(`${seqKey({ ...split, seq: 3 })}/child/${k}`, 'split', { issue: 77, outcome: { kind: 'split', child: n } })
    const s = withLedger(world([merged, split, lost], { issues: [issue(76, { stage: 'ready to merge' }), issue(78, { holder: OTHER, stage: 'designing' })] }), [
      transitioned(merged, 'E3', 'reviewing', 'pr-merged'),
      transitioned(split, 'T4', 'designing', 'split'),
      transitioned(lost, 'E5', 'building', 'claim-lost'),
      child('b', 802),
      child('a', 801),
    ])
    const r = plan(s)
    // a hand merge is a person's intervention (v2 SPEC 7.2); a split and a lost claim are none
    expect(kinds(r, 76)).toEqual(['event merged', 'event transition', 'label clear', 'rollout', 'event intervention'])
    expect(ivs(r, 76)).toEqual(['person hand-merge'])
    expect([ivs(r, 77), ivs(r, 78)]).toEqual([[], []])
    expect(of(r, 76).find(a => a.kind === 'rollout')).toMatchObject({ pr: 776, key: followKey(merged, 'rollout') })
    expect(of(r, 77).find(a => a.kind === 'release-parent')).toMatchObject({ created: [801, 802] })
    expect(kinds(r, 78)).toEqual(['event transition'])
    // the rollout read run-it, and the factory holds the merge: the later milestone, no merged event
    const read = withLedger(
      { ...s, issues: [issue(76, { stage: 'merged', stageSince: NOW - 2 * MIN })], milestone: { open: 1, closed: 0, openIssues: [], expected: null } },
      [done(followKey(merged, 'rollout'), 'rollout', { issue: 76, outcome: { kind: 'rollout', rollout: 'run-it', closeIssue: null } }), ivLogged(merged)],
    )
    expect(kinds(plan(read), 76)).toEqual(['event transition', 'label clear', 'milestone-later'])
  })

  test('a merge whose rollout read merge checks its split tracker, after its epic-base close; a closed tracker checks its own parent, TRACKER_DEPTH checks in all; run-it, keep-open, a drop and a split plan none (#946)', () => {
    const merged = rec(76, { state: 'closed', step: null, why: 'merged', pr: 776, seq: 8, seqAt: NOW - MIN, since: NOW - MIN })
    const key = followKey(merged, 'close-tracker')
    const read = (rollout: 'merge' | 'run-it' | 'keep-open' | null, closeIssue: number | null = null) => done(followKey(merged, 'rollout'), 'rollout', { issue: 76, outcome: { kind: 'rollout', rollout, closeIssue } })
    const checks = (extra: LedgerEntry[], r = merged) => plan(withLedger({ ...world([r]), issues: [issue(r.issue, { stage: 'merged', stageSince: NOW - 2 * MIN })] }, [transitioned(r, 'T13', 'merge-queue', 'merged'), ...extra])).actions.filter(a => a.kind === 'close-tracker')
    const closed = (k: string, parent: number, isClosed: boolean) => done(k, 'close-tracker', { issue: 76, outcome: { kind: 'close-tracker', parent, closed: isClosed, open: [] } })
    // waits for the rollout read
    expect(checks([])).toEqual([])
    expect(checks([read('merge')])).toEqual([expect.objectContaining({ key, issue: 76 })])
    // run-it and keep-open leave the issue open: no check
    expect([checks([read('run-it')]), checks([read('keep-open')]), checks([read(null)])]).toEqual([[], [], []])
    // an epic base: the close of the issue comes first
    const close = (status: LedgerEntry['status']) => done(followKey(merged, 'close-issue'), 'close-issue', { issue: 77, status })
    expect(checks([read('merge', 77)])).toEqual([])
    expect(checks([read('merge', 77), close('running')])).toEqual([])
    expect(checks([read('merge', 77), close('done')])).toHaveLength(1)
    // a drop and a split plan none
    const dropped = rec(78, { state: 'closed', step: null, why: 'dropped', seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    const split = rec(79, { state: 'closed', step: null, why: 'split', seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    expect([checks([], dropped), checks([], split)]).toEqual([[], []])
    // the chain: a plan holds what is not done yet. Only a check that closed a tracker goes up, to that tracker's parent, three checks in all
    expect(checks([read('merge'), closed(key, 139, false)])).toEqual([])
    expect(checks([read('merge'), closed(key, 139, true)]).map(a => [a.key, a.issue])).toEqual([[`${key}/up`, 139]])
    expect(checks([read('merge'), closed(key, 139, true), closed(`${key}/up`, 140, true)]).map(a => [a.key, a.issue])).toEqual([[`${key}/up/up`, 140]])
    expect(checks([read('merge'), closed(key, 139, true), closed(`${key}/up`, 140, true), closed(`${key}/up/up`, 141, true)])).toEqual([])
    // a null parent ends the chain
    expect(checks([read('merge'), { ...closed(key, 139, true), outcome: { kind: 'close-tracker', parent: null, closed: true, open: [] } }])).toEqual([])
  })

  describe('a done close (T18): the work was already merged (8.7, 4.5)', () => {
    const SHA = (c: string) => c.repeat(40).slice(0, 40)
    const designing = rec(90, { state: 'designing', step: 'design' })
    const closedRec = rec(90, { state: 'closed', step: null, why: 'done', seq: 4, seqAt: NOW - MIN, since: NOW - MIN, notes: ['done: PR #812 (merge aaaaaaa)'] })
    const answer = (branch: { sha: string | null; beyond: number | null }, over: Record<string, unknown> = {}) =>
      stepDone(designing, 'design', {
        event: 'not-ok',
        reason: 'done',
        data: { kind: 'done', brief: null, question: null, children: [], evidence: { pr: 812, commit: null, runIt: `https://github.com/${REPO}/issues/90#issuecomment-5` }, reason: 'Shipped in PR 812', text: 'done: PR #812', checked: SHA('a'), mergeCommit: SHA('a'), prHead: SHA('b'), branch, ...over },
      })
    const at = (extra: LedgerEntry[], data = answer({ sha: SHA('c'), beyond: 0 })) => withLedger(world([closedRec]), [data, transitioned(closedRec, 'T18', 'designing', 'done'), ...extra])
    const close = (status: LedgerEntry['status'] = 'done') => done(followKey(closedRec, 'close-issue'), 'close-issue', { issue: 90, status })

    test('the closed entry clears the labels, posts one comment with the evidence, the reason and the branch line, then closes the issue as completed and logs closed; it tells the owner once', () => {
      const r = plan(at([]))
      expect(kinds(r, 90)).toEqual(['event transition', 'label clear', 'comment', 'close-issue', 'tell'])
      const comment = of(r, 90).find(a => a.kind === 'comment')
      expect(comment).toMatchObject({ key: entryKey(closedRec, 'comment'), on: 'issue', number: 90 })
      const body = (comment as { body: string }).body
      expect(body).toContain('PR #812 (merge aaaaaaa)')
      expect(body).toContain(`run it: https://github.com/${REPO}/issues/90#issuecomment-5`)
      expect(body).toContain('Reason: Shipped in PR 812')
      expect(body).toContain('`issue-90` is deleted from origin, since it has no commit beyond the default branch')
      expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i)
      // a closing keyword in the designer's reason links nothing once the executor posts it
      const worded = plan(at([], answer({ sha: SHA('c'), beyond: 0 }, { reason: 'Closes #12 and fixes #13' })))
      expect(commentBody((of(worded, 90).find(x => x.kind === 'comment') as { body: string }).body, 'k')).toContain('Reason: Closing #12 and fixing #13')
      expect(of(r, 90).find(a => a.kind === 'close-issue')).toMatchObject({ key: followKey(closedRec, 'close-issue'), issue: 90, logClosed: true })
      expect(of(r, 90).find(a => a.kind === 'tell')).toMatchObject({ wake: 'done', fields: { issue: '90', branch: 'deleted' } })
    })

    test('the branch is deleted, leased on the head read, only once the close is done and only when it has no commit beyond main or is the evidence PR\'s head', () => {
      const deletes = (extra: LedgerEntry[], data?: LedgerEntry) => of(plan(at(extra, data)), 90).filter(a => a.kind === 'delete-branch')
      expect(deletes([])).toEqual([])
      expect(deletes([close('running')])).toEqual([])
      expect(deletes([close()])).toEqual([expect.objectContaining({ key: followKey(closedRec, 'delete-branch'), branch: 'issue-90', sha: SHA('c') })])
      // its head is the merged PR's head, whatever it holds beyond main
      expect(deletes([close()], answer({ sha: SHA('b'), beyond: 3 }))).toEqual([expect.objectContaining({ sha: SHA('b') })])
      // its own commits: kept, and the comment and the tell say so
      const own = plan(at([close()], answer({ sha: SHA('c'), beyond: 3 })))
      expect(of(own, 90).filter(a => a.kind === 'delete-branch')).toEqual([])
      expect((of(own, 90).find(a => a.kind === 'comment') as { body: string }).body).toContain('is kept, since it has 3 commits of its own beyond the default branch')
      expect(of(own, 90).find(a => a.kind === 'tell')).toMatchObject({ fields: { branch: 'kept' } })
      // not read beyond main: kept
      expect(deletes([close()], answer({ sha: SHA('c'), beyond: null }))).toEqual([])
      // no branch on origin: nothing to delete
      const absent = plan(at([close()], answer({ sha: null, beyond: null })))
      expect(of(absent, 90).filter(a => a.kind === 'delete-branch')).toEqual([])
      expect((of(absent, 90).find(a => a.kind === 'comment') as { body: string }).body).toContain('origin has no branch issue-90')
      // the design answer can no longer be read: the close still runs, no branch is deleted
      const lost = plan(withLedger(world([closedRec]), [transitioned(closedRec, 'T18', 'designing', 'done'), close()]))
      expect(kinds(lost, 90)).toEqual(['event transition', 'label clear', 'comment', 'close-tracker', 'tell'])
      expect((of(lost, 90).find(a => a.kind === 'comment') as { body: string }).body).toContain('no branch is deleted')
    })

    test('a split child that was the last open one has its tracker checked after the close, the chain going up as a merge\'s does', () => {
      const key = followKey(closedRec, 'close-tracker')
      const checks = (extra: LedgerEntry[]) => plan(at(extra)).actions.filter(a => a.kind === 'close-tracker').map(a => [a.key, a.issue])
      expect(checks([])).toEqual([])
      expect(checks([close('running')])).toEqual([])
      expect(checks([close()])).toEqual([[key, 90]])
      expect(checks([close(), done(key, 'close-tracker', { issue: 90, outcome: { kind: 'close-tracker', parent: 139, closed: true, open: [] } })])).toEqual([[`${key}/up`, 139]])
    })

    test('the issue shows closed once the loop closed it: no E2 reads a closed done record', () => {
      const s = withLedger(world([closedRec], {}, { reads: { 90: { open: false, at: NOW, state: null } as never } }), [transitioned(closedRec, 'T18', 'designing', 'done'), close()])
      expect(transitionOf(plan(s), 90)).toBeUndefined()
    })

    test('an issue blocked by the done issue is claimable once its blockedBy reads 0 (rules-claim.ts)', () => {
      const blocked = (blockedBy: number) => plan(world([], { queue: [91], issues: [issue(91, { blockedBy })] }))
      expect(blocked(1).actions.filter(a => a.kind === 'claim')).toEqual([])
      expect(said(blocked(1), 91)).toContain('blocked by 1 open issue')
      expect(blocked(0).actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([91])
    })
  })

  test('a merged issue whose rollout read keep-open while open issues wait on it tells the owner once; nothing else does', () => {
    const merged = rec(76, { state: 'closed', step: null, why: 'merged', pr: 776, seq: 8, seqAt: NOW - MIN, since: NOW - MIN })
    const read = (rollout: 'merge' | 'run-it' | 'keep-open') => done(followKey(merged, 'rollout'), 'rollout', { issue: 76, outcome: { kind: 'rollout', rollout, closeIssue: null } })
    const at = (rollout: 'merge' | 'run-it' | 'keep-open', blocking: number | null, extra: LedgerEntry[] = []) =>
      withLedger({ ...world([merged]), issues: [issue(76, { stage: 'merged', stageSince: NOW - 2 * MIN, blocking })], milestone: { open: 1, closed: 0, openIssues: [], expected: null } }, [transitioned(merged, 'T13', 'merge-queue', 'merged'), read(rollout), ...extra])
    const tells = (s: State) => of(plan(s), 76).filter(a => a.kind === 'tell')
    const out = tells(at('keep-open', 2))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'tell', wake: 'keep-open-blocks', key: followKey(merged, 'blocked-tell'), fields: { issue: '76', blocking: '2' } })
    expect(JSON.stringify(out[0])).toContain(`issues/76`)
    // told once: with the tell done, none is planned, even when the view still shows the blockers
    expect(tells(at('keep-open', 2, [done(followKey(merged, 'blocked-tell'), 'tell', { issue: 76 })]))).toEqual([])
    for (const [rollout, blocking] of [['keep-open', 0], ['keep-open', null], ['merge', 2], ['run-it', 2]] as const) expect(tells(at(rollout, blocking))).toEqual([])
  })

  test('O3: a merged issue the Next milestone lists open again moves to Later and tells the owner once per life; guards keep every other open item where it is', () => {
    const merged = rec(543, { state: 'closed', step: null, why: 'merged', pr: 900, seq: 8, seqAt: NOW - 5 * MIN, since: NOW - 5 * MIN })
    const rolloutOf = (rollout: 'merge' | 'run-it' | 'keep-open', status: 'done' | 'running' = 'done') => {
      const e = done(followKey(merged, 'rollout'), 'rollout', { issue: 543, outcome: { kind: 'rollout', rollout, closeIssue: null } })
      return status === 'done' ? e : { ...e, status, endedAt: null, outcome: undefined }
    }
    const reopened = { open: 1, closed: 3, openIssues: [543], expected: null }
    const at = (over: Partial<State> = {}, extra: LedgerEntry[] = [], rollout: LedgerEntry = rolloutOf('merge'), records = [merged]) =>
      withLedger(world(records, { milestone: reopened, ...over }), [transitioned(merged, 'T13', 'merge-queue', 'merged'), rollout, ...extra])
    const moves = (s: State) => plan(s).actions.filter(a => a.key.includes('/reopened/'))
    const first = moves(at())
    expect(first.map(a => `${a.kind} ${a.rule}`)).toEqual(['milestone-later O3', 'tell O3'])
    expect(first[0]).toMatchObject({ issue: 543, key: followKey(merged, 'reopened/milestone-later') })
    expect(first[1]).toMatchObject({ wake: 'reopened', key: followKey(merged, 'reopened/tell'), fields: { issue: '543', pr: '900' } })
    expect(JSON.stringify(first[1])).toContain('issues/543')
    // once only: with both done, neither is planned again
    const both = [done(followKey(merged, 'reopened/milestone-later'), 'milestone-later', { issue: 543 }), done(followKey(merged, 'reopened/tell'), 'tell', { issue: 543 })]
    expect(moves(at({}, both))).toEqual([])
    // a milestone reading without the issue open: O3 starts the release review
    const taskKinds = (s: State) => plan(s).actions.filter(a => a.kind === 'task').map(a => a.rule)
    expect(taskKinds(at({ milestone: { open: 0, closed: 3, openIssues: [], expected: null } }, both))).toEqual(['O3'])
    // guards
    expect(moves(at({}, [], rolloutOf('keep-open')))).toEqual([])
    expect(moves(at({}, [], rolloutOf('run-it')))).toEqual([])
    expect(moves(at({}, [], rolloutOf('merge', 'running')))).toEqual([])
    expect(moves(at({ sources: { ...baseState().sources, milestone: { ok: true, at: NOW - 10 * MIN } } }))).toEqual([])
    expect(moves(at({ sources: { ...baseState().sources, milestone: { ok: false, at: NOW, error: 'x' } } }))).toEqual([])
    expect(moves(at({ milestone: null }))).toEqual([])
    expect(moves(at({ milestone: { ...reopened, openIssues: [544] } }))).toEqual([])
    const live = rec(543, { state: 'queued', step: null, life: merged.life + 1, seq: 1, seqAt: NOW, since: NOW })
    expect(moves(at({}, [], rolloutOf('merge'), [merged, live]))).toEqual([])
  })

  test('a merge is logged as merged once: the factory view at the close decides, so the sweep\'s later `closed` and the view\'s window never log it again; a lost log is logged until done (R3-F1)', () => {
    const r = rec(79, { state: 'closed', step: null, why: 'merged', pr: 779, seq: 9, seqAt: NOW - MIN, since: NOW - MIN })
    const closed = transitioned(r, 'T13', 'merge-queue', 'merged')
    const at = (stageSince: number | null, extra: LedgerEntry[] = []) => withLedger(world([r], { issues: stageSince === null ? [] : [issue(79, { stage: 'merged', stageSince })] }), [closed, ...extra])
    // the close: callum-flow-merge logged merged before it
    expect(kinds(plan(at(NOW - 2 * MIN)), 79)).toEqual(['event transition', 'label clear', 'rollout'])
    // the entry actions done; then the sweep's `closed` (the view's stage time moves past the close),
    // then the view's 24 h window drops the issue: nothing more
    const settled = [done(entryKey(r, 'event/transition'), 'event', { issue: 79 }), done(entryKey(r, 'label'), 'label', { issue: 79 }), done(followKey(r, 'rollout'), 'rollout', { issue: 79, outcome: { kind: 'rollout', rollout: null, closeIssue: null } })]
    expect([kinds(plan(at(NOW, settled)), 79), kinds(plan(at(null, settled)), 79)]).toEqual([[], []])
    // a merge whose log was lost: the close logs it before its transition (the merge came first),
    // so a pass stopped once it started (kill switch, lost act lock, crash) still plans it, and it
    // stays planned until done
    expect(kinds(plan(at(null)), 79)).toEqual(['event merged', 'event transition', 'label clear', 'rollout'])
    const merged = entry(entryKey(r, 'event/merged'), 'event', { issue: 79, status: 'lost', attempts: 1, startedAt: NOW - MIN, endedAt: NOW })
    expect(kinds(plan(at(NOW, [merged])), 79)).toEqual(['event merged', 'event transition', 'label clear', 'rollout'])
    expect(kinds(plan(at(NOW, [...settled, merged])), 79)).toEqual(['event merged'])
  })

  test('a new seq stops the old step that still runs and kills its slot\'s processes, best effort: the step starts once both ended, however they ended', () => {
    const r = rec(80, { seq: 6, seqAt: NOW - MIN, since: NOW - 30 * MIN, attempt: 2 })
    const old = entry(stepKey({ ...r, seq: 5 }, 'build', 1), 'agent-step', { issue: 80, class: 'develop', step: 'build', status: 'running', endedAt: null, agentId: 'agent-9', startedAt: NOW - 50 * MIN })
    const s = withLedger(world([r]), [transitioned(r, 'U2', 'building', 'unknown:timeout'), old])
    const first = plan(s)
    // the unknown is an intervention by the loop, logged once beside the entry actions (v2 SPEC 7.2)
    expect(kinds(first, 80)).toEqual(['event transition', 'stop-agent', 'slot kill', 'event intervention'])
    expect(ivs(first, 80)).toEqual(['loop unknown:timeout'])
    const stop = of(first, 80).find(a => a.kind === 'stop-agent')
    expect(stop).toMatchObject({ agentId: 'agent-9', entry: old.key })
    expect(of(first, 80).find(a => a.kind === 'slot')).toMatchObject({ op: 'kill', path: '/slots/80', maxAttempts: 1 })
    const ended = withLedger(s, [
      done(entryKey(r, 'event/transition'), 'event', { issue: 80 }),
      entry(stop?.key ?? '', 'stop-agent', { issue: 80, status: 'failed', attempts: 1 }),
      done(entryKey(r, 'kill'), 'slot', { issue: 80, maxAttempts: 1 }),
      ivLogged(r),
    ])
    expect(kinds(plan(ended), 80)).toEqual(['slot prepare'])
    // the agent ended once its stop ended: the stop stays done with, and the step starts
    const gone = { ...ended, ledger: ended.ledger.map(e => (e.key === old.key ? { ...e, status: 'lost' as const, endedAt: NOW } : e)) }
    expect(kinds(plan(gone), 80)).toEqual(['slot prepare'])
  })

  test('the old seq\'s steps are found by time, whatever their key: a reviewer keyed by patch and round is stopped when its seq ends, and every old agent is stopped, each once', () => {
    const r = rec(79, { state: 'reviewing', step: 'review', seq: 6, seqAt: NOW - MIN, since: NOW - 60 * MIN, attempt: 2, pr: 579, round: 1 })
    const reviewer = entry(reviewKey(r, 'f00dfeed', 1, 1), 'agent-step', { issue: 79, class: 'drive', step: 'review', status: 'running', endedAt: null, agentId: 'agent-r', startedAt: NOW - 40 * MIN })
    const triage = entry(stepKey({ ...r, seq: 4 }, 'triage', 1), 'agent-step', { issue: 79, class: 'drive', step: 'triage', status: 'running', endedAt: null, agentId: 'agent-t', startedAt: NOW - 50 * MIN })
    // a step of this seq, started after its transition, runs on
    const current = entry(reviewKey(r, 'f00dfeed', 1, 2), 'agent-step', { issue: 79, class: 'drive', step: 'review', status: 'running', endedAt: null, agentId: 'agent-now', startedAt: NOW - MIN / 2 })
    const s = withLedger(world([r]), [transitioned(r, 'U2', 'reviewing', 'unknown:timeout'), reviewer, triage, current])
    const p = plan(s)
    expect(kinds(p, 79)).toEqual(['event transition', 'stop-agent', 'stop-agent', 'slot kill', 'event intervention'])
    expect(ivs(p, 79)).toEqual(['loop unknown:timeout'])
    const stops = of(p, 79).filter((a): a is Extract<Action, { kind: 'stop-agent' }> => a.kind === 'stop-agent')
    expect(stops.map(a => [a.agentId, a.entry]).sort()).toEqual([['agent-r', reviewer.key], ['agent-t', triage.key]])
    expect(new Set(stops.map(a => a.key)).size).toBe(2)
    // one stop ended, the other did not yet: the step waits for both
    const one = withLedger(s, [done(entryKey(r, 'event/transition'), 'event', { issue: 79 }), done(stops[0]?.key ?? '', 'stop-agent', { issue: 79 }), done(entryKey(r, 'kill'), 'slot', { issue: 79, maxAttempts: 1 }), ivLogged(r)])
    expect(kinds(plan(one), 79)).toEqual(['stop-agent'])
  })

  test('a transition lost to a reload after the store took it keeps its row, its from-state and its via: the seq still logs the row\'s transition and the park\'s comment', () => {
    const prev = rec(83, { state: 'designing', step: 'design', seq: 4, seqAt: NOW - 30 * MIN, since: NOW - 30 * MIN })
    const plans = plan(withLedger(world([prev]), [transitioned(prev, 'T1', 'queued'), done(entryKey(prev, 'event/transition'), 'event', { issue: 83 }), done(entryKey(prev, 'label'), 'label', { issue: 83 }), ...designed(prev, BRIEF(83))]))
    const t = transitionOf(plans, 83)
    expect(t).toMatchObject({ row: 'T2', fromState: 'designing', fromStep: 'design' })
    if (t === undefined) return
    // the store took seq 5, then the loop reloaded before the entry was saved done
    const started = start([], t, NOW).entry
    const [lost] = onLoad([started], NOW + MIN)
    expect(lost).toMatchObject({ status: 'lost', outcome: { kind: 'transition', row: 'T2', from: 'designing', step: 'design', via: 'brief', stored: false } })
    const after = plan(withLedger({ ...world([t.next]), now: NOW + MIN }, [lost as LedgerEntry]))
    expect(kinds(after, 83)).toEqual(['event transition', 'label set'])
    expect(of(after, 83)[0]).toMatchObject({ event: { row: 'T2', from: 'designing', via: 'brief' } })
    // a park lost the same way still names what parked it
    const building = rec(84, { seq: 4, seqAt: NOW - 30 * MIN, since: NOW - 30 * MIN, triages: 9 })
    const cannot = stepDone(building, 'build', { event: 'not-ok', reason: 'cannot', data: { text: 'the API is missing' } })
    const parks = transitionOf(plan(withLedger(world([building]), [transitioned(building, 'T5', 'designing'), done(entryKey(building, 'event/transition'), 'event', { issue: 84 }), done(entryKey(building, 'label'), 'label', { issue: 84 }), cannot])), 84)
    expect(parks).toMatchObject({ row: 'T7', next: { state: 'parked' } })
    if (parks === undefined) return
    const [gone] = onLoad([start([], parks, NOW).entry], NOW + MIN)
    const comment = of(plan(withLedger({ ...world([parks.next]), now: NOW + MIN }, [gone as LedgerEntry])), 84).find(a => a.kind === 'comment')
    expect(comment).toMatchObject({ body: expect.stringContaining('It parked from building (cannot)') })
  })

  test('the next transition waits until its seq\'s transition event is logged; an effect that used up its attempts holds the record, and the owner hears once', () => {
    const r = rec(81, { state: 'designing', step: 'design', seq: 4, seqAt: NOW - 30 * MIN, since: NOW - 30 * MIN })
    const unlogged = withLedger(world([r]), [transitioned(r, 'T1', 'queued'), entry(entryKey(r, 'event/transition'), 'event', { issue: 81, status: 'failed', attempts: 1, endedAt: NOW - MIN }), done(entryKey(r, 'label'), 'label', { issue: 81 }), ...designed(r, BRIEF(81))])
    const waits = plan(unlogged)
    expect(transitionOf(waits, 81)).toBeUndefined()
    expect(said(waits, 81)).toContain('T2 waits: the transition event of seq 4 is not logged yet')
    // the label used up its attempts: the record is held, its skip line names the key, the owner hears
    const r2 = rec(82, { state: 'designing', step: 'design', seq: 4, seqAt: NOW - 30 * MIN, since: NOW - 30 * MIN })
    const stalled = withLedger(world([r2]), [
      transitioned(r2, 'T1', 'queued'),
      done(entryKey(r2, 'event/transition'), 'event', { issue: 82 }),
      entry(entryKey(r2, 'label'), 'label', { issue: 82, status: 'failed', attempts: 3, summary: 'gh issue edit: exit 1: HTTP 502' }),
    ])
    const held = plan(stalled)
    expect(said(held, 82)).toContain(`stalled: ${entryKey(r2, 'label')}: gh issue edit: exit 1: HTTP 502`)
    expect(kinds(held, 82)).toEqual(['tell'])
    expect(of(held, 82)[0]).toMatchObject({ wake: 'stalled', class: 'owner' })
    expect(held.owner).toBe(1)
  })
})

// --- the steps (4.2, 4.4, 10.2, S2 to S5) -------------------------------------------------------------------

describe('the steps', () => {
  test('queued: ok once its lease exists, to designing, or to reviewing for an adopted PR; waiting for a slot, told once per 6 hours', () => {
    const r = rec(90, { state: 'queued', step: 'lease' })
    expect(transitionOf(plan(world([r], {}, { leases: [leaseFor(r)] })), 90)).toMatchObject({ row: 'T1', next: { state: 'designing', step: 'design', round: 0, notes: [] } })
    // S0's note on the PRs it left alone is for the step T1 leads to, as a resume's note is
    const adopted = madeRecord({ issue: 90, life: LIFE, branch: 'issue-90', pr: 690, others: [689] }, NOW - 30 * MIN)
    expect(transitionOf(plan(world([adopted], {}, { leases: [leaseFor(r)] })), 90)).toMatchObject({ row: 'T1', next: { state: 'reviewing', step: 'review', round: 1, resumeTo: null, notes: [expect.stringContaining('#689')] } })
    const waits = plan(world([r]))
    expect(transitionOf(waits, 90)).toBeUndefined()
    expect(said(waits, 90)).toEqual(['queued: waits for a slot (W1)'])
    const long = plan(world([{ ...r, since: NOW - 13 * HOUR }]))
    // W1 leases its slot beside the tell (rules-slots.ts, tested in v2-slots.test.ts)
    expect(of(long, 90)).toEqual([expect.objectContaining({ kind: 'tell', wake: 'waiting', fields: { issue: '90', state: 'queued', hours: '13' } }), expect.objectContaining({ kind: 'slot', op: 'lease', rule: 'W1' })])
  })

  test('S2: the slot prepared for the attempt, then the step\'s agent spawned in it with the record\'s notes and the owner\'s; a step that admission holds has no clock', () => {
    const r = rec(91, { state: 'designing', step: 'design', notes: ['use the v2 API'] })
    const s = world([r], { control: control({ notes: [{ issue: 91, text: 'keep it small', at: NOW - 10 * MIN }, { issue: 92, text: 'not this one', at: NOW - 10 * MIN }] }) })
    const prep = of(plan(s), 91)
    expect(prep).toEqual([expect.objectContaining({ kind: 'slot', op: 'prepare', key: prepareKey(r, 1), path: '/slots/91', lease: 'L91', branch: 'issue-91', maxAttempts: 1 })])
    expect((prep[0] as Extract<Action, { kind: 'slot' }>).marker).toMatchObject({ v: 1, issue: 91, life: LIFE, seq: 3, step: 'design', role: 'reader', branch: 'issue-91', pr: null })
    // the companion's notes carry the issue's PR, when it has one
    const withPr = rec(93, { state: 'fixing', step: 'fix', pr: 612 })
    const prepPr = of(plan(world([withPr])), 93).find(a => a.kind === 'slot') as Extract<Action, { kind: 'slot' }> | undefined
    expect(prepPr?.marker).toMatchObject({ issue: 93, pr: 612 })
    const prepared = withLedger(s, [done(prepareKey(r, 1), 'slot', { issue: 91, maxAttempts: 1 })])
    const spawn = of(plan(prepared), 91)
    expect(spawn).toEqual([expect.objectContaining({ kind: 'agent-step', key: stepKey(r, 'design', 1), class: 'develop', rule: 'S2', step: 'design', slot: '/slots/91', notes: ['use the v2 API', 'owner: keep it small'] })])
    // no new work: held, its skip line names the filter, and with no running entry it never times out
    const held = { ...prepared, control: control({ noNewWork: true }), now: NOW + 5 * HOUR }
    const r2 = plan(held)
    expect(of(r2, 91)).toEqual([])
    expect(said(r2, 91)).toEqual(['owner: no new work (agent-step)'])
  })

  test('a running step past its timeout is unknown (timeout) and its transition re-checks the entry as running; within its timeout it runs on', () => {
    const r = rec(93, { state: 'designing', step: 'design' })
    const runningFor = (min: number) => entry(stepKey(r, 'design', 1), 'agent-step', { issue: 93, class: 'develop', step: 'design', status: 'running', endedAt: null, agentId: 'agent-3', startedAt: NOW - min * MIN })
    expect(of(plan(withLedger(world([r]), [runningFor(30)])), 93)).toEqual([])
    const t = transitionOf(plan(withLedger(world([r]), [runningFor(46)])), 93)
    expect(t).toMatchObject({ row: 'U2', event: 'unknown', rule: 'S4', via: 'unknown:timeout', trigger: { kind: 'entry', key: stepKey(r, 'design', 1), status: 'running', startedAt: NOW - 46 * MIN }, next: { attempt: 2 } })
  })

  test('results through the table: a design\'s brief to building, a build that cannot to triage, a step lost to a restart is a free re-run, a refused spawn is unknown', () => {
    const design = rec(94, { state: 'designing', step: 'design' })
    expect(transitionOf(plan(withLedger(world([design]), designed(design, BRIEF(94)))), 94)).toMatchObject({ row: 'T2', next: { state: 'building', brief: BRIEF(94) } })
    const build = rec(95)
    expect(transitionOf(plan(withLedger(world([build]), [stepDone(build, 'build', { event: 'not-ok', reason: 'cannot', data: { text: 'the API is missing' } })])), 95)).toMatchObject({
      row: 'T6',
      next: { state: 'building', step: 'triage', triages: 1, notes: [expect.stringContaining('the API is missing')] },
    })
    const lost = entry(stepKey(build, 'build', 1), 'agent-step', { issue: 95, class: 'develop', step: 'build', status: 'lost', agentId: 'a', startedAt: NOW - 200 * MIN, endedAt: NOW - MIN })
    expect(transitionOf(plan(withLedger(world([build]), [lost])), 95)).toMatchObject({ row: 'U1', cause: 'load', via: 'free:load', next: { attempt: 1, cut: true } })
    const denied = entry(stepKey(build, 'build', 1), 'agent-step', { issue: 95, class: 'develop', step: 'build', status: 'failed', summary: 'factory-loop:builder denied: no step marker', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })
    expect(transitionOf(plan(withLedger(world([build]), [denied])), 95)).toMatchObject({ row: 'U2', cause: null, via: 'unknown:spawn' })
    // a slot that could not be prepared is the attempt's unknown
    const prep = entry(prepareKey(build, 1), 'slot', { issue: 95, status: 'failed', attempts: 1, maxAttempts: 1, summary: 'factory-slot prepare: exit 1' })
    expect(transitionOf(plan(withLedger(world([build]), [prep])), 95)).toMatchObject({ row: 'U2', via: 'unknown:cli' })
    // a lease gone while the step ran is a free re-run too
    const gone = entry(stepKey(build, 'build', 1), 'agent-step', { issue: 95, class: 'develop', step: 'build', status: 'lost', agentId: 'a', startedAt: NOW - 10 * MIN, endedAt: NOW - MIN })
    expect(transitionOf(plan(withLedger(world([build], {}, { leases: [] }), [gone])), 95)).toMatchObject({ row: 'U1', cause: 'slot' })
  })

  test('triage: prepared and spawned as S5, a drive step; its answer moves the record (retry, drop with its abandoned reason)', () => {
    const r = rec(96, { step: 'triage', triages: 1, head: HEAD })
    expect(of(plan(world([r])), 96)).toEqual([expect.objectContaining({ kind: 'slot', op: 'prepare', rule: 'S5' })])
    const prepared = withLedger(world([r]), [done(prepareKey(r, 1), 'slot', { issue: 96, maxAttempts: 1 })])
    expect(of(plan(prepared), 96)).toEqual([expect.objectContaining({ kind: 'agent-step', step: 'triage', class: 'drive', rule: 'S5', key: stepKey(r, 'triage', 1) })])
    const answer = (choice: 'retry' | 'drop', data: Record<string, unknown>) => stepDone(r, 'triage', { event: 'ok', choice, reason: 'flaky tests', data })
    expect(transitionOf(plan(withLedger(world([r]), [answer('retry', { instructions: 'run them in the foreground' })])), 96)).toMatchObject({ row: 'X1', via: 'triage:retry', next: { step: 'build', attempt: 2, notes: ['run them in the foreground'] } })
    expect(transitionOf(plan(withLedger(world([r]), [answer('drop', {})])), 96)).toMatchObject({ row: 'X5', next: { state: 'closed', why: 'dropped', notes: ['triage: flaky tests'] } })
  })

  test('a merge-queue record with no PR goes back to reviewing, which ensures one (T14)', () => {
    const r = plan(world([rec(98, { state: 'merge-queue', step: 'queue' })]))
    expect(transitionOf(r, 98)).toMatchObject({ row: 'T14', next: { state: 'reviewing' } })
  })
})

// --- the owner's and GitHub's events (4.1) ------------------------------------------------------------------

describe('the events, in 4.1\'s order', () => {
  const mq = rec(100, { state: 'merge-queue', step: 'queue', pr: 700, head: HEAD, seq: 9 })
  const pr = (over: Record<string, unknown>) => ({ prs: [{ pr: 700, issue: 100, state: 'open' as const, head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: null, baseRef: 'main', checks: [], patch: null, readAt: NOW, ...over }] })
  const closedRead = { reads: { 100: { at: NOW - MIN, open: false, labels: [] } } }

  test('a hand merge comes before the issue\'s close; a merge the loop made is the queue step\'s own, never a hand merge', () => {
    const merged = world([mq], {}, { prs: pr({ state: 'merged', mergedHead: HEAD }), ...closedRead })
    expect(transitionOf(plan(merged), 100)).toMatchObject({ row: 'E3', event: 'pr-merged', next: { state: 'closed', why: 'merged-by-hand' } })
    const outcome = (merged: boolean) => ({ kind: 'queue' as const, op: 'merge' as const, merged, head: HEAD, failClass: merged ? null : ('checks' as const), lines: [] })
    const ours = withLedger(merged, [done(`${lifeKey(mq)}/queue/merge/${HEAD.slice(0, 7)}`, 'queue-merge', { issue: 100, head: HEAD, outcome: outcome(true) })])
    expect(transitionOf(plan(ours), 100)).toMatchObject({ row: 'T13', event: 'ok', next: { state: 'closed', why: 'merged' } })
    // a try the guard refused (done, not merged) is not the loop's merge: GitHub's merge after it was by hand
    const refused = withLedger(merged, [done(`${lifeKey(mq)}/queue/merge/${HEAD.slice(0, 7)}`, 'queue-merge', { issue: 100, head: HEAD, outcome: outcome(false) })])
    expect(transitionOf(plan(refused), 100)).toMatchObject({ row: 'E3', event: 'pr-merged' })
    // closed with no merge: the issue's close
    expect(transitionOf(plan(world([mq], {}, closedRead)), 100)).toMatchObject({ row: 'E2', next: { why: 'closed-on-github' } })
  })

  test('a drop applies to the life it names; pr-closed is an edge on GitHub\'s closedAt; a re-claim that exits 3 is claim-lost', () => {
    // (its PR not read for a rate limit, so the head's step holds with no clock)
    const unread = { prs: { prs: [], cut: 'GitHub rate limit: no PR is read this pass' } }
    expect(transitionOf(plan(world([mq], { control: control({ dropped: [{ issue: 100, at: NOW - 3 * HOUR }] }) }, unread)), 100)).toBeUndefined()
    expect(transitionOf(plan(world([mq], { control: control({ dropped: [{ issue: 100, at: NOW - MIN }] }) })), 100)).toMatchObject({ row: 'E1', next: { why: 'dropped' } })
    const closedAt = '2026-10-13T02:50:00Z'
    expect(transitionOf(plan(world([mq], {}, { prs: pr({ state: 'closed', closedAt }) })), 100)).toMatchObject({ row: 'E4', next: { state: 'parked', resumeTo: 'merge-queue', prClosedAt: closedAt } })
    expect(transitionOf(plan(world([{ ...mq, prClosedAt: closedAt }], {}, { prs: pr({ state: 'closed', closedAt }) })), 100)).toBeUndefined()
    // a PR read newer than the issue's read: E4 waits for the issue's read, which may show it closed too (E2 first)
    const late = { prs: pr({ state: 'closed', closedAt }), changed: { 100: Date.parse(closedAt) }, reads: { 100: { at: Date.parse(closedAt) - MIN, open: true, labels: [] } } }
    expect(transitionOf(plan(world([mq], {}, late)), 100)).toBeUndefined()
    expect(said(plan(world([mq], {}, late)), 100)).toEqual(['E4 waits: issue #100 is not read since PR #700 closed'])
    expect(transitionOf(plan(world([mq], {}, { ...late, reads: { 100: { at: NOW, open: true, labels: [] } } })), 100)).toMatchObject({ row: 'E4' })
    const lost = done(reclaimKey(mq, lifeOf(NOW - 5 * MIN)), 'claim', { issue: 100, outcome: { kind: 'claim', result: 'lost' }, summary: 'lost #100: held by other' })
    expect(transitionOf(plan(withLedger(world([mq]), [lost])), 100)).toMatchObject({ row: 'E5', next: { why: 'claim-lost' }, trigger: { kind: 'entry', key: lost.key } })
  })

  test('E7: an event with no meaning is logged and changes nothing, and never stops the next event', () => {
    const parked = rec(101, { state: 'parked', step: null, question: 'q', resumeTo: 'reviewing', pr: 701, since: NOW - HOUR, seqAt: NOW - HOUR })
    const s = world([parked], { control: control({ resumed: [{ subject: 'issue:101', at: NOW - MIN, note: 'merge main first' }] }) }, { prs: { prs: [{ pr: 701, issue: 101, state: 'closed', head: HEAD, mergedHead: null, closedAt: '2026-10-13T02:30:00Z', mergeable: null, author: 'cbundy', checks: [], patch: null, readAt: NOW }] } })
    const r = plan(s)
    expect(said(r, 101)).toContain('E7: pr-closed means nothing in parked')
    expect(transitionOf(r, 101)).toMatchObject({ row: 'P1', next: { state: 'queued', resumeTo: 'reviewing', notes: ['merge main first'], prClosedAt: '2026-10-13T02:30:00Z' } })
  })
})

// --- parked and resumed (11) -----------------------------------------------------------------------------------

describe('parked and resumed (v2 SPEC 11)', () => {
  const parkAt = NOW - 2 * HOUR
  const p = rec(110, { state: 'parked', step: null, question: 'which API?', resumeTo: 'designing', triages: 2, fixes: 1, attempt: 2, seq: 6, seqAt: parkAt, since: parkAt })
  const settledPark = [
    transitioned(p, 'T3', 'designing'),
    done(entryKey(p, 'event/transition'), 'event', { issue: 110 }),
    done(entryKey(p, 'label'), 'label', { issue: 110, endedAt: parkAt + MIN }),
    done(entryKey(p, 'comment'), 'comment', { issue: 110, endedAt: parkAt + 2 * MIN }),
    done(entryKey(p, 'tell'), 'tell', { issue: 110, class: 'owner', wake: 'parked' }),
  ]

  test('/factory resume N "note" unparks it to queued, its budgets reset and the note for its step; an older resume does not', () => {
    const r = plan(withLedger(world([p], { control: control({ resumed: [{ subject: 'issue:110', at: NOW - MIN, note: 'use the v2 API' }] }) }), settledPark))
    expect(transitionOf(r, 110)).toMatchObject({ row: 'P1', rule: 'S6', via: 'unpark:op', next: { state: 'queued', step: 'lease', resumeTo: 'designing', attempt: 1, triages: 0, fixes: 0, notes: ['use the v2 API'], question: null } })
    const old = plan(withLedger(world([p], { control: control({ resumed: [{ subject: 'issue:110', at: parkAt - MIN }] }) }), settledPark))
    expect(transitionOf(old, 110)).toBeUndefined()
    expect(said(old, 110)).toEqual(['parked: waits on the owner'])
  })

  test('the label off: a read after the park\'s label write that lacks it unparks, with the trusted comments since the park as the note; an older read does not; unread comments wait', () => {
    const lacks = (at: number) => ({ reads: { 110: { at, open: true, labels: ['enhancement'] } } })
    const comments = {
      comments: {
        110: [
          { body: 'an answer before the park', at: parkAt - MIN, url: null },
          { body: `The factory loop parked this issue\n\n${hiddenKey(entryKey(p, 'comment'))}`, at: parkAt + 2 * MIN, url: null },
          { body: 'Use the v2 API.', at: NOW - 10 * MIN, url: null },
        ],
      },
    }
    const r = plan(withLedger(world([p], {}, { ...lacks(NOW - 5 * MIN), ...comments }), settledPark))
    expect(transitionOf(r, 110)).toMatchObject({ row: 'P1', via: 'unpark:label', next: { state: 'queued', notes: ['Use the v2 API.'] } })
    // a read from before the label was written is stale: nothing
    expect(transitionOf(plan(withLedger(world([p], {}, { ...lacks(parkAt + 30_000), ...comments }), settledPark)), 110)).toBeUndefined()
    const unread = plan(withLedger(world([p], {}, lacks(NOW - 5 * MIN)), settledPark))
    expect(transitionOf(unread, 110)).toBeUndefined()
    expect(said(unread, 110)).toEqual(['unpark: the label is off; waits for the trusted comments to be read'])
  })

  test('the label off reads the owner\'s tick in this seq\'s park comment: one tick is the note\'s first line, several or an unknown one choose nothing, none and an older seq\'s park comment change nothing', () => {
    const lacks = { reads: { 110: { at: NOW - 5 * MIN, open: true, labels: ['enhancement'] } } }
    const park = (ticks: string[], q = p) => {
      const options = ['A', 'B'].map(k => `- [${ticks.includes(k) ? (k === 'B' ? 'X' : 'x') : ' '}] **${k}** - option ${k}`).join('\n')
      return { body: `### Waiting on the owner\n\n**Decision needed:** which?\n\n#### Options\n\n${options}\n\n#### How to resume\n\n${hiddenKey(entryKey(q, 'comment'))}`, at: parkAt + 2 * MIN, url: null }
    }
    const answer = { body: 'Go with it.', at: NOW - 10 * MIN, url: null }
    const noteOf = (comments: { body: string; at: number; url: string | null }[]) => {
      const t = transitionOf(plan(withLedger(world([p], {}, { ...lacks, comments: { 110: comments } }), settledPark)), 110)
      return (t?.next as IssueRecord | undefined)?.notes
    }
    expect(noteOf([park(['A']), answer])).toEqual(['Owner chose option A: option A Go with it.'])
    expect(noteOf([park(['B'])])).toEqual(['Owner chose option B: option B'])
    expect(noteOf([park(['A', 'B']), answer])).toEqual(['Owner ticked 2 options, so none is chosen: A: option A; B: option B Go with it.'])
    expect(noteOf([park([]), answer])).toEqual(['Go with it.'])
    // the park comment of an earlier seq is not this park's
    expect(noteOf([park(['A'], { ...p, seq: p.seq - 1 }), answer])).toEqual(['Go with it.'])
    // a comment of the owner quoting the template is no park comment
    expect(noteOf([{ body: '- [x] **A** - option A', at: NOW - 20 * MIN, url: null }, answer])).toEqual(['- [x] **A** - option A Go with it.'])
  })

  test('a designer\'s question with options, stored by T3 and worded by parkText, is a park comment whose tick the label-off unpark reads back (#856)', () => {
    const designing = rec(110, { state: 'designing', step: 'design', seq: 5 })
    const asked = renderQuestion({ question: 'Which API?', context: 'Two shapes exist.', options: [{ key: 'A', title: 'v1', detail: 'old' }, { key: 'B', title: 'v2' }], recommendation: { key: 'B', reason: 'newer' } })
    const event = { kind: 'not-ok' as const, reason: 'question', data: { question: asked } }
    const parked = { ...(nextRecord(designing, rowFor(designing, event, config()), event, NOW) as IssueRecord), seq: p.seq, seqAt: parkAt, since: parkAt }
    expect(parked).toMatchObject({ state: 'parked', question: asked })
    const body = parkText(parked, 'designing', 'question')
    for (const line of ['#### Context', '#### Options', '#### Recommendation', '- [ ] **A** - v1', '- [ ] **B** - v2', 'Tick one option, or write your answer as a comment.']) expect(body).toMatch(new RegExp(`^(\\d+\\. )?${line.replace(/[*[\]]/g, '\\$&')}`, 'm'))
    const comment = { body: `${body.replace('- [ ] **B**', '- [x] **B**')}\n\n${hiddenKey(entryKey(p, 'comment'))}`, at: parkAt + 2 * MIN, url: null }
    const r = plan(withLedger(world([p], {}, { reads: { 110: { at: NOW - 5 * MIN, open: true, labels: ['enhancement'] } }, comments: { 110: [comment] } }), settledPark))
    expect(((transitionOf(r, 110)?.next) as IssueRecord).notes[0]).toMatch(/^Owner chose option B: /)
  })

  test('the resume note reaches the step the resume leads to: P1 puts it on queued, T1 carries it into designing, fixing or reviewing, and that step\'s prompt says it (R5-F2)', async () => {
    const note = 'The earlier drill note no longer applies: review the PR on its merits.'
    const PATCH = 'f00dfeed00000000000000000000000000000001'
    for (const [n, to] of [[120, 'designing'], [121, 'fixing'], [122, 'reviewing']] as const) {
      const pr = to === 'designing' ? null : 700 + n
      const parked = rec(n, { state: 'parked', step: null, question: 'which API?', resumeTo: to, pr, head: pr === null ? null : HEAD, fixes: 3, seq: 6, seqAt: parkAt, since: parkAt })
      const resumed = control({ resumed: [{ subject: `issue:${n}`, at: NOW - MIN, note }] })
      const queued = transitionOf(plan(world([parked], { control: resumed })), n)?.next as IssueRecord
      expect(queued).toMatchObject({ state: 'queued', notes: [note] })
      const t1 = transitionOf(plan(world([queued], {}, { leases: [leaseFor(queued)] })), n)
      expect(t1).toMatchObject({ row: 'T1', next: { state: to, notes: [note] } })
      // stored a few minutes ago: the step runs in its prepared slot; a review once its PR is
      // ensured and read since
      const entered = { ...(t1?.next as IssueRecord), seqAt: NOW - 5 * MIN, since: NOW - 5 * MIN }
      const view = { pr: pr ?? 0, issue: n, state: 'open' as const, head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: null, baseRef: 'main', checks: [], patch: PATCH, readAt: NOW - MIN }
      const ready = [done(prepareKey(entered, 1), 'slot', { issue: n, maxAttempts: 1 }), done(prKey(entered, 'ensure'), 'pr', { issue: n, outcome: { kind: 'pr', pr: pr ?? 0, created: false, reopened: false } })]
      const s = withLedger(world([entered], {}, { prs: { prs: pr === null ? [] : [view] } }), ready)
      const step = of(plan(s), n).find((a): a is Extract<Action, { kind: 'agent-step' }> => a.kind === 'agent-step')
      expect(step?.notes).toEqual([note])
      const w = actWorld([entered])
      await w.run(step as Action, s)
      expect(w.spawns).toHaveLength(1)
      expect(w.spawns[0]?.prompt).toContain(note)
    }
  })

  test('a parked record is reminded once a day, an owner item counted once; its own question rides along', () => {
    const r = plan(withLedger(world([{ ...p, since: NOW - 50 * HOUR, seqAt: NOW - 50 * HOUR }]), []))
    expect(of(r, 110)).toEqual([expect.objectContaining({ kind: 'tell', wake: 'parked', rule: 'S6', fields: { issue: '110', from: 'designing', days: '2' }, context: [expect.stringContaining('which API?'), expect.any(String)] })])
    expect(r.owner).toBe(1)
  })
})

describe('waiting (v2 SPEC 3.1, 4.3, 4.4, 11)', () => {
  const waitAt = NOW - 2 * HOUR
  const WAIT = [
    { kind: 'issue-closed' as const, issue: 57 },
    { kind: 'pr-merged' as const, pr: 812 },
  ]
  const w = rec(130, { state: 'waiting', step: null, wait: WAIT, resumeTo: 'designing', notes: ['needs #57 and PR #812'], seq: 6, seqAt: waitAt, since: waitAt })
  const settled = (r: IssueRecord) => [
    transitioned(r, 'T16', 'designing', 'wait'),
    done(entryKey(r, 'event/transition'), 'event', { issue: r.issue }),
    done(entryKey(r, 'label'), 'label', { issue: r.issue, endedAt: waitAt + MIN }),
    done(entryKey(r, 'comment'), 'comment', { issue: r.issue, endedAt: waitAt + 2 * MIN }),
    ...(r.wait ?? []).flatMap(c => (c.kind === 'issue-closed' ? [done(entryKey(r, `link/${c.issue}`), 'link', { issue: r.issue })] : [])),
  ]
  const held = (...keys: string[]) => ({ waits: Object.fromEntries(keys.map(k => [k, { at: NOW - MIN, held: true }])) })

  test('T16: an issue condition on another repo adds no blocked_by link; one without repo still links', () => {
    const wait = [
      { kind: 'issue-closed' as const, issue: 57, repo: 'cbundy/other' },
      { kind: 'issue-closed' as const, issue: 58 },
    ]
    const entered = rec(133, { state: 'waiting', step: null, wait, resumeTo: 'designing', notes: ['x'], seq: 6, seqAt: waitAt, since: waitAt })
    const r = plan(withLedger(world([entered]), [transitioned(entered, 'T16', 'designing', 'wait')]))
    expect(of(r, 133).filter(a => a.kind === 'link')).toEqual([expect.objectContaining({ kind: 'link', blocker: 58, key: entryKey(entered, 'link/58') })])
  })

  test('another repo\'s conditions: the texts name the repo, the cleared note names each repo\'s tag, and the own repo\'s texts do not change', () => {
    const wait = [
      { kind: 'issue-closed' as const, issue: 57, repo: 'o/n' },
      { kind: 'tag-contains' as const, sha: '35bb655', repo: 'o/n' },
      { kind: 'tag-contains' as const, sha: '35bb655' },
    ]
    const f = rec(134, { state: 'waiting', step: null, wait, resumeTo: 'designing', notes: ['x'], seq: 6, seqAt: waitAt, since: waitAt })
    const s = (v2: Partial<V2State>) => plan(withLedger(world([f], {}, v2), settled(f)))
    const all = { waits: { 'issue:o/n#57': { at: NOW - MIN, held: true }, 'tag:o/n@35bb655': { at: NOW - MIN, held: true, tag: 'v1.2.0' }, 'tag:35bb655': { at: NOW - MIN, held: true, tag: 'v0.51.0' } } }
    expect(transitionOf(s(all), 134)).toMatchObject({ row: 'C1', next: { notes: ['The loop resumed this: o/n#57 closed, release v1.2.0 of o/n contains 35bb655, release v0.51.0 contains 35bb655; every condition holds.'] } })
    expect(said(s({}), 134)).toEqual(['waiting: for o/n#57 (still open), no release tag of o/n contains 35bb655 yet, no release tag contains 35bb655 yet'])
    const entered = rec(134, { state: 'waiting', step: null, wait, resumeTo: 'designing', notes: ['x'], seq: 6, seqAt: waitAt, since: waitAt })
    const r = plan(withLedger(world([entered]), [transitioned(entered, 'T16', 'designing', 'wait')]))
    const comment = of(r, 134).find((a): a is Extract<Action, { kind: 'comment' }> => a.kind === 'comment')
    expect(comment?.body).toContain('issue o/n#57 must be closed on GitHub')
    expect(comment?.body).toContain('release tag of o/n must contain commit 35bb655')
    expect(comment?.body).toContain('release tag must contain commit 35bb655')
    expect(of(r, 134).filter(a => a.kind === 'link')).toEqual([])
  })

  test('T16: a designer that answers wait enters waiting at once, with its conditions, no owner tell; its entry posts one comment, links each issue condition and labels factory:waiting', () => {
    const d = rec(131, { state: 'designing', step: 'design', seq: 5, seqAt: NOW - 5 * MIN, since: NOW - 5 * MIN })
    const answer = { kind: 'wait', brief: null, question: null, conditions: WAIT, reason: 'needs #57 and PR #812', reasons: null, children: [] }
    const t = transitionOf(plan(withLedger(world([d]), [stepDone(d, 'design', { event: 'not-ok', reason: 'wait', data: { ...answer, text: answer.reason } })])), 131)
    expect(t).toMatchObject({ row: 'T16', rule: 'S3', via: 'wait', next: { state: 'waiting', step: null, resumeTo: 'designing', wait: WAIT, notes: ['needs #57 and PR #812'], question: null } })
    const entered = t?.next as IssueRecord
    const r = plan(withLedger(world([entered]), [transitioned(entered, 'T16', 'designing', 'wait')]))
    expect(kinds(r, 131)).toEqual(['event transition', 'label set', 'comment', 'link'])
    expect(of(r, 131).find(a => a.kind === 'label')).toMatchObject({ op: 'set', label: 'factory:waiting' })
    const comment = of(r, 131).find((a): a is Extract<Action, { kind: 'comment' }> => a.kind === 'comment')
    expect(comment).toMatchObject({ on: 'issue', number: 131, key: entryKey(entered, 'comment') })
    // the conditions and the reason are listed, the loop says it resumes by itself, and there is no tick and no ask
    expect(comment?.body).toContain('issue #57 must be closed on GitHub')
    expect(comment?.body).toContain('PR #812 must be merged on GitHub')
    expect(comment?.body).toContain('needs #57 and PR #812')
    expect(comment?.body).toContain('resumes this issue when it holds')
    expect(comment?.body).not.toMatch(/\[ \]|\[x\]|resume 131|Decision needed/)
    // one link per issue condition (a PR condition is no link), keyed per condition; no tell, no owner item
    expect(of(r, 131).filter(a => a.kind === 'link')).toEqual([expect.objectContaining({ kind: 'link', blocker: 57, key: entryKey(entered, 'link/57'), issue: 131 })])
    expect(of(r, 131).some(a => a.kind === 'tell')).toBe(false)
    expect(r.owner).toBe(0)
    expect(ivs(r, 131)).toEqual([])
    // it holds no slot: nothing is leased or prepared for it, and it says why it waits
    expect(of(r, 131).some(a => a.kind === 'slot' || a.kind === 'agent-step')).toBe(false)
  })

  test('the link executor: a blocked_by link from the waiting issue to the open blocker, once; a closed blocker and a pull request are skipped; a failed read is a failed attempt', async () => {
    const link: Action = { kind: 'link', key: entryKey(w, 'link/57'), class: 'free', rule: 'S3', reason: 'x', issue: 130, blocker: 57 }
    const read = (state: string, pull = false, held: string = '') => (argv: string[]): Reply => {
      if (argv[0] === 'callum-flow-issue-read') return { stdout: JSON.stringify({ issue: { number: 57, id: 9057, state, ...(pull ? { pull_request: {} } : {}) } }) }
      if (argv.includes('--paginate')) return { stdout: held }
      return {}
    }
    const open = actWorld([w], read('open'))
    expect(await open.run(link)).toMatchObject({ status: 'done', summary: 'linked #130 as blocked by #57' })
    expect(open.argvs).toEqual([
      ['callum-flow-issue-read', '--json', '57'],
      ['gh', 'api', `repos/${REPO}/issues/130/dependencies/blocked_by`, '--paginate', '--jq', '.[].id'],
      ['gh', 'api', '--method', 'POST', `repos/${REPO}/issues/130/dependencies/blocked_by`, '-F', 'issue_id=9057'],
    ])
    // already linked: no second POST
    const again = actWorld([w], read('open', false, '9057\n'))
    expect(await again.run(link)).toMatchObject({ status: 'done', summary: 'found linked #130 as blocked by #57' })
    expect(again.argvs.some(a => a.includes('POST'))).toBe(false)
    // a closed blocker has nothing to wait for; a pull request cannot block
    const closed = actWorld([w], read('closed'))
    expect(await closed.run(link)).toMatchObject({ status: 'done', summary: '#57 is closed, not linked' })
    expect(closed.argvs).toHaveLength(1)
    const pull = actWorld([w], read('open', true))
    expect(await pull.run(link)).toMatchObject({ status: 'done', summary: '#57 is a pull request, not linked' })
    expect(pull.argvs).toHaveLength(1)
    const bad = actWorld([w], () => ({ exitCode: 1, stderr: 'boom' }))
    expect(await bad.run(link)).toMatchObject({ status: 'failed' })
  })

  test('C1: every condition held takes the record to queued with the cleared note; one open, a failed or an unread condition takes nothing, and the skip line names what is open', () => {
    const s = (v2: Partial<V2State>) => plan(withLedger(world([w], {}, v2), settled(w)))
    const both = transitionOf(s(held('issue:57', 'pr:812')), 130)
    expect(both).toMatchObject({ row: 'C1', rule: 'S6', via: 'cleared', next: { state: 'queued', step: 'lease', resumeTo: 'designing', attempt: 1, triages: 0, cut: false, wait: null, notes: ['The loop resumed this: #57 closed, PR #812 merged; every condition holds.'] } })
    expect(both?.trigger).toEqual({ kind: 'fact', fact: `cleared:130@${w.seq}` })
    for (const v2 of [held('issue:57'), held('pr:812'), {}, { waits: { 'issue:57': { at: NOW - MIN, held: true }, 'pr:812': { at: NOW - MIN, held: false } } }]) {
      const r = s(v2)
      expect(transitionOf(r, 130)).toBeUndefined()
      expect(said(r, 130)).toHaveLength(1)
    }
    expect(said(s(held('issue:57')), 130)).toEqual(['waiting: for PR #812 (not merged yet)'])
    expect(said(s({}), 130)).toEqual(['waiting: for #57 (still open), PR #812 (not merged yet)'])
    // the cleared note is the resumed designer's: it reaches the step T1 leads to
    const queued = both?.next as IssueRecord
    expect(transitionOf(plan(world([queued], {}, { leases: [leaseFor(queued)] })), 130)).toMatchObject({ row: 'T1', next: { state: 'designing', notes: ['The loop resumed this: #57 closed, PR #812 merged; every condition holds.'] } })
  })

  test('a removed factory:waiting label is not a resume; the owner\'s /factory resume N "note" is, and /factory drop N closes the record', () => {
    const lacks = { reads: { 130: { at: NOW - 5 * MIN, open: true, labels: ['enhancement'] } }, comments: { 130: [{ body: 'ok go', at: NOW - 10 * MIN, url: null }] } }
    const label = plan(withLedger(world([w], {}, lacks), settled(w)))
    expect(transitionOf(label, 130)).toBeUndefined()
    const resumed = plan(withLedger(world([w], { control: control({ resumed: [{ subject: 'issue:130', at: NOW - MIN, note: 'go on without it' }] }) }), settled(w)))
    expect(transitionOf(resumed, 130)).toMatchObject({ row: 'P1', via: 'unpark:op', next: { state: 'queued', resumeTo: 'designing', wait: null, notes: ['go on without it'] } })
    // a resume from before the wait began does not count
    expect(transitionOf(plan(withLedger(world([w], { control: control({ resumed: [{ subject: 'issue:130', at: waitAt - MIN }] }) }), settled(w))), 130)).toBeUndefined()
    const dropped = plan(withLedger(world([w], { control: control({ dropped: [{ issue: 130, at: NOW - MIN }] }) }), settled(w)))
    expect(transitionOf(dropped, 130)).toMatchObject({ row: 'E1', next: { state: 'closed', why: 'dropped', wait: null } })
  })

  test('E2, E3 and E4 cover waiting as any live state: the issue closed by hand closes it, a merged or closed PR of its life does as for the others', () => {
    const closedByHand = plan(withLedger(world([w], {}, { reads: { 130: { at: NOW - MIN, open: false, labels: [] } } }), settled(w)))
    expect(transitionOf(closedByHand, 130)).toMatchObject({ row: 'E2', next: { state: 'closed', why: 'closed-on-github' } })
    const withPr = { ...w, pr: 900 }
    const view = (state: 'merged' | 'closed') => ({ pr: 900, issue: 130, state, head: HEAD, mergedHead: HEAD, closedAt: '2026-10-15T10:00:00Z', mergeable: null, author: 'cbundy', base: null, baseRef: 'main', checks: [], patch: null, readAt: NOW - MIN })
    expect(transitionOf(plan(withLedger(world([withPr], {}, { prs: { prs: [view('merged')] } }), settled(withPr))), 130)).toMatchObject({ row: 'E3', next: { state: 'closed', why: 'merged-by-hand' } })
    const parked = transitionOf(plan(withLedger(world([withPr], {}, { prs: { prs: [view('closed')] }, reads: { 130: { at: NOW, open: true, labels: ['factory:waiting'] } } }), settled(withPr))), 130)
    expect(parked).toMatchObject({ row: 'E4', next: { state: 'parked', resumeTo: 'designing', wait: null, question: expect.stringContaining('PR #900') } })
  })

  test('E6: after 24 hours (stateTimeoutMs.waiting) it tells the owner what is still open, once per period, and not as an owner item; sooner it says nothing', () => {
    const at = (hours: number) => ({ ...w, since: NOW - hours * HOUR, seqAt: NOW - hours * HOUR })
    const sooner = plan(withLedger(world([at(23)]), settled(w)))
    expect(of(sooner, 130).some(a => a.kind === 'tell')).toBe(false)
    const day = plan(withLedger(world([at(26)], {}, held('issue:57')), settled(w)))
    expect(of(day, 130).filter(a => a.kind === 'tell')).toEqual([
      expect.objectContaining({ kind: 'tell', wake: 'waiting', rule: 'S6', fields: { issue: '130', state: 'waiting', hours: '26' }, context: ['waiting for PR #812 (not merged yet)'] }),
    ])
    expect(day.owner).toBe(0)
    // a second period is a second tell; the same period is told once
    const tells = (hours: number) => of(plan(withLedger(world([at(hours)]), settled(w))), 130).flatMap(a => (a.kind === 'tell' ? [a.key] : []))
    expect(new Set([...tells(26), ...tells(50)]).size).toBe(2)
    expect(tells(26)).toEqual(tells(30))
    // the period is a setting
    const short = plan(withLedger(world([at(2)]), settled(w)), { ...CFG, stateTimeoutMs: { ...CFG.stateTimeoutMs, waiting: HOUR } })
    expect(of(short, 130).some(a => a.kind === 'tell' && a.wake === 'waiting')).toBe(true)
  })

  describe('a condition the loop cannot read (wait-unreadable)', () => {
    const at = (hours: number, over: Partial<IssueRecord> = {}) => ({ ...w, ...over, since: NOW - hours * HOUR, seqAt: NOW - hours * HOUR })
    const unread = (key: string, hours: number, why: 'read-failed' | 'no-release') => ({ waitsUnread: { [key]: { since: NOW - hours * HOUR, why } } })
    const run = (r: IssueRecord, extra: object) => plan(withLedger(world([r], {}, extra), settled(w)))
    const tells = (p: PlanResult) => of(p, 130).filter(a => a.kind === 'tell')

    test('a PR condition unread a whole period: one owner tell with the reason, no tell(waiting); the record stays waiting', () => {
      const p = run(at(26), { ...held('issue:57'), ...unread('pr:812', 26, 'read-failed') })
      expect(tells(p)).toEqual([
        expect.objectContaining({
          wake: 'wait-unreadable',
          rule: 'S6',
          key: `${entryKey(at(26), 'tell')}/wait-unreadable/1`,
          fields: { issue: '130', hours: '26', conditions: 'pr:812' },
          context: [`pr:812: its read has failed since ${new Date(NOW - 26 * HOUR).toISOString()}`],
        }),
      ])
      expect(p.owner).toBe(1)
      expect(of(p, 130).some(a => a.kind === 'transition')).toBe(false)
    })

    test('a tag condition on a repo with no release (plant-console#209): the same, naming the repo', () => {
      const wait = [{ kind: 'tag-contains' as const, sha: '35bb655', repo: 'o/n' }]
      const p = run(at(26, { wait }), unread('tag:o/n@35bb655', 26, 'no-release'))
      expect(tells(p)).toEqual([expect.objectContaining({ wake: 'wait-unreadable', fields: expect.objectContaining({ conditions: 'tag:o/n@35bb655' }), context: [expect.stringContaining('no release tag of o/n is known since')] })])
      expect(p.owner).toBe(1)
    })

    test('unread for less than the period gives the plain tell(waiting), owner 0; a read condition does too', () => {
      const p = run(at(26), { ...held('issue:57'), ...unread('pr:812', 10, 'read-failed') })
      expect(tells(p)).toEqual([expect.objectContaining({ wake: 'waiting', context: ['waiting for PR #812 (not merged yet) (unread: read failing)'] })])
      expect(p.owner).toBe(0)
      const read = run(at(26), held('issue:57'))
      expect(tells(read)).toEqual([expect.objectContaining({ wake: 'waiting' })])
      expect(read.owner).toBe(0)
    })

    test('the next period is a new tell; the skip line says why the condition is still open; a held read still clears', () => {
      const keys = (h: number) => tells(run(at(h), unread('pr:812', h, 'no-release'))).map(a => a.key)
      expect(new Set([...keys(26), ...keys(50)]).size).toBe(2)
      expect(keys(26)).toEqual(keys(30))
      const p = run(at(1), unread('pr:812', 1, 'no-release'))
      expect(JSON.stringify(p.skipped)).toContain('PR #812 (not merged yet) (unread: no release)')
      const cleared = run(at(26), { ...held('issue:57', 'pr:812'), ...unread('pr:812', 26, 'read-failed') })
      expect(of(cleared, 130).some(a => a.kind === 'transition')).toBe(true)
      expect(tells(cleared)).toEqual([])
    })
  })
})

// --- H1: the heartbeat and re-claims (4.1) -----------------------------------------------------------------------

describe('H1: claims renewed and claimed again', () => {
  test('the records\' claims are renewed when a lease is due and on the first pass after a load; a closed record\'s never', () => {
    const live = rec(120)
    const beat = (at: number) => entry('heartbeat:0', 'heartbeat', { startedAt: at, endedAt: at })
    const base = (at: number, records: IssueRecord[]) => ({ ...world(records), ledger: [beat(at)] })
    expect(plan(base(NOW - 5 * MIN, [live])).actions.some(a => a.kind === 'heartbeat')).toBe(false)
    expect(plan(base(NOW - 25 * MIN, [live])).actions.find(a => a.kind === 'heartbeat')).toMatchObject({ rule: 'H1', reason: 'lease renewal due', class: 'free' })
    expect(plan(base(NOW - 200 * MIN, [live])).actions.find(a => a.kind === 'heartbeat')).toMatchObject({ reason: 'first pass after load' })
    expect(plan(base(NOW - 200 * MIN, [rec(121, { state: 'closed', step: null, why: 'merged' })])).actions.some(a => a.kind === 'heartbeat')).toBe(false)
  })

  test('a lapsed claim is claimed again onto its record: a `reclaimed` event after its claim, the factory showing this device\'s claim lapsed, or another device showing as holder; the re-claim logs its transition again; none while one runs', () => {
    const r = rec(122)
    const claimed = done(claimKey(122, LIFE), 'claim', { issue: 122, startedAt: NOW - 40 * MIN, endedAt: NOW - 40 * MIN, outcome: { kind: 'adopt', branch: 'issue-122', pr: null, others: [] } })
    const at = (view: Parameters<typeof issue>[1], queue: number[] = []) => plan(withLedger(world([r], { queue, issues: [issue(122, { stage: 'designing', holder: DEVICE, labels: ['enhancement'], ...view })] }), [claimed]))
    const claims = (p: PlanResult) => p.actions.filter(a => a.kind === 'claim')
    expect(claims(at({ reclaimedAt: NOW - 5 * MIN }))).toEqual([expect.objectContaining({ issue: 122, rule: 'H1', class: 'free', reason: 'its claim lapsed: the sweep gave it back (reclaimed)' })])
    expect(claims(at({ claimLapsedAt: NOW - 5 * MIN, stage: 'queued' }))).toEqual([expect.objectContaining({ issue: 122, rule: 'H1', reason: 'its claim lapsed: the factory shows its lease ended' })])
    // the label list lags behind edits: the issue listed ready just after its claim is no lapse
    expect(claims(at({ labels: ['enhancement', 'ready'] }, [122]))).toEqual([])
    // facts from before the last claim are no lapse: a re-claim is not made twice
    expect(claims(at({ reclaimedAt: NOW - 50 * MIN, claimLapsedAt: NOW - 45 * MIN }))).toEqual([])
    // another device's claim lapsing says nothing of this one
    expect(claims(at({ claimLapsedAt: NOW - 5 * MIN, holder: OTHER }, []))).toEqual([expect.objectContaining({ reason: `the factory shows ${OTHER} holding it` })])
    const other = plan(withLedger(world([r], { issues: [issue(122, { holder: OTHER, stage: 'designing', labels: ['enhancement'] })] }), [claimed]))
    expect(other.actions.find(a => a.kind === 'claim')).toMatchObject({ issue: 122, rule: 'H1' })
    const again = done(reclaimKey(r, lifeOf(NOW - 2 * MIN)), 'claim', { issue: 122, startedAt: NOW - 2 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'claim', result: 'claimed' } })
    const logged = plan(withLedger(world([r], { issues: [issue(122, { holder: OTHER, stage: 'designing', reclaimedAt: NOW - 5 * MIN })] }), [claimed, again]))
    expect(logged.actions.filter(a => a.kind === 'claim')).toEqual([])
    expect(logged.actions.find(a => a.kind === 'event' && a.key === `${again.key}/transition`)).toMatchObject({ event: { state: 'transition', record: r, via: 'reclaim' } })
    const inFlight = entry(reclaimKey(r, lifeOf(NOW - MIN)), 'claim', { issue: 122, status: 'running', endedAt: null, startedAt: NOW - MIN })
    expect(plan(withLedger(world([r], { issues: [issue(122, { reclaimedAt: NOW - 5 * MIN })] }), [claimed, inFlight])).actions.some(a => a.kind === 'claim')).toBe(false)
  })
})

// --- the plan's properties (17.1) --------------------------------------------------------------------------------

// The records a sweep plans over: every state and step, settled, with no step entry, with a done
// result, and with a step running.
function sweepRecords(): { records: IssueRecord[]; ledger: LedgerEntry[] }[] {
  const shapes: Partial<IssueRecord>[] = [
    { state: 'queued', step: 'lease' },
    { state: 'designing', step: 'design' },
    { state: 'building', step: 'build' },
    { state: 'building', step: 'triage', triages: 1 },
    { state: 'reviewing', step: 'review', pr: 600 },
    { state: 'fixing', step: 'fix', pr: 600, fixes: 1 },
    { state: 'merge-queue', step: 'queue', pr: 600 },
    { state: 'merge-queue', step: 'triage', pr: 600, triages: 1 },
    { state: 'parked', step: null, question: 'q', resumeTo: 'building' },
    { state: 'closed', step: null, why: 'merged' },
  ]
  const out: { records: IssueRecord[]; ledger: LedgerEntry[] }[] = []
  const records = shapes.map((shape, i) => rec(200 + i, shape))
  out.push({ records, ledger: [] })
  const agent = records.filter(r => r.step === 'design' || r.step === 'build' || r.step === 'fix' || r.step === 'triage')
  out.push({ records, ledger: agent.map(r => stepDone(r, r.step as 'design', r.step === 'triage' ? { event: 'ok', choice: 'retry', reason: 'r', data: { instructions: 'i' } } : { event: 'unknown', why: 'agent-dead', reason: 'gone' })) })
  out.push({ records, ledger: agent.map(r => entry(stepKey(r, r.step as 'design', 1), 'agent-step', { issue: r.issue, class: 'drive', step: r.step as 'design', status: 'running', endedAt: null, agentId: `a${r.issue}`, startedAt: NOW - 5 * MIN })) })
  return out
}

const breaker = (n: number) => entry(`i${300 + n}/l${LIFE}/s2/t`, 'transition', { issue: 300 + (n % 2), endedAt: NOW - n * MIN, outcome: { kind: 'transition', row: 'U2', event: 'unknown', cause: null, from: 'building', to: 'building', step: 'build', stored: true } })

// Each admission filter on, alone (17.1 property 3's "generated with each admission filter on").
const FILTERS: { name: string; over: (s: State) => State; cfg?: Partial<typeof CFG> }[] = [
  { name: 'none', over: s => s },
  { name: 'no new work', over: s => ({ ...s, control: control({ noNewWork: true }) }) },
  { name: 'paused', over: s => ({ ...s, control: control({ paused: (s.v2?.records ?? []).map(r => r.issue) }) }) },
  { name: 'stop-all', over: s => ({ ...s, usage: { fiveHour: 97, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } }) },
  { name: 'serial', over: s => ({ ...s, control: control({ serial: true }) }) },
  { name: 'GitHub backoff', over: s => ({ ...s, githubBackoffUntil: NOW + 10 * MIN }) },
  { name: 'step breaker', over: s => ({ ...s, ledger: [...s.ledger, breaker(1), breaker(2), breaker(3)] }) },
  { name: 'rate caps', over: s => s, cfg: { rateCaps: { start: 0, spawn: 0, wake: 0, perIssueKind: 0 } } },
]

describe('the plan\'s properties (v2 SPEC 17.1)', () => {
  test('property 3, liveness: after one pass every record not closed has a running step, a planned action or a skip line naming why it waits, with each admission filter on', () => {
    for (const { records, ledger } of sweepRecords()) {
      for (const f of FILTERS) {
        const s = f.over(withLedger(world(records, { queue: [400], issues: [issue(400)] }), ledger))
        const r = planV2(s, { ...CFG, ...(f.cfg ?? {}) })
        for (const rec of records.filter(x => x.state !== 'closed')) {
          const runs = s.ledger.some(e => e.issue === rec.issue && e.status === 'running')
          const live = runs || r.actions.some(a => a.issue === rec.issue) || r.skipped.some(k => k.issue === rec.issue && k.why !== '')
          expect({ filter: f.name, issue: rec.issue, state: rec.state, step: rec.step, live }).toEqual({ filter: f.name, issue: rec.issue, state: rec.state, step: rec.step, live: true })
        }
      }
    }
  })

  test('property 6, one writer: at most one step action per record, never an agent step beside a queue action, and no two records in one slot', () => {
    for (const { records, ledger } of sweepRecords()) {
      const r = plan(withLedger(world(records), ledger))
      const steps = r.actions.filter(a => a.kind === 'agent-step' || (a.kind === 'slot' && a.op === 'prepare') || a.kind === 'queue-update' || a.kind === 'queue-merge')
      const byIssue = new Map<number, number>()
      for (const a of steps) byIssue.set(a.issue ?? 0, (byIssue.get(a.issue ?? 0) ?? 0) + 1)
      expect([...byIssue.values()].every(n => n === 1)).toBe(true)
      const slots = steps.flatMap(a => (a.kind === 'agent-step' ? [a.slot] : a.kind === 'slot' ? [a.path] : []))
      expect(new Set(slots).size).toBe(slots.length)
    }
  })

  test('property 16: determinism, and idempotence: planning again with the planned actions running adds nothing but the title', () => {
    const p = rec(410, { state: 'parked', step: null, question: 'q', resumeTo: 'building' })
    const t = rec(411, { state: 'designing', step: 'design', seq: 4, seqAt: NOW - MIN, since: NOW - MIN })
    const s = withLedger(
      world([rec(412), p, t, rec(413, { state: 'queued', step: 'lease' })], { queue: [414, 415], issues: [issue(414), issue(415)], control: control({ resumed: [{ subject: 'issue:410', at: NOW - MIN }] }) }),
      [transitioned(t, 'T1', 'queued'), done(claimKey(416, LIFE), 'claim', { issue: 416, outcome: { kind: 'claim', result: 'claimed' } })],
    )
    const cfg = { ...CFG, maxInFlightIssues: 10 }
    const first = plan(s, cfg)
    expect(plan(s, cfg)).toEqual(first)
    expect(first.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([414, 415])
    expect(first.actions.map(a => a.kind)).toEqual(expect.arrayContaining(['transition', 'event', 'label', 'slot', 'claim']))
    const again = plan(running(s, first), cfg)
    expect(again.actions.filter(a => a.kind !== 'title')).toEqual([])
  })

  test('property 11: a step that admission holds, for any number of passes, spends no attempt and never times out', () => {
    const r = rec(420, { state: 'designing', step: 'design' })
    const prepared = withLedger(world([r], { control: control({ noNewWork: true }) }), [done(prepareKey(r, 1), 'slot', { issue: 420, maxAttempts: 1 })])
    for (const hours of [1, 3, 12, 48]) {
      const later = { ...prepared, now: NOW + hours * HOUR, ledger: [...prepared.ledger, entry('heartbeat:1', 'heartbeat', { startedAt: NOW + hours * HOUR - MIN, endedAt: NOW + hours * HOUR - MIN })] }
      const p = plan(later)
      expect(transitionOf(p, 420)).toBeUndefined()
      expect(said(p, 420)).toEqual(['owner: no new work (agent-step)'])
    }
  })

  test('property 5 for claims: a claim never takes the records queued or in flight, with the claims in flight, above K', () => {
    for (let held = 0; held <= 4; held++) {
      for (let k = 1; k <= 4; k++) {
        const records = Array.from({ length: held }, (_, i) => rec(430 + i, i % 2 === 0 ? {} : { state: 'queued', step: 'lease' }))
        const queue = [440, 441, 442, 443, 444]
        const r = plan(world(records, { queue, issues: queue.map(n => issue(n)) }), { ...CFG, maxInFlightIssues: k, maxStartsPerPass: 10 })
        const claims = r.actions.filter(a => a.kind === 'claim').length
        expect({ held, k, claims }).toEqual({ held, k, claims: Math.max(0, k - held) })
      }
    }
  })

  test('property 18: every seq logs exactly one transition event before the next transition', () => {
    // a small world that acts: every planned action ends done, a transition stores its record, and
    // each step answers as scripted: the lease, the design's brief, a build that cannot, a triage drop
    let s: State = world([], { queue: [450], issues: [issue(450)] })
    const answers: Record<string, Partial<StepResult>> = {
      design: { event: 'ok', data: { brief: BRIEF(450) } },
      build: { event: 'not-ok', reason: 'cannot', data: { text: 'no API' } },
      triage: { event: 'ok', choice: 'drop', reason: 'not wanted' },
    }
    const logged: number[] = []
    for (let pass = 0; pass < 40; pass++) {
      const r = plan(s)
      let records = [...(s.v2?.records ?? [])]
      const ledger = [...s.ledger]
      for (const a of r.actions) {
        if (a.kind === 'title') continue
        let outcome: LedgerEntry['outcome']
        if (a.kind === 'transition') {
          const prior = records.find(x => x.issue === a.next.issue && x.life === a.next.life)
          if (prior !== undefined) expect({ seq: prior.seq, logged: logged.includes(prior.seq) }).toEqual({ seq: prior.seq, logged: true })
          records = applied(records, a.from, a.next)
          outcome = { kind: 'transition', row: a.row, event: a.event, cause: a.cause ?? null, from: prior?.state ?? null, to: a.next.state, step: prior?.step ?? null, stored: true, via: a.via ?? a.row }
        } else if (a.kind === 'event' && a.event.state === 'transition') {
          expect(logged.includes(a.event.record.seq)).toBe(false)
          logged.push(a.event.record.seq)
        } else if (a.kind === 'claim') {
          outcome = { kind: 'adopt', branch: 'issue-450', pr: null, others: [] }
        } else if (a.kind === 'agent-step') {
          outcome = { kind: 'step', step: a.step, result: { event: 'ok', reason: null, why: null, head: null, choice: null, data: null, ...answers[a.step] } }
        }
        ledger.push({ ...start([], a, s.now).entry, status: 'done', endedAt: s.now, ...(outcome === undefined ? {} : { outcome }) })
      }
      const now = s.now + MIN
      const leases = records.filter(x => x.state !== 'closed').map(leaseFor)
      s = { ...s, now, ledger, queue: [], v2: { ...(s.v2 as V2State), records, leases } }
    }
    const final = s.v2?.records.find(x => x.issue === 450)
    expect(final).toMatchObject({ state: 'closed', why: 'dropped' })
    // one event per seq, in order, the last seq's included
    expect(logged).toEqual(Array.from({ length: final?.seq ?? 0 }, (_, i) => i + 1))
  })
})

// --- the record's executors (act-state.ts) ----------------------------------------------------------------------

function runtime(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP_DIR,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: CFG,
    configProblems: [],
  }
}

type Reply = { exitCode?: number; stdout?: string; stderr?: string }

// actWorld: an act step over a recording ActIo with live records, which a store may refuse.
function actWorld(records: IssueRecord[] = [], reply: (argv: string[], stdin?: string) => Reply = () => ({})) {
  const argvs: string[][] = []
  const stdins: (string | undefined)[] = []
  const pings: string[] = []
  const spawns: SpawnInput[] = []
  const live = { records: [...records], refuse: false, ledger: [] as LedgerEntry[] }
  const v2: V2Io = {
    records: () => live.records,
    ledger: () => live.ledger,
    updateRecords: async fn => {
      const next = fn(live.records)
      if (next === null || live.refuse) return { changed: false, saved: false }
      live.records = next
      return { changed: true, saved: true }
    },
    ping: why => void pings.push(why),
  }
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => {
      argvs.push([...argv])
      stdins.push(init.stdin)
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv, init.stdin) }
    },
    spawnAgent: async input => {
      spawns.push(input)
      return { agentId: 'a1' }
    },
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
    v2,
  }
  const env: ActEnv = { io, rt: runtime(), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  const run = (action: Action, s: State = world(records)) => dispatch(ctxOf(env, s, start([], action, NOW).entry), action)
  return { argvs, stdins, pings, live, spawns, run }
}

describe('the record\'s executors (act-state.ts)', () => {
  const r = rec(500, { state: 'designing', step: 'design', seq: 4 })
  const next = nextRecord(r, rowFor(r, { kind: 'ok', data: { brief: BRIEF(500) } }, CFG), { kind: 'ok', data: { brief: BRIEF(500) } }, NOW)
  const answer = stepDone(r, 'design', { event: 'ok', data: { brief: BRIEF(500) } })
  const action: Action = { kind: 'transition', key: transitionKey(next), class: 'free', rule: 'S3', reason: 'T2', issue: 500, row: 'T2', event: 'ok', from: { issue: 500, life: LIFE, seq: 4 }, next, trigger: { kind: 'entry', key: answer.key, status: 'done', startedAt: answer.startedAt }, cause: null, via: 'brief' }

  test('transition: the trigger re-checked against the live ledger, the record compared on issue, life and seq, stored, and the driver pinged', async () => {
    const w = actWorld([r])
    w.live.ledger = [answer]
    expect(await w.run(action)).toEqual({ status: 'done', outcome: { kind: 'transition', row: 'T2', event: 'ok', cause: null, from: 'designing', to: 'building', step: 'design', stored: true, via: 'brief' }, summary: '#500 designing -> building (T2, seq 5)' })
    expect(w.live.records).toEqual([next])
    expect(w.pings).toEqual(['transition #500 T2'])
    // applied again: the record moved, nothing changes
    expect(await w.run(action)).toMatchObject({ status: 'skipped', summary: expect.stringContaining('moved to seq 5') })
    expect(w.live.records).toEqual([next])
  })

  test('transition: a trigger that no longer holds, or a store that refuses, changes nothing; S0 adds the record once', async () => {
    const stale = actWorld([r])
    stale.live.ledger = [{ ...answer, status: 'running', endedAt: null }]
    expect(await stale.run(action)).toMatchObject({ status: 'skipped', summary: expect.stringContaining('running now, not done as planned') })
    expect(stale.live.records).toEqual([r])
    const refused = actWorld([r])
    refused.live.ledger = [answer]
    refused.live.refuse = true
    expect(await refused.run(action)).toMatchObject({ status: 'failed' })
    expect(refused.live.records).toEqual([r])
    const made = madeRecord({ issue: 501, life: LIFE, branch: 'issue-501', pr: null, others: [] }, NOW)
    const claim = done(claimKey(501, LIFE), 'claim', { issue: 501, outcome: { kind: 'claim', result: 'claimed' } })
    const s0: Action = { kind: 'transition', key: transitionKey(made), class: 'free', rule: 'S1', reason: 'S0', issue: 501, row: 'S0', event: 'ok', from: null, next: made, trigger: { kind: 'claim', key: claim.key }, cause: null, via: 'claim' }
    const w = actWorld([])
    w.live.ledger = [claim]
    expect(await w.run(s0)).toMatchObject({ status: 'done', outcome: { row: 'S0', from: null, to: 'queued' } })
    expect(await w.run(s0)).toMatchObject({ status: 'skipped', summary: expect.stringContaining('exists already') })
    expect(w.live.records).toEqual([made])
    expect(triggerStale([claim], { kind: 'fact', fact: 'drop:1' })).toBeNull()
    expect(recordStale([{ ...made, state: 'building' }], null, { ...made, life: 'zz' })).toContain('not closed')
  })

  test('label: one call sets the state\'s label and removes the other six; a close removes all seven; a release requeues (ready on) or rejects (factory:rejected on) with the seven off; ensure makes the eight; a failure is a failed attempt with its output', async () => {
    const set: Action = { kind: 'label', key: 'k', class: 'free', rule: 'S3', reason: 'x', issue: 502, op: 'set', label: 'factory:building' }
    const others = Object.values(FACTORY_LABELS).map(l => l.name).filter(l => l !== 'factory:building')
    expect(labelArgvs(set as Extract<Action, { kind: 'label' }>, REPO)).toEqual([['gh', 'issue', 'edit', '502', '--repo', REPO, '--add-label', 'factory:building', '--remove-label', others.join(',')]])
    const clear: Action = { ...set, op: 'clear', label: null }
    expect(labelArgvs(clear as Extract<Action, { kind: 'label' }>, REPO)).toEqual([['gh', 'issue', 'edit', '502', '--repo', REPO, '--remove-label', Object.values(FACTORY_LABELS).map(l => l.name).join(',')]])
    const seven = Object.values(FACTORY_LABELS).map(l => l.name).join(',')
    const requeue: Action = { ...set, op: 'requeue', label: null, ready: 'ready' }
    expect(labelArgvs(requeue as Extract<Action, { kind: 'label' }>, REPO)).toEqual([['gh', 'issue', 'edit', '502', '--repo', REPO, '--add-label', 'ready', '--remove-label', seven]])
    expect(labelArgvs({ ...requeue, ready: undefined } as Extract<Action, { kind: 'label' }>, REPO)).toBe('label requeue names no ready label')
    const reject: Action = { ...set, op: 'reject', label: null }
    expect(labelArgvs(reject as Extract<Action, { kind: 'label' }>, REPO)).toEqual([['gh', 'issue', 'edit', '502', '--repo', REPO, '--add-label', 'factory:rejected', '--remove-label', seven]])
    const w = actWorld([])
    expect(await w.run({ ...set, issue: null, op: 'ensure', label: null })).toMatchObject({ status: 'done', summary: 'the 9 factory labels made' })
    expect(w.argvs.map(a => a.slice(0, 4))).toEqual([...Object.values(FACTORY_LABELS).map(l => l.name), 'factory:rejected'].map(name => ['gh', 'label', 'create', name]))
    expect(await actWorld([]).run(requeue)).toMatchObject({ status: 'done', summary: '#502 back in the queue: ready on, factory labels off' })
    expect(await actWorld([]).run(reject)).toMatchObject({ status: 'done', summary: '#502 rejected: factory:rejected on, factory labels off' })
    const failing = actWorld([], () => ({ exitCode: 1, stderr: "could not add label: 'factory:building' not found" }))
    expect(await failing.run(set)).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1, detail: expect.stringContaining('not found') } })
  })

  test('comment: found by its hidden key, never posted twice; posted with its key and no closing keyword; a read that does not parse is a failed attempt', async () => {
    const action: Action = { kind: 'comment', key: 'i503/lx/s4/comment', class: 'free', rule: 'S3', reason: 'x', issue: 503, on: 'issue', number: 503, body: 'Fixes #12 needs an answer' }
    const found = actWorld([], argv => (argv[0] === 'callum-flow-issue-read' ? { stdout: JSON.stringify({ comments: [{ body: `x\n${hiddenKey(action.key)}`, html_url: 'https://github.com/o/r/issues/503#issuecomment-9' }], stripped: 0 }) } : {}))
    expect(await found.run(action)).toMatchObject({ status: 'done', outcome: { detail: 'https://github.com/o/r/issues/503#issuecomment-9' } })
    expect(found.argvs).toEqual([['callum-flow-issue-read', '--json', '503', '--comments']])
    const fresh = actWorld([], argv => (argv[0] === 'callum-flow-issue-read' ? { stdout: JSON.stringify({ comments: [], stripped: 0 }) } : { stdout: 'https://github.com/o/r/issues/503#issuecomment-10\n' }))
    expect(await fresh.run(action)).toMatchObject({ status: 'done', outcome: { detail: 'https://github.com/o/r/issues/503#issuecomment-10' } })
    expect(fresh.argvs[1]).toEqual(['gh', 'issue', 'comment', '503', '--repo', REPO, '--body-file', '-'])
    expect(fresh.stdins[1]).toBe(commentBody(action.body, action.key))
    expect(fresh.stdins[1]).toContain('Fixing #12')
    expect(fresh.stdins[1]).toContain(hiddenKey(action.key))
    const pr = actWorld([], argv => (argv[0] === 'callum-flow-issue-read' ? { stdout: '{"pr": {}, "stripped": 0}' } : {}))
    expect(await pr.run({ ...action, on: 'pr', number: 603 })).toMatchObject({ status: 'failed', summary: 'the comments of PR #603 did not read' })
    expect(postedUrl('not json', 'k')).toBeUndefined()
    expect(postedUrl('{"comments": []}', 'k')).toBeNull()
  })

  test('event: the argv events.ts builds; a usage error is never retried', async () => {
    const e = { state: 'transition' as const, record: r, row: 'T1', from: 'queued' as const, via: 'lease' }
    const action: Action = { kind: 'event', key: 'k', class: 'free', rule: 'S3', reason: 'x', issue: 500, event: e }
    const w = actWorld([])
    expect(await w.run(action)).toMatchObject({ status: 'done', summary: 'logged transition' })
    expect(w.argvs).toEqual([eventArgv(e)])
    const usage = actWorld([], () => ({ exitCode: 2, stderr: 'callum-flow-event: unknown type' }))
    expect(await usage.run(action)).toMatchObject({ status: 'failed', noRetry: true })
    // a fixer's disposition is logged as the fixer's (v2 SPEC 7.1): the actor events.ts names
    const verdict = { state: 'verdict' as const, issue: 500, branch: 'issue-500', pr: 621, head: null, note: 'CORRECT: r1-1 fixed the off-by-one' }
    const fixer = actWorld([])
    expect(await fixer.run({ ...action, event: verdict })).toMatchObject({ status: 'done', summary: 'logged verdict' })
    expect(fixer.argvs).toEqual([eventArgv(verdict)])
    expect(fixer.argvs[0]?.slice(-4)).toEqual(['--issue', '500', '--actor', 'fixer'])
    expect(fixer.argvs[0]?.slice(1, 3)).toEqual(['--type', 'finding_handled'])
  })

  test('event: a merged event with a pr reads the PR size first and logs it; a failed read logs nulls and is no failure', async () => {
    const merged = { state: 'merged' as const, issue: 500, branch: 'issue-500', pr: 621, head: 'abc1234', note: 'merged by hand' }
    const action: Action = { kind: 'event', key: 'k', class: 'free', rule: 'S3', reason: 'x', issue: 500, event: merged }
    const sizeArgv = ['gh', 'pr', 'view', '621', '--repo', REPO, '--json', 'files,additions,deletions']
    const dataOf = (argv: string[] | undefined) => JSON.parse(argv?.[argv.indexOf('--data') + 1] ?? 'null')
    const ok = actWorld([], argv => (argv[0] === 'gh' ? { stdout: JSON.stringify({ files: [{ path: 'a.js' }, { path: '' }, { path: 'b/c.sh' }], additions: 12, deletions: 3 }) } : {}))
    expect(await ok.run(action)).toMatchObject({ status: 'done', summary: 'logged merged' })
    expect(ok.argvs[0]).toEqual(sizeArgv)
    expect(ok.argvs[1]).toEqual(eventArgv({ ...merged, size: { files: ['a.js', 'b/c.sh'], additions: 12, deletions: 3 } }))
    expect(dataOf(ok.argvs[1])).toMatchObject({ pr: 621, files: ['a.js', 'b/c.sh'], additions: 12, deletions: 3 })
    // a read that fails (exit, throw, bad JSON, no counts) writes the three as null, and the summary says so
    const bad: [string, (argv: string[]) => { exitCode?: number; stdout?: string }][] = [
      ['exit', () => ({ exitCode: 1 })],
      ['throw', () => {
        throw new Error('gh timed out')
      }],
      ['json', () => ({ stdout: 'not json' })],
      ['shape', () => ({ stdout: '{"files": []}' })],
    ]
    for (const [name, gh] of bad) {
      const w = actWorld([], argv => (argv[0] === 'gh' ? gh(argv) : {}))
      expect(await w.run(action), name).toMatchObject({ status: 'done', summary: expect.stringContaining('size of PR #621 was unread') })
      expect(w.argvs[1], name).toEqual(eventArgv(merged))
      expect(dataOf(w.argvs[1]), name).toMatchObject({ files: null, additions: null, deletions: null })
    }
    // no pr: no size read; another event: no extra command
    const nopr = actWorld([])
    expect(await nopr.run({ ...action, event: { ...merged, pr: null } })).toMatchObject({ status: 'done', summary: 'logged merged' })
    expect(nopr.argvs.map(a => a[0])).toEqual(['callum-flow-event'])
    const verdict = actWorld([])
    await verdict.run({ ...action, event: { state: 'verdict', issue: 500, branch: 'issue-500', pr: 621, head: null, note: 'CORRECT: r1-1 fixed' } })
    expect(verdict.argvs.map(a => a[0])).toEqual(['callum-flow-event'])
  })

  test('claim under planner v2: exit 3 is lost; a first claim adopts the newest open PR by a trusted author on a branch of the issue, the others named; a re-claim adopts nothing', async () => {
    const claim: Action = { kind: 'claim', key: claimKey(130, LIFE), class: 'start', rule: 'S1', reason: 'x', issue: 130 }
    const lost = actWorld([], () => ({ exitCode: 3, stderr: 'callum-flow-claim: #130 is held by other since x' }))
    expect(await lost.run(claim)).toMatchObject({ status: 'done', outcome: { kind: 'claim', result: 'lost' } })
    const list = [
      { number: 631, headRefName: 'issue-130' },
      { number: 640, headRefName: 'feat/issue-130-fast' },
      { number: 650, headRefName: 'issue-1300' },
      { number: 660, headRefName: 'someone/issue-130' },
    ]
    const w = actWorld([], argv => {
      if (argv[0] === 'gh') return { stdout: JSON.stringify(list) }
      if (argv[0] === 'callum-flow-issue-read') return argv[3] === '660' ? { exitCode: 3 } : { stdout: '{"pr": {}}' }
      return {}
    })
    expect(await w.run(claim)).toMatchObject({ status: 'done', outcome: { kind: 'adopt', branch: 'feat/issue-130-fast', pr: 640, others: [660, 631] } })
    // gh lists 30 by default: the limit keeps the issue's PR on the list however many are open
    expect(w.argvs).toEqual([['callum-flow-claim', '130'], ['gh', 'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName'], ['callum-flow-issue-read', '--json', '--pr', '660'], ['callum-flow-issue-read', '--json', '--pr', '640']])
    const none = actWorld([], argv => (argv[0] === 'gh' ? { stdout: '[]' } : {}))
    expect(await none.run(claim)).toMatchObject({ outcome: { kind: 'adopt', branch: 'issue-130', pr: null, others: [] } })
    // the claim posted, then the PRs did not read: the attempt fails, and says the claim is held
    const unread = actWorld([], argv => (argv[0] === 'gh' ? { exitCode: 1, stderr: 'HTTP 502' } : {}))
    expect(await unread.run(claim)).toMatchObject({ status: 'failed', outcome: { kind: 'claim', result: 'claimed' }, summary: expect.stringContaining('claimed #130, but the PRs to adopt did not read') })
    const badRead = actWorld([], argv => (argv[0] === 'gh' ? { stdout: JSON.stringify(list) } : argv[0] === 'callum-flow-issue-read' ? { exitCode: 1 } : {}))
    expect(await badRead.run(claim)).toMatchObject({ status: 'failed', outcome: { kind: 'claim', result: 'claimed' } })
    // the claim tool itself failed: nothing is held
    const refused = actWorld([], argv => (argv[0] === 'callum-flow-claim' ? { exitCode: 1 } : {}))
    expect(await refused.run(claim)).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
    const again = actWorld([])
    expect(await again.run({ ...claim, rule: 'H1' })).toMatchObject({ status: 'done', outcome: { kind: 'claim', result: 'claimed' } })
    expect(again.argvs).toEqual([['callum-flow-claim', '130']])
    // a scored claim (S1) runs under env CALLUM_FLOW_CLAIM_SCORE, which the claim tool records on the claimed event
    const score = { score: 55, factors: [{ name: 'priority-label', points: 30 }, { name: 'bug', points: 25 }] }
    const scored = actWorld([], argv => (argv[0] === 'gh' ? { stdout: '[]' } : {}))
    expect(await scored.run({ ...claim, score })).toMatchObject({ status: 'done', outcome: { kind: 'adopt' } })
    expect(scored.argvs[0]).toEqual(['env', `CALLUM_FLOW_CLAIM_SCORE=${JSON.stringify(score)}`, 'callum-flow-claim', '130'])
    expect(JSON.parse((scored.argvs[0]?.[1] ?? '').slice('CALLUM_FLOW_CLAIM_SCORE='.length))).toEqual(score)
    expect(issueBranch('feat/issue-130', 130)).toBe(true)
    expect(issueBranch('issue-1300', 130)).toBe(false)
    expect(openPrsOf('nope', 130)).toBeNull()
  })

  test('heartbeat under planner v2: the claims of the records that are not closed, by number; none to renew runs nothing', async () => {
    const beat: Action = { kind: 'heartbeat', key: 'heartbeat:0', class: 'free', rule: 'H1', reason: 'x', issue: null }
    const records = [rec(141), rec(140, { state: 'parked', step: null, question: 'q' }), rec(142, { state: 'closed', step: null, why: 'merged' })]
    const w = actWorld(records)
    expect(await w.run(beat, world(records))).toMatchObject({ status: 'done', summary: 'leases renewed: #140 #141' })
    expect(w.argvs).toEqual([['callum-flow-claim', '--heartbeat', '140', '141']])
    const idle = actWorld([])
    expect(await idle.run(beat, world([]))).toMatchObject({ status: 'done', summary: 'no record to renew' })
    expect(idle.argvs).toEqual([])
  })
})

// --- the triage step (5.2) -----------------------------------------------------------------------------------------

describe('the triage step (v2 SPEC 5.2)', () => {
  const check = (input: unknown) => V2_CONTRACTS.triage.check(input, { contract: 'triage', purpose: null, repo: REPO, issue: 150, branch: 'issue-150' })

  test('the contract: one choice of the menu, its reason, the text it needs within its limit, and no other field', () => {
    expect(check({ choice: 'retry', reason: 'flaky', instructions: 'run it again' })).toEqual({ ok: true, outcome: { choice: 'retry', reason: 'flaky', instructions: 'run it again', question: null } })
    expect(check({ choice: 'park', reason: 'needs the owner', question: 'SQLite or Postgres?' })).toMatchObject({ ok: true, outcome: { choice: 'park', question: 'SQLite or Postgres?' } })
    expect(check({ choice: 'drop', reason: 'obsolete' })).toMatchObject({ ok: true })
    const problems = (input: unknown) => {
      const c = check(input)
      return c.ok ? [] : c.problems
    }
    expect(problems({ choice: 'fix', reason: 'r' })).toEqual(['instructions is required for the choice fix'])
    expect(problems({ choice: 'redesign', reason: 'r' })).toEqual(['instructions is required for the choice redesign'])
    expect(problems({ choice: 'park', reason: 'r' })).toEqual(['question is required for the choice park'])
    expect(problems({ choice: 'merge', reason: 'r', extra: 1 })).toEqual(['extra is not a field of a triage answer (only choice, reason, instructions, question, context, options, recommendation)', 'choice "merge" is not one of retry, fix, redesign, park, drop'])
    expect(problems({ choice: 'drop', reason: 'line one\nline two' })).toEqual(['reason must be one line'])
    expect(problems({ choice: 'drop', reason: 'x'.repeat(501) })).toEqual(['reason is 501 characters; at most 500'])
    expect(problems({ choice: 'retry', reason: 'r', instructions: 'x'.repeat(4001) })).toEqual(['instructions is 4001 characters; at most 4000'])
    expect(problems('retry')).toEqual(['the answer must be one JSON object: {"choice", "reason", and "instructions" or "question"}'])
    expect(V2_CONTRACTS.triage.summary({ choice: 'retry', reason: 'flaky' })).toBe('retry: flaky')
    expect(triageResult({ choice: 'park', reason: 'r', instructions: null, question: 'which?' })).toEqual({ event: 'ok', reason: 'r', why: null, head: null, choice: 'park', data: { text: 'r', instructions: undefined, question: 'which?', parts: { decision: 'which?', context: null, options: null, recommended: null, recommendation: null } } })
    expect(triageResult({})).toMatchObject({ event: 'unknown', why: 'bad-answer' })
  })

  const input = (over: Partial<TriageInput> = {}): TriageInput => ({
    repo: REPO,
    issue: 150,
    slot: '/slots/150',
    scratch: `${LOOP_DIR}/scratch/150-lx-s6`,
    state: 'building',
    step: 'build',
    attempt: 2,
    triages: 1,
    maxTriages: 2,
    fixes: 0,
    conflicts: 0,
    fixCap: 3,
    conflictFixCap: 5,
    round: 0,
    brief: BRIEF(150),
    branch: 'issue-150',
    head: null,
    pr: null,
    results: [{ key: 'i150/lx/s5/build/a2', kind: 'build', status: 'done', summary: 'build #150: not-ok: Fixes #9 cannot', error: 'Resolves #3 is missing', files: ['/l/spawns/x.json'] }],
    checks: null,
    mergeable: null,
    reviewAnswer: null,
    guard: [],
    notes: ['owner: closes #4 later'],
    fixValid: false,
    place: { bin: `${PLUGIN_ROOT}/bin/factory-answer`, file: `${LOOP_DIR}/answers/i150_lx_s6_triage_a1.answer.json` },
    ...over,
  })

  test('the prompt: the slot line first, the counts, the last results with their files, the menu as it stands here, the answer script; free text neutralized; nothing of no-mistakes', () => {
    const p = triagePrompt(input())
    expect(p.split('\n')[0]).toBe('factory-slot: /slots/150')
    expect(p).toContain(COMMAND_RULE)
    expect(p).toContain(`Your scratch folder is ${LOOP_DIR}/scratch/150-lx-s6. It is $TMPDIR in every Bash call.`)
    expect(p).not.toContain('/tmp')
    // with no slot there is no marker and no scratch folder to name
    expect(triagePrompt(input({ slot: null, scratch: null }))).not.toContain('scratch folder')
    expect(p).toContain('1 of 2 triage calls, 0 of 3 fix rounds, 0 of 5 conflict rounds')
    expect(p).toContain('file: /l/spawns/x.json')
    expect(p).toContain('- fix: not valid here (the branch has no commits beyond the base)')
    expect(p).toContain(`${PLUGIN_ROOT}/bin/factory-answer --to ${LOOP_DIR}/answers/i150_lx_s6_triage_a1.answer.json <<'JSON'`)
    expect(p).not.toMatch(/\b(fixes|resolves|closes)\b\s*#\d/i)
    expect(p).not.toMatch(/\baxi\b|no-mistakes|implement-issue/)
    const valid = triagePrompt(input({ head: HEAD, fixValid: true, state: 'reviewing', step: 'review', pr: 750, checks: [{ name: 'ci', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/1/job/2' }], mergeable: 'clean', guard: ['GUARD checks FAIL ci failed class=checks'] }))
    expect(valid).toContain('- fix: a fixer works on issue-150 with your instructions')
    expect(valid).toContain('a fixer can fix a finding without a new head')
    expect(valid).toContain('mergeable state: clean')
    expect(valid).toContain('- ci: fail https://github.com/o/r/actions/runs/1/job/2')
    expect(valid).toContain('GUARD checks FAIL ci failed class=checks')
  })

  test('the park choice names the resume step the park comment gives the owner, so the two never disagree (drill run 2, #36)', () => {
    const p = triagePrompt(input())
    const park = p.split('\n').find(l => l.startsWith('- park:')) ?? ''
    expect(park).toContain('remove the `factory:parked` label')
    expect(park).toContain('/factory resume 150')
    expect(park).not.toContain('ready')
  })

  test('its inputs come from the state the pass planned from: the record\'s counts, its last two results with their files, a fixer\'s validity; no record is a loop bug', () => {
    const r = rec(151, { step: 'triage', triages: 1, attempt: 1, head: HEAD, seq: 7 })
    const ledger = [
      { ...stepDone({ ...r, seq: 5 }, 'build', { event: 'unknown', why: 'timeout', reason: 'ran past 90 min' }), endedAt: NOW - 30 * MIN },
      { ...stepDone({ ...r, seq: 6, attempt: 2 }, 'build', { event: 'unknown', why: 'agent-dead', reason: 'its turn ended: error' }), endedAt: NOW - 10 * MIN },
      { ...stepDone({ ...r, seq: 4 }, 'design', { event: 'ok' }), endedAt: NOW - 60 * MIN },
    ]
    const env: ExecCtx = { io: {} as ActIo, rt: runtime(), state: withLedger(world([r]), ledger), entry: ledger[0] as LedgerEntry, cmd: async () => ({ exitCode: 0, stdout: '', stderr: '' }), event: async () => undefined, wakeId: () => 'w' }
    const action = { kind: 'agent-step', key: stepKey(r, 'triage', 1), class: 'drive', rule: 'S5', reason: 'x', issue: 151, step: 'triage', life: LIFE, seq: 7, attempt: 1, branch: 'issue-151', slot: '/slots/151', notes: ['owner: x'] } as Extract<Action, { kind: 'agent-step' }>
    const got = triageInput(env, action, input().place)
    expect(got).toMatchObject({ issue: 151, state: 'building', step: 'build', triages: 1, fixValid: true, slot: '/slots/151', notes: ['owner: x'], checks: null })
    const results = resultsOf(env, r)
    expect(results.map(x => [x.kind, x.status, x.error])).toEqual([
      ['build', 'done', 'its turn ended: error'],
      ['build', 'done', 'ran past 90 min'],
    ])
    expect(results[0]?.files.slice(0, 2)).toEqual([stepRecordPath(LOOP_DIR, results[0]?.key ?? ''), stepAnswerPath(LOOP_DIR, results[0]?.key ?? '')])
    expect(stepFiles(LOOP_DIR, 'i1/lx/s2/build/a1').slice(0, 2)).toEqual([stepRecordPath(LOOP_DIR, 'i1/lx/s2/build/a1'), stepAnswerPath(LOOP_DIR, 'i1/lx/s2/build/a1')])
    expect(triageInput(env, { ...action, issue: 999 }, input().place)).toEqual(`#999 has no record of life ${LIFE} in the state the pass planned from`)
    // in its first review round the record names no PR yet: the triage is told the one its ensure
    // opened (8.1), with that PR's checks and merge state
    const rv = rec(153, { state: 'reviewing', step: 'triage', head: HEAD, seq: 7 })
    const ensured = done(prKey(rv, 'ensure'), 'pr', { issue: 153, outcome: { kind: 'pr', pr: 753, created: true, reopened: false } })
    const read = { pr: 753, issue: 153, state: 'open' as const, head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: null, baseRef: 'main', checks: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' as const, startedAt: null, completedAt: null, runId: '1', link: 'https://x/actions/runs/1/job/2' }], patch: null, readAt: NOW }
    const seen: ExecCtx = { ...env, state: withLedger(world([rv], {}, { prs: { prs: [read] } }), [ensured]) }
    expect(triageInput(seen, { ...action, issue: 153, branch: 'issue-153' }, input().place)).toMatchObject({ pr: 753, mergeable: 'clean', checks: [{ name: 'ci', bucket: 'fail', link: 'https://x/actions/runs/1/job/2' }], fixValid: true })
  })

  test('the record round-trips the store after every executor\'s transition', () => {
    const r = rec(152)
    expect(recordOf(JSON.parse(JSON.stringify(nextRecord(r, rowFor(r, { kind: 'not-ok', reason: 'cannot' }, CFG), { kind: 'not-ok', reason: 'cannot' }, NOW))))).not.toBeNull()
  })
})

describe('the title is a throttle (O1, titleEveryMs)', () => {
  const titleActions = (r: PlanResult) => r.actions.filter(a => a.kind === 'title')
  const at = (min: number, over: Partial<State> = {}) => ({ ...world([], { lastTitle: 'A', lastTitleAt: NOW, ...over }), now: NOW + min * MIN })
  test('changes inside the window plan nothing; the pass after it sets the title then', () => {
    for (const [min, q] of [[1, 1], [2, 2], [4, 3]] as const) {
      const r = plan(at(min, { queue: Array.from({ length: q }, (_, i) => i + 1) }))
      expect(r.title).not.toBe('A')
      expect(titleActions(r)).toEqual([])
    }
    const due = plan(at(5, { queue: [1, 2, 3] }))
    expect(titleActions(due)).toEqual([expect.objectContaining({ kind: 'title', text: due.title })])
  })
  test('a title that reverts to the last one sends nothing, in the window or after it', () => {
    const last = plan(world([])).title
    for (const min of [1, 3, 6]) expect(titleActions(plan({ ...at(min), lastTitle: last }))).toEqual([])
  })
  test('the first title after a load goes out at once', () => {
    expect(titleActions(plan(world([], { lastTitle: null, lastTitleAt: null })))).toHaveLength(1)
  })
  test('an hour of changes every 2 minutes renames at most 12 times', () => {
    let s = world([])
    let renames = 0
    for (let t = 0; t < 360; t++) {
      s = { ...s, now: NOW + t * 10_000, queue: Array.from({ length: Math.floor(t / 12) % 50 }, (_, i) => i + 1) }
      const r = plan(s)
      renames += titleActions(r).length
      if (titleActions(r).length > 0) s = { ...s, lastTitle: r.title, lastTitleAt: s.now }
    }
    expect(renames).toBeGreaterThan(1)
    expect(renames).toBeLessThanOrEqual(12)
  })
})

describe('the title\'s owner count holds across a sweep retry (H2, O2)', () => {
  test('the pass that starts the retry counts the same stalled sweep as the pass before it', () => {
    // the fixture's own ledger holds a recent done sweep, which would be the last one: replace it
    const lastDoneAt = NOW - 2 * HOUR
    const key = `sweep:${lastDoneAt}`
    const swept = done('sweep:0', 'sweep', { startedAt: lastDoneAt - MIN, endedAt: lastDoneAt })
    const on = (retry: LedgerEntry) => plan({ ...world([]), ledger: [swept, retry] })
    const before = on(entry(key, 'sweep', { status: 'failed', attempts: 3, startedAt: NOW - 20 * MIN, endedAt: NOW - 19 * MIN }))
    const during = on(entry(key, 'sweep', { status: 'running', attempts: 4, startedAt: NOW, endedAt: null }))
    expect(before.owner).toBe(1)
    expect(during.owner).toBe(before.owner)
    expect(before.title).toContain('owner 1')
    expect(during.title).toBe(before.title)
  })
})

// --- comment_posted (v2 SPEC 4.5, comment_posted.v1) ---------------------------------------------------------

describe('a park or wait comment logs where it is (comment_posted)', () => {
  const URL = 'https://github.com/o/r/issues/61#issuecomment-1'
  const at = NOW - 5 * MIN
  const parked = rec(61, { state: 'parked', step: null, question: 'Which API shape?', resumeTo: 'designing', seq: 3, seqAt: at, since: at })
  const waiting = rec(62, { state: 'waiting', step: null, wait: [{ kind: 'issue-closed' as const, issue: 57 }], resumeTo: 'designing', notes: ['x'], seq: 3, seqAt: at, since: at })
  const entered = (r: IssueRecord) => [transitioned(r, 'T16', 'designing', 'wait')]
  const comment = (r: IssueRecord, detail?: string, status: 'done' | 'failed' = 'done') =>
    status === 'done' ? done(entryKey(r, 'comment'), 'comment', { issue: r.issue, outcome: detail === undefined ? { kind: 'cli', exit: 0 } : { kind: 'cli', exit: 0, detail } }) : { ...done(entryKey(r, 'comment'), 'comment', { issue: r.issue }), status: 'failed' as const }
  const run = (r: IssueRecord, ...more: LedgerEntry[]) => plan(withLedger(world([r]), [...entered(r), ...more]))
  const posted = (r: IssueRecord, p: PlanResult) => of(p, r.issue).filter(a => a.kind === 'event' && a.event.state === 'comment_posted')

  test('a parked record plans it after the comment, before the tell', () => {
    const p = run(parked, comment(parked, URL))
    expect(posted(parked, p)).toEqual([expect.objectContaining({ key: entryKey(parked, 'event/comment-posted'), class: 'free', rule: 'S3', issue: 61, event: { state: 'comment_posted', issue: 61, data: { life: parked.life, seq: 3, to_state: 'parked', comment_url: URL } } })])
    const k = kinds(p, 61).filter(x => x === 'event comment_posted' || x === 'comment' || x === 'tell')
    expect(k).toEqual(['event comment_posted', 'tell'])
  })

  test('a waiting record plans it after the comment, before the links', () => {
    const p = run(waiting, comment(waiting, URL))
    expect(posted(waiting, p)).toEqual([expect.objectContaining({ event: expect.objectContaining({ data: { life: waiting.life, seq: 3, to_state: 'waiting', comment_url: URL } }) })])
    const k = kinds(p, 62).filter(x => x === 'event comment_posted' || x === 'comment' || x === 'link')
    expect(k).toEqual(['event comment_posted', 'link'])
  })

  test('nothing while the comment is not done, has no URL, or has one the schema refuses', () => {
    expect(posted(parked, run(parked))).toEqual([])
    expect(posted(parked, run(parked, comment(parked, URL, 'failed')))).toEqual([])
    expect(posted(parked, run(parked, comment(parked, '')))).toEqual([])
    expect(posted(parked, run(parked, comment(parked)))).toEqual([])
    expect(posted(parked, run(parked, comment(parked, 'http://github.com/o/r/issues/61#issuecomment-1')))).toEqual([])
    expect(posted(parked, run(parked, comment(parked, 'https://x/ y')))).toEqual([])
    expect(posted(parked, run(parked, comment(parked, `https://${'a'.repeat(493)}`)))).toEqual([])
    expect(posted(parked, run(parked, comment(parked, `https://${'a'.repeat(492)}`)))).toHaveLength(1)
  })

  test('once the event entry is done it is planned no more; a seq with no transition entry plans nothing', () => {
    const p = run(parked, comment(parked, URL), done(entryKey(parked, 'event/comment-posted'), 'event', { issue: 61 }))
    expect(posted(parked, p)).toEqual([])
    expect(posted(parked, plan(withLedger(world([parked]), [comment(parked, URL)])))).toEqual([])
  })
})
