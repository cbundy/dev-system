// The default branch's state (docs/factory-loop/v2/SPEC.md 2.4, 9.5, 14.1 M1): the `main` source
// (sources-main.ts) reads the head, the merged PR, each workflow's newest completed run and each
// deployment's newest status; rule M1 (rules-main.ts) logs one `main_state` event per change of that
// state from the last one logged, keyed main/<last>/<current>.
import { describe, expect, test } from 'claude-code/testing'

import { loadConfig } from '../hooks/config'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { eventArgv } from '../hooks/v2/events'
import { validateStrict } from '../hooks/v2/event-reader'
import { emptyV2State } from '../hooks/v2/observe'
import type { SourceCtx } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { changedOf, fnv1a, lastLogged, stateKeyOf } from '../hooks/v2/rules-main'
import { EMPTY_MAIN, parseBranch, parseDeployments, parseHead, parsePr, parseRuns, parseStatus, parseWorkflows, readMain } from '../hooks/v2/sources-main'
import type { MainCache } from '../hooks/v2/sources-main'
import type { MainReading, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const sha = (c: string) => c.repeat(40)
const H1 = sha('a')
const H2 = sha('b')
const OK = { ok: true, at: NOW }
const CFG = config({ mode: 'act' })

describe('the parsers', () => {
  const run = (over: Record<string, unknown>) => ({ id: 1, run_attempt: 1, head_sha: H1, event: 'push', status: 'completed', conclusion: 'success', ...over })
  const RUNS = (...runs: unknown[]) => JSON.stringify({ workflow_runs: runs })

  test('the branch and the head', () => {
    expect(parseBranch('main\n')).toBe('main')
    expect(parseBranch('')).toBeNull()
    expect(parseBranch('two words')).toBeNull()
    expect(parseHead(`${H1}\n`)).toBe(H1)
    expect(parseHead('abc')).toBeNull()
    expect(parseHead('{"sha":1}')).toBeNull()
  })

  test('runs: the newest completed run, with an open run newer than it, only queued runs, or none', () => {
    expect(parseRuns(RUNS(run({ id: 9, run_attempt: 2 }), run({ id: 8 })))).toEqual({ run: { id: 9, attempt: 2, head: H1, event: 'push', conclusion: 'success' }, running: false })
    expect(parseRuns(RUNS(run({ id: 10, status: 'in_progress', conclusion: null }), run({ id: 9 })))?.running).toBe(true)
    expect(parseRuns(RUNS(run({ id: 10, status: 'in_progress', conclusion: null }), run({ id: 9 })))?.run?.id).toBe(9)
    // an open run older than the newest completed one does not count
    expect(parseRuns(RUNS(run({ id: 10 }), run({ id: 9, status: 'queued', conclusion: null })))?.running).toBe(false)
    for (const status of ['queued', 'waiting', 'requested', 'pending']) expect(parseRuns(RUNS(run({ status, conclusion: null }), run({ id: 2 })))?.running).toBe(true)
    expect(parseRuns(RUNS(run({ status: 'queued', conclusion: null })))).toEqual({ run: null, running: true })
    expect(parseRuns(RUNS())).toEqual({ run: null, running: false })
  })

  test('a re-run in progress (the same run id, a newer attempt) counts as running', () => {
    const r = parseRuns(RUNS(run({ id: 5, run_attempt: 2, status: 'in_progress', conclusion: null }), run({ id: 4 })))
    expect(r?.running).toBe(true)
    expect(r?.run?.id).toBe(4)
  })

  test('deployments: the newest of each environment, and each status', () => {
    const list = JSON.stringify([{ id: 5, environment: 'prod' }, { id: 7, environment: 'prod' }, { id: 6, environment: 'staging' }])
    expect(parseDeployments(list)).toEqual([{ environment: 'prod', id: 7 }, { environment: 'staging', id: 6 }])
    expect(parseDeployments('[]')).toEqual([])
    expect(parseStatus('[]')).toEqual({ state: null })
    expect(parseStatus('[{"state":"success"}]')).toEqual({ state: 'success' })
    expect(parseStatus('[{"state":"in_progress"}]')).toEqual({ state: 'in_progress' })
  })

  test('the PR: the merged one into the branch, none, or one into another base', () => {
    const pr = (number: number, merged_at: string | null, ref: string) => ({ number, merged_at, base: { ref } })
    expect(parsePr(JSON.stringify([pr(141, '2026-10-19T08:00:00Z', 'main')]), 'main')).toEqual({ pr: 141 })
    expect(parsePr('[]', 'main')).toEqual({ pr: null })
    expect(parsePr(JSON.stringify([pr(141, '2026-10-19T08:00:00Z', 'release')]), 'main')).toEqual({ pr: null })
    expect(parsePr(JSON.stringify([pr(141, null, 'main')]), 'main')).toEqual({ pr: null })
  })

  test('the active workflows only', () => {
    const text = JSON.stringify({ workflows: [{ id: 2, name: 'deploy', state: 'active' }, { id: 1, name: 'ci', state: 'active' }, { id: 3, name: 'old', state: 'disabled_manually' }] })
    expect(parseWorkflows(text)).toEqual([{ id: 1, name: 'ci' }, { id: 2, name: 'deploy' }])
  })

  test('output that is not understood is null', () => {
    for (const bad of ['', 'not json', '{}', '"x"', '[1]', 'null']) {
      expect(parsePr(bad, 'main')).toBeNull()
      expect(parseWorkflows(bad)).toBeNull()
      expect(parseRuns(bad)).toBeNull()
      expect(parseDeployments(bad)).toBeNull()
      expect(parseStatus(bad)).toBeNull()
    }
    expect(parseRuns(RUNS(run({ conclusion: null })))).toBeNull()
    expect(parseRuns(RUNS(run({ head_sha: 'x' })))).toBeNull()
    expect(parseStatus('[{"state":5}]')).toBeNull()
    expect(parseDeployments('[{"id":1}]')).toBeNull()
  })
})

// A fake GitHub: the answers of each call the source makes, changeable between reads.
type Hub = { head: string; pulls: string; workflows: string; runs: Record<number, string>; deployments: string; statuses: Record<number, string>; fail: (path: string) => 'exit' | 'garbage' | null }
function hub(over: Partial<Hub> = {}): Hub {
  const runs = (c: string) => JSON.stringify({ workflow_runs: [{ id: 9001, run_attempt: 1, head_sha: H1, event: 'push', status: 'completed', conclusion: c }] })
  return {
    head: H1,
    pulls: JSON.stringify([{ number: 141, merged_at: '2026-10-19T08:00:00Z', base: { ref: 'main' } }]),
    workflows: JSON.stringify({ workflows: [{ id: 1001, name: 'ci', state: 'active' }, { id: 1002, name: 'deploy', state: 'active' }] }),
    runs: { 1001: runs('success'), 1002: runs('success') },
    deployments: JSON.stringify([{ id: 501, environment: 'production' }]),
    statuses: { 501: '[{"state":"success"}]' },
    fail: () => null,
    ...over,
  }
}

function reply(h: Hub, argv: string[]): { exitCode?: number; stdout: string } {
  const path = argv[2] ?? ''
  const f = h.fail(path)
  if (f === 'exit') return { exitCode: 1, stdout: '' }
  if (f === 'garbage') return { stdout: 'garbage' }
  if (path === `repos/${REPO}`) return { stdout: 'main\n' }
  if (path === `repos/${REPO}/commits/main`) return { stdout: `${h.head}\n` }
  if (path.endsWith('/pulls')) return { stdout: h.pulls }
  if (path.includes('/actions/workflows?')) return { stdout: h.workflows }
  const runs = /actions\/workflows\/(\d+)\/runs/.exec(path)
  if (runs) return { stdout: h.runs[Number(runs[1])] ?? '' }
  if (path.includes('/deployments?')) return { stdout: h.deployments }
  const status = /deployments\/(\d+)\/statuses/.exec(path)
  if (status) return { stdout: h.statuses[Number(status[1])] ?? '' }
  return { exitCode: 1, stdout: '' }
}

function ctxOf(h: Hub, over: Partial<SourceCtx> = {}, mode: Runtime['mode'] = 'act', cfg = CFG) {
  const argvs: string[][] = []
  const rt: Runtime = { mode, repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: cfg, configProblems: [] }
  const ctx: SourceCtx = {
    now: NOW,
    rt,
    run: async argv => {
      argvs.push([...argv])
      return { exitCode: 0, stderr: '', ...reply(h, argv) }
    },
    readFile: async () => null,
    state: baseState(),
    records: [],
    heads: {},
    prBudget: 3,
    limited: () => false,
    unread: [],
    kept: [],
    tag: null,
    tags: {},
    ...over,
  }
  return { ctx, argvs }
}

describe('the main source (sources-main.ts)', () => {
  test('the first read makes the calls in order', async () => {
    const { ctx, argvs } = ctxOf(hub())
    const r = await readMain(ctx, EMPTY_MAIN)
    expect(argvs).toEqual([
      ['gh', 'api', `repos/${REPO}`, '--jq', '.default_branch'],
      ['gh', 'api', `repos/${REPO}/commits/main`, '--jq', '.sha'],
      ['gh', 'api', `repos/${REPO}/commits/${H1}/pulls`],
      ['gh', 'api', `repos/${REPO}/actions/workflows?per_page=100`],
      ['gh', 'api', `repos/${REPO}/actions/workflows/1001/runs?branch=main&per_page=10`],
      ['gh', 'api', `repos/${REPO}/actions/workflows/1002/runs?branch=main&per_page=10`],
      ['gh', 'api', `repos/${REPO}/deployments?sha=${H1}&per_page=100`],
      ['gh', 'api', `repos/${REPO}/deployments/501/statuses?per_page=1`],
    ])
    expect(r.source).toEqual({ ok: true, at: NOW })
    expect(r.read.reading).toEqual({
      observedAt: new Date(NOW).toISOString(),
      branch: 'main',
      head: H1,
      pr: 141,
      workflows: [
        { id: 1001, name: 'ci', run: { id: 9001, attempt: 1, head: H1, event: 'push', conclusion: 'success' }, running: false },
        { id: 1002, name: 'deploy', run: { id: 9001, attempt: 1, head: H1, event: 'push', conclusion: 'success' }, running: false },
      ],
      deployments: [{ environment: 'production', id: 501, state: 'success' }],
    })
  })

  test('the default branch is read once per load, the PR only when the head moved', async () => {
    const h = hub()
    const first = await readMain(ctxOf(h).ctx, EMPTY_MAIN)
    const same = ctxOf(h, { now: NOW + 5 * MIN })
    const second = await readMain(same.ctx, first.read)
    expect(same.argvs.map(a => a[2])).not.toContain(`repos/${REPO}`)
    expect(same.argvs.some(a => a[2]?.endsWith('/pulls'))).toBe(false)
    expect(second.read.reading?.pr).toBe(141)
    h.head = H2
    h.pulls = JSON.stringify([{ number: 142, merged_at: '2026-10-19T09:00:00Z', base: { ref: 'main' } }])
    const moved = ctxOf(h, { now: NOW + 10 * MIN })
    const third = await readMain(moved.ctx, second.read)
    expect(moved.argvs.some(a => a[2] === `repos/${REPO}/commits/${H2}/pulls`)).toBe(true)
    expect(third.read.reading).toMatchObject({ head: H2, pr: 142 })
  })

  test('no call before mainEveryMs: the last reading stands', async () => {
    const first = await readMain(ctxOf(hub()).ctx, EMPTY_MAIN)
    const soon = ctxOf(hub(), { now: NOW + 5 * MIN - 1 })
    const again = await readMain(soon.ctx, first.read)
    expect(soon.argvs).toEqual([])
    expect(again.read).toBe(first.read)
    expect(again.source).toEqual(first.source)
    const due = ctxOf(hub(), { now: NOW + 5 * MIN })
    await readMain(due.ctx, first.read)
    expect(due.argvs.length).toBeGreaterThan(0)
  })

  test('no call during a backoff, once limited, or outside act mode', async () => {
    const kept: MainCache = (await readMain(ctxOf(hub()).ctx, EMPTY_MAIN)).read
    const later = NOW + 10 * MIN
    const backoff = ctxOf(hub(), { now: later, state: baseState({ githubBackoffUntil: later + MIN }) })
    expect((await readMain(backoff.ctx, kept)).read).toBe(kept)
    expect(backoff.argvs).toEqual([])
    const limited = ctxOf(hub(), { now: later, limited: () => true })
    expect((await readMain(limited.ctx, EMPTY_MAIN)).read).toBe(EMPTY_MAIN)
    expect(limited.argvs).toEqual([])
    for (const mode of ['observe', 'off'] as const) {
      const other = ctxOf(hub(), { now: later }, mode)
      expect((await readMain(other.ctx, EMPTY_MAIN)).read).toBe(EMPTY_MAIN)
      expect(other.argvs).toEqual([])
    }
  })

  test('a rate limit met part way ends the read and keeps the last one', async () => {
    const kept = (await readMain(ctxOf(hub()).ctx, EMPTY_MAIN)).read
    let calls = 0
    const { ctx } = ctxOf(hub(), { now: NOW + 10 * MIN, limited: () => ++calls > 3 })
    const r = await readMain(ctx, kept)
    expect(r.read).toBe(kept)
    expect(r.source.ok).toBe(true)
  })

  test('one failing call, of any of them, fails the whole read: no reading, the error in the source', async () => {
    for (const how of ['exit', 'garbage'] as const) {
      for (const needle of ['/commits/main', '/pulls', '/actions/workflows?', '/workflows/1002/runs', '/deployments?', '/statuses']) {
        const h = hub({ fail: path => (path.includes(needle) ? how : null) })
        const r = await readMain(ctxOf(h).ctx, EMPTY_MAIN)
        expect([needle, r.source.ok, r.read.reading]).toEqual([needle, false, null])
        expect(r.source.error ?? '').not.toBe('')
      }
    }
    // a head that is not a sha is not understood either
    const r = await readMain(ctxOf(hub({ head: 'oops' })).ctx, EMPTY_MAIN)
    expect([r.source.ok, r.read.reading]).toEqual([false, null])
  })

  test('a failed read after a good one leaves no reading, and the next read is due after mainEveryMs', async () => {
    const good = (await readMain(ctxOf(hub()).ctx, EMPTY_MAIN)).read
    const bad = await readMain(ctxOf(hub({ fail: p => (p.includes('/pulls') || p.includes('/statuses') ? 'exit' : null), head: H2 }), { now: NOW + 5 * MIN }).ctx, good)
    expect([bad.source.ok, bad.read.reading]).toEqual([false, null])
    const idle = ctxOf(hub(), { now: NOW + 6 * MIN })
    const kept = await readMain(idle.ctx, bad.read)
    expect(idle.argvs).toEqual([])
    expect(kept.source.ok).toBe(false)
    const retried = await readMain(ctxOf(hub({ head: H2 }), { now: NOW + 10 * MIN }).ctx, bad.read)
    expect(retried.read.reading?.head).toBe(H2)
  })
})

describe('mainEveryMs', () => {
  test('defaults to 5 minutes, takes any positive duration, and a bad value is a problem', () => {
    expect(loadConfig().config.mainEveryMs).toBe(5 * MIN)
    const ok = loadConfig({ mainEvery: '10m' })
    expect([ok.config.mainEveryMs, ok.problems]).toEqual([10 * MIN, []])
    const bad = loadConfig({ mainEvery: 'x' })
    expect([bad.config.mainEveryMs, bad.problems.length]).toEqual([5 * MIN, 1])
  })
})

describe('rule M1 (rules-main.ts)', () => {
  const reading = (over: Partial<MainReading> = {}): MainReading => ({
    observedAt: new Date(NOW).toISOString(),
    branch: 'main',
    head: H1,
    pr: 141,
    workflows: [{ id: 1001, name: 'ci', run: { id: 9001, attempt: 1, head: H1, event: 'push', conclusion: 'success' }, running: false }],
    deployments: [{ environment: 'production', id: 501, state: 'success' }],
    ...over,
  })
  const withRun = (attempt: number, conclusion = 'success') => [{ id: 1001, name: 'ci', run: { id: 9001, attempt, head: H1, event: 'push', conclusion }, running: false }]

  function world(main: MainReading | undefined, ledger: LedgerEntry[] = []): State {
    const s = baseState({ ledger: [...baseState().ledger, ...ledger] })
    const v2: V2State = { ...emptyV2State(NOW), sources: { ...emptyV2State(NOW).sources, store: OK, main: OK }, ...(main === undefined ? {} : { main }) }
    return { ...s, v2 }
  }
  const events = (s: State): Extract<Action, { kind: 'event' }>[] => planV2(s, CFG).actions.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.rule === 'M1')
  // the plan's event done, as the executor leaves it in the ledger
  const done = (a: Extract<Action, { kind: 'event' }>, at = NOW): LedgerEntry => entry(a.key, 'event', { rule: 'M1', startedAt: at, endedAt: at })
  const data = (a: Extract<Action, { kind: 'event' }> | undefined) => (a?.event.state === 'main_state' ? a.event.data : null)

  test('the first reading logs one event, changed first, keyed main/none/<state>', () => {
    const m = reading()
    const [a, ...rest] = events(world(m))
    expect(rest).toEqual([])
    expect(a?.key).toBe(`main/none/${stateKeyOf(m)}`)
    expect(a?.class).toBe('free')
    expect(a?.issue).toBeNull()
    expect(a?.reason).toContain('first')
    expect(a?.reason).toContain('green')
    expect(data(a)).toMatchObject({ changed: 'first', green: true, branch: 'main', head: H1, pr: 141, observed_at: new Date(NOW).toISOString() })
  })

  test('the same reading next pass, with that entry done, logs none; nor does a restart (the ledger kept)', () => {
    const m = reading()
    const [a] = events(world(m))
    expect(events(world(m, [done(a as never)]))).toEqual([])
  })

  test('a new head, a new attempt and a deployment change each log one, changed head, workflow or deploy', () => {
    const m = reading()
    const [a] = events(world(m))
    const ledger = [done(a as never)]
    expect(data(events(world(reading({ head: H2 }), ledger))[0])?.changed).toBe('head')
    expect(data(events(world(reading({ workflows: withRun(2) }), ledger))[0])?.changed).toBe('workflow')
    expect(data(events(world(reading({ deployments: [{ environment: 'production', id: 501, state: 'failure' }] }), ledger))[0])?.changed).toBe('deploy')
    const next = events(world(reading({ head: H2 }), ledger))
    expect(next).toHaveLength(1)
    expect(next[0]?.key).toBe(`main/${stateKeyOf(m)}/${stateKeyOf(reading({ head: H2 }))}`)
  })

  test('the first part that differs names the change when several do', () => {
    const [a] = events(world(reading()))
    const both = reading({ head: H2, workflows: withRun(2) })
    expect(data(events(world(both, [done(a as never)]))[0])?.changed).toBe('head')
    const wd = reading({ workflows: withRun(2), deployments: [] })
    expect(data(events(world(wd, [done(a as never)]))[0])?.changed).toBe('workflow')
  })

  test('A then B then A logs three events', () => {
    const A = reading()
    const B = reading({ head: H2 })
    const [e1] = events(world(A))
    const l1 = [done(e1 as never, NOW - 3 * MIN)]
    const [e2] = events(world(B, l1))
    const l2 = [...l1, done(e2 as never, NOW - 2 * MIN)]
    const [e3] = events(world(A, l2))
    expect([e1?.key, e2?.key, e3?.key]).toEqual([`main/none/${stateKeyOf(A)}`, `main/${stateKeyOf(A)}/${stateKeyOf(B)}`, `main/${stateKeyOf(B)}/${stateKeyOf(A)}`])
    // the last logged is the newest done entry's: B after e2, A after e3
    expect(lastLogged([...baseState().ledger, ...l2])).toBe(stateKeyOf(B))
    expect(lastLogged([...baseState().ledger, ...l2, done(e3 as never)])).toBe(stateKeyOf(A))
    expect(events(world(A, [...l2, done(e3 as never)]))).toEqual([])
  })

  test('an entry that is not done is not the last logged; an unfinished one is not planned twice', () => {
    const m = reading()
    const [a] = events(world(m))
    const running = entry(a?.key ?? '', 'event', { rule: 'M1', status: 'running', endedAt: null, startedAt: NOW - 1000 })
    expect(events(world(m, [running]))).toEqual([])
    expect(lastLogged([running])).toBe('none')
  })

  test('a pass with no reading (a failed or skipped read) logs nothing', () => {
    expect(events(world(undefined))).toEqual([])
  })

  test('a ledger pruned after 7 steady days logs the steady state once more, as first', () => {
    const m = reading()
    const [a] = events(world(m))
    expect(data(a)?.changed).toBe('first')
    expect(events(world(m, []))).toHaveLength(1)
  })

  test('it plans whatever the store\'s state', () => {
    const s = world(reading())
    const bad = { ...s, v2: { ...(s.v2 as V2State), sources: { ...(s.v2 as V2State).sources, store: { ok: false, at: null, error: 'down' } } } }
    expect(events(bad)).toHaveLength(1)
  })

  test('changedOf and the digest', () => {
    expect(fnv1a('')).toBe('811c9dc5')
    expect(fnv1a('a')).toBe('e40c292c')
    expect(changedOf('none', 'aaaaaaaa.bbbbbbbb.cccccccc')).toBe('first')
    expect(changedOf('aaaaaaaa.bbbbbbbb.cccccccc', 'aaaaaaaa.bbbbbbbb.dddddddd')).toBe('deploy')
  })

  test('the data of each event passes main_state.v1 strictly, and its argv has no --issue', () => {
    const cases = [
      reading(),
      reading({ pr: null, workflows: [{ id: 1001, name: 'ci', run: null, running: true }], deployments: [] }),
      reading({ workflows: withRun(3, 'failure'), deployments: [{ environment: 'production', id: 501, state: null }] }),
    ]
    for (const m of cases) {
      const [a] = events(world(m))
      expect(validateStrict('main_state', 1, data(a))).toEqual([])
      if (a?.event === undefined) throw new Error('no event')
      const argv = eventArgv(a.event)
      expect(argv.slice(0, 4)).toEqual(['fabriek-event', '--type', 'main_state', '--data'])
      expect(argv).not.toContain('--issue')
      expect(JSON.parse(argv[4] ?? '')).toEqual(data(a))
    }
    expect(data(events(world(cases[2]))[0])?.green).toBe(false)
  })
})
