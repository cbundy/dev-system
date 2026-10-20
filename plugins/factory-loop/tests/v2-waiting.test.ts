// The waiting state at pass level (docs/factory-loop/v2/SPEC.md 3.1, 4.3, 4.4, 8.7), through the
// driver as v2-switch.test.ts drives it: a designer answers wait; the pass writes the blocked_by
// link and labels the issue factory:waiting; a later pass whose issue or PR read shows the
// condition held takes the record to queued and then designing, and the next design prompt
// carries the cleared note.
import { describe, expect, mock, test } from 'claude-code/testing'

import type { SourceCtx } from '../hooks/v2/observe'
import { heldOf, readWaits, waitKey } from '../hooks/v2/sources-waits'
import { handshakePath } from '../hooks/v2/workspace'
import { entryKey, stepKey } from '../hooks/v2/keys'
import { recordsToStore } from '../hooks/v2/observe'
import type { IssueRecord, WaitCondition, WaitRead } from '../hooks/v2/types'
import { renderQuestion } from '../hooks/v2/question.mjs'
import { MIN, NOW, entry } from './fixtures'
import { CFG_DIR, NO_EVENTS, PROCESS, QUIET_BEATS, REPO, SESSION, TOOLS, factoryDoc, host, iso } from './host'
import type { Seen } from './host'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
const HOUR = 60 * MIN

function designing(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    issue: 470,
    life: 'tbq3k0',
    seq: 3,
    seqAt: NOW - 10 * MIN,
    state: 'designing',
    since: NOW - 10 * MIN,
    resumeTo: null,
    branch: 'issue-470',
    pr: null,
    head: null,
    approvedPatch: null,
    brief: null,
    step: 'design',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 0,
    round: 0,
    question: null,
    parts: null,
    why: null,
    notes: [],
    prClosedAt: null,
    wait: null,
    lives: 1,
    ...over,
  }
}

// the CLIs a pass reads, quiet; the loop's slot for #470 is leased; the conditions' states are the test's
type Github = { issue57: 'open' | 'closed'; pr812: 'OPEN' | 'MERGED'; tag?: string; compare?: string }
function world(github: Github, extra: (argv: string[], s: Seen) => { exitCode?: number; stdout?: string; stderr?: string } | undefined = () => undefined) {
  const slots = [{ name: '1', path: '/slots/1', status: 'leased', branch: 'issue-470', lease_id: 'L1', lease_holder: 'factory-loop:470:tbq3k0', leased_at: iso(NOW - HOUR), processes: [] }]
  return (argv: string[], s: Seen) => {
    const own = extra(argv, s)
    if (own !== undefined) return own
    const [cmd, ...args] = argv
    // the companion's slot tool prepares the slot at origin's head
    if (cmd?.endsWith('/factory-slot') && args.includes('prepare')) return { stdout: 'PREPARED head=9e01b77c0ffee000000000000000000000000001\n' }
    switch (cmd) {
      case 'callum-flow-factory-state':
        return { stdout: factoryDoc([]) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: 'queue known=none now=none\n' }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read': {
        if (args.includes('--list')) return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
        const n = Number(args[1])
        if (n === 57) return { stdout: JSON.stringify({ issue: { number: 57, id: 9057, state: github.issue57, labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }) }
        return { stdout: JSON.stringify({ issue: { number: n, id: 9000 + n, state: 'open', labels: ['factory:waiting'], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }) }
      }
      case 'gh':
        if (args[0] === 'release' && args[1] === 'view') return github.tag === undefined ? { exitCode: 1, stderr: 'release not found' } : { stdout: JSON.stringify({ tagName: github.tag }) }
        if (args[0] === 'api' && args[1]?.startsWith(`repos/${REPO}/compare/`)) return { stdout: `${github.compare ?? 'ahead'}\n` }
        if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify({ state: github.pr812, mergedAt: github.pr812 === 'MERGED' ? iso(NOW - MIN) : null }) }
        return undefined
      case 'treehouse':
        return { stdout: JSON.stringify(slots) }
    }
    return undefined
  }
}

// each drives about twenty passes through the driver: more than ENGINE_TEST (host.ts) gives
const SLOW = { timeoutMs: 60_000 }

describe('a designer that waits, end to end (v2 SPEC 8.7, 4.3)', () => {
  const CASES = [
    {
      name: 'an issue closing',
      conditions: [{ kind: 'issue-closed', issue: 57 }],
      later: { issue57: 'closed', pr812: 'OPEN' },
      read: 'callum-flow-issue-read --json 57',
      cleared: 'The loop resumed this: #57 closed; every condition holds.',
    },
    {
      name: 'a PR merging',
      conditions: [{ kind: 'pr-merged', pr: 812 }],
      later: { issue57: 'open', pr812: 'MERGED' },
      read: `gh pr view 812 --repo ${REPO} --json state,mergedAt`,
      cleared: 'The loop resumed this: PR #812 merged; every condition holds.',
    },
    {
      // the newest tag lacks the commit (compare says ahead) until a newer tag carries it (behind)
      name: 'a release tag containing a commit',
      conditions: [{ kind: 'tag-contains', sha: '35bb655' }],
      first: { tag: 'v0.50.0', compare: 'ahead' },
      later: { issue57: 'open', pr812: 'OPEN', tag: 'v0.51.0', compare: 'behind' },
      read: `gh api repos/${REPO}/compare/v0.51.0...35bb655 --jq .status`,
      cleared: 'The loop resumed this: release v0.51.0 contains 35bb655; every condition holds.',
    },
  ] as const
  for (const c of CASES) {
    test(`waiting on ${c.name}: the first pass enters waiting and writes its link and label; a later pass whose read shows it held resumes the record to designing, and the next design prompt carries the cleared note`, SLOW, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const r = designing()
      const answer = { kind: 'wait', brief: null, question: null, conditions: c.conditions, reason: 'blocked on the reader', reasons: null, children: [], text: 'blocked on the reader' }
      const design = entry(stepKey(r, 'design', 1), 'agent-step', {
        class: 'develop',
        rule: 'S2',
        issue: 470,
        step: 'design',
        agentId: 'agent-1',
        status: 'done',
        startedAt: NOW - 8 * MIN,
        endedAt: NOW - 7 * MIN,
        outcome: { kind: 'step', step: 'design', result: { event: 'not-ok', reason: 'wait', why: null, head: null, choice: null, data: answer } },
      })
      // GitHub as the pass reads it: both conditions open until the test closes one
      const github: Github = { issue57: 'open', pr812: 'OPEN', ...('first' in c ? c.first : {}) }
      const h = host(on, {
        config: { repo: REPO, mode: 'act', checkout: '/work' },
        store: { [`records:${REPO}`]: recordsToStore([r], NOW - MIN), [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries: [design] } },
        run: (argv, s) => world(github)(argv, s),
      })
      // the companion runs in the session: its handshake, written every minute (10.9)
      let at = NOW
      const pass = async (ms: number) => {
        h.files.set(handshakePath(`${CFG_DIR}/factory-loop`, SESSION), JSON.stringify({ v: 1, session: SESSION, process: PROCESS, version: '0.38.2', at: iso(at) }))
        at += ms
        await clock.advance(ms)
      }
      const stored = () => (h.store.get(`records:${REPO}`) as { records: IssueRecord[] }).records.find(x => x.issue === 470) as IssueRecord
      const ran = () => h.commands().map(x => x.argv.join(' '))
      await $.session.start(START)
      await pass(6_000)
      for (let i = 0; i < 6 && h.entry(entryKey(stored(), 'comment'))?.status !== 'done'; i++) await pass(60_000)
      // waiting, with the conditions and its target; no slot, no tell
      const waiting = stored()
      expect(waiting).toMatchObject({ state: 'waiting', step: null, resumeTo: 'designing', wait: c.conditions, seq: 4 })
      expect(h.ledger().some(e => e.key.endsWith('/tell'))).toBe(false)
      // the label and the comment, and for an issue condition the blocked_by link from #470 to #57 by its REST id
      expect(ran()).toContain('gh issue edit 470 --repo cbundy/dev-system --add-label factory:waiting --remove-label ' + ran().find(l => l.includes('--add-label factory:waiting'))?.split('--remove-label ')[1])
      const posts = ran().filter(l => l.startsWith(`gh api --method POST repos/${REPO}/issues/470/dependencies/blocked_by`))
      expect(posts).toEqual(c.conditions[0].kind === 'issue-closed' ? [`gh api --method POST repos/${REPO}/issues/470/dependencies/blocked_by -F issue_id=9057`] : [])
      expect(h.spawns).toEqual([])
      // the condition still open: passes read it and change nothing
      for (let i = 0; i < 2; i++) await pass(6 * 60_000)
      expect(ran()).toContain('first' in c ? `gh api repos/${REPO}/compare/v0.50.0...35bb655 --jq .status` : c.read)
      expect(ran().filter(l => l.includes('/compare/')).length).toBe('first' in c ? 1 : 0)
      expect(stored()).toMatchObject({ state: 'waiting', seq: 4 })
      // the condition holds: the read shows it, and the record goes on by itself
      Object.assign(github, c.later)
      let designer: IssueRecord | null = null
      for (let i = 0; i < 6 && designer === null; i++) {
        await pass(6 * 60_000)
        if (h.spawns.length > 0) designer = stored()
      }
      expect(h.ledger().find(e => e.key.endsWith('/s5/t'))).toMatchObject({ status: 'done', outcome: { kind: 'transition', row: 'C1', event: 'cleared', from: 'waiting', to: 'queued', via: 'cleared' } })
      expect(h.ledger().find(e => e.key.endsWith('/s6/t'))).toMatchObject({ status: 'done', outcome: { kind: 'transition', row: 'T1', to: 'designing' } })
      // the designer started with the cleared note first among its notes (the engine's test host hands a spawn
      // no agent id, so the step then ends unknown and the record goes on to its retry: the note stays)
      expect(designer).toMatchObject({ state: 'designing', step: 'design', wait: null, resumeTo: null })
      expect(designer?.notes[0]).toBe(c.cleared)
      expect(h.spawns).toHaveLength(1)
      expect(h.spawns[0]?.prompt).toContain(c.cleared)
    })
  }
})

describe('a designer that asks with options, end to end (#856)', () => {
  test('the pass parks the record and posts a comment that keeps its sections and options at the start of a line; ticking an option and taking the label off unparks it, and the next design prompt carries the choice', SLOW, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const r = designing()
    const asked = renderQuestion({ question: 'Which API?', context: 'Two shapes exist.', options: [{ key: 'A', title: 'v1', detail: 'old' }, { key: 'B', title: 'v2', detail: null }], recommendation: { key: 'B', reason: 'newer' } })
    const design = entry(stepKey(r, 'design', 1), 'agent-step', {
      class: 'develop',
      rule: 'S2',
      issue: 470,
      step: 'design',
      agentId: 'agent-1',
      status: 'done',
      startedAt: NOW - 8 * MIN,
      endedAt: NOW - 7 * MIN,
      outcome: { kind: 'step', step: 'design', result: { event: 'not-ok', reason: 'question', why: null, head: null, choice: null, data: { kind: 'question', brief: null, question: asked, conditions: [], reason: null, reasons: null, children: [], text: asked } } },
    })
    // GitHub as the pass reads it: the issue carries factory:parked until the test takes it off; the
    // comments are what the pass posted, with the owner's tick once the test makes it
    const posted: { body: string; at: number }[] = []
    let labels = [{ name: 'factory:parked' }]
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work' },
      store: { [`records:${REPO}`]: recordsToStore([r], NOW - MIN), [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries: [design] } },
      run: (argv, s) =>
        world({ issue57: 'open', pr812: 'OPEN' }, (a, seen) => {
          if (a[0] === 'gh' && a[1] === 'issue' && a[2] === 'comment') {
            posted.push({ body: seen.stdin ?? '', at: Date.now() })
            return { stdout: `https://github.com/${REPO}/issues/470#issuecomment-1\n` }
          }
          if (a[0] === 'callum-flow-issue-read' && a[1] === '--json' && a[2] === '470') {
            const comments = posted.map((c, i) => ({ body: c.body, created_at: new Date(c.at).toISOString(), html_url: `https://github.com/${REPO}/issues/470#issuecomment-${i + 1}` }))
            if (a.includes('--comments')) return { stdout: JSON.stringify({ comments, stripped: 0 }) }
            return { stdout: JSON.stringify({ issue: { number: 470, id: 9470, state: 'open', labels, issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }) }
          }
          return undefined
        })(argv, s),
    })
    let at = NOW
    const pass = async (ms: number) => {
      h.files.set(handshakePath(`${CFG_DIR}/factory-loop`, SESSION), JSON.stringify({ v: 1, session: SESSION, process: PROCESS, version: '0.38.2', at: iso(at) }))
      at += ms
      await clock.advance(ms)
    }
    const stored = () => (h.store.get(`records:${REPO}`) as { records: IssueRecord[] }).records.find(x => x.issue === 470) as IssueRecord
    await $.session.start(START)
    await pass(6_000)
    for (let i = 0; i < 6 && h.entry(entryKey(stored(), 'comment'))?.status !== 'done'; i++) await pass(60_000)
    expect(stored()).toMatchObject({ state: 'parked', question: asked })
    expect(posted).toHaveLength(1)
    const body = posted[0]?.body ?? ''
    for (const line of ['#### Context', '#### Options', '#### Recommendation', '- [ ] **A** - v1', '- [ ] **B** - v2', 'Tick one option, or write your answer as a comment.']) expect(body).toMatch(new RegExp(`^(\\d+\\. )?${line.replace(/[*[\]]/g, '\\$&')}`, 'm'))
    expect(h.spawns).toEqual([])
    // the owner ticks B and takes the label off; a later pass reads the comments and unparks
    posted[0] = { body: body.replace('- [ ] **B**', '- [x] **B**'), at: posted[0]?.at ?? NOW }
    labels = [{ name: 'enhancement' }]
    let designer: IssueRecord | null = null
    for (let i = 0; i < 8 && designer === null; i++) {
      await pass(6 * 60_000)
      if (h.spawns.length > 0) designer = stored()
    }
    expect(designer?.notes[0]).toMatch(/^Owner chose option B: /)
    expect(h.spawns[0]?.prompt).toContain('Owner chose option B: ')
  })
})

// --- the reads (sources-waits.ts) ------------------------------------------------------------------

describe('the conditions\' reads (v2 SPEC 2.4, 4.4)', () => {
  const issue = (n: number): WaitCondition => ({ kind: 'issue-closed', issue: n })
  const pr = (n: number): WaitCondition => ({ kind: 'pr-merged', pr: n })
  const waiting = (n: number, wait: WaitCondition[]): IssueRecord => designing({ issue: n, state: 'waiting', step: null, wait, resumeTo: 'designing' })
  const EVERY = 5 * MIN

  // ctx: a source context over these records whose commands answer from `answers` (by joined argv; an
  // unlisted one fails), counting what ran
  function ctx(records: IssueRecord[], answers: Record<string, string | null>, over: Partial<SourceCtx> = {}) {
    const ran: string[] = []
    const envs: (Record<string, string> | undefined)[] = []
    const c = {
      now: NOW,
      rt: { repo: REPO },
      tags: {},
      run: async (argv: string[], _stdin?: string, _t?: number, env?: Record<string, string>) => {
        const line = argv.join(' ')
        ran.push(line)
        envs.push(env)
        const out = answers[line]
        return out === undefined || out === null ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : { exitCode: 0, stdout: out, stderr: '' }
      },
      records,
      prBudget: 10,
      limited: () => false,
      ...over,
    } as unknown as SourceCtx
    return { c, ran, envs }
  }
  const ISSUE = (n: number, state: string) => JSON.stringify({ issue: { number: n, id: 9000 + n, state }, stripped: 0 })
  const PR = (n: number) => `gh pr view ${n} --repo ${REPO} --json state,mergedAt`

  test('heldOf: an issue is held when it is closed; a PR when it is merged, by state or by mergedAt; anything the reader did not say is open, never held', () => {
    expect(heldOf(issue(57), ISSUE(57, 'closed'))).toBe(true)
    expect(heldOf(issue(57), ISSUE(57, 'open'))).toBe(false)
    expect(heldOf(pr(812), JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T10:00:00Z' }))).toBe(true)
    expect(heldOf(pr(812), JSON.stringify({ state: 'CLOSED', mergedAt: '2026-10-17T10:00:00Z' }))).toBe(true)
    expect(heldOf(pr(812), JSON.stringify({ state: 'OPEN', mergedAt: null }))).toBe(false)
    expect(heldOf(pr(812), JSON.stringify({ state: 'CLOSED', mergedAt: null }))).toBe(false)
    for (const bad of ['', 'not json', '[]', 'null', JSON.stringify({}), JSON.stringify({ issue: { state: 'weird' } })]) {
      expect({ bad, issue: heldOf(issue(57), bad) }).toEqual({ bad, issue: null })
    }
    expect(heldOf(pr(812), JSON.stringify({ state: 'weird' }))).toBeNull()
  })

  test('waitKey: the long forms carry the repo; a sibling without repo is read against the loop\'s own repo', async () => {
    const fi: WaitCondition = { kind: 'issue-closed', issue: 57, repo: 'o/n' }
    const ft: WaitCondition = { kind: 'tag-contains', sha: '35bb655', repo: 'o/n' }
    expect([waitKey(issue(57)), waitKey(fi), waitKey(pr(8)), waitKey({ kind: 'tag-contains', sha: '35bb655' }), waitKey(ft)]).toEqual(['issue:57', 'issue:o/n#57', 'pr:8', 'tag:35bb655', 'tag:o/n@35bb655'])
    // no tag of o/n is known: its two conditions are not read; the own issue is
    const c = ctx([waiting(1, [ft, issue(57)])], { 'callum-flow-issue-read --json 57': ISSUE(57, 'closed') }, { tag: 'v1' } as Partial<SourceCtx>)
    const out = await readWaits(c.c, {}, EVERY)
    expect(c.ran).toEqual(['callum-flow-issue-read --json 57'])
    expect(out).toEqual({ waits: { 'issue:57': { at: NOW, held: true } }, failed: [], unread: { 'tag:o/n@35bb655': { since: NOW, why: 'no-release' } } })
    expect(c.envs).toEqual([undefined])
  })

  describe('a condition on another repo (#981)', () => {
    const ft = (sha = '35bb655'): WaitCondition => ({ kind: 'tag-contains', sha, repo: 'o/n' })
    const cmpOn = (tag: string, sha: string) => `gh api repos/o/n/compare/${tag}...${sha} --jq .status`
    const KEY = 'tag:o/n@35bb655'

    test('a foreign tag is compared in its own repo against its own tag; ahead waits, behind holds; the loop\'s own tag changing does not read it again', async () => {
      const records = [waiting(1, [ft()])]
      const a = ctx(records, { [cmpOn('v1.1.0', '35bb655')]: 'ahead\n' }, { tag: 'v0.9.0', tags: { 'o/n': 'v1.1.0' } } as Partial<SourceCtx>)
      const first = await readWaits(a.c, {}, EVERY)
      expect(a.ran).toEqual([cmpOn('v1.1.0', '35bb655')])
      expect(first).toEqual({ waits: { [KEY]: { at: NOW, held: false, tag: 'v1.1.0' } }, failed: [], unread: {} })
      // the loop's own tag moves: nothing is read
      const own = ctx(records, {}, { tag: 'v0.10.0', tags: { 'o/n': 'v1.1.0' }, now: NOW + HOUR } as Partial<SourceCtx>)
      expect((await readWaits(own.c, first.waits, EVERY)).waits).toEqual(first.waits)
      expect(own.ran).toEqual([])
      // o/n's tag moves and carries the commit
      const next = ctx(records, { [cmpOn('v1.2.0', '35bb655')]: 'behind\n' }, { tag: 'v0.9.0', tags: { 'o/n': 'v1.2.0' }, now: NOW + MIN } as Partial<SourceCtx>)
      expect((await readWaits(next.c, first.waits, EVERY)).waits).toEqual({ [KEY]: { at: NOW + MIN, held: true, tag: 'v1.2.0' } })
    })

    test('a repo with no release (tag null) or no tag read yet keeps the condition open and is not read', async () => {
      for (const tags of [{ 'o/n': null }, {}]) {
        const c = ctx([waiting(1, [ft()])], {}, { tag: 'v0.9.0', tags } as Partial<SourceCtx>)
        expect(await readWaits(c.c, {}, EVERY)).toEqual({ waits: {}, failed: [], unread: { [KEY]: { since: NOW, why: 'no-release' } } })
        expect(c.ran).toEqual([])
      }
    })

    test('a foreign issue is read through the reader with CALLUM_FLOW_REPO set; closed holds, open and no state stay open', async () => {
      const fi: WaitCondition = { kind: 'issue-closed', issue: 57, repo: 'o/n' }
      const read = 'callum-flow-issue-read --json 57'
      const closed = ctx([waiting(1, [fi])], { [read]: ISSUE(57, 'closed') }, { rt: { repo: REPO, env: { A: '1' } } } as unknown as Partial<SourceCtx>)
      expect(await readWaits(closed.c, {}, EVERY)).toEqual({ waits: { 'issue:o/n#57': { at: NOW, held: true } }, failed: [], unread: {} })
      expect(closed.envs).toEqual([{ A: '1', CALLUM_FLOW_REPO: 'o/n' }])
      const open = ctx([waiting(1, [fi])], { [read]: ISSUE(57, 'open') })
      expect((await readWaits(open.c, {}, EVERY)).waits['issue:o/n#57']?.held).toBe(false)
      const nostate = ctx([waiting(1, [fi])], { [read]: JSON.stringify({ issue: {}, stripped: 0 }) })
      expect(await readWaits(nostate.c, {}, EVERY)).toEqual({ waits: {}, failed: ['issue:o/n#57'], unread: { 'issue:o/n#57': { since: NOW, why: 'read-failed' } } })
    })
  })

  test('each distinct condition of the waiting records is read once with no model call; other states\' records are not read; a read that shows it held is kept and not read again', async () => {
    const records = [waiting(1, [issue(57), pr(812)]), waiting(2, [issue(57)]), designing({ issue: 3, wait: null })]
    const first = ctx(records, { 'callum-flow-issue-read --json 57': ISSUE(57, 'closed'), [PR(812)]: JSON.stringify({ state: 'OPEN', mergedAt: null }) })
    const a = await readWaits(first.c, {}, EVERY)
    expect(first.ran.sort()).toEqual(['callum-flow-issue-read --json 57', PR(812)].sort())
    expect(a).toEqual({ waits: { 'issue:57': { at: NOW, held: true }, 'pr:812': { at: NOW, held: false } }, failed: [], unread: {} })
    // later: the held one is kept; the open one is read once its period passes, not before
    const soon = ctx(records, { [PR(812)]: JSON.stringify({ state: 'MERGED', mergedAt: null }) }, { now: NOW + MIN })
    expect((await readWaits(soon.c, a.waits, EVERY)).waits).toEqual(a.waits)
    expect(soon.ran).toEqual([])
    const due = ctx(records, { [PR(812)]: JSON.stringify({ state: 'MERGED', mergedAt: null }) }, { now: NOW + EVERY })
    expect((await readWaits(due.c, a.waits, EVERY)).waits).toEqual({ 'issue:57': { at: NOW, held: true }, 'pr:812': { at: NOW + EVERY, held: true } })
    expect(due.ran).toEqual([PR(812)])
    // a condition no record waits on is dropped from the cache
    expect((await readWaits(ctx([records[1] as IssueRecord], {}).c, a.waits, EVERY)).waits).toEqual({ 'issue:57': { at: NOW, held: true } })
  })

  test('a failed read keeps the condition open: the old read stays, the condition is named failed, and the others are still read', async () => {
    const records = [waiting(1, [issue(57), issue(58)])]
    const kept: Record<string, WaitRead> = { 'issue:57': { at: NOW - 10 * MIN, held: false } }
    const c = ctx(records, { 'callum-flow-issue-read --json 58': ISSUE(58, 'closed') })
    const out = await readWaits(c.c, kept, EVERY)
    expect(out.failed).toEqual(['issue:57'])
    expect(out.waits).toEqual({ 'issue:57': { at: NOW - 10 * MIN, held: false }, 'issue:58': { at: NOW, held: true } })
    // a reader that exits 0 with something that is not an issue is a failed read too
    const odd = ctx(records, { 'callum-flow-issue-read --json 57': '{"issue": {}}', 'callum-flow-issue-read --json 58': '<html>' })
    expect(await readWaits(odd.c, {}, EVERY)).toEqual({ waits: {}, failed: ['issue:57', 'issue:58'], unread: { 'issue:57': { since: NOW, why: 'read-failed' }, 'issue:58': { since: NOW, why: 'read-failed' } } })
    // a command that throws is a failed read
    const throwing = ctx(records, {})
    throwing.c.run = async () => {
      throw new Error('spawn failed')
    }
    expect(await readWaits(throwing.c, {}, EVERY)).toEqual({ waits: {}, failed: ['issue:57', 'issue:58'], unread: { 'issue:57': { since: NOW, why: 'read-failed' }, 'issue:58': { since: NOW, why: 'read-failed' } } })
  })

  describe('the unread time of a condition', () => {
    const records = [waiting(1, [issue(57)])]
    const READ = 'callum-flow-issue-read --json 57'

    test('a failing read starts it, a second failing pass keeps the first since; a read that says anything clears it', async () => {
      const first = await readWaits(ctx(records, {}).c, {}, EVERY)
      expect(first.unread).toEqual({ 'issue:57': { since: NOW, why: 'read-failed' } })
      const second = await readWaits(ctx(records, {}, { now: NOW + 2 * EVERY }).c, first.waits, EVERY, first.unread)
      expect(second.unread).toEqual({ 'issue:57': { since: NOW, why: 'read-failed' } })
      const open = await readWaits(ctx(records, { [READ]: ISSUE(57, 'open') }, { now: NOW + 3 * EVERY }).c, second.waits, EVERY, second.unread)
      expect(open.unread).toEqual({})
      const closed = await readWaits(ctx(records, { [READ]: ISSUE(57, 'closed') }, { now: NOW + 3 * EVERY }).c, second.waits, EVERY, second.unread)
      expect(closed.unread).toEqual({})
      // an output that says nothing is a failed read too
      const odd = await readWaits(ctx(records, { [READ]: '<html>' }).c, {}, EVERY)
      expect(odd.unread).toEqual({ 'issue:57': { since: NOW, why: 'read-failed' } })
    })

    test('a read skipped for the budget or a rate limit leaves it as it was', async () => {
      const kept = { 'issue:57': { since: NOW - HOUR, why: 'read-failed' as const } }
      const skipped = await readWaits(ctx(records, {}, { prBudget: 0 }).c, {}, EVERY, kept)
      expect(skipped.unread).toEqual(kept)
      const limited = await readWaits(ctx(records, {}, { limited: () => true }).c, {}, EVERY, kept)
      expect(limited.unread).toEqual(kept)
    })

    test('an entry no record waits on any more is dropped', async () => {
      const kept = { 'issue:57': { since: NOW - HOUR, why: 'read-failed' as const } }
      expect((await readWaits(ctx([], {}).c, {}, EVERY, kept)).unread).toEqual({})
    })

    test('a tag condition: no release starts it; a change of why restarts it; a known tag and a stored read clear it', async () => {
      const ft: WaitCondition = { kind: 'tag-contains', sha: '35bb655', repo: 'o/n' }
      const recs = [waiting(1, [ft])]
      const key = 'tag:o/n@35bb655'
      const none = await readWaits(ctx(recs, {}, { tags: {} } as Partial<SourceCtx>).c, {}, EVERY)
      expect(none.unread).toEqual({ [key]: { since: NOW, why: 'no-release' } })
      // the tag appears but its compare fails: the reason changes and the time restarts
      const failing = await readWaits(ctx(recs, {}, { tags: { 'o/n': 'v1' }, now: NOW + HOUR } as Partial<SourceCtx>).c, none.waits, EVERY, none.unread)
      expect(failing.unread).toEqual({ [key]: { since: NOW + HOUR, why: 'read-failed' } })
      // the compare says ahead: cleared
      const ahead = await readWaits(ctx(recs, { 'gh api repos/o/n/compare/v1...35bb655 --jq .status': 'ahead\n' }, { tags: { 'o/n': 'v1' }, now: NOW + 2 * HOUR } as Partial<SourceCtx>).c, failing.waits, EVERY, failing.unread)
      expect(ahead.unread).toEqual({})
      // a stored read for the known tag clears an entry that is left over
      const stored = { [key]: { at: NOW, held: false, tag: 'v1' } }
      const left = await readWaits(ctx(recs, {}, { tags: { 'o/n': 'v1' } } as Partial<SourceCtx>).c, stored, EVERY, { [key]: { since: NOW, why: 'no-release' as const } })
      expect(left.unread).toEqual({})
    })
  })

  test('the reads have a budget, oldest-checked first; none during a GitHub backoff (budget 0), and none after a rate limit met this pass', async () => {
    const records = [waiting(1, [issue(61), issue(62), issue(63)])]
    const kept: Record<string, WaitRead> = { 'issue:61': { at: NOW - 3 * HOUR, held: false }, 'issue:63': { at: NOW - 6 * HOUR, held: false } }
    const answers = Object.fromEntries([61, 62, 63].map(n => [`callum-flow-issue-read --json ${n}`, ISSUE(n, 'open')]))
    const two = ctx(records, answers, { prBudget: 2 })
    await readWaits(two.c, kept, EVERY)
    // never-read 62 first, then the oldest read, 63; 61 waits for the next pass
    expect(two.ran).toEqual(['callum-flow-issue-read --json 62', 'callum-flow-issue-read --json 63'])
    const backoff = ctx(records, answers, { prBudget: 0 })
    expect((await readWaits(backoff.c, kept, EVERY)).waits).toEqual(kept)
    expect(backoff.ran).toEqual([])
    let limited = false
    const limit = ctx(records, answers, { limited: () => limited })
    const run = limit.c.run
    limit.c.run = async argv => {
      limited = true
      return run(argv)
    }
    await readWaits(limit.c, kept, EVERY)
    expect(limit.ran).toHaveLength(1)
  })

  describe('a tag-contains condition: the compare of the commit with the newest release tag', () => {
    const tagOf = (sha: string): WaitCondition => ({ kind: 'tag-contains', sha })
    const cmp = (tag: string, sha: string) => `gh api repos/${REPO}/compare/${tag}...${sha} --jq .status`
    const SHA = '35bb655'

    test('heldOf: behind and identical hold, ahead and diverged do not, anything else keeps it open', () => {
      expect(heldOf(tagOf(SHA), 'behind\n')).toBe(true)
      expect(heldOf(tagOf(SHA), 'identical\n')).toBe(true)
      expect(heldOf(tagOf(SHA), 'ahead\n')).toBe(false)
      expect(heldOf(tagOf(SHA), 'diverged\n')).toBe(false)
      for (const other of ['', 'null', '{"status":"behind"}', 'weird']) expect(heldOf(tagOf(SHA), other)).toBeNull()
    })

    test('read once per tag with the compare, keyed tag:<sha>; held for behind; open for ahead, a failed read and no tag', async () => {
      const records = [designing({ issue: 1, state: 'waiting', step: null, wait: [tagOf(SHA)], resumeTo: 'designing' })]
      // ahead: not held, and the tag it was read for is kept
      const a = ctx(records, { [cmp('v0.50.0', SHA)]: 'ahead\n' }, { tag: 'v0.50.0' } as Partial<SourceCtx>)
      const first = await readWaits(a.c, {}, EVERY)
      expect(first).toEqual({ waits: { [`tag:${SHA}`]: { at: NOW, held: false, tag: 'v0.50.0' } }, failed: [], unread: {} })
      expect(a.ran).toEqual([cmp('v0.50.0', SHA)])
      // the same tag, any time later: not read again
      const same = ctx(records, {}, { tag: 'v0.50.0', now: NOW + HOUR } as Partial<SourceCtx>)
      expect((await readWaits(same.c, first.waits, EVERY)).waits).toEqual(first.waits)
      expect(same.ran).toEqual([])
      // a new tag: read again, and behind holds
      const next = ctx(records, { [cmp('v0.51.0', SHA)]: 'behind\n' }, { tag: 'v0.51.0', now: NOW + MIN } as Partial<SourceCtx>)
      const held = await readWaits(next.c, first.waits, EVERY)
      expect(held.waits).toEqual({ [`tag:${SHA}`]: { at: NOW + MIN, held: true, tag: 'v0.51.0' } })
      // a held result stays held, whatever the tag does
      const later = ctx(records, {}, { tag: 'v0.52.0', now: NOW + HOUR } as Partial<SourceCtx>)
      expect((await readWaits(later.c, held.waits, EVERY)).waits).toEqual(held.waits)
      expect(later.ran).toEqual([])
      // diverged and identical
      const div = ctx(records, { [cmp('v1', SHA)]: 'diverged\n' }, { tag: 'v1' } as Partial<SourceCtx>)
      expect((await readWaits(div.c, {}, EVERY)).waits[`tag:${SHA}`]?.held).toBe(false)
      const same2 = ctx(records, { [cmp('v1', SHA)]: 'identical\n' }, { tag: 'v1' } as Partial<SourceCtx>)
      expect((await readWaits(same2.c, {}, EVERY)).waits[`tag:${SHA}`]?.held).toBe(true)
      // a failed read and an unreadable output stay open and are named failed
      const failed = ctx(records, {}, { tag: 'v1' } as Partial<SourceCtx>)
      expect(await readWaits(failed.c, {}, EVERY)).toEqual({ waits: {}, failed: [`tag:${SHA}`], unread: { [`tag:${SHA}`]: { since: NOW, why: 'read-failed' } } })
      const odd = ctx(records, { [cmp('v1', SHA)]: 'weird' }, { tag: 'v1' } as Partial<SourceCtx>)
      expect(await readWaits(odd.c, {}, EVERY)).toEqual({ waits: {}, failed: [`tag:${SHA}`], unread: { [`tag:${SHA}`]: { since: NOW, why: 'read-failed' } } })
      // no tag known (no release yet, or its read failed): nothing is read, the condition stays open
      const none = ctx(records, {}, { tag: null } as Partial<SourceCtx>)
      expect(await readWaits(none.c, {}, EVERY)).toEqual({ waits: {}, failed: [], unread: { [`tag:${SHA}`]: { since: NOW, why: 'no-release' } } })
      expect(none.ran).toEqual([])
    })

    test('the compares count against the budget and stop after a rate limit, with the other waits', async () => {
      const shas = ['aaaaaaa', 'bbbbbbb', 'ccccccc']
      const records = [designing({ issue: 1, state: 'waiting', step: null, wait: shas.map(tagOf), resumeTo: 'designing' })]
      const answers = Object.fromEntries(shas.map(x => [cmp('v1', x), 'ahead\n']))
      const two = ctx(records, answers, { prBudget: 2, tag: 'v1' } as Partial<SourceCtx>)
      await readWaits(two.c, {}, EVERY)
      expect(two.ran).toHaveLength(2)
      const backoff = ctx(records, answers, { prBudget: 0, tag: 'v1' } as Partial<SourceCtx>)
      await readWaits(backoff.c, {}, EVERY)
      expect(backoff.ran).toEqual([])
      let limited = false
      const limit = ctx(records, answers, { limited: () => limited, tag: 'v1' } as Partial<SourceCtx>)
      const run = limit.c.run
      limit.c.run = async argv => {
        limited = true
        return run(argv)
      }
      await readWaits(limit.c, {}, EVERY)
      expect(limit.ran).toHaveLength(1)
    })
  })
})
