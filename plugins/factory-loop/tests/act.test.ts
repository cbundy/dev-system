// The act step (act.ts) and act mode end to end. The first half drives runActions with a fake
// ActIo: the ledger order (start, pre-check, executor, finish), what a skipped or rate-limited
// action leaves, a wake a hook closed before its submit returned, restart-self saved first. The
// second half runs one issue from claim to merge in the engine's test host, pass by pass, with
// canned CLIs standing for the factory and the test raising each agent's turn.complete and the
// main loop's answer to a judge wake.
import { describe, expect, test } from 'claude-code/testing'

import {
  EXECUTORS,
  REPAIR_GRACE_MS,
  actPass,
  commandOf,
  eventArgv,
  eventOf,
  logLoop,
  loggedOf,
  openWake,
  reconcilable,
  runActions,
  sendNotice,
  transition,
  updateDone,
} from '../hooks/act'
import { TOOL_LATE, wakeAnswered } from '../hooks/act-between'
import type { ActEnv, Between, Live } from '../hooks/act'
import { ACTION_KINDS } from '../hooks/config'
import { V2_ACTION_KINDS } from '../hooks/v2/types'
import type { ActIo, RunInit, RunResult } from '../hooks/exec'
import { finish } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, AgentStatus, LedgerEntry } from '../hooks/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, mine, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const RATE = 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)'

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
    env: { CALLUM_FLOW_REPO: REPO, CALLUM_FLOW_READY_LABEL: 'ready', CALLUM_FLOW_IN_DEV_LABEL: 'in development' },
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: config({ mode: 'act' }),
    configProblems: [],
  }
}

type Fake = {
  env: ActEnv
  calls: { argv: string[]; init: RunInit & { cwd: string; env: Record<string, string> } }[]
  saves: LedgerEntry[][]
  order: string[]
}

// fake: an act step's environment over a recording ActIo; `reply` answers each command.
function fake(ledger: LedgerEntry[], reply: (argv: string[]) => Partial<RunResult> = () => ({}), over: Partial<ActIo> = {}): Fake {
  const calls: Fake['calls'] = []
  const saves: LedgerEntry[][] = []
  const order: string[] = []
  const live: Live = { ledger }
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => {
      calls.push({ argv, init })
      order.push(argv[0] ?? '')
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    spawnAgent: async () => ({ agentId: 'agent-1' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: null, sevenDay: null }),
    readFile: async () => null,
    writeFile: async () => undefined,
    ...over,
  }
  const env: ActEnv = {
    io,
    rt: runtime(),
    live,
    commands: [],
    wakeId: () => 'w1',
    session: 'session-1',
    save: async () => {
      order.push('save')
      saves.push(live.ledger)
      return true
    },
    holds: async () => true,
    killed: async () => false,
    problems: [],
  }
  return { env, calls, saves, order }
}

const base = { reason: 'test', issue: 470 }
const claim: Action = { ...base, kind: 'claim', key: 'claim:470:new', class: 'start', rule: 'D1' }
const closer: Action = { ...base, kind: 'close-issue', key: 'close:470', class: 'free', rule: 'M7' }
const judge: Action = {
  ...base,
  kind: 'judge',
  wake: 'sequence',
  key: 'judge:sequence:512:abc1234',
  class: 'drive',
  rule: 'M5',
  fields: { pr: '512', issue: '470' },
  context: [],
}

describe('the dispatcher (v2 SPEC 13.6.1)', () => {
  test('every action kind has an executor', () => {
    expect(ACTION_KINDS.filter(kind => EXECUTORS[kind] === undefined)).toEqual([])
  })

  test('every action kind is one a module of the current loop produces: no kind of the v1 planner is left', () => {
    expect([...ACTION_KINDS].sort()).toEqual(
      [
        'heartbeat', 'sweep', 'claim', 'close-issue', 'delete-branch', 'release-parent', 'milestone-later', 'restart-self', 'rollout', 'stop-agent', 'judge', 'task', 'tell', 'title',
        ...V2_ACTION_KINDS,
      ].sort(),
    )
    for (const gone of ['spawn', 'delegate', 'respond', 'env-retry', 'guard', 'update-behind', 'fast-forward', 'update-checkout', 'fix-linkage', 'merge', 'abandon', 'milestone-expect', 'pr-reopen', 'pr-comment', 'pr-close', 'release-worktree']) {
      expect(ACTION_KINDS.includes(gone as never)).toBe(false)
      expect(EXECUTORS[gone as never]).toBeUndefined()
    }
  })

  test('commands run from the main checkout with the runtime environment; stdin passes through, empty too', async () => {
    const f = fake([])
    const cmd = commandOf(f.env.io, f.env.rt, f.env.commands)
    await cmd(['treehouse', 'return', '/slot'], { timeoutMs: 1000, stdin: '' })
    await cmd(['git', 'switch', 'b'], { timeoutMs: 1000, cwd: '/slot' })
    expect(f.calls[0]?.init).toEqual({ cwd: '/work', env: f.env.rt.env, timeoutMs: 1000, stdin: '' })
    expect(f.calls[1]?.init).toEqual({ cwd: '/slot', env: f.env.rt.env, timeoutMs: 1000 })
    expect(f.env.commands).toEqual(['treehouse return /slot', 'git switch b'])
  })

  test('an event is callum-flow-event with its type, data and issue; a failure throws with its exit code', async () => {
    expect(eventArgv('closed', { reason: 'completed' }, { issue: 470 })).toEqual(['callum-flow-event', '--type', 'closed', '--data', '{"reason":"completed"}', '--issue', '470'])
    const f = fake([], () => ({ exitCode: 2, stderr: 'callum-flow-event: unknown type' }))
    const event = eventOf(commandOf(f.env.io, f.env.rt, f.env.commands))
    const err = await event('nope', {}, { issue: 1 }).then(() => null, (e: unknown) => e as Error & { exitCode?: number })
    expect(err?.exitCode).toBe(2)
    expect(err?.message).toContain('unknown type')
    expect(f.env.commands.at(-1)).toContain('--type nope --data {} --issue 1')
  })
})

describe('runActions: the ledger around each executor (v2 SPEC 13.7)', () => {
  test('a split child\'s claim carries its park into the outcome; a lost claim (exit 3) stays lost and carries none', async () => {
    const park = { question: 'Which API shape?', parent: 300 }
    const f = fake([])
    const report = await runActions(f.env, state(), [{ ...claim, park }])
    expect(report.outcomes).toEqual([expect.objectContaining({ kind: 'claim', status: 'done', summary: 'claimed #470 to park it on its open decision' })])
    expect(f.env.live.ledger).toMatchObject([{ status: 'done', outcome: { kind: 'claim', result: 'claimed', park } }])
    const lost = fake([], () => ({ exitCode: 3, stderr: 'callum-flow-claim: held by another device' }))
    await runActions(lost.env, state(), [{ ...claim, park }])
    const outcome = lost.env.live.ledger[0]?.outcome
    expect(outcome).toEqual({ kind: 'claim', result: 'lost' })
  })

  test('start, executor, finish: a claim is done in the ledger, saved, with its outcome', async () => {
    const f = fake([])
    const report = await runActions(f.env, state(), [claim])
    expect(report.outcomes).toEqual([{ key: 'claim:470:new', kind: 'claim', status: 'done', ms: 0, summary: 'claimed #470 again', at: NOW }])
    expect(f.env.live.ledger).toMatchObject([{ key: 'claim:470:new', status: 'done', attempts: 1, outcome: { kind: 'claim', result: 'claimed' } }])
    // saved running before the claim ran, then done
    expect(f.order).toEqual(['save', 'callum-flow-claim', 'save'])
    expect(f.saves.map(l => l.map(e => e.status))).toEqual([['running'], ['done']])
  })

  test('a usage pre-check refusal drops a new entry and puts a retried one back as it stood (v2 SPEC 13.10 item 7)', async () => {
    const prior = entry('claim:470:new', 'claim', { status: 'failed', attempts: 1, endedAt: NOW - 10 * MIN })
    const f = fake([prior], () => ({}), { usage: async () => ({ fiveHour: 96, sevenDay: 10 }) })
    const report = await runActions(f.env, state(), [claim, judge])
    expect(report.outcomes.map(o => [o.key, o.status])).toEqual([
      ['claim:470:new', 'skipped'],
      [judge.key, 'skipped'],
    ])
    expect(report.outcomes[0]?.summary).toContain('usage: tier stop-all forbids start')
    expect(f.env.live.ledger).toEqual([prior])
    expect(f.calls).toEqual([])
  })

  test('a GitHub rate limit holds the pass\'s later GitHub writes, not its agents (v2 SPEC 13.10 item 2)', async () => {
    const f = fake([], argv => (argv.includes('callum-flow-claim') ? { exitCode: 1, stderr: RATE } : {}))
    const report = await runActions(f.env, state(), [claim, closer, judge])
    expect(report.rateLimited).toBe(true)
    expect(report.outcomes.map(o => [o.key, o.status])).toEqual([
      ['claim:470:new', 'failed'],
      ['close:470', 'skipped'],
      [judge.key, 'running'],
    ])
    expect(f.env.live.ledger.map(e => e.key)).toEqual(['claim:470:new', judge.key])
  })

  test('once the act lock is no longer this session\'s, the pass runs nothing more (v2 SPEC 13.11.2)', async () => {
    const f = fake([])
    let saves = 0
    f.env.save = async () => {
      saves += 1
      return true
    }
    f.env.holds = async () => saves === 0
    const report = await runActions(f.env, state(), [claim, closer])
    expect(report.outcomes.map(o => [o.key, o.status])).toEqual([
      ['claim:470:new', 'done'],
      ['close:470', 'skipped'],
    ])
    expect(f.calls.map(c => c.argv[0])).toEqual(['callum-flow-claim'])
  })

  test('the kill switch set mid-pass skips every action not yet started; the running one finishes (v2 SPEC 13.11.3)', async () => {
    let off = false
    let checks = 0
    // the switch is created while the claim runs
    const f = fake([], argv => {
      if (argv.includes('callum-flow-claim')) off = true
      return {}
    })
    f.env.killed = async () => {
      checks += 1
      return off
    }
    const title: Action = { kind: 'title', key: 'title', class: 'free', rule: 'O1', reason: 'status changed', issue: null, text: 'x' }
    const report = await runActions(f.env, state(), [claim, closer, judge, title])
    expect(report.outcomes.map(o => [o.key, o.status, o.summary])).toEqual([
      ['claim:470:new', 'done', 'claimed #470 again'],
      ['close:470', 'skipped', 'kill switch'],
      [judge.key, 'skipped', 'kill switch'],
      ['title', 'skipped', 'kill switch'],
    ])
    expect(report.killed).toBe(true)
    expect(report.title).toBeNull()
    // one check per action until the switch is seen, then the pass ends
    expect(checks).toBe(2)
    expect(f.calls.map(c => c.argv[0])).toEqual(['callum-flow-claim'])
    expect(f.env.live.ledger.map(e => [e.key, e.status])).toEqual([['claim:470:new', 'done']])
  })

  test('a notice from outside plan waits while the kill switch is set (v2 SPEC 13.11.3)', async () => {
    const f = fake([])
    f.env.killed = async () => true
    const tell: Action = { kind: 'tell', wake: 'pass-error', key: 'tell:pass-error:1', class: 'owner', rule: 'O2', reason: 'tell', issue: null, fields: {}, context: [] }
    expect(await sendNotice(f.env, state(), tell)).toBe('waiting')
    expect(f.calls).toEqual([])
    expect(f.env.live.ledger).toEqual([])
  })

  test('a wake its own turn answered before the submit returned stays answered (wake.ts onTurnStart)', async () => {
    let f: Fake
    f = fake([], () => ({}), {
      submit: async () => {
        // the turn started and ended inside the submit: the hooks closed the entry
        const answered = { status: 'done' as const, summary: 'answered merge' }
        f.env.live.ledger = finish(f.env.live.ledger, judge.key, answered, NOW)
      },
    })
    await runActions(f.env, state(), [judge])
    expect(f.env.live.ledger).toMatchObject([{ key: judge.key, status: 'done', summary: 'answered merge' }])
  })

  test('restart-self saves the ledger, with its entry running, before the restart runs (v2 SPEC 13.7.5)', async () => {
    const restart: Action = { kind: 'restart-self', key: 'restart:1', class: 'free', rule: 'H4', reason: 'update', issue: null, why: 'image', at: 1 }
    const f = fake([])
    await runActions(f.env, state(), [restart])
    expect(f.order).toEqual(['save', 'dev-restart-self', 'save'])
    expect(f.saves[0]).toMatchObject([{ key: 'restart:1', status: 'running' }])
  })

  test('an executor that throws is a failed attempt, its entry finished, and the pass goes on', async () => {
    const real = EXECUTORS.sweep
    const sweep: Action = { ...base, kind: 'sweep', key: 'sweep:0', class: 'free', rule: 'H2', issue: null }
    EXECUTORS.sweep = async () => {
      throw new Error('boom')
    }
    try {
      const f = fake([])
      const report = await runActions(f.env, state(), [sweep, closer])
      expect(report.outcomes.map(o => [o.key, o.status, o.summary])).toEqual([
        ['sweep:0', 'failed', 'sweep: the executor threw: boom'],
        ['close:470', 'done', expect.any(String)],
      ])
      expect(f.env.live.ledger.find(e => e.key === 'sweep:0')).toMatchObject({ status: 'failed', attempts: 1, endedAt: NOW })
    } finally {
      EXECUTORS.sweep = real
    }
  })

  test('an attempt a hook replaced while its executor ran is left as the hook left it', async () => {
    let f: Fake
    const replaced = { ...entry(claim.key, 'claim', { class: 'start', issue: 470, status: 'running', attempts: 2, startedAt: NOW + 1, endedAt: null }) }
    f = fake([], argv => {
      // a later attempt took the key meanwhile
      if (argv.includes('callum-flow-claim')) f.env.live.ledger = [replaced]
      return {}
    })
    await runActions(f.env, state(), [claim])
    expect(f.env.live.ledger).toEqual([replaced])
  })

  test('the title runs without a ledger entry and says what it set', async () => {
    const renamed: string[] = []
    const f = fake([], () => ({}), { rename: async t => void renamed.push(t) })
    const title: Action = { kind: 'title', key: 'title', class: 'free', rule: 'O1', reason: 'status changed', issue: null, text: '🔄 dev-system (Q:0 - D:0 - M:0)' }
    const report = await runActions(f.env, state(), [title])
    expect(report.title).toBe('🔄 dev-system (Q:0 - D:0 - M:0)')
    expect(renamed).toEqual(['🔄 dev-system (Q:0 - D:0 - M:0)'])
    expect(f.env.live.ledger).toEqual([])
  })
})

describe('notices from outside plan, rate-cap holds, reconciling, the update', () => {
  const tell = (key: string): Action => ({ kind: 'tell', wake: 'heartbeat-other', key, class: 'owner', rule: 'O2', reason: 'tell', issue: null, fields: { device: 'other' }, context: [] })

  test('a notice waits while a wake is open, goes out once, and is never sent twice', async () => {
    const open = entry('judge:sequence:512:abc1234', 'judge', { status: 'running', endedAt: null, wakeId: 'w0' })
    const prompts: string[] = []
    const f = fake([open], () => ({}), { submit: async p => void prompts.push(p) })
    expect(openWake(f.env.live.ledger)?.key).toBe(open.key)
    expect(await sendNotice(f.env, state(), tell('tell:heartbeat-other:1'))).toBe('waiting')
    f.env.live.ledger = []
    expect(await sendNotice(f.env, state(), tell('tell:heartbeat-other:1'))).toBe('sent')
    expect(await sendNotice(f.env, state(), tell('tell:heartbeat-other:1'))).toBe('sent')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toStartWith('TELL heartbeat-other id=w1 repo=cbundy/dev-system device=other')
  })

  test('an answer in flight counts as running; a first completed sighting waits one pass', () => {
    const seen = new Map<string, number>()
    const listed = [
      { id: 'a', status: 'completed' as const },
      { id: 'b', status: 'running' as const },
    ]
    expect(reconcilable(listed, new Set(['c']), seen, NOW, new Map())).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'running' },
    ])
    expect(reconcilable(listed, new Set(), seen, NOW + MIN, new Map())).toEqual(listed)
    expect(reconcilable([], new Set(), seen, NOW + 2 * MIN, new Map())).toEqual([])
    expect(seen.size).toBe(0)
  })

  test('an agent listed idle has ended its turn, as one listed completed: a first sighting waits one pass, and idle then completed is one sighting (#560)', () => {
    const seen = new Map<string, number>()
    const idle = [{ id: 'a', status: 'idle' as const }]
    expect(reconcilable(idle, new Set(), seen, NOW, new Map())).toEqual([{ id: 'a', status: 'running' }])
    expect(reconcilable(idle, new Set(), seen, NOW + MIN, new Map())).toEqual(idle)
    // listed idle, then completed: the second pass judges it, it is not counted afresh
    const twice = new Map<string, number>()
    expect(reconcilable(idle, new Set(), twice, NOW, new Map())).toEqual([{ id: 'a', status: 'running' }])
    expect(reconcilable([{ id: 'a', status: 'completed' }], new Set(), twice, NOW + 5_000, new Map())).toEqual([{ id: 'a', status: 'completed' }])
    // an answer in flight, or a repair message within REPAIR_GRACE_MS, counts as running though idle
    expect(reconcilable(idle, new Set(['a']), new Map(), NOW, new Map())).toEqual([{ id: 'a', status: 'running' }])
    const repairing = new Map([['a', NOW - MIN]])
    const after = new Map([['a', NOW - 2 * MIN]])
    expect(reconcilable(idle, new Set(), after, NOW, repairing)).toEqual([{ id: 'a', status: 'running' }])
    expect(reconcilable(idle, new Set(), after, NOW + REPAIR_GRACE_MS, repairing)).toEqual(idle)
    expect(repairing.size).toBe(0)
    // waiting (background work it holds) and running are at work still
    expect(reconcilable([{ id: 'b', status: 'waiting' }], new Set(), new Map(), NOW, new Map())).toEqual([{ id: 'b', status: 'waiting' }])
  })

  test('an update is done once the workspace came back from its restart, never when it failed (rule H4, D-15)', () => {
    const due = control({ updateDue: { reason: 'image', at: 7 } })
    const restart = (status: LedgerEntry['status'], endedAt: number | null = NOW - MIN) => [entry('restart:7', 'restart-self', { status, endedAt })]
    // lost: the session restarted under it; done before this module loaded: it came back
    expect(updateDone(restart('lost'), due, NOW)).toBe(true)
    expect(updateDone(restart('done'), due, NOW)).toBe(true)
    // done in this module's life: Coder took the build, but the container is not replaced yet
    expect(updateDone(restart('done', NOW + MIN), due, NOW)).toBe(false)
    expect(updateDone(restart('failed'), due, NOW)).toBe(false)
    expect(updateDone(restart('running', null), due, NOW)).toBe(false)
    expect(updateDone([], due, NOW)).toBe(false)
    expect(updateDone(restart('lost'), control(), NOW)).toBe(false)
  })

  test('an agent whose turn ended with no answer the loop could take is lost on the second pass that lists it idle, as completed, not at its A1 timeout (#560)', async () => {
    const gate = entry('step:review:60:1', 'agent-step', { class: 'drive', issue: 60, run: 'R60', status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' })
    const f = fake([gate])
    const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map(), gateHeld: new Map() }
    const s = state({ issues: [mine(60, 'in pipeline', { stageSince: 1 })], ledger: [] })
    const listed = { ok: true, agents: [{ id: 'agent-1', status: 'idle' as AgentStatus }] }
    await actPass(f.env, { ...s, now: NOW }, listed, between)
    expect(f.env.live.ledger.find(e => e.key === gate.key)?.status).toBe('running')
    await actPass(f.env, { ...s, now: NOW + 6_000 }, listed, between)
    expect(f.env.live.ledger.find(e => e.key === gate.key)).toMatchObject({ status: 'lost', summary: 'lost: idle with no answer' })
  })

  test('an agent sent its repair message stays at work while still listed idle or completed, for REPAIR_GRACE_MS, since its resume may show late; then it is lost as before (#548, #560)', async () => {
    for (const status of ['idle', 'completed'] as const) {
      const gate = entry('step:review:60:1', 'agent-step', { class: 'drive', issue: 60, run: 'R60', status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1', reminded: true })
      const f = fake([gate])
      // agentAnswered marks the repair this way when its message went out
      const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map([['agent-1', NOW]]), gateHeld: new Map() }
      const s = state({ issues: [mine(60, 'in pipeline', { stageSince: 1 })], ledger: [] })
      const listed = { ok: true, agents: [{ id: 'agent-1', status: status as AgentStatus }] }
      const at = () => f.env.live.ledger.find(e => e.key === gate.key)?.status
      // passes seconds apart, the agent still listed: it is not lost
      for (const t of [NOW + 1_000, NOW + 6_000, NOW + REPAIR_GRACE_MS]) {
        await actPass(f.env, { ...s, now: t }, listed, between)
        expect([status, t - NOW, at()]).toEqual([status, t - NOW, 'running'])
      }
      // never resumed: past the grace it gets the usual one pass, then it is lost
      await actPass(f.env, { ...s, now: NOW + REPAIR_GRACE_MS + 6_000 }, listed, between)
      expect(at()).toBe('running')
      await actPass(f.env, { ...s, now: NOW + REPAIR_GRACE_MS + 12_000 }, listed, between)
      expect(at()).toBe('lost')
      expect(between.repairing.size).toBe(0)
    }
  })

  test('a wake answer claimed too late changes nothing; in time it is recorded in memory at once (#558)', async () => {
    const wake = entry('judge:sequence:512:abc1234', 'judge', { wake: 'sequence', class: 'drive', issue: 60, pr: 512, status: 'running', startedAt: NOW - MIN, endedAt: null, wakeId: 'w9' })
    const f = fake([wake])
    const late = () => false
    expect(await wakeAnswered(f.env, { id: 'w9', decision: 'merge' }, undefined, late)).toEqual({ ok: false, text: TOOL_LATE, moved: [] })
    expect(f.env.live.ledger).toEqual([wake])
    expect(f.calls).toEqual([])
    const r = await wakeAnswered(f.env, { id: 'w9', decision: 'merge' }, undefined)
    expect(r).toMatchObject({ ok: true, moved: [expect.objectContaining({ key: wake.key, status: 'done' })] })
    expect(f.saves).toEqual([])
  })

  test('transition reports exactly the entries it changed', () => {
    const a = entry('a', 'claim')
    const b = entry('b', 'claim')
    const live: Live = { ledger: [a, b] }
    const moved = transition(live, l => l.map(e => (e.key === 'b' ? { ...e, status: 'failed' as const } : e)))
    expect(moved.map(e => e.key)).toEqual(['b'])
    expect(live.ledger[0]).toBe(a)
  })

  test('a loop event is logged once per change of what it says; a loaded entry counts as logged, a dropped key is forgotten (#536)', async () => {
    const open = entry('tell:runaway:start:1', 'tell', { wake: 'runaway', class: 'owner', status: 'running', endedAt: null, wakeId: 'w0' })
    const f = fake([open])
    f.env.live.logged = loggedOf([open])
    const statuses = () => f.calls.map(c => (JSON.parse(c.argv[4] ?? '{}') as { status?: string }).status)
    // its turn taking its id, then its reminder: the event would say the same, so none is logged
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'running', turnId: 't1' }, NOW)))
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'running', reminded: true }, NOW)))
    expect(statuses()).toEqual([])
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'done', summary: 'answered' }, NOW)))
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'done', summary: 'answered' }, NOW)))
    expect(statuses()).toEqual(['done'])
    // a changed PR or head is not in the native data, so it logs nothing
    await logLoop(f.env, transition(f.env.live, l => l.map(e => (e.key === open.key ? { ...e, pr: 777, head: 'beef123' } : e))))
    expect(statuses()).toEqual(['done'])
    f.env.live.ledger = []
    await logLoop(f.env, [])
    expect(f.env.live.logged?.size).toBe(0)
  })
})

describe('an agent step\'s tokens in its loop event (#657)', () => {
  const step = (status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}) =>
    entry('i9/ltn0brb/review/abc/r1/a1', 'agent-step', { status, issue: 9, step: 'review', agentId: 'ag1', session: 'session-1', endedAt: status === 'running' ? null : NOW, ...over })
  const transcript = JSON.stringify({ type: 'assistant', requestId: 'r', message: { model: 'claude-opus-5-5', usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 6, cache_creation_input_tokens: 7 } } })
  const dataOf = (f: Fake) => f.calls.filter(c => c.argv[0] === 'callum-flow-event').map(c => JSON.parse(c.argv[4] ?? '{}') as Record<string, unknown>)
  const withTokens = (ledger: LedgerEntry[], files: Record<string, string> = {}) => {
    const f = fake(ledger, () => ({}), { readFile: async p => files[p] ?? null })
    f.env.rt = { ...f.env.rt, configDir: '/cfg', sessionCwd: '/work' }
    return f
  }
  const PATH = '/cfg/projects/-work/session-1/subagents/agent-ag1.jsonl'

  test('a running event has null fields; each ended status carries the reading, read once per ended entry', async () => {
    for (const status of ['done', 'failed', 'timed-out', 'lost'] as const) {
      const f = withTokens([step('running')], { [PATH]: transcript })
      await logLoop(f.env, f.env.live.ledger)
      const ended = transition(f.env.live, l => l.map(e => ({ ...e, status, endedAt: NOW })))
      await logLoop(f.env, ended)
      await logLoop(f.env, ended)
      const [running, end] = dataOf(f)
      expect(dataOf(f)).toHaveLength(2)
      expect(running).toMatchObject({ status: 'running', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, model: null })
      expect(end).toMatchObject({ status, input_tokens: 4, output_tokens: 5, cache_read_tokens: 6, cache_creation_tokens: 7, model: 'claude-opus-5-5' })
      expect(f.env.problems).toEqual([])
    }
  })

  test('a missing transcript still writes the event, with null fields and a problem naming the key', async () => {
    const f = withTokens([step('failed')])
    await logLoop(f.env, f.env.live.ledger)
    expect(dataOf(f)).toHaveLength(1)
    expect(dataOf(f)[0]).toMatchObject({ status: 'failed', input_tokens: null, model: null })
    expect(f.env.problems).toEqual(['loop event i9/ltn0brb/review/abc/r1/a1: transcript not found'])
  })

  test('a tell carries none of the fields, and a runtime without a config dir reads nothing', async () => {
    const f = withTokens([entry('tell:x:1', 'tell', { wake: 'runaway', class: 'owner', wakeId: 'w0' })])
    await logLoop(f.env, f.env.live.ledger)
    expect(Object.keys(dataOf(f)[0] ?? {})).not.toContain('input_tokens')
    const g = fake([step('done')])
    await logLoop(g.env, g.env.live.ledger)
    expect(dataOf(g)[0]).toMatchObject({ input_tokens: null, model: null })
    expect(g.env.problems).toEqual([])
  })
})

