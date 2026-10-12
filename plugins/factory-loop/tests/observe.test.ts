// The observe half's pure pieces against canned command output: the parsers (parse.ts), the
// event derivation (derive.ts) and the state assembly (state.ts). Shapes are copied from real
// output of callum-flow-factory-state, callum-flow-issue-read, usage-check.sh, treehouse,
// callum-flow-milestone and dev-query on 2026-10-12.
import { describe, expect, test } from 'claude-code/testing'

import { deriveLedger, eventsFromRows, factsOf, runsFromEvents } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import {
  parseBrief,
  parseCsv,
  parseFactoryState,
  parseIssueRead,
  parseMilestone,
  parsePool,
  parseQueue,
  parseUsage,
} from '../hooks/parse'
import { plan } from '../hooks/plan'
import { buildState } from '../hooks/state'
import { DEVICE, NOW, MIN, config, control, state } from './fixtures'

const REPO = 'cbundy/dev-system'
const iso = (ms: number) => new Date(ms).toISOString()

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

  test('milestone: counts and Expected; nothing printed means not opted in', () => {
    expect(parseMilestone('== Next release\nExpected: minor - new modes\n#506 closed issue x\n#507 open issue y\n#512 closed pr z\n')).toEqual({
      open: 1,
      closed: 2,
      expected: 'minor',
    })
    expect(parseMilestone('== Next release\nExpected: (not set)\n')).toEqual({ open: 0, closed: 0, expected: null })
    expect(parseMilestone('')).toBeNull()
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
    ]
    const factory = parseFactoryState(factoryJson([fsIssue(60, 'designing', { entered_at: iso(NOW - 30 * MIN) })]), REPO)!
    const keys = deriveLedger(events, factory, factsOf(events), DEVICE).map(e => [e.key, e.status])
    expect(keys).toEqual([
      [`claim:60:derived:${NOW - 30 * MIN}`, 'done'],
      [`design:60:${NOW - 30 * MIN}`, 'running'],
      ['adjudicate:R45:null:h1', 'done'],
      ['respond:R45:null:h1:fix', 'done'],
      ['sweep:derived', 'done'],
      ['heartbeat:derived', 'done'],
      ['merge:550:m1', 'done'],
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
    expect(plan(fresh, config()).actions.map(a => a.key)).toContain('adjudicate:R45:null:h1')
  })
})
