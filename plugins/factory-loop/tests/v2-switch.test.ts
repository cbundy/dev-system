// The switch between v1 and v2 (docs/factory-loop/v2/SPEC.md 2.3, appendix A, appendix E): the
// settings that pick the planner and the shadow, and where each comes from (the workspace file may
// set any key and wins; under planner v2 the repo's own come from origin's default branch); the
// plan call sites (act.ts planPass): only the planner acts, and the v2 shadow is planned beside v1,
// logged and never executed; the dispatcher's v2 executors (registry.ts); and the driver end to end:
// the decision log's planner, shadow, counts and sources, the records and heads in the store, and
// an owner op's intervention under planner v2.
import { describe, expect, mock, test } from 'claude-code/testing'

import { EXECUTORS, actPass, ctxOf, dispatch, planPass, runActions } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { DEFAULT_CONFIG, V2_DEFAULTS, loadConfig } from '../hooks/config'
import type { ActIo } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import { plan } from '../hooks/plan'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { emptyV2State, recordsToStore } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { V2_EXECUTORS } from '../hooks/v2/registry'
import { V2_ACTION_KINDS } from '../hooks/v2/types'
import type { IssueRecord } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, issue, state, withLedger } from './fixtures'
import { CFG_DIR, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host, iso } from './host'
import type { Seen } from './host'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
const HOUR = 60 * MIN

function record(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    issue: 470,
    life: 'tbq3k0',
    seq: 4,
    seqAt: NOW - 10 * MIN,
    state: 'building',
    since: NOW - 10 * MIN,
    resumeTo: null,
    branch: 'issue-470',
    pr: null,
    head: null,
    approvedPatch: null,
    brief: null,
    step: 'build',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 0,
    round: 0,
    question: null,
    why: null,
    notes: [],
    prClosedAt: null,
    ...over,
  }
}

describe('the settings (v2 SPEC appendix A)', () => {
  test('v1 plans until cutover, with the shadow off; the timeouts and limits are the spec\'s', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      planner: 'v1',
      shadow: 'off',
      stateTimeoutMs: { design: 45 * MIN, build: 90 * MIN, review: 30 * MIN, fix: 60 * MIN, triage: 15 * MIN, queued: 6 * HOUR, queueWait: 2 * HOUR, parked: 24 * HOUR },
      ciStartMs: 10 * MIN,
      ciRunMs: 30 * MIN,
      maxTriages: 2,
      triageModel: 'opus',
      reviewer: 'adjudicator',
      reviewerModel: 'opus',
      gateCommands: [],
      gateTimeoutMs: 10 * MIN,
      maxInFlightIssues: 5,
      reviewFixCap: 3,
    })
    // a step key is one attempt, and a CI re-run, an update and a merge are one per key (appendix B)
    expect(DEFAULT_CONFIG.maxAttempts).toMatchObject({ 'agent-step': 1, 'ci-rerun': 1, 'queue-update': 1, 'queue-merge': 1 })
  })

  test('each v2 key loads from its settings file, durations and all; a bad value is named and left out', () => {
    const r = loadConfig(
      {
        planner: 'v2',
        shadow: 'v2',
        stateTimeout: { build: '2h', triage: '20m' },
        ciStart: '5m',
        maxTriages: 1,
        reviewerModel: 'sonnet',
        gateCommands: ['npm run lint', 'npm test'],
        gateTimeout: '15m',
      },
      { stateTimeoutMs: { design: 3_600_000 } },
    )
    expect(r.problems).toEqual([])
    expect(r.config).toMatchObject({
      planner: 'v2',
      shadow: 'v2',
      stateTimeoutMs: { ...DEFAULT_CONFIG.stateTimeoutMs, build: 2 * HOUR, triage: 20 * MIN, design: HOUR },
      ciStartMs: 5 * MIN,
      maxTriages: 1,
      reviewerModel: 'sonnet',
      gateCommands: ['npm run lint', 'npm test'],
      gateTimeoutMs: 15 * MIN,
    })
    const bad = loadConfig({ planner: 'v3', shadow: 'v1', maxTriages: 1.5, gateCommands: ['npm test', ''], stateTimeout: { review: 'soon', merge: '1h' } })
    expect(bad.problems).toEqual([
      'planner: "v3" is not v1 or v2',
      'shadow: "v1" is not off or v2',
      'maxTriages: 1.5 is not a whole number',
      'gateCommands: ["npm test",""] is not a list of commands',
      'stateTimeout.review: "soon" is not a duration (like 60s, 5m, 2h)',
      'stateTimeout.merge: unknown',
    ])
    expect(bad.config).toMatchObject({ planner: 'v1', shadow: 'off', maxTriages: 2, gateCommands: [], stateTimeoutMs: DEFAULT_CONFIG.stateTimeoutMs })
  })

  test('under planner v2, K is 3 unless a settings file sets it (v2 SPEC section 15); v1 keeps 5', () => {
    expect(V2_DEFAULTS).toEqual({ maxInFlightIssues: 3 })
    expect(loadConfig({ planner: 'v2' }).config.maxInFlightIssues).toBe(3)
    expect(loadConfig({ planner: 'v2', maxInFlightIssues: 2 }).config.maxInFlightIssues).toBe(2)
    expect(loadConfig({ maxInFlightIssues: 5 }, { planner: 'v2' }).config.maxInFlightIssues).toBe(5)
    expect(loadConfig({ planner: 'v2', maxInFlightIssues: 'two' }).config.maxInFlightIssues).toBe(3)
    expect(loadConfig({}).config.maxInFlightIssues).toBe(5)
  })
})

// --- the plan call sites (act.ts planPass) ------------------------------------------------------------

describe('planPass: only the planner acts; the shadow is planned and logged', () => {
  const s = (): State => ({ ...state({ queue: [7], issues: [issue(7)] }), v2: emptyV2State(NOW) })

  test('planner v1: v1\'s plan, and no shadow until it is on', () => {
    const cfg = config()
    expect(planPass(s(), cfg)).toEqual({ result: plan(s(), cfg), shadow: null })
    const shadowed = planPass(s(), config({ shadow: 'v2' }))
    expect(shadowed.result).toEqual(plan(s(), config({ shadow: 'v2' })))
    expect(shadowed.shadow).toEqual(planV2(s(), config({ shadow: 'v2' })))
  })

  test('planner v2: v2\'s plan, and no shadow of v1 (v2 SPEC 2.3)', () => {
    const cfg = config({ planner: 'v2', shadow: 'v2' })
    expect(planPass(s(), cfg)).toEqual({ result: planV2(s(), cfg), shadow: null })
  })

  test('a v2 shadow that throws never fails the pass it shadows: v1 plans, and the error is logged', () => {
    const broken = { ...s(), v2: { ...emptyV2State(NOW), records: null as unknown as IssueRecord[] } }
    const r = planPass(broken, config({ shadow: 'v2' }))
    expect(r.result).toEqual(plan(broken, config({ shadow: 'v2' })))
    expect(r.shadow).toMatchObject({ error: expect.stringContaining('the v2 shadow threw') })
  })

  test('the v2 shadow plans with the settings v2 runs with: K 3 where no file sets it, the file\'s K where one does', () => {
    const loaded = loadConfig({ shadow: 'v2' })
    expect(loaded.config.maxInFlightIssues).toBe(5)
    expect(loaded.v2.maxInFlightIssues).toBe(3)
    expect(loadConfig({ shadow: 'v2' }, { maxInFlightIssues: 2 }).v2.maxInFlightIssues).toBe(2)
    expect(loadConfig({ planner: 'v2' }).v2).toEqual(loadConfig({ planner: 'v2' }).config)
    const r = planPass(s(), loaded.config, loaded.v2)
    expect(r.result).toEqual(plan(s(), loaded.config))
    expect(r.shadow).toEqual(planV2(s(), loaded.v2))
  })

  test('R2 restarts only on a pass that starts nothing else: a release task due in the same pass holds it, and the task\'s run holds it after (v2 SPEC 14.1)', () => {
    const cfg = config({ planner: 'v2' })
    const quiet: State = { ...state({ control: control({ updateDue: { reason: 'image', at: NOW - MIN } }) }), v2: emptyV2State(NOW) }
    expect(planV2(quiet, cfg).actions.at(-1)).toMatchObject({ kind: 'restart-self', rule: 'R2' })
    const release: State = { ...quiet, milestone: { open: 0, closed: 3, expected: 'patch' } }
    const both = planV2(release, cfg)
    expect(both.actions.map(a => a.kind)).toEqual(['task', 'title'])
    expect(both.skipped).toContainEqual({ rule: 'R2', issue: null, why: 'update due: this pass starts task:release:3:patch first' })
    const running = entry('task:release:3:patch', 'task', { class: 'drive', wake: 'release', status: 'running', endedAt: null })
    const after = planV2({ ...release, ledger: [...release.ledger, running] }, cfg)
    expect(after.actions.some(a => a.kind === 'restart-self')).toBe(false)
    expect(after.skipped).toContainEqual({ rule: 'R2', issue: null, why: 'update due: waiting on task:release:3:patch' })
  })

  test('the v2 planner with no v2 fields read plans no rule, and says why', () => {
    const r = planV2(state(), config({ planner: 'v2' }))
    expect(r.skipped).toContainEqual({ rule: 'G2', issue: null, why: 'v2 sources not read: the planner and the shadow are v1' })
    expect(r.actions.map(a => a.kind)).toEqual(['title'])
  })
})

// --- the dispatcher (v2 registry) ---------------------------------------------------------------------------

function runtime(planner: 'v1' | 'v2'): Runtime {
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
    config: config({ planner }),
    configProblems: [],
  }
}

function recording(): { io: ActIo; argvs: string[][]; spawns: string[] } {
  const argvs: string[][] = []
  const spawns: string[] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async argv => {
      argvs.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    spawnAgent: async input => {
      spawns.push(input.subagentType)
      return { agentId: `a${spawns.length}` }
    },
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  return { io, argvs, spawns }
}

function envOf(planner: 'v1' | 'v2', ledger: LedgerEntry[] = []): { env: ActEnv; argvs: string[][]; spawns: string[] } {
  const { io, argvs, spawns } = recording()
  const env: ActEnv = { io, rt: runtime(planner), live: { ledger }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return { env, argvs, spawns }
}

describe('the dispatcher: v2\'s executors (v2 SPEC 2.2, appendix B)', () => {
  test('every new kind has its executor in the registry, and the act step\'s map holds it', () => {
    expect(V2_ACTION_KINDS.filter(kind => V2_EXECUTORS[kind] === undefined)).toEqual([])
    for (const kind of V2_ACTION_KINDS) expect(EXECUTORS[kind]).toBe(V2_EXECUTORS[kind])
  })

  test('a v2 kind not built yet fails, never retried, before any command; a v1 kind keeps v1\'s executor under planner v2', async () => {
    const pr: Action = { kind: 'pr', key: 'i470/ltbq3k0/s4/pr/ensure', class: 'free', rule: 'S2', reason: 'x', issue: 470, op: 'ensure', branch: 'issue-470', base: 'main', pr: null, title: 't', summary: 's', evidence: null, brief: null }
    const sweep: Action = { kind: 'sweep', key: 'sweep:0', class: 'free', rule: 'H2', reason: 'x', issue: null }
    for (const planner of ['v1', 'v2'] as const) {
      const { env, argvs } = envOf(planner)
      const s = state()
      expect(await dispatch(ctxOf(env, s, start([], pr, NOW).entry), pr)).toEqual({ status: 'failed', summary: 'pr: not built yet (U5)', noRetry: true })
      expect(argvs).toEqual([])
      expect(await dispatch(ctxOf(env, s, start([], sweep, NOW).entry), sweep)).toMatchObject({ status: 'done' })
      expect(argvs).toEqual([['callum-flow-sweep']])
    }
  })

  test('the GitHub backoff of a pass that met a rate limit holds the planner\'s GitHub kinds', async () => {
    const limited = (planner: 'v1' | 'v2') => {
      const { env, argvs } = envOf(planner)
      env.io.run = async argv => {
        argvs.push([...argv])
        return argv[0] === 'callum-flow-claim' ? { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' } : { exitCode: 0, stdout: '', stderr: '' }
      }
      return { env, argvs }
    }
    const claim: Action = { kind: 'claim', key: 'claim:7:new', class: 'start', rule: 'S1', reason: 'x', issue: 7 }
    const label: Action = { kind: 'label', key: 'i8/l1/s1/label', class: 'free', rule: 'S3', reason: 'x', issue: 8, op: 'set', label: 'factory:queued' }
    const v2 = limited('v2')
    const report = await runActions(v2.env, state(), [claim, label])
    expect(report.outcomes.map(o => [o.key, o.status, o.summary])).toEqual([
      ['claim:7:new', 'failed', expect.any(String)],
      ['i8/l1/s1/label', 'skipped', 'held: GitHub rate limit met this pass'],
    ])
  })
})

// --- the driver end to end ---------------------------------------------------------------------------------

// world: the CLIs a pass reads, quiet; treehouse lists one slot the loop leased for #470.
function world(over: { queue?: number[]; issues?: Record<string, unknown>[]; run?: (argv: string[], s: Seen) => { exitCode?: number; stdout?: string; stderr?: string } | undefined } = {}) {
  const slots = [{ name: '1', path: '/slots/1', status: 'leased', branch: 'issue-470', lease_id: 'L1', lease_holder: 'factory-loop:470:tbq3k0', leased_at: iso(NOW - HOUR), processes: [] }]
  return (argv: string[], s: Seen) => {
    const own = over.run?.(argv, s)
    if (own !== undefined) return own
    const [cmd, ...args] = argv
    switch (cmd) {
      case 'callum-flow-factory-state':
        return { stdout: factoryDoc(over.issues ?? []) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: `queue known=none now=${(over.queue ?? []).join(',') || 'none'}\n` }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read':
        if (args.includes('--list')) return { stdout: JSON.stringify({ issues: (over.queue ?? []).map(number => ({ number })), stripped: 0 }) }
        return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: JSON.stringify(slots) }
    }
    return undefined
  }
}

const sources = (line: Record<string, unknown>) => line.sources as Record<string, string>

describe('the driver (v2 SPEC 2.3)', () => {
  test('observe mode with planner v2 from the workspace file: v2 plans and its plan is logged; no runs, no reflogs, nothing kept', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, checkout: '/work', planner: 'v2' }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'observe', executed: false, planner: 'v2', transitions: [], counts: { queue: 0, queued: 0, flight: 0, parked: 0, owner: 0 } })
    // the workspace file's planner is a setting it may set, so nothing is named
    expect(line.config).toBeUndefined()
    expect(line.shadow).toBeUndefined()
    expect(sources(line)).toMatchObject({ runs: 'failed: not read: planner v2 has no pipeline runs', 'v2.leases': 'ok', 'v2.store': 'ok', 'v2.prs': 'failed: not built yet (U7)' })
    expect(h.titles).toEqual(['🔄 dev-system (Q:0 - D:0 - M:0) · observe'])
    expect(h.commands().some(c => c.argv[0]?.endsWith('pipeline-watch.sh'))).toBe(false)
    expect(h.commands().some(c => c.argv.includes('reflog'))).toBe(false)
    expect([...h.store.keys()]).toEqual([])
  })

  test('the v2 shadow plans beside v1 on the same state: logged, never executed (v2 SPEC 2.3)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // an update is due while v1's implementer still runs: v1 drains, v2's R2 restarts at once (its
    // sweep is not due, so the pass starts nothing else). The factory shows no claim of this
    // device, so v2's R1 has no ghost to release, which would hold R2 (v2 SPEC 6.2)
    const running = entry('delegate:470:x', 'delegate', { agent: 'implementer', class: 'develop', issue: 470, status: 'running', endedAt: null, agentId: 'agent-1' })
    const swept = entry('sweep:0', 'sweep', { endedAt: NOW - MIN })
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', shadow: 'v2' },
      files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: NOW - MIN } }) },
      store: { [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries: [running, swept] } },
      run: world(),
    })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:implementer', status: 'running', description: 'Implement #470' })
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: true, planner: 'v1' })
    const shadow = line.shadow as { k: number; actions: { key: string; kind: string; rule: string }[]; skipped: unknown[]; transitions: unknown[] }
    // no file sets K: v1 plans with 5, the shadow with v2's 3
    expect(shadow.k).toBe(3)
    expect(shadow.actions).toContainEqual(expect.objectContaining({ key: `restart:${NOW - MIN}`, kind: 'restart-self', rule: 'R2' }))
    expect(shadow.transitions).toEqual([])
    expect((line.actions as { key: string }[]).some(a => a.key.startsWith('restart:'))).toBe(false)
    expect(h.commands().some(c => c.argv[0] === 'dev-restart-self')).toBe(false)
    // the shadow reads v2's fields, and writes none of them
    expect([...h.store.keys()].filter(k => k.startsWith('records:') || k.startsWith('heads:'))).toEqual([])
  })

  test('the shadow\'s own reads send their events to the sink, as observe mode\'s do; the planner\'s own reads do not', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // a parked record whose label a person removed: v2 reads its comments, which v1 never does
    const parked = record({ issue: 80, state: 'parked', step: null, since: NOW - HOUR, question: 'which API?' })
    const issue80 = { issue: { number: 80, title: 'x', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }
    const reads = (argv: string[]) => (argv.join(' ') === 'callum-flow-issue-read --json 80' ? { stdout: JSON.stringify(issue80) } : undefined)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', shadow: 'v2' },
      store: { [`records:${REPO}`]: recordsToStore([parked], NOW - MIN) },
      run: world({ run: reads }),
    })
    await $.session.start(START)
    await clock.advance(6_000)
    const comments = h.commands().filter(c => c.argv.join(' ') === 'callum-flow-issue-read --json 80 --comments')
    expect(comments.map(c => c.env.CALLUM_EVENTS_DIR)).toEqual([`${LOOP_DIR}/sink-events`])
    // the pass's own reads are real ones
    expect(h.commands().find(c => c.argv.join(' ') === 'callum-flow-issue-read --json 80')?.env.CALLUM_EVENTS_DIR).toBeUndefined()
  })

  test('v2\'s own GitHub reads have budgets of their own: a pass whose issue reads took all 12 still reads an unparked record\'s comments (v2 SPEC 2.4)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const parked = record({ issue: 80, state: 'parked', step: null, since: NOW - HOUR, question: 'which API?' })
    const issue80 = { issue: { number: 80, title: 'x', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }
    const reads = (argv: string[]) => (argv.join(' ') === 'callum-flow-issue-read --json 80' ? { stdout: JSON.stringify(issue80) } : undefined)
    const queue = Array.from({ length: 14 }, (_, i) => 100 + i)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' },
      store: { [`records:${REPO}`]: recordsToStore([parked], NOW - MIN) },
      run: world({ queue, run: reads }),
    })
    await $.session.start(START)
    await clock.advance(6_000)
    const issueReads = h.commands().filter(c => c.argv[0] === 'callum-flow-issue-read' && !c.argv.includes('--list') && !c.argv.includes('--comments'))
    expect(issueReads).toHaveLength(12)
    // the parked record's issue went first, and its comments still came after the 12
    expect(issueReads[0]?.argv).toEqual(['callum-flow-issue-read', '--json', '80'])
    expect(h.commands().filter(c => c.argv.join(' ') === 'callum-flow-issue-read --json 80 --comments')).toHaveLength(1)
  })

  test('act mode with planner v2 reads its records from the store, counts them, and keeps the store\'s records as they are', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const stored = recordsToStore([record(), record({ issue: 471, state: 'parked', step: null, question: 'which API?' })], NOW - MIN)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' },
      store: { [`records:${REPO}`]: stored },
      run: world(),
    })
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: true, planner: 'v2', counts: { queue: 0, queued: 0, flight: 1, parked: 1, owner: 0 } })
    expect(h.titles).toEqual(['🔄 dev-system (Q:0 - D:1 - M:0) · parked 1'])
    expect(h.store.get(`records:${REPO}`)).toEqual(stored)
  })

  test('the workspace file may set any setting, and wins over the repo\'s; its runtime keys are not settings', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, {
      config: { repo: REPO, checkout: '/work', runSource: 'local', poolSize: 8, readyLabel: 'ship', queueEvery: '10m' },
      files: { '/work/.claude/factory-loop.json': JSON.stringify({ readyLabel: 'go', queueEvery: '2m' }) },
      run: world(),
    })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.seen.some(s => s.argv.join(' ') === 'callum-flow-issue-read --json --list --label ship')).toBe(true)
    expect(h.last().config).toBeUndefined()
  })

  // under planner v2 the repo's settings are origin's default branch's (origin/HEAD names it, else
  // main); the tree's stand only when origin's cannot be read, and the decision log says so
  const NOT_READ = "settings: origin's default branch not read (origin/main: fatal: invalid object name 'origin/main'.); the main checkout's file is used"
  const showCases: [string, { exitCode?: number; stdout?: string; stderr?: string }, string, string[] | undefined][] = [
    ['origin has the file', { stdout: JSON.stringify({ planner: 'v2', readyLabel: 'from-origin' }) }, 'from-origin', undefined],
    ['origin has none', { exitCode: 128, stderr: "fatal: path '.claude/factory-loop.json' does not exist in 'origin/main'" }, 'ready', undefined],
    ['origin cannot be read', { exitCode: 128, stderr: "fatal: invalid object name 'origin/main'." }, 'from-tree', [NOT_READ]],
  ]
  for (const [name, show, label, problems] of showCases) {
    test(`under planner v2 the repo's settings are origin's default branch's: ${name}`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const run = world({ run: argv => (argv.join(' ') === 'git show origin/main:.claude/factory-loop.json' ? show : undefined) })
      const h = host(on, { config: { repo: REPO, checkout: '/work' }, files: { '/work/.claude/factory-loop.json': JSON.stringify({ planner: 'v2', readyLabel: 'from-tree' }) }, run })
      await $.session.start(START)
      await clock.advance(6_000)
      expect(h.seen.some(s => s.argv.join(' ') === `callum-flow-issue-read --json --list --label ${label}`)).toBe(true)
      expect(h.last().config).toEqual(problems)
    })
  }

  test('under planner v2 with no origin/HEAD, origin\'s default branch is taken to be main', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const run = world({
      run: argv => {
        const line = argv.join(' ')
        if (line === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') return { exitCode: 1, stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref' }
        return line === 'git show origin/main:.claude/factory-loop.json' ? { stdout: JSON.stringify({ planner: 'v2', readyLabel: 'from-main' }) } : undefined
      },
    })
    const h = host(on, { config: { repo: REPO, checkout: '/work' }, files: { '/work/.claude/factory-loop.json': JSON.stringify({ planner: 'v2' }) }, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.seen.some(s => s.argv.join(' ') === 'callum-flow-issue-read --json --list --label from-main')).toBe(true)
  })

  test('act mode with planner v2: a records store that cannot be read is no records known, not none; nothing that releases or starts is planned, and nothing is written over it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const stored = recordsToStore([record()], NOW - MIN)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' },
      store: { [`records:${REPO}`]: stored },
      run: world({ queue: [7], issues: [{ issue: 470, stage: 'implementing', entered_at: iso(NOW - HOUR), holder: DEVICE, run: null, pr: null, stuck: null, github: null }] }),
    })
    let down = true
    h.failGet = key => down && key === `records:${REPO}`
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: true, planner: 'v2' })
    const why = sources(line)['v2.store'] ?? ''
    expect(why).toStartWith(`failed: records:${REPO} could not be read: `)
    expect(line.skipped).toContainEqual({ rule: 'G2', issue: null, why: `v2 records not read: ${why.slice('failed: '.length)}; nothing is released, claimed or started` })
    expect(h.store.get(`records:${REPO}`)).toEqual(stored)
    // the store back: the next pass loads the records
    down = false
    await clock.advance(61_000)
    expect(sources(h.last())['v2.store']).toBe('ok')
    expect(h.last().counts).toMatchObject({ flight: 1 })
  })

  for (const planner of ['v2', 'v1'] as const) {
    test(`an owner op in act mode under planner ${planner} ${planner === 'v2' ? 'is logged as an intervention (act-events.ts, U4)' : 'logs no intervention'}`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work', planner }, run: world() })
      await $.session.start(START)
      await clock.advance(6_000)
      const r = await $.command.run({ command: 'factory', args: 'pause 12', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
      expect(r.text).toBe('Paused #12: no action on it until unpause; its claim still renews.')
      await clock.advance(1_000)
      const control = h.lines().find(l => l.control === 'pause 12')
      expect(control?.problems).toBeUndefined()
      const logged = h.seen.filter(s => s.argv[0] === 'callum-flow-event' && s.argv[1] === 'intervention').map(s => s.argv.slice(2, 4).concat((s.argv.at(-1) ?? '').split(' ').slice(0, 2)))
      expect(logged).toEqual(planner === 'v2' ? [['--issue', '12', 'who=person', 'cause=op:pause']] : [])
    })
  }

  test('/factory planner v2 writes the workspace file; the next pass plans with v2, and status names it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, checkout: '/work' }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last().planner).toBe('v1')
    const r = await $.command.run({ command: 'factory', args: 'planner v2', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(r.text).toBe('Planner v2 set in the workspace config file; it plans and acts from the next pass.')
    expect(JSON.parse(h.files.get(`${CFG_DIR}/factory-loop/config.json`) ?? '{}')).toMatchObject({ planner: 'v2' })
    await clock.advance(61_000)
    expect(h.last().planner).toBe('v2')
    const status = await $.command.run({ command: 'factory', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(status.text).toContain(': observe, planner v2, tier')
  })
})

describe('the shadow in the act step (act.ts actPass)', () => {
  test('an acting pass with the shadow on runs v1\'s actions alone, and hands the shadow\'s plan back for the log', async () => {
    // an update is due while v1's implementer runs: v1 drains, the v2 shadow's R2 would restart now
    // (no claim of this device shows, so the shadow's R1 has no ghost to release, v2 SPEC 6.2)
    const running = entry('delegate:470:x', 'delegate', { agent: 'implementer', class: 'develop', issue: 470, status: 'running', endedAt: null, agentId: 'agent-1' })
    const swept = entry('sweep:0', 'sweep', { endedAt: NOW - MIN })
    const s: State = {
      ...withLedger(state({ control: control({ updateDue: { reason: 'image', at: NOW - MIN } }) }), [running, swept]),
      agents: [{ id: 'agent-1', type: 'callum-flow:implementer', status: 'running' }],
      v2: emptyV2State(NOW),
    }
    const { env, argvs } = envOf('v1', s.ledger)
    env.rt = { ...env.rt, config: config({ shadow: 'v2' }) }
    const acted = await actPass(env, s, { ok: true, agents: [{ id: 'agent-1', status: 'running' }] }, { answering: new Set(), completedSeen: new Map(), repairing: new Map() })
    expect(acted.result.actions.some(a => a.kind === 'restart-self')).toBe(false)
    expect(acted.shadow !== null && 'actions' in acted.shadow ? acted.shadow.actions.filter(a => a.kind === 'restart-self').map(a => a.rule) : []).toEqual(['R2'])
    expect(acted.report.outcomes.map(o => o.key)).toEqual(acted.result.actions.map(a => a.key))
    expect(argvs.some(a => a[0] === 'dev-restart-self')).toBe(false)
  })
})
