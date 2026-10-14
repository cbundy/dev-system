// The observe half's pure pieces against canned command output: the parsers (parse.ts), the
// event derivation (derive.ts) and the state assembly (state.ts). Shapes are copied from real
// output of callum-flow-factory-state, callum-flow-issue-read, usage-check.sh, treehouse,
// callum-flow-milestone and dev-query on 2026-10-12.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, EMPTY_CONTROL, controlFrom, loadConfig, parseDuration } from '../hooks/config'
import { EVENTS_SQL, LOOP_NOTE_MAX, deriveLedger, entryFromLoop, eventsFromRows, factsOf, loopEventArgs, loopNote, runsFromEvents } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import { GITHUB_BACKOFF_MS, emptyCache, observe } from '../hooks/observe'
import type { Cache, Io, Observation, Runtime, Stored } from '../hooks/observe'
import {
  parseBrief,
  parseCheckout,
  parseCsv,
  parseFactoryState,
  parseIssueRead,
  parseMilestone,
  parsePipelineLine,
  parsePipelineOnce,
  parsePool,
  parseQueue,
  parseQueueOnce,
  parseSubIssues,
  parseUsage,
} from '../hooks/parse'
import type { PipelineRun } from '../hooks/parse'
import { plan } from '../hooks/plan'
import { buildState, runsFromWatch, seenRuns, subIssuesOf } from '../hooks/state'
import type { Observed } from '../hooks/state'
import type { LedgerEntry, Outcome, RunState } from '../hooks/types'
import { DEVICE, NOW, MIN, OTHER, PLUGIN_ROOT, config, control, entry, review, run, state, wakeAnswer } from './fixtures'

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
    expect(parseIssueRead(json)).toEqual({ open: true, labels: ['enhancement', 'ready'], blockedBy: 1, subIssues: 0, title: 'Escalate by opening an issue' })
    expect(parseIssueRead('{}')).toBeNull()
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
      { name: '1', path: '/t/1', status: 'leased', branch: 'feat/issue-9-x', processes: [{ pid: 1, name: 'node' }] },
      { name: '2', path: '/t/2', status: 'available', branch: '', detached: true },
    ])
    expect(parsePool(json, 16)).toEqual({
      free: 15,
      total: 16,
      slots: [
        { path: '/t/1', branch: 'feat/issue-9-x', state: 'leased', dirty: null, busy: true },
        { path: '/t/2', branch: null, state: 'available', dirty: null, busy: false },
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
    expect(parseMilestone('== Next release\nExpected: minor - new modes\n#506 closed issue x\n#507 open issue y\n#512 closed pr z\n')).toEqual({
      open: 1,
      closed: 2,
      expected: 'minor',
    })
    expect(parseMilestone('== Next release\nExpected: (not set)\n')).toEqual({ open: 0, closed: 0, expected: null })
    expect(parseMilestone('')).toBeNull()
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

  // the lines are the watcher's own examples (features/test/callum-tools/pipeline-watch-once.test.sh),
  // with real run ids and SHAs
  test('pipeline-watch.sh --once: every state it prints, with its detail, step and PR', () => {
    const lines: [string, PipelineRun][] = [
      [`parked feat/issue-7-x ${RUN(7)} step=review pr=12 head=${SHA(7)}`, pl('parked', 'feat/issue-7-x', RUN(7), { step: 'review', pr: 12, head: SHA(7) })],
      [`failed feat/issue-8-f unknown step=unknown pr=77 head=${SHA(8)}`, pl('failed', 'feat/issue-8-f', 'unknown', { pr: 77, head: SHA(8) })],
      [`failed feat/issue-9-c ${RUN(9)} step=test head=${SHA(9)}`, pl('failed', 'feat/issue-9-c', RUN(9), { step: 'test', head: SHA(9) })],
      [`cancelled feat/issue-10-x ${RUN(10)} pr=14 head=${SHA(10)}`, pl('cancelled', 'feat/issue-10-x', RUN(10), { pr: 14, head: SHA(10) })],
      [`running feat/issue-11-r ${RUN(11)} head=${SHA(11)}`, pl('running', 'feat/issue-11-r', RUN(11), { head: SHA(11) })],
      [`pending feat/u unknown head=unknown`, pl('pending', 'feat/u', 'unknown', {})],
      [`merge-ready feat/issue-12-b ${RUN(12)} pr=12 head=${SHA(12)}`, pl('merge-ready', 'feat/issue-12-b', RUN(12), { pr: 12, head: SHA(12) })],
      [`conflict feat/issue-12-b ${RUN(12)} pr=12 head=${SHA(12)}`, pl('conflict', 'feat/issue-12-b', RUN(12), { pr: 12, head: SHA(12) })],
      [
        `head-mismatch feat/issue-13-y ${RUN(13)} run=${SHA(13)} branch=${SHA(14)} worktree=${SHA(15)} pr=13 head=${SHA(13)}`,
        pl('head-mismatch', 'feat/issue-13-y', RUN(13), { detail: `run=${SHA(13)} branch=${SHA(14)} worktree=${SHA(15)}`, pr: 13, head: SHA(13) }),
      ],
      [
        `head-mismatch feat/issue-13-y ${RUN(13)} run=unknown branch=unknown head=unknown`,
        pl('head-mismatch', 'feat/issue-13-y', RUN(13), { detail: 'run=unknown branch=unknown' }),
      ],
      [`ci-stalled feat/s ${RUN(16)} reason=no-workflow pr=16 head=${SHA(16)}`, pl('ci-stalled', 'feat/s', RUN(16), { detail: 'reason=no-workflow', pr: 16, head: SHA(16) })],
      [`ci-stalled feat/s ${RUN(16)} reason=no-checks head=${SHA(16)}`, pl('ci-stalled', 'feat/s', RUN(16), { detail: 'reason=no-checks', head: SHA(16) })],
    ]
    for (const [line, want] of lines) expect([line, parsePipelineLine(line)]).toEqual([line, want])
    // one poll: every line, blank lines ignored; nothing printed is no run in flight
    const poll = parsePipelineOnce(`${lines.map(([l]) => l).join('\n')}\n\n`)
    expect(poll).toEqual({ runs: lines.map(([, r]) => r), bad: [] })
    expect(parsePipelineOnce('')).toEqual({ runs: [], bad: [] })
  })

  test('pipeline-watch.sh --once: a line off the grammar is unreadable, never another state', () => {
    const run = RUN(7)
    const head = `head=${SHA(7)}`
    const bad = [
      'timeout',
      `stalled feat/x ${run} ${head}`,
      `parked feat/x RUNA step=review ${head}`,
      `running feat/x ${run} pr=3`,
      `running feat/x ${run} head=main`,
      `running  feat/x ${run} ${head}`,
      `running feat/x ${run} ${head} `,
      `running feat/x ${run} ${head}\r`,
      `parked feat/x ${run} pr=3 ${head}`,
      `parked feat/x ${run} pr=3 step=review ${head}`,
      `parked feat/x ${run} step= ${head}`,
      `running feat/x ${run} step=review ${head}`,
      `ci-stalled feat/x ${run} reason=slow ${head}`,
      `ci-stalled feat/x ${run} pr=3 ${head}`,
      `head-mismatch feat/x ${run} run=${SHA(1)} ${head}`,
      `head-mismatch feat/x ${run} run=${SHA(1)} branch=main ${head}`,
      `merge-ready feat/x ${run} reason=no-checks ${head}`,
      `merge-ready feat/x ${run} pr=0 ${head}`,
      `merge-ready feat/x ${run} pr=12a ${head}`,
      `merge-ready feat/x ${run} pr=3 extra=1 ${head}`,
      `merge-ready feat/x ${run} pr=3 pr=4 ${head}`,
    ]
    for (const line of bad) expect([line, parsePipelineLine(line)]).toEqual([line, null])
    const good = `running feat/issue-11-r ${run} ${head}`
    expect(parsePipelineOnce([good, bad[1], good].join('\n'))).toEqual({
      runs: [pl('running', 'feat/issue-11-r', run, { head: SHA(7) }), pl('running', 'feat/issue-11-r', run, { head: SHA(7) })],
      bad: [bad[1]],
    })
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
        ].join('\n'),
      ),
    )
    const facts = factsOf(events)
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

  test('the ledger a device proves: keyed as plan keys it', () => {
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
    const factory = parseFactoryState(factoryJson([fsIssue(60, 'designing', { entered_at: iso(NOW - 30 * MIN) })]), REPO)!
    const keys = deriveLedger(events, factory, factsOf(events), DEVICE).map(e => [e.key, e.status])
    expect(keys).toEqual([
      [`claim:60:derived:${NOW - 30 * MIN}`, 'done'],
      [`design:60:${NOW - 30 * MIN}`, 'running'],
      [`adjudicate:R45:park@${NOW - 25 * MIN}:h1`, 'done'],
      [`respond:R45:park@${NOW - 25 * MIN}:h1:fix`, 'done'],
      ['sweep:derived', 'done'],
      ['heartbeat:derived', 'done'],
      ['merge:550:m1', 'done'],
      // the merging device ran its follow-ups, so a rebuilt merge is never read again (M7)
      ['rollout:50', 'done'],
      ['rollout:51', 'done'],
    ])
  })
})

describe('state', () => {
  test('a gate the live orchestrator already answered is not adjudicated again', () => {
    const events: FactoryEvent[] = [
      ev({ state: 'renewed', issue: 45, run: null, branch: null, actor: 'agent', ts: NOW - 2 * MIN }),
      ev({ state: 'closed', issue: 3, run: null, branch: null, actor: 'sweep', ts: NOW - 2 * MIN }),
      ev({ state: 'parked', ts: NOW - 6 * MIN }),
      ev({ state: 'verdict', note: 'NIT: fine', actor: 'agent', ts: NOW - 5 * MIN }),
    ]
    const factory = parseFactoryState(factoryJson([fsIssue(45, 'parked', { run: 'R45', pr: 545 })]), REPO)!
    const facts = factsOf(events)
    const base = state()
    const observed = {
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
      ledger: deriveLedger(events, factory, facts, DEVICE),
      control: control(),
      lastTitle: null,
      githubBackoffUntil: null,
      trackerTitle: config().trackerTitle,
    }
    const s = buildState(observed)
    expect(s.runs.map(r => [r.issue, r.state, r.run])).toEqual([[45, 'parked', 'R45']])
    // answered at the same head: the respond is done, so nothing new is planned yet
    expect(plan(s, config()).actions.filter(a => a.kind !== 'title').map(a => a.key)).toEqual([])
    // a park the log shows no answer for is adjudicated
    const fresh = buildState({ ...observed, ledger: [] })
    expect(plan(fresh, config()).actions.map(a => a.key)).toContain(`adjudicate:R45:park@${NOW - 6 * MIN}:h1`)
    // parked again on the same head, at the next gate: a new gate to adjudicate (2026-10-12, #506)
    const again = [...events, ev({ state: 'parked', ts: NOW - MIN })]
    const facts2 = factsOf(again)
    const second = buildState({ ...observed, facts: facts2, ledger: deriveLedger(again, factory, facts2, DEVICE) })
    expect(plan(second, config()).actions.map(a => a.key)).toContain(`adjudicate:R45:park@${NOW - MIN}:h1`)
  })
})

describe('config (SPEC 4.2)', () => {
  test('durations: ms, s, m, h and d; anything else is not one', () => {
    expect([parseDuration('500ms'), parseDuration('60s'), parseDuration('5m'), parseDuration('2h'), parseDuration('1d'), parseDuration('1.5h')]).toEqual([
      500, 60_000, 300_000, 7_200_000, 86_400_000, 5_400_000,
    ])
    expect([parseDuration('5'), parseDuration('5x'), parseDuration('m5'), parseDuration('')]).toEqual([null, null, null, null])
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
      maxAttempts: { claim: 5, respond: 0, bogus: 1 },
      skipLabels: ['parked'],
      trackerTitle: '(',
      colour: 'blue',
    })
    expect(c.readyLabel).toBe('Go')
    expect(c.maxInFlightIssues).toBe(4)
    expect(c.rateCaps).toEqual({ start: 10, spawn: 120, wake: 20, perIssueKind: 6 })
    expect(c.maxAttempts.claim).toBe(5)
    expect(c.maxAttempts.respond).toBe(2)
    expect(c.skipLabels).toEqual(['parked'])
    expect([c.passEveryMs, c.sweepEveryMs, c.trackerTitle]).toEqual([DEFAULT_CONFIG.passEveryMs, DEFAULT_CONFIG.sweepEveryMs, DEFAULT_CONFIG.trackerTitle])
    expect(problems).toEqual([
      'passEveryMs: "60s" is not a number of milliseconds',
      'sweepEvery: "soon" is not a duration (like 60s, 5m, 2h)',
      'rateCaps.merge: unknown (merges are never capped)',
      'maxAttempts.respond: 0 is not a whole number of at least 1',
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
    for (const channel of ['script', 'tool', 'text'] as const) expect(loadConfig({ answerChannel: channel })).toEqual({ config: { ...DEFAULT_CONFIG, answerChannel: channel }, problems: [] })
    expect(loadConfig({ answerChannel: 'tool' }, { answerChannel: 'text' }).config.answerChannel).toBe('text')
    expect(loadConfig({ answerChannel: 'tools' })).toMatchObject({ config: { answerChannel: 'script' }, problems: ['answerChannel: "tools" is not script, tool or text'] })
    expect(loadConfig({ answerChannel: true }).problems).toEqual(['answerChannel: true is not script, tool or text'])
  })

  test("answerTools, #560's switch, is replaced by answerChannel: named as replaced, and read as nothing (#561)", () => {
    for (const value of [true, false, 'on']) {
      expect(loadConfig({ answerTools: value })).toEqual({ config: DEFAULT_CONFIG, problems: ['answerTools: replaced by answerChannel (script, tool or text), and ignored'] })
    }
    expect('answerTools' in DEFAULT_CONFIG).toBe(false)
  })

  test('the defaults the owner set on 2026-10-13', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      inDevLabel: 'in development',
      maxInFlightIssues: 5,
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

describe('control (SPEC 4.3)', () => {
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

describe('the loop event (SPEC 7.4, 7.5, D-09)', () => {
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
  // every outcome kind plan reads, with free text already empty so the round trip is exact
  const outcomes: [string, LedgerEntry][] = [
    ['cli', entry('release-parent:60', 'release-parent', { outcome: { kind: 'cli', exit: 1 } })],
    ['claim', entry('claim:7:new', 'claim', { class: 'start', issue: 7, outcome: { kind: 'claim', result: 'lost' } })],
    ['designer', entry('design:60:5', 'spawn', { agent: 'designer', class: 'develop', issue: 60, agentId: 'a1', outcome: { kind: 'designer', brief: 'https://github.com/cbundy/dev-system/issues/60#issuecomment-1060', created: [61, 62], pendingDecision: true } })],
    ['designer unparsed', entry('design:61:5', 'spawn', { agent: 'designer', class: 'develop', issue: 61, outcome: { kind: 'designer', unparsed: true } })],
    ['adjudicator hold', entry('adjudicate-merge:550:head50', 'spawn', { ...base, agent: 'adjudicator', class: 'drive', outcome: review({ type: 'hold', reason: '' }, { summary: '', bumpReason: '', bump: 'major', flags: ['image', 'run-it'] }) })],
    ['adjudicator gate', entry('adjudicate:R:review:h', 'spawn', { ...base, agent: 'adjudicator', class: 'drive', outcome: review({ type: 'fix', findings: null, instructions: null, addFinding: null }) })],
    ['handoff', entry('delegate:63:u', 'delegate', { class: 'develop', issue: 63, agent: 'implementer', outcome: { kind: 'handoff', notGated: true, run: 'R63', head: 'h63', newBranch: 'feat/issue-63-x-v2' } })],
    ['update-behind', entry('update-behind:550:head50', 'update-behind', { ...base, outcome: { kind: 'update-behind', result: 'updated', from: 'head50', to: 'head51', line: '' } })],
    ['merge', entry('merge:550:head50', 'merge', { ...base, outcome: { kind: 'merge', result: 'merged', rollout: 'run-it', closeIssue: null, line: '' } })],
    ['rollout', entry('rollout:70', 'rollout', { issue: 70, pr: 570, outcome: { kind: 'rollout', rollout: 'merge', closeIssue: 70 } })],
    ['wake sequence', entry('judge:sequence:550:head50', 'judge', { ...base, class: 'drive', wake: 'sequence', outcome: wakeAnswer('hold') })],
    ['wake report', entry('judge:report:design:61:5', 'judge', { class: 'drive', issue: 61, wake: 'report', outcome: wakeAnswer('parsed', { fields: { brief: null, created: [], pendingDecision: false } }) })],
    ['running wake', entry('tell:decision:60:u', 'tell', { class: 'owner', issue: 60, wake: 'decision', status: 'running', endedAt: null })],
  ]

  test('every outcome kind plan reads comes back exactly from its note', () => {
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
    const verdicts = entry('adjudicate:R:x:h', 'spawn', { agent: 'adjudicator', class: 'drive', outcome: review({ type: 'escalate', why: long }, null, [long]) })
    expect(entryFromLoop(logged(verdicts))?.outcome).toEqual(review({ type: 'escalate', why: '' }))
    // spaces and percent signs in a value are encoded, so a key survives intact
    const odd = entry('judge:report:brief:60:https://x/a b%20', 'judge', { wake: 'report' })
    expect(entryFromLoop(logged(odd))?.key).toBe('judge:report:brief:60:https://x/a b%20')
    // a guard re-runs after a lost store (M1), so its loop event rebuilds nothing
    expect(entryFromLoop(logged(entry('guard:550:h:1', 'guard', { outcome: { kind: 'guard', fails: [], warns: [] } })))).toBeNull()
    // a note too long for a row keeps the entry, without its outcome
    const huge = entry(`delegate:9:${'x'.repeat(450)}`, 'delegate', { outcome: { kind: 'handoff', notGated: false, run: 'R'.repeat(40), head: 'h'.repeat(40), newBranch: null } })
    expect(loopNote(huge)).not.toContain('out=')
    expect(entryFromLoop(logged(huge))?.outcome).toBeUndefined()
    expect(entryFromLoop({ ...logged(held), note: 'kind=nope key=x status=done attempts=1 class=free started=1' })).toBeNull()
    expect(entryFromLoop({ ...logged(held), state: 'verdict' })).toBeNull()
  })

  test('the arguments that log an entry put its subject in the columns', () => {
    const e = outcomes[8]![1]
    expect(loopEventArgs(e)).toEqual(['loop', '--issue', '50', '--run', '01M4RQ0050AAAA', '--pr', '550', '--head', 'head50', '--note', loopNote(e)])
    expect(loopEventArgs(entry('tell:blind:0', 'tell', { wake: 'blind' }))).toEqual(['loop', '--note', loopNote(entry('tell:blind:0', 'tell', { wake: 'blind' }))])
  })

  test('a lost store is rebuilt from the loop events, the latest per key winning over the rest', () => {
    const factory = parseFactoryState(factoryJson([fsIssue(60, 'designing', { entered_at: iso(NOW - 30 * MIN) })]), REPO)!
    const designing = entry(`design:60:${NOW - 30 * MIN}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'running', startedAt: NOW - 30 * MIN, endedAt: null, agentId: 'a1' })
    const decided: LedgerEntry = {
      ...designing,
      status: 'done',
      endedAt: NOW - 5 * MIN,
      outcome: { kind: 'designer', brief: 'https://github.com/cbundy/dev-system/issues/60#issuecomment-9', created: [], pendingDecision: true },
    }
    const other = { ...logged(decided, NOW - 5 * MIN), device: 'someone-else' }
    const events = [logged(designing, NOW - 30 * MIN), logged(decided, NOW - 5 * MIN), other]
    const ledger = deriveLedger(events, factory, factsOf(events), DEVICE)
    // the designer's pending decision, not the in-flight designer the stage alone suggests
    expect(ledger.filter(e => e.key === designing.key)).toEqual([decided])
    const s = buildState({ ...observedFrom(factory, events), ledger })
    const brief = (decided.outcome as Extract<Outcome, { kind: 'designer'; brief: string | null }>).brief
    expect(plan(s, config()).actions.map(a => a.key)).toContain(`tell:decision:60:${brief}`)
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

describe('observe for act mode (SPEC 3.3, 3.4, 7.5, 10.2)', () => {
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
    pipeline: Reply
    queue: Reply
    issues: Record<string, Reply>
    files: Record<string, string>
    // the main checkout: origin's default branch, and its status
    originHead: Reply
    status: Reply
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
      ...over,
    }
    let now = NOW
    const calls: Call[] = []
    const answer = (argv: string[]): Reply => {
      const [cmd, ...args] = argv
      switch (cmd) {
        case 'callum-flow-factory-state':
          return { stdout: factoryJson(world.factory) }
        case 'dev-query':
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
          return { stdout: '[]' }
        case 'git':
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
        const r = answer(argv)
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
      return observe(io, rt, cache, NOW - 60 * MIN, null, stored)
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
    expect(h.commands()).toContain(`${TOOLS}/pipeline-watch.sh --once`)
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

  test("runSource local: the watcher's runs, with the event log's review rounds, verdicts and supersessions", async () => {
    const h = host()
    const obs = await h.pass(runtime(), stored())
    expect(obs.state.sources.runs).toEqual({ ok: true, at: NOW })
    expect(obs.state.runs).toEqual([
      // not an issue branch: kept, since a restart waits for every run (rule H4)
      { branch: 'chore/docs', issue: null, run: 'unknown', state: 'pending', head: null, step: null, detail: null, pr: null, since: NOW, reviewFixRounds: 0, verdicts: [], superseded: false },
      { ...run(44, 'running'), branch: 'feat/issue-44-old', run: R44, head: SHA(44), step: null, pr: 544, since: NOW, superseded: true },
      { ...run(45, 'parked'), branch: BR45, run: R45, head: SHA(45), step: 'review', pr: 545, since: NOW, reviewFixRounds: 1, verdicts: ['CORRECT: review-1 x'] },
    ])
    // plan drives the parked gate of the run the watcher sees
    expect(plan(obs.state, config()).actions.map(a => a.key)).toContain(`adjudicate:${R45}:review:${SHA(45)}`)

    // runSource events (the shadow) still reads the runs from the log, and runs no watcher
    const s = host()
    const shadow = await s.pass(runtime({ mode: 'observe', runSource: 'events' }))
    expect(s.commands().some(c => c.includes('pipeline-watch'))).toBe(false)
    expect(shadow.state.sources.runs.ok).toBe(true)
  })

  test("a run's since holds across passes until its state, head or step moves", async () => {
    // no step known: the gate is told apart by when the park was first seen (plan's gateOf)
    const parked = (head: string, step = 'unknown') => ({ stdout: `parked ${BR45} ${R45} step=${step} pr=545 head=${head}\n` })
    const h = host({ pipeline: parked(SHA(1)) })
    const rt = runtime()
    const keyOf = (obs: Observation) => plan(obs.state, config()).actions.map(a => a.key).find(k => k.startsWith('adjudicate:'))
    const first = await h.pass(rt, stored(), NOW)
    expect(first.state.runs.find(r => r.issue === 45)?.since).toBe(NOW)
    expect(keyOf(first)).toBe(`adjudicate:${R45}:park@${NOW}:${SHA(1)}`)
    const again = await h.pass(rt, stored(), NOW + MIN)
    expect(again.state.runs.find(r => r.issue === 45)?.since).toBe(NOW)
    expect(keyOf(again)).toBe(keyOf(first))

    // a failed poll keeps the runs it last saw, with their age
    h.world.pipeline = { exitCode: 1, stderr: 'pipeline-watch.sh: no-mistakes runs failed\n' }
    const failed = await h.pass(rt, stored(), NOW + 2 * MIN)
    expect(failed.state.sources.runs).toEqual({ ok: false, at: NOW + MIN, error: 'exit 1: pipeline-watch.sh: no-mistakes runs failed' })
    expect(failed.state.runs).toEqual(again.state.runs)

    // answered and parked again on the same head: a new gate, seen anew
    h.world.pipeline = { stdout: `running ${BR45} ${R45} pr=545 head=${SHA(1)}\n` }
    expect((await h.pass(rt, stored(), NOW + 3 * MIN)).state.runs.find(r => r.issue === 45)?.state).toBe('running')
    h.world.pipeline = parked(SHA(1))
    const next = await h.pass(rt, stored(), NOW + 4 * MIN)
    expect(next.state.runs.find(r => r.issue === 45)?.since).toBe(NOW + 4 * MIN)
    // a new head or a new step is a new sight too
    h.world.pipeline = parked(SHA(2))
    expect((await h.pass(rt, stored(), NOW + 5 * MIN)).state.runs.find(r => r.issue === 45)?.since).toBe(NOW + 5 * MIN)
    h.world.pipeline = parked(SHA(2), 'test')
    expect((await h.pass(rt, stored(), NOW + 6 * MIN)).state.runs.find(r => r.issue === 45)?.since).toBe(NOW + 6 * MIN)

    // the pure pieces: a branch gone from the poll is dropped, so its return starts over
    const line = pl('parked', BR45, R45, { head: SHA(2), step: 'review' })
    expect(seenRuns(seenRuns([], [line], NOW), [], NOW + MIN)).toEqual([])
    expect(seenRuns([{ ...line, since: NOW }], [line], NOW + MIN)).toEqual([{ ...line, since: NOW }])
    expect(runsFromWatch([{ ...line, run: 'unknown', since: NOW }], null)[0]).toMatchObject({ issue: 45, reviewFixRounds: 0, superseded: false })
  })

  test('an unreadable watcher line or a failed poll is a failed runs source, never no runs', async () => {
    const h = host({ pipeline: { stdout: `${LINES}\ntimeout\n` } })
    const obs = await h.pass(runtime(), stored())
    expect(obs.state.sources.runs).toEqual({ ok: false, at: null, error: 'unreadable line: timeout' })
    expect(obs.state.runs).toEqual([])
    // plan leaves the P and M rules alone while the runs are unknown
    expect(plan(obs.state, config()).skipped).toContainEqual({ rule: 'P', issue: null, why: 'runs source unavailable' })
    h.world.pipeline = { exitCode: 127, stderr: 'sh: pipeline-watch.sh: not found' }
    expect((await h.pass(runtime(), stored(), NOW + MIN)).state.sources.runs).toEqual({ ok: false, at: null, error: 'exit 127: sh: pipeline-watch.sh: not found' })
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
    expect(h.commands().filter(c => c.startsWith('dev-query')).map(c => c.match(/days=\d+/)?.[0])).toEqual(['days=3'])

    const o = host()
    const shadow = await o.pass(runtime({ mode: 'observe' }))
    expect(shadow.ledgerSource).toBe('events')
    expect(shadow.state.ledger.map(e => e.key)).toEqual(['heartbeat:derived', 'sweep:derived'])
    expect(o.commands().filter(c => c.startsWith('dev-query')).map(c => c.match(/days=\d+/)?.[0])).toEqual(['days=3'])
  })

  test('a lost store is rebuilt from 7 days of events, once: holds older than the facts window survive', async () => {
    // a pending decision five days old: outside the 3-day facts window, inside the week
    const life = NOW - 5 * DAY
    const decided = entry(`design:60:${life}`, 'spawn', {
      agent: 'designer',
      class: 'develop',
      issue: 60,
      agentId: 'a60',
      startedAt: life,
      endedAt: life + 60 * MIN,
      outcome: { kind: 'designer', brief: 'https://github.com/cbundy/dev-system/issues/60#issuecomment-60', created: [], pendingDecision: true },
    })
    const loop = ev({ state: 'loop', issue: 60, run: null, branch: null, head: null, note: loopNote(decided), actor: 'agent', ts: life + 60 * MIN })
    const factory = [fsIssue(60, 'designing', { entered_at: iso(life) })]
    const h = host({ factory, week: [loop, ...RECENT] })
    const obs = await h.pass(runtime(), stored({ ledger: null }))
    expect(obs.ledgerSource).toBe('events')
    expect(h.calls.filter(c => c.argv[0] === 'dev-query').map(c => [c.argv.find(a => a.startsWith('days=')), c.stdin === EVENTS_SQL])).toEqual([
      ['days=3', true],
      ['days=7', true],
    ])
    expect(obs.state.ledger.find(e => e.key === decided.key)).toEqual(decided)
    // so the owner's decision is still awaited, and no second designer starts
    const planned = plan(obs.state, config()).actions.map(a => a.key)
    expect(planned).toContain('tell:decision:60:https://github.com/cbundy/dev-system/issues/60#issuecomment-60')
    expect(planned.filter(k => k.startsWith('design:'))).toEqual([])
    // the 3-day window alone would have lost it: the stage's in-flight designer is all it shows
    const shadow = await host({ factory, week: [loop, ...RECENT] }).pass(runtime({ mode: 'observe' }))
    expect(shadow.state.ledger.find(e => e.key === decided.key)?.status).toBe('running')

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
    // plan will not count review rounds it cannot see
    expect(plan(failed.state, config()).skipped).toContainEqual({ rule: 'P2', issue: 45, why: 'event log unavailable: review rounds cannot be counted' })
    down.world.week = []
    await down.pass(runtime(), stored({ ledger: null }), NOW + MIN)
    expect(down.commands().filter(c => c.includes('days=7'))).toHaveLength(1)
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
    expect(plan(held.state, config()).title).toContain('gh wait')
    // the other sources still run
    expect(h.commands()).toContain(`${TOOLS}/pipeline-watch.sh --once`)

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
    // 45, this device's, is read first (#556); 114 hits the limit; 470 is not tried
    expect(h.commands().filter(c => c.startsWith('callum-flow-issue-read'))).toEqual(['callum-flow-issue-read --json 45', 'callum-flow-issue-read --json 114'])
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
    expect(plan(first.state, config()).actions.map(a => a.key)).toContain(`design:60:${NOW - 30 * MIN}`)

    // an agent checks out another issue's branch: the next pass sees it, tells, and holds the designer
    h.world.status = { stdout: `# branch.oid ${SHA(4)}\n# branch.head (detached)\n` }
    const moved = await h.pass(runtime(), stored(), NOW + MIN)
    expect(moved.state.checkout).toMatchObject({ branch: null, head: SHA(4) })
    const r = plan(moved.state, config())
    expect(r.actions.map(a => a.key)).toContain(`tell:checkout:detached@${SHA(4)}`)
    expect(r.actions.filter(a => a.kind === 'spawn')).toEqual([])
    expect(r.title).toContain('checkout')

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
  const issueReads = (h: ReturnType<typeof host>) =>
    h.commands().flatMap(c => (c.startsWith('callum-flow-issue-read --json ') && !c.includes('--list') ? [c.slice('callum-flow-issue-read --json '.length)] : []))

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
    // the ledger rebuilt from run 2's events: 40's adjudication asked for a fixer
    const adjudicated = entry(`adjudicate:${R40}:review:${SHA(40)}`, 'spawn', {
      agent: 'adjudicator',
      class: 'drive',
      issue: 40,
      run: R40,
      head: SHA(40),
      outcome: review({ type: 'fixer', instructions: 'add the missing test' }),
    })
    const kept = stored({ ledger: [...(stored().ledger ?? []), adjudicated], queueKnown: null })
    const first = await h.pass(runtime(), kept)
    // the twelve reads of the pass: this device's issues, the other live one, then the queue
    expect(issueReads(h)).toEqual(['40', '41', '32', ...queue.slice(0, 9).map(String)])
    expect(first.state.issues.filter(i => i.open === false).map(i => i.number)).toEqual([32, 40, 41])
    const r = plan(first.state, config())
    expect(r.actions.filter(a => a.kind === 'spawn').map(a => a.key)).toEqual([])
    expect(r.title).toContain('(Q:12 - D:0 - M:0)')

    // a closed issue is not read again, unless this device holds it: 40 and 41 are read again
    // with the oldest reads, after the rest of the queue; 32, another device's, is not
    h.world.issues['--json 40'] = { stdout: ISSUE(40) }
    const second = await h.pass(runtime(), kept, NOW + 6 * MIN)
    expect(issueReads(h)).toEqual(['69', '70', '71', '40', '41', ...queue.slice(0, 7).map(String)])
    // 40 was reopened: held and open, it is driven again (its lease renewed with it, rule H1)
    expect(second.state.issues.find(i => i.number === 40)?.open).toBe(true)
    expect(plan(second.state, config()).actions.filter(a => a.kind === 'spawn' && a.issue === 40).map(a => a.rule)).toEqual(['P3'])
  })

  test('an issue with a running agent of the loop is read too; a failed read keeps the last state; a closed issue back in the queue is read again (#556)', async () => {
    const fixer = entry('fixer:gate:x', 'spawn', { agent: 'fixer', class: 'drive', issue: 77, status: 'running', agentId: 'a77', startedAt: NOW - 5 * MIN, endedAt: null })
    const kept = stored({ ledger: [...(stored().ledger ?? []), fixer] })
    const h = host({ issues: { '--json 77': CLOSED(77) } })
    const first = await h.pass(runtime(), kept)
    expect(issueReads(h)).toEqual(['77', '45', '114', '470'])
    // the factory never saw 77, but its agent is the loop's: stopped, with the reason
    expect(plan(first.state, config()).actions.find(a => a.key === 'stop:a77')).toMatchObject({ rule: 'A2', reason: 'issue closed' })

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
    const spawned = entry(`adjudicate:${R45}:review:${SHA(45)}`, 'spawn', { agent: 'adjudicator', class: 'drive', status: 'running', endedAt: null, agentId: 'a1' })
    const io: Io = {
      now: async () => NOW,
      run: async argv => (argv[0] === 'callum-flow-factory-state' ? { exitCode: 0, stdout: factoryJson([]), stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }),
      readFile: async () => null,
      sessionLimits: async () => [],
      agents: async () => agents,
    }
    const obs = await observe(io, runtime(), emptyCache(), NOW, null, stored({ ledger: [spawned] }))
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
    githubBackoffUntil: null,
    trackerTitle: config().trackerTitle,
  }
}
