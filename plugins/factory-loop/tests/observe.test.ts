// The observe half's pure pieces against canned command output: the parsers (parse.ts), the
// event derivation (derive.ts) and the state assembly (state.ts). Shapes are copied from real
// output of callum-flow-factory-state, callum-flow-issue-read, usage-check.sh, treehouse,
// callum-flow-milestone and dev-query on 2026-10-12.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, EMPTY_CONTROL, controlFrom, loadConfig, parseDuration } from '../hooks/config'
import { LOOP_NOTE_MAX, deriveLedger, entryFromLoop, eventsFromRows, factsOf, loopEventArgs, loopNote, runsFromEvents } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import {
  parseBrief,
  parseCsv,
  parseFactoryState,
  parseIssueRead,
  parseMilestone,
  parsePool,
  parseQueue,
  parseSubIssues,
  parseUsage,
} from '../hooks/parse'
import { plan } from '../hooks/plan'
import { buildState, subIssuesOf } from '../hooks/state'
import type { Observed } from '../hooks/state'
import type { LedgerEntry, Outcome } from '../hooks/types'
import { DEVICE, NOW, MIN, config, control, entry, review, state, wakeAnswer } from './fixtures'

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
    expect(c.rateCaps).toEqual({ start: 10, spawn: 40, wake: 20, perIssueKind: 6 })
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

  test('the defaults the owner set on 2026-10-13', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      inDevLabel: 'in development',
      maxInFlightIssues: 10,
      rateCaps: { start: 30, spawn: 40, wake: 20, perIssueKind: 6 },
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
