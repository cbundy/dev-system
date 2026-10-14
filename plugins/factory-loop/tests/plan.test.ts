// The plan, scenario by scenario. Each expectation is written from the issue-orchestrator
// skill (cited SKILL:<line>, v0.35.0), the inventory row (I-nn) or the owner's rules in the
// memory file (MEM), not from the code. docs/factory-loop/SPEC.md section 5 is the table.
import { describe, expect, test } from 'claude-code/testing'

import { start } from '../hooks/ledger'
import { classifyFail, issueFromBranch, plan as planOf, sameLabel, tierOf } from '../hooks/plan'
import type { Action, ActionKind, AdjudicatorAction, Config, IssueView, LedgerEntry, MergeReport, PlanResult, State } from '../hooks/types'
import {
  CLEAN,
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

// --- the properties every plan keeps (SPEC 5.9), checked on every plan this file makes ----------

const HOUR = 60 * MIN
const TIER_READINGS = [
  { fiveHour: 10, sevenDay: 10 },
  { fiveHour: 10, sevenDay: 86 },
  { fiveHour: 10, sevenDay: 91 },
  { fiveHour: 96, sevenDay: 10 },
]
const ALLOWED_CLASSES: Record<string, string[]> = {
  normal: ['free', 'owner', 'drive', 'develop', 'start'],
  slow: ['free', 'owner', 'drive', 'develop', 'start'],
  'stop-new': ['free', 'owner', 'drive'],
  'stop-all': ['free', 'owner'],
}
const isWake = (kind: ActionKind) => kind === 'judge' || kind === 'task' || kind === 'tell'
// a rate cap's bucket, as SPEC 11.4 counts: claims, spawns (a delegate spawns), wakes
const bucketOf = (kind: ActionKind, klass: string) => (klass === 'start' ? 'start' : kind === 'spawn' || kind === 'delegate' ? 'spawn' : isWake(kind) ? 'wake' : null)

// startedAll: the ledger once every planned action started, as ledger.ts start() starts it.
function startedAll(s: State, r: PlanResult): State {
  let ledger = s.ledger
  for (const a of r.actions) if (a.kind !== 'title') ledger = start(ledger, a, s.now).ledger
  return { ...s, ledger, lastTitle: r.title }
}

// properties: what SPEC 5.9 asks of every plan, for one state and config.
function properties(s: State, cfg: Config, r: PlanResult) {
  // 1. determinism
  expect(planOf(JSON.parse(JSON.stringify(s)), cfg)).toEqual(r)
  // 2. idempotence: every planned action running, a second plan adds nothing
  expect(['idempotence', planOf(startedAll(s, r), cfg).actions.filter(a => a.kind !== 'title').map(a => a.key)]).toEqual(['idempotence', []])
  // 4. tier safety, at every tier
  for (const w of TIER_READINGS) {
    const t = planOf({ ...s, usage: { ...w, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } }, cfg)
    expect(['tier', t.tier, t.actions.filter(a => !(ALLOWED_CLASSES[t.tier] ?? []).includes(a.class)).map(a => a.key)]).toEqual(['tier', t.tier, []])
  }
  // 5. control safety: nothing names a paused issue but the heartbeat; no start or develop work without new work
  const paused = [...new Set([...s.issues.map(i => i.number), ...s.queue, ...s.control.dropped.map(d => d.issue)])]
  const p = planOf({ ...s, control: { ...s.control, paused } }, cfg)
  expect(['paused', p.actions.filter(a => a.issue !== null && paused.includes(a.issue) && a.kind !== 'heartbeat').map(a => a.key)]).toEqual(['paused', []])
  const n = planOf({ ...s, control: { ...s.control, noNewWork: true } }, cfg)
  expect(['no new work', n.actions.filter(a => a.class === 'start' || a.class === 'develop').map(a => a.key)]).toEqual(['no new work', []])
  // 6. bounded: one wake, maxStartsPerPass claims, and no bucket nor kind on one issue past its rate cap
  expect(['wakes', r.actions.filter(a => isWake(a.kind)).length <= 1]).toEqual(['wakes', true])
  expect(['claims', r.actions.filter(a => a.kind === 'claim').length <= cfg.maxStartsPerPass]).toEqual(['claims', true])
  const hour = s.ledger.filter(e => e.startedAt > s.now - HOUR)
  // the runaway and breaker notices are what tell the owner a cap or breaker tripped (SPEC 11.4)
  const kept = r.actions.filter(a => !(a.kind === 'tell' && (a.wake === 'runaway' || a.wake === 'breaker')))
  const caps: Record<string, number> = cfg.rateCaps
  for (const bucket of ['start', 'spawn', 'wake']) {
    const had = hour.filter(e => bucketOf(e.kind, e.class) === bucket).length
    const added = kept.filter(a => bucketOf(a.kind, a.class) === bucket).length
    expect(['rate cap', bucket, added === 0 || had + added <= (caps[bucket] ?? 0)]).toEqual(['rate cap', bucket, true])
  }
  for (const a of kept) {
    if (a.issue === null || bucketOf(a.kind, a.class) === null) continue
    const had = hour.filter(e => e.kind === a.kind && e.issue === a.issue && bucketOf(e.kind, e.class) !== null).length
    const added = kept.filter(b => b.kind === a.kind && b.issue === a.issue).length
    expect(['rate cap', `${a.kind}:${a.issue}`, had + added <= cfg.rateCaps.perIssueKind]).toEqual(['rate cap', `${a.kind}:${a.issue}`, true])
  }
}

// plan: plan.ts's plan, with every property checked on the way (SPEC 5.9: on every fixture).
function plan(s: State, cfg: Config): PlanResult {
  const r = planOf(s, cfg)
  properties(s, cfg, r)
  return r
}

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
  // the main checkout brought up to date a minute ago, so rule H5 stays quiet
  const UPDATED = entry('update-checkout:0', 'update-checkout', { endedAt: NOW - MIN })

  test('heartbeat first thing after a restart, then every 20 minutes (SKILL:62-63, MEM 05:03 lesson)', () => {
    const holding = state({ issues: [mine(9, 'implementing')], loadedAt: NOW - MIN })
    expect(keys(plan(holding, CFG))).toContain(`heartbeat:${NOW - 5 * MIN}`)
    const settled = { ...holding, loadedAt: NOW - 60 * MIN }
    expect(keys(plan(settled, CFG))).toEqual([])
    const due = {
      ...settled,
      ledger: [entry('heartbeat:1', 'heartbeat', { endedAt: NOW - 21 * MIN }), entry('sweep:0', 'sweep', { endedAt: NOW - MIN }), UPDATED],
    }
    expect(keys(plan(due, CFG))).toEqual([`heartbeat:${NOW - 21 * MIN}`])
  })

  test('a claim starts its own lease: the next heartbeat is due 20 minutes after it (shadow, #522)', () => {
    const claimed = (n: number, at: number) =>
      entry(`claim:${n}:x`, 'claim', { class: 'start', issue: n, startedAt: at, endedAt: at, outcome: { kind: 'claim', result: 'claimed' } })
    const beat = entry('heartbeat:1', 'heartbeat', { endedAt: NOW - 12 * 60 * MIN })
    const sweep = entry('sweep:0', 'sweep', { endedAt: NOW - MIN })
    const fresh = state({ issues: [mine(9, 'implementing')], ledger: [beat, sweep, UPDATED, claimed(9, NOW - MIN)] })
    expect(keys(plan(fresh, CFG))).toEqual([])
    const old = { ...fresh, ledger: [beat, sweep, UPDATED, claimed(9, NOW - 21 * MIN)] }
    expect(keys(plan(old, CFG))).toEqual([`heartbeat:${NOW - 12 * 60 * MIN}`])
    // the stalest lease decides
    const two = { ...fresh, issues: [mine(9, 'implementing'), mine(10, 'implementing')], ledger: [beat, sweep, UPDATED, claimed(9, NOW - MIN)] }
    expect(keys(plan(two, CFG))).toEqual([`heartbeat:${NOW - 12 * 60 * MIN}`])
    // a claim made since the last load counts as renewed since it; a lost claim renews nothing
    expect(keys(plan({ ...fresh, loadedAt: NOW - 10 * MIN }, CFG))).toEqual([])
    const lost = entry('claim:9:y', 'claim', { class: 'start', issue: 9, endedAt: NOW - MIN, outcome: { kind: 'claim', result: 'lost' } })
    expect(keys(plan({ ...fresh, ledger: [beat, sweep, UPDATED, lost] }, CFG))).toEqual([`heartbeat:${NOW - 12 * 60 * MIN}`])
  })

  test('heartbeat and sweep are never used up: past their attempts they retry at their cadence, and the owner hears once (SPEC 6.1)', () => {
    const failed = (key: string, kind: 'heartbeat' | 'sweep', attempts: number, endedAt: number) =>
      entry(key, kind, { status: 'failed', attempts, startedAt: endedAt - 1000, endedAt })
    const told = (key: string) => entry(`tell:agent-failed:${key}`, 'tell', { wake: 'agent-failed', class: 'owner' })
    const sweep = entry('sweep:0', 'sweep', { endedAt: NOW - MIN })
    const holding = (beat: LedgerEntry, extra: LedgerEntry[] = []) => state({ issues: [mine(9, 'implementing')], ledger: [beat, sweep, UPDATED, ...extra] })
    // three failures in a few minutes: the owner hears once; the next try waits its backoff
    expect(keys(plan(holding(failed('heartbeat:0', 'heartbeat', 3, NOW - MIN)), CFG))).toEqual(['tell:agent-failed:heartbeat:0'])
    expect(keys(plan(holding(failed('heartbeat:0', 'heartbeat', 3, NOW - MIN), [told('heartbeat:0')]), CFG))).toEqual([])
    expect(keys(plan(holding(failed('heartbeat:0', 'heartbeat', 3, NOW - 9 * MIN), [told('heartbeat:0')]), CFG))).toEqual(['heartbeat:0'])
    // a long spell of failures still tries every heartbeat interval, days later too
    for (const ago of [21 * MIN, 6 * 60 * MIN, 3 * 24 * 60 * MIN]) {
      expect(keys(plan(holding(failed('heartbeat:0', 'heartbeat', 9, NOW - ago), [told('heartbeat:0')]), CFG))).toEqual(['heartbeat:0'])
    }
    expect(keys(plan(holding(failed('heartbeat:0', 'heartbeat', 9, NOW - 19 * MIN), [told('heartbeat:0')]), CFG))).toEqual([])
    // the sweep likewise, at its 30-minute cadence
    const quiet = (s: LedgerEntry, extra: LedgerEntry[] = []) => state({ ledger: [entry('heartbeat:0', 'heartbeat', { endedAt: NOW - MIN }), s, UPDATED, ...extra] })
    expect(keys(plan(quiet(failed('sweep:0', 'sweep', 3, NOW - MIN)), CFG))).toEqual(['tell:agent-failed:sweep:0'])
    expect(keys(plan(quiet(failed('sweep:0', 'sweep', 9, NOW - 29 * MIN), [told('sweep:0')]), CFG))).toEqual([])
    expect(keys(plan(quiet(failed('sweep:0', 'sweep', 9, NOW - 31 * MIN), [told('sweep:0')]), CFG))).toEqual(['sweep:0'])
  })

  test('no live claim, no heartbeat; the sweep runs every 30 minutes regardless (SKILL:62-63)', () => {
    const s = state({ loadedAt: NOW - MIN, ledger: [entry('sweep:9', 'sweep', { endedAt: NOW - 31 * MIN }), UPDATED] })
    expect(keys(plan(s, CFG))).toEqual([`sweep:${NOW - 31 * MIN}`])
  })

  test('a clean slot on a merged branch is returned; a dirty or busy one is not (SKILL:150, I-76)', () => {
    const slot = (path: string, over = {}) => ({ path, branch: 'feat/issue-12-x', state: 'leased', dirty: false, busy: false, ...over })
    // merged by the loop, so its rollout follow-ups are its merge's (M7)
    const merged = entry('merge:512:h12', 'merge', { issue: 12, pr: 512, outcome: { kind: 'merge', result: 'merged', rollout: 'merge', closeIssue: null, line: 'merged' } })
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

  // #537, found on the testbed: codex was logged out, so runs failed at the test step and every
  // adjudicator escalated ENV. Once the owner fixed it and resumed, new adjudicators were asked
  // about the same stale failure and escalated again; only a hand `no-mistakes rerun` moved them.
  describe('P2a: the owner resumed an environment escalation (#537)', () => {
    const RUN45 = '01M4RQ0045AAAA'
    const AT = `${RUN45}:test:head45`
    const ENV = 'ENV: codex is logged out (401 on the evidence step); the tests passed'
    const failedTest = (over: Partial<State> = {}) =>
      state({ issues: [mine(45, 'in pipeline', { delegatedBrief: brief(45), run: RUN45, pr: 545 })], runs: [run(45, 'failed', { step: 'test' })], ...over })
    const escalated = (verdicts: string[], key = `adjudicate:${AT}`) =>
      entry(key, 'spawn', { agent: 'adjudicator', class: 'drive', issue: 45, run: RUN45, head: 'head45', startedAt: NOW - 60 * MIN, endedAt: NOW - 50 * MIN, outcome: review({ type: 'escalate', why: 'environment' }, null, verdicts) })
    const told = (key = `tell:escalate:${AT}`) => entry(key, 'tell', { wake: 'escalate', class: 'owner', issue: 45 })
    const resumedAt = (...ats: number[]) => control({ resumed: ats.map(at => ({ subject: `run:${RUN45}`, at })) })

    test('every verdict ENV and the owner resumed: the same head is rerun, no new adjudicator', () => {
      const held = withLedger(failedTest(), [escalated([ENV]), told()])
      expect(keys(plan(held, CFG))).toEqual([])
      const r = plan({ ...held, control: resumedAt(NOW - MIN) }, CFG)
      expect(keys(r)).toEqual([`env-retry:${AT}:r1`])
      expect(find(r, `env-retry:${AT}:r1`)).toMatchObject({
        kind: 'env-retry',
        class: 'drive',
        rule: 'P2a',
        issue: 45,
        run: RUN45,
        branch: 'feat/issue-45-work',
        step: 'test',
        head: 'head45',
      })
    })

    test('a code failure is never rerun: any other verdict, no verdict, or no escalation asks the adjudicator again', () => {
      for (const verdicts of [[ENV, 'CORRECT: slugify drops the trailing dash'], ['WRONG: x'], ['NIT: x'], ['DUP: x'], ['CORRECT: x'], []]) {
        const s = withLedger(failedTest({ control: resumedAt(NOW - MIN) }), [escalated(verdicts), told()])
        expect({ verdicts, keys: keys(plan(s, CFG)) }).toEqual({ verdicts, keys: [`adjudicate:${AT}:r1`] })
      }
      // an ENV verdict the adjudicator answered with a fix is a respond, never a rerun
      const fix = entry(`adjudicate:${AT}`, 'spawn', {
        agent: 'adjudicator',
        issue: 45,
        run: RUN45,
        outcome: review({ type: 'fix', findings: null, instructions: 'retry', addFinding: null }, null, [ENV]),
      })
      expect(keys(plan(withLedger(failedTest({ control: resumedAt(NOW - MIN) }), [fix]), CFG))).toEqual([`adjudicate:${AT}:r1`])
      // a resume from before the escalation is not the owner answering it
      const early = withLedger(failedTest({ control: resumedAt(NOW - 55 * MIN) }), [escalated([ENV]), told()])
      expect(keys(plan(early, CFG))).toEqual([`adjudicate:${AT}:r1`])
    })

    test('once per resume: a rerun that left the run at the gate escalates again, and a second resume reruns once more', () => {
      const s = (ended: number, ...ats: number[]) =>
        withLedger(failedTest({ control: resumedAt(...ats) }), [
          escalated([ENV]),
          told(),
          entry(`env-retry:${AT}:r1`, 'env-retry', { class: 'drive', rule: 'P2a', issue: 45, run: RUN45, head: 'head45', endedAt: ended }),
        ])
      expect(keys(plan(s(NOW - 2 * MIN, NOW - 5 * MIN), CFG))).toEqual([])
      const again = plan(s(NOW - 16 * MIN, NOW - 20 * MIN), CFG)
      expect(keys(again)).toEqual([`tell:escalate:${AT}:r1`])
      expect(find(again, `tell:escalate:${AT}:r1`)).toMatchObject({ rule: 'P2a', context: [expect.stringContaining('run again'), ENV] })
      expect(again.owner).toBe(1)
      const second = withLedger(s(NOW - 16 * MIN, NOW - 20 * MIN, NOW - MIN), [told(`tell:escalate:${AT}:r1`)])
      expect(keys(plan(second, CFG))).toEqual([`env-retry:${AT}:r2`])
    })

    test('a rerun that could not launch is not tried again: the owner hears to resume, no adjudicator, no agent-failed', () => {
      const failed = entry(`env-retry:${AT}:r1`, 'env-retry', {
        class: 'drive',
        rule: 'P2a',
        issue: 45,
        run: RUN45,
        status: 'failed',
        endedAt: NOW - 30 * MIN,
        summary: 'launch: exit 1: no slot on feat/issue-45-work',
      })
      const s = withLedger(failedTest({ control: resumedAt(NOW - 40 * MIN) }), [escalated([ENV]), told(), failed])
      const r = plan(s, CFG)
      // `/factory retry` never clears an env-retry, so a notice that says retry would lead nowhere
      expect(keys(r)).toEqual([`tell:escalate:${AT}:r1`])
      expect(find(r, `tell:escalate:${AT}:r1`)).toMatchObject({
        rule: 'P2a',
        context: [
          'the pipeline could not be run again on this head after the resume (launch: exit 1: no slot on feat/issue-45-work); resuming the run tries once more',
          ENV,
        ],
      })
      expect(r.owner).toBe(1)
      // lost on a reload: the same notice, once; told, it waits for the next resume
      const lost = { ...failed, status: 'lost' as const, summary: undefined }
      const fromLost = plan(withLedger(failedTest({ control: resumedAt(NOW - 40 * MIN) }), [escalated([ENV]), told(), lost]), CFG)
      expect(fromLost.actions.flatMap(a => (a.kind === 'tell' ? [a.key, a.context[0]] : []))).toEqual([
        `tell:escalate:${AT}:r1`,
        'the pipeline could not be run again on this head after the resume; resuming the run tries once more',
      ])
      const toldOnce = withLedger(s, [told(`tell:escalate:${AT}:r1`)])
      expect(keys(plan(toldOnce, CFG))).toEqual([])
      expect(keys(plan({ ...toldOnce, control: resumedAt(NOW - 40 * MIN, NOW - MIN) }, CFG))).toEqual([`env-retry:${AT}:r2`])
    })

    test('the rerun is a new run: its gate is judged afresh, and a repeat failure escalates again', () => {
      const RERUN = '01M4RQ0045BBBB'
      const s = withLedger(
        failedTest({ control: resumedAt(NOW - 20 * MIN), runs: [run(45, 'failed', { step: 'test' }), run(45, 'failed', { run: RERUN, step: 'test' })] }),
        [escalated([ENV]), told(), entry(`env-retry:${AT}:r1`, 'env-retry', { class: 'drive', rule: 'P2a', issue: 45, run: RUN45, endedAt: NOW - 18 * MIN })],
      )
      expect(keys(plan(s, CFG))).toEqual([`adjudicate:${RERUN}:test:head45`])
      const again = withLedger(s, [escalated([ENV], `adjudicate:${RERUN}:test:head45`)])
      expect(keys(plan(again, CFG))).toEqual([`tell:escalate:${RERUN}:test:head45`])
    })
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
    expect(find(plan(mergeReady([guarded(behind), ub('fail')]), CFG), 'fixer:regate:550:head50')).toMatchObject({
      purpose: 'regate',
      instructions: 'UPDATE-BEHIND fail',
    })
    const skipped = ub('skip', { status: 'failed', attempts: 1, endedAt: NOW - 6 * MIN })
    expect(keys(plan(mergeReady([guarded(behind), skipped]), CFG))).toEqual(['update-behind:550:head50'])
    const exhausted = ub('skip', { status: 'failed', attempts: 4, endedAt: NOW - 6 * MIN })
    expect(keys(plan(mergeReady([guarded(behind), exhausted]), CFG))).toEqual(['tell:update-behind:550:head50'])
  })

  test('a behind-only update moves the PR head, not the run head: the guard runs again, and the next update keys by the pushed head (SPEC M1, M2b)', () => {
    // pipeline-watch keeps printing the run's head (head50) after the update pushed head51
    const behind = [{ name: 'mergeable', reason: 'behind main, run update-behind first' }]
    const updated = (from: string, to: string, endedAt: number) =>
      entry(`update-behind:550:${from}`, 'update-behind', {
        issue: 50,
        pr: 550,
        head: from,
        startedAt: endedAt - 30_000,
        endedAt,
        outcome: { kind: 'update-behind', result: 'updated', from, to, line: `UPDATED pr=550 from=${from} to=${to}` },
      })
    // the update ended after the guard that asked for it: that guard is stale
    const first = mergeReady([guarded(behind), updated('head50', 'head51', NOW - 30_000)], { runs: [run(50, 'head-mismatch')] })
    expect(keys(plan(first, CFG))).toEqual(['guard:550:head50:2'])
    // main moved again: the guard after the update says behind, so the PR is updated again from the head it now has
    const again = guarded(behind, [], 2, { startedAt: NOW - 20_000, endedAt: NOW - 10_000 })
    const second = withLedger(first, [again])
    const r = plan(second, CFG)
    expect(keys(r)).toEqual(['update-behind:550:head51'])
    expect(find(r, 'update-behind:550:head51')).toMatchObject({ pr: 550, head: 'head51', run: '01M4RQ0050AAAA' })
    // that one runs out of SKIPs: the owner hears under the head it was keyed by
    const skips = entry('update-behind:550:head51', 'update-behind', {
      issue: 50,
      pr: 550,
      head: 'head51',
      status: 'failed',
      attempts: 4,
      endedAt: NOW - 6 * MIN,
      outcome: { kind: 'update-behind', result: 'skip', from: null, to: null, line: 'UPDATE-BEHIND SKIP busy' },
    })
    expect(keys(plan(withLedger(second, [skips]), CFG))).toEqual(['tell:update-behind:550:head51'])
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

  test('one writer per branch: no conflict fixer, respond or merge while a fixer of the issue works (testbed, 2026-10-13)', () => {
    const conflict = guarded([{ name: 'mergeable', reason: 'conflicts with main, rebase and re-gate' }])
    const working = entry('fixer:guard:550:head50', 'spawn', { agent: 'fixer', issue: 50, pr: 550, status: 'running', endedAt: null, agentId: 'a-fix' })
    const r = plan(mergeReady([conflict, working]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'M2', issue: 50, why: 'an agent already works the branch of #50 (spawn)' })
    // the merge waits too, and goes ahead once the fixer has ended
    const ready = mergeReady([guarded(), reviewed(), working])
    expect(keys(plan(ready, CFG))).toEqual([])
    const ended = { ...working, status: 'done' as const, endedAt: NOW - MIN }
    expect(keys(plan(mergeReady([guarded(), reviewed(), ended]), CFG))).toEqual(['merge:550:head50'])
  })

  test('pending CI waits for the recheck; a failed check goes to the model (SKILL:139)', () => {
    const pending = [{ name: 'checks', reason: 'ci=pending' }]
    expect(keys(plan(mergeReady([guarded(pending)]), CFG))).toEqual([])
    const stale = guarded(pending, [], 1, { endedAt: NOW - 4 * MIN })
    expect(keys(plan(mergeReady([stale]), CFG))).toEqual(['guard:550:head50:2'])
    const failed = [{ name: 'checks', reason: 'ci=fail' }]
    expect(keys(plan(mergeReady([guarded(failed)]), CFG))).toEqual([expect.stringMatching(/^judge:guard-fail:550:head50:[0-9a-f]{8}$/)])
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

  test('a guard older than guardTtlMs is run again (SPEC M1)', () => {
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

  test('a designer that failed, was lost or timed out after posting its brief is not redesigned (SPEC D2, 10.4)', () => {
    const life = NOW - 70 * MIN
    const posted = (at: number) => state({ issues: [mine(60, 'designing', { stageSince: life, brief: { url: brief(60), at } })] })
    for (const status of ['failed', 'lost', 'timed-out'] as const) {
      const ended = entry(`design:60:${life}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status, attempts: 1, endedAt: NOW - 5 * MIN })
      expect([status, keys(plan(withLedger(posted(NOW - 10 * MIN), [ended]), CFG))]).toEqual([status, [`judge:report:brief:60:${brief(60)}`]])
      // a brief from before this life is not this design's: the designer is retried
      expect([status, keys(plan(withLedger(posted(life - MIN), [ended]), CFG))]).toEqual([status, [`design:60:${life}`]])
    }
    // while the designer runs, its own RESULT line comes first
    const running = entry(`design:60:${life}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'running', endedAt: null, startedAt: NOW - 10 * MIN, agentId: 'a60' })
    expect(keys(plan(withLedger(posted(NOW - 5 * MIN), [running]), CFG))).toEqual([])
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

  test('a dropped issue gets only its abandon, the stop of its agents and a tell: no guard, review or merge (SPEC G4, D6)', () => {
    const dropped = control({ dropped: [{ issue: 50, at: NOW - MIN }] })
    const fixer = entry('fixer:review:550:head50', 'spawn', { agent: 'fixer', class: 'drive', issue: 50, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'a50' })
    for (const extra of [[], [guarded()], [guarded(), reviewed()]]) {
      const r = plan(mergeReady([...extra, fixer], { control: dropped }), CFG)
      expect(keys(r)).toEqual([`abandon:50:${NOW - MIN}`, 'stop:a50', 'tell:stopped:a50'])
      expect(r.skipped.some(k => k.issue === 50 && k.why.startsWith('owner: dropped ('))).toBe(true)
    }
    // a parked run is not adjudicated either
    const parked = parkedReview({ control: control({ dropped: [{ issue: 45, at: NOW - MIN }] }) })
    expect(keys(plan(parked, CFG))).toEqual([`abandon:45:${NOW - MIN}`])
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
    expect(keys(plan({ ...closed, ledger: [...closed.ledger, agentEntry({})] }, CFG))).toEqual(['stop:a70', 'tell:stopped:a70'])
    const taken = state({ issues: [issue(70, { stage: 'implementing', holder: OTHER })] })
    expect(keys(plan({ ...taken, ledger: [...taken.ledger, agentEntry({})] }, CFG))).toEqual(['stop:a70', `tell:claim-lost:70:${OTHER}`])
  })

  test('an agent stopped for a closed, merged or dropped issue is told to the owner (SPEC A2)', () => {
    const r = plan(withLedger(state({ issues: [mine(70, 'implementing', { open: false })] }), [agentEntry({})]), CFG)
    expect(find(r, 'tell:stopped:a70')).toMatchObject({ kind: 'tell', wake: 'stopped', rule: 'A2', fields: { issue: '70', why: 'closed' } })
    const merged = plan(withLedger(state({ issues: [mine(70, 'merged')] }), [agentEntry({})]), CFG)
    expect(find(merged, 'tell:stopped:a70')).toMatchObject({ fields: { issue: '70', why: 'merged' } })
    const dropped = state({ issues: [mine(70, 'implementing')], control: control({ dropped: [{ issue: 70, at: NOW - MIN }] }) })
    const d = plan(withLedger(dropped, [agentEntry({})]), CFG)
    expect(keys(d)).toEqual([`abandon:70:${NOW - MIN}`, 'stop:a70', 'tell:stopped:a70'])
    expect(find(d, 'tell:stopped:a70')).toMatchObject({ fields: { issue: '70', why: 'dropped' } })
  })

  test('a stop that failed leaves its agent marked timed-out: its rule waits while the agent still runs, and the owner hears (SPEC A1, 13)', () => {
    const life = NOW - 70 * MIN
    const key = `design:60:${life}`
    const s = state({ issues: [mine(60, 'designing', { stageSince: life })] })
    const timedOut = entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'timed-out', attempts: 1, agentId: 'a60', endedAt: NOW - 5 * MIN })
    const stopFailed = entry('stop:a60', 'stop-agent', { rule: 'A1', issue: 60, status: 'failed', attempts: 1, endedAt: NOW - 5 * MIN })
    const listed = (status: 'running' | 'killed' | 'completed' | 'idle') => ({ ...s, agents: [{ id: 'a60', type: 'callum-flow:designer', status }] })
    const r = plan(withLedger(listed('running'), [timedOut, stopFailed]), CFG)
    expect(keys(r)).toEqual(['tell:agent-failed:stop:a60'])
    expect(find(r, 'tell:agent-failed:stop:a60')).toMatchObject({ rule: 'A1', issue: 60, fields: { key: 'stop:a60', kind: 'stop-agent' } })
    expect(r.skipped).toContainEqual({ rule: 'D2', issue: 60, why: `${key}: its agent a60 still runs` })
    // told once; the designer is retried only once the list shows the old agent ended
    const told = entry('tell:agent-failed:stop:a60', 'tell', { wake: 'agent-failed', class: 'owner', issue: 60 })
    expect(keys(plan(withLedger(listed('running'), [timedOut, stopFailed, told]), CFG))).toEqual([])
    // idle is between turns: its turn ended, as completed (#560)
    for (const status of ['killed', 'completed', 'idle'] as const) {
      expect(keys(plan(withLedger(listed(status), [timedOut, stopFailed, told]), CFG))).toEqual([key])
    }
    expect(keys(plan(withLedger(s, [timedOut, stopFailed, told]), CFG))).toEqual([key])
    // a stop is tried once (SPEC 6.1): a failed A2 stop is told, not repeated
    const closed = state({ issues: [mine(70, 'implementing', { open: false })] })
    const a2 = entry('stop:a70', 'stop-agent', { rule: 'A2', issue: 70, status: 'failed', attempts: 1, endedAt: NOW - 5 * MIN })
    expect(keys(plan(withLedger(closed, [agentEntry({}), a2]), CFG))).toEqual(['tell:stopped:a70'])
    expect(keys(plan(withLedger(closed, [agentEntry({}), a2, entry('tell:stopped:a70', 'tell', { wake: 'stopped', class: 'owner', issue: 70 })]), CFG))).toEqual([
      'tell:agent-failed:stop:a70',
    ])
  })

  test('an agent that works on after its answer is recorded (its tool answers before its turn ends) is still timed out and stopped, so its branch is not held for good (SPEC A1, A2, #548)', () => {
    // a fixer answered through its tool an hour in, then went on (or sat waiting on a job)
    const answered = (over: Partial<LedgerEntry> = {}) =>
      entry('fixer:guard:550:head50', 'spawn', {
        agent: 'fixer',
        class: 'drive',
        issue: 50,
        status: 'done',
        startedAt: NOW - 3 * HOUR,
        endedAt: NOW - 2 * HOUR,
        agentId: 'a-fix',
        outcome: { kind: 'handoff', notGated: false, run: 'R50', head: 'head50', newBranch: null },
        ...over,
      })
    const listed = (status: 'running' | 'waiting' | 'completed' | 'killed' | 'idle') => ({ agents: [{ id: 'a-fix', type: 'callum-flow:fixer', status }] })
    const r = plan(mergeReady([guarded(), reviewed(), answered()], listed('waiting')), CFG)
    expect(keys(r)).toEqual(['stop:a-fix'])
    expect(find(r, 'stop:a-fix')).toMatchObject({ rule: 'A1', reason: 'timed out', entry: 'fixer:guard:550:head50' })
    // the merge waits on it meanwhile, and goes once the list shows it ended
    expect(r.skipped).toContainEqual({ rule: 'M5', issue: 50, why: 'an agent already works the branch of #50 (merge)' })
    // listed idle, its turn has ended (Claude Code 2.1.299 lists it so for 20 s or more before
    // completed, #560): no stop of an agent past its turn, and the merge goes
    for (const status of ['completed', 'killed', 'idle'] as const) expect(keys(plan(mergeReady([guarded(), reviewed(), answered()], listed(status)), CFG))).toEqual(['merge:550:head50'])
    // within its timeout it works on, except where an A2 stop applies: the owner dropped the issue
    const young = answered({ startedAt: NOW - 30 * MIN, endedAt: NOW - 20 * MIN })
    expect(keys(plan(mergeReady([guarded(), reviewed(), young], listed('running')), CFG))).toEqual([])
    const dropped = control({ dropped: [{ issue: 50, at: NOW - MIN }] })
    expect(keys(plan(mergeReady([guarded(), reviewed(), young], { ...listed('running'), control: dropped }), CFG))).toEqual([`abandon:50:${NOW - MIN}`, 'stop:a-fix', 'tell:stopped:a-fix'])
    // an answer just in: the list has not yet marked the agent completed, so nothing is stopped
    const fresh = answered({ endedAt: NOW - 5_000 })
    expect(keys(plan(mergeReady([guarded(), reviewed(), fresh], listed('running')), CFG))).toEqual([])
  })

  test('a running agent entry whose agent is listed idle is left to the reconciling read: plan neither stops nor retries it, so an agent the loop awaits a repair reply from is never cut off (#560)', () => {
    // the fixer's answer did not parse and the loop sent its repair message: the entry runs on,
    // reminded, while the list may still show the agent idle until the message resumes it
    const repairing = entry('fixer:guard:550:head50', 'spawn', {
      agent: 'fixer',
      class: 'drive',
      issue: 50,
      status: 'running',
      startedAt: NOW - 30 * MIN,
      endedAt: null,
      agentId: 'a-fix',
      reminded: true,
    })
    const r = plan(mergeReady([guarded(), reviewed(), repairing], { agents: [{ id: 'a-fix', type: 'callum-flow:fixer', status: 'idle' }] }), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'M5', issue: 50, why: 'an agent already works the branch of #50 (merge)' })
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
    expect(keys(failed)).toEqual([`tell:agent-failed:restart:${at}`])
    expect(failed.skipped).toContainEqual({ rule: 'H4', issue: null, why: `exhausted: restart:${at}` })
  })

  test('a restart that failed tells the owner once, so the drain never holds in silence (SPEC H4, 6.1)', () => {
    const at = NOW - 10 * MIN
    const failed = entry(`restart:${at}`, 'restart-self', { rule: 'H4', status: 'failed', summary: 'dev-restart-self: exit 1: refusing' })
    const r = plan(withLedger(state({ control: due(at) }), [failed]), CFG)
    expect(keys(r)).toEqual([`tell:agent-failed:restart:${at}`])
    expect(find(r, `tell:agent-failed:restart:${at}`)).toMatchObject({ kind: 'tell', class: 'owner', fields: { key: `restart:${at}`, kind: 'restart-self' } })
    const told = entry(`tell:agent-failed:restart:${at}`, 'tell', { wake: 'agent-failed', class: 'owner' })
    expect(keys(plan(withLedger(state({ control: due(at) }), [failed, told]), CFG))).toEqual([])
  })

  test('a ci-stalled run holds the restart: its CI step is still live in the daemon (SPEC H4, D-15)', () => {
    const at = NOW - 10 * MIN
    const stalled = state({ control: due(at), issues: [mine(48, 'in pipeline', { pr: 548 })], runs: [run(48, 'ci-stalled', { detail: 'reason=no-workflow' })] })
    const r = plan(withLedger(stalled, [entry('tell:no-ci:01M4RQ0048AAAA', 'tell', { wake: 'no-ci', issue: 48 })]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'H4', issue: null, why: 'update due: draining, waiting on run 01M4RQ0048AAAA ci-stalled' })
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

  test('a hand merge of a closing PR onto an epic base closes its issue, as callum-flow-merge would have said (D-29)', () => {
    const read = entry('rollout:70', 'rollout', { issue: 70, pr: 570, outcome: { kind: 'rollout', rollout: 'merge', closeIssue: null } })
    const guard = (fails: { name: string; reason: string }[], startedAt: number) =>
      entry(`guard:570:h7:${startedAt}`, 'guard', { issue: 70, pr: 570, head: 'h7', startedAt, endedAt: startedAt + 1000, outcome: { kind: 'guard', fails, warns: [] } })
    const base = [{ name: 'base', reason: 'PR targets epic/loop, default branch is main; if the PR intentionally targets an epic/integration branch, confirm that with the brief and rerun with --base epic/loop' }]
    const s = state({ issues: [handMerged()] })
    expect(keys(plan(withLedger(s, [read, guard(base, NOW - 60 * MIN)]), CFG))).toEqual(['close:70'])
    // the latest guard decides: a PR retargeted to the default branch closes its issue by itself
    expect(keys(plan(withLedger(s, [read, guard(base, NOW - 60 * MIN), guard([], NOW - 40 * MIN)]), CFG))).toEqual([])
    // a base that could not be read says nothing; a run-it or keep-open rollout leaves the issue open
    expect(keys(plan(withLedger(s, [read, guard([{ name: 'base', reason: 'cannot read the PR base' }], NOW - 60 * MIN)]), CFG))).toEqual([])
    const keepOpen = entry('rollout:70', 'rollout', { issue: 70, pr: 570, outcome: { kind: 'rollout', rollout: 'keep-open', closeIssue: null } })
    expect(keys(plan(withLedger(s, [keepOpen, guard(base, NOW - 60 * MIN)]), CFG))).toEqual([])
  })

  test('a loop merge whose rollout read failed has it read again, then followed up once', () => {
    const unread = entry('merge:570:h7', 'merge', {
      issue: 70,
      pr: 570,
      head: 'h7',
      endedAt: NOW - 5 * MIN,
      outcome: { kind: 'merge', result: 'merged', rollout: null, closeIssue: null, line: 'merged' },
    })
    const s = state({ issues: [handMerged()], milestone: { open: 2, closed: 1, expected: 'patch' } })
    expect(keys(plan(withLedger(s, [unread]), CFG))).toEqual(['rollout:70'])
    const read = entry('rollout:70', 'rollout', { issue: 70, pr: 570, outcome: { kind: 'rollout', rollout: 'run-it', closeIssue: null } })
    expect(keys(plan(withLedger(s, [unread, read]), CFG))).toEqual(['milestone-later:70', 'task:run-it:70'])
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
    const live = Array.from({ length: 5 }, (_, i) => mine(100 + i, 'implementing'))
    const s = state({ queue: [1], issues: [issue(1), ...live], pool: { free: 16, total: 16, slots: [] } })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual(['tell:at-cap:0'])
    expect(r.atCap).toBe(true)
    expect(r.skipped).toContainEqual({ rule: 'D1', issue: 1, why: 'in-flight cap: 5 of 5' })
    expect(r.title).toBe('🔄 dev-system (Q:1 - D:5 - M:0) · observe · at cap')
    // a notice, not an owner item
    expect(r.owner).toBe(0)
    const told = withLedger(s, [entry('tell:at-cap:0', 'tell', { wake: 'at-cap' })])
    expect(keys(plan(told, CFG))).toEqual([])
    // a claim since then starts the count over: reaching the cap again is told again
    const claimed = withLedger(told, [entry('claim:99:x', 'claim', { class: 'start', issue: 99, endedAt: NOW - 3 * MIN, outcome: { kind: 'claim', result: 'claimed' } })])
    expect(keys(plan(claimed, CFG))).toEqual([`tell:at-cap:${NOW - 3 * MIN}`])
    expect(plan({ ...s, issues: s.issues.slice(0, 5) }, CFG).atCap).toBe(false)
  })

  // finished: the ledger after each claim the plan made ended this long after it started
  const finished = (s: State, r: PlanResult, tookMs: number): State => ({
    ...running(s, r),
    ledger: running(s, r).ledger.map(e =>
      e.kind === 'claim' && e.status === 'running'
        ? { ...e, status: 'done' as const, endedAt: s.now + tookMs, outcome: { kind: 'claim' as const, result: 'claimed' as const } }
        : e,
    ),
  })

  test('a fresh claim counts toward the in-flight cap until the factory shows it live (testbed run 2, #547)', () => {
    // four live, cap five: one pass claims #35, the next 13 s later still sees #35 queued
    const live = Array.from({ length: 4 }, (_, i) => mine(100 + i, 'implementing'))
    const first = state({ queue: [35, 36], issues: [issue(35), issue(36), ...live], pool: { free: 16, total: 16, slots: [] } })
    const r1 = plan(first, CFG)
    expect(keys(r1)).toEqual([`claim:35:${NOW - 30 * MIN}`, 'tell:at-cap:0'])
    const second = { ...finished(first, r1, 5_000), now: NOW + 13_000 }
    const r2 = plan(second, CFG)
    expect(keys(r2).filter(k => k.startsWith('claim:'))).toEqual([])
    expect(r2.skipped).toContainEqual({ rule: 'D1', issue: 36, why: 'in-flight cap: 5 of 5' })
    expect(r2.atCap).toBe(true)
    // once observed live the claim is counted there, not twice
    const seen = { ...second, queue: [36], issues: [mine(35, 'designing', { stageSince: NOW + 3_000 }), issue(36), ...live] }
    expect(plan(seen, CFG).skipped).toContainEqual({ rule: 'D1', issue: 36, why: 'in-flight cap: 5 of 5' })
    // a claim the factory never shows stops counting after one heartbeat interval
    const later = { ...second, now: NOW + CFG.heartbeatEveryMs + 6_000, ledger: second.ledger.map(e => (e.kind === 'heartbeat' || e.kind === 'sweep' ? { ...e, endedAt: NOW } : e)) }
    expect(keys(plan(later, CFG))).toContain(`claim:36:${NOW - 30 * MIN}`)
    // a worktree too: the claimed issue will be in design
    const tight = { ...second, issues: [issue(35), issue(36)], pool: { free: 3, total: 16, slots: [] } }
    expect(plan(tight, CFG).skipped).toContainEqual({ rule: 'D1', issue: 36, why: 'no free worktree' })
  })

  test('no second claim when the claim event lands after ready (testbed issue 11, #538)', () => {
    // the first pass claims #11 before the factory knows it; the ready event lands first
    const first = state({ queue: [11], issues: [issue(11, { stage: null, stageSince: null })] })
    const r1 = plan(first, CFG)
    expect(keys(r1)).toEqual(['claim:11:new'])
    const claimed = { ...finished(first, r1, 4_000), now: NOW + 29_000 }
    const late = { ...claimed, issues: [issue(11, { stageSince: NOW + 1_000 })] }
    const r2 = plan(late, CFG)
    expect(keys(r2)).toEqual([])
    expect(r2.skipped).toContainEqual({ rule: 'D1', issue: 11, why: 'claimed; the factory state has not caught up' })
    // queued again after the claim ended (released, then made ready again): claimed again
    const again = { ...claimed, issues: [issue(11, { stageSince: NOW + 20_000 })] }
    expect(keys(plan(again, CFG))).toEqual([`claim:11:${NOW + 20_000}`])
    // a claim that lost never holds the issue back
    const lost = { ...late, ledger: late.ledger.map(e => (e.kind === 'claim' ? { ...e, outcome: { kind: 'claim' as const, result: 'lost' as const } } : e)) }
    expect(keys(plan(lost, CFG))).toEqual([`claim:11:${NOW + 1_000}`])
  })

  test('retry counts follow SPEC 6.1: a close and reopen once, a slot return twice', () => {
    const stalled = state({ issues: [mine(48, 'in pipeline', { pr: 548 })], runs: [run(48, 'ci-stalled', { detail: 'reason=no-checks' })] })
    const reopen = entry('reopen:548:01M4RQ0048AAAA', 'pr-reopen', { issue: 48, pr: 548, status: 'failed', attempts: 1, endedAt: NOW - 10 * MIN })
    expect(keys(plan(withLedger(stalled, [reopen]), CFG))).toEqual(['tell:agent-failed:reopen:548:01M4RQ0048AAAA'])
    const slot = { path: '/t/1', branch: 'feat/issue-12-x', state: 'leased', dirty: false, busy: false }
    const merged = state({ issues: [issue(12, { stage: 'merged', holder: OTHER })], pool: { free: 8, total: 16, slots: [slot] } })
    const returned = (attempts: number) => entry('release:/t/1:feat/issue-12-x', 'release-worktree', { issue: 12, status: 'failed', attempts, endedAt: NOW - 10 * MIN })
    expect(keys(plan(withLedger(merged, [returned(1)]), CFG))).toEqual(['release:/t/1:feat/issue-12-x'])
    expect(keys(plan(withLedger(merged, [returned(2)]), CFG))).toEqual(['tell:agent-failed:release:/t/1:feat/issue-12-x'])
    expect(CFG.maxAttempts).toMatchObject({ 'pr-reopen': 1, 'stop-agent': 1, 'release-worktree': 2 })
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

describe('G5: the main checkout (#544)', () => {
  // testbed 2026-10-13: an adjudicator checked out another issue's branch in the session's
  // directory, and the loop kept starting agents there for 25 minutes
  const SHA = '9f3c2a1b7d4e5f60718293a4b5c6d7e8f9012345'
  const LIFE = NOW - 30 * MIN
  const designing = (checkout: State['checkout']) => state({ issues: [mine(60, 'designing')], checkout })
  const told = (s: State, key: string) => withLedger(s, [entry(key, 'tell', { class: 'owner', wake: 'checkout' })])

  test('a detached checkout shows within one pass: the title, one owner notice, and designers held', () => {
    const s = designing({ branch: null, head: SHA, defaultBranch: 'main', dirty: [] })
    const r = plan(s, CFG)
    expect(keys(r)).toEqual([`tell:checkout:detached@${SHA}`])
    expect(find(r, `tell:checkout:detached@${SHA}`)).toMatchObject({ kind: 'tell', wake: 'checkout', class: 'owner', rule: 'G5', fields: { head: SHA, default: 'main' } })
    expect(r.title).toContain('checkout')
    expect(r.owner).toBe(1)
    expect(r.skipped).toContainEqual({ rule: 'D2', issue: 60, why: 'main checkout detached at 9f3c2a1 (spawn)' })
    // told once: the next pass holds on in silence, and the title still says so
    const after = plan(told(s, `tell:checkout:detached@${SHA}`), CFG)
    expect(keys(after)).toEqual([])
    expect([after.title.includes('checkout'), after.owner]).toEqual([true, 1])
    // put back on its default branch: the designer starts, and the title drops the word
    const back = plan({ ...told(s, `tell:checkout:detached@${SHA}`), checkout: CLEAN }, CFG)
    expect(keys(back)).toEqual([`design:60:${LIFE}`])
    expect(back.title).not.toContain('checkout')
  })

  test('a checkout switched to another branch, or carrying changes, holds designers and tells once', () => {
    const switched = plan(designing({ branch: 'feat/issue-4-slugify-separator', head: SHA, defaultBranch: 'main', dirty: [] }), CFG)
    expect(keys(switched)).toEqual([`tell:checkout:feat/issue-4-slugify-separator@${SHA}`])
    expect(switched.skipped).toContainEqual({ rule: 'D2', issue: 60, why: 'main checkout on feat/issue-4-slugify-separator, not main (spawn)' })
    const dirty = plan(designing({ ...CLEAN, dirty: ['plugins/factory-loop/hooks/plan.ts', 'README.md', 'a.ts', 'b.ts'] }), CFG)
    expect(keys(dirty)).toEqual([`tell:checkout:main@${CLEAN.head}:changed`])
    expect(dirty.skipped).toContainEqual({ rule: 'D2', issue: 60, why: 'main checkout has changes: plugins/factory-loop/hooks/plan.ts, README.md, a.ts and 1 more (spawn)' })
    // a checkout that cannot be read is not proven where it belongs: held, and told
    const unread = plan(designing({ error: 'exit 128: fatal: not a git repository' }), CFG)
    expect(keys(unread)).toEqual(['tell:checkout:unreadable'])
    expect(unread.skipped).toContainEqual({ rule: 'D2', issue: 60, why: 'main checkout unreadable: exit 128: fatal: not a git repository (spawn)' })
    // not read at all (the replay harness): nothing to hold
    expect(keys(plan(designing(null), CFG))).toEqual([`design:60:${LIFE}`])
  })

  test('what starts in the checkout waits: claims, agents and tasks; free work, judges and notices go on', () => {
    const moved = { branch: 'feat/issue-4-slugify-separator', head: SHA, defaultBranch: 'main', dirty: [] }
    const key = `tell:checkout:feat/issue-4-slugify-separator@${SHA}`
    // a claim, a delegation, a gate adjudicator and the release task all wait
    const busy = told(
      state({
        queue: [7],
        issues: [issue(7), mine(61, 'designing'), mine(45, 'parked', { pr: 545 })],
        runs: [run(45, 'parked')],
        milestone: { open: 0, closed: 2, expected: null },
        checkout: moved,
      }),
      key,
    )
    const withDesign = withLedger(busy, [
      entry(`design:61:${LIFE}`, 'spawn', { agent: 'designer', class: 'develop', issue: 61, outcome: { kind: 'designer', brief: brief(61), created: [], pendingDecision: false } }),
    ])
    const r = plan(withDesign, CFG)
    expect(keys(r)).toEqual([])
    const why = r.skipped.map(k => k.why)
    for (const kind of ['claim', 'delegate', 'spawn', 'task']) expect(why).toContain(`main checkout on feat/issue-4-slugify-separator, not main (${kind})`)
    // the merge reads only the object store and remote refs, so it goes on
    const ready = mergeReady([guarded(), reviewed()])
    expect(keys(plan({ ...told(ready, key), checkout: moved }, CFG))).toEqual(['merge:550:head50'])
  })
})

describe('H5: the main checkout kept up to date with origin (#555)', () => {
  // stage D run 2: the testbed's main checkout stayed at the merge of PR 47 for the whole run
  // while origin's main moved on through eight more merges, so agents started there read code
  // several merges stale. Only an acting pass plans it (see the observe test below).
  const ACT = config({ mode: 'act' })
  const LAST = NOW - 2 * MIN
  const updates = (r: PlanResult) => r.actions.filter(a => a.kind === 'update-checkout')
  const merged = (endedAt: number) =>
    entry('merge:547:head47', 'merge', { issue: 47, pr: 547, head: 'head47', startedAt: endedAt - MIN, endedAt, outcome: { kind: 'merge', result: 'merged', rollout: 'merge', closeIssue: null, line: 'merged' } })
  const others = (s: State) => s.ledger.filter(e => e.kind !== 'update-checkout')

  test('a merge brings the main checkout up to date on the next pass, a free action; so does every checkoutEveryMs', () => {
    const r = plan(withLedger(state(), [merged(NOW - MIN)]), ACT)
    expect(updates(r)).toEqual([
      { kind: 'update-checkout', key: `update-checkout:${LAST}`, class: 'free', rule: 'H5', reason: 'a merge since the last update', issue: null, branch: 'main', head: CLEAN.head },
    ])
    // a merge the last update already saw asks for nothing
    expect(updates(plan(withLedger(state(), [merged(NOW - 3 * MIN)]), ACT))).toEqual([])
    // with no merge, it is due every checkoutEveryMs (5 minutes), and first thing when none ran
    expect(updates(plan(state({ now: LAST + CFG.checkoutEveryMs - 1 }), ACT))).toEqual([])
    expect(updates(plan(state({ now: LAST + CFG.checkoutEveryMs }), ACT)).map(a => [a.key, a.reason])).toEqual([[`update-checkout:${LAST}`, 'due']])
    const fresh = state()
    expect(updates(plan({ ...fresh, ledger: others(fresh) }, ACT)).map(a => [a.key, a.reason])).toEqual([['update-checkout:0', 'none since the load']])
    expect(updates(plan(state({ now: LAST + CFG.checkoutEveryMs }), config({ mode: 'act', checkoutEveryMs: 60 * MIN })))).toEqual([])
    expect(CFG.checkoutEveryMs).toBe(5 * MIN)
  })

  test('the first pass after a load brings it up to date, however recent the last update: a reload can leave it stale', () => {
    // the last update (2 minutes ago) came before this load
    expect(updates(plan(state({ loadedAt: NOW - MIN }), ACT)).map(a => [a.key, a.reason])).toEqual([[`update-checkout:${LAST}`, 'none since the load']])
    // one this load made counts
    expect(updates(plan(state({ loadedAt: LAST }), ACT))).toEqual([])
  })

  test('an observe pass plans none: the ledger it derives from the event log holds no update, so one would be due every pass', () => {
    const due = state({ now: LAST + CFG.checkoutEveryMs })
    expect(updates(plan(due, ACT)).length).toBe(1)
    expect(CFG.mode).toBe('observe')
    expect(updates(plan(due, CFG))).toEqual([])
    expect(updates(plan({ ...due, ledger: others(due) }, CFG))).toEqual([])
    expect(updates(plan(withLedger(state(), [merged(NOW - MIN)]), CFG))).toEqual([])
  })

  test('a checkout off its default branch, carrying changes, detached or unread is left alone, and G5 speaks', () => {
    const at = (checkout: State['checkout']) => plan(withLedger(state({ checkout }), [merged(NOW - MIN)]), ACT)
    const dirty = at({ ...CLEAN, dirty: ['README.md'] })
    expect([updates(dirty), keys(dirty)]).toEqual([[], [`tell:checkout:main@${CLEAN.head}:changed`]])
    const switched = at({ ...CLEAN, branch: 'feat/issue-4-slugify-separator' })
    expect([updates(switched), keys(switched)]).toEqual([[], [`tell:checkout:feat/issue-4-slugify-separator@${CLEAN.head}`]])
    const detached = at({ ...CLEAN, branch: null })
    expect([updates(detached), keys(detached)]).toEqual([[], [`tell:checkout:detached@${CLEAN.head}`]])
    expect(updates(at({ error: 'exit 128' }))).toEqual([])
    // not read (the replay harness): nothing is known, so nothing moves
    expect(updates(at(null))).toEqual([])
  })

  test('held while a designer, an adjudicator or a task reads the checkout; an implementer or fixer, in a worktree of its own, does not hold it', () => {
    const reader = (agent: 'designer' | 'adjudicator', over: Partial<LedgerEntry> = {}) =>
      entry(`${agent}:60`, 'spawn', { agent, class: agent === 'designer' ? 'develop' : 'drive', issue: 60, status: 'running', endedAt: null, agentId: `agent-${agent}`, ...over })
    const base = state({ issues: [mine(60, 'designing')], agents: [{ id: 'agent-designer', type: 'factory-loop:designer', status: 'running' }] })
    const held = plan(withLedger(base, [merged(NOW - MIN), reader('designer')]), ACT)
    expect(updates(held)).toEqual([])
    expect(held.skipped).toContainEqual({ rule: 'H5', issue: null, why: 'update-checkout waits for work reading the main checkout: designer:60' })
    expect(updates(plan(withLedger(base, [merged(NOW - MIN), reader('adjudicator')]), ACT))).toEqual([])
    // an answer is in, but the list still shows the agent at work: it may still be reading
    expect(updates(plan(withLedger(base, [merged(NOW - MIN), reader('designer', { status: 'done', endedAt: NOW - MIN })]), ACT))).toEqual([])
    // the agent ended: the update goes ahead; listed idle, its turn has ended too (#560)
    for (const status of ['completed', 'idle'] as const) {
      const ended = { ...base, agents: [{ id: 'agent-designer', type: 'factory-loop:designer', status }] }
      expect(updates(plan(withLedger(ended, [merged(NOW - MIN), reader('designer', { status: 'done', endedAt: NOW - MIN })]), ACT)).length).toBe(1)
    }
    // a task is the model working in the checkout (a release, a hand merge's run-it), as G5 says
    const task = entry('task:release:2:none', 'task', { wake: 'release', class: 'drive', status: 'running', endedAt: null })
    const tasked = plan(withLedger(state(), [merged(NOW - MIN), task]), ACT)
    expect(updates(tasked)).toEqual([])
    expect(tasked.skipped).toContainEqual({ rule: 'H5', issue: null, why: 'update-checkout waits for work reading the main checkout: task:release:2:none' })
    expect(updates(plan(withLedger(state(), [merged(NOW - MIN), { ...task, status: 'done', endedAt: NOW - MIN }]), ACT)).length).toBe(1)
    const implementing = state({ issues: [mine(61, 'implementing')], agents: [{ id: 'agent-impl', type: 'callum-flow:implementer', status: 'running' }] })
    const delegated = entry(`delegate:61:${brief(61)}`, 'delegate', { class: 'develop', issue: 61, status: 'running', endedAt: null, agentId: 'agent-impl' })
    expect(updates(plan(withLedger(implementing, [merged(NOW - MIN), delegated]), ACT)).length).toBe(1)
  })

  test('while the update waits for readers, no new reader starts, so they drain and it runs: designers, adjudicators and tasks are held', () => {
    // stage D run 2 again: with five issues in flight a designer or adjudicator was nearly always
    // at work, so an update that only waited for a gap might never find one
    const LIFE = NOW - 20 * MIN
    const reading = entry(`design:60:${LIFE}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'running', startedAt: NOW - 5 * MIN, endedAt: null, agentId: 'agent-designer' })
    const busy = (issues: IssueView[], agents: State['agents']) =>
      state({
        issues: [...issues, mine(61, 'designing', { stageSince: LIFE }), mine(45, 'parked', { delegatedBrief: brief(45), run: '01M4RQ0045AAAA', pr: 545 })],
        runs: [run(45, 'parked')],
        milestone: { open: 0, closed: 2, expected: null },
        agents,
      })
    const s = busy([mine(60, 'designing', { stageSince: LIFE })], [{ id: 'agent-designer', type: 'factory-loop:designer', status: 'running' }])
    const held = plan(withLedger(s, [merged(NOW - MIN), reading]), ACT)
    expect(keys(held)).toEqual([])
    const why = held.skipped.map(k => k.why)
    for (const kind of ['designer', 'adjudicator', 'task']) expect(why).toContain(`waits for the main checkout's update (${kind})`)
    // with no update due, they start beside the reader as before
    const quiet = keys(plan(withLedger(s, [reading]), ACT))
    expect(quiet).toEqual(expect.arrayContaining([`design:61:${LIFE}`, 'task:release:2:none']))
    expect(quiet.some(k => k.startsWith('adjudicate:'))).toBe(true)
    // the reader is done: the update goes first, and the held readers start after it in the same
    // pass (plan's order is the order they run in)
    const drained = keys(plan(withLedger(busy([], []), [merged(NOW - MIN)]), ACT))
    expect(drained[0]).toBe(`update-checkout:${LAST}`)
    expect(drained).toEqual(expect.arrayContaining([`design:61:${LIFE}`, 'task:release:2:none']))
    // an update that cannot run when they drain (its retry backoff) holds nothing
    const backingOff = withLedger(s, [merged(NOW - MIN), reading, entry(`update-checkout:${LAST}`, 'update-checkout', { status: 'failed', attempts: 1, startedAt: NOW - MIN, endedAt: NOW - MIN })])
    expect(keys(plan(backingOff, ACT))).toEqual(quiet)
  })

  test('a refused update, the checkout carrying commits origin lacks, tells the owner once with the checkout notice', () => {
    const line = `REFUSED the main checkout at ${CLEAN.head} has commits not on origin/main`
    const refused = (s: State) => ({
      ...s,
      ledger: [...others(s), entry('update-checkout:0', 'update-checkout', { head: CLEAN.head, startedAt: LAST, endedAt: LAST, outcome: { kind: 'update-checkout', result: 'refused', line } })],
    })
    const key = `tell:checkout:main@${CLEAN.head}:refused`
    const r = plan(refused(state()), ACT)
    expect(keys(r)).toEqual([key])
    expect(find(r, key)).toMatchObject({ kind: 'tell', wake: 'checkout', class: 'owner', rule: 'H5', fields: { branch: 'main', head: CLEAN.head, default: 'main' }, context: [line] })
    // told once; the update is tried again at its cadence, not every pass
    const told = withLedger(refused(state()), [entry(key, 'tell', { class: 'owner', wake: 'checkout' })])
    expect(keys(plan(told, ACT))).toEqual([])
    // an update that went through ends it
    expect(keys(plan(state(), ACT))).toEqual([])
  })

  test('a refused checkout that changed since (the owner put it right) is not told the old refusal: the update is tried at once', () => {
    const line = `REFUSED the main checkout at ${CLEAN.head} has commits not on origin/main`
    const fixed = { ...CLEAN, head: 'f1x3df1x3df1x3df1x3df1x3df1x3df1x3df1x3d' }
    const s = state({ checkout: fixed })
    const r = plan({ ...s, ledger: [...others(s), entry('update-checkout:0', 'update-checkout', { head: CLEAN.head, startedAt: LAST, endedAt: LAST, outcome: { kind: 'update-checkout', result: 'refused', line } })] }, ACT)
    expect(keys(r)).toEqual([`update-checkout:${LAST}`])
    expect(updates(r)).toMatchObject([{ reason: 'the refused checkout changed', head: fixed.head }])
  })

  test('an update that keeps failing is never used up: it retries at its cadence, and the owner hears once', () => {
    const failing = (attempts: number, endedAt: number) =>
      withLedger(state(), [merged(NOW - MIN), entry(`update-checkout:${LAST}`, 'update-checkout', { status: 'failed', attempts, startedAt: endedAt, endedAt })])
    expect(keys(plan(failing(1, NOW - MIN), ACT))).toEqual([])
    expect(keys(plan(failing(1, NOW - 3 * MIN), ACT))).toEqual([`update-checkout:${LAST}`])
    expect(keys(plan(failing(3, NOW - MIN), ACT))).toEqual([`tell:agent-failed:update-checkout:${LAST}`])
    expect(keys(plan(failing(9, NOW - CFG.checkoutEveryMs), ACT))).toContain(`update-checkout:${LAST}`)
  })
})

describe('M8: the PR of a superseded run is closed (#553, I-39)', () => {
  // stage D run 2: issue 32's conflict fixes moved it to -v2, then -v2-v2, and PRs 44 and 50
  // stayed open with their Closes keyword beside the live PR 57
  const B = 'feat/issue-32-slug'
  const R1 = '01M4RQ0032AAAA'
  const R2 = '01M4RQ0032BBBB'
  const R3 = '01M4RQ0032CCCC'
  // a conflict fixer sent to a run and its PR that handed off on a new branch, with its new run
  const moved = (runId: string, pr: number, to: string, newRun: string | null) =>
    entry(`fixer:conflict:${pr}:h${pr}`, 'spawn', {
      agent: 'fixer',
      class: 'drive',
      issue: 32,
      run: runId,
      pr,
      head: `h${pr}`,
      outcome: { kind: 'handoff', notGated: false, run: newRun, head: `n${pr}`, newBranch: to },
    })
  const live = (branch: string, runId: string, pr: number | null) => run(32, 'running', { branch, run: runId, pr })
  const at = (ledger: LedgerEntry[], runs: State['runs']) => withLedger(state({ issues: [mine(32, 'in pipeline', { pr: 57 })], runs }), ledger)
  const closed = (pr: number) => entry(`pr-close:${pr}`, 'pr-close', { issue: 32, pr })

  test('once the new branch has its PR, the old PR is closed with a link to it', () => {
    const r = plan(at([moved(R1, 44, `${B}-v2`, R2)], [live(`${B}-v2`, R2, 50)]), CFG)
    expect(keys(r)).toEqual(['pr-close:44'])
    expect(find(r, 'pr-close:44')).toMatchObject({ kind: 'pr-close', class: 'free', rule: 'M8', issue: 32, pr: 44, run: R1, newBranch: `${B}-v2`, by: 50 })
  })

  test('no PR on the new branch yet: it waits, and says so', () => {
    const r = plan(at([moved(R1, 44, `${B}-v2`, R2)], [live(`${B}-v2`, R2, null)]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'M8', issue: 32, why: `PR #44 superseded: waiting for the PR of ${B}-v2` })
    expect(keys(plan(at([moved(R1, 44, `${B}-v2`, R2)], []), CFG))).toEqual([])
  })

  test('a chain (-v2, then -v2-v2) closes each older PR once', () => {
    const first = [moved(R1, 44, `${B}-v2`, R2)]
    expect(keys(plan(at(first, [live(`${B}-v2`, R2, 50)]), CFG))).toEqual(['pr-close:44'])
    // 44 closed; the second fix moves 50's work on, and the new run's PR is 57
    const second = [...first, closed(44), moved(R2, 50, `${B}-v2-v2`, R3)]
    const r = plan(at(second, [live(`${B}-v2-v2`, R3, 57)]), CFG)
    expect(keys(r)).toEqual(['pr-close:50'])
    expect(find(r, 'pr-close:50')).toMatchObject({ pr: 50, by: 57, newBranch: `${B}-v2-v2` })
    expect(keys(plan(at([...second, closed(50)], [live(`${B}-v2-v2`, R3, 57)]), CFG))).toEqual([])
    // both fixes done before either close: each old PR links the newest one
    const both = plan(at([...first, moved(R2, 50, `${B}-v2-v2`, R3)], [live(`${B}-v2-v2`, R3, 57)]), CFG)
    expect(both.actions.flatMap(a => (a.kind === 'pr-close' ? [[a.key, a.by]] : []))).toEqual([
      ['pr-close:44', 57],
      ['pr-close:50', 57],
    ])
  })

  test('never a PR whose run is not superseded: a fixer on the same branch, no run, or a run the log does not mark superseded', () => {
    // the fixer pushed to the branch it was sent to: nothing moved
    const same = entry('fixer:conflict:44:h44', 'spawn', { agent: 'fixer', issue: 32, run: R1, pr: 44, outcome: { kind: 'handoff', notGated: false, run: R2, head: 'n', newBranch: null } })
    expect(keys(plan(at([same], [live(B, R2, 44)]), CFG))).toEqual([])
    // the fixer was sent with no run (a handoff fixer): no superseded event was logged
    expect(keys(plan(at([{ ...moved(R1, 44, `${B}-v2`, R2), run: null }], [live(`${B}-v2`, R2, 50)]), CFG))).toEqual([])
    // the watcher still shows the old run and the event log does not mark it superseded
    const old = run(32, 'cancelled', { branch: B, run: R1, pr: 44, superseded: false })
    expect(keys(plan(at([moved(R1, 44, `${B}-v2`, R2)], [old, live(`${B}-v2`, R2, 50)]), CFG))).toEqual([])
    const marked = { ...old, superseded: true }
    expect(keys(plan(at([moved(R1, 44, `${B}-v2`, R2)], [marked, live(`${B}-v2`, R2, 50)]), CFG))).toEqual(['pr-close:44'])
    // the new branch's PR is the old one: nothing replaced it
    expect(keys(plan(at([moved(R1, 44, `${B}-v2`, R2)], [live(`${B}-v2`, R2, 44)]), CFG))).toEqual([])
  })

  test('a run task(redrive) superseded: its PR is closed once the issue\'s run on the regated branch has a PR', () => {
    // callum-flow-regate moved B to B-v2 and logged `superseded` for R1; no fixer was involved
    const old = run(32, 'cancelled', { branch: B, run: R1, pr: 44, superseded: true })
    const redrive = entry(`task:redrive:${B}:h44`, 'task', { wake: 'redrive', class: 'drive', issue: 32, run: R1, pr: 44, outcome: wakeAnswer('done') })
    const r = plan(at([redrive], [old, live(`${B}-v2`, R2, 50)]), CFG)
    expect(keys(r)).toEqual(['pr-close:44'])
    expect(find(r, 'pr-close:44')).toMatchObject({ rule: 'M8', issue: 32, pr: 44, run: R1, newBranch: `${B}-v2`, by: 50 })
    expect(keys(plan(at([redrive, closed(44)], [old, live(`${B}-v2`, R2, 50)]), CFG))).toEqual([])
    // a chain links the newest PR; an older superseded run on the way is closed too
    const mid = run(32, 'cancelled', { branch: `${B}-v2`, run: R2, pr: 50, superseded: true })
    const chain = plan(at([], [old, mid, live(`${B}-v2-v2`, R3, 57)]), CFG)
    expect(chain.actions.flatMap(a => (a.kind === 'pr-close' ? [[a.key, a.by]] : []))).toEqual([
      ['pr-close:44', 57],
      ['pr-close:50', 57],
    ])
    // nothing until the regated branch has a PR of its own; never a run left unmarked, a branch
    // that is not the old one's -v<n>, another issue's run, or the old PR itself
    expect(keys(plan(at([], [old, live(`${B}-v2`, R2, null)]), CFG))).toEqual([])
    expect(keys(plan(at([], [{ ...old, superseded: false }, live(`${B}-v2`, R2, 50)]), CFG))).toEqual([])
    expect(keys(plan(at([], [old, live('feat/issue-32-other', R2, 50)]), CFG))).toEqual([])
    expect(keys(plan(at([], [old, run(33, 'running', { branch: `${B}-v2`, run: R2, pr: 50 })]), CFG))).toEqual([])
    expect(keys(plan(at([], [old, live(`${B}-v2`, R2, 44)]), CFG))).toEqual([])
  })

  test('the new branch and run are the fixer\'s word: neither may name another issue\'s run or PR', () => {
    const R38 = '01M4RQ0038AAAA'
    const other = run(38, 'running', { branch: 'feat/issue-38-other', run: R38, pr: 52 })
    // a fixer that worked in the wrong slot names issue 38's branch: PR 44 stays open, and says why
    const wrongBranch = plan(at([moved(R1, 44, 'feat/issue-38-other', R38)], [other]), CFG)
    expect(keys(wrongBranch)).toEqual([])
    expect(wrongBranch.skipped).toContainEqual({ rule: 'M8', issue: 32, why: 'PR #44 left open: feat/issue-38-other is not a branch of #32' })
    // the right branch, with no PR yet, and issue 38's run id: it waits for the branch's own PR
    const wrongRun = plan(at([moved(R1, 44, `${B}-v2`, R38)], [other, live(`${B}-v2`, R2, null)]), CFG)
    expect(keys(wrongRun)).toEqual([])
    expect(wrongRun.skipped).toContainEqual({ rule: 'M8', issue: 32, why: `PR #44 superseded: waiting for the PR of ${B}-v2` })
    // a chain is never followed into another issue's move
    const theirs = entry('fixer:conflict:52:h52', 'spawn', {
      agent: 'fixer',
      issue: 38,
      run: R38,
      pr: 52,
      outcome: { kind: 'handoff', notGated: false, run: null, head: 'n52', newBranch: 'feat/issue-38-other-v2' },
    })
    const chained = plan(withLedger(state({ issues: [mine(32, 'in pipeline', { pr: 57 }), mine(38, 'in pipeline', { pr: 60 })], runs: [run(38, 'running', { branch: 'feat/issue-38-other-v2', run: '01M4RQ0038BBBB', pr: 60 }), live(`${B}-v2`, R2, 50)] }), [moved(R1, 44, `${B}-v2`, R38), theirs]), CFG)
    expect(chained.actions.flatMap(a => (a.kind === 'pr-close' ? [[a.key, a.by]] : []))).toEqual([
      ['pr-close:44', 50],
      ['pr-close:52', 60],
    ])
  })
})

// --- properties every plan keeps (SPEC 5.9), over every scenario state above ----------------
// plan() checks all of them on every call in this file; these states also put each bound to work.

const hourOld = (n: number, make: (i: number) => LedgerEntry) => Array.from({ length: n }, (_, i) => make(i))
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
  // six claimable issues: four claims, the rest wait for the next pass
  ['queue-six', state({ queue: [1, 2, 3, 4, 5, 6], issues: [1, 2, 3, 4, 5, 6].map(n => issue(n)), pool: { free: 16, total: 16, slots: [] } })],
  // three wakes wanted at once: the review-cap tell, a cancelled run's judge, the release task
  ['wakes', state({
    issues: [mine(45, 'parked', { pr: 545 }), mine(46, 'in pipeline', { pr: 546 })],
    runs: [run(45, 'parked', { reviewFixRounds: 3 }), run(46, 'cancelled')],
    milestone: { open: 0, closed: 3, expected: null },
  })],
  // a busy hour: 30 claims and 40 spawns already, so claims and spawns wait for it to clear
  ['busy-hour', withLedger(state({ queue: [1], issues: [issue(1), mine(60, 'designing')] }), [
    ...hourOld(30, i => entry(`claim:${200 + i}:x`, 'claim', { class: 'start', issue: 200 + i, startedAt: NOW - 30 * MIN })),
    ...hourOld(120, i => entry(`design:${300 + i}:x`, 'spawn', { agent: 'designer', class: 'develop', issue: 300 + i, startedAt: NOW - 30 * MIN })),
  ])],
]

describe('properties', () => {
  test('every scenario keeps every property, at every tier (SPEC 5.9)', () => {
    for (const [, s] of SCENARIOS) {
      for (const w of TIER_READINGS) plan({ ...s, usage: { ...w, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false } }, CFG)
    }
  })

  test('the bounds are put to work: one wake per pass, claims per pass, and the start and spawn caps', () => {
    const why = SCENARIOS.flatMap(([, s]) => plan(s, CFG).skipped.map(k => k.why))
    expect(why).toContain('one wake per pass')
    expect(why).toContain('claims per pass')
    expect(why).toContain('rate cap: start 30/30')
    expect(why).toContain('rate cap: spawn 120/120')
    expect(keys(plan(SCENARIOS.find(([n]) => n === 'wakes')?.[1] ?? state(), CFG))).toEqual(['tell:review-cap:01M4RQ0045AAAA:3'])
  })

  test('control safety is checked for each directive alone: paused, and no new work (SPEC 5.9 item 5)', () => {
    for (const [name, s] of SCENARIOS) {
      const paused = s.issues.map(i => i.number)
      const p = planOf({ ...s, control: control({ paused }) }, CFG)
      expect([name, p.actions.filter(a => a.issue !== null && paused.includes(a.issue) && a.kind !== 'heartbeat').map(a => a.key)]).toEqual([name, []])
      const n = planOf({ ...s, control: control({ noNewWork: true }) }, CFG)
      expect([name, n.actions.filter(a => a.class === 'start' || a.class === 'develop').map(a => a.key)]).toEqual([name, []])
    }
  })
})

// --- #550 and #551: re-guard after a repair, judge a failure once, fast-forward a lagging worktree ---

// The guard's head FAIL line for PR 550 (images/base/callum-flow-merge-guard): the run, origin
// and PR heads, then one worktree= per worktree on the branch.
function headFail(runHead: string, origin: string, prHead: string, ...worktrees: string[]) {
  const wt = worktrees.map(w => ` worktree=${w}`).join('')
  return { name: 'head', reason: `run=${runHead} origin=${origin} pr=${prHead}${wt} (run 01M4RQ0050AAAA); fix: if only a worktree lags the branch, fast-forward it` }
}
const LAG = headFail('head50', 'head50', 'head50', 'wt50')
const CI_FAIL = { name: 'checks', reason: 'ci=fail' }

// The guard-fail judge's answer for a failure, under the key plan gives that failure.
function judgedFail(fails: { name: string; reason: string }[], decision: string, over: Partial<LedgerEntry> = {}) {
  const key = keys(plan(mergeReady([guarded(fails)]), CFG))[0] as string
  return entry(key, 'judge', { wake: 'guard-fail', class: 'drive', issue: 50, pr: 550, head: 'head50', outcome: wakeAnswer(decision, { instructions: 'make ci pass' }), ...over })
}
function fastForward(key: string, result: 'forwarded' | 'current' | 'refused', over: Partial<LedgerEntry> = {}) {
  return entry(key, 'fast-forward', { issue: 50, pr: 550, head: 'head50', outcome: { kind: 'fast-forward', result, line: `${result.toUpperCase()} x` }, ...over })
}
function fixerDone(key: string, startedAt: number, endedAt: number) {
  return entry(key, 'spawn', { agent: 'fixer', class: 'drive', issue: 50, pr: 550, head: 'head50', startedAt, endedAt })
}
const waits = (r: PlanResult) => r.skipped.filter(s => s.issue === 50 && s.rule.startsWith('M'))

describe('M1, M2: re-guard after a repair and judge a failure once (#550)', () => {
  test('a fixer that ends done without a commit makes the guard stale, so the next pass guards again', () => {
    const judged = judgedFail([CI_FAIL], 'fixer', { endedAt: NOW - 50_000 })
    const fixerKey = keys(plan(mergeReady([guarded([CI_FAIL]), judged]), CFG))[0] as string
    expect(fixerKey.startsWith('fixer:guard:550:head50:')).toBe(true)
    const fixed = fixerDone(fixerKey, NOW - 40_000, NOW - 10_000)
    expect(keys(plan(mergeReady([guarded([CI_FAIL]), judged, fixed]), CFG))).toEqual(['guard:550:head50:2'])
    // any fixer on the PR counts: a conflict fixer that made no commit too
    const conflict = [{ name: 'mergeable', reason: 'conflicts with main, rebase and re-gate' }]
    const resolved = fixerDone('fixer:conflict:550:head50', NOW - 40_000, NOW - 10_000)
    expect(keys(plan(mergeReady([guarded(conflict), resolved]), CFG))).toEqual(['guard:550:head50:2'])
  })

  test('a PR no rule acts on says what it waits for', () => {
    const judged = judgedFail([CI_FAIL], 'fixer', { endedAt: NOW - 50_000 })
    const fixerKey = keys(plan(mergeReady([guarded([CI_FAIL]), judged]), CFG))[0] as string
    // the fixer ended before the guard that saw the failure: nothing to do but wait
    const fixed = fixerDone(fixerKey, NOW - 4 * MIN, NOW - 3 * MIN)
    const r = plan(mergeReady([guarded([CI_FAIL]), judged, fixed]), CFG)
    expect(keys(r)).toEqual([])
    expect(waits(r)).toEqual([{ rule: 'M2', issue: 50, why: `PR #550 waits for its head to move or its next guard in 240s (${fixerKey} is done)` }])
    // a guard still running, a judge still open, an owner notice and a hold each say so too
    const guarding = plan(mergeReady([guarded([], [], 1, { status: 'running', endedAt: null })]), CFG)
    expect(waits(guarding)).toEqual([{ rule: 'M1', issue: 50, why: 'PR #550 waits for guard:550:head50:1 to finish' }])
    const open = { ...judged, status: 'running' as const, endedAt: null, outcome: undefined }
    expect(waits(plan(mergeReady([guarded([CI_FAIL]), open]), CFG))).toEqual([{ rule: 'M2', issue: 50, why: `PR #550 waits for ${judged.key} to finish` }])
    const base = [{ name: 'base', reason: 'PR targets epic/x' }]
    const told = entry('tell:base:550:head50', 'tell', { wake: 'base', class: 'owner', issue: 50 })
    expect(waits(plan(mergeReady([guarded(base), told]), CFG))).toEqual([{ rule: 'M2', issue: 50, why: 'PR #550 waits on the owner (tell:base:550:head50)' }])
    const held = judgedFail([CI_FAIL], 'hold')
    expect(waits(plan(mergeReady([guarded([CI_FAIL]), held]), CFG))).toEqual([
      { rule: 'M2', issue: 50, why: 'PR #550 is held by judge(guard-fail) until the owner resumes run:01M4RQ0050AAAA' },
    ])
  })

  test('a PR that keeps failing the same way across re-checks raises one judge wake; a changed failure raises another', () => {
    const key = keys(plan(mergeReady([guarded([CI_FAIL])]), CFG))[0] as string
    expect(key).toMatch(/^judge:guard-fail:550:head50:[0-9a-f]{8}$/)
    const first = guarded([CI_FAIL], [], 1, { startedAt: NOW - 30 * MIN, endedAt: NOW - 29 * MIN })
    const judged = judgedFail([CI_FAIL], 'wait', { startedAt: NOW - 29 * MIN, endedAt: NOW - 28 * MIN })
    // re-check after re-check fails the same way, each fresh when planned: no new wake
    for (let n = 2; n <= 4; n++) {
      const rechecks = Array.from({ length: n - 1 }, (_, i) => {
        const ago = (n - 2 - i) * 6 * MIN + MIN
        return guarded([CI_FAIL], [], i + 2, { startedAt: NOW - ago - 30_000, endedAt: NOW - ago })
      })
      const r = plan(mergeReady([first, judged, ...rechecks]), CFG)
      expect([n, keys(r)]).toEqual([n, []])
    }
    // the failure changes: one new judge, under its own key
    const changed = guarded([CI_FAIL, { name: 'checks', reason: 'lint=fail' }], [], 2, { startedAt: NOW - 30_000, endedAt: NOW - 20_000 })
    const r = plan(mergeReady([first, judged, changed]), CFG)
    expect(r.actions.filter(a => a.kind !== 'title').map(a => a.kind)).toEqual(['judge'])
    expect(keys(r)[0]).not.toBe(key)
  })

  test('the same failure is asked about again only after a slow reminder, or once the owner resumes after a hold', () => {
    const recheck = guarded([CI_FAIL], [], 2, { startedAt: NOW - 2 * MIN, endedAt: NOW - MIN })
    const waited = judgedFail([CI_FAIL], 'wait', { endedAt: NOW - 29 * MIN })
    expect(keys(plan(mergeReady([recheck, waited]), CFG))).toEqual([])
    const reminded = { ...waited, endedAt: NOW - 31 * MIN }
    expect(keys(plan(mergeReady([recheck, reminded]), CFG))).toEqual([`${waited.key}:r1`])
    const held = judgedFail([CI_FAIL], 'hold', { endedAt: NOW - 40 * MIN })
    expect(keys(plan(mergeReady([recheck, held]), CFG))).toEqual([])
    const resumed = control({ resumed: [{ subject: 'run:01M4RQ0050AAAA', at: NOW - 5 * MIN }] })
    expect(keys(plan(mergeReady([recheck, held], { control: resumed }), CFG))).toEqual([`${held.key}:r1`])
  })

  test('the guard expires after 5 minutes by default (SPEC 4.2, M1)', () => {
    expect(CFG.guardTtlMs).toBe(5 * MIN)
    expect(keys(plan(mergeReady([guarded([], [], 1, { endedAt: NOW - 6 * MIN })]), CFG))).toEqual(['guard:550:head50:2'])
  })
  test('a guard numbers past the highest key: a re-check folded into one entry is never a reused key (#550)', () => {
    // guards 1 to 4 found what guard 5 found, so the ledger keeps only guard 5 (ledger.ts)
    expect(keys(plan(mergeReady([guarded([CI_FAIL], [], 5, { endedAt: NOW - 6 * MIN })]), CFG))).toEqual(['guard:550:head50:6'])
    // and the fast-forward is that guard's
    expect(keys(plan(mergeReady([guarded([LAG], [], 5)]), CFG))).toEqual(['fast-forward:550:head50:5'])
  })
})

describe('M1, M2: fast-forward a worktree the pipeline left behind (#551)', () => {
  test('a head FAIL that is only a lagging worktree fast-forwards it, with no judge, then guards again', () => {
    const r = plan(mergeReady([guarded([LAG])]), CFG)
    expect(keys(r)).toEqual(['fast-forward:550:head50:1'])
    expect(find(r, 'fast-forward:550:head50:1')).toMatchObject({ kind: 'fast-forward', class: 'free', rule: 'M2', pr: 550, head: 'head50', branch: 'feat/issue-50-work' })
    const moved = fastForward('fast-forward:550:head50:1', 'forwarded', { startedAt: NOW - 30_000, endedAt: NOW - 20_000 })
    expect(keys(plan(mergeReady([guarded([LAG]), moved]), CFG))).toEqual(['guard:550:head50:2'])
  })

  test('a diverged or dirty worktree (the fast-forward refuses) still goes to the judge, with the refusal', () => {
    const refused = fastForward('fast-forward:550:head50:1', 'refused', { startedAt: NOW - 30_000, endedAt: NOW - 20_000 })
    const r = plan(mergeReady([guarded([LAG]), refused]), CFG)
    expect(r.actions.filter(a => a.kind !== 'title').map(a => a.kind)).toEqual(['judge'])
    const judge = r.actions.find(a => a.kind === 'judge') as Extract<Action, { wake: string }>
    expect(judge.wake).toBe('guard-fail')
    expect(judge.context).toContain('FAST-FORWARD REFUSED x')
    // a fast-forward that ran out of attempts goes to the judge too, with no notice of its own
    const spent = fastForward('fast-forward:550:head50:1', 'refused', { status: 'failed', attempts: 3, outcome: undefined })
    expect(plan(mergeReady([guarded([LAG]), spent]), CFG).actions.filter(a => a.kind !== 'title').map(a => a.kind)).toEqual(['judge'])
  })

  test('a head FAIL that is more than a lagging worktree goes to the judge as before', () => {
    for (const fail of [headFail('head50', 'head51', 'head51', 'head50'), headFail('head50', 'head50', 'head50', 'unknown'), headFail('head50', 'head50', 'head50')]) {
      const r = plan(mergeReady([guarded([fail])]), CFG)
      expect([fail.reason, r.actions.filter(a => a.kind !== 'title').map(a => a.kind)]).toEqual([fail.reason, ['judge']])
    }
  })

  test('a lag that comes back after a fast-forward went through goes to the judge, not round again', () => {
    const moved = fastForward('fast-forward:550:head50:1', 'forwarded', { startedAt: NOW - 4 * MIN, endedAt: NOW - 4 * MIN + 1000 })
    const again = guarded([LAG], [], 2, { startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN })
    const r = plan(mergeReady([guarded([LAG], [], 1, { startedAt: NOW - 6 * MIN, endedAt: NOW - 5 * MIN }), moved, again]), CFG)
    expect(r.actions.filter(a => a.kind !== 'title').map(a => a.kind)).toEqual(['judge'])
  })

  test('a fast-forward that finds nothing lagging any more makes the guard stale: guarded again, no judge', () => {
    // the slot was reused on another branch between the guard and the fast-forward
    const current = fastForward('fast-forward:550:head50:1', 'current', { rule: 'M2', startedAt: NOW - 30_000, endedAt: NOW - 20_000 })
    expect(keys(plan(mergeReady([guarded([LAG]), current]), CFG))).toEqual(['guard:550:head50:2'])
    // the lag is back on that re-guard: the judge looks, not another round
    const again = guarded([LAG], [], 2, { startedAt: NOW - 15_000, endedAt: NOW - 10_000 })
    expect(plan(mergeReady([guarded([LAG]), current, again]), CFG).actions.filter(a => a.kind !== 'title').map(a => a.kind)).toEqual(['judge'])
    // M1's CURRENT before the first guard says nothing about it: a lag that guard saw is forwarded
    const before = fastForward('fast-forward:550:head50', 'current', { rule: 'M1', startedAt: NOW - 3 * MIN, endedAt: NOW - 3 * MIN + 500 })
    expect(keys(plan(mergeReady([before, guarded([LAG])]), CFG))).toEqual(['fast-forward:550:head50:1'])
  })

  test('before the first guard of a head, a clean slot on the branch is fast-forwarded first', () => {
    const slot = { path: '/w/slot-3', branch: 'feat/issue-50-work', state: 'leased', dirty: false, busy: false }
    const pool = (s: typeof slot) => ({ pool: { free: 10, total: 16, slots: [s] } })
    expect(keys(plan(mergeReady([], pool(slot)), CFG))).toEqual(['fast-forward:550:head50', 'guard:550:head50:1'])
    // a dirty slot is left to the guard (and the judge), and no slot means nothing to forward
    expect(keys(plan(mergeReady([], pool({ ...slot, dirty: true })), CFG))).toEqual(['guard:550:head50:1'])
    expect(keys(plan(mergeReady(), CFG))).toEqual(['guard:550:head50:1'])
    // the fast-forward that ran just before the first guard does not make that guard stale
    const ff = fastForward('fast-forward:550:head50', 'forwarded', { startedAt: NOW - 3 * MIN, endedAt: NOW - 3 * MIN + 500 })
    const g = guarded([], [], 1, { startedAt: NOW - 3 * MIN + 600, endedAt: NOW - 2 * MIN })
    expect(keys(plan(mergeReady([ff, g], pool(slot)), CFG))).toEqual(['adjudicate-merge:550:head50'])
  })

  test('no fast-forward while an agent works the issue\'s branch', () => {
    const working = entry('fixer:gate:x', 'spawn', { agent: 'fixer', issue: 50, pr: 550, status: 'running', endedAt: null, agentId: 'a-fix' })
    const r = plan(mergeReady([guarded([LAG]), working]), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'M2', issue: 50, why: 'an agent already works the branch of #50 (fast-forward)' })
  })
})

describe('an issue closed on GitHub is finished (#556)', () => {
  // testbed run 3's first pass: run 2's issues were closed at the reset, but their failed runs are
  // still listed, the factory still shows them live (stuck), and the ledger rebuilt from the event
  // log holds an adjudication of 40's run that asked for a fixer
  const R40 = '01M4RQ0040AAAA'
  const R41 = '01M4RQ0041AAAA'
  const adjudicated40 = entry(`adjudicate:${R40}:review:head40`, 'spawn', {
    agent: 'adjudicator',
    class: 'drive',
    issue: 40,
    run: R40,
    head: 'head40',
    outcome: review({ type: 'fixer', instructions: 'add the missing test' }),
  })
  const leftovers = (open: boolean | null) =>
    withLedger(
      state({
        queue: [60],
        issues: [
          mine(40, 'parked', { open, run: R40, pr: 540, stuck: 'S3' }),
          mine(41, 'in pipeline', { open, run: R41, pr: 541, stuck: 'S3' }),
          issue(60),
        ],
        runs: [run(40, 'failed'), run(41, 'failed')],
      }),
      [adjudicated40],
    )
  const CAP2 = config({ maxInFlightIssues: 2 })

  test('a failed run of a closed issue gets no adjudicator or fixer, and the issue takes no in-flight slot (testbed run 3)', () => {
    const r = plan(leftovers(false), CAP2)
    expect(keys(r)).toEqual([`claim:60:${NOW - 30 * MIN}`])
    expect(r.atCap).toBe(false)
    // not live: no D count, no stuck word
    expect(r.title).toBe('🔄 dev-system (Q:1 - D:0 - M:0) · observe')
    expect(r.skipped).toContainEqual({ rule: 'P', issue: 40, why: 'closed on GitHub: its runs are not driven' })
    // a state not read yet is never taken for closed: the issue is driven as before
    const unknown = plan(leftovers(null), CAP2)
    expect(keys(unknown)).toEqual([`fixer:gate:${R40}:review:head40`, `adjudicate:${R41}:review:head41`, 'tell:at-cap:0'])
    expect(unknown.title).toBe('🔄 dev-system (Q:1 - D:2 - M:0) · observe · stuck 2 · at cap')
  })

  test('while GitHub fails, an issue whose state is not read gets no agent: a backoff after a reload, or a pass a rate limit cut short', () => {
    const blind = failing(leftovers(null), 'github', NOW - 10 * MIN)
    const r = plan(blind, CAP2)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'P3', issue: 40, why: 'GitHub state not read (spawn)' })
    expect(r.skipped).toContainEqual({ rule: 'P2', issue: 41, why: 'GitHub state not read (spawn)' })
    // a state read before the failure still counts: an open issue is driven
    expect(keys(plan(failing(leftovers(true), 'github', NOW - 10 * MIN), CAP2))).toEqual([`fixer:gate:${R40}:review:head40`, `adjudicate:${R41}:review:head41`])
    // and so is a delegation
    const failedDelegate = entry('delegate:61:x', 'delegate', { class: 'develop', issue: 61, status: 'failed', attempts: 1, endedAt: NOW - 20 * MIN })
    const s = (open: boolean | null) => failing(withLedger(state({ issues: [mine(61, 'implementing', { open })] }), [failedDelegate]), 'github', NOW - 10 * MIN)
    expect(keys(plan(s(true), CFG))).toEqual(['delegate:61:x'])
    expect(plan(s(null), CFG).skipped).toContainEqual({ rule: 'D4', issue: 61, why: 'GitHub state not read (delegate)' })
  })

  test('a closed designing issue leaves its worktree free for a claim (SPEC D1)', () => {
    // 3 free with a reserve of 2: an issue in design would take the one left
    const s = (open: boolean) => state({ queue: [60], issues: [mine(40, 'designing', { open, stageSince: NOW - 10 * MIN }), issue(60)], pool: { free: 3, total: 16, slots: [] } })
    expect(plan(s(true), CFG).skipped).toContainEqual({ rule: 'D1', issue: 60, why: 'no free worktree' })
    expect(keys(plan(s(false), CFG))).toEqual([`claim:60:${NOW - 30 * MIN}`])
  })

  test('a closed issue gets no designer, delegation, handoff judge or lease renewal', () => {
    const life = NOW - 20 * MIN
    const failedDelegate = entry('delegate:61:x', 'delegate', { class: 'develop', issue: 61, status: 'failed', attempts: 1, endedAt: NOW - 20 * MIN })
    const notGated = entry('delegate:62:y', 'delegate', { class: 'develop', issue: 62, outcome: { kind: 'handoff', notGated: true, run: 'R', head: 'H', newBranch: null } })
    // the first pass after a load renews the leases of the live issues this device holds
    const s = (open: boolean) =>
      withLedger(
        state({
          loadedAt: NOW - MIN,
          issues: [mine(60, 'designing', { open, stageSince: life }), mine(61, 'implementing', { open }), mine(62, 'in pipeline', { open })],
        }),
        [failedDelegate, notGated],
      )
    expect(keys(plan(s(true), CFG))).toEqual([`heartbeat:${NOW - 5 * MIN}`, `design:60:${life}`, 'delegate:61:x', 'judge:handoff:delegate:62:y'])
    const r = plan(s(false), CFG)
    expect(keys(r)).toEqual([])
    expect(r.skipped).toContainEqual({ rule: 'D2', issue: 60, why: 'closed on GitHub' })
    expect(r.skipped).toContainEqual({ rule: 'D4', issue: 61, why: 'closed on GitHub' })
  })

  test("a clean pool slot on a closed issue's branch is returned (SPEC H3)", () => {
    const slot = { path: '/t/1', branch: 'feat/issue-40-work', state: 'leased', dirty: false, busy: false }
    const s = (open: boolean) => state({ issues: [mine(40, 'parked', { open })], pool: { free: 8, total: 16, slots: [slot] } })
    expect(keys(plan(s(true), CFG))).toEqual([])
    const r = plan(s(false), CFG)
    expect(keys(r)).toEqual(['release:/t/1:feat/issue-40-work'])
    expect(find(r, 'release:/t/1:feat/issue-40-work')).toMatchObject({ rule: 'H3', reason: 'closed on GitHub, slot clean' })
    // an agent that answered but still works there keeps it until rule A2 has stopped it
    const answered = entry('fixer:gate:x', 'spawn', { agent: 'fixer', class: 'drive', issue: 40, agentId: 'a40', endedAt: NOW - 5 * MIN })
    const working = { ...withLedger(s(false), [answered]), agents: [{ id: 'a40', type: 'callum-flow:fixer', status: 'running' as const }] }
    expect(keys(plan(working, CFG))).toEqual(['stop:a40', 'tell:stopped:a40'])
    const stopped = { ...working, agents: [{ id: 'a40', type: 'callum-flow:fixer', status: 'killed' as const }] }
    expect(keys(plan(stopped, CFG))).toEqual(['release:/t/1:feat/issue-40-work'])
  })

  test('an agent of the loop working an issue that closes is stopped, and the decision log says why (SPEC A2)', () => {
    const fixer = entry(`fixer:gate:${R40}:review:head40`, 'spawn', {
      agent: 'fixer',
      class: 'drive',
      issue: 40,
      run: R40,
      status: 'running',
      agentId: 'a40',
      startedAt: NOW - 5 * MIN,
      endedAt: null,
    })
    const r = plan(withLedger(leftovers(false), [fixer]), CAP2)
    expect(find(r, 'stop:a40')).toMatchObject({ kind: 'stop-agent', class: 'free', rule: 'A2', reason: 'issue closed', issue: 40, entry: fixer.key })
    expect(find(r, 'tell:stopped:a40')).toMatchObject({ fields: { issue: '40', why: 'closed' } })
    // open, it works on
    expect(keys(plan(withLedger(leftovers(true), [fixer]), CAP2)).filter(k => k.startsWith('stop:'))).toEqual([])
    // an issue that also ended says how: merged, not just closed
    const merged = plan(withLedger(state({ issues: [mine(40, 'merged', { open: false })] }), [fixer]), CFG)
    expect(find(merged, 'tell:stopped:a40')).toMatchObject({ fields: { issue: '40', why: 'merged' } })
  })

  test("the loop's own merge closed the issue: its rollout follow-ups still run, and so does a superseded PR's close (SPEC M7, M8)", () => {
    const merged = (rollout: 'merge' | 'run-it' | 'keep-open', closeIssue: number | null = null) =>
      entry('merge:550:head50', 'merge', { issue: 50, pr: 550, head: 'head50', outcome: { kind: 'merge', result: 'merged', rollout, closeIssue, line: 'merged' } })
    // the factory has not caught up: still ready to merge, its run still merge-ready, but closed
    const after = (e: LedgerEntry) =>
      mergeReady([guarded(), reviewed({ type: 'merge' }, 'head50', { bump: 'minor', bumpReason: 'new mode' }), e], {
        issues: [mine(50, 'ready to merge', { open: false, pr: 550 })],
        milestone: { open: 2, closed: 1, expected: 'patch' },
      })
    expect(keys(plan(after(merged('run-it')), CFG))).toEqual(['milestone-later:50', 'task:run-it:50', 'expect:minor:550'])
    expect(keys(plan(after(merged('keep-open')), CFG))).toEqual(['milestone-later:50', 'expect:minor:550'])
    expect(keys(plan(after(merged('merge', 50)), CFG))).toEqual(['close:50', 'expect:minor:550'])
    // a hand merge closes its issue too: its rollout is still read
    expect(keys(plan(state({ issues: [mine(70, 'merged', { open: false, stageSince: NOW - 30 * MIN, pr: 570 })] }), CFG))).toEqual(['rollout:70'])
    // the PR of a run superseded before the issue closed is still closed (M8)
    const B = 'feat/issue-32-slug'
    const moved = entry('fixer:conflict:44:h44', 'spawn', {
      agent: 'fixer',
      class: 'drive',
      issue: 32,
      run: '01M4RQ0032AAAA',
      pr: 44,
      head: 'h44',
      outcome: { kind: 'handoff', notGated: false, run: '01M4RQ0032BBBB', head: 'n44', newBranch: `${B}-v2` },
    })
    const superseded = withLedger(
      state({ issues: [mine(32, 'in pipeline', { open: false, pr: 50 })], runs: [run(32, 'running', { branch: `${B}-v2`, run: '01M4RQ0032BBBB', pr: 50 })] }),
      [moved],
    )
    expect(keys(plan(superseded, CFG))).toEqual(['pr-close:44'])
  })
})
