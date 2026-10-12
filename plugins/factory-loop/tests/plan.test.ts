// The plan, scenario by scenario. Each expectation is written from the issue-orchestrator
// skill (cited SKILL:<line>, v0.35.0), the inventory row (I-nn) or the owner's rules in the
// memory file (MEM), not from the code. docs/factory-loop/SPEC.md section 5 is the table.
import { describe, expect, test } from 'claude-code/testing'

import { classifyFail, issueFromBranch, plan, tierOf } from '../hooks/plan'
import type { Action, LedgerEntry, State } from '../hooks/types'
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

function adjudicated(action: Extract<LedgerEntry['outcome'], { kind: 'adjudicator' }>['action'], key = `adjudicate:${AT45}`) {
  return entry(key, 'spawn', {
    agent: 'adjudicator',
    class: 'drive',
    issue: 45,
    run: '01M4RQ0045AAAA',
    head: 'head45',
    outcome: { kind: 'adjudicator', verdicts: ['CORRECT: review-1 a real gap'], action },
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
function reviewed(decision: string, head = 'head50', over = {}) {
  return entry(`judge:merge-review:550:${head}`, 'judge', {
    wake: 'merge-review',
    class: 'drive',
    issue: 50,
    pr: 550,
    head,
    outcome: wakeAnswer(decision, over),
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
    const u = (fiveHour: number | null, sevenDay: number | null, unavailable = false) => ({ fiveHour, sevenDay, resetsAt: null, unavailable })
    expect(tierOf(u(10, 84), CFG, null, NOW).tier).toBe('normal')
    expect(tierOf(u(85, 20), CFG, null, NOW).tier).toBe('slow')
    expect(tierOf(u(10, 90), CFG, null, NOW).tier).toBe('stop-new')
    expect(tierOf(u(95, 10), CFG, null, NOW).tier).toBe('stop-all')
    expect(tierOf(u(null, null, true), CFG, null, NOW).tier).toBe('normal')
  })

  test('an owner override runs past a threshold until it expires (SKILL:49)', () => {
    const u = { fiveHour: 60, sevenDay: 92, resetsAt: null, unavailable: false }
    expect(tierOf(u, CFG, { untilPct: 100, expiresAt: NOW + MIN }, NOW)).toEqual({ tier: 'normal', overridden: true })
    expect(tierOf(u, CFG, { untilPct: 100, expiresAt: NOW - MIN }, NOW).tier).toBe('stop-new')
    expect(tierOf(u, CFG, { untilPct: 91, expiresAt: NOW + MIN }, NOW).tier).toBe('stop-new')
  })

  test('Stop new claims nothing but in-flight work continues (SKILL:41-42)', () => {
    const s = parkedReview({ usage: { fiveHour: 20, sevenDay: 91, resetsAt: null, unavailable: false }, queue: [7] })
    const r = plan({ ...s, issues: [...s.issues, issue(7)] }, CFG)
    expect(r.tier).toBe('stop-new')
    expect(keys(r)).toEqual([`adjudicate:${AT45}`])
  })

  test('Stop all launches nothing, not even an adjudicator, but free work like a merge proceeds (SKILL:43-44)', () => {
    const usage = { fiveHour: 96, sevenDay: 60, resetsAt: null, unavailable: false }
    expect(keys(plan(parkedReview({ usage }), CFG))).toEqual([])
    const r = plan(mergeReady([guarded(), reviewed('merge')], { usage }), CFG)
    expect(keys(r)).toEqual(['merge:550:head50'])
  })

  test('Slow: at most one claim per pass, none soon after the last, none while merging (SKILL:40, D-07)', () => {
    const usage = { fiveHour: 20, sevenDay: 86, resetsAt: null, unavailable: false }
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

  test('no live claim, no heartbeat; the sweep runs every 30 minutes regardless (SKILL:62-63)', () => {
    const s = state({ loadedAt: NOW - MIN, ledger: [entry('sweep:9', 'sweep', { endedAt: NOW - 31 * MIN })] })
    expect(keys(plan(s, CFG))).toEqual([`sweep:${NOW - 31 * MIN}`])
  })

  test('a clean slot on a merged branch is returned; a dirty or busy one is not (SKILL:150, I-76)', () => {
    const slot = (path: string, over = {}) => ({ path, branch: 'feat/issue-12-x', state: 'leased', dirty: false, busy: false, ...over })
    const s = state({
      issues: [issue(12, { stage: 'merged', holder: DEVICE })],
      pool: { free: 8, total: 16, slots: [slot('/t/1'), slot('/t/2', { dirty: true }), slot('/t/3', { busy: true })] },
    })
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

  test('a respond that leaves the gate unmoved is tried once more, then the owner hears (MEM respond lesson, SPEC P3a)', () => {
    const adj = adjudicated({ type: 'approve', reason: null })
    const sent = entry(`respond:${AT45}:approve`, 'respond', { run: '01M4RQ0045AAAA', endedAt: NOW - 20 * MIN })
    expect(keys(plan(withLedger(parkedReview(), [adj, sent]), CFG))).toEqual([`respond:${AT45}:approve:retry`])
    const retried = entry(`respond:${AT45}:approve:retry`, 'respond', { run: '01M4RQ0045AAAA', endedAt: NOW - 16 * MIN })
    expect(keys(plan(withLedger(parkedReview(), [adj, sent, retried]), CFG))).toEqual([
      'tell:respond-stuck:01M4RQ0045AAAA:review:head45',
    ])
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

  test('a passing guard asks the model to read the fix commits before merging (SKILL:141-145)', () => {
    const r = plan(mergeReady([guarded()]), CFG)
    expect(keys(r)).toEqual(['judge:merge-review:550:head50'])
    expect(find(r, 'judge:merge-review:550:head50')).toMatchObject({
      kind: 'judge',
      wake: 'merge-review',
      fields: { pr: '550', issue: '50', head: 'head50', brief: brief(50) },
    })
  })

  test('the review answer decides: merge, a fixer, or a hold the owner sees (SKILL:139-145)', () => {
    expect(keys(plan(mergeReady([guarded(), reviewed('merge')]), CFG))).toEqual(['merge:550:head50'])
    const fixer = plan(mergeReady([guarded(), reviewed('fixer', 'head50', { instructions: 'restore the requirement' })]), CFG)
    expect(find(fixer, 'fixer:review:550:head50')).toMatchObject({ purpose: 'review', instructions: 'restore the requirement' })
    const hold = plan(mergeReady([guarded(), reviewed('hold', 'head50', { reason: 'needs owner' })]), CFG)
    expect(keys(hold)).toEqual([])
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
      [reviewed('merge', 'head50'), moved, entry('guard:550:head51:1', 'guard', { pr: 550, head: 'head51', endedAt: NOW - MIN, outcome: { kind: 'guard', fails: [], warns: [] } })],
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
      outcome: { kind: 'adjudicator', verdicts: ['WRONG: || true is in a new file'], action: { type: 'approve', reason: 'new file' } },
    })
    const r = plan(mergeReady([guarded([], warn), judged]), CFG)
    expect(keys(r)).toEqual(['pr-comment:550:head50'])
    const commented = entry('pr-comment:550:head50', 'pr-comment', { pr: 550, endedAt: NOW - 30_000 })
    expect(keys(plan(mergeReady([guarded([], warn), judged, commented]), CFG))).toEqual(['judge:merge-review:550:head50'])
  })

  test('a refused merge goes to the owner with the guard output (SKILL:148-149)', () => {
    const refused = entry('merge:550:head50', 'merge', {
      pr: 550,
      head: 'head50',
      outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line: 'GitHub refused: branch rules' },
    })
    expect(keys(plan(mergeReady([guarded(), reviewed('merge'), refused]), CFG))).toEqual(['tell:merge-refused:550:head50'])
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
    const bumped = plan(base(merged('merge'), [reviewed('merge', 'head50', { bump: 'minor', bumpReason: 'new mode' })]), CFG)
    expect(find(bumped, 'expect:minor:550')).toMatchObject({ bump: 'minor', why: 'new mode' })
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
      queue: [1, 2, 3, 4, 5, 6, 7],
      issues: [
        issue(1, { subIssues: 4 }),
        issue(2, { blockedBy: 1 }),
        issue(3, { trusted: false }),
        issue(4, { labels: ['enhancement'] }),
        issue(5, { labels: ['ready', 'parked'] }),
        issue(6, { stage: 'designing', holder: OTHER }),
        issue(7),
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

  test('the title: repo, mode, tier with windows rounded down to 5%, counts, owner items (SKILL:171-173)', () => {
    const s = state({
      usage: { fiveHour: 67, sevenDay: 86, resetsAt: null, unavailable: false },
      queue: [1, 2, 3],
      issues: [issue(1), issue(2), issue(3), mine(9, 'implementing'), mine(10, 'designing', { brief: null }), mine(11, 'parked')],
    })
    expect(plan({ ...s, issues: s.issues.filter(i => i.number !== 10) }, CFG).title).toBe(
      '🔄 dev-system · observe · slow 5h 65% 7d 85% · q 3 dev 1 pipe 1 merge 0',
    )
    const na = plan(state({ usage: { fiveHour: null, sevenDay: null, resetsAt: null, unavailable: true } }), CFG)
    expect(na.title).toBe('🔄 dev-system · observe · normal usage n/a · q 0 dev 0 pipe 0 merge 0')
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
    const judgeOut = entry('judge:merge-review:550:head50', 'judge', { wake: 'merge-review', status: 'timed-out', attempts: 1, pr: 550, head: 'head50' })
    const r = plan(mergeReady([guarded(), judgeOut]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.owner).toBe(1)
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
  ['reviewed', mergeReady([guarded(), reviewed('merge')])],
  ['queue', state({ queue: [1, 2, 3], issues: [issue(1), issue(2), issue(3)], loadedAt: NOW - MIN })],
  ['designing', state({ issues: [mine(60, 'designing')], loadedAt: NOW - MIN })],
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
        const r = plan({ ...s, usage: { ...w, resetsAt: null, unavailable: false } }, CFG)
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
