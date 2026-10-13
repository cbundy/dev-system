// The plan, scenario by scenario. Each expectation is written from the issue-orchestrator
// skill (cited SKILL:<line>, v0.35.0), the inventory row (I-nn) or the owner's rules in the
// memory file (MEM), not from the code. docs/factory-loop/SPEC.md section 5 is the table.
import { describe, expect, test } from 'claude-code/testing'

import { classifyFail, issueFromBranch, plan, sameLabel, tierOf } from '../hooks/plan'
import type { Action, AdjudicatorAction, IssueView, LedgerEntry, MergeReport, State } from '../hooks/types'
import {
  DEVICE,
  MIN,
  NOW,
  OTHER,
  brief,
  config,
  control,
  entry,
  failing,
  find,
  issue,
  keys,
  mine,
  review,
  run,
  running,
  state,
  wakeAnswer,
  withLedger,
} from './fixtures'

const CFG = config()

// A parked review gate on #45, its brief posted, and the adjudicator's outcome for it.
function parkedReview(over: Partial<State> = {}, rounds = 0) {
  return state({
    issues: [mine(45, 'parked', { delegatedBrief: brief(45), run: '01M4RQ0045AAAA', pr: 545 })],
    runs: [run(45, 'parked', { reviewFixRounds: rounds })],
    ...over,
  })
}
const AT45 = '01M4RQ0045AAAA:review:head45'

function adjudicated(action: AdjudicatorAction, key = `adjudicate:${AT45}`) {
  return entry(key, 'spawn', {
    agent: 'adjudicator',
    class: 'drive',
    issue: 45,
    run: '01M4RQ0045AAAA',
    head: 'head45',
    outcome: review(action, null, ['CORRECT: review-1 a real gap']),
  })
}

// A merge-ready run on #50 (PR 550) and the guard outcomes for it.
function mergeReady(extra: LedgerEntry[] = [], over: Partial<State> = {}) {
  const s = state({
    issues: [mine(50, 'ready to merge', { delegatedBrief: brief(50), pr: 550 })],
    runs: [run(50, 'merge-ready')],
    ...over,
  })
  return { ...s, ledger: [...s.ledger, ...extra] }
}
function guarded(fails: { name: string; reason: string }[] = [], warns: string[] = [], seq = 1, over: Partial<LedgerEntry> = {}) {
  return entry(`guard:550:head50:${seq}`, 'guard', {
    issue: 50,
    pr: 550,
    head: 'head50',
    startedAt: NOW - 2 * MIN,
    endedAt: NOW - 1 * MIN,
    outcome: { kind: 'guard', fails, warns },
    ...over,
  })
}
// The merge adjudicator's answer for PR 550 at a head (SPEC M4), with its report.
function reviewed(action: AdjudicatorAction = { type: 'merge' }, head = 'head50', report: Partial<MergeReport> | null = {}, over: Partial<LedgerEntry> = {}) {
  return entry(`adjudicate-merge:550:${head}`, 'spawn', {
    agent: 'adjudicator',
    class: 'drive',
    issue: 50,
    pr: 550,
    head,
    outcome: review(action, report),
    ...over,
  })
}

describe('G: gates', () => {
  test('a failing factory source makes the pass blind; the owner hears after 15 minutes (I-67, SPEC G2)', () => {
    const base = state({ queue: [7], issues: [issue(7)] })
    const short = plan(failing(base, 'factory', NOW - 5 * MIN), CFG)
    expect(keys(short)).toEqual([])
    expect(short.title).toContain('blind')
    const long = plan(failing(base, 'factory', NOW - 20 * MIN), CFG)
    expect(keys(long)).toEqual([`tell:blind:${NOW - 20 * MIN}`])
  })

  test('the tier comes from the higher window; missing usage is Normal (SKILL:38-45)', () => {
    const u = (fiveHour: number | null, sevenDay: number | null, unavailable = false) => ({ fiveHour, sevenDay, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable })
    expect(tierOf(u(10, 84), CFG, null, NOW).tier).toBe('normal')
    expect(tierOf(u(85, 20), CFG, null, NOW).tier).toBe('slow')
    expect(tierOf(u(10, 90), CFG, null, NOW).tier).toBe('stop-new')
    expect(tierOf(u(95, 10), CFG, null, NOW).tier).toBe('stop-all')
    expect(tierOf(u(null, null, true), CFG, null, NOW).tier).toBe('normal')
  })

  test('a window whose reset has passed counts as zero until the next read (SKILL:47-48)', () => {
    const u = { fiveHour: 97, sevenDay: 80, fiveHourResetsAt: NOW - MIN, sevenDayResetsAt: NOW + 3 * 86_400_000, unavailable: false }
    expect(tierOf(u, CFG, null, NOW).tier).toBe('normal')
    expect(tierOf({ ...u, sevenDay: 91 }, CFG, null, NOW).tier).toBe('stop-new')
    expect(tierOf({ ...u, fiveHourResetsAt: NOW + MIN }, CFG, null, NOW).tier).toBe('stop-all')
  })

  test('an owner override runs past a threshold until it expires (SKILL:49)', () => {
    const u = { fiveHour: 60, sevenDay: 92, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false }
    expect(tierOf(u, CFG, { untilPct: 100, expiresAt: NOW + MIN }, NOW)).toEqual({ tier: 'normal', overridden: true })
    expect(tierOf(u, CFG, { untilPct: 100, expiresAt: NOW - MIN }, NOW).tier).toBe('stop-new')
    expect(tierOf(u, CFG, { untilPct: 91, expiresAt: NOW + MIN }, NOW).tier).toBe('stop-new')
  })

  test('Stop new claims nothing but in-flight work continues (SKILL:41-42)', () => {
    const s = parkedReview({ usage: { fiveHour: 20, sevenDay: 91, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false }, queue: [7] })
    const r = plan({ ...s, issues: [...s.issues, issue(7)] }, CFG)
    expect(r.tier).toBe('stop-new')
    expect(keys(r)).toEqual([`adjudicate:${AT45}`])
  })

  test('Stop all launches nothing, not even an adjudicator, but free work like a merge proceeds (SKILL:43-44)', () => {
    const usage = { fiveHour: 96, sevenDay: 60, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false }
    expect(keys(plan(parkedReview({ usage }), CFG))).toEqual([])
    const r = plan(mergeReady([guarded(), reviewed()], { usage }), CFG)
    expect(keys(r)).toEqual(['merge:550:head50'])
  })

  test('Slow: at most one claim per pass, none soon after the last, none while merging (SKILL:40, D-07)', () => {
    const usage = { fiveHour: 20, sevenDay: 86, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false }
    const s = state({ usage, queue: [7, 8], issues: [issue(7), issue(8)] })
    expect(keys(plan(s, CFG))).toEqual([`claim:7:${NOW - 30 * MIN}`])
    const recent = { ...s, ledger: [...s.ledger, entry('claim:3:x', 'claim', { class: 'start', startedAt: NOW - 5 * MIN })] }
    expect(keys(plan(recent, CFG))).toEqual([])
    const merging = mergeReady([], { usage, queue: [7], issues: [mine(50, 'ready to merge', { pr: 550 }), issue(7)] })
    expect(keys(plan(merging, CFG))).toEqual(['guard:550:head50:1'])
  })

  test('paused issues get no action at all, but claims still renew (MEM 06:45, I-90)', () => {
    const s = parkedReview({ loadedAt: NOW - MIN, control: control({ paused: [45] }) })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual(['heartbeat:' + (NOW - 5 * MIN)])
  })

  test('no new work: nothing claimed or designed, in-flight gates still driven (MEM wind-down)', () => {
    const s = parkedReview({ queue: [7], control: control({ noNewWork: true }) })
    const withDesign = { ...s, issues: [...s.issues, issue(7), mine(9, 'designing')] }
    expect(keys(plan(withDesign, CFG))).toEqual([`adjudicate:${AT45}`])
  })
})

describe('H: housekeeping', () => {
  test('heartbeat first thing after a restart, then every 20 minutes (SKILL:62-63, MEM 05:03 lesson)', () => {
    const holding = state({ issues: [mine(9, 'implementing')], loadedAt: NOW - MIN })
    expect(keys(plan(holding, CFG))).toContain(`heartbeat:${NOW - 5 * MIN}`)
    const settled = { ...holding, loadedAt: NOW - 60 * MIN }
    expect(keys(plan(settled, CFG))).toEqual([])
    const due = {
      ...settled,
      ledger: [entry('heartbeat:1', 'heartbeat', { endedAt: NOW - 21 * MIN }), entry('sweep:0', 'sweep', { endedAt: NOW - MIN })],
    }
    expect(keys(plan(due, CFG))).toEqual([`heartbeat:${NOW - 21 * MIN}`])
  })

  test('a claim starts its own lease: the next heartbeat is due 20 minutes after it (shadow, #522)', () => {
    const claimed = (n: number, at: number) =>
      entry(`claim:${n}:x`, 'claim', { class: 'start', issue: n, startedAt: at, endedAt: at, outcome: { kind: 'claim', result: 'claimed' } })
    const beat = entry('heartbeat:1', 'heartbeat', { endedAt: NOW - 12 * 60 * MIN })
    const sweep = entry('sweep:0', 'sweep', { endedAt: NOW - MIN })
    const fresh = state({ issues: [mine(9, 'implementing')], ledger: [beat, sweep, claimed(9, NOW - MIN)] })
    expect(keys(plan(fresh, CFG))).toEqual([])
    const old = { ...fresh, ledger: [beat, sweep, claimed(9, NOW - 21 * MIN)] }
    expect(keys(plan(old, CFG))).toEqual([`heartbeat:${NOW - 12 * 60 * MIN}`])
    // the stalest lease decides
    const two = { ...fresh, issues: [mine(9, 'implementing'), mine(10, 'implementing')], ledger: [beat, sweep, claimed(9, NOW - MIN)] }
    expect(keys(plan(two, CFG))).toEqual([`heartbeat:${NOW - 12 * 60 * MIN}`])
    // a claim made since the last load counts as renewed since it; a lost claim renews nothing
    expect(keys(plan({ ...fresh, loadedAt: NOW - 10 * MIN }, CFG))).toEqual([])
    const lost = entry('claim:9:y', 'claim', { class: 'start', issue: 9, endedAt: NOW - MIN, outcome: { kind: 'claim', result: 'lost' } })
    expect(keys(plan({ ...fresh, ledger: [beat, sweep, lost] }, CFG))).toEqual([`heartbeat:${NOW - 12 * 60 * MIN}`])
  })

  test('no live claim, no heartbeat; the sweep runs every 30 minutes regardless (SKILL:62-63)', () => {
    const s = state({ loadedAt: NOW - MIN, ledger: [entry('sweep:9', 'sweep', { endedAt: NOW - 31 * MIN })] })
    expect(keys(plan(s, CFG))).toEqual([`sweep:${NOW - 31 * MIN}`])
  })

  test('a clean slot on a merged branch is returned; a dirty or busy one is not (SKILL:150, I-76)', () => {
    const slot = (path: string, over = {}) => ({ path, branch: 'feat/issue-12-x', state: 'leased', dirty: false, busy: false, ...over })
    // merged by the loop, so its rollout follow-ups are its merge's (M7)
    const merged = entry('merge:512:h12', 'merge', { issue: 12, pr: 512, outcome: { kind: 'merge', result: 'merged', rollout: null, closeIssue: null, line: 'merged' } })
    const s = withLedger(
      state({
        issues: [issue(12, { stage: 'merged', holder: DEVICE })],
        pool: { free: 8, total: 16, slots: [slot('/t/1'), slot('/t/2', { dirty: true }), slot('/t/3', { busy: true })] },
      }),
      [merged],
    )
    expect(keys(plan(s, CFG))).toEqual(['release:/t/1:feat/issue-12-x'])
  })
})

describe('P: pipeline gates', () => {
  test('a parked gate goes to the adjudicator with run, branch, brief and step (SKILL:114-115)', () => {
    const r = plan(parkedReview(), CFG)
    expect(keys(r)).toEqual([`adjudicate:${AT45}`])
    expect(find(r, `adjudicate:${AT45}`)).toMatchObject({
      kind: 'spawn',
      agent: 'adjudicator',
      run: '01M4RQ0045AAAA',
      branch: 'feat/issue-45-work',
      step: 'review',
      brief: brief(45),
      model: null,
    })
  })

  test('an issue model label rides on every other sub-agent call (SKILL:101-102)', () => {
    const s = parkedReview()
    const labelled = { ...s, issues: [{ ...s.issues[0]!, labels: ['In development', 'model:opus'] }] }
    expect(find(plan(labelled, CFG), `adjudicate:${AT45}`)).toMatchObject({ model: 'opus' })
  })

  test('three review fix rounds: the owner gets the brief and verdicts, no adjudicator (SKILL:111-113)', () => {
    const s = parkedReview({}, 3)
    const capped = { ...s, runs: [{ ...s.runs[0]!, verdicts: ['CORRECT: a', 'WRONG: b'] }] }
    const r = plan(capped, CFG)
    expect(keys(r)).toEqual(['tell:review-cap:01M4RQ0045AAAA:3'])
    expect(find(r, 'tell:review-cap:01M4RQ0045AAAA:3')).toMatchObject({ fields: { brief: brief(45) }, context: ['CORRECT: a', 'WRONG: b'] })
    expect(r.owner).toBe(1)
    const resumed = { ...capped, control: control({ resumed: [{ subject: 'run:01M4RQ0045AAAA', at: NOW - MIN }] }) }
    expect(keys(plan(resumed, CFG))).toEqual([`adjudicate:${AT45}:r1`])
  })

  test('rounds the loop logged itself count even before the event log has them (SPEC P1)', () => {
    const s = parkedReview({}, 1)
    const fixes = ['h1', 'h2', 'h3'].map(h =>
      entry(`respond:01M4RQ0045AAAA:review:${h}:fix`, 'respond', { run: '01M4RQ0045AAAA', issue: 45 }),
    )
    expect(keys(plan({ ...s, ledger: [...s.ledger, ...fixes] }, CFG))).toEqual(['tell:review-cap:01M4RQ0045AAAA:3'])
  })

  test('without the event log a review gate waits; other gates do not (SPEC P2)', () => {
    const blindFacts = failing(parkedReview(), 'facts', NOW - MIN)
    expect(keys(plan(blindFacts, CFG))).toEqual([])
    const testGate = { ...blindFacts, runs: [{ ...blindFacts.runs[0]!, step: 'test' }] }
    expect(keys(plan(testGate, CFG))).toEqual(['adjudicate:01M4RQ0045AAAA:test:head45'])
  })

  test('ACTION approve, fix and skip become axi respond; a review fix also logs fix_requested (SKILL:118-120)', () => {
    const approve = plan(withLedger(parkedReview(), [adjudicated({ type: 'approve', reason: 'NIT only' })]), CFG)
    expect(keys(approve)).toEqual([`respond:${AT45}:approve`])
    expect(find(approve, `respond:${AT45}:approve`)).toMatchObject({ action: 'approve', approveReason: 'NIT only', logReview: false })
    const fix = plan(
      withLedger(parkedReview(), [adjudicated({ type: 'fix', findings: 'F1', instructions: 'do x', addFinding: null })]),
      CFG,
    )
    expect(find(fix, `respond:${AT45}:fix`)).toMatchObject({ action: 'fix', findings: 'F1', instructions: 'do x', logReview: true })
    const skip = plan(withLedger(parkedReview(), [adjudicated({ type: 'skip' })]), CFG)
    expect(keys(skip)).toEqual([`respond:${AT45}:skip`])
  })

  test('a fix on a test gate does not count as a review round (SKILL:119-120)', () => {
    const s = parkedReview()
    const testGate = { ...s, runs: [{ ...s.runs[0]!, step: 'test' }] }
    const ledger = [adjudicated({ type: 'fix', findings: 'T1', instructions: null, addFinding: null }, 'adjudicate:01M4RQ0045AAAA:test:head45')]
    expect(find(plan(withLedger(testGate, ledger), CFG), 'respond:01M4RQ0045AAAA:test:head45:fix')).toMatchObject({ logReview: false })
  })

  test('escalate goes to the owner; fixer spawns a fixer with the instructions and brief (SKILL:120-122)', () => {
    const esc = plan(withLedger(parkedReview(), [adjudicated({ type: 'escalate', why: 'scope call' })]), CFG)
    expect(keys(esc)).toEqual([`tell:escalate:${AT45}`])
    expect(esc.owner).toBe(1)
    const fixer = plan(withLedger(parkedReview(), [adjudicated({ type: 'fixer', instructions: 'rewrite the parser' })]), CFG)
    expect(find(fixer, `fixer:gate:${AT45}`)).toMatchObject({ agent: 'fixer', instructions: 'rewrite the parser', brief: brief(45) })
  })

  test('a respond that leaves the gate unmoved is tried once more, then the model takes it as a task (D-37, SPEC P3a)', () => {
    const adj = adjudicated({ type: 'approve', reason: null })
    const sent = entry(`respond:${AT45}:approve`, 'respond', { run: '01M4RQ0045AAAA', endedAt: NOW - 20 * MIN })
    expect(keys(plan(withLedger(parkedReview(), [adj, sent]), CFG))).toEqual([`respond:${AT45}:approve:retry`])
    const retried = entry(`respond:${AT45}:approve:retry`, 'respond', { run: '01M4RQ0045AAAA', endedAt: NOW - 16 * MIN })
    const stuck = plan(withLedger(parkedReview(), [adj, sent, retried]), CFG)
    expect(keys(stuck)).toEqual(['task:respond-stuck:01M4RQ0045AAAA:review:head45'])
    expect(find(stuck, 'task:respond-stuck:01M4RQ0045AAAA:review:head45')).toMatchObject({
      kind: 'task',
      class: 'drive',
      fields: { issue: '45', run: '01M4RQ0045AAAA', branch: 'feat/issue-45-work', step: 'review', head: 'head45' },
    })
    // a task for the model, not a notice the owner must act on
    expect(stuck.owner).toBe(0)
    const fresh = entry(`respond:${AT45}:approve`, 'respond', { run: '01M4RQ0045AAAA', endedAt: NOW - 2 * MIN })
    expect(keys(plan(withLedger(parkedReview(), [adj, fresh]), CFG))).toEqual([])
  })

  test('failed with run id unknown is infrastructure: a re-drive, no adjudicator (SKILL:125-127)', () => {
    const s = state({ issues: [mine(46, 'implementing')], runs: [run(46, 'failed', { run: 'unknown', step: null })] })
    expect(keys(plan(s, CFG))).toEqual(['task:redrive:feat/issue-46-work:head46'])
  })

  test('cancelled: the model judges re-drive or drop (SKILL:131)', () => {
    const s = state({ issues: [mine(47, 'implementing')], runs: [run(47, 'cancelled', { step: null })] })
    const key = 'judge:cancelled:01M4RQ0047AAAA:head47'
    expect(keys(plan(s, CFG))).toEqual([key])
    const answer = (d: string) => withLedger(s, [entry(key, 'judge', { wake: 'cancelled', outcome: wakeAnswer(d, { reason: 'stale' }) })])
    expect(keys(plan(answer('redrive'), CFG))).toEqual(['task:redrive:feat/issue-47-work:head47'])
    expect(find(plan(answer('drop'), CFG), 'abandon:47:01M4RQ0047AAAA')).toMatchObject({ kind: 'abandon', note: 'stale' })
  })

  test('a run cancelled by the loop own fixer or re-drive is not judged again (SPEC P4, P5)', () => {
    const s = state({ issues: [mine(47, 'implementing')], runs: [run(47, 'cancelled', { step: null })] })
    const fixer = entry('fixer:gate:x', 'spawn', { agent: 'fixer', issue: 47, status: 'running', endedAt: null })
    expect(keys(plan(withLedger(s, [fixer]), CFG))).toEqual([])
    const redrive = entry('task:redrive:b:h', 'task', { wake: 'redrive', issue: 47, endedAt: NOW - 10 * MIN })
    expect(keys(plan(withLedger(s, [redrive]), CFG))).toEqual([])
    const old = entry('task:redrive:b:h', 'task', { wake: 'redrive', issue: 47, endedAt: NOW - 40 * MIN })
    expect(keys(plan(withLedger(s, [old]), CFG))).toEqual(['judge:cancelled:01M4RQ0047AAAA:head47'])
  })

  test('ci-stalled: no workflow tells the owner; no checks reopens the PR once, then tells (SKILL:132-135)', () => {
    const stalled = (detail: string, ledger: LedgerEntry[] = []) =>
      withLedger(state({ issues: [mine(48, 'in pipeline')], runs: [run(48, 'ci-stalled', { detail })] }), ledger)
    expect(keys(plan(stalled('reason=no-workflow'), CFG))).toEqual(['tell:no-ci:01M4RQ0048AAAA'])
    expect(keys(plan(stalled('reason=no-checks'), CFG))).toEqual(['reopen:548:01M4RQ0048AAAA'])
    const reopened = entry('reopen:548:01M4RQ0048AAAA', 'pr-reopen', { endedAt: NOW - 20 * MIN })
    expect(keys(plan(stalled('reason=no-checks', [reopened]), CFG))).toEqual(['tell:ci-triggers:01M4RQ0048AAAA'])
  })

  test('a run whose issue another device holds, or nobody claimed, is not driven here (SPEC 5.4)', () => {
    const other = state({ issues: [issue(45, { stage: 'parked', holder: OTHER })], runs: [run(45, 'parked')] })
    expect(keys(plan(other, CFG))).toEqual([])
    const unclaimed = state({ issues: [issue(45, { stage: 'parked', holder: null })], runs: [run(45, 'parked')] })
    expect(keys(plan(unclaimed, CFG))).toEqual([])
  })

  test('only the issue current run is acted on: a superseded or older branch is history (SKILL:91, SPEC 5.4)', () => {
    const old = run(49, 'cancelled', { branch: 'feat/issue-49-a', run: '01M4AAAAAAAAAA' })
    const current = run(49, 'running', { branch: 'feat/issue-49-a-v2', run: '01M4ZZZZZZZZZZ' })
    expect(keys(plan(state({ issues: [mine(49, 'in pipeline')], runs: [old, current] }), CFG))).toEqual([])
    const superseded = { ...run(49, 'cancelled'), superseded: true }
    expect(keys(plan(state({ issues: [mine(49, 'implementing')], runs: [superseded] }), CFG))).toEqual([])
  })
})

describe('M: merge', () => {
  test('merge-ready runs the guard first (SKILL:128)', () => {
    expect(keys(plan(mergeReady(), CFG))).toEqual(['guard:550:head50:1'])
    expect(keys(plan(mergeReady([guarded([], [], 1, { status: 'running', endedAt: null })]), CFG))).toEqual([])
  })

  test('a passing guard sends the PR to the merge adjudicator, with pointers only (D-05, SPEC M4)', () => {
    const handoff = entry(`delegate:50:${brief(50)}`, 'delegate', {
      class: 'develop',
      issue: 50,
      outcome: { kind: 'handoff', notGated: false, run: '01M4RQ0050AAAA', head: 'h0', newBranch: null },
    })
    const s = mergeReady([guarded(), handoff], { runs: [run(50, 'merge-ready', { verdicts: ['NIT: x'] })] })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual(['adjudicate-merge:550:head50'])
    expect(find(r, 'adjudicate-merge:550:head50')).toMatchObject({
      kind: 'spawn',
      agent: 'adjudicator',
      purpose: 'merge',
      class: 'drive',
      rule: 'M4',
      pr: 550,
      head: 'head50',
      brief: brief(50),
      handoffHead: 'h0',
      verdicts: ['NIT: x'],
      guard: [],
    })
    // the model is not woken for the review itself
    expect(r.actions.some(a => a.kind === 'judge')).toBe(false)
  })

  test('the merge adjudicator decides: merge, a fixer, or a hold the owner is told of (D-05, SPEC M5, M5a, M5b)', () => {
    const merged = plan(mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', { bump: 'minor', bumpReason: 'new mode' })]), CFG)
    expect(keys(merged)).toEqual(['merge:550:head50'])
    expect(find(merged, 'merge:550:head50')).toMatchObject({ bump: 'minor', bumpReason: 'new mode' })
    const fixer = plan(mergeReady([guarded(), reviewed({ type: 'fixer', instructions: 'restore the requirement' })]), CFG)
    expect(keys(fixer)).toEqual(['fixer:review:550:head50'])
    expect(find(fixer, 'fixer:review:550:head50')).toMatchObject({ purpose: 'review', rule: 'M5b', instructions: 'restore the requirement' })
    const hold = plan(mergeReady([guarded(), reviewed({ type: 'hold', reason: 'the brief asked for a flag' })]), CFG)
    expect(keys(hold)).toEqual(['tell:merge-hold:550:head50'])
    expect(find(hold, 'tell:merge-hold:550:head50')).toMatchObject({ rule: 'M5a', context: ['the brief asked for a flag'] })
    expect(hold.owner).toBe(1)
  })

  test('linkage FAIL runs fix-linkage, then the guard again; a second FAIL tells the owner (SKILL:146)', () => {
    const fail = [{ name: 'linkage', reason: 'MISMATCH (PR must close exactly #50)' }]
    expect(keys(plan(mergeReady([guarded(fail)]), CFG))).toEqual(['fix-linkage:550:head50'])
    const repaired = entry('fix-linkage:550:head50', 'fix-linkage', { pr: 550, startedAt: NOW - 30_000, endedAt: NOW - 20_000 })
    expect(keys(plan(mergeReady([guarded(fail), repaired]), CFG))).toEqual(['guard:550:head50:2'])
    const again = guarded(fail, [], 2, { startedAt: NOW - 10_000, endedAt: NOW - 5_000 })
    expect(keys(plan(mergeReady([guarded(fail), repaired, again]), CFG))).toEqual(['tell:linkage:550:head50'])
  })

  test('behind its base: update-behind; FAIL gets a re-gate fixer; SKIP retries, then tells (SKILL:130, 138)', () => {
    const behind = [{ name: 'mergeable', reason: 'behind main, run update-behind first' }]
    expect(keys(plan(mergeReady([guarded(behind)]), CFG))).toEqual(['update-behind:550:head50'])
    const ub = (result: 'updated' | 'fail' | 'skip', over: Partial<LedgerEntry> = {}) =>
      entry('update-behind:550:head50', 'update-behind', {
        pr: 550,
        head: 'head50',
        outcome: { kind: 'update-behind', result, from: 'head50', to: result === 'updated' ? 'head51' : null, line: `UPDATE-BEHIND ${result}` },
        ...over,
      })
    expect(keys(plan(mergeReady([guarded(behind), ub('updated')]), CFG))).toEqual([])
    expect(find(plan(mergeReady([guarded(behind), ub('fail')]), CFG), 'fixer:regate:550:head50')).toMatchObject({
      purpose: 'regate',
      instructions: 'UPDATE-BEHIND fail',
    })
    const skipped = ub('skip', { status: 'failed', attempts: 1, endedAt: NOW - 6 * MIN })
    expect(keys(plan(mergeReady([guarded(behind), skipped]), CFG))).toEqual(['update-behind:550:head50'])
    const exhausted = ub('skip', { status: 'failed', attempts: 4, endedAt: NOW - 6 * MIN })
    expect(keys(plan(mergeReady([guarded(behind), exhausted]), CFG))).toEqual(['tell:update-behind:550:head50'])
  })

  test('after a rebase-only update the review carries over to the new head (SKILL:130, SPEC M5)', () => {
    const moved = entry('update-behind:550:head50', 'update-behind', {
      pr: 550,
      head: 'head50',
      outcome: { kind: 'update-behind', result: 'updated', from: 'head50', to: 'head51', line: 'UPDATED' },
    })
    const s = mergeReady(
      [reviewed({ type: 'merge' }, 'head50'), moved, entry('guard:550:head51:1', 'guard', { pr: 550, head: 'head51', endedAt: NOW - MIN, outcome: { kind: 'guard', fails: [], warns: [] } })],
      { runs: [run(50, 'head-mismatch', { head: 'head51' })] },
    )
    expect(keys(plan(s, CFG))).toEqual(['merge:550:head51'])
  })

  test('a conflict gets a fixer that keeps both sides (SKILL:129-130)', () => {
    const r = plan(mergeReady([guarded([{ name: 'mergeable', reason: 'conflicts with main, rebase and re-gate' }])]), CFG)
    expect(find(r, 'fixer:conflict:550:head50')).toMatchObject({ purpose: 'conflict' })
    expect((find(r, 'fixer:conflict:550:head50') as Extract<Action, { agent: 'fixer' }>).instructions).toContain('Keep both sides')
  })

  test('pending CI waits for the recheck; a failed check goes to the model (SKILL:139)', () => {
    const pending = [{ name: 'checks', reason: 'ci=pending' }]
    expect(keys(plan(mergeReady([guarded(pending)]), CFG))).toEqual([])
    const stale = guarded(pending, [], 1, { endedAt: NOW - 4 * MIN })
    expect(keys(plan(mergeReady([stale]), CFG))).toEqual(['guard:550:head50:2'])
    const failed = [{ name: 'checks', reason: 'ci=fail' }]
    expect(keys(plan(mergeReady([guarded(failed)]), CFG))).toEqual(['judge:guard-fail:550:head50:1'])
  })

  test('an untrusted PR author is never merged and the owner is told (I-11.5, SPEC M2)', () => {
    const r = plan(mergeReady([guarded([{ name: 'author', reason: 'PR #550 was not opened by a trusted author' }])]), CFG)
    expect(keys(r)).toEqual(['tell:untrusted-pr:550'])
  })

  test('a test-weakening WARN goes to the adjudicator; an accepted one is justified on the PR (SKILL:143-144)', () => {
    const warn = ['GUARD test-weakening WARN 89eff63 step=none files=t.sh kinds=or-true - have the adjudicator judge it']
    expect(keys(plan(mergeReady([guarded([], warn)]), CFG))).toEqual(['adjudicate-weakening:550:head50'])
    const judged = entry('adjudicate-weakening:550:head50', 'spawn', {
      agent: 'adjudicator',
      outcome: review({ type: 'approve', reason: 'new file' }, null, ['WRONG: || true is in a new file']),
    })
    const r = plan(mergeReady([guarded([], warn), judged]), CFG)
    expect(keys(r)).toEqual(['pr-comment:550:head50'])
    const commented = entry('pr-comment:550:head50', 'pr-comment', { pr: 550, endedAt: NOW - 30_000 })
    const after = plan(mergeReady([guarded([], warn), judged, commented]), CFG)
    expect(keys(after)).toEqual(['adjudicate-merge:550:head50'])
    // the merge adjudicator sees the WARN lines among the guard's
    expect(find(after, 'adjudicate-merge:550:head50')).toMatchObject({ guard: warn })
  })

  test('an escalated test-weakening review holds until the owner resumes the run, which asks again (SPEC M3)', () => {
    const warn = ['GUARD test-weakening WARN 89eff63 step=none files=t.sh kinds=or-true - have the adjudicator judge it']
    const escalated = entry('adjudicate-weakening:550:head50', 'spawn', {
      agent: 'adjudicator',
      endedAt: NOW - 10 * MIN,
      outcome: review({ type: 'escalate', why: 'the brief does not say' }),
    })
    const told = entry('tell:escalate:pr:550:head50', 'tell', { wake: 'escalate', issue: 50 })
    const s = mergeReady([guarded([], warn), escalated, told])
    expect(keys(plan(s, CFG))).toEqual([])
    const resumed = { ...s, control: control({ resumed: [{ subject: 'run:01M4RQ0050AAAA', at: NOW - MIN }] }) }
    expect(keys(plan(resumed, CFG))).toEqual(['adjudicate-weakening:550:head50:r1'])
  })

  test('a refused merge goes to the owner with the guard output (SKILL:148-149)', () => {
    const refused = entry('merge:550:head50', 'merge', {
      pr: 550,
      head: 'head50',
      outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line: 'GitHub refused: branch rules' },
    })
    expect(keys(plan(mergeReady([guarded(), reviewed(), refused]), CFG))).toEqual(['tell:merge-refused:550:head50'])
  })

  test('after a merge, the rollout decides the follow-up (SKILL:84-89, 165)', () => {
    const merged = (rollout: 'merge' | 'run-it' | 'keep-open', closeIssue: number | null = null) =>
      entry('merge:550:head50', 'merge', {
        issue: 50,
        pr: 550,
        head: 'head50',
        outcome: { kind: 'merge', result: 'merged', rollout, closeIssue, line: 'merged' },
      })
    const milestone = { open: 2, closed: 1, expected: 'patch' as const }
    const base = (e: LedgerEntry, extra: LedgerEntry[] = []) => {
      const s = state({ milestone })
      return { ...s, ledger: [...s.ledger, e, ...extra] }
    }
    expect(keys(plan(base(merged('merge')), CFG))).toEqual([])
    expect(keys(plan(base(merged('merge', 50)), CFG))).toEqual(['close:50'])
    expect(keys(plan(base(merged('run-it')), CFG))).toEqual(['milestone-later:50', 'task:run-it:50'])
    expect(keys(plan(base(merged('keep-open')), CFG))).toEqual(['milestone-later:50'])
    const bumped = plan(base(merged('merge'), [reviewed({ type: 'merge' }, 'head50', { bump: 'minor', bumpReason: 'new mode' })]), CFG)
    expect(find(bumped, 'expect:minor:550')).toMatchObject({ bump: 'minor', why: 'new mode' })
    // a bump no higher than the milestone's Expected changes nothing
    expect(keys(plan(base(merged('merge'), [reviewed({ type: 'merge' }, 'head50', { bump: 'patch' })]), CFG))).toEqual([])
  })

  test('a guard older than 30 minutes is run again (SPEC M1)', () => {
    expect(keys(plan(mergeReady([guarded([], [], 1, { endedAt: NOW - 31 * MIN })]), CFG))).toEqual(['guard:550:head50:2'])
  })
})

describe('D: design and delegation', () => {
  test('ready, unblocked issues are claimed oldest first, up to four a pass (SKILL:30-31, 71)', () => {
    const queue = [9, 3, 5, 1, 7]
    const s = state({ queue, issues: queue.map(n => issue(n)) })
    expect(keys(plan(s, CFG))).toEqual([1, 3, 5, 7].map(n => `claim:${n}:${NOW - 30 * MIN}`))
  })

  test('candidates: no tracker, nothing blocked, nothing untrusted, nothing held elsewhere (SKILL:30-31, MEM trackers)', () => {
    const s = state({
      queue: [1, 2, 3, 4, 5, 6, 7, 8],
      issues: [
        issue(1, { subIssues: 4 }),
        issue(2, { blockedBy: 1 }),
        issue(3, { trusted: false }),
        issue(4, { labels: ['enhancement'] }),
        issue(5, { labels: ['ready', 'parked'] }),
        issue(6, { stage: 'designing', holder: OTHER }),
        issue(7),
        issue(8, { epic: true }),
      ],
    })
    const r = plan(s, config({ skipLabels: ['parked'] }))
    expect(keys(r)).toEqual([`claim:7:${NOW - 30 * MIN}`])
    const why = Object.fromEntries(r.skipped.filter(x => x.rule === 'D1').map(x => [x.issue, x.why]))
    expect(why).toEqual({
      1: 'tracker (has sub-issues)',
      2: 'blocked by 1 open issue',
      3: 'untrusted author',
      4: 'no ready label',
      5: 'label parked',
      6: 'stage designing',
      8: 'tracker (title)',
    })
  })

  test('owner priority goes first; serial waits for the live issue; skip is never claimed (MEM 08:50)', () => {
    const s = state({ queue: [1, 2, 3], issues: [issue(1), issue(2), issue(3)] })
    expect(keys(plan({ ...s, control: control({ priority: [3], skip: [2] }) }, CFG))).toEqual([
      `claim:3:${NOW - 30 * MIN}`,
      `claim:1:${NOW - 30 * MIN}`,
    ])
    const busy = { ...s, issues: [...s.issues, mine(9, 'implementing')], control: control({ serial: true }) }
    expect(keys(plan(busy, CFG))).toEqual([])
  })

  test('only: just the listed issues are claimed, in its order; no new work still wins (shadow, #522)', () => {
    const s = state({ queue: [1, 2, 3, 4], issues: [issue(1), issue(2), issue(3), issue(4)] })
    const only = plan({ ...s, control: control({ only: [4, 2], priority: [1] }) }, CFG)
    expect(keys(only)).toEqual([`claim:4:${NOW - 30 * MIN}`, `claim:2:${NOW - 30 * MIN}`])
    expect(only.skipped.filter(k => k.issue === 1 || k.issue === 3).map(k => k.why)).toEqual([
      'owner: only #4 #2',
      'owner: only #4 #2',
    ])
    const winding = plan({ ...s, control: control({ only: [4], noNewWork: true }) }, CFG)
    expect(keys(winding)).toEqual([])
    // work in flight on an unlisted issue goes on
    const inFlight = parkedReview({ queue: [7], control: control({ only: [8] }) })
    expect(keys(plan({ ...inFlight, issues: [...inFlight.issues, issue(7)] }, CFG))).toEqual([`adjudicate:${AT45}`])
  })

  test('the worktree pool bounds new work (SKILL:103-104)', () => {
    const s = state({ queue: [1, 2], issues: [issue(1), issue(2)], pool: { free: 3, total: 16, slots: [] } })
    expect(keys(plan(s, CFG))).toEqual([`claim:1:${NOW - 30 * MIN}`])
  })

  test('an implementer lost before any run is delegated again, then reported (SPEC D4, A1)', () => {
    const lost = (over: Partial<LedgerEntry>) =>
      entry(`delegate:63:${brief(63)}`, 'delegate', { class: 'develop', issue: 63, status: 'lost', attempts: 1, agentId: 'a63', ...over })
    const s = state({ issues: [mine(63, 'implementing')] })
    expect(keys(plan(withLedger(s, [lost({})]), CFG))).toEqual([`delegate:63:${brief(63)}`])
    expect(keys(plan(withLedger(s, [lost({ status: 'done' })]), CFG))).toEqual([])
    expect(keys(plan(withLedger(s, [lost({ status: 'failed', attempts: 2 })]), CFG))).toEqual([`tell:agent-failed:delegate:63:${brief(63)}`])
    const withRun = { ...s, runs: [run(63, 'running')] }
    expect(keys(plan(withLedger(withRun, [lost({})]), CFG))).toEqual([])
  })

  test('design counts against the pool: an issue in design will need a worktree (SKILL:103-104)', () => {
    const s = state({ queue: [1, 2], issues: [issue(1), issue(2), mine(9, 'designing')], pool: { free: 4, total: 16, slots: [] } })
    expect(keys(plan(withLedger(s, [entry(`design:9:${NOW - 30 * MIN}`, 'spawn', { agent: 'designer', status: 'running', endedAt: null })]), CFG))).toEqual([
      `claim:1:${NOW - 30 * MIN}`,
    ])
  })

  test('a claim another device won is not retried this life (SKILL:71-72)', () => {
    const lost = entry(`claim:1:${NOW - 30 * MIN}`, 'claim', { class: 'start', outcome: { kind: 'claim', result: 'lost' } })
    const s = state({ queue: [1], issues: [issue(1)] })
    expect(keys(plan({ ...s, ledger: [...s.ledger, lost] }, CFG))).toEqual([])
  })

  test('a claimed issue with no brief gets a designer with the owner notes (SKILL:73-75)', () => {
    const s = state({
      issues: [mine(60, 'designing', { stageSince: NOW - 2 * MIN }), issue(61, { stage: 'designing', holder: OTHER })],
      control: control({ notes: [{ issue: 60, text: 'keep the 175-line cap', at: NOW - MIN }] }),
    })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual([`design:60:${NOW - 2 * MIN}`])
    expect(find(r, `design:60:${NOW - 2 * MIN}`)).toMatchObject({ agent: 'designer', notes: ['keep the 175-line cap'] })
  })

  const designed = (result: Extract<LedgerEntry['outcome'], { kind: 'designer' }>) =>
    entry(`design:60:${NOW - 20 * MIN}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, outcome: result })
  const designing = (extra: LedgerEntry[], over: Partial<State> = {}) => {
    const s = state({ issues: [mine(60, 'designing', { stageSince: NOW - 20 * MIN })], ...over })
    return { ...s, ledger: [...s.ledger, ...extra] }
  }

  test('a pending owner decision is surfaced and waits; a resume designs again (SKILL:76, 155)', () => {
    const pending = designed({ kind: 'designer', brief: brief(60), created: [], pendingDecision: true })
    const r = plan(designing([pending]), CFG)
    expect(keys(r)).toEqual([`tell:decision:60:${brief(60)}`])
    expect(r.owner).toBe(1)
    const resumed = designing([pending], { control: control({ resumed: [{ subject: 'issue:60', at: NOW - MIN }] }) })
    expect(keys(plan(resumed, CFG))).toEqual([`design:60:${NOW - 20 * MIN}:r1`])
  })

  test('a split releases the parent: label off, abandoned logged (SKILL:76-78)', () => {
    const split = designed({ kind: 'designer', brief: brief(60), created: [61, 62], pendingDecision: false })
    expect(find(plan(designing([split]), CFG), 'release-parent:60')).toMatchObject({ created: [61, 62] })
  })

  test('a brief with no pending decision is delegated by URL (SKILL:79-81)', () => {
    const ok = designed({ kind: 'designer', brief: brief(60), created: [], pendingDecision: false })
    expect(find(plan(designing([ok]), CFG), `delegate:60:${brief(60)}`)).toMatchObject({ kind: 'delegate', brief: brief(60), class: 'develop' })
  })

  test('a designer reply with no RESULT line goes to the model, and its answer is used (SPEC 7.2)', () => {
    const unparsed = designed({ kind: 'designer', unparsed: true })
    const reportKey = `judge:report:design:60:${NOW - 20 * MIN}`
    expect(keys(plan(designing([unparsed]), CFG))).toEqual([reportKey])
    const answered = entry(reportKey, 'judge', {
      wake: 'report',
      outcome: wakeAnswer('parsed', { fields: { brief: brief(60), created: [], pendingDecision: false } }),
    })
    expect(keys(plan(designing([unparsed, answered]), CFG))).toEqual([`delegate:60:${brief(60)}`])
  })

  test('a brief posted this life with no designer record is confirmed by the model, not redesigned (SPEC 7.5)', () => {
    const s = state({ issues: [mine(60, 'designing', { stageSince: NOW - 20 * MIN, brief: { url: brief(60), at: NOW - 10 * MIN } })] })
    expect(keys(plan(s, CFG))).toEqual([`judge:report:brief:60:${brief(60)}`])
  })

  test('a handoff that says NOT GATED goes to the model (implement-issue section 8)', () => {
    const handoff = entry('delegate:61:x', 'delegate', {
      issue: 61,
      outcome: { kind: 'handoff', notGated: true, run: 'R', head: 'H', newBranch: null },
    })
    const s = state({ issues: [mine(61, 'implementing')] })
    expect(keys(plan({ ...s, ledger: [...s.ledger, handoff] }, CFG))).toEqual(['judge:handoff:delegate:61:x'])
  })

  test('an issue the owner dropped is abandoned (SKILL:92)', () => {
    const s = state({ issues: [mine(62, 'implementing')], control: control({ dropped: [{ issue: 62, at: NOW - MIN }] }) })
    expect(keys(plan(s, CFG))).toEqual([`abandon:62:${NOW - MIN}`])
  })
})

describe('A: agents', () => {
  const agentEntry = (over: Partial<LedgerEntry>) =>
    entry('delegate:70:x', 'delegate', { status: 'running', agentId: 'a70', issue: 70, startedAt: NOW - 10 * MIN, endedAt: null, ...over })

  test('an agent past its timeout is stopped (SPEC A1)', () => {
    const s = state({ issues: [mine(70, 'implementing')] })
    expect(keys(plan({ ...s, ledger: [...s.ledger, agentEntry({ startedAt: NOW - 121 * MIN })] }, CFG))).toEqual(['stop:a70'])
  })

  test('an issue closed, or claimed by another device, stops its agents (SPEC A2)', () => {
    const closed = state({ issues: [mine(70, 'implementing', { open: false })] })
    expect(keys(plan({ ...closed, ledger: [...closed.ledger, agentEntry({})] }, CFG))).toEqual(['stop:a70'])
    const taken = state({ issues: [issue(70, { stage: 'implementing', holder: OTHER })] })
    expect(keys(plan({ ...taken, ledger: [...taken.ledger, agentEntry({})] }, CFG))).toEqual(['stop:a70', `tell:claim-lost:70:${OTHER}`])
  })

  test('an agent whose attempts ran out is reported to the owner (SPEC A1)', () => {
    const failedTwice = entry(`design:60:${NOW - 20 * MIN}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'failed', attempts: 2 })
    const s = state({ issues: [mine(60, 'designing', { stageSince: NOW - 20 * MIN })] })
    expect(keys(plan({ ...s, ledger: [...s.ledger, failedTwice] }, CFG))).toEqual([`tell:agent-failed:design:60:${NOW - 20 * MIN}`])
  })
})

describe('O: owner and report', () => {
  test('one wake per pass, owner decisions first; none while a wake is open (SPEC O2)', () => {
    const s = state({
      issues: [mine(60, 'designing', { stageSince: NOW - 20 * MIN }), mine(47, 'implementing')],
      runs: [run(47, 'cancelled', { step: null })],
    })
    const pending = entry(`design:60:${NOW - 20 * MIN}`, 'spawn', {
      agent: 'designer',
      issue: 60,
      outcome: { kind: 'designer', brief: brief(60), created: [], pendingDecision: true },
    })
    const both = { ...s, ledger: [...s.ledger, pending] }
    expect(keys(plan(both, CFG))).toEqual([`tell:decision:60:${brief(60)}`])
    const open = { ...both, ledger: [...both.ledger, entry('judge:x', 'judge', { status: 'running', endedAt: null })] }
    expect(keys(plan(open, CFG))).toEqual([])
  })

  test('Next release with no open items: the model runs the release (SKILL:166-167)', () => {
    const s = state({ milestone: { open: 0, closed: 2, expected: 'minor' } })
    expect(keys(plan(s, CFG))).toEqual(['task:release:2:minor'])
    expect(keys(plan(state({ milestone: { open: 1, closed: 2, expected: 'minor' } }), CFG))).toEqual([])
  })

  test('the title: counts of queue, in progress and merged in 6 hours, no usage (D-23, SPEC 9.1)', () => {
    const s = state({
      usage: { fiveHour: 67, sevenDay: 86, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false },
      queue: [1, 2, 3],
      issues: [
        issue(1),
        issue(2),
        issue(3),
        mine(9, 'implementing'),
        mine(10, 'designing'),
        mine(11, 'parked'),
        issue(12, { stage: 'ready to merge', holder: OTHER }),
        issue(13, { stage: 'merged', stageSince: NOW - 5 * 60 * MIN }),
        issue(14, { stage: 'merged', stageSince: NOW - 7 * 60 * MIN }),
        issue(15, { stage: 'closed without merge', stageSince: NOW - MIN }),
      ],
    })
    // Slow holds no work, so it adds no word; usage is never shown
    expect(plan(s, CFG).title).toBe('🔄 dev-system (Q:3 - D:4 - M:1) · observe')
    expect(plan(s, config({ mode: 'act' })).title).toBe('🔄 dev-system (Q:3 - D:4 - M:1)')
  })

  test('the title adds a word only for what needs attention (D-23, SPEC 9.1)', () => {
    const u = (fiveHour: number) => ({ fiveHour, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false })
    expect(plan(state({ usage: u(91) }), CFG).title).toBe('🔄 dev-system (Q:0 - D:0 - M:0) · observe · stop new')
    expect(plan(state({ usage: u(96) }), CFG).title).toBe('🔄 dev-system (Q:0 - D:0 - M:0) · observe · stop all')
    const stuck = state({ issues: [mine(9, 'implementing', { stuck: 'S3' })], githubBackoffUntil: NOW + MIN })
    expect(plan(stuck, CFG).title).toBe('🔄 dev-system (Q:0 - D:1 - M:0) · observe · stuck 1 · gh wait')
    // a blind pass has no counts: blind takes their place
    expect(plan(failing(state({ queue: [7] }), 'factory', NOW - 5 * MIN), CFG).title).toBe('🔄 dev-system · observe · blind')
    const owner = plan(parkedReview({}, 3), CFG)
    expect(owner.title).toBe('🔄 dev-system (Q:0 - D:1 - M:0) · observe · owner 1')
  })

  test('the title is set only when it changes (FINDINGS check 3)', () => {
    const s = state()
    const first = plan(s, CFG)
    expect(first.actions.some(a => a.kind === 'title')).toBe(true)
    expect(plan({ ...s, lastTitle: first.title }, CFG).actions).toEqual([])
  })

  test('a model task that timed out is reported; a timed-out judge just holds (SPEC 8.2)', () => {
    const merged = entry('merge:550:head50', 'merge', {
      issue: 50,
      pr: 550,
      head: 'head50',
      outcome: { kind: 'merge', result: 'merged', rollout: 'run-it', closeIssue: null, line: 'merged' },
    })
    const timedOut = entry('task:run-it:50', 'task', { wake: 'run-it', status: 'timed-out', attempts: 1, class: 'drive', issue: 50 })
    expect(keys(plan(withLedger(state(), [merged, timedOut]), CFG))).toEqual(['tell:task-timeout:task:run-it:50'])
    const judgeOut = entry('judge:sequence:550:head50', 'judge', { wake: 'sequence', status: 'timed-out', attempts: 1, pr: 550, head: 'head50' })
    const r = plan(mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', { flags: ['image'] }), judgeOut]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.owner).toBe(1)
    expect(r.skipped).toContainEqual({ rule: 'M5', issue: 50, why: 'exhausted: judge:sequence:550:head50' })
  })

  test('free rechecks never trip the per-issue cap (SPEC 11.4)', () => {
    const guards = Array.from({ length: 8 }, (_, i) =>
      entry(`guard:550:old${i}:1`, 'guard', { issue: 50, pr: 550, head: `old${i}`, startedAt: NOW - (50 - i) * MIN, endedAt: NOW - (49 - i) * MIN }),
    )
    expect(keys(plan(mergeReady(guards), CFG))).toEqual(['guard:550:head50:1'])
  })

  test('a runaway class is closed at its cap and the owner is told once (SPEC 11.4)', () => {
    const claims = Array.from({ length: 30 }, (_, i) => entry(`claim:${100 + i}:x`, 'claim', { class: 'start', startedAt: NOW - 30 * MIN }))
    const s = state({ queue: [1], issues: [issue(1)] })
    expect(keys(plan({ ...s, ledger: [...s.ledger, ...claims] }, CFG))).toEqual([`tell:runaway:start:${Math.floor(NOW / 3_600_000)}`])
  })

  test('three failures in a row close an executor kind for 30 minutes (SPEC 11.4)', () => {
    const fails = [1, 2, 3].map(i =>
      entry(`guard:9${i}:h:1`, 'guard', { status: 'failed', attempts: 3, startedAt: NOW - (20 - i) * MIN, endedAt: NOW - (19 - i) * MIN }),
    )
    const r = plan(mergeReady(fails), CFG)
    expect(keys(r)).toEqual([`tell:breaker:guard:${NOW - 16 * MIN}`])
  })

  test('a GitHub rate limit holds GitHub writes and shows in the title (SPEC 10.2)', () => {
    const s = state({ queue: [1], issues: [issue(1)], githubBackoffUntil: NOW + 5 * MIN })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual([])
    expect(r.title).toContain('gh wait')
  })
})

describe('H4: restart for an update (D-15)', () => {
  const due = (at = NOW - 10 * MIN) => control({ updateDue: { reason: 'base image 1.2.3', at } })
  const designer = entry(`design:60:${NOW - 30 * MIN}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'running', endedAt: null, agentId: 'a60' })

  test('while an update is due the loop drains: no claim, no agent, no wake that drives work (SPEC H4)', () => {
    const s = withLedger(parkedReview({ queue: [7], control: due() }), [designer])
    const r = plan({ ...s, issues: [...s.issues, issue(7), mine(60, 'designing')] }, CFG)
    expect(keys(r)).toEqual([])
    const why = r.skipped.map(x => x.why)
    expect(why).toContain('update due: draining (spawn)')
    expect(why).toContain('update due: draining (claim)')
    expect(why).toContain(`update due: draining, waiting on design:60:${NOW - 30 * MIN}`)
    // free work goes on, so a reviewed PR still merges, and the restart waits for it
    const merging = plan(mergeReady([guarded(), reviewed()], { control: due() }), CFG)
    expect(keys(merging)).toEqual(['merge:550:head50'])
    expect(merging.skipped).toContainEqual({ rule: 'H4', issue: null, why: 'update due: this pass has other actions to finish first' })
  })

  test('once nothing is in flight it restarts, after every other action (SPEC H4)', () => {
    const at = NOW - 10 * MIN
    const r = plan(state({ control: due(at) }), CFG)
    expect(keys(r)).toEqual([`restart:${at}`])
    expect(find(r, `restart:${at}`)).toMatchObject({ kind: 'restart-self', class: 'free', rule: 'H4', why: 'base image 1.2.3', at })
    expect(r.actions.map(a => a.kind)).toEqual(['title', 'restart-self'])
    // parked and merge-ready runs are safe; a running or pending one, of any device, is not
    const parked = state({ control: due(at), issues: [mine(45, 'parked')], runs: [run(45, 'parked')] })
    expect(keys(plan(parked, CFG))).toContain(`restart:${at}`)
    for (const live of ['running', 'pending'] as const) {
      const busy = state({ control: due(at), issues: [issue(80, { stage: 'in pipeline', holder: OTHER })], runs: [run(80, live)] })
      const held = plan(busy, CFG)
      expect(keys(held)).toEqual([])
      expect(held.skipped).toContainEqual({ rule: 'H4', issue: null, why: `update due: draining, waiting on run 01M4RQ0080AAAA ${live}` })
    }
    // an open wake, or runs that cannot be seen, hold it too
    expect(keys(plan(withLedger(state({ control: due(at) }), [entry('tell:x', 'tell', { status: 'running', endedAt: null })]), CFG))).toEqual([])
    expect(keys(plan(failing(state({ control: due(at) }), 'runs', NOW - MIN), CFG))).toEqual([])
    // one restart per request: done, or exhausted and named
    expect(keys(plan(withLedger(state({ control: due(at) }), [entry(`restart:${at}`, 'restart-self')]), CFG))).toEqual([])
    const failed = plan(withLedger(state({ control: due(at) }), [entry(`restart:${at}`, 'restart-self', { status: 'failed' })]), CFG)
    expect(keys(failed)).toEqual([])
    expect(failed.skipped).toContainEqual({ rule: 'H4', issue: null, why: `exhausted: restart:${at}` })
  })

  test('a drain past an hour tells the owner once, with what it waits on (SPEC H4)', () => {
    const slow = withLedger(state({ control: due(NOW - 61 * MIN), issues: [mine(60, 'designing')] }), [designer])
    const r = plan(slow, CFG)
    expect(keys(r)).toEqual([`tell:drain-slow:${NOW - 61 * MIN}`])
    expect(find(r, `tell:drain-slow:${NOW - 61 * MIN}`)).toMatchObject({
      class: 'owner',
      context: ['update: base image 1.2.3', `waiting on: design:60:${NOW - 30 * MIN}`],
    })
    expect(r.owner).toBe(0)
    expect(keys(plan({ ...slow, control: due(NOW - 59 * MIN) }, CFG))).toEqual([])
  })
})

describe('M5: release sequencing of a reviewed merge (D-05)', () => {
  test('a flag that needs a call asks the model to sequence it, from the report lines and never the diff (SPEC M5)', () => {
    const report = { summary: 'the dev image gains a PostgreSQL 17 server', bump: 'minor' as const, bumpReason: 'a new server', flags: ['image' as const] }
    const r = plan(mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', report)]), CFG)
    expect(keys(r)).toEqual(['judge:sequence:550:head50'])
    expect(find(r, 'judge:sequence:550:head50')).toMatchObject({
      kind: 'judge',
      wake: 'sequence',
      rule: 'M5',
      fields: { pr: '550', issue: '50', head: 'head50', flags: 'image', bump: 'minor' },
      context: ['SUMMARY: the dev image gains a PostgreSQL 17 server', 'BUMP: minor a new server', 'FLAGS: image'],
    })
    // a major bump, a run-it rollout and a template change need the call too; a restart alone does not
    const calls: Partial<MergeReport>[] = [{ bump: 'major' }, { flags: ['run-it'] }, { flags: ['template'] }]
    for (const c of calls) expect(keys(plan(mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', c)]), CFG))).toEqual(['judge:sequence:550:head50'])
    expect(keys(plan(mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', { flags: ['restart'] })]), CFG))).toEqual(['merge:550:head50'])
  })

  test('the sequencing answer merges or holds (SPEC M5, M5a)', () => {
    const flagged = reviewed({ type: 'merge' }, 'head50', { flags: ['image'] })
    const answer = (d: string, reason: string | null = null) =>
      entry('judge:sequence:550:head50', 'judge', { wake: 'sequence', issue: 50, pr: 550, head: 'head50', outcome: wakeAnswer(d, { reason }) })
    expect(keys(plan(mergeReady([guarded(), flagged, answer('merge')]), CFG))).toEqual(['merge:550:head50'])
    const held = plan(mergeReady([guarded(), flagged, answer('hold', 'wait for the image release')]), CFG)
    expect(keys(held)).toEqual(['tell:merge-hold:550:head50'])
    expect(find(held, 'tell:merge-hold:550:head50')).toMatchObject({ context: ['wait for the image release'] })
    expect(held.owner).toBe(1)
  })

  test('a hold lasts until the head moves or the owner resumes the run, which asks for a fresh review (SPEC M5a)', () => {
    const hold = reviewed({ type: 'hold', reason: 'scope creep' })
    const told = entry('tell:merge-hold:550:head50', 'tell', { wake: 'merge-hold', issue: 50 })
    const s = mergeReady([guarded(), hold, told])
    const r = plan(s, CFG)
    expect(keys(r)).toEqual([])
    expect(r.owner).toBe(1)
    // a resume from before the hold does not release it
    const early = { ...s, control: control({ resumed: [{ subject: 'run:01M4RQ0050AAAA', at: NOW - 20 * MIN }] }) }
    expect(keys(plan(early, CFG))).toEqual([])
    const resumed = { ...s, control: control({ resumed: [{ subject: 'run:01M4RQ0050AAAA', at: NOW - MIN }] }) }
    expect(keys(plan(resumed, CFG))).toEqual(['adjudicate-merge:550:head50:r1'])
    // a new head is a new review
    const moved = mergeReady([guarded([], [], 1, { key: 'guard:550:head51:1', head: 'head51' }), hold, told], {
      runs: [run(50, 'merge-ready', { head: 'head51' })],
    })
    expect(keys(plan(moved, CFG))).toEqual(['adjudicate-merge:550:head51'])
  })

  test('a run-it PR waits while another merged run-it issue waits for its Run it (SPEC M5)', () => {
    const other = entry('merge:560:head60', 'merge', {
      issue: 60,
      pr: 560,
      head: 'head60',
      outcome: { kind: 'merge', result: 'merged', rollout: 'run-it', closeIssue: null, line: 'merged' },
    })
    const runIt = reviewed({ type: 'merge' }, 'head50', { flags: ['run-it'] })
    const r = plan(mergeReady([guarded(), runIt, other]), CFG)
    expect(keys(r)).toEqual(['task:run-it:60'])
    expect(r.skipped).toContainEqual({ rule: 'M5', issue: 50, why: 'run-it: waits for the Run it of #60' })
    const ran = entry('task:run-it:60', 'task', { wake: 'run-it', issue: 60, outcome: wakeAnswer('done') })
    expect(keys(plan(mergeReady([guarded(), runIt, other, ran]), CFG))).toEqual(['judge:sequence:550:head50'])
    // a Run it held for the owner's release approval still holds the next run-it PR, until the
    // owner resumes the issue
    const held = entry('task:run-it:60', 'task', { wake: 'run-it', issue: 60, endedAt: NOW - 10 * MIN, outcome: wakeAnswer('hold') })
    const waiting = mergeReady([guarded(), runIt, other, held])
    expect(keys(plan(waiting, CFG))).toEqual([])
    const resumed = { ...waiting, control: control({ resumed: [{ subject: 'issue:60', at: NOW - MIN }] }) }
    expect(keys(plan(resumed, CFG))).toEqual(['judge:sequence:550:head50'])
  })

  test('an ACTION that does not answer a merge review is not acted on (SPEC 7.3)', () => {
    const r = plan(mergeReady([guarded(), reviewed({ type: 'approve', reason: null })]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'M4', issue: 50, why: 'merge adjudicator: ACTION approve does not answer a merge review' })
  })
})

describe('M7: follow-ups for hand merges (D-29)', () => {
  const handMerged = (over: Partial<IssueView> = {}) => mine(70, 'merged', { stageSince: NOW - 30 * MIN, pr: 570, ...over })
  const loopMerge = (result: 'merged' | 'refused') =>
    entry('merge:570:h7', 'merge', { issue: 70, pr: 570, head: 'h7', outcome: { kind: 'merge', result, rollout: 'merge', closeIssue: null, line: result } })

  test('an issue this device held that merged with no merge of the loop has its rollout read', () => {
    const r = plan(state({ issues: [handMerged()] }), CFG)
    expect(keys(r)).toEqual(['rollout:70'])
    expect(find(r, 'rollout:70')).toMatchObject({ kind: 'rollout', class: 'free', rule: 'M7', issue: 70, pr: 570 })
    // the loop's own merge has its follow-ups already; another device's is not ours; a day-old one is history
    expect(keys(plan(withLedger(state({ issues: [handMerged()] }), [loopMerge('merged')]), CFG))).toEqual([])
    expect(keys(plan(state({ issues: [handMerged({ holder: OTHER })] }), CFG))).toEqual([])
    expect(keys(plan(state({ issues: [handMerged({ stageSince: NOW - 25 * 60 * MIN })] }), CFG))).toEqual([])
    // GitHub refused the loop's merge and the owner merged it by hand: it is followed up
    expect(keys(plan(withLedger(state({ issues: [handMerged()] }), [loopMerge('refused')]), CFG))).toEqual(['rollout:70'])
  })

  test('the rollout outcome gives the same follow-ups as a merge (SPEC M7)', () => {
    const read = (rollout: 'merge' | 'run-it' | 'keep-open', closeIssue: number | null = null) =>
      entry('rollout:70', 'rollout', { issue: 70, pr: 570, outcome: { kind: 'rollout', rollout, closeIssue } })
    const s = state({ issues: [handMerged()], milestone: { open: 2, closed: 1, expected: 'patch' } })
    expect(keys(plan(withLedger(s, [read('merge', 70)]), CFG))).toEqual(['close:70'])
    expect(keys(plan(withLedger(s, [read('run-it')]), CFG))).toEqual(['milestone-later:70', 'task:run-it:70'])
    expect(keys(plan(withLedger(s, [read('keep-open')]), CFG))).toEqual(['milestone-later:70'])
    // the merge report the loop had before the owner merged sets the milestone's Expected
    const reported = entry('adjudicate-merge:570:h7', 'spawn', {
      agent: 'adjudicator',
      issue: 70,
      pr: 570,
      head: 'h7',
      outcome: review({ type: 'merge' }, { bump: 'minor', bumpReason: 'a new mode' }),
    })
    expect(find(plan(withLedger(s, [read('merge'), reported]), CFG), 'expect:minor:570')).toMatchObject({ bump: 'minor', why: 'a new mode' })
  })
})

describe('D1: trackers inside only (D-35)', () => {
  test('a tracker in only stands for its open sub-issues, ascending', () => {
    const s = state({
      queue: [41, 43, 44],
      issues: [
        issue(40, { subIssues: 3, labels: ['enhancement'], subIssueList: [41, 42, 43] }),
        issue(41),
        issue(42, { labels: ['enhancement'] }),
        issue(43),
        issue(44),
      ],
      control: control({ only: [40] }),
    })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual([`claim:41:${NOW - 30 * MIN}`, `claim:43:${NOW - 30 * MIN}`])
    const why = Object.fromEntries(r.skipped.filter(x => x.rule === 'D1').map(x => [x.issue, x.why]))
    expect(why).toEqual({ 42: 'owner: only names it, but it is not in the ready queue', 44: 'owner: only #40' })
  })

  test('a tracker whose sub-issues are not read yet stands for nothing, and says so', () => {
    const s = state({ queue: [41], issues: [issue(40, { subIssues: 2 }), issue(41)], control: control({ only: [40] }) })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'D1', issue: 40, why: 'owner: only names this tracker, whose sub-issues are not read yet' })
  })

  test('an epic by its title is a tracker too; a plain issue in only stands for itself, in only order', () => {
    const s = state({
      queue: [45, 51, 52],
      issues: [issue(45), issue(50, { epic: true, subIssueList: [52, 51] }), issue(51), issue(52)],
      control: control({ only: [50, 45] }),
    })
    expect(keys(plan(s, CFG))).toEqual([52, 51, 45].map(n => `claim:${n}:${NOW - 30 * MIN}`))
  })
})

describe('caps and exhausted keys (D-24, D-38, SPEC 4.2, 11.4)', () => {
  test('a tripped rate cap is named in the log and the title, and the owner is told once (SPEC 11.4)', () => {
    const claims = Array.from({ length: 30 }, (_, i) => entry(`claim:${100 + i}:x`, 'claim', { class: 'start', startedAt: NOW - 30 * MIN }))
    const r = plan(withLedger(state({ queue: [1], issues: [issue(1)] }), claims), CFG)
    expect(r.capped).toEqual(['start'])
    expect(r.skipped).toContainEqual({ rule: 'D1', issue: 1, why: 'rate cap: start 30/30' })
    expect(r.title).toBe('🔄 dev-system (Q:1 - D:0 - M:0) · observe · capped start')
  })

  test('the per-issue cap names its kind and issue (SPEC 11.4)', () => {
    const spawns = Array.from({ length: 6 }, (_, i) =>
      entry(`design:60:old${i}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'lost', startedAt: NOW - 40 * MIN }),
    )
    const r = plan(withLedger(state({ issues: [mine(60, 'designing')] }), spawns), CFG)
    expect(r.capped).toEqual(['spawn:60'])
    expect(r.skipped).toContainEqual({ rule: 'D2', issue: 60, why: 'rate cap: spawn on #60 6/6' })
    expect(r.title).toContain('capped spawn:60')
  })

  test('merges are never capped (D-24)', () => {
    const merges = Array.from({ length: 12 }, (_, i) => entry(`merge:${600 + i}:h`, 'merge', { pr: 600 + i, startedAt: NOW - 20 * MIN }))
    const r = plan(mergeReady([guarded(), reviewed(), ...merges]), CFG)
    expect(keys(r)).toEqual(['merge:550:head50'])
    expect(r.capped).toEqual([])
  })

  test('the in-flight cap holds claims back, shows in the title, and tells the owner once per reach (SPEC 4.2)', () => {
    const live = Array.from({ length: 10 }, (_, i) => mine(100 + i, 'implementing'))
    const s = state({ queue: [1], issues: [issue(1), ...live], pool: { free: 16, total: 16, slots: [] } })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual(['tell:at-cap:0'])
    expect(r.atCap).toBe(true)
    expect(r.skipped).toContainEqual({ rule: 'D1', issue: 1, why: 'in-flight cap: 10 of 10' })
    expect(r.title).toBe('🔄 dev-system (Q:1 - D:10 - M:0) · observe · at cap')
    // a notice, not an owner item
    expect(r.owner).toBe(0)
    const told = withLedger(s, [entry('tell:at-cap:0', 'tell', { wake: 'at-cap' })])
    expect(keys(plan(told, CFG))).toEqual([])
    // a claim since then starts the count over: reaching the cap again is told again
    const claimed = withLedger(told, [entry('claim:99:x', 'claim', { class: 'start', issue: 99, endedAt: NOW - 3 * MIN, outcome: { kind: 'claim', result: 'claimed' } })])
    expect(keys(plan(claimed, CFG))).toEqual([`tell:at-cap:${NOW - 3 * MIN}`])
    expect(plan({ ...s, issues: s.issues.slice(0, 10) }, CFG).atCap).toBe(false)
  })

  test('an exhausted key is named, so the log shows what /factory retry would clear (D-38)', () => {
    const failedTwice = entry(`design:60:${NOW - 20 * MIN}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'failed', attempts: 2 })
    const r = plan(withLedger(state({ issues: [mine(60, 'designing', { stageSince: NOW - 20 * MIN })] }), [failedTwice]), CFG)
    expect(r.skipped).toContainEqual({ rule: 'D2', issue: 60, why: `exhausted: design:60:${NOW - 20 * MIN}` })
  })
})

describe('labels (SPEC 4.2)', () => {
  test('labels are compared without regard to case: ready, skip labels and the model: prefix', () => {
    expect(sameLabel('In development', 'in development')).toBe(true)
    const s = state({ queue: [1, 2], issues: [issue(1, { labels: ['Ready'] }), issue(2, { labels: ['ready', 'Parked'] })] })
    const r = plan(s, config({ skipLabels: ['parked'] }))
    expect(keys(r)).toEqual([`claim:1:${NOW - 30 * MIN}`])
    expect(r.skipped).toContainEqual({ rule: 'D1', issue: 2, why: 'label Parked' })
    const p = parkedReview()
    const labelled = { ...p, issues: [{ ...p.issues[0]!, labels: ['In development', 'Model:Opus'] }] }
    expect(find(plan(labelled, CFG), `adjudicate:${AT45}`)).toMatchObject({ model: 'opus' })
  })
})

describe('parsing helpers', () => {
  test('guard FAIL lines are classified by their fixed prefixes (SPEC 6.2)', () => {
    expect(classifyFail({ name: 'mergeable', reason: 'behind main, run ...' })).toBe('behind')
    expect(classifyFail({ name: 'mergeable', reason: 'conflicts with main, rebase ...' })).toBe('conflict')
    expect(classifyFail({ name: 'mergeable', reason: 'GitHub has not computed mergeability, retry' })).toBe('transient')
    expect(classifyFail({ name: 'mergeable', reason: 'PR is MERGED' })).toBe('state')
    expect(classifyFail({ name: 'checks', reason: 'ci=pending, lint=pending' })).toBe('transient')
    expect(classifyFail({ name: 'checks', reason: 'ci=pending, lint=fail' })).toBe('judge')
    expect(classifyFail({ name: 'head', reason: 'run=a origin=b' })).toBe('judge')
    expect(classifyFail({ name: 'something-new', reason: 'x' })).toBe('judge')
  })

  test('the issue comes from the branch convention issue-<N>', () => {
    expect(issueFromBranch('feat/issue-506-implementer-route-v2')).toBe(506)
    expect(issueFromBranch('issue-448-dev-statusline')).toBe(448)
    expect(issueFromBranch('chore/release-1.0')).toBeNull()
  })
})

// --- properties every plan keeps (SPEC 5.9), over every scenario state above ----------------

const SCENARIOS: [string, State][] = [
  ['quiet', state()],
  ['blind', failing(state({ queue: [7], issues: [issue(7)] }), 'factory', NOW - 20 * MIN)],
  ['parked', parkedReview()],
  ['capped', parkedReview({}, 3)],
  ['approved', withLedger(parkedReview(), [adjudicated({ type: 'approve', reason: null })])],
  ['merge-ready', mergeReady()],
  ['guarded', mergeReady([guarded()])],
  ['reviewed', mergeReady([guarded(), reviewed()])],
  ['queue', state({ queue: [1, 2, 3], issues: [issue(1), issue(2), issue(3)], loadedAt: NOW - MIN })],
  ['designing', state({ issues: [mine(60, 'designing')], loadedAt: NOW - MIN })],
  ['draining', withLedger(parkedReview({ control: control({ updateDue: { reason: 'x', at: NOW - 70 * MIN } }) }), [
    entry('design:9:x', 'spawn', { agent: 'designer', class: 'develop', issue: 9, status: 'running', endedAt: null }),
  ])],
  ['restart', state({ control: control({ updateDue: { reason: 'x', at: NOW - MIN } }) })],
  ['flagged', mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', { flags: ['image'] })])],
  ['hand-merge', state({ issues: [mine(70, 'merged', { stageSince: NOW - 30 * MIN, pr: 570 })] })],
  ['tracker-only', state({
    queue: [41, 43],
    issues: [issue(40, { subIssues: 2, subIssueList: [41, 43] }), issue(41), issue(43)],
    control: control({ only: [40] }),
  })],
  ['at-cap', state({ queue: [1], issues: [issue(1), ...Array.from({ length: 10 }, (_, i) => mine(100 + i, 'implementing'))] })],
  ['busy', state({
    loadedAt: NOW - MIN,
    queue: [1, 2],
    issues: [issue(1), issue(2), mine(45, 'parked', { pr: 545 }), mine(50, 'ready to merge', { pr: 550 }), mine(60, 'designing')],
    runs: [run(45, 'parked'), run(50, 'merge-ready'), run(48, 'ci-stalled', { detail: 'reason=no-checks' })],
    milestone: { open: 0, closed: 3, expected: null },
  })],
]
const TIERS = [
  { fiveHour: 10, sevenDay: 10 },
  { fiveHour: 10, sevenDay: 86 },
  { fiveHour: 10, sevenDay: 91 },
  { fiveHour: 96, sevenDay: 10 },
]
const ALLOWED: Record<string, string[]> = {
  normal: ['free', 'owner', 'drive', 'develop', 'start'],
  slow: ['free', 'owner', 'drive', 'develop', 'start'],
  'stop-new': ['free', 'owner', 'drive'],
  'stop-all': ['free', 'owner'],
}

describe('properties', () => {
  test('determinism: the same state gives the same plan', () => {
    for (const [, s] of SCENARIOS) expect(plan(JSON.parse(JSON.stringify(s)), CFG)).toEqual(plan(s, CFG))
  })

  test('idempotence: once every planned action is running, re-planning adds nothing', () => {
    for (const [name, s] of SCENARIOS) {
      const first = plan(s, CFG)
      const again = plan(running(s, first), CFG)
      expect([name, keys(again)]).toEqual([name, []])
    }
  })

  test('tier safety: no action of a class the tier forbids, in any scenario', () => {
    for (const [name, s] of SCENARIOS) {
      for (const w of TIERS) {
        const r = plan({ ...s, usage: { ...w, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } }, CFG)
        const bad = r.actions.filter(a => !ALLOWED[r.tier]!.includes(a.class)).map(a => a.key)
        expect([name, r.tier, bad]).toEqual([name, r.tier, []])
      }
    }
  })

  test('control safety: nothing on a paused issue but the heartbeat; no claim without new work', () => {
    for (const [name, s] of SCENARIOS) {
      const paused = s.issues.map(i => i.number)
      const r = plan({ ...s, control: control({ paused, noNewWork: true }) }, CFG)
      const bad = r.actions.filter(a => (a.issue !== null && paused.includes(a.issue)) || a.class === 'start' || a.class === 'develop')
      expect([name, bad.map(a => a.key)]).toEqual([name, []])
    }
  })

  test('bounded: at most one wake and at most maxStartsPerPass claims per pass', () => {
    for (const [name, s] of SCENARIOS) {
      const r = plan(s, CFG)
      const wakes = r.actions.filter(a => a.kind === 'judge' || a.kind === 'task' || a.kind === 'tell').length
      const claims = r.actions.filter(a => a.kind === 'claim').length
      expect([name, wakes <= 1, claims <= CFG.maxStartsPerPass]).toEqual([name, true, true])
    }
  })
})
