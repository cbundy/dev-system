// The `close-tracker` executor (docs/factory-loop/v2/SPEC.md 8.7, appendix B; act-tracker.ts): a split's
// parent is closed when its last sub-issue is closed (#946). It runs through the act step's dispatcher
// against a fake GitHub that keeps what each command wrote, so a retry sees the attempt before it.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import type { ActIo } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action } from '../hooks/types'
import { splitParentOf, subIssueStates, trackerComment } from '../hooks/v2/act-tracker'
import * as ARGV from '../hooks/v2/argv'
import { followKey, hiddenKey, lifeOf } from '../hooks/v2/keys'
import { DEVICE, NOW, PLUGIN_ROOT, config, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const LIFE = lifeOf(NOW - 3_600_000)

type Issue = { number: number; state: 'open' | 'closed'; reason?: string; body: string; pr?: boolean }
type Gh = { issues: Issue[]; subs: Map<number, number[]>; writes: string[][]; events: string[][]; subRead?: string }

// childOf: a body as act-split.ts childBody leaves it: the hidden key of the parent's split last
const childOf = (parent: number, key: string, over: Partial<Issue> & { number: number }): Issue => ({
  state: 'closed',
  body: `Work.\n\nPart of #${parent}, split by the factory loop.\n\n${hiddenKey(`i${parent}/l${LIFE}/s3/child/${key}`)}\n`,
  ...over,
})

function answer(g: Gh, argv: string[]): { exitCode?: number; stdout?: string; stderr?: string } {
  const [cmd, ...a] = argv
  if (cmd === 'fabriek-event') {
    g.events.push([...argv])
    return {}
  }
  if (cmd === 'fabriek-issue-read') {
    const i = g.issues.find(x => x.number === Number(a[1]))
    return i === undefined ? { exitCode: 1, stderr: 'cannot read issue' } : { stdout: JSON.stringify({ issue: { number: i.number, id: 9_000 + i.number, state: i.state, body: i.body, ...(i.pr === true ? { pull_request: { url: 'x' } } : {}) }, stripped: 0 }) }
  }
  if (cmd !== 'gh') return {}
  if (a[0] === 'api') {
    const n = Number(/issues\/(\d+)\//.exec(a.find(x => x.startsWith('repos/')) ?? '')?.[1])
    if (g.subRead !== undefined) return { stdout: g.subRead }
    return { stdout: (g.subs.get(n) ?? []).map(s => `${s} ${g.issues.find(i => i.number === s)?.state ?? 'open'}`).join('\n') }
  }
  if (a[0] === 'issue' && a[1] === 'close') {
    g.writes.push([...argv])
    const i = g.issues.find(x => x.number === Number(a[2]))
    if (i !== undefined) {
      i.state = 'closed'
      i.reason = a[a.indexOf('--reason') + 1] ?? ''
    }
    return {}
  }
  return {}
}

function rt(): Runtime {
  return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config({ mode: 'act' }), configProblems: [] }
}

function act(g: Gh) {
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, _init) => ({ exitCode: 0, stdout: '', stderr: '', ...answer(g, argv) }),
    spawnAgent: async () => ({ agentId: 'a1' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const env: ActEnv = { io, rt: rt(), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return (issue: number) => {
    const action: Action = { kind: 'close-tracker', key: followKey({ issue, life: LIFE }, 'close-tracker'), class: 'free', rule: 'D3', reason: 'x', issue }
    return dispatch(ctxOf(env, state(), start([], action, NOW).entry), action)
  }
}

// the plant-console case: #139 blocks #50 and is split into #189, #190 and #191
const world = (over: Partial<Gh> = {}, c: Partial<Issue> = {}): Gh => ({
  issues: [
    { number: 139, state: 'open', body: 'The tracker.' },
    childOf(139, 'a', { number: 189 }),
    childOf(139, 'b', { number: 190, ...c }),
    childOf(139, 'c', { number: 191 }),
    { number: 50, state: 'open', body: 'Waits on #139.' },
  ],
  subs: new Map([[139, [189, 190, 191]]]),
  writes: [],
  events: [],
  ...over,
})

describe('the close-tracker executor (#946)', () => {
  test('regression: the tracker stays open while a sibling is open and closes with the last child, as completed, with its event', async () => {
    const g = world({}, { state: 'open' })
    const run = act(g)
    expect(await run(189)).toMatchObject({ status: 'done', outcome: { kind: 'close-tracker', parent: 139, closed: false, open: [190] } })
    expect(await run(191)).toMatchObject({ status: 'done', outcome: { kind: 'close-tracker', parent: 139, closed: false, open: [190] } })
    expect(g.writes).toEqual([])
    // the last one merges
    g.issues.find(i => i.number === 190)!.state = 'closed'
    const last = await run(190)
    expect(last).toMatchObject({ status: 'done', outcome: { kind: 'close-tracker', parent: 139, closed: true, open: [] }, summary: 'closing #139: #189 #190 #191 done' })
    expect(g.writes).toEqual([['gh', 'issue', 'close', '139', '--repo', REPO, '--reason', 'completed', '--comment', trackerComment([189, 190, 191])]])
    expect(g.events).toEqual([['fabriek-event', '--type', 'closed', '--data', '{"reason":"completed"}', '--issue', '139']])
    expect(g.issues.find(i => i.number === 139)?.reason).toBe('completed')
    // run again (a retry, a second device): the tracker is closed, nothing is written twice
    expect(await run(190)).toMatchObject({ status: 'done', outcome: { parent: 139, closed: false, open: [] }, summary: '#139 is already closed' })
    expect(g.writes).toHaveLength(1)
    expect(g.events).toHaveLength(1)
  })

  test('a sub-issue closed as not planned counts as closed', async () => {
    const g = world({}, { reason: 'not_planned' })
    expect(await act(g)(191)).toMatchObject({ outcome: { closed: true } })
  })

  test('an issue without the hidden key plans nothing: done, no parent, no write', async () => {
    const g = world()
    g.issues.push({ number: 300, state: 'closed', body: 'An epic child made by hand.\n\nPart of #139' })
    expect(await act(g)(300)).toMatchObject({ status: 'done', outcome: { kind: 'close-tracker', parent: null, closed: false, open: [] } })
    expect(g.writes).toEqual([])
  })

  test('a merged child GitHub still shows open fails, to be retried', async () => {
    const g = world({}, { state: 'open' })
    expect(await act(g)(190)).toMatchObject({ status: 'failed', summary: '#190 is still open' })
    expect(g.writes).toEqual([])
  })

  test('a tracker listing no sub-issue, and a malformed sub-issue read, close nothing', async () => {
    const none = world({ subs: new Map() })
    expect(await act(none)(190)).toMatchObject({ status: 'done', outcome: { closed: false } })
    const bad = world({ subRead: '190 gone' })
    expect(await act(bad)(190)).toMatchObject({ status: 'failed' })
    expect([...none.writes, ...bad.writes]).toEqual([])
  })

  test('a parent that is a pull request is refused', async () => {
    const g = world()
    g.issues.find(i => i.number === 139)!.pr = true
    expect(await act(g)(190)).toMatchObject({ status: 'failed', noRetry: true })
  })

  test('the comment carries no closing keyword', () => {
    expect(trackerComment([189, 190, 191])).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[:\s]*#\d+/i)
  })
})

describe('the readers', () => {
  test('the hidden key is the one of a split child; none, or a different comment, is none', () => {
    const body = (b: unknown) => JSON.stringify({ issue: { body: b } })
    expect(splitParentOf(body(childOf(7, 'x-1', { number: 1 }).body))).toBe(7)
    expect(splitParentOf(body('<!-- factory-loop:i7/lab/s2/comment -->'))).toBeNull()
    expect(splitParentOf(body(null))).toBeNull()
    expect(splitParentOf(body(5))).toBeUndefined()
    expect(splitParentOf('nope')).toBeUndefined()
  })

  test('the states: number and state a line; anything else is null', () => {
    expect(subIssueStates('1 open\n2 closed\n')).toEqual([{ number: 1, open: true }, { number: 2, open: false }])
    expect(subIssueStates('1 merged')).toBeNull()
  })

  test('the argv shapes', () => {
    expect(ARGV.subIssueStatesArgv(REPO, 139).slice(0, 4)).toEqual(['gh', 'api', `repos/${REPO}/issues/139/sub_issues`, '--paginate'])
  })
})
