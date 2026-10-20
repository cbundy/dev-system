// The observe half's pure pieces against canned command output: the parsers (parse.ts), the
// event derivation (derive.ts) and the state assembly (state.ts). Shapes are copied from real
// output of callum-flow-factory-state, callum-flow-issue-read, usage-check.sh, treehouse,
// callum-flow-milestone and dev-query on 2026-10-12.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, EMPTY_CONTROL, controlFrom, loadConfig, parseDuration } from '../hooks/config'
import { EVENTS_SQL, LOOP_NOTE_MAX, deriveLedger, entryFromLoop, eventsFromRows, factsOf, loopEventArgs, loopNote, runsFromEvents } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import { newestTag, readMilestone, repoTags, tagRepos, waitsOnTag } from '../hooks/observe-milestone'
import type { MilestoneCache } from '../hooks/observe-milestone'
import { GITHUB_BACKOFF_MS, emptyCache, observe } from '../hooks/observe'
import type { Cache, Io, Observation, Runtime, Stored } from '../hooks/observe'
import {
  parseBrief,
  parseCheckout,
  parseCsv,
  parseFactoryState,
  parseIssueRead,
  parseIssuesRead,
  parseCommitDate,
  parseMilestone,
  parseOldestMerge,
  parseReleaseTag,
  parseTagCommit,
  parsePool,
  parseQueue,
  parseQueueOnce,
  parseSubIssues,
  parseUsage,
} from '../hooks/parse'
import { NEW_EVENTS_SQL, NEW_FLOORS_SQL } from '../hooks/v2/sources-facts'
import { FLAKES_SQL } from '../hooks/v2/sources-flakes'
import { parseCompareStatus } from '../hooks/v2/sources-waits'
import { buildState, subIssuesOf } from '../hooks/state'
import type { Observed } from '../hooks/state'
import type { LedgerEntry, Outcome, RunState } from '../hooks/types'
import { DEVICE, NOW, MIN, OTHER, PLUGIN_ROOT, config, control, entry, eventRow, eventsCsv, review, run, state, wakeAnswer } from './fixtures'
import { issuesRead } from './host'

const REPO = 'cbundy/dev-system'
const iso = (ms: number) => new Date(ms).toISOString()
// a real-shaped run id (a ULID) and commit SHA per number
const RUN = (n: number) => `01K7RRXQ7M2YB9ZB3J8N0V${String(n).padStart(4, '0')}`
const SHA = (n: number) => `${String(n).padStart(4, '0')}${'abc123'.repeat(6)}`
const pl = (s: RunState, branch: string, run: string, over: Partial<PipelineRun>): PipelineRun => ({
  state: s,
  branch,
  run,
  head: null,
  step: null,
  detail: null,
  pr: null,
  ...over,
})

function factoryJson(issues: Record<string, unknown>[], recent: Record<string, unknown>[] = []) {
  return JSON.stringify({ at: iso(NOW), at_source: '--at', repos: [{ repo: REPO, issues, recent }] })
}
const fsIssue = (n: number, stage: string, over: Record<string, unknown> = {}) => ({
  issue: n,
  stage,
  detail: null,
  entered_at: iso(NOW - 30 * MIN),
  minutes_in_stage: 30,
  holder: DEVICE,
  run: null,
  pr: null,
  stuck: null,
  source: 'event',
  github: null,
  flags: [],
  ...over,
})

function ev(over: Partial<FactoryEvent>): FactoryEvent {
  return { ts: NOW - 10 * MIN, state: 'parked', issue: 45, run: 'R45', branch: 'feat/issue-45-x', pr: null, head: 'h1', note: null, actor: 'watcher', device: DEVICE, ...over }
}

describe('parse', () => {
  test('factory-state: live and recent issues, stuck rule, GitHub when read', () => {
    const json = factoryJson(
      [
        fsIssue(45, 'parked', { run: 'R45', pr: 545, stuck: { rule: 'S3', text: 'parked for more than 30 minutes' } }),
        fsIssue(114, 'queued', { holder: null, github: { state: 'open', labels: ['enhancement', 'ready'], claim: null } }),
      ],
      [fsIssue(271, 'merged', { run: 'R271', pr: 282 })],
    )
    const f = parseFactoryState(json, REPO)
    expect(f?.at).toBe(NOW)
    expect(f?.issues.map(i => [i.number, i.stage, i.ended, i.stuck])).toEqual([
      [45, 'parked', false, 'S3'],
      [114, 'queued', false, null],
      [271, 'merged', true, null],
    ])
    expect(f?.issues[1]?.github).toEqual({ open: true, labels: ['enhancement', 'ready'] })
    // a claim the tool shows lapsed carries its lease end (v2's H1 reads it); any other detail none
    const lapsed = parseFactoryState(factoryJson([fsIssue(60, 'queued', { detail: `claim lapsed at ${iso(NOW - 5 * MIN)}` }), fsIssue(61, 'queued', { detail: 'ready' })]), REPO)
    expect(lapsed?.issues.map(i => [i.number, i.lapsedAt])).toEqual([
      [60, NOW - 5 * MIN],
      [61, null],
    ])
    expect(parseFactoryState(json, 'other/repo')).toBeNull()
    expect(parseFactoryState('not json', REPO)).toBeNull()
  })

  test('CSV: quoted commas, quotes and newlines survive', () => {
    const rows = parseCsv('ts,state,note\n2026-10-12T18:00:00.000Z,verdict,"CORRECT: a, b ""quoted""\nsecond line"\n2026-10-12T18:01:00.000Z,parked,\n')
    expect(rows).toEqual([
      { ts: '2026-10-12T18:00:00.000Z', state: 'verdict', note: 'CORRECT: a, b "quoted"\nsecond line' },
      { ts: '2026-10-12T18:01:00.000Z', state: 'parked', note: '' },
    ])
  })

  test('issue-read: state, labels, open blockers and sub-issues', () => {
    const json = JSON.stringify({
      issue: {
        number: 470,
        title: 'Escalate by opening an issue',
        state: 'open',
        labels: [{ name: 'enhancement' }, { name: 'ready' }],
        issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1, blocking: 0, total_blocking: 0 },
        sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
      },
      stripped: 0,
    })
    expect(parseIssueRead(json)).toEqual({ open: true, labels: ['enhancement', 'ready'], blockedBy: 1, blocking: 0, subIssues: 0, title: 'Escalate by opening an issue', blockingList: null, blockersClosedAt: null, parent: null, siblings: null })
    const two = JSON.stringify({ issue: { state: 'open', title: 't', issue_dependencies_summary: { blocked_by: 0, blocking: 2 } } })
    expect(parseIssueRead(two)?.blocking).toBe(2)
    expect(parseIssueRead(JSON.stringify({ issue: { state: 'open', title: 't', issue_dependencies_summary: { blocked_by: 0 } } }))?.blocking).toBeNull()
    expect(parseIssueRead('{}')).toBeNull()
  })

  test('parseIssuesRead maps each batched item as parseIssueRead maps the single read, and rejects a malformed shape (#922)', () => {
    const item = (n: number, state: string) => ({
      number: n,
      title: `T${n}`,
      state,
      labels: [{ name: 'ready' }],
      issue_dependencies_summary: { blocked_by: 1, blocking: 2, total_blocked_by: 1, total_blocking: 2 },
      sub_issues_summary: { total: 3, completed: 1 },
    })
    const read = parseIssuesRead(JSON.stringify({ issues: [item(45, 'open'), item(114, 'closed')], refused: [7], missing: [8], stripped: 1 }))
    expect(read?.refused).toEqual([7])
    expect(read?.missing).toEqual([8])
    for (const [n, state] of [[45, 'open'], [114, 'closed']] as const) {
      expect(read?.facts.get(n)).toEqual(parseIssueRead(JSON.stringify({ issue: item(n, state) })))
    }
    for (const bad of ['', '{}', '{"issues":[],"refused":"x","missing":[]}', '{"issues":[{"state":"open"}],"refused":[],"missing":[]}', '{"issues":[],"refused":[1.5],"missing":[]}']) {
      expect(parseIssuesRead(bad)).toBeNull()
    }
  })

  test('parseIssuesRead maps the blocking, blocked-by and parent lists, and gives null for an older reader and the single read', () => {
    const node = (number: number, state: string, repo = REPO) => ({ number, repo, state })
    const base = { number: 45, title: 'T', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 1, blocking: 1 }, sub_issues_summary: { total: 0 } }
    const closedA = Date.UTC(2026, 0, 2, 3, 4, 5)
    const closedB = Date.UTC(2026, 5, 1)
    const full = {
      ...base,
      blocking: [node(7, 'open'), node(8, 'closed'), node(9, 'open', 'other/repo')],
      blocked_by: [{ ...node(3, 'closed'), closed_at: iso(closedA) }, { ...node(4, 'closed', 'other/repo'), closed_at: iso(closedB) }, { ...node(5, 'open'), closed_at: null }],
      parent: { ...node(12, 'open'), sub_issues: [node(45, 'open'), node(46, 'open'), node(47, 'closed'), node(48, 'open', 'other/repo')] },
    }
    const read = parseIssuesRead(JSON.stringify({ issues: [full, { ...base, number: 50 }, { ...base, number: 51, blocked_by: [{ ...node(5, 'open'), closed_at: null }], parent: { ...node(13, 'open', 'other/repo'), sub_issues: [node(51, 'open', 'other/repo')] } }], refused: [], missing: [], stripped: 0 }), REPO)
    expect(read?.facts.get(45)).toMatchObject({
      blockingList: [7],
      blockersClosedAt: Math.max(closedA, closedB),
      parent: 12,
      siblings: [{ number: 46, open: true }, { number: 47, open: false }],
    })
    // an older reader: no fields at all
    expect(read?.facts.get(50)).toMatchObject({ blockingList: null, blockersClosedAt: null, parent: null, siblings: null })
    // no closed blocker listed, and a parent in another repo
    expect(read?.facts.get(51)).toMatchObject({ blockingList: null, blockersClosedAt: null, parent: null, siblings: null })
    // without the repo nothing can be said of this repo's issues
    expect(parseIssuesRead(JSON.stringify({ issues: [full], refused: [], missing: [] }))?.facts.get(45)).toMatchObject({ blockingList: null, parent: null, siblings: null })
    // the single read carries none of them
    expect(parseIssueRead(JSON.stringify({ issue: full }))).toMatchObject({ blockingList: null, parent: null, siblings: null })
  })

  test('the newest design brief comment, by its heading', () => {
    const json = JSON.stringify({
      issue: {},
      comments: [
        { body: '## Design brief (designer, 2026-10-11)\n...', created_at: iso(NOW - 60 * MIN), html_url: 'u1' },
        { body: 'claimed-by: x', created_at: iso(NOW - 50 * MIN), html_url: 'u2' },
        { body: '## Design brief (designer, 2026-10-12)\n...', created_at: iso(NOW - 10 * MIN), html_url: 'u3' },
      ],
      stripped: 0,
    })
    expect(parseBrief(json)).toEqual({ url: 'u3', at: NOW - 10 * MIN })
  })

  test('the main checkout: its branch or a detached head, its commit, changed tracked paths, the default branch (#544)', () => {
    const oid = '# branch.oid 5251b75ef45eef8d6c31556c1b5ac3d5dd34f3ff'
    const clean = `${oid}\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n`
    expect(parseCheckout('origin/main\n', clean)).toEqual({ branch: 'main', head: '5251b75ef45eef8d6c31556c1b5ac3d5dd34f3ff', defaultBranch: 'main', dirty: [] })
    // the testbed's adjudicator left it detached on another issue's branch
    expect(parseCheckout('origin/main\n', `${oid}\n# branch.head (detached)\n`)).toMatchObject({ branch: null, defaultBranch: 'main' })
    // modified, renamed (path, then its old name after a tab) and unmerged entries; untracked are allowed
    const changed = [
      `${oid}`,
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaaa aaaa plugins/factory-loop/hooks/plan.ts',
      '2 R. N... 100644 100644 100644 bbbb bbbb R100 docs/new name.md\tdocs/old.md',
      'u UU N... 100644 100644 100644 100644 cccc dddd eeee README.md',
      '? scratch.txt',
    ].join('\n')
    expect(parseCheckout('origin/main', changed)).toMatchObject({ dirty: ['plugins/factory-loop/hooks/plan.ts', 'docs/new name.md', 'README.md'] })
    // what does not read
    expect(parseCheckout('', clean)).toBeNull()
    expect(parseCheckout('origin/main', '')).toBeNull()
    expect(parseCheckout('origin/main', `${oid}\n# branch.head main\nfatal: bad\n`)).toBeNull()
  })

  test('the ready queue, ascending', () => {
    expect(parseQueue(JSON.stringify({ issues: [{ number: 470, title: 't' }, { number: 114, title: 't' }], stripped: 2 }))).toEqual([114, 470])
    expect(parseQueue('nope')).toBeNull()
  })

  test('usage-check.sh: both windows and the binding reset; unavailable', () => {
    const u = parseUsage(
      'five_hour=73 resets_at=2026-10-13T00:19:59Z resets_in=7000 seven_day=87 seven_day_resets_at=2026-10-16T10:59:59Z seven_day_resets_in=300000 source=oauth',
    )
    expect(u).toEqual({
      fiveHour: 73,
      sevenDay: 87,
      fiveHourResetsAt: Date.parse('2026-10-13T00:19:59Z'),
      sevenDayResetsAt: Date.parse('2026-10-16T10:59:59Z'),
      unavailable: false,
    })
    expect(parseUsage('usage=unavailable reason=oauth:no-token').unavailable).toBe(true)
  })

  test('treehouse: slots not yet made count as free; busy slots are seen', () => {
    const json = JSON.stringify([
      { name: '1', path: '/t/1', status: 'leased', branch: 'feat/issue-9-x', lease_id: 'l1', leased_at: '2026-10-14T08:00:00Z', processes: [{ pid: 1, name: 'node' }] },
      { name: '2', path: '/t/2', status: 'available', branch: '', detached: true },
    ])
    expect(parsePool(json, 16)).toEqual({
      free: 15,
      total: 16,
      slots: [
        { path: '/t/1', branch: 'feat/issue-9-x', state: 'leased', dirty: null, busy: true, lease: 'l1', leasedAt: Date.parse('2026-10-14T08:00:00Z'), leaseBranch: 'feat/issue-9-x' },
        { path: '/t/2', branch: null, state: 'available', dirty: null, busy: false, lease: null, leasedAt: null, leaseBranch: null },
      ],
    })
  })

  test('a tracker timeline: its open sub-issues on this repo, ascending, replayed in order (D-35)', () => {
    // the shape of `callum-flow-issue-read --json --timeline 472` on 2026-10-13, trimmed
    const added = (n: number, at: string, st = 'open', repo = REPO) => ({
      event: 'sub_issue_added',
      created_at: at,
      actor: { login: 'cbundy', id: 1 },
      sub_issue: { number: n, state: st, repository: { full_name: repo } },
    })
    const json = JSON.stringify({
      events: [
        added(477, '2026-10-12T06:05:30Z'),
        added(473, '2026-10-12T06:05:24Z', 'closed'),
        added(475, '2026-10-12T06:05:27Z'),
        { event: 'labeled', created_at: '2026-10-12T06:06:00Z', label: { name: 'enhancement' } },
        added(476, '2026-10-12T06:05:29Z'),
        { event: 'sub_issue_removed', created_at: '2026-10-12T07:00:00Z', sub_issue: { number: 476, state: 'open' } },
        added(9, '2026-10-12T06:05:31Z', 'open', 'cbundy/other'),
      ],
      stripped: 0,
    })
    expect(parseSubIssues(json, REPO)).toEqual([475, 477])
    expect(parseSubIssues(JSON.stringify({ events: [], stripped: 0 }), REPO)).toEqual([])
    expect(parseSubIssues('{"issue": {}}', REPO)).toBeNull()
    expect(parseSubIssues('nope', REPO)).toBeNull()
  })

  test('milestone: counts and Expected; nothing printed means not opted in', () => {
    expect(parseMilestone('== Next release\nExpected: minor - new modes\n#506 closed issue x\n#507 open issue y\n#512 closed pr z\n#513 open pr w\n')).toEqual({
      open: 2,
      closed: 2,
      openIssues: [507],
      expected: 'minor',
    })
    expect(parseMilestone('== Next release\nExpected: (not set)\n')).toEqual({ open: 0, closed: 0, openIssues: [], expected: null })
    expect(parseMilestone('')).toBeNull()
  })

  test('release reads: the tag, the tag commit date, the oldest merge since it', () => {
    expect(parseReleaseTag('{"tagName":"v1.2.3"}\n')).toBe('v1.2.3')
    for (const bad of ['', 'nope', '{}', '{"tagName":""}', '{"tagName":5}']) expect(parseReleaseTag(bad)).toBeNull()
    expect(parseCommitDate('2026-10-12T08:30:00Z\n')).toBe(Date.UTC(2026, 9, 12, 8, 30))
    for (const bad of ['', 'nope', 'null']) expect(parseCommitDate(bad)).toBeNull()
    const list = '[{"mergedAt":"2026-10-12T10:00:00Z"},{"mergedAt":"2026-10-12T08:45:00Z"}]'
    expect(parseOldestMerge(list)).toBe(Date.UTC(2026, 9, 12, 8, 45))
    expect(parseOldestMerge('[]')).toBeNull()
    for (const bad of ['', 'nope', '{}', '[{"mergedAt":null}]', '[{}]']) expect(parseOldestMerge(bad)).toBeUndefined()
  })

  test('the release bump PR (the tag commit) is not an unreleased merge', () => {
    const sha = '892e4f6e0000000000000000000000000000abcd'
    expect(parseTagCommit(`${sha}\n2026-10-17T03:26:31Z\n`)).toEqual({ sha, at: Date.UTC(2026, 9, 17, 3, 26, 31) })
    for (const bad of ['', 'nope', `${sha}\n`, `${sha}\nnope`, `${sha}\n2026-10-17T03:26:31Z\nx`]) expect(parseTagCommit(bad)).toBeNull()
    const list = JSON.stringify([
      { mergedAt: '2026-10-17T03:26:32Z', mergeCommit: { oid: sha } },
      { mergedAt: '2026-10-17T03:31:56Z', mergeCommit: { oid: 'bbbb' } },
    ])
    expect(parseOldestMerge(list, sha)).toBe(Date.UTC(2026, 9, 17, 3, 31, 56))
    expect(parseOldestMerge(list)).toBe(Date.UTC(2026, 9, 17, 3, 26, 32))
    expect(parseOldestMerge(JSON.stringify([{ mergedAt: '2026-10-17T03:26:32Z', mergeCommit: { oid: sha } }]), sha)).toBeNull()
  })

  test('parseCompareStatus: behind and identical hold, ahead and diverged do not, anything else says nothing', () => {
    expect(parseCompareStatus('behind\n')).toBe(true)
    expect(parseCompareStatus('identical')).toBe(true)
    expect(parseCompareStatus('ahead\n')).toBe(false)
    expect(parseCompareStatus(' diverged ')).toBe(false)
    for (const other of ['', '\n', 'Behind', 'behind ahead', '{"status":"behind"}', 'null']) expect({ other, got: parseCompareStatus(other) }).toEqual({ other, got: null })
  })

  describe('readMilestone: the milestone and release reads', () => {
    const SHA_T = '892e4f6e0000000000000000000000000000abcd'
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
    const fail = (stderr = 'boom') => ({ exitCode: 1, stdout: '', stderr })
    const QUAL = '== Next release\nExpected: minor - x\n#1 closed issue a\n'
    const OPEN = '== Next release\nExpected: minor - x\n#1 closed issue a\n#2 open issue b\n'
    type Reply = { exitCode: number; stdout: string; stderr: string }
    const setup = (replies: Record<string, Reply | (() => Reply)>) => {
      const calls: string[][] = []
      const run = async (argv: string[]) => {
        calls.push(argv)
        const key = argv[0] === 'callum-flow-milestone' ? 'ms' : argv[1] === 'release' ? 'view' : argv[1] === 'api' ? 'api' : 'list'
        const r = replies[key]
        return typeof r === 'function' ? r() : r ?? fail()
      }
      return { calls, run }
    }
    const o = (run: ReturnType<typeof setup>['run'], now: number, every = 1000) => ({ now, every, repo: REPO, base: 'main', run })
    const listOf = JSON.stringify([
      { mergedAt: '2026-10-17T03:26:32Z', mergeCommit: { oid: SHA_T } },
      { mergedAt: '2026-10-17T03:31:56Z', mergeCommit: { oid: 'bbbb' } },
    ])
    const all = { ms: ok(QUAL), view: ok('{"tagName":"v0.48.0"}'), api: ok(`${SHA_T}\n2026-10-17T03:26:31Z\n`), list: ok(listOf) }

    test('reads the tag and the oldest merge since it, leaving out the release PR', async () => {
      const cache: MilestoneCache = {}
      const { calls, run } = setup(all)
      await readMilestone(cache, o(run, 5000))
      expect(cache.release).toEqual({ at: 5000, value: { tag: 'v0.48.0', oldest: Date.UTC(2026, 9, 17, 3, 31, 56) } })
      expect(calls.find((c) => c[1] === 'pr')?.join(' ')).toContain('merged:>=2026-10-17T03:26:31.000Z')
    })

    test('no release yet: tag null and oldest unknown, without a list read', async () => {
      const cache: MilestoneCache = {}
      const { calls, run } = setup({ ...all, view: fail('release not found') })
      await readMilestone(cache, o(run, 5000))
      expect(cache.release?.value).toEqual({ tag: null, oldest: null })
      expect(calls.some((c) => c[1] === 'pr')).toBe(false)
    })

    test('a failed or malformed read keeps the last reading', async () => {
      const prior = { at: 1, value: { tag: 'v0.47.0', oldest: 7 } }
      for (const bad of [
        { view: fail() },
        { view: ok('nope') },
        { api: fail() },
        { api: ok('nope') },
        { list: fail() },
        { list: ok('nope') },
      ]) {
        const cache: MilestoneCache = { release: prior }
        await readMilestone(cache, o(setup({ ...all, ...bad }).run, 5000))
        expect(cache.release).toBe(prior)
      }
      const thrown: MilestoneCache = { release: prior }
      await readMilestone(thrown, o(async () => { throw new Error('x') }, 5000))
      expect(thrown.release).toBe(prior)
    })

    test('no release read while the milestone does not qualify; none opted in leaves no milestone', async () => {
      for (const ms of [ok(OPEN), ok('== Next release\nExpected: (not set)\n'), ok('')]) {
        const cache: MilestoneCache = {}
        const { calls, run } = setup({ ...all, ms })
        await readMilestone(cache, o(run, 5000))
        expect(cache.release).toBeUndefined()
        // no full release read (the tag commit and the merges since it); a milestone still gets its tag view and closed list
        expect(calls.some((c) => c[1] === 'api' || c[1] === 'pr')).toBe(false)
      }
      const unopted = setup({ ...all, ms: ok('') })
      await readMilestone({}, o(unopted.run, 5000))
      expect(unopted.calls.map((c) => c[0])).toEqual(['callum-flow-milestone'])
      const cache: MilestoneCache = {}
      await readMilestone(cache, o(setup({ ...all, ms: fail() }).run, 5000))
      expect(cache.milestone).toBeUndefined()
    })

    describe('the tag view, wanted by a record that waits on a tag-contains condition', () => {
      const wanted = (run: ReturnType<typeof setup>['run'], now: number) => ({ ...o(run, now), tagWanted: true })

      test('with open items only gh release view runs, and cache.tag fills; with it unwanted nothing runs', async () => {
        const cache: MilestoneCache = {}
        const { calls, run } = setup({ ...all, ms: ok(OPEN) })
        await readMilestone(cache, wanted(run, 5000))
        expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['callum-flow-milestone show next', 'gh issue list', 'gh release view'])
        expect(cache.tag).toEqual({ at: 5000, value: 'v0.48.0' })
        expect(cache.release).toBeUndefined()
        const none: MilestoneCache = {}
        const quiet = setup({ ...all, ms: ok('') })
        await readMilestone(none, o(quiet.run, 5000))
        expect(quiet.calls.map((c) => c[0])).toEqual(['callum-flow-milestone'])
        expect(none.tag).toBeUndefined()
      })

      test('no release yet reads as no tag; a failed or malformed view keeps the last reading; it is read on the cadence only', async () => {
        const cache: MilestoneCache = {}
        await readMilestone(cache, wanted(setup({ ...all, ms: ok(OPEN), view: fail('release not found') }).run, 5000))
        expect(cache.tag).toEqual({ at: 5000, value: null })
        const prior = { at: 1, value: 'v0.47.0' }
        for (const view of [fail(), ok('nope')]) {
          const kept: MilestoneCache = { tag: prior }
          await readMilestone(kept, wanted(setup({ ...all, ms: ok(OPEN), view }).run, 5000))
          expect(kept.tag).toBe(prior)
        }
        const thrown: MilestoneCache = { tag: prior }
        await readMilestone(thrown, wanted(async () => { throw new Error('x') }, 5000))
        expect(thrown.tag).toBe(prior)
        const again: MilestoneCache = {}
        const { calls, run } = setup({ ...all, ms: ok(OPEN) })
        await readMilestone(again, wanted(run, 5000))
        const n = calls.length
        await readMilestone(again, wanted(run, 5500))
        expect(calls.length).toBe(n)
        await readMilestone(again, wanted(run, 6000))
        expect(calls.filter((c) => c[1] === 'release')).toHaveLength(2)
      })

      test('a qualifying milestone keeps the full release read and refreshes the tag with it, with no second view', async () => {
        const cache: MilestoneCache = {}
        const { calls, run } = setup(all)
        await readMilestone(cache, wanted(run, 5000))
        expect(cache.release?.value.tag).toBe('v0.48.0')
        expect(cache.tag).toEqual({ at: 5000, value: 'v0.48.0' })
        expect(calls.filter((c) => c[1] === 'release')).toHaveLength(1)
      })

      test('another repo\'s tag: read per repo on the cadence while a record names it, dropped when none does; the loop\'s own tag is not read for it', async () => {
        const cache: MilestoneCache = {}
        const calls: string[][] = []
        const run = async (argv: string[]) => {
          calls.push(argv)
          // no milestone, so the loop's own tag is read for no one
          if (argv[0] === 'callum-flow-milestone') return ok('')
          const repo = argv[argv.indexOf('--repo') + 1]
          return repo === 'o/none' ? fail('release not found') : repo === 'o/down' ? fail() : ok(`{"tagName":"tag-of-${repo}"}`)
        }
        const at = (now: number, repos: string[]) => readMilestone(cache, { ...o(run, now), tagRepos: repos })
        await at(5000, ['o/n', 'o/none'])
        expect(calls.filter(c => c[1] === 'release').map(c => c[c.indexOf('--repo') + 1])).toEqual(['o/n', 'o/none'])
        expect(repoTags(cache)).toEqual({ 'o/n': 'tag-of-o/n', 'o/none': null })
        expect(cache.tag).toBeUndefined()
        // inside the cadence nothing is read again; after it, each is
        calls.length = 0
        await at(5500, ['o/n', 'o/none'])
        expect(calls.filter(c => c[1] === 'release')).toHaveLength(0)
        await at(6000, ['o/n', 'o/none', 'o/down'])
        expect(calls.filter(c => c[1] === 'release')).toHaveLength(3)
        // a failed read keeps the last value (here none yet), and a repo no record names is dropped
        expect(repoTags(cache)).toEqual({ 'o/n': 'tag-of-o/n', 'o/none': null })
        await at(6100, ['o/n'])
        expect(repoTags(cache)).toEqual({ 'o/n': 'tag-of-o/n' })
        const kept: MilestoneCache = { tags: { 'o/down': { at: 1, value: 'v9' } } }
        await readMilestone(kept, { ...o(run, 5000), tagRepos: ['o/down'] })
        expect(repoTags(kept)).toEqual({ 'o/down': 'v9' })
      })

      test('tagRepos lists the distinct other repos of waiting records; waitsOnTag ignores a condition that names a repo', () => {
        const foreign = { kind: 'tag-contains', sha: '35bb655', repo: 'o/n' }
        const records = [{ state: 'waiting', wait: [foreign, { kind: 'issue-closed', repo: 'x/y' }] }, { state: 'waiting', wait: [foreign, { ...foreign, repo: 'a/b' }] }, { state: 'designing', wait: [{ ...foreign, repo: 'z/z' }] }]
        expect(tagRepos(records)).toEqual(['a/b', 'o/n'])
        expect(waitsOnTag(records)).toBe(false)
        expect(waitsOnTag([...records, { state: 'waiting', wait: [{ kind: 'tag-contains', sha: '35bb655' }] }])).toBe(true)
      })

      test('newestTag: the newer of the release read and the tag view; waitsOnTag: waiting records with a tag-contains condition', () => {
        expect(newestTag({})).toBeNull()
        expect(newestTag({ tag: { at: 1, value: 'v1' } })).toBe('v1')
        expect(newestTag({ release: { at: 5, value: { tag: 'v2', oldest: null } }, tag: { at: 1, value: 'v1' } })).toBe('v2')
        expect(newestTag({ release: { at: 1, value: { tag: 'v2', oldest: null } }, tag: { at: 5, value: 'v3' } })).toBe('v3')
        expect(newestTag({ release: { at: 1, value: { tag: null, oldest: null } } })).toBeNull()
        const tag = { kind: 'tag-contains', sha: '35bb655' }
        expect(waitsOnTag([{ state: 'waiting', wait: [{ kind: 'issue-closed' }, tag] }])).toBe(true)
        expect(waitsOnTag([{ state: 'designing', wait: [tag] }, { state: 'waiting', wait: [{ kind: 'pr-merged' }] }, { state: 'waiting', wait: null }])).toBe(false)
      })
    })

    test('the cadence: reads again only once every has passed', async () => {
      const cache: MilestoneCache = {}
      const { calls, run } = setup(all)
      await readMilestone(cache, o(run, 5000))
      const n = calls.length
      await readMilestone(cache, o(run, 5500))
      expect(calls.length).toBe(n)
      await readMilestone(cache, o(run, 6000))
      expect(calls.length).toBe(n * 2)
      expect(cache.release?.at).toBe(6000)
    })

    describe('the release log\'s reads: the tag view and the oldest closed issue, whenever the milestone exists', () => {
      const closedOf = (...at: string[]) => ok(JSON.stringify(at.map((closedAt) => ({ closedAt }))))
      const withClosed = { ...all, ms: ok(OPEN), list: closedOf('2026-10-18T10:00:00Z', '2026-10-16T08:30:00Z', '2026-10-17T00:00:00Z') }

      test('the tag view runs with a milestone and no tag wait, and not without a milestone', async () => {
        const cache: MilestoneCache = {}
        await readMilestone(cache, o(setup(withClosed).run, 5000))
        expect(cache.tag).toEqual({ at: 5000, value: 'v0.48.0' })
        const none: MilestoneCache = {}
        await readMilestone(none, o(setup({ ...withClosed, ms: ok('') }).run, 5000))
        expect(none.tag).toBeUndefined()
        expect(none.closed).toBeUndefined()
      })

      test('the oldest closedAt of the milestone\'s closed issues; none, a full list and a failed read cache null', async () => {
        const argv = setup(withClosed)
        const cache: MilestoneCache = {}
        await readMilestone(cache, o(argv.run, 5000))
        expect(cache.closed).toEqual({ at: 5000, value: '2026-10-16T08:30:00.000Z' })
        expect(argv.calls.find((c) => c[1] === 'issue')).toEqual(['gh', 'issue', 'list', '--repo', REPO, '--milestone', 'Next release', '--state', 'closed', '--json', 'closedAt', '--limit', '200'])
        const full = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ closedAt: `2026-10-17T04:${String(i % 60).padStart(2, '0')}:00Z` })))
        for (const list of [ok('[]'), ok(full), fail(), ok('nope')]) {
          const c: MilestoneCache = { closed: { at: 1, value: '2026-01-01T00:00:00.000Z' } }
          await readMilestone(c, o(setup({ ...withClosed, list }).run, 5000))
          expect(c.closed).toEqual({ at: 5000, value: null })
        }
      })

      test('neither GitHub read runs with backoff, and the last readings stay', async () => {
        const cache: MilestoneCache = { tag: { at: 1, value: 'v0.47.0' }, closed: { at: 1, value: '2026-01-01T00:00:00.000Z' } }
        const { calls, run } = setup(withClosed)
        await readMilestone(cache, { ...o(run, 5000), backoff: true })
        expect(calls.map((c) => c[0])).toEqual(['callum-flow-milestone'])
        expect(cache.tag?.value).toBe('v0.47.0')
        expect(cache.closed?.value).toBe('2026-01-01T00:00:00.000Z')
      })

      test('the cadence holds both reads between passes', async () => {
        const cache: MilestoneCache = {}
        const { calls, run } = setup(withClosed)
        await readMilestone(cache, o(run, 5000))
        const n = calls.length
        await readMilestone(cache, o(run, 5500))
        expect(calls.length).toBe(n)
        await readMilestone(cache, o(run, 6000))
        expect(calls.filter((c) => c[1] === 'issue')).toHaveLength(2)
        expect(calls.filter((c) => c[1] === 'release')).toHaveLength(2)
      })
    })

    test('a full list is no reading of the oldest', async () => {
      const full = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ mergedAt: `2026-10-17T04:${String(i % 60).padStart(2, '0')}:00Z`, mergeCommit: { oid: `c${i}` } })))
      const cache: MilestoneCache = {}
      await readMilestone(cache, o(setup({ ...all, list: ok(full) }).run, 5000))
      expect(cache.release?.value).toEqual({ tag: 'v0.48.0', oldest: null })
    })
  })

  test('queue-watch.sh --once: its one line, ascending; anything else is no reading', () => {
    expect(parseQueueOnce('queue known=none now=114,470\n')).toEqual({ known: [], now: [114, 470] })
    expect(parseQueueOnce('queue known=470,114 now=none')).toEqual({ known: [114, 470], now: [] })
    expect(parseQueueOnce('queue known=7 now=9,7,9')).toEqual({ known: [7], now: [7, 9] })
    for (const bad of [
      '',
      'queue known= now=1',
      'queue known=none',
      'queue now=1 known=2',
      'queue known=none now=1,x',
      'queue known=none now=0',
      'queue known=none now=1 extra=2',
      'queue known=none now=1\nqueue known=1 now=1',
      'watcher-error cannot read the queue',
    ]) {
      expect([bad, parseQueueOnce(bad)]).toEqual([bad, null])
    }
  })

})

describe('derive', () => {
  test('rows become events; facts collect briefs, review rounds, verdicts, superseded runs', () => {
    const events = eventsFromRows(
      parseCsv(
        [
          'ts,state,issue,run_id,branch,pr,head,note,actor,device',
          `${iso(NOW - 40 * MIN)},delegated,45,,,,,brief https://github.com/cbundy/dev-system/issues/45#issuecomment-99,agent,${DEVICE}`,
          `${iso(NOW - 20 * MIN)},verdict,45,R45,feat/issue-45-x,,,CORRECT: review-1 x,agent,${DEVICE}`,
          `${iso(NOW - 19 * MIN)},fix_requested,45,R45,feat/issue-45-x,,,review,agent,${DEVICE}`,
          `${iso(NOW - 5 * MIN)},superseded,45,R44,,,,by -v2,agent,${DEVICE}`,
          `${iso(NOW - 50 * MIN)},reclaimed,46,,,,,lease expired,sweep,${DEVICE}`,
          `${iso(NOW - 4 * MIN)},reclaimed,46,,,,,lease expired,sweep,${DEVICE}`,
        ].join('\n'),
      ),
    )
    const facts = factsOf(events)
    // the newest `reclaimed` per issue: v2's H1 reads a lapse from it
    expect([...facts.reclaimed]).toEqual([[46, NOW - 4 * MIN]])
    expect(facts.briefs.get(45)).toBe('https://github.com/cbundy/dev-system/issues/45#issuecomment-99')
    expect(facts.reviewFixes.get('R45')).toBe(1)
    expect(facts.verdicts.get('R45')).toEqual(['CORRECT: review-1 x'])
    expect([...facts.superseded]).toEqual(['R44'])
  })

  test('runs: the mirror decides parked or running; the watcher refines the rest', () => {
    const facts = factsOf([
      ev({ state: 'parked', ts: NOW - 30 * MIN }),
      ev({ state: 'merge_ready', ts: NOW - 20 * MIN, head: 'h2' }),
      ev({ issue: 46, run: 'R46', branch: 'feat/issue-46-x', state: 'merge_ready', ts: NOW - 40 * MIN }),
      ev({ issue: 46, run: 'R46', branch: 'feat/issue-46-x', state: 'parked', ts: NOW - 30 * MIN }),
      ev({ issue: 46, run: 'R46', branch: 'feat/issue-46-x', state: 'verdict', note: 'NIT: x', actor: 'agent', ts: NOW - 29 * MIN }),
      ev({ issue: 47, run: 'R47', branch: 'feat/issue-47-x', state: 'failed', note: 'cancelled' }),
      ev({ issue: 48, run: 'R48', branch: 'feat/issue-48-x', state: 'merge_ready' }),
    ])
    const factory = parseFactoryState(
      factoryJson([
        fsIssue(45, 'in pipeline', { run: 'R45', pr: 545 }),
        fsIssue(46, 'in pipeline', { run: 'R46' }),
        fsIssue(47, 'implementing', { run: 'R47' }),
        fsIssue(48, 'ready to merge', { run: 'R48', pr: 548 }),
      ]),
      REPO,
    )!
    const runs = runsFromEvents(factory, facts)
    expect(runs.map(r => [r.issue, r.state, r.head])).toEqual([
      [45, 'merge-ready', 'h2'],
      [46, 'running', 'h1'],
      [47, 'cancelled', 'h1'],
      [48, 'merge-ready', 'h1'],
    ])
  })

  test('a park the mirror shows as running is still waiting until the log shows it answered', () => {
    const park = ev({ state: 'parked', ts: NOW - 6 * MIN })
    const factory = parseFactoryState(factoryJson([fsIssue(45, 'in pipeline', { run: 'R45' })]), REPO)!
    expect(runsFromEvents(factory, factsOf([park]))[0]?.state).toBe('parked')
    const answered = [park, ev({ state: 'verdict', note: 'NIT: x', actor: 'agent', ts: NOW - 5 * MIN })]
    expect(runsFromEvents(factory, factsOf(answered))[0]?.state).toBe('running')
  })

  test('a run the watcher saw that the mirror has not synced yet is the current run', () => {
    const facts = factsOf([
      ev({ state: 'failed', run: 'R45A', note: 'cancelled', ts: NOW - 20 * MIN }),
      ev({ state: 'parked', run: 'R45B', branch: 'feat/issue-45-x-2', ts: NOW - 2 * MIN, head: 'h9' }),
    ])
    const factory = parseFactoryState(factoryJson([fsIssue(45, 'implementing', { run: 'R45A' })]), REPO)!
    expect(runsFromEvents(factory, facts).map(r => [r.run, r.branch, r.state, r.head])).toEqual([['R45B', 'feat/issue-45-x-2', 'parked', 'h9']])
  })

  test('the ledger a device proves: its claims, heartbeats, sweeps and the rollouts of its merges', () => {
    const events: FactoryEvent[] = [
      ev({ state: 'renewed', issue: 9, run: null, branch: null, actor: 'agent', ts: NOW - 8 * MIN }),
      ev({ state: 'closed', issue: 3, run: null, branch: null, actor: 'sweep', ts: NOW - 12 * MIN }),
      ev({ state: 'claimed', issue: 60, run: null, branch: null, actor: 'agent', ts: NOW - 30 * MIN }),
      ev({ state: 'parked', ts: NOW - 25 * MIN }),
      ev({ state: 'verdict', note: 'CORRECT: x', actor: 'agent', ts: NOW - 24 * MIN }),
      ev({ state: 'fix_requested', note: 'review', actor: 'agent', ts: NOW - 24 * MIN }),
      ev({ state: 'merged', issue: 50, run: 'R50', branch: 'feat/issue-50-x', pr: 550, head: 'm1', actor: 'agent', ts: NOW - 2 * MIN }),
      // the owner merged #51 by hand and the device noted it, with no PR
      ev({ state: 'merged', issue: 51, run: null, branch: null, head: null, note: 'PR 484 merged by owner', actor: 'agent', ts: NOW - MIN }),
    ]
    const keys = deriveLedger(events, DEVICE).map(e => [e.key, e.status])
    expect(keys).toEqual([
      [`claim:60:derived:${NOW - 30 * MIN}`, 'done'],
      ['sweep:derived', 'done'],
      ['heartbeat:derived', 'done'],
      // the merging device ran its follow-ups, so a rebuilt merge is never read again (M7)
      ['rollout:50', 'done'],
      ['rollout:51', 'done'],
    ])
  })
})

describe('state', () => {
  test('a parked run the mirror shows is carried into the state with its run id, whoever answered it', () => {
    const events: FactoryEvent[] = [
      ev({ state: 'renewed', issue: 45, run: null, branch: null, actor: 'agent', ts: NOW - 2 * MIN }),
      ev({ state: 'parked', ts: NOW - 6 * MIN }),
      ev({ state: 'verdict', note: 'NIT: fine', actor: 'agent', ts: NOW - 5 * MIN }),
    ]
    const factory = parseFactoryState(factoryJson([fsIssue(45, 'parked', { run: 'R45', pr: 545 })]), REPO)!
    const facts = factsOf(events)
    const base = state()
    const s = buildState({
      now: NOW,
      repo: REPO,
      device: DEVICE,
      loadedAt: NOW - 60 * MIN,
      sources: base.sources,
      factory,
      facts,
      runs: null,
      queue: [],
      github: new Map(),
      timelines: new Map(),
      usage: base.usage,
      pool: base.pool,
      agents: [],
      milestone: null,
      ledger: deriveLedger(events, DEVICE),
      control: control(),
      lastTitle: null,
      lastTitleAt: null,
      githubBackoffUntil: null,
      trackerTitle: config().trackerTitle,
    })
    expect(s.runs.map(r => [r.issue, r.state, r.run])).toEqual([[45, 'parked', 'R45']])
  })
})

describe('config (v2 SPEC 13.4.2)', () => {
  test('durations: ms, s, m, h and d; anything else is not one', () => {
    expect([parseDuration('500ms'), parseDuration('60s'), parseDuration('5m'), parseDuration('2h'), parseDuration('1d'), parseDuration('1.5h')]).toEqual([
      500, 60_000, 300_000, 7_200_000, 86_400_000, 5_400_000,
    ])
    expect([parseDuration('5'), parseDuration('5x'), parseDuration('m5'), parseDuration('')]).toEqual([null, null, null, null])
  })

  test('titleEvery takes a duration and defaults to five minutes', () => {
    expect(loadConfig({ titleEvery: '5m' }).config.titleEveryMs).toBe(300_000)
    expect(loadConfig({}).config.titleEveryMs).toBe(300_000)
  })

  test('reportEvery takes a duration and defaults to ten minutes', () => {
    expect(loadConfig({ reportEvery: '10m' }).config.reportEveryMs).toBe(600_000)
    expect(loadConfig({ reportEvery: '2m' }).config.reportEveryMs).toBe(120_000)
    expect(loadConfig({}).config.reportEveryMs).toBe(600_000)
  })

  test('a time setting takes a duration under its short key, or milliseconds under either key', () => {
    const { config: c, problems } = loadConfig({ passEvery: '90s', queueEveryMs: 60_000, githubEvery: 120_000, heartbeatEvery: '30m' })
    expect([c.passEveryMs, c.queueEveryMs, c.githubEveryMs, c.heartbeatEveryMs]).toEqual([90_000, 60_000, 120_000, 1_800_000])
    expect(problems).toEqual([])
    // the maps likewise, entry by entry, over the defaults
    const maps = loadConfig({ agentTimeout: { designer: '90m' }, wakeTimeoutMs: { task: 3_600_000 } }).config
    expect(maps.agentTimeoutMs).toEqual({ ...DEFAULT_CONFIG.agentTimeoutMs, designer: 5_400_000 })
    expect(maps.wakeTimeoutMs).toEqual({ judge: 1_800_000, task: 3_600_000, tell: 1_800_000 })
  })

  test('unknown keys and bad values are left out and named, the rest still applies', () => {
    const { config: c, problems } = loadConfig({
      readyLabel: 'Go',
      passEveryMs: '60s',
      sweepEvery: 'soon',
      maxInFlightIssues: 4,
      rateCaps: { start: 10, merge: 5 },
      maxAttempts: { claim: 5, 'restart-self': 0, bogus: 1 },
      skipLabels: ['parked'],
      trackerTitle: '(',
      colour: 'blue',
    })
    expect(c.readyLabel).toBe('Go')
    expect(c.maxInFlightIssues).toBe(4)
    expect(c.rateCaps).toEqual({ start: 10, spawn: 120, wake: 20, perIssueKind: 6 })
    expect(c.maxAttempts.claim).toBe(5)
    expect(c.maxAttempts['restart-self']).toBe(1)
    expect(c.skipLabels).toEqual(['parked'])
    expect([c.passEveryMs, c.sweepEveryMs, c.trackerTitle]).toEqual([DEFAULT_CONFIG.passEveryMs, DEFAULT_CONFIG.sweepEveryMs, DEFAULT_CONFIG.trackerTitle])
    expect(problems).toEqual([
      'passEveryMs: "60s" is not a number of milliseconds',
      'sweepEvery: "soon" is not a duration (like 60s, 5m, 2h)',
      'rateCaps.merge: unknown (merges are never capped)',
      'maxAttempts.restart-self: 0 is not a whole number of at least 1',
      'maxAttempts.bogus: unknown',
      'trackerTitle: "(" is not a regular expression',
      'colour: unknown setting',
    ])
    // the defaults themselves are untouched, and later layers win
    expect(DEFAULT_CONFIG.rateCaps.start).toBe(30)
    expect(loadConfig({ slowGap: '5m' }, { slowGapMs: 60_000 }).config.slowGapMs).toBe(60_000)
    expect(loadConfig(null, 'x').problems).toEqual(['settings: not a JSON object'])
  })

  test('answerChannel: script by default (the workaround, #561); script, tool or text in either file, the later layer winning; a bad value is named and left out', () => {
    expect(DEFAULT_CONFIG.answerChannel).toBe('script')
    for (const channel of ['script', 'tool', 'text'] as const) expect(loadConfig({ answerChannel: channel })).toMatchObject({ config: { ...DEFAULT_CONFIG, maxInFlightIssues: 3, answerChannel: channel }, problems: [] })
    expect(loadConfig({ answerChannel: 'tool' }, { answerChannel: 'text' }).config.answerChannel).toBe('text')
    expect(loadConfig({ answerChannel: 'tools' })).toMatchObject({ config: { answerChannel: 'script' }, problems: ['answerChannel: "tools" is not script, tool or text'] })
    expect(loadConfig({ answerChannel: true }).problems).toEqual(['answerChannel: true is not script, tool or text'])
  })

  test("answerTools, #560's switch, is replaced by answerChannel: named as replaced, and read as nothing (#561)", () => {
    for (const value of [true, false, 'on']) {
      expect(loadConfig({ answerTools: value })).toMatchObject({ config: { ...DEFAULT_CONFIG, maxInFlightIssues: 3 }, problems: ['answerTools: replaced by answerChannel (script, tool or text), and ignored'] })
    }
    expect('answerTools' in DEFAULT_CONFIG).toBe(false)
  })

  test('the defaults the owner set on 2026-10-13', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      inDevLabel: 'in development',
      maxInFlightIssues: 3,
      rateCaps: { start: 30, spawn: 120, wake: 20, perIssueKind: 6 },
      passEveryMs: 60_000,
      queueEveryMs: 120_000,
      githubEveryMs: 300_000,
      usageEveryMs: 300_000,
      milestoneEveryMs: 600_000,
      usageStaleMs: 900_000,
      wakeTimeoutMs: { judge: 1_800_000, task: 21_600_000, tell: 1_800_000 },
      allowActOutsideOrchestrator: false,
    })
  })
})

describe('control (v2 SPEC 13.4.3)', () => {
  test('control.json is read field by field: a bad field or item never voids the others', () => {
    expect(controlFrom(null)).toEqual(EMPTY_CONTROL)
    expect(
      controlFrom({
        paused: [7, 'x', -1, 2.5],
        noNewWork: 'yes',
        only: [522],
        serial: true,
        usageOverride: { untilPct: 98 },
        updateDue: { at: NOW },
        resumed: [{ subject: 'run:R1', at: NOW }, { subject: 5, at: NOW }, 'junk'],
        dropped: [{ issue: 9, at: NOW }, { issue: 'nine', at: NOW }],
        notes: [{ text: 'all issues', at: NOW }, { issue: 4, text: 'keep it small', at: NOW }, { issue: 4, at: NOW }],
      }),
    ).toEqual({
      ...EMPTY_CONTROL,
      paused: [7],
      only: [522],
      serial: true,
      updateDue: { reason: '', at: NOW },
      resumed: [{ subject: 'run:R1', at: NOW }],
      dropped: [{ issue: 9, at: NOW }],
      notes: [
        { issue: null, text: 'all issues', at: NOW },
        { issue: 4, text: 'keep it small', at: NOW },
      ],
    })
    expect(controlFrom({ updateDue: { reason: 'image 1.2.3', at: NOW } }).updateDue).toEqual({ reason: 'image 1.2.3', at: NOW })
  })
})

describe('the loop event (v2 SPEC 13.7.4, 13.7.5, D-09)', () => {
  // the event callum-flow-event would log for an entry: its columns and the note
  const logged = (e: LedgerEntry, ts = NOW): FactoryEvent => ({
    ts,
    state: 'loop',
    issue: e.issue,
    run: e.run,
    branch: null,
    pr: e.pr,
    head: e.head,
    note: loopNote(e),
    actor: 'agent',
    device: DEVICE,
  })
  const base = { issue: 50, pr: 550, head: 'head50', run: '01M4RQ0050AAAA' }
  // every outcome kind the rules read, with free text already empty so the round trip is exact
  const outcomes: [string, LedgerEntry][] = [
    ['cli', entry('release-parent:60', 'release-parent', { outcome: { kind: 'cli', exit: 1 } })],
    ['claim', entry('claim:7:new', 'claim', { class: 'start', issue: 7, outcome: { kind: 'claim', result: 'lost' } })],
    ['rollout', entry('rollout:70', 'rollout', { issue: 70, pr: 570, outcome: { kind: 'rollout', rollout: 'merge', closeIssue: 70 } })],
    ['wake sequence', entry('judge:sequence:550:head50', 'judge', { ...base, class: 'drive', wake: 'sequence', outcome: wakeAnswer('hold') })],
    ['wake report', entry('judge:report:design:61:5', 'judge', { class: 'drive', issue: 61, wake: 'report', outcome: wakeAnswer('parsed', { fields: { brief: null, created: [], pendingDecision: false } }) })],
    ['running wake', entry('tell:decision:60:u', 'tell', { class: 'owner', issue: 60, wake: 'decision', status: 'running', endedAt: null })],
  ]

  test('every outcome kind the rules read comes back exactly from its note', () => {
    for (const [name, e] of outcomes) {
      expect([name, entryFromLoop(logged(e))]).toEqual([name, e])
      const note = loopNote(e)
      expect([name, note.length <= LOOP_NOTE_MAX, note.includes('  ')]).toEqual([name, true, false])
    }
    expect(loopNote(outcomes[1]![1])).toBe(`kind=claim key=claim:7:new status=done attempts=1 class=start rule=test started=${NOW - 10 * MIN} ended=${NOW - 9 * MIN} out=claim result=lost`)
  })

  test('free text is left out, a guard is not carried, and the note stays one short row', () => {
    const long = 'a reason with spaces, 100% '.repeat(30)
    const held = entry('tell:merge-hold:550:h', 'tell', { class: 'owner', wake: 'merge-hold', outcome: wakeAnswer('done', { reason: long, instructions: long }) })
    const back = entryFromLoop(logged(held))
    expect(back?.outcome).toEqual(wakeAnswer('done'))
    // spaces and percent signs in a value are encoded, so a key survives intact
    const odd = entry('judge:report:brief:60:https://x/a b%20', 'judge', { wake: 'report' })
    expect(entryFromLoop(logged(odd))?.key).toBe('judge:report:brief:60:https://x/a b%20')
    // a v2 agent step's event is for the trail: it rebuilds nothing
    expect(entryFromLoop(logged(entry('i470/l1/s2/build/a1', 'agent-step', { step: 'build' })))).toBeNull()
    // a note too long for a row keeps the entry, without its outcome
    const huge = entry(`release-parent:9:${'x'.repeat(450)}`, 'release-parent', { outcome: { kind: 'cli', exit: 3 } })
    expect(loopNote(huge)).not.toContain('out=')
    expect(entryFromLoop(logged(huge))?.outcome).toBeUndefined()
    expect(entryFromLoop({ ...logged(held), note: 'kind=nope key=x status=done attempts=1 class=free started=1' })).toBeNull()
    expect(entryFromLoop({ ...logged(held), state: 'verdict' })).toBeNull()
  })

  test('the arguments that log an entry put its subject in the columns', () => {
    const e = entry('judge:sequence:550:head50', 'judge', { ...base, class: 'drive', wake: 'sequence' })
    expect(loopEventArgs(e)).toEqual(['loop', '--issue', '50', '--run', '01M4RQ0050AAAA', '--pr', '550', '--head', 'head50', '--note', loopNote(e)])
    expect(loopEventArgs(entry('tell:blind:0', 'tell', { wake: 'blind' }))).toEqual(['loop', '--note', loopNote(entry('tell:blind:0', 'tell', { wake: 'blind' }))])
  })

  test('a lost store is rebuilt from the loop events, the latest per key winning over the rest', () => {
    const asked = entry('judge:sequence:550:head50', 'judge', { ...base, class: 'drive', wake: 'sequence', status: 'running', startedAt: NOW - 30 * MIN, endedAt: null })
    const decided: LedgerEntry = { ...asked, status: 'done', endedAt: NOW - 5 * MIN, outcome: wakeAnswer('hold') }
    const other = { ...logged(decided, NOW - 5 * MIN), device: 'someone-else' }
    const events = [logged(asked, NOW - 30 * MIN), logged(decided, NOW - 5 * MIN), other]
    const ledger = deriveLedger(events, DEVICE)
    // the answered wake, not the open one it began as; another device's events prove nothing of this one's
    expect(ledger.filter(e => e.key === asked.key)).toEqual([decided])
  })
})

describe('trackers (D-35)', () => {
  test('a tracker stands for its open sub-issues, nested trackers followed and loops cut', () => {
    const timelines = new Map([
      [40, [41, 50]],
      [50, [51, 40, 60]],
      [60, [61]],
      [61, [62]],
    ])
    expect(subIssuesOf(40, timelines)).toEqual([41, 50, 51, 60, 61])
    expect(subIssuesOf(40, timelines, 1)).toEqual([41, 50])
    expect(subIssuesOf(41, timelines)).toBeNull()
  })

  test('state carries the list for each tracker read, and the issues only brings in', () => {
    const factory = parseFactoryState(factoryJson([]), REPO)!
    const s = buildState({ ...observedFrom(factory, []), control: control({ only: [40] }), timelines: new Map([[40, [42, 41]]]) })
    expect(s.issues.map(i => [i.number, i.subIssueList])).toEqual([
      [40, [41, 42]],
      [41, null],
      [42, null],
    ])
  })
})

describe('observe for act mode (v2 SPEC 13.3.3, 13.3.4, 13.7.5, 13.10 item 2)', () => {
  const TOOLS = '/opt/branch/callum-tools'
  const LOOP = '/cfg/factory-loop/cbundy__dev-system'
  const ENV = { CALLUM_FLOW_REPO: REPO, PATH: '/opt/branch/bin:/usr/bin', CALLUM_FLOW_READY_LABEL: 'ready' }
  const DAY = 24 * 60 * MIN
  const R44 = RUN(44)
  const R45 = RUN(45)
  const BR45 = 'feat/issue-45-loop'
  const csvCell = (v: string | number | null) => (v === null ? '' : /[",\n ]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  const csv = (events: FactoryEvent[]) =>
    [
      'ts,state,issue,run_id,branch,pr,head,note,actor,device',
      ...events.map(e => [iso(e.ts), e.state, e.issue, e.run, e.branch, e.pr, e.head, e.note, e.actor, e.device].map(csvCell).join(',')),
    ].join('\n')
  // the last 3 days: issue 45's review round and verdict, and a superseded older run of 44
  const RECENT = [
    ev({ state: 'renewed', issue: 45, run: null, branch: null, actor: 'agent', ts: NOW - 5 * MIN }),
    ev({ state: 'closed', issue: 3, run: null, branch: null, actor: 'sweep', ts: NOW - 5 * MIN }),
    ev({ state: 'verdict', issue: 45, run: R45, branch: BR45, note: 'CORRECT: review-1 x', actor: 'agent', ts: NOW - 40 * MIN }),
    ev({ state: 'fix_requested', issue: 45, run: R45, branch: BR45, note: 'review', actor: 'agent', ts: NOW - 39 * MIN }),
    ev({ state: 'superseded', issue: 44, run: R44, branch: null, note: 'by feat/issue-44-v2', actor: 'agent', ts: NOW - 30 * MIN }),
  ]
  const ISSUE = (n: number, title = 'Some work') =>
    JSON.stringify({ issue: { number: n, title, state: 'open', labels: [{ name: 'ready' }], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 })
  const LINES = [
    `parked ${BR45} ${R45} step=review pr=545 head=${SHA(45)}`,
    `running feat/issue-44-old ${R44} pr=544 head=${SHA(44)}`,
    'pending chore/docs unknown head=unknown',
  ].join('\n')

  type Reply = { exitCode?: number; stdout?: string; stderr?: string }
  type Call = { argv: string[]; cwd: string; env: Record<string, string>; stdin?: string }
  // World: what the commands answer; a test changes it between passes.
  type World = {
    factory: Record<string, unknown>[]
    recent: FactoryEvent[]
    week: FactoryEvent[] | null
    // the new store's rows for the facts (NEW_EVENTS_SQL), as dev-query prints them; undefined: exit 78
    newEvents?: Reply
    // each device's first row in the new store (NEW_FLOORS_SQL); the default has no device and so no floor
    floors?: Reply
    pipeline: Reply
    queue: Reply
    issues: Record<string, Reply>
    files: Record<string, string>
    // the main checkout: origin's default branch, and its status
    originHead: Reply
    status: Reply
    // the pool, and what git answers in a slot, by `<path> <reflog|status>` (#563)
    pool: Reply
    slots: Record<string, Reply>
    // a fixed answer to the batched `--issues` call (#922); undefined composes it from the single-read replies
    batch?: Reply
  }

  function host(over: Partial<World> = {}) {
    const world: World = {
      factory: [fsIssue(45, 'parked', { run: R45, pr: 545 }), fsIssue(470, 'queued', { holder: null })],
      recent: RECENT,
      week: null,
      pipeline: { stdout: `${LINES}\n` },
      queue: { stdout: 'queue known=114 now=114,470\n' },
      issues: {},
      files: {},
      originHead: { stdout: 'origin/main\n' },
      status: { stdout: `# branch.oid ${SHA(1)}\n# branch.head main\n` },
      pool: { stdout: '[]' },
      slots: {},
      ...over,
    }
    let now = NOW
    const calls: Call[] = []
    const answer = (argv: string[], stdin?: string): Reply => {
      const [cmd, ...args] = argv
      switch (cmd) {
        case 'callum-flow-factory-state':
          return { stdout: factoryJson(world.factory) }
        case 'dev-query':
          // the facts' read of the new store (v2/sources-facts.ts); no factory URL when the test gives none
          if (stdin === NEW_EVENTS_SQL) return world.newEvents ?? { exitCode: 78 }
          if (stdin === NEW_FLOORS_SQL) return world.floors ?? { stdout: 'device,floor\n' }
          if (!args.includes('days=7')) return { stdout: csv(world.recent) }
          return world.week === null ? { exitCode: 1, stderr: 'psql: connection refused' } : { stdout: csv(world.week) }
        case `${TOOLS}/pipeline-watch.sh`:
          return world.pipeline
        case `${TOOLS}/queue-watch.sh`:
          return world.queue
        case 'callum-flow-issue-read': {
          const key = args.join(' ')
          if (world.issues[key] !== undefined) return world.issues[key]
          if (args.includes('--list')) return { stdout: JSON.stringify({ issues: [{ number: 114 }, { number: 470 }], stripped: 0 }) }
          return { stdout: ISSUE(Number(args[args.length - 1])) }
        }
        case `${TOOLS}/usage-check.sh`:
          return { stdout: 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth' }
        case 'treehouse':
          return world.pool
        case 'git':
          if (args[0] === '-C') return world.slots[`${args[1]} ${args.includes('reflog') ? 'reflog' : 'status'}`] ?? { exitCode: 128 }
          if (args[0] === 'symbolic-ref') return world.originHead
          return args[1] === 'status' ? world.status : {}
        default:
          return {}
      }
    }
    const io: Io = {
      now: async () => now,
      run: async (argv, init) => {
        calls.push({ argv: [...argv], cwd: init.cwd, env: init.env, stdin: init.stdin })
        const r = argv.includes('--issues') && world.batch !== undefined ? world.batch : ((await issuesRead(argv, answer)) ?? answer(argv, init.stdin))
        return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
      readFile: async path => world.files[path] ?? null,
      sessionLimits: async () => [],
      agents: async () => [],
    }
    const cache: Cache = emptyCache()
    const pass = (rt: Runtime, stored?: Stored, at = now): Promise<Observation> => {
      now = at
      calls.length = 0
      return observe(io, rt, cache, NOW - 60 * MIN, null, null, stored)
    }
    const commands = () => calls.map(c => c.argv.join(' '))
    return { world, calls, cache, pass, commands }
  }

  const runtime = (over: Partial<Runtime> = {}): Runtime => ({
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP,
    sink: null,
    env: ENV,
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: config(),
    configProblems: [],
    ...over,
  })
  const stored = (over: Partial<Stored> = {}): Stored => ({
    ledger: [entry('heartbeat:0', 'heartbeat', { startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })],
    githubBackoffUntil: null,
    queueKnown: [114],
    ...over,
  })

  test('every command runs from the checkout with the runtime environment, and the scripts from toolsDir', async () => {
    const h = host()
    await h.pass(runtime(), stored())
    expect(h.calls.length).toBeGreaterThan(6)
    // the very object register built: observe adds nothing of its own
    expect(h.calls.filter(c => c.env !== ENV || c.cwd !== '/work').map(c => c.argv.join(' '))).toEqual([])
    expect(h.commands().some(c => c.includes('pipeline-watch'))).toBe(false)
    expect(h.commands()).toContain(`${TOOLS}/queue-watch.sh --once --repo ${REPO} --label ready --known 114`)
    expect(h.commands()).toContain(`${TOOLS}/usage-check.sh`)
    expect(h.commands().filter(c => c.includes('/usr/local/share/callum-tools'))).toEqual([])

    // observe mode too: its environment (with the sink) reaches every command as given
    const sinkEnv = { ...ENV, CALLUM_EVENTS_DIR: `${LOOP}/sink-events` }
    const o = host()
    await o.pass(runtime({ mode: 'observe', sink: `${LOOP}/sink-events`, env: sinkEnv }))
    expect(o.calls.every(c => c.env === sinkEnv && c.cwd === '/work')).toBe(true)
    expect(o.commands()).toContain(`${TOOLS}/usage-check.sh`)
  })

  test('a pass for another repo reads everything again: nothing cached for one repo stands in for another', async () => {
    const h = host({ queue: { stdout: 'queue known=none now=114,470\n' } })
    const first = await h.pass(runtime(), stored())
    expect(first.state.queue).toEqual([114, 470])
    // the workspace config now names another repo, with no reload: its queue is read afresh,
    // within the queue cadence, and the old repo's issues are not read against the new one
    h.world.queue = { stdout: 'queue known=none now=4,5\n' }
    h.world.factory = []
    const other = 'cbundy/dev-system-testbed'
    const next = await h.pass(runtime({ repo: other }), stored({ queueKnown: null }), NOW + MIN)
    expect(next.state.repo).toBe(other)
    expect(next.state.queue).toEqual([4, 5])
    expect(h.commands()).toContain(`${TOOLS}/queue-watch.sh --once --repo ${other} --label ready --known none`)
    expect(h.commands().filter(c => /callum-flow-issue-read --json (114|470)$/.test(c))).toEqual([])
    expect(h.cache.repo).toBe(other)
  })

  test('the loop reads no pipeline runs: the runs source says so, and no watcher runs; only the event log stands in for them (the shadow, the replay)', async () => {
    const h = host()
    const obs = await h.pass(runtime(), stored())
    expect(obs.state.sources.runs).toEqual({ ok: false, at: null, error: 'not read: the loop has no pipeline runs' })
    expect(obs.state.runs).toEqual([])
    expect(h.commands().some(c => c.includes('pipeline-watch'))).toBe(false)
    const s = host()
    const shadow = await s.pass(runtime({ mode: 'observe', runSource: 'events' }))
    expect(shadow.state.sources.runs.ok).toBe(true)
    expect(s.commands().some(c => c.includes('pipeline-watch'))).toBe(false)
  })

  test('act mode reads the queue through queue-watch.sh with the stored known list; exit 1 is a failed source', async () => {
    const h = host()
    const obs = await h.pass(runtime(), stored({ queueKnown: [470, 114] }))
    expect(h.commands()).toContain(`${TOOLS}/queue-watch.sh --once --repo ${REPO} --label ready --known 470,114`)
    expect(h.commands().some(c => c.includes('--list'))).toBe(false)
    expect(obs.state.queue).toEqual([114, 470])
    expect(obs.queueKnown).toEqual([114, 470])
    // nothing known yet: none; the cadence holds the next read, and nothing new is to be saved
    const fresh = host()
    await fresh.pass(runtime({ config: config({ readyLabel: 'go' }) }), stored({ queueKnown: null }))
    expect(fresh.commands()).toContain(`${TOOLS}/queue-watch.sh --once --repo ${REPO} --label go --known none`)
    const later = await fresh.pass(runtime(), stored({ queueKnown: [114, 470] }), NOW + MIN)
    expect(fresh.commands().some(c => c.includes('queue-watch'))).toBe(false)
    expect([later.queueKnown, later.state.sources.queue]).toEqual([null, { ok: true, at: NOW }])

    // a reader failure: the last queue stays with its age, and no list to save
    h.world.queue = { exitCode: 1, stderr: 'queue-watch.sh: cannot read the queue\n' }
    const failed = await h.pass(runtime(), stored(), NOW + 3 * MIN)
    expect(failed.state.sources.queue).toEqual({ ok: false, at: NOW, error: 'exit 1: queue-watch.sh: cannot read the queue' })
    expect([failed.state.queue, failed.queueKnown]).toEqual([[114, 470], null])
    h.world.queue = { stdout: 'queue known=114 now=\n' }
    expect((await h.pass(runtime(), stored(), NOW + 6 * MIN)).state.sources.queue.ok).toBe(false)

    // observe mode keeps the plain reader, so the shadow logs no ready events of its own
    const o = host()
    const shadow = await o.pass(runtime({ mode: 'observe', runSource: 'events' }))
    expect(o.commands()).toContain('callum-flow-issue-read --json --list --label ready')
    expect(o.commands().some(c => c.includes('queue-watch'))).toBe(false)
    expect([shadow.state.queue, shadow.queueKnown]).toEqual([[114, 470], null])
  })

  test('the store wins whenever it holds a ledger; observe mode derives it from the 3-day log', async () => {
    const kept = [entry('claim:470:new', 'claim', { class: 'start', issue: 470, outcome: { kind: 'claim', result: 'claimed' } })]
    const h = host()
    const obs = await h.pass(runtime(), stored({ ledger: kept }))
    expect([obs.ledgerSource, obs.state.ledger]).toEqual(['store', kept])
    // (v2 reads the last 90 days of its own device's events beside, for its dual write)
    expect(h.commands().filter(c => c.startsWith('dev-query') && !c.includes('since=')).map(c => c.match(/days=\d+/)?.[0])).toEqual(['days=3', 'days=90'])

    const o = host()
    const shadow = await o.pass(runtime({ mode: 'observe' }))
    expect(shadow.ledgerSource).toBe('events')
    expect(shadow.state.ledger.map(e => e.key)).toEqual(['heartbeat:derived', 'sweep:derived'])
    expect(o.commands().filter(c => c.startsWith('dev-query') && !c.includes('since=')).map(c => c.match(/days=\d+/)?.[0])).toEqual(['days=3', 'days=90'])
  })

  test('a lost store is rebuilt from 7 days of events, once: holds older than the facts window survive', async () => {
    // an answered wake five days old: outside the 3-day facts window, inside the week
    const life = NOW - 5 * DAY
    const decided = entry('judge:sequence:550:head50', 'judge', {
      class: 'drive',
      rule: 'M5',
      issue: 50,
      pr: 550,
      head: 'head50',
      wake: 'sequence',
      startedAt: life,
      endedAt: life + 60 * MIN,
      outcome: wakeAnswer('hold'),
    })
    const loop = ev({ state: 'loop', issue: 50, run: null, branch: null, pr: 550, head: 'head50', note: loopNote(decided), actor: 'agent', ts: life + 60 * MIN })
    const factory = [fsIssue(60, 'designing', { entered_at: iso(life) })]
    const h = host({ factory, week: [loop, ...RECENT] })
    const obs = await h.pass(runtime(), stored({ ledger: null }))
    expect(obs.ledgerSource).toBe('events')
    expect(h.calls.filter(c => c.argv[0] === 'dev-query' && c.stdin !== FLAKES_SQL).map(c => [c.argv.find(a => a.startsWith('days=')), c.stdin === EVENTS_SQL])).toEqual([
      ['days=3', true],
      ['days=7', true],
      ['days=90', false],
    ])
    expect(obs.state.ledger.find(e => e.key === decided.key)).toEqual(decided)
    // the 3-day window alone would have lost it
    const shadow = await host({ factory, week: [loop, ...RECENT] }).pass(runtime({ mode: 'observe' }))
    expect(shadow.state.ledger.find(e => e.key === decided.key)).toBeUndefined()

    // register saved it: from now on the store holds it, and the week is not read again
    const next = await h.pass(runtime(), stored({ ledger: obs.state.ledger }), NOW + MIN)
    expect(next.ledgerSource).toBe('store')
    expect(h.commands().filter(c => c.includes('days=7'))).toEqual([])
  })

  test('a rebuild that finds nothing is not repeated; one the log cannot serve is retried and blocks review gates', async () => {
    const h = host({ week: [] })
    const empty = await h.pass(runtime(), stored({ ledger: null }))
    expect([empty.ledgerSource, empty.state.ledger]).toEqual(['none', []])
    const again = await h.pass(runtime(), stored({ ledger: [] }), NOW + MIN)
    expect(again.ledgerSource).toBe('none')
    expect(h.commands().filter(c => c.includes('days=7'))).toEqual([])

    const down = host({ week: null })
    const failed = await down.pass(runtime(), stored({ ledger: null }))
    expect(failed.ledgerSource).toBe('none')
    expect(failed.state.sources.facts).toEqual({
      ok: false,
      at: NOW,
      error: 'the store holds no ledger and the event log could not rebuild it: exit 1: psql: connection refused',
    })
    down.world.week = []
    await down.pass(runtime(), stored({ ledger: null }), NOW + MIN)
    expect(down.commands().filter(c => c.includes('days=7'))).toHaveLength(1)
  })

  describe('the facts and the ledger rebuild follow eventsSource (v2/sources-facts.ts)', () => {
    // RECENT's heartbeat (a renewal) and the sweep's close, as the new store holds them
    const NEW_RECENT = [
      eventRow('claim_renewed', { lease_minutes: 120 }, NOW - 5 * MIN, { issue: '45' }),
      eventRow('closed', { reason: 'completed' }, NOW - 5 * MIN, { issue: '3', actor: 'sweep' }),
    ]
    const withSource = (eventsSource: 'old' | 'new' | 'shadow') => runtime({ mode: 'observe', config: config({ eventsSource }) })
    const calls = (h: ReturnType<typeof host>, sql: string) => h.calls.filter(c => c.argv[0] === 'dev-query' && c.stdin === sql)
    const keys = (o: Observation) => o.state.ledger.map(e => e.key)

    test('old reads factory.events alone, as before', async () => {
      const h = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) } })
      const o = await h.pass(withSource('old'))
      expect(calls(h, NEW_EVENTS_SQL)).toHaveLength(0)
      expect(calls(h, EVENTS_SQL).map(c => c.argv.join(' '))).toEqual([`dev-query --csv -v repo=${REPO} -v at=${iso(NOW)} -v days=3`])
      expect([o.state.sources.facts.ok, keys(o), h.cache.factsShadow]).toEqual([true, ['heartbeat:derived', 'sweep:derived'], undefined])
    })

    test('the default reads factory.event_store alone, through the factory database', async () => {
      const h = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) } })
      const o = await h.pass(runtime({ mode: 'observe', config: config({ eventsSource: DEFAULT_CONFIG.eventsSource }) }))
      expect(calls(h, EVENTS_SQL)).toHaveLength(0)
      expect(calls(h, NEW_EVENTS_SQL).map(c => c.argv.join(' '))).toEqual([`dev-query --factory --csv -v repo=${REPO} -v at=${iso(NOW)} -v days=3`])
      expect([o.state.sources.facts.ok, keys(o), h.cache.factsShadow]).toEqual([true, ['heartbeat:derived', 'sweep:derived'], undefined])
    })

    test('new reads factory.event_store alone, through the factory database, and rebuilds the same ledger', async () => {
      const h = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) } })
      const o = await h.pass(withSource('new'))
      expect(calls(h, EVENTS_SQL)).toHaveLength(0)
      expect(calls(h, NEW_EVENTS_SQL).map(c => c.argv.join(' '))).toEqual([`dev-query --factory --csv -v repo=${REPO} -v at=${iso(NOW)} -v days=3`])
      expect([o.state.sources.facts.ok, keys(o), h.cache.factsShadow]).toEqual([true, ['heartbeat:derived', 'sweep:derived'], undefined])
      // the facts nothing in v2 reads come out empty: the old rows hold a verdict, a review fix and a supersede
      expect(factsOf(h.cache.events?.value ?? []).verdicts.size).toBe(0)
    })

    test('new: a row the reader refuses, or no factory URL, leaves the facts not ok and names the event and the source', async () => {
      const bad = eventRow('claim_renewed', { lease_minutes: 120 }, NOW - 5 * MIN, { issue: '45', type_version: '9' })
      const h = host({ newEvents: { stdout: eventsCsv([...NEW_RECENT, bad]) } })
      const o = await h.pass(withSource('new'))
      expect(o.state.sources.facts.ok).toBe(false)
      expect(o.state.sources.facts.error).toContain(`event ${bad.event_id}`)
      expect(o.state.sources.facts.error).toContain('source new')
      const noUrl = await host().pass(withSource('new'))
      expect(noUrl.state.sources.facts.ok).toBe(false)
      expect(noUrl.state.sources.facts.error).toContain('source new')
    })

    test('shadow decides on old, reads both on the first pass of a load and only old within the hour, and a failing new read never fails the pass', async () => {
      const h = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) } })
      const first = await h.pass(withSource('shadow'))
      expect([calls(h, EVENTS_SQL).length, calls(h, NEW_EVENTS_SQL).length]).toEqual([1, 1])
      expect([first.state.sources.facts.ok, keys(first)]).toEqual([true, ['heartbeat:derived', 'sweep:derived']])
      expect(first.state.v2?.factsShadow?.data).toMatchObject({ reader: 'loop-facts', tool: 'factory-loop', compared: 2, differences: 0, live_differences: 0, diff_keys: [], old_ok: true, new_ok: true })
      await h.pass(withSource('shadow'), undefined, NOW + 30 * MIN)
      expect([calls(h, EVENTS_SQL).length, calls(h, NEW_EVENTS_SQL).length]).toEqual([1, 0])
      expect(h.cache.factsShadow?.at).toBe(NOW)
      await h.pass(withSource('shadow'), undefined, NOW + 61 * MIN)
      expect([calls(h, EVENTS_SQL).length, calls(h, NEW_EVENTS_SQL).length]).toEqual([1, 1])
      expect(h.cache.factsShadow?.at).toBe(NOW + 61 * MIN)

      // the new store without a renewal made half an hour ago: the compare counts it, and the pass still uses old
      const old = ev({ state: 'renewed', issue: 45, run: null, branch: null, actor: 'agent', ts: NOW - 30 * MIN })
      const short = host({ recent: [old], newEvents: { stdout: eventsCsv([]) } })
      const differing = await short.pass(withSource('shadow'))
      expect(keys(differing)).toEqual(['heartbeat:derived'])
      expect(differing.state.v2?.factsShadow?.data).toMatchObject({ differences: 1, live_differences: 1, diff_keys: ['ledger:heartbeat:derived'] })

      // the new read fails (no factory URL): new_ok false, the facts stay ok
      const down = host()
      const failed = await down.pass(withSource('shadow'))
      expect(failed.state.sources.facts.ok).toBe(true)
      expect(keys(failed)).toEqual(['heartbeat:derived', 'sweep:derived'])
      expect(failed.state.v2?.factsShadow?.data).toMatchObject({ old_ok: true, new_ok: false, compared: 0, differences: 0, diff_keys: [] })
    })

    test('shadow reads the device floors once per compare, through the factory database, and a failing read fails the compare alone', async () => {
      const h = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) } })
      const floorCalls = () => calls(h, NEW_FLOORS_SQL).map(c => c.argv.join(' '))
      const first = await h.pass(withSource('shadow'))
      expect(floorCalls()).toEqual([`dev-query --factory --csv -v repo=${REPO}`])
      expect([calls(h, EVENTS_SQL).length, calls(h, NEW_EVENTS_SQL).length, floorCalls().length]).toEqual([1, 1, 1])
      expect(first.state.v2?.factsShadow?.data).toMatchObject({ new_ok: true, scope_floor: null, out_of_scope: 0 })
      // no compare within the hour: no floor read
      await h.pass(withSource('shadow'), undefined, NOW + 30 * MIN)
      expect(floorCalls()).toHaveLength(0)
      // old and new make no floor call
      for (const source of ['old', 'new'] as const) {
        const other = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) } })
        await other.pass(withSource(source))
        expect(calls(other, NEW_FLOORS_SQL)).toHaveLength(0)
      }
      // a floor read that fails: the compare failed on the new side, the pass and its facts stay ok
      const down = host({ newEvents: { stdout: eventsCsv(NEW_RECENT) }, floors: { exitCode: 1, stderr: 'boom' } })
      const failed = await down.pass(withSource('shadow'))
      expect(failed.state.sources.facts.ok).toBe(true)
      expect(keys(failed)).toEqual(['heartbeat:derived', 'sweep:derived'])
      expect(failed.state.v2?.factsShadow?.data).toMatchObject({ old_ok: true, new_ok: false, compared: 0, differences: 0, diff_keys: [] })
      expect(failed.state.v2?.factsShadow?.data.detail).toContain('source new')
    })

    test('shadow: the events older than their device floor are no difference, and the data names the floor', async () => {
      const old = ev({ state: 'renewed', issue: 45, run: null, branch: null, actor: 'agent', ts: NOW - 30 * MIN })
      const floor = iso(NOW - 10 * MIN).replace('.000Z', 'Z')
      const withFloor = host({ recent: [old], newEvents: { stdout: eventsCsv([]) }, floors: { stdout: `device,floor\n${old.device},${floor}\n` } })
      const o = await withFloor.pass(withSource('shadow'))
      expect(keys(o)).toEqual(['heartbeat:derived'])
      expect(o.state.v2?.factsShadow?.data).toMatchObject({ differences: 0, live_differences: 0, diff_keys: [], new_ok: true, out_of_scope: 1 })
      expect(o.state.v2?.factsShadow?.data.scope_floor).toBe(floor.replace('Z', '.000Z'))
    })

    test('the ledger rebuild of a lost store reads the week from the source eventsSource picks', async () => {
      const tell = entry('tell:parked:50', 'tell', { class: 'owner', rule: 'H1', issue: 50, wake: 'parked', startedAt: NOW - 5 * DAY, endedAt: NOW - 5 * DAY + MIN })
      const row = eventRow('loop_entry', { kind: 'tell', key: tell.key, status: 'done', attempts: 1, class: 'owner', rule: 'H1', started_at: iso(NOW - 5 * DAY), ended_at: iso(NOW - 5 * DAY + MIN), agent_id: null, wake: 'parked' }, NOW - 5 * DAY + MIN, { issue: '50' })
      const h = host({ week: [], newEvents: { stdout: eventsCsv([row]) } })
      const act = runtime({ config: config({ eventsSource: 'new' }) })
      const o = await h.pass(act, stored({ ledger: null }))
      expect(o.ledgerSource).toBe('events')
      expect(o.state.ledger.find(e => e.key === tell.key)).toEqual({ ...tell, run: null, pr: null, head: null })
      expect(calls(h, NEW_EVENTS_SQL).map(c => c.argv.find(a => a.startsWith('days=')))).toEqual(['days=3', 'days=7'])
      expect(calls(h, EVENTS_SQL)).toHaveLength(0)
    })
  })

  test('a GitHub backoff skips the queue and issue reads, their old values kept with their age', async () => {
    const h = host()
    const first = await h.pass(runtime(), stored())
    expect(first.state.githubBackoffUntil).toBeNull()
    const until = NOW + 12 * MIN
    const held = await h.pass(runtime(), stored({ githubBackoffUntil: until }), NOW + 3 * MIN)
    expect(h.commands().filter(c => c.includes('queue-watch') || c.startsWith('callum-flow-issue-read'))).toEqual([])
    const waiting = `GitHub rate limit: waiting until ${iso(until)}`
    expect([held.state.sources.queue, held.state.sources.github]).toEqual([
      { ok: false, at: NOW, error: waiting },
      { ok: false, at: NOW, error: waiting },
    ])
    expect(held.state.queue).toEqual([114, 470])
    expect(held.state.issues.find(i => i.number === 470)?.labels).toEqual(['ready'])
    expect(held.state.githubBackoffUntil).toBe(until)
    // the other sources still run
    expect(h.commands()).toContain('treehouse status --json')

    // once it has passed, GitHub is read again and the state shows no wait
    const over = await h.pass(runtime(), stored({ githubBackoffUntil: NOW + 6 * MIN }), NOW + 6 * MIN)
    expect(h.commands().some(c => c.includes('queue-watch'))).toBe(true)
    expect([over.state.githubBackoffUntil, over.state.sources.queue.ok]).toEqual([null, true])
  })

  test('a rate limit in a command is reported, ends the pass\'s GitHub reads, and holds GitHub writes in act mode', async () => {
    const limit = { exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)\n' }
    const h = host({ issues: { '--json 114': limit } })
    const obs = await h.pass(runtime(), stored())
    expect(obs.rateLimited).toBe(true)
    // 45, this device's, is read first (#556); the one batched call hits the limit; no single read follows
    expect(h.commands().filter(c => c.startsWith('callum-flow-issue-read'))).toEqual(['callum-flow-issue-read --json --issues 45,114,470'])
    expect(obs.state.sources.github).toEqual({ ok: false, at: NOW, error: 'GitHub rate limit' })
    expect(obs.state.githubBackoffUntil).toBe(NOW + GITHUB_BACKOFF_MS)

    // observe mode reports it too, but keeps no backoff of its own
    const o = host({ issues: { '--json 114': limit } })
    const shadow = await o.pass(runtime({ mode: 'observe' }))
    expect([shadow.rateLimited, shadow.state.githubBackoffUntil]).toEqual([true, null])
    // a quiet pass reports none
    expect((await host().pass(runtime(), stored())).rateLimited).toBe(false)
  })

  test('the main checkout is read every pass, and a moved one holds what starts in it at once (#544)', async () => {
    const h = host({ factory: [fsIssue(60, 'designing')] })
    const first = await h.pass(runtime(), stored())
    expect(h.commands()).toContain('git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
    expect(h.commands()).toContain('git --no-optional-locks status --porcelain=v2 --branch --untracked-files=no')
    expect(first.state.checkout).toEqual({ branch: 'main', head: SHA(1), defaultBranch: 'main', dirty: [] })

    // an agent checks out another issue's branch: the next pass sees it
    h.world.status = { stdout: `# branch.oid ${SHA(4)}\n# branch.head (detached)\n` }
    const moved = await h.pass(runtime(), stored(), NOW + MIN)
    expect(moved.state.checkout).toMatchObject({ branch: null, head: SHA(4) })

    // a read that fails is a checkout not proven where it belongs; observe mode reads it too
    h.world.originHead = { exitCode: 1 }
    expect((await h.pass(runtime(), stored(), NOW + 2 * MIN)).state.checkout).toEqual({
      error: 'no origin/HEAD (exit 1); git remote set-head origin --auto sets it',
    })
    h.world.originHead = { stdout: 'origin/main\n' }
    h.world.status = { exitCode: 128, stderr: 'fatal: not a git repository\n' }
    expect((await h.pass(runtime({ mode: 'observe' }), undefined, NOW + 3 * MIN)).state.checkout).toEqual({ error: 'exit 128: fatal: not a git repository' })
  })

  // an issue as the reader prints it once it is closed
  const CLOSED = (n: number): Reply => ({
    stdout: JSON.stringify({
      issue: { number: n, title: 'Old work', state: 'closed', labels: [{ name: 'In development' }], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } },
      stripped: 0,
    }),
  })
  // the issues one pass read, in order: the numbers of its batched call (#922), or the single reads
  const issueReads = (h: ReturnType<typeof host>) =>
    h.commands().flatMap(c => {
      if (c.startsWith('callum-flow-issue-read --json --issues ')) return c.slice('callum-flow-issue-read --json --issues '.length).split(',')
      return c.startsWith('callum-flow-issue-read --json ') && !c.includes('--list') ? [c.slice('callum-flow-issue-read --json '.length)] : []
    })

  test('the first pass reads the issues the loop would act on before the queue, so a closed one is never driven (testbed run 3, #556)', async () => {
    // twelve ready issues, and run 2's issues 40 and 41, closed at the reset, still live in the
    // factory with their failed runs listed; 32 is another device's, closed too
    const queue = Array.from({ length: 12 }, (_, i) => 60 + i)
    const R40 = RUN(40)
    const R41 = RUN(41)
    const h = host({
      factory: [
        fsIssue(40, 'parked', { run: R40, pr: 540, stuck: { rule: 'S3', text: 'parked for more than 30 minutes' } }),
        fsIssue(41, 'in pipeline', { run: R41, pr: 541 }),
        fsIssue(32, 'parked', { holder: OTHER, run: RUN(32), pr: 532 }),
      ],
      pipeline: { stdout: `failed feat/issue-40-x ${R40} step=review pr=540 head=${SHA(40)}\nfailed feat/issue-41-x ${R41} step=review pr=541 head=${SHA(41)}\n` },
      queue: { stdout: `queue known=none now=${queue.join(',')}\n` },
      issues: { '--json 40': CLOSED(40), '--json 41': CLOSED(41), '--json 32': CLOSED(32) },
    })
    const kept = stored({ queueKnown: null })
    const first = await h.pass(runtime(), kept)
    // the twelve reads of the pass: this device's issues, the other live one, then the queue
    expect(issueReads(h)).toEqual(['40', '41', '32', ...queue.slice(0, 9).map(String)])
    expect(first.state.issues.filter(i => i.open === false).map(i => i.number)).toEqual([32, 40, 41])

    // a closed issue is not read again, unless this device holds it: 40 and 41 are read again
    // with the oldest reads, after the rest of the queue; 32, another device's, is not
    h.world.issues['--json 40'] = { stdout: ISSUE(40) }
    const second = await h.pass(runtime(), kept, NOW + 6 * MIN)
    expect(issueReads(h)).toEqual(['69', '70', '71', '40', '41', ...queue.slice(0, 7).map(String)])
    // 40 was reopened: held and open, it is driven again (its lease renewed with it, rule H1)
    expect(second.state.issues.find(i => i.number === 40)?.open).toBe(true)
  })

  test('an issue with a running agent of the loop is read too; a failed read keeps the last state; a closed issue back in the queue is read again (#556)', async () => {
    const fixer = entry('i77/l1/s2/fix/a1', 'agent-step', { step: 'fix', class: 'drive', issue: 77, status: 'running', agentId: 'a77', startedAt: NOW - 5 * MIN, endedAt: null })
    const kept = stored({ ledger: [...(stored().ledger ?? []), fixer] })
    const h = host({ issues: { '--json 77': CLOSED(77) } })
    const first = await h.pass(runtime(), kept)
    expect(issueReads(h)).toEqual(['77', '45', '114', '470'])
    // the factory never saw 77, but its agent is the loop's: the closed issue is in the state
    expect(first.state.issues.find(i => i.number === 77)?.open).toBe(false)

    // 45's next read fails: it stays open as last read, never unknown or closed
    h.world.issues['--json 45'] = { exitCode: 1, stderr: 'callum-flow-issue-read: cannot read issue #45' }
    const later = await h.pass(runtime(), kept, NOW + 6 * MIN)
    expect(issueReads(h)).toEqual(['45', '114', '470'])
    expect(later.state.issues.find(i => i.number === 45)?.open).toBe(true)
    expect(later.state.sources.github.ok).toBe(false)

    // 77 reopened and made ready: the queue lists open issues only, so it is read again
    h.world.queue = { stdout: 'queue known=114,470 now=77,114,470\n' }
    h.world.issues['--json 77'] = { stdout: ISSUE(77) }
    const back = await h.pass(runtime(), kept, NOW + 12 * MIN)
    expect(issueReads(h)).toContain('77')
    expect(back.state.issues.find(i => i.number === 77)?.open).toBe(true)
  })

  test('forty queued issues are read with one batched call of at most twelve numbers, never by single reads (#922)', async () => {
    const queue = Array.from({ length: 40 }, (_, i) => 200 + i)
    const issues = Object.fromEntries(queue.map(n => [`--json ${n}`, { stdout: ISSUE(n) }]))
    const h = host({ queue: { stdout: `queue known=none now=${queue.join(',')}\n` }, issues })
    const obs = await h.pass(runtime(), stored({ queueKnown: null }))
    const calls = h.commands().filter(c => c.startsWith('callum-flow-issue-read') && !c.includes('--list'))
    expect(calls.filter(c => c.includes('--issues'))).toHaveLength(1)
    expect(calls.filter(c => !c.includes('--issues') && !c.includes('--timeline') && !c.includes('--comments'))).toEqual([])
    expect(issueReads(h).length).toBeLessThanOrEqual(12)
    expect(obs.state.sources.github.ok).toBe(true)
    // the cached facts are those the single read gives: compare with a pass of single reads
    const read = issueReads(h).map(Number)
    const batched = obs.state.issues.filter(i => read.includes(i.number))
    expect(batched).toHaveLength(read.length)
    const single = host({ queue: { stdout: `queue known=none now=${queue.join(',')}\n` }, issues })
    single.world.batch = { exitCode: 2, stderr: 'usage' }
    const ref = await single.pass(runtime(), stored({ queueKnown: null }))
    for (const i of batched) {
      expect(i.open).toBe(true)
      expect(i).toEqual(ref.state.issues.find(j => j.number === i.number))
    }
  })

  test('the open issues a read issue blocks join the next read last, behind every other reason and within the cap, and a closed one is not read (#1004)', async () => {
    const blocking = (...ns: number[]) => ({ stdout: JSON.stringify({ issue: { ...JSON.parse(ISSUE(45)).issue, blocking: ns.map(number => ({ number, repo: REPO, state: 'open' })) }, stripped: 0 }) })
    const h = host({ issues: { '--json 45': blocking(900), '--json 900': { stdout: ISSUE(900) } } })
    const first = await h.pass(runtime(), stored())
    expect(issueReads(h)).toEqual(['45', '114', '470'])
    expect(first.state.issues.find(i => i.number === 45)?.blockingList).toEqual([900])
    expect(first.state.issues.find(i => i.number === 114)?.blockingList).toBeNull()

    // the next pass: one call, 900 after the others
    await h.pass(runtime(), stored(), NOW + 6 * MIN)
    expect(h.commands().filter(c => c.includes('--issues'))).toHaveLength(1)
    expect(issueReads(h)).toEqual(['45', '114', '470', '900'])

    // 900 closed: known closed, it is not read again
    h.world.issues['--json 900'] = CLOSED(900)
    await h.pass(runtime(), stored(), NOW + 12 * MIN)
    expect(issueReads(h)).toEqual(['45', '114', '470', '900'])
    await h.pass(runtime(), stored(), NOW + 18 * MIN)
    expect(issueReads(h)).toEqual(['45', '114', '470'])
  })

  test('a chain never starves the issues the loop acts on: with twelve other due issues the blocked one is not read (#1004)', async () => {
    const blocking = { stdout: JSON.stringify({ issue: { ...JSON.parse(ISSUE(45)).issue, blocking: [{ number: 900, repo: REPO, state: 'open' }] }, stripped: 0 }) }
    const h = host({ issues: { '--json 45': blocking } })
    await h.pass(runtime(), stored())
    const queue = Array.from({ length: 14 }, (_, i) => 300 + i)
    h.world.queue = { stdout: `queue known=none now=${queue.join(',')}
` }
    await h.pass(runtime(), stored({ queueKnown: null }), NOW + 6 * MIN)
    const reads = issueReads(h)
    expect(reads).toHaveLength(12)
    expect(reads).not.toContain('900')
  })

  test('a failed batched call keeps every last value and marks github not ok; an exit-2 reader falls back to single reads; a refused number is untrusted (#922)', async () => {
    const h = host()
    const good = await h.pass(runtime(), stored())
    expect(good.state.issues.find(i => i.number === 114)?.open).toBe(true)

    // the whole call fails: the values stay, github is not ok
    h.world.batch = { exitCode: 1, stderr: 'callum-flow-issue-read: boom' }
    const failed = await h.pass(runtime(), stored(), NOW + 6 * MIN)
    expect(failed.state.sources.github.ok).toBe(false)
    expect(failed.state.issues.find(i => i.number === 114)?.open).toBe(true)

    // an older reader exits 2 on --issues: single reads in the same pass
    h.world.batch = { exitCode: 2, stderr: 'usage' }
    const old = await h.pass(runtime(), stored(), NOW + 12 * MIN)
    const after = h.commands().filter(c => c.startsWith('callum-flow-issue-read --json '))
    expect(after).toContain('callum-flow-issue-read --json 114')
    expect(old.state.sources.github.ok).toBe(true)

    // a refused number is cached as untrusted
    h.world.batch = undefined
    h.world.issues['--json 114'] = { exitCode: 3, stderr: 'refused' }
    const refused = await h.pass(runtime(), stored(), NOW + 18 * MIN)
    expect(refused.state.issues.find(i => i.number === 114)?.trusted ?? false).toBe(false)
  })

  test("an issue whose labels the loop changed is read again on the next pass, not a read period later (drill run 2, R2-O2)", async () => {
    const BARE = { stdout: JSON.stringify({ issue: { number: 114, title: 'Some work', state: 'open', labels: [{ name: 'factory:designing' }], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }) }
    const h = host({ issues: { '--json 114': BARE } })
    await h.pass(runtime(), stored())
    expect(issueReads(h)).toContain('114')
    // the loop's own label op (a release back to the queue) ended done after that read
    h.world.issues['--json 114'] = { stdout: ISSUE(114) }
    const requeue = entry('label:114:release', 'label', { issue: 114, status: 'done', startedAt: NOW + MIN, endedAt: NOW + MIN })
    const next = await h.pass(runtime(), stored({ ledger: [...(stored().ledger ?? []), requeue] }), NOW + 1.5 * MIN)
    expect(issueReads(h)).toEqual(['114'])
    expect(next.state.issues.find(i => i.number === 114)?.labels).toEqual(['ready'])
    // once read after it, the op makes no further read due
    await h.pass(runtime(), stored({ ledger: [...(stored().ledger ?? []), requeue] }), NOW + 1.8 * MIN)
    expect(issueReads(h)).toEqual([])
  })

  test("an issue the loop put back in the queue is listed on the next pass, not a queue period later (drill run 2, R2-O2)", async () => {
    const h = host({ queue: { stdout: 'queue known=114 now=470\n' } })
    expect((await h.pass(runtime(), stored())).state.queue).toEqual([470])
    // the loop's own requeue of 114 (ready on) ended done after that read
    h.world.queue = { stdout: 'queue known=470 now=114,470\n' }
    const requeue = entry('label:114:release', 'label', { issue: 114, status: 'done', startedAt: NOW + MIN, endedAt: NOW + MIN })
    const next = await h.pass(runtime(), stored({ ledger: [...(stored().ledger ?? []), requeue] }), NOW + 1.5 * MIN)
    expect(next.state.queue).toEqual([114, 470])
    expect(next.state.issues.find(i => i.number === 114)?.labels).toEqual(['ready'])
    // once read after it, the op makes no further queue read due
    await h.pass(runtime(), stored({ ledger: [...(stored().ledger ?? []), requeue] }), NOW + 1.8 * MIN)
    expect(h.commands().some(c => c.includes('queue-watch'))).toBe(false)
  })

  test("a merged Run it not answered done is read until it closes, so the owner closing it ends rule M5's wait (#556)", async () => {
    const task = (n: number, decision: string) => entry(`task:run-it:${n}`, 'task', { wake: 'run-it', class: 'drive', issue: n, outcome: wakeAnswer(decision) })
    const kept = stored({ ledger: [...(stored().ledger ?? []), task(50, 'hold'), task(51, 'done')] })
    const h = host({ issues: { '--json 50': CLOSED(50) } })
    const first = await h.pass(runtime(), kept)
    // 50 held for the owner is read; 51's Run it is done, so it is not
    expect(issueReads(h)).toEqual(['45', '50', '114', '470'])
    expect(first.state.issues.find(i => i.number === 50)?.open).toBe(false)
    // closed, it is not read again
    await h.pass(runtime(), kept, NOW + 6 * MIN)
    expect(issueReads(h)).toEqual(['45', '114', '470'])
  })

  test('state.agents lists only the session agents the ledger holds', async () => {
    const agents = [
      { id: 'a1', type: 'callum-flow:adjudicator', status: 'running' as const },
      { id: 'other', type: 'general-purpose', status: 'running' as const },
    ]
    const spawned = entry('i45/l1/s2/review/a1', 'agent-step', { step: 'review', class: 'drive', status: 'running', endedAt: null, agentId: 'a1' })
    const io: Io = {
      now: async () => NOW,
      run: async argv => (argv[0] === 'callum-flow-factory-state' ? { exitCode: 0, stdout: factoryJson([]), stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }),
      readFile: async () => null,
      sessionLimits: async () => [],
      agents: async () => agents,
    }
    const obs = await observe(io, runtime(), emptyCache(), NOW, null, null, stored({ ledger: [spawned] }))
    expect(obs.state.agents).toEqual([agents[0]])
  })
})

// observedFrom: what observe would hand buildState, from a factory report and events.
function observedFrom(factory: NonNullable<ReturnType<typeof parseFactoryState>>, events: FactoryEvent[]): Observed {
  const base = state()
  return {
    now: NOW,
    repo: REPO,
    device: DEVICE,
    loadedAt: NOW - 60 * MIN,
    sources: base.sources,
    factory,
    facts: factsOf(events),
    runs: null,
    queue: [],
    github: new Map(),
    timelines: new Map(),
    usage: base.usage,
    pool: base.pool,
    agents: [],
    milestone: null,
    ledger: [],
    control: control(),
    lastTitle: null,
    lastTitleAt: null,
    githubBackoffUntil: null,
    trackerTitle: config().trackerTitle,
  }
}
