// The PR and a split's children (docs/factory-loop/v2/SPEC.md 3.5, 8.1, 8.7, 9.3, appendix B): the
// `pr` executor (act-pr.ts) ensures one PR per branch for life (used, reopened or created, never a
// second) with the loop's own body and linkage, and writes the body again after a linkage FAIL; the
// `split` executor (act-split.ts) makes each child once, found again by its hidden key, linked once
// under its parent and to the siblings it is blocked by, then labelled ready. Both run through the
// act step's dispatcher under planner v2, against a fake GitHub that keeps what each command wrote,
// so a retry sees the effects of the attempt before it.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import type { ActIo } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action } from '../hooks/types'
import { bodyWork, candidates, createdPr, footer, listedPrs, prBody, prRead, prTitle, refusedReopen, rolloutLinkage } from '../hooks/v2/act-pr'
import { childBody, childTitle, createdIssue, foundChild, ids, issueId } from '../hooks/v2/act-split'
import { hiddenKey } from '../hooks/v2/act-state'
import { childKey, lifeOf, prKey } from '../hooks/v2/keys'
import { DEVICE, NOW, PLUGIN_ROOT, config, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const LIFE = lifeOf(NOW - 3_600_000)
const REF = { issue: 300, life: LIFE, seq: 7 }
const BRIEF = `https://github.com/${REPO}/issues/300#issuecomment-1300`
const READY = 'ready'

// --- a fake GitHub ---------------------------------------------------------------------------------------

// gone: its head branch was deleted or recreated after it closed, so GitHub refuses to reopen it
type Pr = { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; ref: string; repo: string; trusted: boolean; body: string; title: string; gone?: boolean }
type Issue = { number: number; id: number; title: string; body: string; labels: string[] }
// down: GitHub answers every gh command with a 502
type Gh = { prs: Pr[]; issues: Issue[]; subs: Map<number, number[]>; blockers: Map<number, number[]>; rollout: string; writes: string[][]; down: boolean }

function gh(over: Partial<Gh> = {}): Gh {
  return { prs: [], issues: [], subs: new Map(), blockers: new Map(), rollout: 'ROLLOUT merge source=brief', writes: [], down: false, ...over }
}

const json = (v: unknown) => ({ stdout: JSON.stringify(v) })

// answer: each command as GitHub and the image's tools answer it, keeping every write.
function answer(g: Gh, argv: string[], stdin: string | undefined): { exitCode?: number; stdout?: string; stderr?: string } {
  const [cmd, ...a] = argv
  const write = () => g.writes.push([...argv])
  if (cmd === 'callum-flow-rollout') return { stdout: `${g.rollout}\n`, exitCode: g.rollout.startsWith('ROLLOUT merge') || g.rollout.startsWith('ROLLOUT run-it') || g.rollout.startsWith('ROLLOUT keep-open') ? 0 : 1 }
  if (cmd === 'callum-flow-issue-read') {
    if (a.includes('--pr')) {
      const pr = g.prs.find(p => p.number === Number(a[a.indexOf('--pr') + 1]))
      if (pr === undefined) return { exitCode: 1, stderr: 'cannot read PR' }
      if (!pr.trusted) return { exitCode: 3, stderr: 'untrusted author' }
      return json({ pr: { number: pr.number, state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.state === 'MERGED', body: pr.body, head: { ref: pr.ref, repo: { full_name: pr.repo } } }, stripped: 0 })
    }
    if (a.includes('--list')) return json({ issues: g.issues.map(i => ({ number: i.number, id: i.id, title: i.title, body: i.body })), stripped: 0 })
    const issue = g.issues.find(i => i.number === Number(a[1]))
    return issue === undefined ? { exitCode: 1, stderr: 'cannot read issue' } : json({ issue: { number: issue.number, id: issue.id }, stripped: 0 })
  }
  if (cmd !== 'gh') return {}
  if (g.down) return { exitCode: 1, stderr: 'HTTP 502' }
  if (a[0] === 'pr' && a[1] === 'list') {
    const head = a[a.indexOf('--head') + 1]
    return json(g.prs.filter(p => p.ref === head).map(p => ({ number: p.number, state: p.state, headRefOid: 'abc' })))
  }
  if (a[0] === 'pr' && a[1] === 'create') {
    write()
    const number = 500 + g.prs.length
    g.prs.push({ number, state: 'OPEN', ref: a[a.indexOf('--head') + 1] ?? '', repo: REPO, trusted: true, body: stdin ?? '', title: a[a.indexOf('--title') + 1] ?? '' })
    return { stdout: `https://github.com/${REPO}/pull/${number}\n` }
  }
  const pr = g.prs.find(p => p.number === Number(a[2]))
  if (a[0] === 'pr' && a[1] === 'reopen' && pr !== undefined) {
    // GitHub refuses a PR whose head branch is gone, or while another PR is open on its head
    if (pr.gone === true || g.prs.some(p => p !== pr && p.state === 'OPEN' && p.ref === pr.ref)) return { exitCode: 1, stderr: 'GraphQL: Could not open the pull request. (reopenPullRequest)' }
    write()
    pr.state = 'OPEN'
    return {}
  }
  if (a[0] === 'pr' && a[1] === 'edit' && pr !== undefined) {
    write()
    pr.body = stdin ?? ''
    return {}
  }
  if (a[0] === 'issue' && a[1] === 'create') {
    write()
    const number = 600 + g.issues.length
    g.issues.push({ number, id: 9_000_000 + number, title: a[a.indexOf('--title') + 1] ?? '', body: stdin ?? '', labels: [] })
    return { stdout: `https://github.com/${REPO}/issues/${number}\n` }
  }
  if (a[0] === 'issue' && a[1] === 'edit') {
    write()
    g.issues.find(i => i.number === Number(a[2]))?.labels.push(a[a.indexOf('--add-label') + 1] ?? '')
    return {}
  }
  if (a[0] === 'api') {
    const path = a.find(x => x.startsWith('repos/')) ?? ''
    const n = Number(/issues\/(\d+)\//.exec(path)?.[1])
    const map = path.endsWith('/sub_issues') ? g.subs : g.blockers
    if (a.includes('POST')) {
      write()
      const id = Number(a[a.length - 1]?.split('=')[1])
      map.set(n, [...(map.get(n) ?? []), id])
      return json({})
    }
    return { stdout: (map.get(n) ?? []).map(String).join('\n') }
  }
  return {}
}

function rt(): Runtime {
  return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config({ planner: 'v2', mode: 'act', readyLabel: READY }), configProblems: [] }
}

// act: the action through the act step's dispatcher, its commands answered by the fake GitHub.
function act(g: Gh) {
  const argvs: string[][] = []
  const stdins: (string | undefined)[] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => {
      argvs.push([...argv])
      stdins.push(init.stdin)
      return { exitCode: 0, stdout: '', stderr: '', ...answer(g, argv, init.stdin) }
    },
    spawnAgent: async () => ({ agentId: 'a1' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const env: ActEnv = { io, rt: rt(), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  const run = (action: Action) => dispatch(ctxOf(env, state(), start([], action, NOW).entry), action)
  return { argvs, stdins, run }
}

const ensure = (over: Partial<Extract<Action, { kind: 'pr' }>> = {}): Action => ({
  kind: 'pr',
  key: prKey(REF, 'ensure'),
  class: 'free',
  rule: 'S2',
  reason: 'the reviewing step\'s PR',
  issue: 300,
  op: 'ensure',
  branch: 'issue-300',
  base: 'main',
  pr: null,
  title: 'Add the thing',
  summary: 'It adds the thing.',
  evidence: 'npm test: 3 pass',
  brief: BRIEF,
  ...over,
})

const verbs = (argvs: string[][]) => argvs.map(a => (a[0] === 'gh' ? `gh ${a[1]} ${a[2]}` : a[0] ?? ''))

// --- the body (8.1) ------------------------------------------------------------------------------------------

describe('the PR body and title (8.1)', () => {
  test('the loop\'s body: the summary, its one linkage line, the brief, the evidence and its footer; free text links nothing', () => {
    const body = prBody({ issue: 300, summary: 'Fixes #12 and closes #13.', linkage: 'Closes', brief: BRIEF, evidence: 'resolves #14' })
    expect(body).toBe(`Fixing #12 and closing #13.\n\nCloses #300\n\nDesign brief: ${BRIEF}\n\n## Evidence\nresolving #14\n\n${footer(300)}`)
    expect(prBody({ issue: 300, summary: '', linkage: 'Refs', brief: 'https://evil.example', evidence: null })).toBe(`Refs #300\n\n${footer(300)}`)
    expect(prBody({ issue: 300, summary: 'x'.repeat(5000), linkage: 'Closes', brief: null, evidence: null }).length).toBeLessThan(4100)
  })

  test('the linkage follows the Rollout: merge closes the issue, run-it and keep-open refer to it; anything else is none', () => {
    expect(rolloutLinkage('ROLLOUT merge source=brief\n')).toBe('Closes')
    expect(rolloutLinkage('ROLLOUT run-it source=body')).toBe('Refs')
    expect(rolloutLinkage('ROLLOUT keep-open source=brief')).toBe('Refs')
    expect(rolloutLinkage('ROLLOUT conflict brief says merge')).toBeNull()
  })

  test('a title is one line within 72 characters with no closing keyword; none gives the issue\'s number', () => {
    expect(prTitle('Fixes #12: the parser\nsecond line', 300)).toBe('Fixing #12: the parser')
    expect(prTitle('t'.repeat(100), 300)).toHaveLength(72)
    expect(prTitle('', 300)).toBe('Work on #300')
  })

  test('the work a body keeps when the action brings none: the loop\'s own summary and evidence of its body, else the PR\'s own text', () => {
    const own = prBody({ issue: 300, summary: 'The summary.\n\nTwo paragraphs.', linkage: 'Closes', brief: BRIEF, evidence: 'npm test: 3 pass\n\n## Evidence\nmore' })
    expect(bodyWork(own, 300)).toEqual({ summary: 'The summary.\n\nTwo paragraphs.', evidence: 'npm test: 3 pass\n\n## Evidence\nmore' })
    expect(bodyWork(prBody({ issue: 300, summary: '', linkage: 'Refs', brief: null, evidence: null }), 300)).toEqual({ summary: '', evidence: null })
    expect(bodyWork('A hand-written PR.\r\n\r\nCloses #300', 300)).toEqual({ summary: 'A hand-written PR.\n\nCloses #300', evidence: null })
  })

  test('the readers: a branch\'s PRs newest first, a PR\'s fields, a created PR\'s number', () => {
    expect(listedPrs('[{"number": 5, "state": "CLOSED"}, {"number": 9, "state": "OPEN"}, {"number": 7, "state": "DRAFT"}]')).toEqual([{ pr: 9, state: 'OPEN' }, { pr: 5, state: 'CLOSED' }])
    expect(listedPrs('not json')).toBeNull()
    expect(prRead('{"pr": {"state": "closed", "merged": true, "body": null, "head": {"ref": "issue-1"}}}')).toEqual({ open: false, merged: true, body: '', ref: 'issue-1', repo: null })
    expect(prRead('{"comments": []}')).toBeNull()
    expect(createdPr(`https://github.com/${REPO}/pull/513\n`, REPO)).toBe(513)
    expect(createdPr('https://github.com/other/repo/pull/513', REPO)).toBeNull()
  })
})

// --- ensure and body (8.1, 9.3) ----------------------------------------------------------------------------------

describe('the pr executor: one PR per branch for life (3.5, 8.1)', () => {
  test('with no PR it opens one with the loop\'s body and title; run again, it finds that one and writes nothing', async () => {
    const g = gh()
    const w = act(g)
    expect(await w.run(ensure())).toEqual({ status: 'done', outcome: { kind: 'pr', pr: 500, created: true, reopened: false }, summary: 'opened PR #500 for #300 on issue-300 (Closes #300)' })
    expect(verbs(w.argvs)).toEqual(['gh pr list', 'callum-flow-rollout', 'gh pr create'])
    expect(w.argvs[2]).toEqual(['gh', 'pr', 'create', '--repo', REPO, '--base', 'main', '--head', 'issue-300', '--title', 'Add the thing', '--body-file', '-'])
    expect(g.prs[0]?.body).toBe(prBody({ issue: 300, summary: 'It adds the thing.', linkage: 'Closes', brief: BRIEF, evidence: 'npm test: 3 pass' }))
    const again = act(g)
    expect(await again.run(ensure())).toMatchObject({ status: 'done', outcome: { kind: 'pr', pr: 500, created: false, reopened: false } })
    expect(g.prs).toHaveLength(1)
    expect(g.writes).toHaveLength(1)
  })

  test('an adopted PR keeps its number and its own text, and gets the loop\'s linkage: a run-it Rollout refers to the issue', async () => {
    const g = gh({ prs: [{ number: 621, state: 'OPEN', ref: 'issue-300', repo: REPO, trusted: true, body: 'Hand-made. Fixes #300 and #301.', title: 'x' }], rollout: 'ROLLOUT run-it source=brief' })
    const w = act(g)
    expect(await w.run(ensure({ title: '', summary: '', evidence: null }))).toMatchObject({ status: 'done', outcome: { kind: 'pr', pr: 621, created: false, reopened: false } })
    expect(g.prs[0]?.body).toBe(`Hand-made. Fixing #300 and #301.\n\nRefs #300\n\nDesign brief: ${BRIEF}\n\n${footer(300)}`)
    // its body is the loop's now: ensured again, the same body, so nothing is written
    expect(await act(g).run(ensure({ title: '', summary: '', evidence: null }))).toMatchObject({ status: 'done', summary: expect.stringContaining('its body is the loop\'s') })
    expect(g.writes).toHaveLength(1)
  })

  test('an action with no work of its own (a record rebuilt without its build entry) keeps the PR\'s own summary and evidence', async () => {
    const own = prBody({ issue: 300, summary: 'It adds the thing.', linkage: 'Closes', brief: BRIEF, evidence: 'npm test: 3 pass' })
    const g = gh({ prs: [{ number: 621, state: 'OPEN', ref: 'issue-300', repo: REPO, trusted: true, body: own, title: 'x' }] })
    // the plan's action when the ledger has no done build of the life (rules-review.ts workOf)
    const bare = { title: 'Factory loop work for #300', summary: '', evidence: null }
    expect(await act(g).run(ensure({ ...bare, pr: 621 }))).toMatchObject({ status: 'done', summary: expect.stringContaining('its body is the loop\'s') })
    expect(g.writes).toEqual([])
    // a linkage FAIL's rewrite keeps them too
    g.rollout = 'ROLLOUT keep-open source=brief'
    expect(await act(g).run({ ...ensure({ ...bare, op: 'body', pr: 621 }), key: prKey(REF, 'body', 1) })).toMatchObject({ status: 'done' })
    expect(g.prs[0]?.body).toBe(prBody({ issue: 300, summary: 'It adds the thing.', linkage: 'Refs', brief: BRIEF, evidence: 'npm test: 3 pass' }))
  })

  test('an action with no summary but a fix\'s evidence (an adopted PR whose fixer answered an evidence finding) writes that evidence over the body\'s', async () => {
    const own = prBody({ issue: 300, summary: 'It adds the thing.', linkage: 'Closes', brief: BRIEF, evidence: 'old shot' })
    const pr = () => ({ number: 621, state: 'OPEN', ref: 'issue-300', repo: REPO, trusted: true, body: own, title: 'x' })
    const g = gh({ prs: [pr()] })
    const fixed = { title: 'Factory loop work for #300', summary: '', evidence: 'shot' }
    expect(await act(g).run(ensure({ ...fixed, pr: 621 }))).toMatchObject({ status: 'done', summary: expect.stringContaining('the loop\'s body written') })
    expect(g.prs[0]?.body).toBe(prBody({ issue: 300, summary: 'It adds the thing.', linkage: 'Closes', brief: BRIEF, evidence: 'shot' }))
    // a linkage FAIL's rewrite takes it too
    const h = gh({ prs: [pr()], rollout: 'ROLLOUT keep-open source=brief' })
    expect(await act(h).run({ ...ensure({ ...fixed, op: 'body', pr: 621 }), key: prKey(REF, 'body', 1) })).toMatchObject({ status: 'done' })
    expect(h.prs[0]?.body).toBe(prBody({ issue: 300, summary: 'It adds the thing.', linkage: 'Refs', brief: BRIEF, evidence: 'shot' }))
  })

  test('a PR closed unmerged is reopened (a resume after a hand close, E4); a merged one is never reused', async () => {
    const closed = gh({ prs: [{ number: 621, state: 'CLOSED', ref: 'issue-300', repo: REPO, trusted: true, body: '', title: 'x' }] })
    const w = act(closed)
    expect(await w.run(ensure({ pr: 621 }))).toMatchObject({ status: 'done', outcome: { kind: 'pr', pr: 621, created: false, reopened: true } })
    expect(verbs(w.argvs)).toEqual(['gh pr list', 'callum-flow-issue-read', 'callum-flow-rollout', 'gh pr reopen', 'gh pr edit'])
    const merged = gh({ prs: [{ number: 621, state: 'MERGED', ref: 'issue-300', repo: REPO, trusted: true, body: '', title: 'x' }] })
    expect(await act(merged).run(ensure())).toMatchObject({ status: 'done', outcome: { kind: 'pr', created: true } })
  })

  test('an open PR comes before a closed one, even the one plan named: a resume after a hand close uses the PR opened since', async () => {
    const g = gh({
      prs: [
        { number: 621, state: 'CLOSED', ref: 'issue-300', repo: REPO, trusted: true, body: '', title: 'x' },
        { number: 640, state: 'OPEN', ref: 'issue-300', repo: REPO, trusted: true, body: 'Opened by a person.', title: 'y' },
      ],
    })
    const w = act(g)
    expect(await w.run(ensure({ pr: 621 }))).toMatchObject({ status: 'done', outcome: { kind: 'pr', pr: 640, created: false, reopened: false } })
    expect(verbs(w.argvs)).toEqual(['gh pr list', 'callum-flow-issue-read', 'callum-flow-rollout', 'gh pr edit'])
    expect(g.prs.map(p => [p.number, p.state])).toEqual([[621, 'CLOSED'], [640, 'OPEN']])
    // the order: open first, the named one first within each state, then newest first
    const listed = [{ pr: 9, state: 'CLOSED' as const }, { pr: 5, state: 'CLOSED' as const }, { pr: 7, state: 'OPEN' as const }, { pr: 3, state: 'OPEN' as const }, { pr: 8, state: 'MERGED' as const }]
    expect(candidates(listed, 5).map(l => l.pr)).toEqual([7, 3, 5, 9])
    expect(candidates(listed, 3).map(l => l.pr)).toEqual([3, 7, 9, 5])
  })

  test('a closed PR GitHub refuses to reopen (its branch was deleted) is passed over for the next one, then a new PR; a re-run uses that one', async () => {
    const g = gh({ prs: [{ number: 621, state: 'CLOSED', ref: 'issue-300', repo: REPO, trusted: true, body: '', title: 'x', gone: true }] })
    const w = act(g)
    expect(await w.run(ensure({ pr: 621 }))).toEqual({
      status: 'done',
      outcome: { kind: 'pr', pr: 501, created: true, reopened: false },
      summary: 'opened PR #501 for #300 on issue-300 (Closes #300); #621 not reopened: GraphQL: Could not open the pull request. (reopenPullRequest)',
    })
    expect(verbs(w.argvs)).toEqual(['gh pr list', 'callum-flow-issue-read', 'callum-flow-rollout', 'gh pr reopen', 'gh pr create'])
    // run again with the record's old PR named: the new open one is used, nothing written
    const again = act(g)
    expect(await again.run(ensure({ pr: 621 }))).toMatchObject({ status: 'done', outcome: { kind: 'pr', pr: 501, created: false, reopened: false } })
    expect(verbs(again.argvs)).toEqual(['gh pr list', 'callum-flow-issue-read', 'callum-flow-rollout'])
    // a reopen that failed because GitHub or the network was down is tried again, never passed over
    expect(refusedReopen({ exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' })).toBeNull()
    expect(refusedReopen({ exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' })).toBeNull()
    expect(refusedReopen({ exitCode: 1, stdout: '', stderr: 'GraphQL: Could not open the pull request.' })).toBe('GraphQL: Could not open the pull request.')
  })

  test('a PR by an untrusted author, or from another repository\'s branch of the same name, is left alone', async () => {
    const g = gh({
      prs: [
        { number: 630, state: 'OPEN', ref: 'issue-300', repo: REPO, trusted: false, body: 'Closes #300', title: 'x' },
        { number: 631, state: 'OPEN', ref: 'issue-300', repo: 'someone/fork', trusted: true, body: 'Closes #300', title: 'x' },
      ],
    })
    const w = act(g)
    expect(await w.run(ensure())).toMatchObject({ status: 'done', outcome: { kind: 'pr', created: true } })
    expect(g.prs.filter(p => p.number >= 630).map(p => p.body)).toEqual(['Closes #300', 'Closes #300'])
  })

  test('a Rollout that does not read writes nothing and fails, to be tried again; a failed list too', async () => {
    const g = gh({ rollout: 'ROLLOUT conflict brief says merge but issue #300 has a Run it heading' })
    expect(await act(g).run(ensure())).toMatchObject({ status: 'failed' })
    expect(g.writes).toEqual([])
    const down = gh({ down: true })
    expect(await act(down).run(ensure())).toMatchObject({ status: 'failed', summary: 'gh pr list: exit 1: HTTP 502' })
    expect(down.writes).toEqual([])
  })

  test('op body writes the loop\'s body again on the PR (a linkage FAIL, 9.3); with no PR it is refused, never retried', async () => {
    const g = gh({ prs: [{ number: 621, state: 'OPEN', ref: 'issue-300', repo: REPO, trusted: true, body: 'Closes #300 wrongly', title: 'x' }], rollout: 'ROLLOUT keep-open source=brief' })
    const body: Action = { ...ensure({ op: 'body', pr: 621 }), key: prKey(REF, 'body', 1) }
    expect(await act(g).run(body)).toEqual({ status: 'done', outcome: { kind: 'pr', pr: 621, created: false, reopened: false }, summary: "the loop's body written on PR #621 (Refs #300)" })
    expect(g.prs[0]?.body).toContain('\n\nRefs #300\n\n')
    expect(await act(g).run({ ...body, pr: null } as Action)).toMatchObject({ status: 'failed', noRetry: true })
    expect(await act(g).run(ensure({ branch: 'issue-300; rm -rf /' }))).toMatchObject({ status: 'failed', noRetry: true })
  })
})

// --- a split's children (8.7) ----------------------------------------------------------------------------------

const splitOf = (key: string, over: Partial<Extract<Action, { kind: 'split' }>> = {}): Action => ({
  kind: 'split',
  key: childKey(REF, key),
  class: 'free',
  rule: 'S2',
  reason: 'a child',
  issue: 300,
  parent: 300,
  child: { key, title: 'Part one: Fixes #12', body: '## Design brief\nresolves #13', blockedBy: [], ready: true },
  blockedBy: [],
  ...over,
})

describe('the split executor (8.7)', () => {
  test('a child is made with its hidden key, linked under its parent and to its blockers, then labelled ready; run again it is found, and nothing is written twice', async () => {
    const g = gh({ issues: [{ number: 300, id: 9_000_300, title: 'parent', body: 'p', labels: [] }, { number: 601, id: 9_000_601, title: 'a', body: 'a', labels: [] }] })
    const action = splitOf('b', { blockedBy: [601] })
    expect(await act(g).run(action)).toEqual({ status: 'done', outcome: { kind: 'split', child: 602 }, summary: 'made #602 under #300, blocked by #601, ready' })
    const child = g.issues.find(i => i.number === 602)
    expect(child?.title).toBe('Part one: Fixing #12')
    expect(child?.body).toBe(childBody('## Design brief\nresolves #13', 300, action.key))
    expect(child?.body).toContain(hiddenKey(action.key))
    expect(child?.body).toContain('resolving #13')
    expect(g.subs.get(300)).toEqual([9_000_602])
    expect(g.blockers.get(602)).toEqual([9_000_601])
    expect(child?.labels).toEqual([READY])
    const writes = g.writes.length
    expect(await act(g).run(action)).toMatchObject({ status: 'done', outcome: { kind: 'split', child: 602 }, summary: expect.stringContaining('found #602') })
    // the label is the one write a retry repeats, and adding a label twice changes nothing
    expect(g.writes.slice(writes).map(a => a.slice(0, 3).join(' '))).toEqual(['gh issue edit'])
    expect(g.subs.get(300)).toEqual([9_000_602])
    expect(g.blockers.get(602)).toEqual([9_000_601])
  })

  test('a child that waits on an owner decision is not labelled ready', async () => {
    const g = gh({ issues: [{ number: 300, id: 9_000_300, title: 'parent', body: 'p', labels: [] }] })
    const action = splitOf('a', { child: { key: 'a', title: 'Part', body: 'b', blockedBy: [], ready: false } })
    expect(await act(g).run(action)).toMatchObject({ status: 'done', outcome: { kind: 'split', child: 601 } })
    expect(g.writes.map(a => a.slice(0, 3).join(' '))).toEqual(['gh issue create', 'gh api --method'])
  })

  test('the readers: the child by its key, an issue\'s id, a created issue\'s number, the link ids', () => {
    const key = childKey(REF, 'a')
    expect(foundChild(JSON.stringify({ issues: [{ number: 9, id: 90, body: `x ${hiddenKey(key)}` }] }), key)).toEqual({ number: 9, id: 90 })
    expect(foundChild(JSON.stringify({ issues: [{ number: 9, id: 90, body: hiddenKey(`${key}x`) }] }), key)).toBeNull()
    expect(foundChild('{}', key)).toBeUndefined()
    expect(issueId('{"issue": {"id": 12}}')).toBe(12)
    expect(issueId('{"issue": {}}')).toBeNull()
    expect(createdIssue(`https://github.com/${REPO}/issues/77\n`, REPO)).toBe(77)
    expect(ids('1\n2\n')).toEqual([1, 2])
    expect(ids('{"message": "Not Found"}')).toBeNull()
    expect(childTitle('t'.repeat(200))).toHaveLength(120)
  })
})
