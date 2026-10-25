// Waking the model and reading its answers (wake.ts; v2 SPEC 13.8, 13.9.2, 13.10 item 8; D-04, D-25, D-26): the
// prompt of every wake the planner emits, the ANSWER blocks and the answer tool, turn tracking with its
// one reminder and the timeouts' fallbacks.
import { describe, expect, test } from 'claude-code/testing'

import { S } from '../hooks/driver-state'
import { WAKE_POINTER } from '../hooks/exec'
import type { ActIo, Exec, ExecCtx } from '../hooks/exec'
import { exhausted, finish } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State, WakeKind } from '../hooks/types'
import {
  ANSWER_TOOL,
  WAKE_SUMMARY_MAX,
  allowedDecisions,
  answerTool,
  checkAnswer,
  expireWakes,
  orphanedWakes,
  lineSummary,
  onTurnComplete,
  onTurnStart,
  parseAnswers,
  reminderLine,
  wakeExecutors,
  wakeLine,
} from '../hooks/wake'
import type { WakeAction, WakeUpdate } from '../hooks/wake'
import { DEVICE, MIN, NOW, OTHER, PLUGIN_ROOT, brief, config, entry, find, keys, mine, review, run, state, withLedger } from './fixtures'

const REPO = 'cbundy/dev-system'
const LOOP_DIR = '/cfg/factory-loop/cbundy__dev-system'
const CFG = config({ mode: 'act' })
const RUN47 = '01M4RQ0047AAAA'

function runtime(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/workspaces/dev-system',
    loopDir: LOOP_DIR,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: '/usr/local/share/callum-tools',
    pluginRoot: PLUGIN_ROOT,
    config: CFG,
    configProblems: [],
  }
}

// w: a wake action exactly as plan's wake() builds one (null fields dropped, values as text).
function w(kind: WakeKind, name: string, fields: Record<string, string | number | null>, context: string[] = [], issue: number | null = null): WakeAction {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== null) clean[k] = String(v)
  return { kind, wake: name, key: `${kind}:${name}:test`, class: kind === 'tell' ? 'owner' : 'drive', rule: 'test', reason: `${kind} ${name}`, issue, fields: clean, context }
}

// harness: a fake ExecCtx whose submit records each prompt; a wake runs no command, logs no event
// and calls nothing else. Wake ids count w1, w2, ...
function harness(ledger: LedgerEntry[] = [], submitError: Error | null = null) {
  const prompts: string[] = []
  let ids = 0
  const never = (what: string) => async () => {
    throw new Error(`a wake does not ${what}`)
  }
  const io: ActIo = {
    now: async () => NOW,
    run: never('run commands'),
    spawnAgent: never('spawn agents'),
    stopAgent: never('stop agents'),
    submit: async text => {
      if (submitError !== null) throw submitError
      prompts.push(text)
    },
    rename: never('rename the session'),
    usage: never('read usage'),
    readFile: never('read files'),
    writeFile: never('write files'),
  }
  const exec = async (action: Action): Promise<Exec> => {
    const executor = wakeExecutors[action.kind]
    if (executor === undefined) throw new Error(`no wake executor for ${action.kind}`)
    const ctx: ExecCtx = {
      io,
      rt: runtime(),
      state: state({ ledger }),
      entry: entry(action.key, action.kind, { status: 'running', endedAt: null, startedAt: NOW }),
      cmd: never('run commands'),
      event: never('log events itself (the ledger logs its loop event)'),
      wakeId: () => `w${++ids}`,
    }
    return executor(ctx, action)
  }
  return { prompts, exec }
}

// open: a running wake entry as the driver leaves it once the executor returned.
function open(key: string, kind: WakeKind, wake: string, wakeId: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(key, kind, { wake, wakeId, status: 'running', endedAt: null, startedAt: NOW - 5 * MIN, class: kind === 'tell' ? 'owner' : 'drive', ...over })
}

// apply: the updates as ledger.ts finish applies a completion (status, end time, outcome,
// summary and the wake's ids), so plan can read the result.
function apply(ledger: readonly LedgerEntry[], updates: readonly WakeUpdate[], now = NOW): LedgerEntry[] {
  let out = [...ledger]
  for (const u of updates) {
    out = out.map(e => {
      if (e.key !== u.key) return e
      const next: LedgerEntry = { ...e, status: u.status, endedAt: u.status === 'running' ? null : now }
      if (u.outcome !== undefined) next.outcome = u.outcome
      if (u.summary !== undefined) next.summary = u.summary
      if (u.wakeId !== undefined) next.wakeId = u.wakeId
      if (u.turnId !== undefined) next.turnId = u.turnId
      if (u.reminded !== undefined) next.reminded = u.reminded
      return next
    })
  }
  return out
}

const lines = (prompt: string) => prompt.split('\n')
const answerOf = (u: WakeUpdate | undefined) => (u?.outcome?.kind === 'wake' ? u.outcome : undefined)

describe('the prompt (v2 SPEC 13.8.1)', () => {
  const B = brief(47)
  const R = `repo=${REPO}`
  // every wake plan.ts emits (grep `wake(` there), with the fields it gives, plus the driver's
  // own tells (heartbeat-other, the ping breaker)
  const cases: [WakeAction, string][] = [
    [w('tell', 'blind', { since: NOW - 20 * MIN }), `TELL blind id=w1 ${R} since=${NOW - 20 * MIN}`],
    [w('tell', 'blind', { since: 'never' }), `TELL blind id=w1 ${R} since=never`],
    [w('tell', 'drain-slow', { since: NOW - 70 * MIN }), `TELL drain-slow id=w1 ${R} since=${NOW - 70 * MIN}`],
    [w('tell', 'review-cap', { issue: 47, run: RUN47, rounds: 3, brief: B }), `TELL review-cap id=w1 ${R} issue=47 run=${RUN47} rounds=3 brief=${B}`],
    [w('tell', 'escalate', { issue: 47, run: RUN47, step: 'review', brief: B }), `TELL escalate id=w1 ${R} issue=47 run=${RUN47} step=review brief=${B}`],
    [w('tell', 'escalate', { issue: 50, pr: 550, run: RUN47, brief: null }), `TELL escalate id=w1 ${R} issue=50 pr=550 run=${RUN47}`],
    [w('task', 'redrive', { issue: 46, branch: 'feat/issue-46-work', head: 'head46', cause: 'infrastructure' }), `TASK redrive id=w1 ${R} issue=46 branch=feat/issue-46-work head=head46 cause=infrastructure`],
    [w('judge', 'cancelled', { issue: 47, run: RUN47, branch: 'feat/issue-47-work', head: 'head47', brief: B }), `JUDGE cancelled id=w1 ${R} issue=47 run=${RUN47} branch=feat/issue-47-work head=head47 brief=${B}`],
    [w('tell', 'no-ci', { issue: 48, pr: 548 }), `TELL no-ci id=w1 ${R} issue=48 pr=548`],
    [w('tell', 'ci-triggers', { issue: 48, pr: 548 }), `TELL ci-triggers id=w1 ${R} issue=48 pr=548`],
    [w('task', 'respond-stuck', { issue: 45, run: 'R45', branch: 'feat/issue-45-x', step: 'review', head: 'h1' }), `TASK respond-stuck id=w1 ${R} issue=45 run=R45 branch=feat/issue-45-x step=review head=h1`],
    [w('tell', 'untrusted-pr', { issue: 50, pr: 550 }), `TELL untrusted-pr id=w1 ${R} issue=50 pr=550`],
    [w('tell', 'rollout', { issue: 50, pr: 550 }), `TELL rollout id=w1 ${R} issue=50 pr=550`],
    [w('tell', 'base', { issue: 50, pr: 550 }), `TELL base id=w1 ${R} issue=50 pr=550`],
    [w('tell', 'linkage', { issue: 50, pr: 550 }), `TELL linkage id=w1 ${R} issue=50 pr=550`],
    [w('judge', 'guard-fail', { issue: 50, pr: 550, run: RUN47, head: 'head50', brief: B }), `JUDGE guard-fail id=w1 ${R} issue=50 pr=550 run=${RUN47} head=head50 brief=${B}`],
    [w('tell', 'update-behind', { issue: 50, pr: 550 }), `TELL update-behind id=w1 ${R} issue=50 pr=550`],
    [w('tell', 'merge-hold', { issue: 50, pr: 550, run: RUN47, head: 'head50' }), `TELL merge-hold id=w1 ${R} issue=50 pr=550 run=${RUN47} head=head50`],
    [w('judge', 'sequence', { pr: 550, issue: 50, head: 'head50', flags: 'image,run-it', bump: 'minor' }), `JUDGE sequence id=w1 ${R} pr=550 issue=50 head=head50 flags=image,run-it bump=minor`],
    [w('tell', 'merge-refused', { issue: 50, pr: 550 }), `TELL merge-refused id=w1 ${R} issue=50 pr=550`],
    [w('task', 'run-it', { issue: 60, pr: 560 }), `TASK run-it id=w1 ${R} issue=60 pr=560`],
    [w('judge', 'report', { issue: 47, agent: 'designer', entry: 'design:47:1000' }), `JUDGE report id=w1 ${R} issue=47 agent=designer entry=design:47:1000`],
    [w('judge', 'report', { issue: 47, agent: 'designer', brief: B }), `JUDGE report id=w1 ${R} issue=47 agent=designer brief=${B}`],
    [w('tell', 'decision', { issue: 47, brief: B }), `TELL decision id=w1 ${R} issue=47 brief=${B}`],
    [w('judge', 'handoff', { issue: 47, entry: `delegate:47:${B}`, run: RUN47, head: 'head47' }), `JUDGE handoff id=w1 ${R} issue=47 entry=delegate:47:${B} run=${RUN47} head=head47`],
    [w('tell', 'at-cap', { live: 10, cap: 10 }), `TELL at-cap id=w1 ${R} live=10 cap=10`],
    [w('tell', 'claim-lost', { issue: 47, holder: OTHER }), `TELL claim-lost id=w1 ${R} issue=47 holder=${OTHER}`],
    [w('tell', 'stopped', { issue: 47, why: 'split' }), `TELL stopped id=w1 ${R} issue=47 why=split`],
    [w('tell', 'agent-failed', { key: 'design:47:1000', kind: 'spawn' }), `TELL agent-failed id=w1 ${R} key=design:47:1000 kind=spawn`],
    [w('tell', 'task-timeout', { key: 'task:run-it:60', kind: 'task' }), `TELL task-timeout id=w1 ${R} key=task:run-it:60 kind=task`],
    [w('task', 'release', { closed: 4, expected: 'minor' }), `TASK release id=w1 ${R} closed=4 expected=minor`],
    [w('task', 'release', { closed: 4, expected: null }), `TASK release id=w1 ${R} closed=4`],
    [w('task', 'release', { closed: 4, expected: 'minor', tag: 'v1.2.3', oldest: '2026-10-12T08:30:00.000Z' }), `TASK release id=w1 ${R} closed=4 expected=minor tag=v1.2.3 oldest=2026-10-12T08:30:00.000Z`],
    [w('tell', 'runaway', { cap: 'start' }), `TELL runaway id=w1 ${R} cap=start`],
    [w('tell', 'breaker', { kind: 'guard' }), `TELL breaker id=w1 ${R} kind=guard`],
    [w('tell', 'breaker', { kind: 'ping' }), `TELL breaker id=w1 ${R} kind=ping`],
    [w('tell', 'heartbeat-other', { device: OTHER }), `TELL heartbeat-other id=w1 ${R} device=${OTHER}`],
  ]

  test('the first line of every wake: kind, name, id, repo, then the fields in plan order', async () => {
    for (const [action, first] of cases) {
      const h = harness()
      const result = await h.exec(action)
      const sent = h.prompts[0] ?? ''
      expect([action.wake, lines(sent)[0]]).toEqual([action.wake, first])
      // the skill's pointer is the last line of every wake
      expect([action.wake, lines(sent).at(-1)]).toEqual([action.wake, WAKE_POINTER])
      expect(result).toEqual({ status: 'running', wakeId: 'w1', summary: first })
    }
  })

  test("plan's context follows as detail lines; values never hold a space; the loop's own keys stay its own", async () => {
    const h = harness()
    const action = w('judge', 'sequence', { pr: 550, issue: 50, head: 'head50', flags: 'image', bump: 'minor', id: 'spoof', why: 'two words\tand a tab' }, [
      'SUMMARY: the dev image gains a PostgreSQL 17 server',
      'BUMP: minor a new server\nFLAGS: image',
      '',
    ])
    await h.exec(action)
    expect(lines(h.prompts[0] ?? '')).toEqual([
      `JUDGE sequence id=w1 repo=${REPO} pr=550 issue=50 head=head50 flags=image bump=minor why=two%20words%09and%20a%20tab`,
      'SUMMARY: the dev image gains a PostgreSQL 17 server',
      'BUMP: minor a new server',
      'FLAGS: image',
      WAKE_POINTER,
    ])
  })

  test('a prompt refused because the session was stopped is skipped and marks the hold; a delivered one clears it', async () => {
    S.held = null
    S.resumed = null
    const dropped = new Error('the prompt was dropped: the session was stopped and nobody has sent input since')
    expect((await harness([], dropped).exec(w('tell', 'blind', { since: 'never' }))).status).toBe('skipped')
    expect(S.held).toMatchObject({ since: NOW, spawns: 0, wakes: 1 })
    expect((await harness().exec(w('tell', 'blind', { since: 'never' }))).status).toBe('running')
    expect(S.held).toBeNull()
    expect(S.resumed).toMatchObject({ since: NOW, wakes: 1 })
    S.resumed = null
  })

  test('a submit that fails started no turn: skipped, so it uses no attempt; a non-wake action is a loop bug', async () => {
    const h = harness([], new Error('session closed'))
    expect(await h.exec(w('tell', 'blind', { since: 'never' }))).toEqual({ status: 'skipped', summary: 'submit failed: Error: session closed' })
    expect(h.prompts).toEqual([])
    const executor = wakeExecutors.judge
    if (executor === undefined) throw new Error('no judge executor')
    const heartbeat: Action = { kind: 'heartbeat', key: 'heartbeat:0', class: 'free', rule: 'H1', reason: 'lease', issue: null }
    const ctx = { wakeId: () => 'w1' } as unknown as ExecCtx
    expect(await executor(ctx, heartbeat)).toEqual({ status: 'failed', summary: 'not a wake: heartbeat', noRetry: true })
  })

  test('the detail lines are the action\'s context alone: no file of an agent\'s is named, then the skill pointer', async () => {
    const h = harness()
    await h.exec(w('judge', 'report', { issue: 47, agent: 'designer', entry: 'design:47:1000' }))
    await h.exec(w('judge', 'handoff', { issue: 47, entry: `delegate:47:${brief(47)}`, run: RUN47, head: 'head47' }, ['NOT GATED: commit 03a35cd']))
    expect(lines(h.prompts[0] ?? '').slice(1)).toEqual([WAKE_POINTER])
    expect(lines(h.prompts[1] ?? '').slice(1)).toEqual(['NOT GATED: commit 03a35cd', WAKE_POINTER])
  })

  test('the summary keeps the first line for the reminder, cut after a whole field when too long', () => {
    const long = w('tell', 'escalate', { issue: 47, a: 'x'.repeat(150), b: 'y'.repeat(150) })
    const first = wakeLine(long, 'w1', REPO)
    const summary = lineSummary(first)
    expect(first.length).toBeGreaterThan(WAKE_SUMMARY_MAX)
    expect(summary).toBe(`TELL escalate id=w1 repo=${REPO} issue=47 a=${'x'.repeat(150)}`)
    expect(lineSummary('TELL blind id=w1')).toBe('TELL blind id=w1')
  })
})

describe('ANSWER blocks (v2 SPEC 13.8.2)', () => {
  test('a block amid prose and a code fence; its key lines end at a blank line or any other line', () => {
    const text = [
      'I checked the milestone: nothing else waits for the next release.',
      '',
      '```text',
      'ANSWER w41 merge',
      'reason: nothing else waits for the next release, so the image change can join it',
      '```',
    ].join('\n')
    expect(parseAnswers(text)).toEqual({
      blocks: [{ id: 'w41', decision: 'merge', reason: 'nothing else waits for the next release, so the image change can join it', instructions: null, fields: null }],
      problems: [],
    })
  })

  test('several blocks; the first value of a key counts; junk lines are named, never read', () => {
    const text = [
      'ANSWER w1 hold',
      'reason: first',
      'Reason: a second reason is ignored',
      'note: an unknown key',
      '',
      'ANSWER w2 fixer',
      'instructions: CI check test failed on 03a35cd: make it pass without weakening a test, then re-gate',
      'fields: {"a": 1}',
      '**ANSWER w3 done**',
      '`ANSWER w4 failed`',
      'reason:',
      'ANSWER w5',
      'ANSWER: w6 merge',
      'The ANSWER above is final.',
    ].join('\r\n')
    const parsed = parseAnswers(text)
    expect(parsed.blocks).toEqual([
      { id: 'w1', decision: 'hold', reason: 'first', instructions: null, fields: null },
      { id: 'w2', decision: 'fixer', reason: null, instructions: 'CI check test failed on 03a35cd: make it pass without weakening a test, then re-gate', fields: '{"a": 1}' },
      { id: 'w3', decision: 'done', reason: null, instructions: null, fields: null },
      { id: 'w4', decision: 'failed', reason: null, instructions: null, fields: null },
    ])
    expect(parsed.problems).toEqual(['ANSWER w1: unknown key note', 'not an ANSWER line: ANSWER w5', 'not an ANSWER line: ANSWER: w6 merge'])
  })

  test('no block at all', () => {
    expect(parseAnswers('Done: the run moved on after all.')).toEqual({ blocks: [], problems: [] })
    expect(parseAnswers('')).toEqual({ blocks: [], problems: [] })
  })
})

describe('checking an answer (v2 SPEC 13.8.2)', () => {
  const ledger = [
    open('judge:sequence:550:head50', 'judge', 'sequence', 'w1', { issue: 50, pr: 550, head: 'head50' }),
    open('task:run-it:60', 'task', 'run-it', 'w2', { issue: 60 }),
    open('tell:decision:47:x', 'tell', 'decision', 'w3', { issue: 47 }),
    open('judge:report:design:47:1000', 'judge', 'report', 'w4', { issue: 47 }),
    entry('judge:cancelled:R:h', 'judge', { wake: 'cancelled', wakeId: 'w5', outcome: { kind: 'wake', decision: 'redrive', reason: null, instructions: null, bump: null, bumpReason: null, fields: {} } }),
    open('judge:mystery:1', 'judge', 'mystery', 'w6'),
    open('judge:guard-fail:550:head50:1', 'judge', 'guard-fail', 'w7', { issue: 50 }),
    open('task:redrive:b:h', 'task', 'redrive', 'w8', { issue: 46 }),
  ]
  const check = (id: string, decision: string, more: { reason?: string; instructions?: string; fields?: unknown } = {}) =>
    checkAnswer(ledger, { id, decision, ...more }, REPO)
  const problem = (c: ReturnType<typeof check>) => (c.ok ? null : c.problem)

  test('each wake takes only the decisions v2 SPEC 13.8.2 allows', () => {
    expect(allowedDecisions('judge', 'sequence')).toEqual(['merge', 'hold'])
    expect(allowedDecisions('judge', 'guard-fail')).toEqual(['fixer', 'wait', 'hold'])
    expect(allowedDecisions('judge', 'cancelled')).toEqual(['redrive', 'drop'])
    expect(allowedDecisions('judge', 'handoff')).toEqual(['ok', 'fixer', 'hold'])
    expect(allowedDecisions('judge', 'report')).toEqual(['parsed', 'hold'])
    for (const name of ['redrive', 'run-it', 'release', 'respond-stuck']) expect(allowedDecisions('task', name)).toEqual(['done', 'failed', 'hold'])
    expect(allowedDecisions('tell', 'decision')).toEqual([])
    // a name the table lacks may only hold (the skill: `reason: unknown wake <name>`)
    expect(allowedDecisions('judge', 'mystery')).toEqual(['hold'])
    expect(allowedDecisions('task', 'mystery')).toEqual(['hold'])
  })

  test('an allowed decision closes its wake with the outcome plan reads', () => {
    const c = check('w1', 'Merge', { reason: '  nothing else waits  ' })
    expect(c).toEqual({
      ok: true,
      update: {
        key: 'judge:sequence:550:head50',
        status: 'done',
        outcome: { kind: 'wake', decision: 'merge', reason: 'nothing else waits', instructions: null, bump: null, bumpReason: null, fields: {} },
        summary: 'answered merge: nothing else waits',
      },
    })
    expect(check('id=w2', 'done').ok).toBe(true)
    expect(check('w2', 'hold').ok).toBe(true)
    expect(check('w6', 'hold', { reason: 'unknown wake mystery' }).ok).toBe(true)
    const fixer = check('w7', 'fixer', { instructions: 'CI check test failed on 03a35cd: make it pass' })
    expect(fixer.ok ? answerOf(fixer.update)?.instructions : null).toBe('CI check test failed on 03a35cd: make it pass')
  })

  test('a bad id, a closed wake, a tell or a disallowed decision is refused, and the wake stays open', () => {
    expect(problem(check('w9', 'merge'))).toBe('ANSWER w9 merge: no wake has this id')
    expect(problem(check('w5', 'drop', { reason: 'r' }))).toBe('ANSWER w5 drop: that wake is not open (done)')
    expect(problem(check('w3', 'done'))).toBe('ANSWER w3 done: a TELL takes no answer')
    expect(problem(check('w1', 'maybe'))).toBe('ANSWER w1 maybe: JUDGE sequence allows merge, hold')
    expect(problem(check('w1', 'constructor'))).toBe('ANSWER w1 constructor: JUDGE sequence allows merge, hold')
    expect(problem(check('w8', 'redrive'))).toBe('ANSWER w8 redrive: TASK redrive allows done, failed, hold')
    expect(problem(check('w6', 'merge'))).toBe('ANSWER w6 merge: JUDGE mystery allows hold')
  })

  test('a decision without the field it needs is refused', () => {
    expect(problem(check('w1', 'hold'))).toBe('ANSWER w1 hold: needs a reason')
    expect(problem(check('w1', 'hold', { reason: '   ' }))).toBe('ANSWER w1 hold: needs a reason')
    expect(problem(check('w7', 'fixer'))).toBe('ANSWER w7 fixer: needs instructions')
    expect(problem(check('w2', 'failed'))).toBe('ANSWER w2 failed: needs a reason')
    expect(problem(check('w6', 'hold'))).toBe('ANSWER w6 hold: needs a reason')
    expect(problem(check('w4', 'parsed'))).toBe('ANSWER w4 parsed: parsed needs fields: brief, created, pendingDecision')
  })

  test('fields are one JSON object of plain values', () => {
    expect(problem(check('w2', 'done', { fields: '{"brief": ' }))).toBe('ANSWER w2 done: fields is not one line of JSON')
    expect(problem(check('w2', 'done', { fields: '[1, 2]' }))).toBe('ANSWER w2 done: fields must be a JSON object')
    expect(problem(check('w2', 'done', { fields: '{"x": {"y": 1}}' }))).toBe('ANSWER w2 done: fields.x must be a string, number, boolean, null or a list of numbers')
    expect(problem(check('w2', 'done', { fields: '{"x": ["a"]}' }))).toBe('ANSWER w2 done: fields.x must be a string, number, boolean, null or a list of numbers')
    const kept = check('w2', 'done', { fields: '{"n": 1, "ok": true, "list": [4, 5], "none": null, "s": "t"}' })
    expect(kept.ok ? answerOf(kept.update)?.fields : null).toEqual({ n: 1, ok: true, list: [4, 5], none: null, s: 't' })
  })

  test("judge(report) parsed: a brief on this repo's issue or a split, and every field", () => {
    const parsed = (fields: unknown) => check('w4', 'parsed', { fields })
    const good = parsed(`{"brief": "${brief(47)}", "created": [], "pendingDecision": false}`)
    expect(good.ok ? answerOf(good.update) : null).toEqual({
      kind: 'wake',
      decision: 'parsed',
      reason: null,
      instructions: null,
      bump: null,
      bumpReason: null,
      fields: { brief: brief(47), created: [], pendingDecision: false },
    })
    // the tool hands an object, and a split has no brief of its own
    expect(parsed({ brief: null, created: [61, 62], pendingDecision: false }).ok).toBe(true)
    // the repo compares without regard to case, as GitHub's URLs do
    expect(parsed({ brief: 'https://github.com/CBundy/Dev-System/issues/47#issuecomment-1047', created: [], pendingDecision: true }).ok).toBe(true)
    const brief47 = 'ANSWER w4 parsed: fields.brief must be null or a comment URL on cbundy/dev-system issue 47'
    expect(problem(parsed({ brief: brief(48), created: [], pendingDecision: false }))).toBe(brief47)
    expect(problem(parsed({ brief: 'https://github.com/other/repo/issues/47#issuecomment-1', created: [], pendingDecision: false }))).toBe(brief47)
    expect(problem(parsed({ brief: 'https://github.com/cbundy/dev-system/issues/47', created: [], pendingDecision: false }))).toBe(brief47)
    expect(problem(parsed({ created: [], pendingDecision: false }))).toBe(brief47)
    expect(problem(parsed({ brief: null, created: [0], pendingDecision: false }))).toBe('ANSWER w4 parsed: fields.created must be a list of issue numbers ([] for none)')
    expect(problem(parsed({ brief: brief(47), created: 'none', pendingDecision: false }))).toBe('ANSWER w4 parsed: fields.created must be a list of issue numbers ([] for none)')
    expect(problem(parsed({ brief: brief(47), created: [] }))).toBe('ANSWER w4 parsed: fields.pendingDecision must be true or false')
    expect(problem(parsed({ brief: null, created: [], pendingDecision: false }))).toBe('ANSWER w4 parsed: parsed needs a brief or created issues; with neither, answer hold')
    // hold needs nothing (v2 SPEC 13.8.2): the owner designs it again
    expect(check('w4', 'hold').ok).toBe(true)
  })

  test('a long reason is cut, never refused', () => {
    const c = check('w2', 'done', { reason: 'r'.repeat(5000) })
    expect(c.ok ? answerOf(c.update)?.reason?.length : 0).toBe(2000)
  })
})

describe('turns: answers, the one reminder, tells delivered (v2 SPEC 13.8.2, 13.10 item 8, D-25)', () => {
  const action = w('judge', 'sequence', { pr: 550, issue: 50, head: 'head50', flags: 'image', bump: 'minor' }, ['SUMMARY: s'])
  const first = wakeLine(action, 'w1', REPO)
  const judge = open('judge:sequence:550:head50', 'judge', 'sequence', 'w1', { issue: 50, pr: 550, head: 'head50', summary: first, turnId: 't1' })

  test('a turn whose text starts with the wake line is its turn; a reminder too; any other turn is not', () => {
    const ledger = [{ ...judge, turnId: undefined }]
    const prompt = `${first}\nSUMMARY: s\n${WAKE_POINTER}`
    expect(onTurnStart(ledger, prompt, 't1')).toEqual({ key: judge.key, status: 'running', wakeId: 'w1', turnId: 't1' })
    expect(onTurnStart(ledger, `\n  ${first} reminder=1\n${WAKE_POINTER}`, 't2')).toEqual({ key: judge.key, status: 'running', wakeId: 'w1', turnId: 't2' })
    expect(onTurnStart(ledger, 'what is the factory doing?', 't3')).toBeNull()
    expect(onTurnStart(ledger, `please look at ${first}`, 't3')).toBeNull()
    expect(onTurnStart(ledger, first.replace('id=w1', 'id=w11'), 't3')).toBeNull()
    expect(onTurnStart([{ ...judge, status: 'done' }], prompt, 't3')).toBeNull()
  })

  test('a turn that starts while the executor still awaits submit maps to the one entry with no id yet', () => {
    const pending = { ...judge, wakeId: undefined, turnId: undefined, summary: undefined }
    expect(onTurnStart([pending], first, 't1')).toEqual({ key: judge.key, status: 'running', wakeId: 'w1', turnId: 't1' })
    const twin = { ...pending, key: 'judge:sequence:551:head51' }
    expect(onTurnStart([pending, twin], first, 't1')).toBeNull()
  })

  test('an answer in the wake turn closes it; plan then acts on it', () => {
    const turn = onTurnComplete([judge], { turnId: 't1', reason: 'answer', answer: 'Checked.\n\nANSWER w1 merge\nreason: nothing else waits' }, REPO)
    expect(turn.prompts).toEqual([])
    expect(turn.problems).toEqual([])
    expect(turn.updates).toEqual([
      {
        key: judge.key,
        status: 'done',
        outcome: { kind: 'wake', decision: 'merge', reason: 'nothing else waits', instructions: null, bump: null, bumpReason: null, fields: {} },
        summary: 'answered merge: nothing else waits',
      },
    ])
  })

  test('no answer in the wake turn gets exactly one reminder, then the wake waits for its timeout', () => {
    const turn = onTurnComplete([judge], { turnId: 't1', reason: 'answer', answer: 'I think it can go out.' }, REPO)
    expect(turn.updates).toEqual([{ key: judge.key, status: 'running', reminded: true }])
    expect(turn.prompts.map(lines)).toEqual([[`${first} reminder=1`, WAKE_POINTER]])
    const reminded = apply([judge], turn.updates)
    // the reminder's own turn
    const started = onTurnStart(reminded, turn.prompts[0] ?? '', 't2')
    expect(started).toEqual({ key: judge.key, status: 'running', wakeId: 'w1', turnId: 't2' })
    const again = onTurnComplete(apply(reminded, started === null ? [] : [started]), { turnId: 't2', reason: 'answer', answer: 'Still thinking.' }, REPO)
    expect(again).toEqual({ updates: [], prompts: [], problems: ['JUDGE sequence w1: no answer after its reminder; it waits for its timeout'] })
  })

  test('the reminder says why an answer was refused', () => {
    const turn = onTurnComplete([judge], { turnId: 't1', reason: 'answer', answer: 'ANSWER w1 hold\n\nANSWER w0 merge' }, REPO)
    expect(turn.problems).toEqual(['ANSWER w1 hold: needs a reason', 'ANSWER w0 merge: no wake has this id'])
    expect(turn.prompts.map(lines)).toEqual([
      [`${first} reminder=1`, 'not accepted: ANSWER w1 hold: needs a reason', 'not accepted: ANSWER w0 merge: no wake has this id', WAKE_POINTER],
    ])
  })

  test('an interrupted or failed wake turn is reminded too (v2 SPEC 13.8.2: a turn that ends without an answer)', () => {
    for (const reason of ['aborted', 'error', 'refusal'] as const) {
      expect(onTurnComplete([judge], { turnId: 't1', reason, answer: '' }, REPO).updates).toEqual([{ key: judge.key, status: 'running', reminded: true }])
    }
  })

  test('an answer in any main-loop turn counts; an agent\'s turn never answers a wake', () => {
    const owner = onTurnComplete([judge], { turnId: 't9', reason: 'answer', answer: 'Done.\nANSWER w1 merge' }, REPO)
    expect(owner.updates.map(u => [u.key, u.status])).toEqual([[judge.key, 'done']])
    expect(owner.prompts).toEqual([])
    const agent = onTurnComplete([judge], { turnId: 't1', reason: 'answer', answer: 'ANSWER w1 merge', agentId: 'a1' }, REPO)
    expect(agent).toEqual({ updates: [], prompts: [], problems: [] })
    // the owner's chat turn ending without an answer is not the wake's: no reminder
    expect(onTurnComplete([judge], { turnId: 't9', reason: 'answer', answer: 'Here is the status.' }, REPO)).toEqual({ updates: [], prompts: [], problems: [] })
  })

  test('one answer per wake: a second block for the same id finds it closed', () => {
    const turn = onTurnComplete([judge], { turnId: 't1', reason: 'answer', answer: 'ANSWER w1 merge\n\nANSWER w1 hold\nreason: changed my mind' }, REPO)
    expect(turn.updates.map(u => answerOf(u)?.decision)).toEqual(['merge'])
    expect(turn.problems).toEqual(['ANSWER w1 hold: that wake is not open (done)'])
  })

  test('a task works like a judge: answered, or reminded once', () => {
    const task = open('task:run-it:60', 'task', 'run-it', 'w2', { issue: 60, summary: `TASK run-it id=w2 repo=${REPO} issue=60 pr=560`, turnId: 't5' })
    const done = onTurnComplete([task], { turnId: 't5', reason: 'answer', answer: 'ANSWER w2 done\nreason: ran the Run it steps, recorded the result, closed the issue' }, REPO)
    expect(done.updates.map(u => [u.status, answerOf(u)?.decision])).toEqual([['done', 'done']])
    const quiet = onTurnComplete([task], { turnId: 't5', reason: 'answer', answer: 'Working on it.' }, REPO)
    expect(quiet.prompts.map(lines)).toEqual([[`TASK run-it id=w2 repo=${REPO} issue=60 pr=560 reminder=1`, WAKE_POINTER]])
  })

  test('a tell is delivered when its turn says something; never reminded; an ANSWER cannot close it', () => {
    const tell = open('tell:decision:47:x', 'tell', 'decision', 'w3', { issue: 47, turnId: 't7' })
    const said = '[DECISION] Owner: pick SQLite or Postgres for the settings store ([#507](https://github.com/o/r/issues/507)).'
    expect(onTurnComplete([tell], { turnId: 't7', reason: 'answer', answer: said }, REPO)).toEqual({
      updates: [{ key: tell.key, status: 'done', summary: 'delivered' }],
      prompts: [],
      problems: [],
    })
    expect(onTurnComplete([tell], { turnId: 't7', reason: 'aborted', answer: '' }, REPO)).toEqual({
      updates: [],
      prompts: [],
      problems: ['TELL decision w3: its turn ended (aborted) with nothing said; it waits for its timeout'],
    })
    expect(onTurnComplete([tell], { turnId: 't8', reason: 'answer', answer: said }, REPO).updates).toEqual([])
    const answered = onTurnComplete([tell], { turnId: 't8', reason: 'answer', answer: 'ANSWER w3 done' }, REPO)
    expect(answered.problems).toEqual(['ANSWER w3 done: a TELL takes no answer'])
  })

  test('after a reload the reminder still repeats the first line, from the entry alone', () => {
    expect(reminderLine(judge, REPO)).toBe(`${first} reminder=1`)
    // an entry that lost its first line gets the head, the repo and its ids
    const bare = { ...judge, summary: 'something else' }
    expect(reminderLine(bare, REPO)).toBe(`JUDGE sequence id=w1 repo=${REPO} issue=50 pr=550 head=head50 reminder=1`)
  })
})

describe('timeouts: the fallback never acts (v2 SPEC 13.8.2, 13.10 item 8)', () => {
  const at = (minutesAgo: number) => NOW - minutesAgo * MIN

  test("a wake another session submitted, or a sessionless one open before this load, is lost at once with its attempt given back; this session's waits (v2 SPEC 13.7.5)", () => {
    const open = (key: string, kind: WakeKind, startedAt: number, session?: string) =>
      entry(key, kind, { wake: 'x', status: 'running', startedAt, endedAt: null, wakeId: key, ...(session === undefined ? {} : { session }) })
    const loadedAt = at(2)
    const ledger = [
      open('j', 'judge', at(1), 'old'),
      open('t', 'task', at(5), 'old'),
      open('l', 'tell', at(1), 'old'),
      // a reload within this session keeps its wake, however old
      open('mine', 'judge', at(5), 'now'),
      // rebuilt from the event log, or an older build: no session, so its start decides
      open('rebuilt', 'judge', at(13)),
      open('since-load', 'tell', at(1)),
      // an agent step carries its session too and is none of this filter's business (#657)
      entry('agent', 'agent-step', { status: 'running', startedAt: at(1), endedAt: null, session: 'old' }),
      entry('done', 'judge', { wake: 'x', status: 'done', startedAt: at(13), endedAt: at(12) }),
    ]
    const updates = orphanedWakes(ledger, 'now', loadedAt)
    expect(updates).toEqual([
      { key: 'j', status: 'lost', attempts: 0, summary: 'lost: its session ended' },
      { key: 't', status: 'lost', attempts: 0, summary: 'lost: its session ended' },
      { key: 'l', status: 'lost', attempts: 0, summary: 'lost: its session ended' },
      { key: 'rebuilt', status: 'lost', attempts: 0, summary: 'lost: it was open before this load' },
    ])
    // the rule that raised it may raise it again: gone from the ledger it holds no wake (O2), and its key is not used up
    let after: LedgerEntry[] = ledger
    for (const u of updates) after = finish(after, u.key, u, NOW)
    expect(after.find(e => e.key === 'rebuilt')).toMatchObject({ status: 'lost', attempts: 0, endedAt: NOW })
    expect(exhausted(after.find(e => e.key === 'rebuilt') as LedgerEntry, CFG)).toBe(false)
    // with no session id of its own, a recorded session cannot be judged: only the sessionless rule applies
    expect(orphanedWakes(ledger, '', loadedAt).map(u => u.key)).toEqual(['rebuilt'])
  })

  test('a judge past its timeout is done with hold; a task and a tell time out', () => {
    const ledger = [
      open('judge:sequence:550:head50', 'judge', 'sequence', 'w1', { startedAt: at(31) }),
      open('judge:cancelled:R:h', 'judge', 'cancelled', 'w2', { startedAt: at(29) }),
      open('task:run-it:60', 'task', 'run-it', 'w3', { startedAt: at(360) }),
      open('task:release:4:minor', 'task', 'release', 'w4', { startedAt: at(359) }),
      open('tell:decision:47:x', 'tell', 'decision', 'w5', { startedAt: at(30) }),
      entry('judge:handoff:x', 'judge', { wake: 'handoff', wakeId: 'w6', startedAt: at(90) }),
      entry('guard:550:head50:1', 'guard', { status: 'running', endedAt: null, startedAt: at(90) }),
    ]
    expect(expireWakes(ledger, NOW, CFG)).toEqual([
      {
        key: 'judge:sequence:550:head50',
        status: 'done',
        outcome: { kind: 'wake', decision: 'hold', reason: 'no answer within 30m, so the loop holds', instructions: null, bump: null, bumpReason: null, fields: {} },
        summary: 'timed out: no answer within 30m, so the loop holds',
      },
      { key: 'task:run-it:60', status: 'timed-out', summary: 'timed out: no answer within 6h' },
      { key: 'tell:decision:47:x', status: 'timed-out', summary: 'dropped: not delivered within 30m' },
    ])
  })

  test('the timeouts come from config.wakeTimeoutMs', () => {
    const quick = config({ wakeTimeoutMs: { judge: 5 * MIN, task: 90 * MIN, tell: 45_000 } })
    const ledger = [
      open('judge:a', 'judge', 'sequence', 'w1', { startedAt: at(6) }),
      open('task:b', 'task', 'redrive', 'w2', { startedAt: at(91) }),
      open('tell:c', 'tell', 'blind', 'w3', { startedAt: NOW - 50_000 }),
    ]
    expect(expireWakes(ledger, NOW, quick).map(u => u.summary)).toEqual([
      'timed out: no answer within 5m, so the loop holds',
      'timed out: no answer within 90m',
      'dropped: not delivered within 45s',
    ])
  })
})

describe('the answer tool (v2 SPEC 13.8.2, D-04)', () => {
  const ledger = [
    open('judge:sequence:550:head50', 'judge', 'sequence', 'w1', { issue: 50 }),
    open('judge:report:design:47:1000', 'judge', 'report', 'w4', { issue: 47 }),
  ]

  test('registered as mcp__factory-loop__answer with { id, decision, reason?, instructions?, fields? }', () => {
    expect(ANSWER_TOOL.name).toBe('answer')
    expect(ANSWER_TOOL.inputSchema).toMatchObject({ type: 'object', required: ['id', 'decision'] })
    expect(Object.keys((ANSWER_TOOL.inputSchema as { properties: object }).properties)).toEqual(['id', 'decision', 'reason', 'instructions', 'fields'])
    // the block is the primary channel: the tool waits behind ToolSearch
    expect(ANSWER_TOOL.isDeferred).toBe(true)
  })

  test('the same validation as the block; the text is what the model reads', () => {
    const ok = answerTool(ledger, { id: 'w1', decision: 'merge', reason: 'nothing else waits' }, REPO)
    expect(ok).toEqual({
      ok: true,
      text: 'Recorded: w1 merge. No ANSWER block is needed.',
      update: {
        key: 'judge:sequence:550:head50',
        status: 'done',
        outcome: { kind: 'wake', decision: 'merge', reason: 'nothing else waits', instructions: null, bump: null, bumpReason: null, fields: {} },
        summary: 'answered merge (tool): nothing else waits',
      },
    })
    expect(answerTool(ledger, { id: 'w1', decision: 'maybe' }, REPO)).toEqual({ ok: false, text: 'Not recorded: ANSWER w1 maybe: JUDGE sequence allows merge, hold.', update: null })
    const fields = { brief: brief(47), created: [], pendingDecision: false }
    expect(answerTool(ledger, { id: 'w4', decision: 'parsed', fields }, REPO).ok).toBe(true)
    expect(answerTool(ledger, { id: 'w4', decision: 'parsed', fields: JSON.stringify(fields) }, REPO).ok).toBe(true)
  })

  test('only the main conversation answers, with text values', () => {
    expect(answerTool(ledger, { id: 'w1', decision: 'merge' }, REPO, { agentId: 'a7' })).toEqual({ ok: false, text: 'Not recorded: only the main conversation answers a wake.', update: null })
    expect(answerTool(ledger, null, REPO).text).toBe('Not recorded: id and decision are required, as text.')
    expect(answerTool(ledger, { id: 1, decision: 'merge' }, REPO).text).toBe('Not recorded: id and decision are required, as text.')
    expect(answerTool(ledger, { id: 'w1', decision: 'hold', reason: 42 }, REPO).text).toBe('Not recorded: reason must be text.')
  })
})
