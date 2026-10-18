// The loop's v2 settings and driver (docs/factory-loop/v2/SPEC.md 2.3, appendix A, appendix E): the
// settings and where each comes from (the workspace file may set any key and wins; the repo's own
// come from origin's default branch), the retired `planner` and `shadow` keys, the plan call site
// (act.ts planPass); the dispatcher's v2 executors (registry.ts); and the driver end to end: the
// decision log's counts and sources, the records and heads in the store, and an owner op's
// intervention.
import { describe, expect, mock, test } from 'claude-code/testing'

import { EXECUTORS, actPass, ctxOf, dispatch, planPass, runActions } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { DEFAULT_CONFIG, RETIRED_KEYS, loadConfig } from '../hooks/config'
import type { ActIo } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { emptyV2State, recordsToStore } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { newSettingsCache, repoLoaded } from '../hooks/v2/settings'
import { V2_EXECUTORS } from '../hooks/v2/registry'
import { V2_ACTION_KINDS } from '../hooks/v2/types'
import type { IssueRecord } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, issue, state, withLedger } from './fixtures'
import { CFG_DIR, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host, iso, ENGINE_TEST } from './host'
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
    wait: null,
    lives: 1,
    ...over,
  }
}

describe('the settings (v2 SPEC appendix A)', () => {
  test('the defaults are v2\'s: the timeouts and limits are the spec\'s, and K is 3', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      stateTimeoutMs: { design: 45 * MIN, build: 90 * MIN, review: 30 * MIN, fix: 60 * MIN, triage: 15 * MIN, queued: 6 * HOUR, queueWait: 2 * HOUR, parked: 24 * HOUR },
      ciStartMs: 10 * MIN,
      ciRunMs: 30 * MIN,
      maxTriages: 2,
      maxLives: 3,
      triageModel: 'opus',
      reviewer: 'adjudicator',
      reviewerModel: 'opus',
      gateCommands: [],
      gateTimeoutMs: 10 * MIN,
      maxInFlightIssues: 3,
      reviewFixCap: 3,
    })
    // a step key is one attempt, an update and a merge are one per key, and a CI re-run's call is
    // tried three times (appendix B)
    expect(DEFAULT_CONFIG.maxAttempts).toMatchObject({ 'agent-step': 1, 'ci-rerun': 3, 'queue-update': 1, 'queue-merge': 1 })
  })

  test('each v2 key loads from its settings file, durations and all; a bad value is named and left out', () => {
    const r = loadConfig(
      {
        stateTimeout: { build: '2h', triage: '20m' },
        ciStart: '5m',
        maxTriages: 1,
        maxLives: 2,
        reviewerModel: 'sonnet',
        gateCommands: ['npm run lint', 'npm test'],
        gateTimeout: '15m',
      },
      { stateTimeoutMs: { design: 3_600_000 } },
    )
    expect(r.problems).toEqual([])
    expect(r.config).toMatchObject({
      stateTimeoutMs: { ...DEFAULT_CONFIG.stateTimeoutMs, build: 2 * HOUR, triage: 20 * MIN, design: HOUR },
      ciStartMs: 5 * MIN,
      maxTriages: 1,
      maxLives: 2,
      reviewerModel: 'sonnet',
      gateCommands: ['npm run lint', 'npm test'],
      gateTimeoutMs: 15 * MIN,
    })
    const bad = loadConfig({ maxTriages: 1.5, maxLives: 0, gateCommands: ['npm test', ''], stateTimeout: { review: 'soon', merge: '1h' } })
    expect(bad.problems).toEqual([
      'maxTriages: 1.5 is not a whole number',
      'maxLives: 0 is not a whole number of at least 1',
      'gateCommands: ["npm test",""] is not a list of commands',
      'stateTimeout.review: "soon" is not a duration (like 60s, 5m, 2h)',
      'stateTimeout.merge: unknown',
    ])
    expect(bad.config).toMatchObject({ maxTriages: 2, maxLives: 3, gateCommands: [], stateTimeoutMs: DEFAULT_CONFIG.stateTimeoutMs })
  })

  test('minimumReleaseCadence: 6h by default, a duration or ms of at least 1h, the workspace wins, anything else is one problem (#772)', () => {
    expect(loadConfig({}).config.minimumReleaseCadenceMs).toBe(21_600_000)
    expect(loadConfig({ minimumReleaseCadence: '3h' }).config.minimumReleaseCadenceMs).toBe(10_800_000)
    expect(loadConfig({ minimumReleaseCadence: '3h' }, { minimumReleaseCadence: '90m' })).toMatchObject({ problems: [], config: { minimumReleaseCadenceMs: 5_400_000 } })
    expect(loadConfig({ minimumReleaseCadence: 7_200_000 })).toMatchObject({ problems: [], config: { minimumReleaseCadenceMs: 7_200_000 } })
    for (const value of [0, '30m', 'soon', -1]) {
      const r = loadConfig({ minimumReleaseCadence: value })
      expect(r.problems).toEqual([`minimumReleaseCadence: ${JSON.stringify(value)} is not a duration of at least 1h (like 6h, 90m)`])
      expect(r.config.minimumReleaseCadenceMs).toBe(21_600_000)
    }
  })

  test('a model setting takes only an alias the agent tool accepts; any other is named and left out (R2-F8)', () => {
    expect(loadConfig({ reviewerModel: 'haiku', triageModel: 'sonnet' })).toMatchObject({ problems: [], config: { reviewerModel: 'haiku', triageModel: 'sonnet' } })
    const bad = loadConfig({ reviewerModel: 'claude-nonexistent-9', triageModel: 'Opus' })
    expect(bad.problems).toEqual([
      'reviewerModel: "claude-nonexistent-9" is not sonnet, opus, haiku or fable',
      'triageModel: "Opus" is not sonnet, opus, haiku or fable',
    ])
    expect(bad.config).toMatchObject({ reviewerModel: 'opus', triageModel: 'opus' })
  })

  test('no settings file (a new workspace): v2\'s defaults, K 3 and no problems', () => {
    for (const loaded of [loadConfig(), loadConfig({}), loadConfig({}, {})]) {
      expect(loaded.config).toMatchObject({ maxInFlightIssues: 3 })
      expect(loaded.problems).toEqual([])
    }
  })

  test('K is 3 unless a settings file sets it (v2 SPEC section 15)', () => {
    expect(loadConfig({ maxInFlightIssues: 2 }).config.maxInFlightIssues).toBe(2)
    expect(loadConfig({ maxInFlightIssues: 5 }, {}).config.maxInFlightIssues).toBe(5)
    expect(loadConfig({}, { maxInFlightIssues: 4 }).config.maxInFlightIssues).toBe(4)
    expect(loadConfig({ maxInFlightIssues: 'two' }).config.maxInFlightIssues).toBe(3)
  })

  test('planner and shadow are retired: a settings file that still sets them (any value, v1 too) loads, is ignored, and each is one problem', () => {
    expect(Object.keys(RETIRED_KEYS).sort()).toEqual(['planner', 'shadow'])
    const loaded = loadConfig({ planner: 'v1', shadow: 'v2' })
    expect(loaded.problems).toEqual([
      'planner: retired, the loop always plans with v2, and ignored',
      'shadow: retired, the loop always plans with v2, and ignored',
    ])
    // v2's defaults hold: nothing of v1 comes back (K is 3, not v1's 5)
    expect(loaded.config).toEqual(loadConfig().config)
    expect(loaded.config.maxInFlightIssues).toBe(3)
    expect('planner' in loaded.config || 'shadow' in loaded.config).toBe(false)
    // in either layer, with any value
    for (const [repo, workspace] of [[{ planner: 'v2' }, {}], [{}, { planner: 'v3' }], [{ shadow: 'off' }, {}], [{}, { shadow: 7 }]]) {
      const r = loadConfig(repo, workspace)
      expect(r.problems).toHaveLength(1)
      expect(r.problems[0]).toContain('retired')
      expect(r.config).toEqual(loadConfig().config)
    }
  })
})

// --- the plan call sites (act.ts planPass) ------------------------------------------------------------

describe('planPass: the planner is v2 (v2 SPEC 2.3)', () => {
  const s = (): State => ({ ...state({ queue: [7], issues: [issue(7)] }), v2: emptyV2State(NOW) })

  test('planPass is the v2 planner\'s plan, for any config the loader gives', () => {
    const cfg = loadConfig({}, {}).config
    expect(planPass(s(), cfg)).toEqual(planV2(s(), cfg))
    // a retired planner or shadow key in a settings file changes nothing
    const retired = loadConfig({ planner: 'v1', shadow: 'v2' }).config
    expect(planPass(s(), retired)).toEqual(planV2(s(), cfg))
  })

  test('O3 (v2) wakes the release review once per UTC hour, keyed by tag and hour, through the shared helper', () => {
    const cfg = config()
    const base: State = { ...state({ milestone: { open: 0, closed: 5, openIssues: [], expected: 'minor' }, release: { tag: 'v1.0.0', oldest: null } }), v2: emptyV2State(NOW) }
    const tasks = (s: State) => planV2(s, cfg).actions.filter(x => x.kind === 'task')
    expect(tasks(base)).toMatchObject([{ key: 'task:release:v1.0.0:2026-10-13T03', fields: { closed: '5', expected: 'minor', tag: 'v1.0.0', cadence: '6h' } }])
    const held = entry('task:release:v1.0.0:2026-10-13T03', 'task', { class: 'drive', wake: 'release', status: 'done', startedAt: NOW, endedAt: NOW + MIN })
    const after: State = { ...base, ledger: [...base.ledger, held] }
    expect(tasks(after)).toEqual([])
    expect(tasks({ ...after, release: { tag: 'v1.1.0', oldest: null } })).toEqual([])
    expect(tasks({ ...after, now: NOW + 60 * MIN }).map(x => x.key)).toEqual(['task:release:v1.0.0:2026-10-13T04'])
  })

  test('O3 (v2) with records waiting on a release tag: the review is due while the milestone has open items, its fields list the issues, once per UTC hour', () => {
    const cfg = config()
    const waitingOn = (issue: number, kind: 'tag-contains' | 'issue-closed') =>
      record({ issue, state: 'waiting', step: null, resumeTo: 'designing', wait: [kind === 'tag-contains' ? { kind, sha: '35bb655' } : { kind, issue: 99 }] })
    const open = state({ milestone: { open: 2, closed: 5, openIssues: [], expected: 'minor' }, release: { tag: 'v1.0.0', oldest: null } })
    const withRecords = (records: IssueRecord[], s: State = open): State => ({ ...s, v2: { ...emptyV2State(NOW), records } })
    const tasks = (s: State) => planV2(s, cfg).actions.filter(x => x.kind === 'task')
    // an issue condition or no waiting record leaves the due rule and fields as they were
    expect(tasks(withRecords([waitingOn(7, 'issue-closed')]))).toEqual([])
    const due = tasks(withRecords([waitingOn(9, 'tag-contains'), waitingOn(7, 'tag-contains'), waitingOn(8, 'issue-closed')]))
    expect(due).toMatchObject([{ key: 'task:release:v1.0.0:2026-10-13T03', fields: { tag: 'v1.0.0', waiting: '7,9' } }])
    // a record waiting only on another repo's release is not this judge's to answer
    const foreignTag = record({ issue: 6, state: 'waiting', step: null, resumeTo: 'designing', wait: [{ kind: 'tag-contains', sha: '35bb655', repo: 'o/n' }] })
    expect(tasks(withRecords([foreignTag]))).toEqual([])
    expect(tasks(withRecords([foreignTag, waitingOn(7, 'tag-contains')]))).toMatchObject([{ fields: { waiting: '7' } }])
    // a milestone with none closed is due too
    expect(tasks(withRecords([waitingOn(7, 'tag-contains')], state({ milestone: { open: 0, closed: 0, openIssues: [], expected: null } })))).toHaveLength(1)
    // at most one release task per UTC hour
    const held = entry('task:release:v1.0.0:2026-10-13T03', 'task', { class: 'drive', wake: 'release', status: 'done', startedAt: NOW, endedAt: NOW + MIN })
    expect(tasks(withRecords([waitingOn(7, 'tag-contains')], { ...open, ledger: [...open.ledger, held] }))).toEqual([])
    // a milestone source that is not readable stays no review
    expect(tasks(withRecords([waitingOn(7, 'tag-contains')], { ...open, milestone: null }))).toEqual([])
  })

  test('R2 restarts only on a pass that starts nothing else: a release task due in the same pass holds it, and the task\'s run holds it after (v2 SPEC 14.1)', () => {
    const cfg = config()
    const quiet: State = { ...state({ control: control({ updateDue: { reason: 'image', at: NOW - MIN } }) }), v2: emptyV2State(NOW) }
    expect(planV2(quiet, cfg).actions.at(-1)).toMatchObject({ kind: 'restart-self', rule: 'R2' })
    const release: State = { ...quiet, milestone: { open: 0, closed: 3, openIssues: [], expected: 'patch' } }
    const both = planV2(release, cfg)
    expect(both.actions.map(a => a.kind)).toEqual(['task', 'title'])
    expect(both.skipped).toContainEqual({ rule: 'R2', issue: null, why: 'update due: this pass starts task:release:unknown:2026-10-13T03 first' })
    const running = entry('task:release:unknown:2026-10-13T03', 'task', { class: 'drive', wake: 'release', status: 'running', endedAt: null })
    const after = planV2({ ...release, ledger: [...release.ledger, running] }, cfg)
    expect(after.actions.some(a => a.kind === 'restart-self')).toBe(false)
    expect(after.skipped).toContainEqual({ rule: 'R2', issue: null, why: 'update due: waiting on task:release:unknown:2026-10-13T03' })
  })

  test('the v2 planner with no v2 fields read plans no rule, and says why', () => {
    const r = planV2(state(), config())
    expect(r.skipped).toContainEqual({ rule: 'G2', issue: null, why: 'v2 sources not read' })
    expect(r.actions.map(a => a.kind)).toEqual(['title'])
  })
})

// --- the dispatcher (v2 registry) ---------------------------------------------------------------------------

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
    config: config(),
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

function envOf(ledger: LedgerEntry[] = []): { env: ActEnv; argvs: string[][]; spawns: string[] } {
  const { io, argvs, spawns } = recording()
  const env: ActEnv = { io, rt: runtime(), live: { ledger }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return { env, argvs, spawns }
}

describe('the dispatcher: v2\'s executors (v2 SPEC 2.2, appendix B)', () => {
  test('every new kind has its executor in the registry, and the act step\'s map holds it', () => {
    expect(V2_ACTION_KINDS.filter(kind => V2_EXECUTORS[kind] === undefined)).toEqual([])
    for (const kind of V2_ACTION_KINDS) expect(EXECUTORS[kind]).toBe(V2_EXECUTORS[kind])
  })

  test('a v2 kind runs its own executor, and a shared kind keeps its shared executor', async () => {
    const pr: Action = { kind: 'pr', key: 'i470/ltbq3k0/s4/pr/ensure', class: 'free', rule: 'S2', reason: 'x', issue: 470, op: 'ensure', branch: 'issue-470', base: 'main', pr: null, title: 't', summary: 's', evidence: null, brief: null }
    const sweep: Action = { kind: 'sweep', key: 'sweep:0', class: 'free', rule: 'H2', reason: 'x', issue: null }
    {
      const { env, argvs } = envOf()
      const s = state()
      // the pr executor (U5) lists the branch's PRs first; an answer not in its shape fails, and is retried
      expect(await dispatch(ctxOf(env, s, start([], pr, NOW).entry), pr)).toMatchObject({ status: 'failed', summary: 'the PRs of issue-470 did not read' })
      expect(argvs).toEqual([['gh', 'pr', 'list', '--repo', REPO, '--head', 'issue-470', '--state', 'all', '--json', 'number,state,headRefOid']])
      argvs.length = 0
      expect(await dispatch(ctxOf(env, s, start([], sweep, NOW).entry), sweep)).toMatchObject({ status: 'done' })
      expect(argvs).toEqual([['callum-flow-sweep']])
    }
  })

  test('the GitHub backoff of a pass that met a rate limit holds the planner\'s GitHub kinds', async () => {
    const limited = () => {
      const { env, argvs } = envOf()
      env.io.run = async argv => {
        argvs.push([...argv])
        return argv[0] === 'callum-flow-claim' ? { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' } : { exitCode: 0, stdout: '', stderr: '' }
      }
      return { env, argvs }
    }
    const claim: Action = { kind: 'claim', key: 'claim:7:new', class: 'start', rule: 'S1', reason: 'x', issue: 7 }
    const label: Action = { kind: 'label', key: 'i8/l1/s1/label', class: 'free', rule: 'S3', reason: 'x', issue: 8, op: 'set', label: 'factory:queued' }
    const v2 = limited()
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
  test('observe mode: v2 plans and its plan is logged; no runs, no reflogs, nothing kept', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, checkout: '/work' }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'observe', executed: false, planner: 'v2', transitions: [], counts: { queue: 0, queued: 0, flight: 0, parked: 0, owner: 0 } })
    // the workspace file's planner is a setting it may set, so nothing is named
    expect(line.config).toBeUndefined()
    expect(line.shadow).toBeUndefined()
    expect(sources(line)).toMatchObject({ runs: 'failed: not read: the loop has no pipeline runs', 'v2.leases': 'ok', 'v2.store': 'ok', 'v2.prs': 'ok' })
    expect(h.titles).toEqual(['🔄 dev-system (Q:0 - D:0 - M:0) · observe'])
    expect(h.commands().some(c => c.argv[0]?.endsWith('pipeline-watch.sh'))).toBe(false)
    expect(h.commands().some(c => c.argv.includes('reflog'))).toBe(false)
    expect([...h.store.keys()]).toEqual([])
  })

  test('v2\'s own GitHub reads have budgets of their own: a pass whose issue reads took all 12 still reads an unparked record\'s comments (v2 SPEC 2.4)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const parked = record({ issue: 80, state: 'parked', step: null, since: NOW - HOUR, question: 'which API?' })
    const issue80 = { issue: { number: 80, title: 'x', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }
    const reads = (argv: string[]) => (argv.join(' ') === 'callum-flow-issue-read --json 80' ? { stdout: JSON.stringify(issue80) } : undefined)
    const queue = Array.from({ length: 14 }, (_, i) => 100 + i)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work' },
      store: { [`records:${REPO}`]: recordsToStore([parked], NOW - MIN) },
      run: world({ queue, run: reads }),
    })
    await $.session.start(START)
    await clock.advance(6_000)
    const issueReads = h.commands().filter(c => c.argv[0] === 'callum-flow-issue-read' && c.argv.includes('--issues'))
    // one batched call for the pass's 12 due issues (the cap), the parked record's issue first
    expect(issueReads).toHaveLength(1)
    const asked = (issueReads[0]?.argv[3] ?? '').split(',')
    expect(asked).toHaveLength(12)
    expect(asked[0]).toBe('80')
    // and its comments still came after the 12
    expect(h.commands().filter(c => c.argv.join(' ') === 'callum-flow-issue-read --json 80 --comments')).toHaveLength(1)
  })

  test('act mode with planner v2 reads its records from the store, counts them, and keeps the store\'s records as they are', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const stored = recordsToStore([record(), record({ issue: 471, state: 'parked', step: null, question: 'which API?' })], NOW - MIN)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work' },
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

  test('the workspace file may set any setting, and wins over the repo\'s; its runtime keys are not settings', ENGINE_TEST, async ($, on) => {
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

  // the repo's settings are origin's default branch's (origin/HEAD names it, else
  // main); the tree's stand only when origin's cannot be read, and the decision log says so
  const NOT_READ = "settings: origin's default branch not read (origin/main: fatal: invalid object name 'origin/main'.); the main checkout's file is used"
  const showCases: [string, { exitCode?: number; stdout?: string; stderr?: string }, string, string[] | undefined][] = [
    ['origin has the file', { stdout: JSON.stringify({ readyLabel: 'from-origin' }) }, 'from-origin', undefined],
    ['origin has none', { exitCode: 128, stderr: "fatal: path '.claude/factory-loop.json' does not exist in 'origin/main'" }, 'ready', undefined],
    ['origin cannot be read', { exitCode: 128, stderr: "fatal: invalid object name 'origin/main'." }, 'from-tree', [NOT_READ]],
  ]
  for (const [name, show, label, problems] of showCases) {
    test(`the repo's settings are origin's default branch's: ${name}`, ENGINE_TEST, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const run = world({ run: argv => (argv.join(' ') === 'git show origin/main:.claude/factory-loop.json' ? show : undefined) })
      const h = host(on, { config: { repo: REPO, checkout: '/work' }, files: { '/work/.claude/factory-loop.json': JSON.stringify({ readyLabel: 'from-tree' }) }, run })
      await $.session.start(START)
      await clock.advance(6_000)
      expect(h.seen.some(s => s.argv.join(' ') === `callum-flow-issue-read --json --list --label ${label}`)).toBe(true)
      expect(h.last().config).toEqual(problems)
    })
  }

  test('with no origin/HEAD, origin\'s default branch is taken to be main', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const run = world({
      run: argv => {
        const line = argv.join(' ')
        if (line === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') return { exitCode: 1, stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref' }
        return line === 'git show origin/main:.claude/factory-loop.json' ? { stdout: JSON.stringify({ readyLabel: 'from-main' }) } : undefined
      },
    })
    const h = host(on, { config: { repo: REPO, checkout: '/work' }, files: { '/work/.claude/factory-loop.json': JSON.stringify({}) }, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.seen.some(s => s.argv.join(' ') === 'callum-flow-issue-read --json --list --label from-main')).toBe(true)
  })

  test('repoLoaded: the repo settings are origin\'s (#794)', async () => {
    const asked: string[] = []
    const io = {
      run: async (argv: string[]) => {
        asked.push(argv.join(' '))
        return argv[1] === 'show' ? { exitCode: 0, stdout: JSON.stringify({ readyLabel: 'from-origin' }), stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }
      },
      now: async () => NOW,
    }
    const r = await repoLoaded(io, newSettingsCache(), '/work', { readyLabel: 'from-tree' }, {})
    expect(asked).toContain('git show origin/main:.claude/factory-loop.json')
    expect(r.config).toMatchObject({ readyLabel: 'from-origin' })
    // a retired planner key in the workspace file changes nothing: the repo settings are still origin's
    const retired = await repoLoaded(io, newSettingsCache(), '/work', { readyLabel: 'from-tree' }, { planner: 'v1' })
    expect(retired.config.readyLabel).toBe('from-origin')
    expect(retired.problems).toEqual(['planner: retired, the loop always plans with v2, and ignored'])
  })

  test('act mode: a records store that cannot be read is no records known, not none; nothing that releases or starts is planned, and nothing is written over it', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const stored = recordsToStore([record()], NOW - MIN)
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work' },
      store: { [`records:${REPO}`]: stored },
      run: world({ queue: [7], issues: [{ issue: 470, stage: 'implementing', entered_at: iso(NOW - HOUR), holder: DEVICE, run: null, pr: null, stuck: null, github: null }] }),
    })
    let down = true
    h.failGet = key => down && key === `records:${REPO}`
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: true })
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

  test('an owner op in act mode is logged as an intervention (act-events.ts, U4)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    const r = await $.command.run({ command: 'factory', args: 'pause 12', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(r.text).toBe('Paused #12: no action on it until unpause; its claim still renews.')
    await clock.advance(1_000)
    const control = h.lines().find(l => l.control === 'pause 12')
    expect(control?.problems).toBeUndefined()
    const logged = h.seen.filter(s => s.argv[0] === 'callum-flow-event' && s.argv[1] === 'intervention').map(s => s.argv.slice(2, 4).concat((s.argv.at(-1) ?? '').split(' ').slice(0, 2)))
    expect(logged).toEqual([['--issue', '12', 'who=person', 'cause=op:pause']])
  })

  test('act mode: a load after an earlier run is a person\'s restart, logged once and attached to no issue; a first start restarts nothing (v2 SPEC 7.2)', ENGINE_TEST, async ($, on) => {
    const restarts = (h: ReturnType<typeof host>) => h.seen.filter(s => s.argv[0] === 'callum-flow-event' && s.argv[1] === 'intervention' && (s.argv.at(-1) ?? '').includes('cause=restart'))
    const clock = mock.clock(on, { now: NOW })
    const earlier = { v: 1, savedAt: NOW - 30 * MIN, entries: [entry('sweep:0', 'sweep', { startedAt: NOW - 30 * MIN, endedAt: NOW - 30 * MIN })] }
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: world(), store: { [`ledger:${REPO}`]: earlier } })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(61_000)
    const logged = restarts(h)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.argv.includes('--issue')).toBe(false)
    expect(logged[0]?.argv.at(-1)).toMatch(/^who=person cause=restart life=none fact=restart\/fleet\/[0-9a-z]+ reason=/)
  })

  test('act mode: the first start of a loop with no ledger logs no restart', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: world() })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(61_000)
    expect(h.seen.filter(s => s.argv[0] === 'callum-flow-event' && s.argv[1] === 'intervention')).toEqual([])
  })

  test('an issue a person closes with its PR closes (E2), without parking first: the PR read makes the issue read due, and E4 waits for it (v2 SPEC 4.1; drill run 2, R2-F2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const head = 'a'.repeat(40)
    const mq = record({ state: 'merge-queue', step: 'queue', pr: 900, head, approvedPatch: 'p1' })
    let closedAt: string | null = null
    const issue470 = () => ({ issue: { number: 470, title: 'x', state: closedAt === null ? 'open' : 'closed', labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 })
    const pr900 = () => ({ pr: { state: closedAt === null ? 'open' : 'closed', merged: false, merged_at: null, closed_at: closedAt, head: { sha: head }, base: { ref: 'main' }, user: { login: 'cbundy' }, mergeable_state: 'clean' }, stripped: 0 })
    const reads = (argv: string[]) => {
      const line = argv.join(' ')
      if (line === 'callum-flow-issue-read --json 470') return { stdout: JSON.stringify(issue470()) }
      if (line === 'callum-flow-issue-read --json --pr 900') return { stdout: JSON.stringify(pr900()) }
      return undefined
    }
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, store: { [`records:${REPO}`]: recordsToStore([mq], NOW - MIN) }, run: world({ run: reads }) })
    await $.session.start(START)
    await clock.advance(6_000)
    // a person closes the issue, then its PR, between two passes
    closedAt = iso(NOW + 20_000)
    const reasons: string[] = []
    for (let i = 0; i < 3; i++) {
      await clock.advance(61_000)
      reasons.push(...((h.last().actions as { reason: string }[] | undefined) ?? []).map(a => a.reason))
    }
    expect(reasons.filter(r => /park/.test(r))).toEqual([])
    expect(reasons).toContain('intervention: person issue-closed')
    // one transition, E2: the checks read this world does not answer is one failed read, which holds
    // (it once ended the step unknown at once, as the seq was ciStartMs old)
    expect((h.store.get(`records:${REPO}`) as { records: IssueRecord[] }).records.find(r => r.issue === 470)).toMatchObject({ state: 'closed', why: 'closed-on-github', seq: 5 })
  })

})
