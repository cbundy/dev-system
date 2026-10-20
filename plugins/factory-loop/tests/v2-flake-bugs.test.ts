// Rule F1, the flake bug (docs/factory-loop/v2/SPEC.md 8.5): the rule over the `flakes` source, the
// executor against a fake GitHub that keeps what each command wrote (so a retry sees the attempt
// before it), the tell planned from the filed bug, and the source's reads.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { loadConfig } from '../hooks/config'
import { loopEventArgs } from '../hooks/derive'
import type { ActIo } from '../hooks/exec'
import { GITHUB_V2, newCtx } from '../hooks/foundation'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { emptyV2State } from '../hooks/v2/observe'
import type { SourceCtx } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { bugBody } from '../hooks/v2/act-flake-bug'
import { flakeBugRules } from '../hooks/v2/rules-flake-bugs'
import { FLAKES_SQL, bugsFromJson, flakesFromRows, readFlakes, readFlakesCached, EMPTY_FLAKES } from '../hooks/v2/sources-flakes'
import type { Flake, FlakeBug } from '../hooks/v2/sources-flakes'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { FlakeBugSpec, IssueRecord, V2Ctx, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const DAY = 86_400_000
const TEST_A = 'tests/cli.test.js > prints help'
const TEST_B = 'tests/db.test.js > connects'
const HASH_A = 'aaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbb'
const HASH_C = 'cccccccccccccccc'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function flake(n: number, ago: number, hash = HASH_A, over: Partial<Flake> = {}): Flake {
  return { id: id(n), source: n % 2 === 0 ? 'ci' : 'gate', issue: 100 + n, head: `${n}`.repeat(7), at: NOW - ago, test: hash === HASH_A ? TEST_A : hash === HASH_B ? TEST_B : 'tests/other.test.js > x', job: null, hash, ...over }
}

function marker(hash: string, ids: string[] = []): string {
  return `Body\n\n<!-- factory-loop:flake:${hash} -->\n${ids.map(i => `<!-- factory-loop:flake-bug/${hash}/c/${i} -->`).join('\n')}\n`
}

type World = { flakes?: Flake[]; bugs?: FlakeBug[]; records?: IssueRecord[]; ledger?: LedgerEntry[]; source?: { ok: boolean; error?: string }; cfg?: Parameters<typeof config>[0]; read?: boolean }

function stateOf(w: World): State {
  const s = state({ control: control() })
  const v2: V2State = { ...emptyV2State(NOW, w.records ?? []), ...(w.read === false ? {} : { flakes: { flakes: w.flakes ?? [], bugs: w.bugs ?? [] } }) }
  v2.sources = { ...v2.sources, flakes: w.source === undefined ? { ok: true, at: NOW } : { ok: w.source.ok, at: null, ...(w.source.error === undefined ? {} : { error: w.source.error }) } }
  return { ...s, ledger: [...s.ledger, ...(w.ledger ?? [])], v2 }
}

function rule(w: World): { out: Action[]; skipped: string[] } {
  const s = stateOf(w)
  const ctx: V2Ctx = Object.assign(newCtx(s, config({ mode: 'act', ...w.cfg }), { tier: 'normal', overridden: false }, V2_OWNER_TELLS, GITHUB_V2), { v2: s.v2 as V2State })
  flakeBugRules(ctx)
  return { out: ctx.out, skipped: ctx.skipped.map(k => k.why) }
}

const bugsOf = (a: Action[]) => a.filter((x): x is Extract<Action, { kind: 'flake-bug' }> => x.kind === 'flake-bug')
const commentsOf = (a: Action[]) => a.filter((x): x is Extract<Action, { kind: 'comment' }> => x.kind === 'comment')
const tellsOf = (a: Action[]) => a.filter((x): x is Extract<Action, { kind: 'tell' }> => x.kind === 'tell')

const two = [flake(1, 3 * DAY), flake(2, 1 * DAY)]

describe('F1 plans one bug for a test with enough flakes in the window', () => {
  test('two flakes (one gate, one CI) plan one flake-bug: marker, per-flake markers, the standard, the epic, ready under the cap', () => {
    const { out } = rule({ flakes: two, cfg: { flakeEpic: 864 } })
    const [a, ...rest] = bugsOf(out)
    expect(rest).toEqual([])
    expect(a?.key).toBe(`flake-bug/${HASH_A}/${id(1)}`)
    expect(a?.bug).toMatchObject({ hash: HASH_A, test: TEST_A, ready: true, epic: 864, flakes: 2, windowDays: 7, title: `Flaky test: ${TEST_A}` })
    const body = a?.bug.body ?? ''
    expect(a?.bug.flakeIds).toEqual([id(1), id(2)])
    // the executor adds the markers: the bug's, and one for each flake it lists
    const full = bugBody(a?.bug as FlakeBugSpec)
    expect(full).toContain(body)
    expect(full).toContain(`<!-- factory-loop:flake:${HASH_A} -->`)
    expect(full).toContain(`<!-- factory-loop:flake-bug/${HASH_A}/c/${id(1)} -->`)
    expect(full).toContain(`<!-- factory-loop:flake-bug/${HASH_A}/c/${id(2)} -->`)
    expect(body).toContain('#101, `1111111`')
    expect(body).toContain(', gate')
    expect(body).toContain(', ci')
    expect(body).toContain('epic #864')
    expect(body).toContain('reproduce the flake under load first')
    expect(body).toContain('(3) show the same stress run passing many times in a row')
    expect(body).toContain('No retry, skip or raised timeout without a written reason')
    expect(body).toMatch(/```\ngate: tests\/cli\.test\.js > prints help\nci: tests\/cli\.test\.js > prints help\n```/)
  })

  test('one flake plans nothing, and two flakes 8 days apart (one outside the window) plan nothing', () => {
    expect(rule({ flakes: [flake(1, DAY)] }).out).toEqual([])
    expect(rule({ flakes: [flake(1, 8 * DAY), flake(2, DAY)] }).out).toEqual([])
    expect(rule({ flakes: [flake(1, 3 * DAY), flake(2, DAY)], cfg: { flakeBugMin: 3 } }).out).toEqual([])
  })

  test('the same flake read twice counts once; two tests are two bugs', () => {
    expect(rule({ flakes: [flake(1, DAY), flake(1, DAY)] }).out).toEqual([])
    const both = [...two, flake(3, 2 * DAY, HASH_B), flake(4, DAY, HASH_B)]
    expect(bugsOf(rule({ flakes: both }).out).map(b => b.bug.hash)).toEqual([HASH_A, HASH_B])
  })

  test('closing keywords in a test name or a failure line are made safe', () => {
    const f = [flake(1, 3 * DAY, HASH_A, { test: 'Fixes #12 ```x' }), flake(2, DAY, HASH_A, { test: 'Fixes #12 ```x' })]
    const [a] = bugsOf(rule({ flakes: f }).out)
    // the failure lines cannot break out of the fence, and the executor's neutralBody turns the keyword
    expect(a?.bug.body.match(/```/g)).toHaveLength(2)
    const full = bugBody(a?.bug as FlakeBugSpec)
    expect(full).not.toMatch(/Fixes #12/)
    expect(full).toContain('Fixing #12')
  })

  test('the ledger key already done: no second bug, however often the pass runs', () => {
    const done = entry(`flake-bug/${HASH_A}/${id(1)}`, 'flake-bug', { status: 'done' })
    expect(bugsOf(rule({ flakes: two, ledger: [done] }).out)).toEqual([])
  })
})

describe('F1 and an open bug', () => {
  const bug = (over: Partial<FlakeBug> = {}): FlakeBug => ({ number: 900, hash: HASH_A, ready: true, known: [], ...over })

  test('a flake not on the open bug gets one comment; the flakes its body names get none; no second bug', () => {
    const f = [...two, flake(3, 3 * MIN)]
    const { out } = rule({ flakes: f, bugs: [bug({ known: [id(1), id(2)] })] })
    expect(bugsOf(out)).toEqual([])
    expect(commentsOf(out).map(c => [c.key, c.number, c.on])).toEqual([[`flake-bug/${HASH_A}/c/${id(3)}`, 900, 'issue']])
    expect(commentsOf(out)[0]?.body).toContain('Another flake of this test: #103')
  })

  test('a comment already done is not planned again', () => {
    const done = entry(`flake-bug/${HASH_A}/c/${id(3)}`, 'comment', { status: 'done' })
    expect(commentsOf(rule({ flakes: [...two, flake(3, 3 * MIN)], bugs: [bug({ known: [id(1), id(2)] })], ledger: [done] }).out)).toEqual([])
  })

  test('an issue with another test\'s marker is not this test\'s bug', () => {
    expect(bugsOf(rule({ flakes: two, bugs: [bug({ hash: HASH_B })] }).out)).toHaveLength(1)
  })
})

describe('F1 and the ready cap', () => {
  const open = (n: number, ready: boolean): FlakeBug => ({ number: n, hash: `${n}`.repeat(16).slice(0, 16), ready, known: [] })
  const rec = (issue: number, st: IssueRecord['state']): IssueRecord => ({
    issue, life: 'l1', seq: 1, seqAt: NOW - MIN, state: st, since: NOW - MIN, resumeTo: null, branch: `issue-${issue}`, pr: null, head: null, approvedPatch: null, brief: null, step: null, attempt: 0, cut: false, triages: 0, fixes: 0, round: 0, question: null, parts: null, why: null, notes: [], prClosedAt: null, wait: null, lives: 1,
  })

  test('with two open flake bugs ready or in flight, a third test\'s bug is filed without ready', () => {
    const bugs = [open(801, true), open(802, false)]
    const { out } = rule({ flakes: two, bugs, records: [rec(802, 'building')] })
    const [a] = bugsOf(out)
    expect(a?.bug.ready).toBe(false)
    expect(a?.bug.reason).toContain('2 open flake bugs ready or in flight reach the cap of 2')
  })

  test('a closed record and an unready bug with no record hold no place', () => {
    const bugs = [open(801, false), open(802, false)]
    expect(bugsOf(rule({ flakes: two, bugs, records: [rec(802, 'closed')] }).out)[0]?.bug.ready).toBe(true)
  })

  test('two new bugs in one pass fill the cap in turn: the first ready, the second held at a cap of 1', () => {
    const both = [...two, flake(3, 2 * DAY, HASH_B), flake(4, DAY, HASH_B)]
    expect(bugsOf(rule({ flakes: both, cfg: { flakeBugReadyCap: 1 } }).out).map(b => b.bug.ready)).toEqual([true, false])
  })

  test('a cap of 0 never readies', () => {
    expect(bugsOf(rule({ flakes: two, cfg: { flakeBugReadyCap: 0 } }).out)[0]?.bug.ready).toBe(false)
  })
})

describe('F1 and the source', () => {
  test('a failed source plans nothing and says so; so does a pass that read nothing', () => {
    const failed = rule({ flakes: two, source: { ok: false, error: 'the flakes read failed: exit 1' } })
    expect(failed.out).toEqual([])
    expect(failed.skipped).toEqual(['flakes source unread: the flakes read failed: exit 1; no flake bug is filed or commented'])
    expect(rule({ read: false }).out).toEqual([])
  })

  test('planV2 completes with a failed source, and plans the bug with a good one', () => {
    const ok = planV2(stateOf({ flakes: two }), config({ mode: 'act' }))
    expect(bugsOf(ok.actions)).toHaveLength(1)
    const bad = planV2(stateOf({ flakes: two, source: { ok: false, error: 'x' } }), config({ mode: 'act' }))
    expect(bugsOf(bad.actions)).toEqual([])
    expect(bad.skipped.some(k => k.rule === 'F1')).toBe(true)
  })
})

// --- the executor, against a fake GitHub ---------------------------------------------------------

type Issue = { number: number; open: boolean; body: string; labels: string[]; comments: string[] }
type Gh = { issues: Issue[]; labels: string[]; subs: Map<number, number[]>; writes: string[][]; reads: string[][]; events: string[][]; next: number }

const idOfIssue = (n: number) => 7_000 + n

function answer(g: Gh, argv: string[], stdin?: string): { exitCode?: number; stdout?: string; stderr?: string } {
  const [cmd, ...a] = argv
  if (cmd === 'callum-flow-event') {
    g.events.push([...argv])
    return {}
  }
  if (cmd === 'callum-flow-issue-read') {
    g.reads.push([...argv])
    if (a.includes('--list')) return { stdout: JSON.stringify({ issues: g.issues.filter(i => i.open).map(i => ({ number: i.number, id: idOfIssue(i.number), body: i.body, labels: i.labels.map(name => ({ name })) })), stripped: 0 }) }
    const i = g.issues.find(x => x.number === Number(a[1]))
    if (i === undefined) return { exitCode: 1, stderr: 'cannot read issue' }
    if (a.includes('--comments')) return { stdout: JSON.stringify({ comments: i.comments.map(body => ({ body, created_at: '2026-10-13T00:00:00Z', html_url: 'u' })), stripped: 0 }) }
    return { stdout: JSON.stringify({ issue: { number: i.number, id: idOfIssue(i.number), state: i.open ? 'open' : 'closed', body: i.body }, stripped: 0 }) }
  }
  if (cmd !== 'gh') return {}
  g.writes.push([...argv])
  if (a[0] === 'label' && a[1] === 'create') {
    if (!g.labels.includes(a[2] ?? '')) g.labels.push(a[2] ?? '')
    return {}
  }
  if (a[0] === 'issue' && a[1] === 'create') {
    const n = g.next++
    g.issues.push({ number: n, open: true, body: stdin ?? '', labels: [], comments: [] })
    return { stdout: `https://github.com/${REPO}/issues/${n}\n` }
  }
  if (a[0] === 'issue' && a[1] === 'edit') {
    const i = g.issues.find(x => x.number === Number(a[2]))
    for (let k = 0; k < a.length; k++) if (a[k] === '--add-label' && i !== undefined && !i.labels.includes(a[k + 1] ?? '')) i.labels.push(a[k + 1] ?? '')
    return {}
  }
  if (a[0] === 'issue' && a[1] === 'comment') {
    g.issues.find(x => x.number === Number(a[2]))?.comments.push(stdin ?? '')
    return { stdout: 'https://github.com/x/y/issues/1#issuecomment-1\n' }
  }
  if (a[0] === 'api') {
    const path = a.find(x => x.startsWith('repos/')) ?? ''
    const epic = Number(/issues\/(\d+)\/sub_issues/.exec(path)?.[1])
    if (a.includes('--method')) {
      const sub = Number(a[a.indexOf('-F') + 1]?.split('=')[1])
      g.subs.set(epic, [...(g.subs.get(epic) ?? []), sub])
      return {}
    }
    return { stdout: (g.subs.get(epic) ?? []).join('\n') }
  }
  return {}
}

function rt(cfg: Parameters<typeof config>[0] = {}): Runtime {
  return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config({ mode: 'act', ...cfg }), configProblems: [] }
}

function act(g: Gh, cfg: Parameters<typeof config>[0] = {}) {
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => ({ exitCode: 0, stdout: '', stderr: '', ...answer(g, argv, (init as { stdin?: string }).stdin) }),
    spawnAgent: async () => ({ agentId: 'a1' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const env: ActEnv = { io, rt: rt(cfg), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return (action: Action) => dispatch(ctxOf(env, state(), start([], action, NOW).entry), action)
}

const world = (): Gh => ({ issues: [{ number: 864, open: true, body: 'The epic', labels: [], comments: [] }], labels: [], subs: new Map(), writes: [], reads: [], events: [], next: 900 })

describe('the flake-bug executor', () => {
  const planned = (cfg: World['cfg'] = { flakeEpic: 864 }): Extract<Action, { kind: 'flake-bug' }> => bugsOf(rule({ flakes: two, cfg }).out)[0] as Extract<Action, { kind: 'flake-bug' }>

  test('files one issue with the marker, flaky and priority, links it under the epic and readies it; a replay makes nothing more', async () => {
    const g = world()
    const run = act(g, { flakeEpic: 864 })
    const a = planned()
    const first = await run(a)
    expect(first).toMatchObject({ status: 'done', outcome: { kind: 'flake-bug', issue: 900, made: true, ready: true, test: TEST_A, flakes: 2, windowDays: 7 } })
    const bug = g.issues.find(i => i.number === 900)
    expect(bug?.body).toContain(`<!-- factory-loop:flake:${HASH_A} -->`)
    expect(bug?.labels).toEqual(['flaky', 'priority', 'ready'])
    expect(g.labels).toEqual(['flaky'])
    expect(g.subs.get(864)).toEqual([idOfIssue(900)])
    // the label is made before the issue, and ready is the last write
    const writes = g.writes.map(w => w.slice(0, 3).join(' '))
    expect(writes.indexOf('gh label create')).toBeLessThan(writes.indexOf('gh issue create'))
    expect(g.writes.at(-1)).toEqual(['gh', 'issue', 'edit', '900', '--repo', REPO, '--add-label', 'ready'])
    // replay (a retry, or a lost ledger): found by its marker, nothing created, linked, or labelled again beyond the idempotent adds
    const before = g.issues.length
    const again = await run(a)
    expect(again).toMatchObject({ status: 'done', outcome: { kind: 'flake-bug', issue: 900, made: false } })
    expect(g.issues).toHaveLength(before)
    expect(g.subs.get(864)).toEqual([idOfIssue(900)])
    expect(g.writes.filter(w => w[1] === 'issue' && w[2] === 'create')).toHaveLength(1)
  })

  test('held by the cap: no ready label; no epic set: no link', async () => {
    const g = world()
    const a = bugsOf(rule({ flakes: two, cfg: { flakeBugReadyCap: 0 } }).out)[0] as Extract<Action, { kind: 'flake-bug' }>
    const done = await act(g)(a)
    expect(done).toMatchObject({ status: 'done', outcome: { ready: false } })
    expect(g.issues.find(i => i.number === 900)?.labels).toEqual(['flaky', 'priority'])
    expect(g.subs.size).toBe(0)
  })

  test('the open issues are read through the reader alone, which lists trusted authors only: an untrusted issue with the marker is never found, counted or commented on', async () => {
    const g = world()
    await act(g)(planned())
    expect(g.reads.filter(r => r.includes('--list'))).toEqual([['callum-flow-issue-read', '--json', '--list', '--state', 'open']])
    // no `gh` command lists or reads issue text
    expect(g.writes.filter(w => w[1] === 'issue' && ['list', 'view'].includes(w[2] ?? ''))).toEqual([])
  })

  test('the comment executor posts one comment per flake and finds it again by its marker', async () => {
    const g = world()
    g.issues.push({ number: 900, open: true, body: marker(HASH_A, [id(1), id(2)]), labels: ['flaky'], comments: [] })
    const run = act(g)
    const c = commentsOf(rule({ flakes: [...two, flake(3, 3 * MIN)], bugs: [{ number: 900, hash: HASH_A, ready: true, known: [id(1), id(2)] }] }).out)[0] as Extract<Action, { kind: 'comment' }>
    expect(await run(c)).toMatchObject({ status: 'done' })
    expect(await run(c)).toMatchObject({ status: 'done' })
    expect(g.issues.find(i => i.number === 900)?.comments).toHaveLength(1)
    expect(g.issues.find(i => i.number === 900)?.comments[0]).toContain(`<!-- factory-loop:flake-bug/${HASH_A}/c/${id(3)} -->`)
  })

  test('the filed bug is told once: key, fields and the loop_entry payload', async () => {
    const g = world()
    const a = planned()
    const exec = await act(g, { flakeEpic: 864 })(a)
    const done = entry(a.key, 'flake-bug', { status: 'done', outcome: exec.status === 'done' ? exec.outcome : undefined })
    const { out } = rule({ flakes: two, bugs: [{ number: 900, hash: HASH_A, ready: true, known: [id(1), id(2)] }], ledger: [done] })
    const [t, ...more] = tellsOf(out)
    expect(more).toEqual([])
    expect(t).toMatchObject({ wake: 'flake-bug', key: 'tell:flake-bug:900', fields: { bug: '900', flakes: '2', days: '7', decision: 'ready' } })
    expect(t?.context.join('\n')).toContain('flaked 2 times in the last 7 days')
    expect(t?.loopData).toEqual({ decision: 'ready', decision_reason: '0 open flake bugs ready or in flight, under the cap of 2', flake_test: TEST_A, flakes: 2, window_days: 7, first_flake_at: new Date(NOW - 3 * DAY).toISOString(), filed_issue: 900 })
    // once it was told, the tell's key is done and it is not planned again
    const told = entry('tell:flake-bug:900', 'tell', { status: 'done' })
    expect(tellsOf(rule({ flakes: two, ledger: [done, told] }).out)).toEqual([])
  })

  test('a bug held by the cap is told as held, naming the owner\'s step', () => {
    const outcome = { kind: 'flake-bug' as const, issue: 901, made: true, ready: false, test: TEST_B, flakes: 3, windowDays: 7, firstFlakeAt: '2026-10-12T00:00:00.000Z', reason: '2 open flake bugs ready or in flight reach the cap of 2' }
    const [t] = tellsOf(rule({ ledger: [entry('flake-bug/x/y', 'flake-bug', { status: 'done', outcome })] }).out)
    expect(t?.fields.decision).toBe('held')
    expect(t?.loopData).toMatchObject({ decision: 'held', filed_issue: 901 })
    expect(t?.context.join('\n')).toContain('the owner adds `ready`')
  })

  test('the tell\'s ledger entry logs its payload with --data on the loop event', () => {
    const outcome = { kind: 'flake-bug' as const, issue: 901, made: true, ready: true, test: TEST_B, flakes: 3, windowDays: 7, firstFlakeAt: '2026-10-12T00:00:00.000Z', reason: 'r' }
    const [t] = tellsOf(rule({ ledger: [entry('flake-bug/x/y', 'flake-bug', { status: 'done', outcome })] }).out)
    const e = start([], t as Action, NOW).entry
    const args = loopEventArgs(e)
    expect(args.slice(-2)).toEqual(['--data', JSON.stringify(t?.loopData)])
    // an entry with none writes no --data
    expect(loopEventArgs({ ...e, loopData: undefined })).not.toContain('--data')
  })
})

// --- the source ----------------------------------------------------------------------------------------

const HEADER = 'event_id,source,issue,head,passed_at,test,job,hash'
const row = (n: number, test = TEST_A, hash = HASH_A) => `${id(n)},gate,${100 + n},${'1'.repeat(40)},2026-10-17T10:11:00.000Z,"${test}",,${hash}`

function sourceCtx(run: SourceCtx['run'], cfg: Parameters<typeof config>[0] = {}, st: State = state()): SourceCtx {
  return { now: NOW, rt: rt(cfg), run, readFile: async () => null, state: st, records: [], heads: {}, prBudget: 0, limited: () => false, unread: [], kept: [], tag: null, tags: {} }
}

describe('the flakes source', () => {
  test('rows read as flakes: the SQL on stdin, the repo and the window start as variables; a bad row is dropped', async () => {
    const calls: { argv: string[]; stdin?: string }[] = []
    const run: SourceCtx['run'] = async (argv, stdin) => {
      calls.push({ argv, stdin })
      if (argv[0] === 'dev-query') return { exitCode: 0, stdout: `${HEADER}\n${row(1)}\n${row(2)}\nnot-an-id,gate,1,,2026-10-17T10:11:00.000Z,x,,${HASH_A}\n`, stderr: '' }
      return { exitCode: 0, stdout: JSON.stringify({ issues: [{ number: 900, body: marker(HASH_A, [id(1)]), labels: [{ name: 'flaky' }, { name: 'ready' }] }], stripped: 0 }), stderr: '' }
    }
    const r = await readFlakes(sourceCtx(run), 2)
    expect(calls[0]).toEqual({ argv: ['dev-query', '--factory', '--csv', '-v', `repo=${REPO}`, '-v', `since=${new Date(NOW - 7 * DAY).toISOString()}`], stdin: FLAKES_SQL })
    expect(calls[1]?.argv).toEqual(['callum-flow-issue-read', '--json', '--list', '--label', 'flaky', '--state', 'open'])
    expect(r.source.ok).toBe(true)
    expect(r.read?.flakes.map(f => f.id)).toEqual([id(1), id(2)])
    expect(r.read?.bugs).toEqual([{ number: 900, hash: HASH_A, ready: true, known: [id(1)] }])
  })

  test('no test with enough flakes: the issues are not listed', async () => {
    const calls: string[] = []
    const run: SourceCtx['run'] = async argv => {
      calls.push(argv[0] ?? '')
      return { exitCode: 0, stdout: `${HEADER}\n${row(1)}\n`, stderr: '' }
    }
    expect((await readFlakes(sourceCtx(run), 2)).read?.bugs).toEqual([])
    expect(calls).toEqual(['dev-query'])
  })

  test('a missing factory URL (exit 77) is no flakes; any other failure, a throw or an unreadable list fails the source', async () => {
    const reply = (exitCode: number, stdout = ''): SourceCtx['run'] => async () => ({ exitCode, stdout, stderr: '' })
    expect(await readFlakes(sourceCtx(reply(77)), 2)).toEqual({ source: { ok: true, at: NOW }, read: { flakes: [], bugs: [] } })
    expect((await readFlakes(sourceCtx(reply(1)), 2)).source).toEqual({ ok: false, at: null, error: 'the flakes read failed: exit 1' })
    const boom: SourceCtx['run'] = async () => {
      throw new Error('spawn failed')
    }
    expect((await readFlakes(sourceCtx(boom), 2)).source.ok).toBe(false)
    const listFails: SourceCtx['run'] = async argv => (argv[0] === 'dev-query' ? { exitCode: 0, stdout: `${HEADER}\n${row(1)}\n${row(2)}\n`, stderr: '' } : { exitCode: 3, stdout: '', stderr: 'refused' })
    const r = await readFlakes(sourceCtx(listFails), 2)
    expect(r.source.ok).toBe(false)
    expect(r.read).toBeNull()
  })

  test('bugs: the marker, the labels and the flake ids of a body; an issue with no marker has no hash; a list not in shape is null', () => {
    const json = JSON.stringify({ issues: [{ number: 5, body: 'no marker', labels: [{ name: 'flaky' }] }, { number: 6, body: marker(HASH_C, [id(7)]), labels: [{ name: 'Ready' }] }, { number: 'x', body: '' }], stripped: 1 })
    expect(bugsFromJson(json)).toEqual([{ number: 5, hash: null, ready: false, known: [] }, { number: 6, hash: HASH_C, ready: true, known: [id(7)] }])
    expect(bugsFromJson('{"issues":')).toBeNull()
    expect(bugsFromJson('{}')).toBeNull()
  })

  test('flakesFromRows keeps the issue, head, time, test and job', () => {
    const [f] = flakesFromRows([{ event_id: id(1), source: 'ci', issue: '12', head: 'abc1234', passed_at: '2026-10-17T10:11:00.000Z', test: TEST_A, job: 'test, lint', hash: HASH_A }])
    expect(f).toEqual({ id: id(1), source: 'ci', issue: 12, head: 'abc1234', at: Date.parse('2026-10-17T10:11:00.000Z'), test: TEST_A, job: 'test, lint', hash: HASH_A })
  })

  test('the cadence: act mode only, every githubEveryMs, at once after an action of F1 ended', async () => {
    let reads = 0
    const run: SourceCtx['run'] = async () => {
      reads += 1
      return { exitCode: 77, stdout: '', stderr: '' }
    }
    const act1 = sourceCtx(run)
    const c1 = await readFlakesCached(act1, EMPTY_FLAKES, false)
    expect(reads).toBe(1)
    expect((await readFlakesCached(act1, c1, false)).at).toBe(c1.at)
    expect(reads).toBe(1)
    const later = { ...act1, now: NOW + 6 * MIN }
    await readFlakesCached(later, c1, false)
    expect(reads).toBe(2)
    const own = state({ ledger: [entry(`flake-bug/${HASH_A}/${id(1)}`, 'flake-bug', { startedAt: NOW + MIN, endedAt: NOW + 2 * MIN })] })
    await readFlakesCached({ ...act1, now: NOW + 3 * MIN, state: own }, c1, false)
    expect(reads).toBe(3)
    // observe mode and a backoff read nothing
    await readFlakesCached({ ...act1, rt: { ...act1.rt, mode: 'observe' } }, EMPTY_FLAKES, false)
    await readFlakesCached(act1, EMPTY_FLAKES, true)
    expect(reads).toBe(3)
  })
})

describe('the settings', () => {
  test('defaults, and a value that is not a whole number of at least 1 (0 for the cap), or an epic that is not an issue number, is left out and named', () => {
    const d = loadConfig({}).config
    expect([d.flakeWindowDays, d.flakeBugMin, d.flakeBugReadyCap, d.flakeEpic]).toEqual([7, 2, 2, null])
    expect(loadConfig({ flakeWindowDays: 14, flakeBugMin: 3, flakeBugReadyCap: 0, flakeEpic: 864 }).config).toMatchObject({ flakeWindowDays: 14, flakeBugMin: 3, flakeBugReadyCap: 0, flakeEpic: 864 })
    const bad = loadConfig({ flakeWindowDays: 0, flakeBugMin: 1.5, flakeBugReadyCap: -1, flakeEpic: 0 })
    expect(bad.config).toMatchObject({ flakeWindowDays: 7, flakeBugMin: 2, flakeBugReadyCap: 2, flakeEpic: null })
    expect(bad.problems).toHaveLength(4)
  })
})
