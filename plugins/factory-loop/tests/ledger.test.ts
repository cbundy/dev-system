// The ledger, transition by transition (SPEC 7): attempts and retries under one key, what a
// reload and the agent list prove, the 7-day prune and the size budget, the store or the event
// log, `/factory retry` against plan's own exhaustion rule (D-38), the loop's own events (D-09)
// and the round trip through the store. Where a transition exists for plan's sake, the test
// asks plan what it does next.
import { describe, expect, test } from 'claude-code/testing'

import { entryFromLoop } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import type { Exec } from '../hooks/exec'
import {
  KEEP_MS,
  LEDGER_MAX_BYTES,
  attemptsKindOf,
  changedEntries,
  choose,
  exhausted,
  finish,
  fit,
  fromStored,
  load,
  loopEvent,
  maxAttemptsOf,
  onLoad,
  prune,
  reconcileAgents,
  retryIssue,
  save,
  start,
  storeKey,
  toStored,
} from '../hooks/ledger'
import type { StoreIo } from '../hooks/ledger'
import { plan } from '../hooks/plan'
import type { Action, LedgerEntry, Outcome, State } from '../hooks/types'
import { MIN, NOW, brief, config, entry, issue, keys, mine, run, state, withLedger } from './fixtures'

const CFG = config()
const REPO = 'cbundy/dev-system'
const DAY = 24 * 60 * MIN
const LIFE = NOW - 20 * MIN

// --- actions as plan emits them ---------------------------------------------------------------

const claim = (n: number, key = `claim:${n}:new`): Action => ({ kind: 'claim', key, class: 'start', rule: 'D1', reason: 'ready', issue: n })
const designer = (n: number, key = `design:${n}:${LIFE}`): Action => ({
  kind: 'spawn',
  agent: 'designer',
  model: null,
  notes: [],
  key,
  class: 'develop',
  rule: 'D2',
  reason: 'designing, no brief',
  issue: n,
})
const adjudicator: Action = {
  kind: 'spawn',
  agent: 'adjudicator',
  purpose: 'gate',
  run: 'R45',
  branch: 'feat/issue-45-x',
  step: 'review',
  head: 'h45',
  pr: 545,
  brief: brief(45),
  model: null,
  warns: [],
  handoffHead: null,
  verdicts: [],
  guard: [],
  key: 'adjudicate:R45:review:h45',
  class: 'drive',
  rule: 'P2',
  reason: 'parked',
  issue: 45,
}
const delegate: Action = { kind: 'delegate', brief: brief(63), key: `delegate:63:${brief(63)}`, class: 'develop', rule: 'D4', reason: 'brief posted', issue: 63 }
const guard: Action = { kind: 'guard', pr: 550, run: 'R50', head: 'head50', key: 'guard:550:head50:1', class: 'free', rule: 'M1', reason: 'no guard yet', issue: 50 }
const merge: Action = {
  kind: 'merge',
  pr: 550,
  run: 'R50',
  head: 'head50',
  bump: null,
  bumpReason: null,
  key: 'merge:550:head50',
  class: 'free',
  rule: 'M5',
  reason: 'reviewed: merge',
  issue: 50,
}
const judge: Action = {
  kind: 'judge',
  wake: 'sequence',
  fields: { pr: '550' },
  context: [],
  key: 'judge:sequence:550:head50',
  class: 'drive',
  rule: 'M5',
  reason: 'judge sequence',
  issue: 50,
}
const stop = (agentId: string, rule: 'A1' | 'A2'): Action => ({
  kind: 'stop-agent',
  agentId,
  entry: 'design:70:x',
  key: `stop:${agentId}`,
  class: 'free',
  rule,
  reason: rule === 'A1' ? 'timed out' : 'issue closed',
  issue: 70,
})

const cliFail = (exit: number): Outcome => ({ kind: 'cli', exit, detail: 'boom' })
const failed = (exit = 1): Exec => ({ status: 'failed', outcome: cliFail(exit), summary: `exit ${exit}` })

// started: the ledger with these actions started at `at`
function started(actions: Action[], at = NOW, ledger: LedgerEntry[] = []): LedgerEntry[] {
  return actions.reduce((l, a) => start(l, a, at).ledger, ledger)
}

function only(ledger: readonly LedgerEntry[], key: string): LedgerEntry {
  const found = ledger.filter(e => e.key === key)
  expect(found).toHaveLength(1)
  return found[0] as LedgerEntry
}

describe('start and finish (SPEC 5.1, 6.1, 7.1)', () => {
  test('a new key starts at attempt 1, running, with its subject from the action', () => {
    const before: LedgerEntry[] = []
    const s = start(before, claim(7), NOW)
    expect(s.prev).toBeNull()
    expect(s.entry).toEqual({
      key: 'claim:7:new',
      kind: 'claim',
      class: 'start',
      rule: 'D1',
      issue: 7,
      run: null,
      pr: null,
      head: null,
      status: 'running',
      attempts: 1,
      startedAt: NOW,
      endedAt: null,
    })
    expect(s.ledger).toEqual([s.entry])
    // pure: the ledger it was given is untouched
    expect(before).toEqual([])
  })

  test('run, PR, head, agent and wake come from the actions that carry them', () => {
    expect(start([], adjudicator, NOW).entry).toMatchObject({ run: 'R45', pr: 545, head: 'h45', agent: 'adjudicator', class: 'drive', issue: 45 })
    // a delegate spawns the implementer: its entry is that agent's, as plan reads it
    expect(start([], delegate, NOW).entry).toMatchObject({ agent: 'implementer', class: 'develop', run: null, pr: null })
    expect(start([], guard, NOW).entry).toMatchObject({ run: 'R50', pr: 550, head: 'head50', class: 'free' })
    const wake = start([], judge, NOW).entry
    expect(wake).toMatchObject({ wake: 'sequence', pr: null, head: null, class: 'drive' })
    expect(wake.agent).toBeUndefined()
    // a wake records the session submitting it, and the store keeps it (SPEC 7.5); nothing else does
    const sessioned = start([], judge, NOW, 'session-1').entry
    expect(sessioned.session).toBe('session-1')
    expect(fromStored(JSON.parse(JSON.stringify(toStored([sessioned], NOW))))?.[0]?.session).toBe('session-1')
    expect(start([], claim(7), NOW, 'session-1').entry.session).toBeUndefined()
  })

  test('a retry keeps the key, counts the attempt and clears the last outcome and agent', () => {
    let ledger = started([designer(60)], NOW - 30 * MIN)
    ledger = finish(ledger, `design:60:${LIFE}`, { status: 'running', agentId: 'a1', summary: 'spawned' }, NOW - 30 * MIN)
    ledger = finish(ledger, `design:60:${LIFE}`, { status: 'failed', outcome: { kind: 'designer', unparsed: true }, summary: 'aborted' }, NOW - 20 * MIN)
    const retry = start(ledger, designer(60), NOW - 10 * MIN)
    expect(retry.prev).toMatchObject({ status: 'failed', attempts: 1, agentId: 'a1' })
    expect(retry.entry).toMatchObject({ status: 'running', attempts: 2, startedAt: NOW - 10 * MIN, endedAt: null })
    expect(retry.entry.outcome).toBeUndefined()
    expect(retry.entry.agentId).toBeUndefined()
    expect(retry.entry.summary).toBeUndefined()
    expect(only(retry.ledger, `design:60:${LIFE}`)).toBe(retry.entry)
    // timed-out and lost are retried the same way
    for (const status of ['timed-out', 'lost'] as const) {
      const ended = finish(retry.ledger, `design:60:${LIFE}`, { status }, NOW - 5 * MIN)
      expect(start(ended, designer(60), NOW).entry.attempts).toBe(3)
    }
  })

  test('a done key started again counts from 1: success resets the count', () => {
    const title: Action = { kind: 'title', key: 'title', class: 'free', rule: 'O1', reason: 'status changed', issue: null, text: 'x' }
    let ledger = started([title], NOW - 2 * MIN)
    ledger = finish(ledger, 'title', { status: 'failed', summary: 'rename refused' }, NOW - 2 * MIN)
    ledger = start(ledger, title, NOW - MIN).ledger
    expect(only(ledger, 'title').attempts).toBe(2)
    ledger = finish(ledger, 'title', { status: 'done', summary: 'set' }, NOW - MIN)
    expect(start(ledger, title, NOW).entry.attempts).toBe(1)
  })

  test('finish records the status, outcome, summary and end time', () => {
    let ledger = started([claim(7), claim(8)], NOW - MIN)
    ledger = finish(ledger, 'claim:7:new', { status: 'done', outcome: { kind: 'claim', result: 'lost' }, summary: 'lost to a live claim' }, NOW)
    ledger = finish(ledger, 'claim:8:new', failed(1), NOW)
    expect(only(ledger, 'claim:7:new')).toMatchObject({ status: 'done', endedAt: NOW, outcome: { kind: 'claim', result: 'lost' }, summary: 'lost to a live claim', attempts: 1 })
    expect(only(ledger, 'claim:8:new')).toMatchObject({ status: 'failed', endedAt: NOW, outcome: cliFail(1), summary: 'exit 1' })
    // a long summary is cut to a few words' worth
    ledger = finish(ledger, 'claim:8:new', { status: 'failed', summary: 'y'.repeat(5000) }, NOW)
    expect(only(ledger, 'claim:8:new').summary).toHaveLength(300)
  })

  test("an agent runs on past the pass with its id, and its turn.complete ends it", () => {
    let ledger = started([adjudicator], NOW - 10 * MIN)
    ledger = finish(ledger, adjudicator.key, { status: 'running', agentId: 'a45', summary: 'spawned' }, NOW - 10 * MIN)
    expect(only(ledger, adjudicator.key)).toMatchObject({ status: 'running', agentId: 'a45', endedAt: null })
    const verdict: Outcome = { kind: 'adjudicator', verdicts: ['CORRECT: a gap'], action: { type: 'approve', reason: null }, report: null }
    ledger = finish(ledger, adjudicator.key, { status: 'done', outcome: verdict, summary: 'approve' }, NOW)
    expect(only(ledger, adjudicator.key)).toMatchObject({ status: 'done', agentId: 'a45', endedAt: NOW, outcome: verdict })
  })

  test('a wake runs with its id, keeps its turn and reminder, and ends with its answer', () => {
    let ledger = started([judge], NOW - 10 * MIN)
    ledger = finish(ledger, judge.key, { status: 'running', wakeId: 'w41', summary: 'submitted' }, NOW - 10 * MIN)
    ledger = finish(ledger, judge.key, { status: 'running', turnId: 't9', reminded: true }, NOW - 5 * MIN)
    expect(only(ledger, judge.key)).toMatchObject({ status: 'running', wakeId: 'w41', turnId: 't9', reminded: true, endedAt: null, summary: 'submitted' })
    const answer: Outcome = { kind: 'wake', decision: 'merge', reason: null, instructions: null, bump: null, bumpReason: null, fields: {} }
    ledger = finish(ledger, judge.key, { status: 'done', outcome: answer }, NOW)
    expect(only(ledger, judge.key)).toMatchObject({ status: 'done', wakeId: 'w41', endedAt: NOW, outcome: answer })
  })

  test('a detached respond keeps its launch record when it settles', () => {
    const respond: Action = {
      kind: 'respond',
      run: 'R45',
      branch: 'feat/issue-45-x',
      step: 'review',
      head: 'h45',
      action: 'approve',
      findings: null,
      instructions: null,
      addFinding: null,
      approveReason: null,
      logReview: false,
      key: 'respond:R45:review:h45:approve',
      class: 'drive',
      rule: 'P3',
      reason: 'adjudicator: approve',
      issue: 45,
    }
    const launched: Outcome = { kind: 'respond', slot: '/w/3', log: '/loop/respond/R45-1.log' }
    let ledger = started([respond], NOW - 5 * MIN)
    ledger = finish(ledger, respond.key, { status: 'running', outcome: launched, summary: 'launched' }, NOW - 5 * MIN)
    expect(only(ledger, respond.key)).toMatchObject({ status: 'running', endedAt: null, outcome: launched, run: 'R45', head: 'h45' })
    ledger = finish(ledger, respond.key, { status: 'done', summary: 'the gate moved' }, NOW)
    expect(only(ledger, respond.key)).toMatchObject({ status: 'done', endedAt: NOW, outcome: launched })
  })

  test('a usage error uses up the attempts, so plan tells the owner instead of retrying (SPEC 10.1)', () => {
    const key = `claim:1:${NOW - 30 * MIN}`
    const s = state({ queue: [1], issues: [issue(1)] })
    const base = started([claim(1, key)], NOW - 10 * MIN)
    const usage: Exec = { status: 'failed', outcome: cliFail(2), summary: 'usage error', noRetry: true }
    const once = finish(base, key, failed(1), NOW - 10 * MIN, { config: CFG })
    expect(only(once, key).attempts).toBe(1)
    expect(keys(plan(withLedger(s, once), CFG))).toEqual([key])
    const bug = finish(base, key, usage, NOW - 10 * MIN, { config: CFG })
    expect(only(bug, key).attempts).toBe(3)
    expect(keys(plan(withLedger(s, bug), CFG))).toEqual([`tell:agent-failed:${key}`])
    // the repo's own maximum, when it raised one
    const raised = config({ maxAttempts: { ...CFG.maxAttempts, claim: 5 } })
    expect(only(finish(base, key, usage, NOW, { config: raised }), key).attempts).toBe(5)
    // without the settings, the defaults
    expect(only(finish(base, key, usage, NOW), key).attempts).toBe(3)
  })

  test('a skipped attempt is not counted: a new entry is dropped, a retry put back as it stood', () => {
    const skipped: Exec = { status: 'skipped', summary: 'usage now stop-new' }
    const fresh = start([], claim(7), NOW)
    expect(finish(fresh.ledger, 'claim:7:new', skipped, NOW, { prev: fresh.prev })).toEqual([])
    expect(finish(fresh.ledger, 'claim:7:new', skipped, NOW)).toEqual([])

    const once = finish(started([claim(7)], NOW - 10 * MIN), 'claim:7:new', failed(1), NOW - 9 * MIN)
    const retry = start(once, claim(7), NOW)
    expect(retry.entry.attempts).toBe(2)
    const back = finish(retry.ledger, 'claim:7:new', skipped, NOW, { prev: retry.prev })
    expect(back).toEqual(once)
    // without prev the count is still put back, and the key waits a backoff
    expect(only(finish(retry.ledger, 'claim:7:new', skipped, NOW), 'claim:7:new')).toMatchObject({
      status: 'failed',
      attempts: 1,
      endedAt: NOW,
      summary: 'skipped: usage now stop-new',
    })
  })

  test('an extra entry is recorded done beside its action: a guard FAIL that merge printed (SPEC 5.5)', () => {
    const fails = { kind: 'guard' as const, fails: [{ name: 'mergeable', reason: 'behind main, run update-behind first' }], warns: [] }
    const result: Exec = {
      status: 'done',
      outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line: 'GUARD mergeable FAIL behind main' },
      summary: 'guard FAIL',
      extra: [{ key: 'guard:550:head50:2', kind: 'guard', issue: 50, run: 'R50', pr: 550, head: 'head50', outcome: fails }],
    }
    const ledger = finish(started([merge], NOW - 3 * MIN), merge.key, result, NOW)
    expect(only(ledger, merge.key)).toMatchObject({ status: 'done', outcome: { kind: 'merge', result: 'refused' } })
    expect(only(ledger, 'guard:550:head50:2')).toEqual({
      key: 'guard:550:head50:2',
      kind: 'guard',
      class: 'free',
      rule: 'M5',
      issue: 50,
      run: 'R50',
      pr: 550,
      head: 'head50',
      status: 'done',
      attempts: 1,
      startedAt: NOW - 3 * MIN,
      endedAt: NOW,
      outcome: fails,
    })
    // plan reads it as this head's latest guard: behind, so update-behind next (rule M2)
    const s = state({ issues: [mine(50, 'ready to merge', { delegatedBrief: brief(50), pr: 550 })], runs: [run(50, 'merge-ready', { run: 'R50' })] })
    const first = entry('guard:550:head50:1', 'guard', { issue: 50, pr: 550, head: 'head50', outcome: { kind: 'guard', fails: [], warns: [] } })
    expect(keys(plan(withLedger(s, [first, ...ledger]), CFG))).toEqual(['update-behind:550:head50'])
  })

  test('a stop of rule A1 marks the agent timed-out, even when TaskStop failed (SPEC A1, 13)', () => {
    const agent = (id: string) => entry(`design:70:${id}`, 'spawn', { agent: 'designer', class: 'develop', issue: 70, status: 'running', endedAt: null, agentId: id })
    const base = [agent('a70'), agent('a71')]
    const stopped = finish(started([stop('a70', 'A1')], NOW, base), 'stop:a70', { status: 'done', summary: 'stopped' }, NOW)
    expect(only(stopped, 'design:70:a70')).toMatchObject({ status: 'timed-out', endedAt: NOW, summary: 'timed out: stopped' })
    expect(only(stopped, 'design:70:a71').status).toBe('running')
    const unsupported = finish(started([stop('a70', 'A1')], NOW, base), 'stop:a70', { status: 'failed', summary: 'TaskStop unavailable' }, NOW)
    expect(only(unsupported, 'design:70:a70')).toMatchObject({ status: 'timed-out', summary: 'timed out: the stop failed, the agent may still run' })
    // A2 (closed, claimed elsewhere, dropped, split): the agent's own end or the agent list says how it ended
    const a2 = finish(started([stop('a70', 'A2')], NOW, base), 'stop:a70', { status: 'done', summary: 'stopped' }, NOW)
    expect(only(a2, 'design:70:a70').status).toBe('running')
  })

  test('a key the ledger no longer holds is left alone', () => {
    const ledger = started([claim(7)], NOW)
    expect(finish(ledger, 'claim:9:new', { status: 'done', summary: 'late' }, NOW)).toEqual(ledger)
  })
})

describe('a reload and the agent list (SPEC 3.3, 7.5, 10.4)', () => {
  const cli = entry('guard:550:head50:1', 'guard', { status: 'running', endedAt: null })
  const spawning = entry(`design:60:${LIFE}`, 'spawn', { agent: 'designer', status: 'running', endedAt: null })
  const agentEntry = (id: string) => entry(`agent:${id}`, 'spawn', { agent: 'fixer', class: 'drive', status: 'running', endedAt: null, agentId: id })
  const wake = entry('judge:sequence:550:head50', 'judge', { wake: 'sequence', status: 'running', endedAt: null, wakeId: 'w1' })
  const done = entry('heartbeat:0', 'heartbeat')

  test('on load every running CLI entry is lost; agents, wakes and ended entries stay', () => {
    const before = [cli, spawning, agentEntry('a1'), wake, done]
    const after = onLoad(before, NOW)
    expect(only(after, cli.key)).toMatchObject({ status: 'lost', endedAt: NOW, summary: 'lost: the loop reloaded mid-action' })
    // a spawn that had no agent id yet died with the session too
    expect(only(after, spawning.key).status).toBe('lost')
    expect(changedEntries(before, after).map(e => e.key)).toEqual([cli.key, spawning.key])
    // an agent waits for the agent list, a wake for its answer or timeout
    expect(only(after, 'agent:a1')).toBe(before[2])
    expect(only(after, wake.key)).toBe(wake)
  })

  test('an agent the list lacks, or lists as completed, is lost; failed or killed is failed', () => {
    const ids = ['gone', 'done', 'failed', 'killed', 'running', 'waiting', 'idle', 'pending']
    const before = [...ids.map(agentEntry), wake, done]
    const after = reconcileAgents(
      before,
      [
        { id: 'done', status: 'completed' },
        { id: 'failed', status: 'failed' },
        { id: 'killed', status: 'killed' },
        { id: 'running', status: 'running' },
        { id: 'waiting', status: 'waiting' },
        { id: 'idle', status: 'idle' },
        { id: 'pending', status: 'pending' },
      ],
      NOW,
    )
    const status = (id: string) => only(after, `agent:${id}`).status
    expect(ids.map(status)).toEqual(['lost', 'lost', 'failed', 'failed', 'running', 'running', 'running', 'running'])
    expect(only(after, 'agent:gone')).toMatchObject({ endedAt: NOW, summary: 'lost: gone from the agent list' })
    expect(only(after, 'agent:done').summary).toBe('lost: completed with no answer')
    expect(only(after, 'agent:killed').summary).toBe('agent killed')
    expect(changedEntries(before, after).map(e => e.key)).toEqual(['agent:gone', 'agent:done', 'agent:failed', 'agent:killed'])
    // wakes are never agents, and an ended entry is history
    expect(only(after, wake.key)).toBe(wake)
    expect(only(after, done.key)).toBe(done)
  })

  test('an implementer lost across a restart is delegated again by its rule (SPEC 7.5, D4b)', () => {
    const s = state({ issues: [mine(63, 'implementing')] })
    let ledger = started([delegate], NOW - 30 * MIN)
    ledger = finish(ledger, delegate.key, { status: 'running', agentId: 'a63', summary: 'spawned' }, NOW - 30 * MIN)
    expect(keys(plan(withLedger(s, ledger), CFG))).toEqual([])
    ledger = reconcileAgents(onLoad(ledger, NOW - MIN), [], NOW - MIN)
    expect(only(ledger, delegate.key).status).toBe('lost')
    expect(keys(plan(withLedger(s, ledger), CFG))).toEqual([delegate.key])
    expect(start(ledger, delegate, NOW).entry.attempts).toBe(2)
  })
})

describe('the prune and the size budget (SPEC 7.1)', () => {
  test('an entry is kept 7 days after it ends, a running one forever', () => {
    const ended = (key: string, endedAt: number) => entry(key, 'guard', { startedAt: endedAt - MIN, endedAt })
    const ledger = [
      ended('edge', NOW - KEEP_MS),
      ended('past', NOW - KEEP_MS - 1),
      ended('fresh', NOW - DAY),
      entry('running', 'spawn', { agent: 'fixer', status: 'running', startedAt: NOW - 30 * DAY, endedAt: null }),
      // no end time: it ages from its start
      entry('unended', 'claim', { status: 'failed', startedAt: NOW - 8 * DAY, endedAt: null }),
    ]
    expect(prune(ledger, NOW).map(e => e.key)).toEqual(['edge', 'fresh', 'running'])
  })

  test('over budget, the entries that ended first go first, and a running one never', () => {
    const ledger = Array.from({ length: 10 }, (_, i) =>
      entry(`e${i}`, 'guard', { status: i === 0 ? 'running' : 'done', startedAt: NOW - (20 - i) * MIN, endedAt: i === 0 ? null : NOW - (10 - i) * MIN }),
    )
    expect(fit(ledger)).toEqual(ledger)
    const one = JSON.stringify(ledger[5]).length + 1
    const kept = fit(ledger, 64 + 6 * one)
    expect(kept.map(e => e.key)).toEqual(['e0', 'e5', 'e6', 'e7', 'e8', 'e9'])
    expect(fit(ledger, 0).map(e => e.key)).toEqual(['e0'])
  })

  test('a busy week stays far below the store limit, and nothing is dropped to fit', () => {
    const week = busyWeek(20)
    const stored = toStored(week, NOW)
    // more than twice the ~1 600 events dev-system's orchestrator logged in its busiest week
    expect(week.length).toBeGreaterThan(3500)
    expect(stored.entries).toHaveLength(week.length)
    // half the store at most, which holds 4 MiB for every key
    expect(JSON.stringify(stored).length).toBeLessThan(2 * 1024 * 1024)
    // and the week after, it is gone again
    expect(toStored(week, NOW + 8 * DAY).entries).toEqual([])
  })

  test('a runaway ledger is kept within its budget: the oldest ended entries go, running ones stay', () => {
    const running = Array.from({ length: 20 }, (_, i) =>
      entry(`agent:${i}`, 'spawn', { agent: 'fixer', class: 'drive', status: 'running', startedAt: NOW - 6 * DAY, endedAt: null, agentId: `a${i}` }),
    )
    const huge = [...running, ...busyWeek(48)]
    expect(JSON.stringify(huge).length).toBeGreaterThan(LEDGER_MAX_BYTES)
    const stored = toStored(huge, NOW)
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(LEDGER_MAX_BYTES)
    expect(stored.entries.slice(0, 20)).toEqual(running)
    const end = (e: LedgerEntry) => e.endedAt ?? e.startedAt
    const kept = new Set(stored.entries)
    const dropped = huge.filter(e => !kept.has(e))
    expect(dropped.length).toBeGreaterThan(0)
    const newestDropped = Math.max(...dropped.map(end))
    expect(stored.entries.filter(e => e.status !== 'running').every(e => end(e) >= newestDropped)).toBe(true)
  })
})

describe('the store or the event log (SPEC 7.5)', () => {
  const stored = [entry('claim:7:new', 'claim', { class: 'start', issue: 7 })]
  const derived = [entry('claim:7:derived:1', 'claim', { class: 'start', issue: 7 }), entry('heartbeat:derived', 'heartbeat')]

  test('the store wins whenever it holds a ledger', () => {
    expect(choose(stored, derived)).toEqual({ ledger: stored, source: 'store' })
    expect(choose(stored, null)).toEqual({ ledger: stored, source: 'store' })
  })

  test('a missing or empty store falls back to the ledger rebuilt from the event log', () => {
    expect(choose(null, derived)).toEqual({ ledger: derived, source: 'events' })
    expect(choose(undefined, derived)).toEqual({ ledger: derived, source: 'events' })
    expect(choose([], derived)).toEqual({ ledger: derived, source: 'events' })
  })

  test('with neither, the ledger starts empty and says so', () => {
    expect(choose(null, null)).toEqual({ ledger: [], source: 'none' })
    expect(choose([], [])).toEqual({ ledger: [], source: 'none' })
  })
})

describe('/factory retry (D-38)', () => {
  const ended = (key: string, kind: LedgerEntry['kind'], status: LedgerEntry['status'], attempts: number, over: Partial<LedgerEntry> = {}) =>
    entry(key, kind, { status, attempts, ...over })

  test("exhausted is plan's rule: failed, timed-out or lost at the kind's or agent's maximum", () => {
    const cases: [LedgerEntry, boolean][] = [
      [ended('d', 'spawn', 'failed', 2, { agent: 'designer' }), true],
      [ended('d', 'spawn', 'failed', 1, { agent: 'designer' }), false],
      [ended('d', 'spawn', 'lost', 2, { agent: 'adjudicator' }), true],
      [ended('i', 'delegate', 'timed-out', 2), true],
      [ended('c', 'claim', 'failed', 3), true],
      [ended('c', 'claim', 'failed', 2), false],
      [ended('u', 'update-behind', 'failed', 4), true],
      [ended('u', 'update-behind', 'failed', 3), false],
      [ended('j', 'judge', 'timed-out', 1), true],
      [ended('r', 'rollout', 'failed', 3), true],
      [ended('r', 'rollout', 'failed', 2), false],
      // heartbeat and sweep retry at their cadence however often they failed (SPEC 6.1)
      [ended('h', 'heartbeat', 'failed', 9), false],
      [ended('s', 'sweep', 'failed', 3), false],
      [ended('x', 'claim', 'running', 9), false],
      [ended('x', 'claim', 'done', 9), false],
    ]
    for (const [e, want] of cases) expect(exhausted(e, CFG), `${e.kind} ${e.status} ${e.attempts}`).toBe(want)
    expect(attemptsKindOf(ended('i', 'delegate', 'failed', 1))).toBe('implementer')
    expect(maxAttemptsOf(config({ updateBehindRetries: 5 }), 'update-behind')).toBe(6)
    expect(exhausted(cases[0]?.[0] as LedgerEntry, config({ maxAttempts: { ...CFG.maxAttempts, designer: 3 } }))).toBe(false)
  })

  test("retry clears the attempts of the issue's exhausted entries and the notices they raised, nothing else", () => {
    const failedTwice = ended(`design:60:${LIFE}`, 'spawn', 'failed', 2, { agent: 'designer', issue: 60 })
    const told = ended(`tell:agent-failed:design:60:${LIFE}`, 'tell', 'done', 1, { wake: 'agent-failed', issue: 60 })
    const keep = [
      ended('claim:60:new', 'claim', 'done', 1, { issue: 60 }),
      ended('guard:560:h:1', 'guard', 'failed', 1, { issue: 60 }),
      ended('stop:a60', 'stop-agent', 'running', 5, { issue: 60 }),
      ended('claim:61:new', 'claim', 'failed', 3, { issue: 61 }),
      ended('tell:agent-failed:claim:61:new', 'tell', 'done', 1, { issue: 61 }),
    ]
    const r = retryIssue([failedTwice, told, ...keep], 60, CFG)
    expect(r.cleared).toEqual([failedTwice.key])
    expect(r.notices).toEqual([told.key])
    // the entry stays, its count cleared: the next attempt is the first
    const reset = { ...failedTwice, attempts: 0, summary: 'attempts cleared by the owner (/factory retry)' }
    expect(r.ledger).toEqual([reset, ...keep])
    expect(start(r.ledger, designer(60), NOW).entry.attempts).toBe(1)
    // a notice still open is left to its wake
    const open = { ...told, status: 'running' as const, endedAt: null }
    expect(retryIssue([failedTwice, open], 60, CFG)).toEqual({ ledger: [reset, open], cleared: [failedTwice.key], notices: [] })
    expect(retryIssue(keep, 60, CFG).cleared).toEqual([])
  })

  // Each case: plan holds the key as exhausted (and has told the owner), retry clears it, and
  // plan emits the action again.
  function crossCheck(s: State, held: LedgerEntry[], n: number, notice: string, again: string) {
    expect(keys(plan(withLedger(s, held), CFG))).toEqual([notice])
    const told = [...held, entry(notice, 'tell', { wake: notice.split(':')[1], class: 'owner', issue: n })]
    expect(keys(plan(withLedger(s, told), CFG))).toEqual([])
    const r = retryIssue(withLedger(s, told).ledger, n, CFG)
    const after = plan({ ...s, ledger: r.ledger }, CFG)
    expect(keys(after)).toEqual([again])
    expect(after.skipped.some(k => k.why.startsWith('exhausted: '))).toBe(false)
    return r
  }

  test('after retry a designer is spawned again (rule D2)', () => {
    const s = state({ issues: [mine(60, 'designing', { stageSince: LIFE })] })
    const key = `design:60:${LIFE}`
    const r = crossCheck(s, [ended(key, 'spawn', 'failed', 2, { agent: 'designer', class: 'develop', issue: 60 })], 60, `tell:agent-failed:${key}`, key)
    // and a retry that runs out again is told again
    let ledger = r.ledger
    for (const at of [NOW, NOW + 5 * MIN]) {
      ledger = start(ledger, designer(60), at).ledger
      ledger = finish(ledger, key, { status: 'failed', summary: 'aborted' }, at + MIN)
    }
    expect(only(ledger, key).attempts).toBe(2)
    expect(keys(plan({ ...s, now: NOW + 12 * MIN, ledger }, CFG))).toEqual([`tell:agent-failed:${key}`])
  })

  test('after retry a claim is tried again (rule D1)', () => {
    const s = state({ queue: [1], issues: [issue(1)] })
    const key = `claim:1:${NOW - 30 * MIN}`
    crossCheck(s, [ended(key, 'claim', 'failed', 3, { class: 'start', issue: 1 })], 1, `tell:agent-failed:${key}`, key)
  })

  test('after retry a lost implementer is delegated again (rule D4b)', () => {
    const s = state({ issues: [mine(63, 'implementing')] })
    const lostTwice = ended(delegate.key, 'delegate', 'lost', 2, { class: 'develop', issue: 63, agentId: 'a63', agent: 'implementer' })
    crossCheck(s, [lostTwice], 63, `tell:agent-failed:${delegate.key}`, delegate.key)
  })

  test('after retry a skipped update-behind runs again (rule M2b)', () => {
    const s = state({ issues: [mine(50, 'ready to merge', { delegatedBrief: brief(50), pr: 550 })], runs: [run(50, 'merge-ready')] })
    const behind = entry('guard:550:head50:1', 'guard', {
      issue: 50,
      pr: 550,
      head: 'head50',
      startedAt: NOW - 2 * MIN,
      endedAt: NOW - MIN,
      outcome: { kind: 'guard', fails: [{ name: 'mergeable', reason: 'behind main, run update-behind first' }], warns: [] },
    })
    const skipped = ended('update-behind:550:head50', 'update-behind', 'failed', 4, {
      issue: 50,
      pr: 550,
      head: 'head50',
      endedAt: NOW - 6 * MIN,
      outcome: { kind: 'update-behind', result: 'skip', from: 'head50', to: null, line: 'UPDATE-BEHIND SKIP' },
    })
    const r = crossCheck(s, [behind, skipped], 50, 'tell:update-behind:550:head50', 'update-behind:550:head50')
    expect(r.cleared).toEqual(['update-behind:550:head50'])
    expect(r.notices).toEqual(['tell:update-behind:550:head50'])
  })

  test('after retry a timed-out model task is woken again (rule M7)', () => {
    const merged = entry('merge:550:head50', 'merge', {
      issue: 50,
      pr: 550,
      head: 'head50',
      outcome: { kind: 'merge', result: 'merged', rollout: 'run-it', closeIssue: null, line: 'merged' },
    })
    const timedOut = ended('task:run-it:50', 'task', 'timed-out', 1, { wake: 'run-it', class: 'drive', issue: 50 })
    crossCheck(state(), [merged, timedOut], 50, 'tell:task-timeout:task:run-it:50', 'task:run-it:50')
  })

  test('an entry with attempts left is not cleared, and plan retries it by itself', () => {
    const s = state({ issues: [mine(60, 'designing', { stageSince: LIFE })] })
    const key = `design:60:${LIFE}`
    const roomy = config({ maxAttempts: { ...CFG.maxAttempts, designer: 3 } })
    const once = ended(key, 'spawn', 'failed', 2, { agent: 'designer', class: 'develop', issue: 60 })
    expect(retryIssue(withLedger(s, [once]).ledger, 60, roomy).cleared).toEqual([])
    expect(keys(plan(withLedger(s, [once]), roomy))).toEqual([key])
  })
})

describe("the loop's own events (D-09, SPEC 7.4)", () => {
  test('agent and wake entries log a loop event at their start and end, which rebuilds them', () => {
    let ledger = started([adjudicator], NOW - 5 * MIN)
    const startEvent = loopEvent(only(ledger, adjudicator.key))
    expect(startEvent?.slice(0, 10)).toEqual(['callum-flow-event', 'loop', '--issue', '45', '--run', 'R45', '--pr', '545', '--head', 'h45'])
    expect(startEvent?.[10]).toBe('--note')
    expect(startEvent?.[11]).toMatch(/^kind=spawn key=adjudicate:R45:review:h45 status=running attempts=1 /)
    ledger = finish(ledger, adjudicator.key, { status: 'running', agentId: 'a45', summary: 'spawned' }, NOW - 5 * MIN)
    ledger = finish(ledger, adjudicator.key, { status: 'failed', summary: 'unparseable reply' }, NOW)
    const ended = only(ledger, adjudicator.key)
    const argv = loopEvent(ended) as string[]
    // what a lost store is rebuilt from (SPEC 7.5): the event gives the entry back
    const event: FactoryEvent = { ts: NOW, state: 'loop', issue: 45, run: 'R45', branch: null, pr: 545, head: 'h45', note: argv[11] ?? null, actor: null, device: null }
    expect(entryFromLoop(event)).toEqual({ ...ended, summary: undefined })
  })

  test('wakes and owner notices log one; CLI work logs its own events and gets none', () => {
    const tell: Action = { kind: 'tell', wake: 'runaway', fields: {}, context: [], key: 'tell:runaway:start:1', class: 'owner', rule: 'O2', reason: 'tell runaway', issue: null }
    for (const a of [judge, tell, delegate, designer(60)]) expect(loopEvent(start([], a, NOW).entry)?.[1]).toBe('loop')
    for (const a of [claim(7), guard, merge, stop('a1', 'A1')]) expect(loopEvent(start([], a, NOW).entry)).toBeNull()
    expect(loopEvent(entry('heartbeat:0', 'heartbeat'))).toBeNull()
  })

  test("a stop's side effect shows among the changed entries, so the agent's end is logged", () => {
    const agent = entry('design:70:x', 'spawn', { agent: 'designer', class: 'develop', issue: 70, status: 'running', endedAt: null, agentId: 'a70' })
    const before = started([stop('a70', 'A1')], NOW, [agent])
    const after = finish(before, 'stop:a70', { status: 'done', summary: 'stopped' }, NOW)
    const changed = changedEntries(before, after)
    expect(changed.map(e => [e.key, e.status])).toEqual([
      ['design:70:x', 'timed-out'],
      ['stop:a70', 'done'],
    ])
    expect(changed.map(loopEvent).filter(e => e !== null)).toHaveLength(1)
  })
})

describe('the store (SPEC 7.1)', () => {
  // fakeStore: $.store as the engine documents it: JSON data, read back as its JSON round
  // trip, and a set that would put the store over 4 MiB of JSON in all is refused.
  function fakeStore(initial: Record<string, unknown> = {}): StoreIo & { data: Map<string, unknown> } {
    const data = new Map(Object.entries(initial))
    return {
      data,
      get: async key => data.get(key),
      set: async (key, value) => {
        const next = new Map(data).set(key, JSON.parse(JSON.stringify(value)))
        if (JSON.stringify(Object.fromEntries(next)).length > 4 * 1024 * 1024) throw new Error('store over 4 MiB')
        data.set(key, next.get(key))
      },
    }
  }

  test('save and load round trip under ledger:<repo>, pruned first', async () => {
    const store = fakeStore({ 'queue-known:cbundy/dev-system': [7, 9] })
    let ledger = started([adjudicator, claim(7)], NOW - 5 * MIN)
    ledger = finish(ledger, adjudicator.key, { status: 'running', agentId: 'a45', summary: 'spawned' }, NOW - 5 * MIN)
    ledger = finish(ledger, 'claim:7:new', { status: 'done', outcome: { kind: 'claim', result: 'claimed' }, summary: 'claimed' }, NOW - 4 * MIN)
    const old = entry('sweep:1', 'sweep', { startedAt: NOW - 9 * DAY, endedAt: NOW - 8 * DAY })
    const written = await save(store, REPO, [old, ...ledger], NOW)
    expect(written).toEqual(ledger)
    expect(store.data.get(storeKey(REPO))).toEqual({ v: 1, savedAt: NOW, entries: ledger })
    expect(await load(store, REPO)).toEqual(ledger)
    expect(await load(store, 'cbundy/other')).toBeNull()
    // the other keys are the driver's, and stay
    expect(store.data.get('queue-known:cbundy/dev-system')).toEqual([7, 9])
  })

  test('a busy week saves beside the other keys with room to spare', async () => {
    const store = fakeStore({ 'queue-known:cbundy/dev-system': [7, 9], 'backoff:cbundy/dev-system': NOW })
    const week = busyWeek(20)
    expect(await save(store, REPO, week, NOW)).toHaveLength(week.length)
    expect(await load(store, REPO)).toEqual(week)
  })

  test('the stored value keeps the fields plan reads, and drops what JSON cannot hold', async () => {
    const store = fakeStore()
    const verdict: Outcome = { kind: 'adjudicator', verdicts: ['WRONG: no'], action: { type: 'escalate', why: 'unclear' }, report: null }
    const e = { ...entry('adjudicate:R1:review:h1', 'spawn', { agent: 'adjudicator', class: 'drive', issue: 1, run: 'R1', head: 'h1', outcome: verdict }), summary: undefined }
    await save(store, REPO, [e], NOW)
    const back = await load(store, REPO)
    expect(back).toEqual([{ ...e }])
    expect(back?.[0] && 'summary' in back[0]).toBe(false)
  })

  test('another version, a malformed value or a malformed entry never becomes a ledger', async () => {
    expect(await load(fakeStore(), REPO)).toBeNull()
    expect(await load(fakeStore({ [storeKey(REPO)]: { v: 2, savedAt: NOW, entries: [] } }), REPO)).toBeNull()
    expect(await load(fakeStore({ [storeKey(REPO)]: 'junk' }), REPO)).toBeNull()
    expect(fromStored({ v: 1, savedAt: NOW })).toBeNull()
    const good = entry('claim:7:new', 'claim', { class: 'start', issue: 7 })
    const bad = [
      { ...good, key: '' },
      { ...good, kind: 'teleport' },
      { ...good, status: 'pending' },
      { ...good, class: 'vip' },
      { ...good, attempts: 1.5 },
      { ...good, startedAt: 'yesterday' },
      { ...good, issue: '7' },
      { ...good, endedAt: undefined },
      null,
      42,
    ]
    expect(fromStored({ v: 1, savedAt: NOW, entries: [...bad, good] })).toEqual([good])
    // two entries under one key: the later start wins, as in plan
    const older = { ...good, startedAt: NOW - 20 * MIN, attempts: 1 }
    const newer = { ...good, startedAt: NOW - 10 * MIN, attempts: 2 }
    expect(fromStored({ v: 1, savedAt: NOW, entries: [newer, older] })).toEqual([newer])
    expect(fromStored({ v: 1, savedAt: NOW, entries: [older, newer] })).toEqual([newer])
  })

  test('a store that cannot be read throws rather than starting an empty ledger', async () => {
    const broken: StoreIo = { get: async () => Promise.reject(new Error('EIO')), set: async () => undefined }
    await expect(load(broken, REPO)).rejects.toThrow('EIO')
  })
})

// busyWeek: a week of factory work: lease renewals and sweeps on their cadence, and perDay
// issues a day taken from claim to merge, each with its designer, implementer, three adjudicated
// gates and their responds, five guards, the merge review, a sequencing wake, the merge, its
// follow-ups and a notice; one CLI failure per issue carries the full 2 000 characters of stderr.
function busyWeek(perDay: number): LedgerEntry[] {
  const out: LedgerEntry[] = []
  const at = (offset: number) => ({ startedAt: offset - 2 * MIN, endedAt: offset })
  for (let t = NOW - 7 * DAY + 20 * MIN; t <= NOW; t += 20 * MIN) out.push(entry(`heartbeat:${t - 20 * MIN}`, 'heartbeat', at(t)))
  for (let t = NOW - 7 * DAY + 30 * MIN; t <= NOW; t += 30 * MIN) out.push(entry(`sweep:${t - 30 * MIN}`, 'sweep', at(t)))
  const stderr = 'gh: HTTP 502 Bad Gateway (https://api.github.com/repos/cbundy/dev-system/pulls)\n'.repeat(40).slice(0, 2000)
  for (let i = 0; i < 7 * perDay; i++) {
    const n = 1000 + i
    const t0 = NOW - 7 * DAY + i * (DAY / perDay) + MIN
    const runId = `01M4RQ${String(n).padStart(6, '0')}AAAAAAAAAAAA`
    const head = (k: number) => `${n}${k}`.padEnd(40, 'f')
    const subject = { issue: n, run: runId, pr: 500 + n }
    const t = (k: number) => at(t0 + k * 2 * MIN)
    out.push(entry(`claim:${n}:new`, 'claim', { class: 'start', issue: n, ...t(0), outcome: { kind: 'claim', result: 'claimed' } }))
    out.push(
      entry(`design:${n}:${t0}`, 'spawn', {
        agent: 'designer',
        class: 'develop',
        issue: n,
        agentId: `a${n}d`,
        ...t(1),
        outcome: { kind: 'designer', brief: `https://github.com/cbundy/dev-system/issues/${n}#issuecomment-${3_000_000_000 + n}`, created: [], pendingDecision: false },
      }),
    )
    out.push(
      entry(`delegate:${n}:https://github.com/cbundy/dev-system/issues/${n}#issuecomment-${3_000_000_000 + n}`, 'delegate', {
        agent: 'implementer',
        class: 'develop',
        ...subject,
        agentId: `a${n}i`,
        ...t(2),
        outcome: { kind: 'handoff', notGated: false, run: runId, head: head(0), newBranch: null },
      }),
    )
    for (const [k, step] of ['review', 'test', 'lint'].entries()) {
      out.push(
        entry(`adjudicate:${runId}:${step}:${head(k)}`, 'spawn', {
          agent: 'adjudicator',
          class: 'drive',
          ...subject,
          head: head(k),
          agentId: `a${n}a${k}`,
          ...t(3 + k),
          outcome: {
            kind: 'adjudicator',
            verdicts: [
              'CORRECT: review-1 the retry loop never resets its counter after a successful read',
              'NIT: review-2 the helper name says parse but it also validates the shape',
              'WRONG: review-3 the comma form of --accept-dropped is required by the CLI',
            ],
            action: { type: 'fix', findings: 'review-1', instructions: 'reset the counter after each successful read', addFinding: null },
            report: null,
          },
        }),
      )
      out.push(
        entry(`respond:${runId}:${step}:${head(k)}:fix`, 'respond', {
          class: 'drive',
          ...subject,
          head: head(k),
          ...t(3 + k),
          outcome: { kind: 'respond', slot: `/workspaces/dev-system/.treehouse/dev-system-22f535/${k + 2}/dev-system`, log: `/persist/claude/factory-loop/cbundy__dev-system/respond/${runId}-1.log` },
        }),
      )
    }
    for (let g = 1; g <= 5; g++) {
      out.push(
        entry(`guard:${500 + n}:${head(3)}:${g}`, 'guard', {
          ...subject,
          head: head(3),
          ...t(6 + g),
          outcome: {
            kind: 'guard',
            fails: g < 5 ? [{ name: 'checks', reason: 'ci=pending, e2e=pending, lint=pending' }] : [],
            warns: ['GUARD test-weakening WARN tests/foo.test.ts: an assertion was removed from the retry test'],
          },
        }),
      )
    }
    out.push(
      entry(`adjudicate-merge:${500 + n}:${head(3)}`, 'spawn', {
        agent: 'adjudicator',
        class: 'drive',
        ...subject,
        head: head(3),
        agentId: `a${n}m`,
        ...t(12),
        outcome: {
          kind: 'adjudicator',
          verdicts: [],
          action: { type: 'merge' },
          report: { summary: 'the dev image gains a PostgreSQL 17 server for local tests', bump: 'minor', bumpReason: 'a new tool', flags: ['image'] },
        },
      }),
    )
    out.push(
      entry(`judge:sequence:${500 + n}:${head(3)}`, 'judge', {
        wake: 'sequence',
        class: 'drive',
        ...subject,
        head: head(3),
        wakeId: `w${n}`,
        turnId: `turn-${n}`,
        ...t(13),
        outcome: { kind: 'wake', decision: 'merge', reason: 'nothing else waits for the next release', instructions: null, bump: null, bumpReason: null, fields: {} },
      }),
    )
    out.push(
      entry(`merge:${500 + n}:${head(3)}`, 'merge', {
        ...subject,
        head: head(3),
        ...t(14),
        outcome: { kind: 'merge', result: 'merged', rollout: 'merge', closeIssue: n, line: `MERGED ${500 + n} rollout=merge close_issue=${n}` },
      }),
    )
    out.push(entry(`close:${n}`, 'close-issue', { issue: n, ...t(15), outcome: { kind: 'cli', exit: 0 } }))
    out.push(entry(`milestone-later:${n}`, 'milestone-later', { issue: n, status: 'failed', ...t(15), outcome: { kind: 'cli', exit: 1, detail: stderr } }))
    out.push(entry(`tell:merge-hold:${500 + n}:${head(3)}`, 'tell', { wake: 'merge-hold', class: 'owner', issue: n, wakeId: `w${n}t`, ...t(16) }))
  }
  return out
}
