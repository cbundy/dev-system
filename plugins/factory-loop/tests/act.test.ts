// The act step (act.ts) and act mode end to end. The first half drives runActions with a fake
// ActIo: the ledger order (start, pre-check, executor, finish), what a skipped or rate-limited
// action leaves, a wake a hook closed before its submit returned, restart-self saved first. The
// second half runs one issue from claim to merge in the engine's test host, pass by pass, with
// canned CLIs standing for the factory and the test raising each agent's turn.complete and the
// main loop's answer to a judge wake.
import { describe, expect, test } from 'claude-code/testing'

import {
  EXECUTORS,
  GITHUB_KINDS,
  actPass,
  agentAnswered,
  capEventArgv,
  capKey,
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
  wakeEnded,
  wakeStarted,
} from '../hooks/act'
import type { ActEnv, Acted, Between, Live } from '../hooks/act'
import { ACTION_KINDS } from '../hooks/config'
import type { ActIo, RunInit, RunResult, SpawnInput } from '../hooks/exec'
import { finish } from '../hooks/ledger'
import { emptyCache, observe } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import type { Action, AgentStatus, LedgerEntry } from '../hooks/types'
import { DEVICE, MIN, NOW, config, control, entry, mine, state } from './fixtures'
import { LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, iso } from './host'
import type { Seen } from './host'

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
    config: config(),
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
    problems: [],
  }
  return { env, calls, saves, order }
}

const base = { reason: 'test', issue: 470 }
const claim: Action = { ...base, kind: 'claim', key: 'claim:470:new', class: 'start', rule: 'D1' }
const guard: Action = { ...base, kind: 'guard', key: 'guard:512:abc1234:1', class: 'free', rule: 'M1', pr: 512, run: '01RUN', head: 'abc1234' }
const designer: Action = { ...base, kind: 'spawn', agent: 'designer', key: 'design:470:1', class: 'develop', rule: 'D2', model: null, notes: [] }
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

describe('the dispatcher (SPEC 6.1)', () => {
  test('every action kind has an executor', () => {
    expect(ACTION_KINDS.filter(kind => EXECUTORS[kind] === undefined)).toEqual([])
  })

  test('GITHUB_KINDS are action kinds', () => {
    expect(GITHUB_KINDS.filter(kind => !ACTION_KINDS.includes(kind))).toEqual([])
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

  test('an event is callum-flow-event with its fields as flags; a failure throws with its exit code', async () => {
    expect(eventArgv('delegated', { issue: 470, note: 'brief u' })).toEqual(['callum-flow-event', 'delegated', '--issue', '470', '--note', 'brief u'])
    expect(eventArgv('verdict', { issue: 470, run: 'R', branch: 'b', pr: 5, head: 'h', note: 'n' })).toEqual([
      'callum-flow-event', 'verdict', '--issue', '470', '--run', 'R', '--branch', 'b', '--pr', '5', '--head', 'h', '--note', 'n',
    ])
    const f = fake([], () => ({ exitCode: 2, stderr: 'callum-flow-event: unknown state' }))
    const event = eventOf(commandOf(f.env.io, f.env.rt, f.env.commands))
    const err = await event('nope', {}).then(() => null, (e: unknown) => e as Error & { exitCode?: number })
    expect(err?.exitCode).toBe(2)
    expect(err?.message).toContain('unknown state')
  })
})

describe('runActions: the ledger around each executor (SPEC 7)', () => {
  test('start, executor, finish: a claim is done in the ledger, saved, with its outcome', async () => {
    const f = fake([])
    const report = await runActions(f.env, state(), [claim])
    expect(report.outcomes).toEqual([{ key: 'claim:470:new', kind: 'claim', status: 'done', ms: 0, summary: 'claimed #470' }])
    expect(f.env.live.ledger).toMatchObject([{ key: 'claim:470:new', status: 'done', attempts: 1, outcome: { kind: 'claim', result: 'claimed' } }])
    // saved running before the claim ran, then done
    expect(f.order).toEqual(['save', 'callum-flow-claim', 'save'])
    expect(f.saves.map(l => l.map(e => e.status))).toEqual([['running'], ['done']])
  })

  test('a usage pre-check refusal drops a new entry and puts a retried one back as it stood (SPEC 10.7)', async () => {
    const prior = entry('claim:470:new', 'claim', { status: 'failed', attempts: 1, endedAt: NOW - 10 * MIN })
    const f = fake([prior], () => ({}), { usage: async () => ({ fiveHour: 96, sevenDay: 10 }) })
    const report = await runActions(f.env, state(), [claim, designer])
    expect(report.outcomes.map(o => [o.key, o.status])).toEqual([
      ['claim:470:new', 'skipped'],
      ['design:470:1', 'skipped'],
    ])
    expect(report.outcomes[0]?.summary).toContain('usage: tier stop-all forbids start')
    expect(f.env.live.ledger).toEqual([prior])
    expect(f.calls).toEqual([])
  })

  test('a GitHub rate limit holds the pass\'s later GitHub writes, not its agents (SPEC 10.2)', async () => {
    const f = fake([], argv => (argv[0] === 'callum-flow-claim' ? { exitCode: 1, stderr: RATE } : {}))
    const report = await runActions(f.env, state(), [claim, guard, designer])
    expect(report.rateLimited).toBe(true)
    expect(report.outcomes.map(o => [o.key, o.status])).toEqual([
      ['claim:470:new', 'failed'],
      ['guard:512:abc1234:1', 'skipped'],
      ['design:470:1', 'running'],
    ])
    expect(f.env.live.ledger.map(e => e.key)).toEqual(['claim:470:new', 'design:470:1'])
  })

  test('once the act lock is no longer this session\'s, the pass runs nothing more (SPEC 11.2)', async () => {
    const f = fake([])
    let saves = 0
    f.env.save = async () => {
      saves += 1
      return true
    }
    f.env.holds = async () => saves === 0
    const report = await runActions(f.env, state(), [claim, guard])
    expect(report.outcomes.map(o => [o.key, o.status])).toEqual([
      ['claim:470:new', 'done'],
      ['guard:512:abc1234:1', 'skipped'],
    ])
    expect(f.calls.map(c => c.argv[0])).toEqual(['callum-flow-claim'])
  })

  test('a spawn runs on with its agent id, and its loop event is logged once', async () => {
    const f = fake([])
    await runActions(f.env, state(), [designer])
    expect(f.env.live.ledger).toMatchObject([{ key: 'design:470:1', status: 'running', agentId: 'agent-1', attempts: 1 }])
    const loops = f.calls.filter(c => c.argv[0] === 'callum-flow-event')
    expect(loops).toHaveLength(1)
    expect(loops[0]?.argv.at(-1)).toContain('kind=spawn key=design:470:1 status=running')
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

  test('restart-self saves the ledger, with its entry running, before the restart runs (SPEC 7.5)', async () => {
    const restart: Action = { kind: 'restart-self', key: 'restart:1', class: 'free', rule: 'H4', reason: 'update', issue: null, why: 'image', at: 1 }
    const f = fake([])
    await runActions(f.env, state(), [restart])
    expect(f.order).toEqual(['save', 'dev-restart-self', 'save'])
    expect(f.saves[0]).toMatchObject([{ key: 'restart:1', status: 'running' }])
  })

  test('an executor that throws is a failed attempt, its entry finished, and the pass goes on', async () => {
    const real = EXECUTORS.claim
    EXECUTORS.claim = async () => {
      throw new Error('boom')
    }
    try {
      const f = fake([])
      const report = await runActions(f.env, state(), [claim, guard])
      expect(report.outcomes.map(o => [o.key, o.status, o.summary])).toEqual([
        ['claim:470:new', 'failed', 'claim: the executor threw: boom'],
        ['guard:512:abc1234:1', 'done', expect.any(String)],
      ])
      expect(f.env.live.ledger.find(e => e.key === claim.key)).toMatchObject({ status: 'failed', attempts: 1, endedAt: NOW })
    } finally {
      EXECUTORS.claim = real
    }
  })

  test('an attempt a hook replaced while its executor ran is left as the hook left it', async () => {
    let f: Fake
    const replaced = { ...entry(claim.key, 'claim', { class: 'start', issue: 470, status: 'running', attempts: 2, startedAt: NOW + 1, endedAt: null }) }
    f = fake([], argv => {
      // a later attempt took the key meanwhile
      if (argv[0] === 'callum-flow-claim') f.env.live.ledger = [replaced]
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

  test('a rate-cap hold is one loop event per cap per hour, status held (SPEC 11.4)', () => {
    expect(capKey('spawn', NOW)).toBe(`cap:spawn:${Math.floor(NOW / 3_600_000)}`)
    expect(capEventArgv('spawn', NOW)).toEqual(['callum-flow-event', 'loop', '--note', `kind=spawn key=${capKey('spawn', NOW)} status=held`])
    expect(capEventArgv('claim:470', NOW)).toEqual([
      'callum-flow-event', 'loop', '--issue', '470', '--note', `kind=claim key=${capKey('claim:470', NOW)} status=held`,
    ])
  })

  test('an answer in flight counts as running; a first completed sighting waits one pass', () => {
    const seen = new Map<string, number>()
    const listed = [
      { id: 'a', status: 'completed' as const },
      { id: 'b', status: 'running' as const },
    ]
    expect(reconcilable(listed, new Set(['c']), seen, NOW)).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'running' },
    ])
    expect(reconcilable(listed, new Set(), seen, NOW + MIN)).toEqual(listed)
    expect(reconcilable([], new Set(), seen, NOW + 2 * MIN)).toEqual([])
    expect(seen.size).toBe(0)
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

  test('an answer in flight is never marked lost by a pass in between, and one an A1 stop timed out meanwhile is dropped (SPEC 10.4)', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    const spawned: SpawnInput[] = []
    const designer = entry('design:60:1', 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' })
    // the answer file's write waits on the test: the answer is being handled
    const f = fake([designer], () => ({}), { writeFile: async () => held, spawnAgent: async input => (spawned.push(input), { agentId: 'agent-2' }) })
    const between: Between = { answering: new Set(), completedSeen: new Map() }
    const s = state({ issues: [mine(60, 'designing', { stageSince: 1 })], ledger: [] })
    const answering = agentAnswered(f.env, s, { agentId: 'agent-1', answer: 'RESULT brief=none created=none pending_decision=no', reason: 'answer' }, between)
    // two passes meanwhile, the agent listed completed: neither marks it lost, nor spawns again
    const listed = { ok: true, agents: [{ id: 'agent-1', status: 'completed' as AgentStatus }] }
    for (const now of [NOW, NOW + MIN, NOW + 2 * MIN]) await actPass(f.env, { ...s, now }, listed, between)
    expect(f.env.live.ledger.find(e => e.key === designer.key)).toMatchObject({ status: 'running', agentId: 'agent-1' })
    expect(spawned).toEqual([])
    // an A1 stop times the agent out before its answer is read: the answer is dropped, not applied
    f.env.live.ledger = finish(f.env.live.ledger, designer.key, { status: 'timed-out', summary: 'timed out: stopped' }, NOW + 3 * MIN)
    release()
    expect(await answering).toEqual({ result: 'dropped', why: `answer for ${designer.key} came after the entry ended` })
    expect(f.env.live.ledger.find(e => e.key === designer.key)).toMatchObject({ status: 'timed-out', summary: 'timed out: stopped' })
    expect(between.answering.size).toBe(0)
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
    const open = entry('judge:sequence:512:abc1234', 'judge', { wake: 'sequence', status: 'running', endedAt: null, wakeId: 'w0' })
    const f = fake([open])
    f.env.live.logged = loggedOf([open])
    const statuses = () => f.calls.map(c => /status=(\S+)/.exec(c.argv.at(-1) ?? '')?.[1])
    // its turn taking its id, then its reminder: the event would say the same, so none is logged
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'running', turnId: 't1' }, NOW)))
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'running', reminded: true }, NOW)))
    expect(statuses()).toEqual([])
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'done', summary: 'answered' }, NOW)))
    await logLoop(f.env, transition(f.env.live, l => finish(l, open.key, { status: 'done', summary: 'answered' }, NOW)))
    expect(statuses()).toEqual(['done'])
    f.env.live.ledger = []
    await logLoop(f.env, [])
    expect(f.env.live.logged?.size).toBe(0)
  })
})

// --- one issue from claim to merge, in the engine's test host ------------------------------------

const RUN = `01K7S1${'A'.repeat(20)}`
const HEAD = 'abc1234'
const BRANCH = 'issue-470-loop'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-9001'
const SLOT = '/workspaces/dev-system/.treehouse/dev-system-22f535/2/dev-system'
const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
const ISSUE_470 = JSON.stringify({
  issue: {
    number: 470,
    title: 'The loop acts',
    state: 'open',
    labels: [{ name: 'ready' }],
    issue_dependencies_summary: { blocked_by: 0 },
    sub_issues_summary: { total: 0 },
  },
  stripped: 0,
})

// world: the factory one issue walks through, answered as the real CLIs answer
function world(now: () => number) {
  const w = {
    stage: null as string | null,
    since: 0,
    run: null as string | null,
    pr: null as number | null,
    slotBranch: null as string | null,
    watch: '',
    queue: [470],
  }
  const run = (argv: string[], s: Seen) => {
    const [cmd, ...args] = argv
    switch (cmd) {
      case 'callum-flow-factory-state': {
        const issue = { issue: 470, stage: w.stage, entered_at: iso(w.since), holder: DEVICE, run: w.run, pr: w.pr, stuck: null, github: null }
        if (w.stage === null) return { stdout: factoryDoc([], [], now()) }
        return { stdout: w.stage === 'merged' ? factoryDoc([], [issue], now()) : factoryDoc([issue], [], now()) }
      }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`: {
        const known = args[args.indexOf('--known') + 1] ?? 'none'
        return { stdout: `queue known=${known} now=${w.queue.join(',') || 'none'}\n` }
      }
      case `${TOOLS}/pipeline-watch.sh`:
        return { stdout: w.watch }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read':
        if (args.includes('--comments')) return { stdout: JSON.stringify({ comments: [], stripped: 0 }) }
        return { stdout: args.join(' ') === '--json 470' ? ISSUE_470 : JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: JSON.stringify([{ path: SLOT, branch: w.slotBranch, status: 'leased', processes: [] }]) }
      case 'callum-flow-milestone':
        return args[0] === 'show' ? { stdout: 'Next release (v0.36.0)\nExpected: patch\n#470 open  The loop acts\n' } : { stdout: 'ok\n' }
      case 'callum-flow-claim':
        if (args[0] === '470') {
          w.stage = 'designing'
          w.since = now()
          w.queue = []
        }
        return {}
      case 'callum-flow-implementer-route':
        return { stdout: 'sonnet\n' }
      case 'callum-flow-event':
        if (args[0] === 'delegated') {
          w.stage = 'implementing'
          w.since = now()
          w.slotBranch = BRANCH
        }
        return {}
      case 'sh':
        // the respond launch: the run leaves the gate, its checks pass, and it is mergeable
        if ((args[1] ?? '').includes('nohup')) {
          w.stage = 'ready to merge'
          w.since = now()
          w.watch = `merge-ready ${BRANCH} ${RUN} pr=512 head=${HEAD}\n`
        }
        return {}
      case 'callum-flow-merge-guard':
        return { stdout: 'GUARD author PASS\nGUARD gates PASS\nGUARD linkage PASS\n' }
      case 'callum-flow-merge':
        w.stage = 'merged'
        w.since = now()
        w.watch = ''
        return { stdout: `merged PR #512 at ${HEAD}\n` }
      case 'callum-flow-rollout':
        return { stdout: 'ROLLOUT run-it source=brief\n' }
    }
    return undefined
  }
  return { w, run }
}

// harness: an act-mode session's passes without the engine: observe.ts reads the world's
// commands, act.ts actPass plans and acts, agentAnswered and wakeStarted/wakeEnded take what the
// hooks would hand them; register.ts does exactly this between its rails and its store. (The
// engine's test host never hands a plugin's $.agent.spawn an agent id, so spawns that start are
// driven here; driver.test.ts covers register's own wiring in the host.)
function harness(run: (argv: string[], s: Seen) => { exitCode?: number; stdout?: string; stderr?: string } | undefined) {
  let now = NOW
  let wakes = 0
  let spawned = 0
  const files = new Map<string, string>()
  const seen: Seen[] = []
  const spawns: SpawnInput[] = []
  const prompts: string[] = []
  const titles: string[] = []
  const agents: { id: string; type: string; status: AgentStatus }[] = []
  const io: ActIo = {
    now: async () => now,
    run: async (argv, init) => {
      const s: Seen = { argv, env: init.env, stdin: init.stdin, cwd: init.cwd }
      seen.push(s)
      const r = run(argv, s) ?? {}
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    spawnAgent: async input => {
      spawns.push(input)
      const agentId = `agent-${++spawned}`
      agents.push({ id: agentId, type: input.subagentType, status: 'running' })
      return { agentId }
    },
    stopAgent: async () => ({ stopped: true }),
    submit: async p => void prompts.push(p),
    rename: async t => void titles.push(t),
    usage: async () => ({ fiveHour: 40, sevenDay: 60 }),
    readFile: async p => files.get(p) ?? null,
    writeFile: async (p, t) => void files.set(p, t),
  }
  const observeIo: Io = {
    now: io.now,
    run: (argv, init) => io.run(argv, init),
    readFile: io.readFile,
    sessionLimits: async () => [],
    agents: async () => agents.map(a => ({ ...a })),
  }
  const rt = runtime()
  const live: Live = { ledger: [] }
  const between: Between = { answering: new Set(), completedSeen: new Map() }
  const env: ActEnv = { io, rt, live, commands: [], wakeId: () => `w${++wakes}`, session: 'session-1', save: async () => true, holds: async () => true, problems: [] }
  const cache = emptyCache()
  let lastTitle: string | null = null
  let queueKnown: number[] | null = null
  let last: Acted | null = null
  const h = {
    seen,
    spawns,
    prompts,
    titles,
    live,
    at: (s: number) => {
      now = NOW + s * 1000
    },
    async pass(): Promise<Acted> {
      const stored = { ledger: live.ledger.length > 0 ? live.ledger : null, githubBackoffUntil: null, queueKnown }
      const observed = await observe(observeIo, rt, cache, NOW, lastTitle, stored)
      if (observed.queueKnown !== null) queueKnown = observed.queueKnown
      const listed = { ok: true, agents: agents.map(a => ({ id: a.id, status: a.status })) }
      last = await actPass(env, observed.state, listed, between)
      if (last.report.title !== null) lastTitle = last.report.title
      return last
    },
    keys: () => (last?.result.actions ?? []).filter(a => a.kind !== 'title').map(a => a.key),
    entry: (key: string) => live.ledger.find(e => e.key === key),
    ran: (name: string) => seen.filter(s => s.argv[0] === name),
    events: () => seen.filter(s => s.argv[0] === 'callum-flow-event').map(s => s.argv),
    async answer(agentId: string, text: string) {
      const r = await agentAnswered(env, last?.state ?? state(), { agentId, answer: text, reason: 'answer' }, between)
      const a = agents.find(x => x.id === agentId)
      if (a !== undefined) a.status = 'completed'
      return r
    },
    async turn(turnId: string, said: string, answer: string) {
      await wakeStarted(env, said, turnId)
      return wakeEnded(env, { turnId, answer, reason: 'answer' })
    },
  }
  return h
}

describe('act mode end to end (SPEC 2, 5, 6)', () => {
  test('one issue from claim to merge and its follow-ups, across passes', async () => {
    let clock = NOW
    const { w, run } = world(() => clock)
    const h = harness(run)
    const at = (s: number) => {
      clock = NOW + s * 1000
      h.at(s)
    }

    // pass 1: the sweep, and the claim of the ready issue
    at(5)
    await h.pass()
    expect(h.keys()).toEqual(['sweep:0', 'claim:470:new'])
    expect(h.entry('claim:470:new')).toMatchObject({ status: 'done', outcome: { kind: 'claim', result: 'claimed' } })
    const claimed = h.ran('callum-flow-claim')[0]
    expect(claimed?.argv).toEqual(['callum-flow-claim', '470'])
    expect(claimed?.env).toMatchObject({ CALLUM_FLOW_REPO: REPO, CALLUM_FLOW_READY_LABEL: 'ready', CALLUM_FLOW_IN_DEV_LABEL: 'in development' })
    const claimedAt = w.since

    // pass 2: the designer, with its spawn record and loop event
    at(60)
    await h.pass()
    expect(h.keys()).toEqual([`design:470:${claimedAt}`])
    expect(h.spawns[0]).toMatchObject({ subagentType: 'callum-flow:designer', name: 'designer-470', description: 'Design #470' })
    expect(h.entry(`design:470:${claimedAt}`)).toMatchObject({ status: 'running', agentId: 'agent-1', attempts: 1 })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=spawn key=design:470:${claimedAt} status=running`))).toBe(true)

    // its answer: pass 3 delegates (route, the delegated event, the implementer on the routed model)
    expect(await h.answer('agent-1', `Brief posted.\nRESULT brief=${BRIEF} created=none pending_decision=no`)).toEqual({ result: 'applied' })
    expect(h.entry(`design:470:${claimedAt}`)).toMatchObject({ status: 'done', outcome: { kind: 'designer', brief: BRIEF } })
    at(65)
    await h.pass()
    expect(h.keys()).toEqual([`delegate:470:${BRIEF}`])
    expect(h.ran('callum-flow-implementer-route').map(s => s.argv)).toEqual([['callum-flow-implementer-route', '470']])
    expect(h.events()).toContainEqual(['callum-flow-event', 'delegated', '--issue', '470', '--note', `brief ${BRIEF}`])
    expect(h.spawns[1]).toMatchObject({ subagentType: 'callum-flow:implementer', model: 'sonnet' })

    // the implementer hands off a gated run, which parks at review: pass 4 adjudicates
    w.stage = 'parked'
    w.run = RUN
    w.pr = 512
    w.watch = `parked ${BRANCH} ${RUN} step=review pr=512 head=${HEAD}\n`
    await h.answer('agent-2', `Done.\nRESULT run=${RUN} head=${HEAD} commit=${HEAD} gated=yes branch=${BRANCH} pr=512`)
    expect(h.entry(`delegate:470:${BRIEF}`)).toMatchObject({ status: 'done', outcome: { kind: 'handoff', notGated: false, run: RUN } })
    at(70)
    await h.pass()
    expect(h.keys()).toEqual([`adjudicate:${RUN}:review:${HEAD}`])
    expect(h.spawns[2]).toMatchObject({ subagentType: 'callum-flow:adjudicator' })

    // the adjudicator approves: its verdict is logged, and pass 5 responds in the run's slot
    await h.answer('agent-3', 'WRONG: review-1 the retry is bounded already.\nACTION: approve')
    expect(h.events()).toContainEqual(['callum-flow-event', 'verdict', '--issue', '470', '--run', RUN, '--branch', BRANCH, '--note', 'WRONG: review-1 the retry is bounded already.'])
    at(75)
    await h.pass()
    expect(h.keys()).toEqual([`respond:${RUN}:review:${HEAD}:approve`])
    const launch = h.ran('sh')[0]
    expect(launch?.argv.slice(3, 6)).toEqual(['factory-loop-respond', SLOT, BRANCH])
    expect(launch?.argv.slice(7)).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'approve', '--step=review'])
    expect(h.entry(`respond:${RUN}:review:${HEAD}:approve`)).toMatchObject({ status: 'done' })

    // merge-ready: pass 6 guards, pass 7 asks the merge adjudicator
    at(120)
    await h.pass()
    expect(h.keys()).toEqual([`guard:512:${HEAD}:1`])
    expect(h.ran('callum-flow-merge-guard').map(s => s.argv)).toEqual([['callum-flow-merge-guard', '512', '--run', RUN]])
    at(180)
    await h.pass()
    expect(h.keys()).toEqual([`adjudicate-merge:512:${HEAD}`])

    // it answers merge with an image flag: pass 8 wakes the model for the sequencing call
    await h.answer('agent-4', 'ACTION: merge\nSUMMARY: the loop acts on the factory\nBUMP: minor a new capability\nFLAGS: image')
    at(185)
    await h.pass()
    expect(h.keys()).toEqual([`judge:sequence:512:${HEAD}`])
    const wake = h.prompts[0] ?? ''
    expect(wake).toStartWith('JUDGE sequence id=w1 repo=cbundy/dev-system')
    expect(wake).toContain('flags=image bump=minor')
    expect(wake.split('\n').at(-1)).toBe('Answer with the factory-loop:judge skill.')

    // the main loop's turn answers it (the engine frames a plugin's prompt; the frame is skipped)
    const ended = await h.turn('turn-main-1', `The factory-loop plugin sent a message:\n${wake}`, 'ANSWER w1 merge\nreason: nothing else waits for the next release')
    expect(ended).toEqual({ moved: true, prompts: [], problems: [] })
    expect(h.entry(`judge:sequence:512:${HEAD}`)).toMatchObject({ status: 'done', turnId: 'turn-main-1', outcome: { kind: 'wake', decision: 'merge' } })

    // pass 9 merges and reads the rollout
    at(190)
    await h.pass()
    expect(h.keys()).toEqual([`merge:512:${HEAD}`])
    expect(h.ran('callum-flow-merge').map(s => s.argv)).toEqual([['callum-flow-merge', '512', '--run', RUN]])
    expect(h.ran('callum-flow-rollout').map(s => s.argv)).toEqual([['callum-flow-rollout', '470']])
    expect(h.entry(`merge:512:${HEAD}`)).toMatchObject({ status: 'done', outcome: { kind: 'merge', result: 'merged', rollout: 'run-it' } })

    // pass 10: the run-it rollout's follow-ups, and the bump above the milestone's Expected
    at(240)
    await h.pass()
    expect(h.keys()).toEqual(['milestone-later:470', 'task:run-it:470', 'expect:minor:512'])
    expect(h.ran('callum-flow-milestone').filter(s => s.argv[1] !== 'show').map(s => s.argv)).toEqual([
      ['callum-flow-milestone', 'plan', '470', 'later'],
      ['callum-flow-milestone', 'expect', 'minor', 'a new capability'],
    ])
    expect(h.prompts[1]).toStartWith('TASK run-it id=w2')

    // every command ran from the main checkout with the repo's environment (whether act mode's
    // events reach the real log is register.ts's to decide: driver.test.ts checks it)
    expect(h.seen.every(s => s.cwd === '/work' || s.argv[0] === 'git')).toBe(true)
    expect(h.seen.every(s => s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
    // and nothing is left running but the run-it task the model now holds
    expect(h.live.ledger.filter(e => e.status === 'running').map(e => e.key)).toEqual(['task:run-it:470'])
    // and each transition logged one loop event: none twice, the judge's turn taking its id
    // included (#536)
    const loops = h.events().filter(e => e[1] === 'loop').map(e => e.join(' '))
    expect(loops).toEqual([...new Set(loops)])
    expect(loops.filter(l => l.includes(`key=judge:sequence:512:${HEAD} `)).map(l => /status=(\S+)/.exec(l)?.[1])).toEqual(['running', 'done'])
  })

  test('an agent that answers after its entry ended is dropped, and one the loop never spawned is not its own', async () => {
    const h = harness(() => undefined)
    h.live.ledger = [entry('design:470:1', 'spawn', { agent: 'designer', status: 'timed-out', agentId: 'agent-9' })]
    expect(await h.answer('agent-9', 'RESULT brief=none created=none pending_decision=no')).toEqual({ result: 'dropped', why: 'late answer for design:470:1 (timed-out)' })
    expect(await h.answer('agent-other', 'hello')).toEqual({ result: 'not ours' })
    expect(h.live.ledger).toMatchObject([{ key: 'design:470:1', status: 'timed-out' }])
  })
})
