// The `upstream` executor (docs/factory-loop/v2/SPEC.md 8.7, appendix B; act-upstream.ts): a design's
// upstream request is one issue in the target repo, found again by its marker or created once, with no
// label. It runs through the act step's dispatcher against a fake GitHub that keeps what each command
// wrote, so a retry sees the attempt before it. The loop's one write to a repo other than its own.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import type { ActIo } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action } from '../hooks/types'
import { upstreamBody } from '../hooks/v2/act-upstream'
import { upstreamKey, upstreamMarker } from '../hooks/v2/keys'
import { UPSTREAM_REPOS } from '../hooks/v2/upstream-answer.mjs'
import { DEVICE, NOW, PLUGIN_ROOT, config, state } from './fixtures'
import { LOOP_DIR, TOOLS } from './host'

const OWN = 'cbundy/consumer'
const TARGET = 'cbundy/dev-system'
const REF = { issue: 300, life: 'ltbq3k0', seq: 3 }

type Issue = { number: number; body: string }
type Gh = { issues: Issue[]; writes: { argv: string[]; stdin: string | undefined }[]; reads: { argv: string[]; repo: string | undefined }[]; createdUrl?: string; createFails?: number }

function answer(g: Gh, argv: string[], init: { env: Record<string, string>; stdin?: string }): { exitCode?: number; stdout?: string; stderr?: string } {
  const [cmd, ...a] = argv
  if (cmd === 'fabriek-issue-read' && a.includes('--list')) {
    g.reads.push({ argv: [...argv], repo: init.env.CALLUM_FLOW_REPO })
    return { stdout: JSON.stringify({ issues: g.issues.map(i => ({ number: i.number, id: 9_000 + i.number, body: i.body })), stripped: 0 }) }
  }
  if (cmd === 'gh' && a[0] === 'issue' && a[1] === 'create') {
    g.writes.push({ argv: [...argv], stdin: init.stdin })
    if ((g.createFails ?? 0) > 0) {
      g.createFails = (g.createFails ?? 0) - 1
      return { exitCode: 1, stderr: 'gh: Validation Failed' }
    }
    const number = 1300 + g.issues.length
    g.issues.push({ number, body: init.stdin ?? '' })
    return { stdout: `${g.createdUrl ?? `https://github.com/${a[a.indexOf('--repo') + 1]}/issues/${number}`}\n` }
  }
  return { exitCode: 1, stderr: `unexpected: ${argv.join(' ')}` }
}

function rt(repo: string): Runtime {
  return { mode: 'act', repo, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: repo }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config({ mode: 'act' }), configProblems: [] }
}

function act(g: Gh) {
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => ({ exitCode: 0, stdout: '', stderr: '', ...answer(g, argv, init) }),
    spawnAgent: async () => ({ agentId: 'a1' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const env: ActEnv = { io, rt: rt(OWN), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return (over: Partial<Extract<Action, { kind: 'upstream' }>> = {}, attempt = 1) => {
    const action: Action = {
      kind: 'upstream',
      key: upstreamKey(REF),
      class: 'free',
      rule: 'S2',
      reason: 'raise an issue upstream',
      issue: 300,
      target: TARGET,
      request: 'bug',
      title: 'The reader drops a quote',
      body: 'fabriek-issue-read drops the quote.\n\nFixes #9 by hand.',
      marker: upstreamMarker(OWN, REF),
      authority: { kind: 'owner', source: 'note' },
      fields: { repo: TARGET, request: 'bug', authority: 'owner', source: 'note' },
      ...over,
    }
    return dispatch(ctxOf(env, state(), { ...start([], action, NOW).entry, attempts: attempt }), action)
  }
}

const world = (over: Partial<Gh> = {}): Gh => ({ issues: [{ number: 1200, body: 'Unrelated.' }], writes: [], reads: [], ...over })

describe('the upstream executor (8.7)', () => {
  test('the issue is created once in the target repo, no label, its body ending with the source line and the marker; the list is read in the target repo', async () => {
    const g = world()
    const run = act(g)
    const exec = await run()
    expect(exec).toMatchObject({ status: 'done', outcome: { kind: 'upstream', repo: TARGET, issue: 1301, made: true } })
    expect(g.reads).toEqual([{ argv: ['fabriek-issue-read', '--json', '--list', '--state', 'open'], repo: TARGET }])
    expect(g.writes).toHaveLength(1)
    const w = g.writes[0]!
    expect(w.argv).toEqual(['gh', 'issue', 'create', '--repo', TARGET, '--title', 'The reader drops a quote', '--body-file', '-'])
    expect(w.argv.join(' ')).not.toContain('label')
    const marker = `<!-- factory-loop:upstream:${OWN}#300/l${REF.life}/s3 -->`
    expect(upstreamMarker(OWN, REF)).toBe(marker)
    expect(w.stdin?.endsWith(`Raised by the factory loop from ${OWN}#300 (bug).\n\n${marker}\n`)).toBe(true)
    // the designer's text is made safe: no closing keyword before a reference survives
    expect(w.stdin).not.toMatch(/\bFixes #9/)
  })

  test('a marker already present finds the issue and creates nothing (a retry, a lost ledger)', async () => {
    const g = world({ issues: [{ number: 1200, body: 'Unrelated.' }, { number: 1250, body: `Body\n\n${upstreamMarker(OWN, REF)}\n` }] })
    const exec = await act(g)()
    expect(exec).toMatchObject({ status: 'done', outcome: { kind: 'upstream', repo: TARGET, issue: 1250, made: false } })
    expect(g.writes).toEqual([])
    // another seq's marker is no match
    const other = world({ issues: [{ number: 1250, body: upstreamMarker(OWN, { ...REF, seq: 4 }) }] })
    expect(await act(other)()).toMatchObject({ outcome: { issue: 1301, made: true } })
    expect(other.writes).toHaveLength(1)
  })

  test('a failed create retries, and the retry after a create that landed finds it', async () => {
    const g = world({ createFails: 1 })
    const run = act(g)
    expect(await run()).toMatchObject({ status: 'failed' })
    expect(g.issues).toHaveLength(1)
    expect(await run({}, 2)).toMatchObject({ status: 'done', outcome: { issue: 1301, made: true } })
    expect(await run({}, 3)).toMatchObject({ status: 'done', outcome: { issue: 1301, made: false } })
    expect(g.writes).toHaveLength(2)
  })

  test("a `gh issue create` that prints another repo's URL fails", async () => {
    const g = world({ createdUrl: 'https://github.com/other/repo/issues/5' })
    expect(await act(g)()).toMatchObject({ status: 'failed', summary: expect.stringContaining(`printed no issue of ${TARGET}`) })
  })

  test('a target outside UPSTREAM_REPOS is refused before any command', async () => {
    const g = world()
    expect(await act(g)({ target: 'other/repo' })).toMatchObject({ status: 'failed', noRetry: true, summary: expect.stringContaining('not a repo an upstream request may go to') })
    expect(await act(g)({ target: 'CBundy/Other' })).toMatchObject({ status: 'failed', noRetry: true })
    expect(g.reads).toEqual([])
    expect(g.writes).toEqual([])
    expect(UPSTREAM_REPOS).toEqual([TARGET])
  })

  test('the body names the source issue and the request, without a closing keyword', () => {
    const a = { body: 'Text.', request: 'need', issue: 7, marker: 'M' } as unknown as Extract<Action, { kind: 'upstream' }>
    expect(upstreamBody(a, OWN)).toBe(`Text.\n\nRaised by the factory loop from ${OWN}#7 (need).\n\nM\n`)
  })
})
