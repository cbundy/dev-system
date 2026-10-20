// The flake row (docs/factory-loop/v2/SPEC.md 8.5): the log parser, and the rule that writes the
// second `ci-rerun` intervention once the re-run's run has settled.
import { describe, expect, mock, test } from 'claude-code/testing'

import { GITHUB_V2, newCtx } from '../hooks/foundation'
import * as ARGV from '../hooks/v2/argv'
import type { Action, LedgerEntry, State } from '../hooks/types'
import { eventNote, onceKey, parseIntervention } from '../hooks/v2/events'
import type { InterventionEvent } from '../hooks/v2/events'
import { logFailedNames } from '../hooks/v2/flake-names'
import { lifeOf, prKey, rerunKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State, recordsToStore } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { flakeRules } from '../hooks/v2/rules-flakes'
import type { CheckRun, PrView } from '../hooks/v2/sources-prs'
import { madeRecord } from '../hooks/v2/table'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { IssueRecord, V2Ctx, V2State } from '../hooks/v2/types'
import { handshakePath } from '../hooks/v2/workspace'
import { DEVICE, MIN, NOW, config, control, entry, state } from './fixtures'
import { CFG_DIR, ENGINE_TEST, NO_EVENTS, PROCESS, QUIET_BEATS, REPO, SESSION, TOOLS, factoryDoc, host, iso } from './host'
import type { Seen } from './host'

const N = 571
const LIFE = (Math.floor(NOW / 1000) - 3 * 3600).toString(36)
const HEAD = 'a'.repeat(40)
const RUN = '18342299123'
const TS = '2026-10-19T08:00:00.1234567Z'
const row = (job: string, text: string) => `${job}\tnpm test\t${TS} ${text}`

describe('logFailedNames', () => {
  test('jobs by first column; tests from FAIL, isolation and (fail) lines; the wrapper line is dropped', () => {
    const log = [
      row('ci', '\u001b[31mFAIL tests/cli.test.js\u001b[0m'),
      row('ci', '  at /x/y.js:1'),
      row('ci', 'FAIL plugins/a (claude plugin validate / test)'),
      row('ci', 'FAIL test isolation: 2 leftovers'),
      row('lint', '   (fail) the thing > does it [3ms]'),
      row('lint', 'FAIL tests/cli.test.js'),
      row('lint', 'FAIL a,b'),
    ].join('\n')
    expect(logFailedNames(log)).toEqual({ failedJobs: ['ci', 'lint'], failedTests: ['tests/cli.test.js', 'test isolation: 2 leftovers', 'the thing > does it [3ms]', 'a,b'] })
  })

  test('at most 20 names, each cut to 200 characters; empty output gives null', () => {
    const many = Array.from({ length: 30 }, (_, i) => row('ci', `FAIL t${i}`)).join('\n')
    expect(logFailedNames(many).failedTests).toHaveLength(20)
    expect(logFailedNames(row('ci', `FAIL ${'x'.repeat(300)}`)).failedTests?.[0]).toHaveLength(200)
    expect(logFailedNames('')).toEqual({ failedJobs: null, failedTests: null })
    expect(logFailedNames('no tabs here\n')).toEqual({ failedJobs: null, failedTests: null })
  })
})

function record(): IssueRecord {
  return {
    issue: N, life: LIFE, seq: 5, seqAt: NOW - 30 * MIN, state: 'reviewing', since: NOW - 30 * MIN, resumeTo: null, branch: `issue-${N}`, pr: 621, head: HEAD, approvedPatch: null, brief: null,
    step: 'review', attempt: 1, cut: false, triages: 0, fixes: 0, round: 1, question: null, parts: null, why: null, notes: [], prClosedAt: null, wait: null, lives: 1,
  }
}

const check = (name: string, bucket: CheckRun['bucket'], completedAt: number | null, runId: string | null = RUN): CheckRun => ({ name, state: bucket, bucket, startedAt: NOW - 20 * MIN, completedAt, runId, link: null })
const view = (checks: CheckRun[], head = HEAD): PrView => ({ pr: 621, issue: N, state: 'open', head, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: null, baseRef: 'main', checks, patch: null, readAt: NOW })
const START = NOW - 10 * MIN
const BEFORE = START - 5 * MIN
const AFTER = START + 3 * MIN

function rerun(over: Partial<LedgerEntry> = {}, life = LIFE, id = RUN): LedgerEntry {
  return entry(rerunKey({ issue: N, life }, 1, id), 'ci-rerun', {
    issue: N,
    startedAt: START,
    endedAt: START + 1000,
    outcome: { kind: 'cli', exit: 0, failedJobs: ['ci'], failedTests: ['tests/a.test.js'] },
    ...over,
  })
}

function stateOf(ledger: LedgerEntry[], prs: PrView[], logged: string[] = []): State {
  const s = state({ control: control() })
  const v2: V2State = { ...emptyV2State(NOW, [record()]), prs: { prs }, logged }
  return { ...s, ledger: [...s.ledger, ...ledger], v2 }
}

function flakes(ledger: LedgerEntry[], prs: PrView[], logged: string[] = []): Extract<Action, { kind: 'event' }>[] {
  const s = stateOf(ledger, prs, logged)
  const ctx: V2Ctx = Object.assign(newCtx(s, config({ mode: 'act' }), { tier: 'normal', overridden: false }, V2_OWNER_TELLS, GITHUB_V2), { v2: s.v2 as V2State })
  flakeRules(ctx)
  return ctx.out.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event')
}

describe('flakeRules', () => {
  test('a re-run that passed: flaky, with head, jobs and tests; an untouched pass check keeps its old time', () => {
    const [a] = flakes([rerun()], [view([check('ci / test', 'pass', AFTER), check('lint', 'pass', BEFORE), check('docs', 'skipping', null)])])
    expect(a?.key).toBe(`iv/${rerunKey({ issue: N, life: LIFE }, 1, RUN)}/flake`)
    expect(a?.event).toMatchObject({ state: 'intervention', who: 'loop', cause: 'ci-rerun', issue: N, life: LIFE, pr: 621, flaky: true, head: HEAD, failed_jobs: ['ci'], failed_tests: ['tests/a.test.js'], reason: `ci flake: run ${RUN} passed on its re-run on ${HEAD.slice(0, 7)}` })
  })

  test('a check that failed again since the start: not a flake', () => {
    const [a] = flakes([rerun()], [view([check('ci / test', 'fail', AFTER), check('lint', 'pass', BEFORE)])])
    expect(a?.event).toMatchObject({ flaky: false, reason: `not a flake: ci / test failed again after the re-run on ${HEAD.slice(0, 7)}` })
  })

  test('nothing yet while a check is pending, or a failed check still shows its result from before the re-run', () => {
    expect(flakes([rerun()], [view([check('a', 'pass', AFTER), check('b', 'pending', null)])])).toEqual([])
    expect(flakes([rerun()], [view([check('a', 'pass', AFTER), check('b', 'fail', BEFORE)])])).toEqual([])
    expect(flakes([rerun()], [view([check('a', 'fail', BEFORE)])])).toEqual([])
  })

  test('names are null when the outcome carries none', () => {
    const [a] = flakes([rerun({ outcome: { kind: 'cli', exit: 0 } })], [view([check('a', 'pass', AFTER)])])
    expect(a?.event).toMatchObject({ failed_jobs: null, failed_tests: null })
  })

  test('no entry, a refused or lost entry, another life\'s entry, another run, or a new head without the run: nothing', () => {
    const v = [view([check('a', 'pass', AFTER)])]
    expect(flakes([], v)).toEqual([])
    expect(flakes([rerun({ status: 'failed' })], v)).toEqual([])
    expect(flakes([rerun({ status: 'lost' })], v)).toEqual([])
    expect(flakes([rerun({}, 'zzzz')], v)).toEqual([])
    expect(flakes([rerun({}, LIFE, '777')], v)).toEqual([])
    expect(flakes([rerun()], [view([check('a', 'pass', AFTER, '999')], 'b'.repeat(40))])).toEqual([])
  })

  test('once: an event the log already holds is marked logged, and a done ledger entry plans nothing', () => {
    const v = [view([check('a', 'pass', AFTER)])]
    const [first] = flakes([rerun()], v)
    const key = onceKey({ state: 'intervention', ...cols(first?.event as InterventionEvent), note: eventNote(first?.event as InterventionEvent) })
    expect(flakes([rerun()], v, [key as string])[0]).toMatchObject({ logged: true })
    const planned = planV2(stateOf([rerun(), entry(first?.key as string, 'event', { issue: N })], v), config({ mode: 'act' })).actions
    expect(planned.filter(a => a.key.endsWith('/flake'))).toEqual([])
  })
})

const cols = (e: InterventionEvent) => ({ ts: '', issue: e.issue, run_id: null, branch: null, pr: e.pr, head: null, actor: null, device: null })

describe('the flake row in events.ts', () => {
  const base: InterventionEvent = { state: 'intervention', who: 'loop', cause: 'ci-rerun', reason: 'ci flake', issue: N, life: LIFE, pr: 621, fact: 'i571/l1/rerun/r1/9' }

  test('a flake row reads back equal; the first row\'s note is unchanged', () => {
    const flake: InterventionEvent = { ...base, flaky: true, head: HEAD, failed_jobs: ['ci'], failed_tests: ['a,b', 'c'] }
    const note = eventNote(flake)
    expect(note).toContain('flaky=yes failed_tests=a%2Cb,c failed_jobs=ci head=')
    expect(parseIntervention({ state: 'intervention', note, ...cols(flake) } as never)).toEqual(flake)
    expect(parseIntervention({ state: 'intervention', note: eventNote({ ...flake, flaky: false, failed_jobs: null, failed_tests: null }), ...cols(flake) } as never)).toMatchObject({ flaky: false, failed_jobs: null, failed_tests: null })
    expect(eventNote(base)).toBe(`who=loop cause=ci-rerun life=${LIFE} fact=i571/l1/rerun/r1/9 reason=ci%20flake`)
  })

  test('the flake row has its own once-key', () => {
    const first = onceKey({ state: 'intervention', note: eventNote(base), ...cols(base) } as never)
    const flake = onceKey({ state: 'intervention', note: eventNote({ ...base, flaky: true }), ...cols(base) } as never)
    expect(first).toBe(`intervention ${N} ci-rerun i571/l1/rerun/r1/9`)
    expect(flake).toBe(`${first} flake`)
  })
})

// --- whole passes through the test host: log read, re-run, ledger store, rule, event writer ---------

describe('the flake row in the pass driver (v2 SPEC 8.5)', () => {
  const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
  const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
  const HOUR = 60 * MIN
  const HEAD2 = 'b'.repeat(40)
  const PATCH = 'f00dfeed00000000000000000000000000000001'
  const SAMPLE = [
    `ci\tnpm test\t${TS} \u001b[31mFAIL tests/cli.test.js\u001b[0m`,
    `ci\tnpm test\t${TS} FAIL a,b`,
    `lint\tnpm run lint\t${TS} FAIL plugins/a (claude plugin validate / test)`,
  ].join('\n')

  // A record in reviewing, long past its step's start, whose PR has one red check of run RUN on HEAD. The
  // test changes what the checks read answers (`world.checks`, `world.head`) between passes.
  function flakeWorld(on: Parameters<typeof host>[0]) {
    const clock = mock.clock(on, { now: NOW })
    const pr = 43
    const life = lifeOf(NOW - 2 * HOUR)
    const r: IssueRecord = { ...madeRecord({ issue: N, life, branch: `issue-${N}`, pr, others: [] }, NOW - 2 * HOUR), seq: 4, seqAt: NOW - HOUR, since: NOW - HOUR, state: 'reviewing', step: 'review', round: 1, head: HEAD, brief: `https://github.com/${REPO}/issues/${N}#issuecomment-1` }
    const t5 = entry(transitionKey(r), 'transition', { issue: N, rule: 'S3', startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'transition', row: 'T5', event: 'ok', cause: null, from: 'building', to: 'reviewing', step: 'build', stored: true, via: 'build' } })
    const ens = entry(prKey(r, 'ensure'), 'pr', { issue: N, rule: 'S2', pr, startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'pr', pr, created: true, reopened: false } })
    const slot = { name: '1', path: '/slots/1', status: 'leased', branch: r.branch, lease_id: 'L1', lease_holder: `factory-loop:${N}:${life}`, leased_at: iso(NOW - 2 * HOUR), processes: [] }
    const world = { head: HEAD, checks: [] as { name: string; state: string; bucket: string; startedAt: string; completedAt: string | null; link: string }[] }
    const job = (runId: string, bucket: 'fail' | 'pass', completedAt: number) => ({ name: 'ci / test', state: bucket === 'pass' ? 'SUCCESS' : 'FAILURE', bucket, startedAt: iso(NOW - 20 * MIN), completedAt: iso(completedAt), link: `https://github.com/${REPO}/actions/runs/${runId}/job/1` })
    world.checks = [job(RUN, 'fail', NOW - 5 * MIN)]
    const logReads = () => h.seen.filter(c => c.argv.join(' ') === ARGV.runViewLogFailedArgv(REPO, RUN).join(' ')).length
    const run = (argv: string[], s: Seen) => {
      const line = argv.join(' ')
      switch (argv[0]) {
        case 'callum-flow-factory-state':
          return { stdout: factoryDoc([{ issue: N, stage: 'reviewing', entered_at: iso(NOW - HOUR), holder: DEVICE, run: null, pr, stuck: null, github: null }]) }
        case 'dev-query':
          return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
        case `${TOOLS}/queue-watch.sh`:
          return { stdout: 'queue known=none now=none\n' }
        case `${TOOLS}/usage-check.sh`:
          return { stdout: USAGE }
        case 'treehouse':
          return { stdout: JSON.stringify([slot]) }
        case 'callum-flow-rollout':
          return { stdout: 'ROLLOUT merge source=issue\n' }
        case 'callum-flow-patch-id':
          return { stdout: `${PATCH}\n` }
        case 'callum-flow-issue-read': {
          const pull = { pr: { number: pr, state: 'open', merged: false, head: { sha: world.head, ref: r.branch, repo: { full_name: REPO } }, base: { ref: 'main' }, user: { login: 'cbundy' }, mergeable_state: 'clean', body: '' }, stripped: 0 }
          return { stdout: JSON.stringify(line === `callum-flow-issue-read --json --pr ${pr}` ? pull : { issues: [], stripped: 0 }) }
        }
      }
      if (line === ARGV.runViewLogFailedArgv(REPO, RUN).join(' ')) return { stdout: SAMPLE }
      if (line === ARGV.branchPrsArgv(REPO, r.branch).join(' ')) return { stdout: JSON.stringify([{ number: pr, state: 'OPEN', headRefOid: world.head }]) }
      if (line === ARGV.prChecksArgv(REPO, pr).join(' ')) return { stdout: JSON.stringify(world.checks) }
      if (line.startsWith(`gh api repos/${REPO}/actions/runs?`)) return { stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) }
      return undefined
    }
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work' },
      store: { [`records:${REPO}`]: recordsToStore([r], NOW - HOUR), [`ledger:${REPO}`]: { v: 1, savedAt: NOW - HOUR, entries: [t5, ens] } },
      run,
    })
    let at = NOW
    const pass = async (ms: number) => {
      h.files.set(handshakePath(`${CFG_DIR}/factory-loop`, SESSION), JSON.stringify({ v: 1, session: SESSION, process: PROCESS, version: '0.38.2', at: iso(at) }))
      at += ms
      await clock.advance(ms)
    }
    const key = rerunKey(r, 1, RUN)
    const flakeRows = () => h.events().filter(e => e[1] === 'intervention' && (e.at(-1) ?? '').includes('flaky='))
    // passes until the re-run is done (the log read first, then gh run rerun)
    const rerunDone = async () => {
      for (let i = 0; i < 6 && h.entry(key)?.status !== 'done'; i++) await pass(60_000)
      expect(h.entry(key)).toMatchObject({ status: 'done', outcome: { kind: 'cli', exit: 0 } })
    }
    return { h, world, job, pass, key, flakeRows, rerunDone, logReads, reran: () => h.seen.filter(c => c.argv.join(' ') === ARGV.runRerunArgv(REPO, RUN).join(' ')).length }
  }

  const NAMES = { failedJobs: ['ci', 'lint'], failedTests: ['tests/cli.test.js', 'a,b'] }

  test('red, then its re-run (the log read answered), then the same run green on the same head: exactly one flaky=yes row with the parsed names', ENGINE_TEST, async ($, on) => {
    const w = flakeWorld(on)
    await $.session.start(START)
    await w.pass(6_000)
    await w.rerunDone()
    // the names went from the log read through the ledger's store (its outcome as stored), not from a stubbed command
    expect(w.logReads()).toBe(1)
    expect(w.reran()).toBe(1)
    expect(w.h.entry(w.key)?.outcome).toMatchObject({ kind: 'cli', exit: 0, ...NAMES })
    expect(w.flakeRows()).toEqual([])
    // the re-run is shown: the same run, green since it started
    const started = (w.h.ledger().find(e => e.key === w.key) as unknown as { startedAt: number }).startedAt
    w.world.checks = [w.job(RUN, 'pass', started + 1000)]
    for (let i = 0; i < 4; i++) await w.pass(60_000)
    const rows = w.flakeRows()
    expect(rows).toHaveLength(1)
    const note = rows[0]?.at(-1) ?? ''
    expect(note).toContain('cause=ci-rerun')
    expect(note).toContain('flaky=yes')
    expect(note).toContain('failed_tests=tests/cli.test.js,a%2Cb')
    expect(note).toContain('failed_jobs=ci,lint')
    expect(note).toContain(`head=${HEAD}`)
  })

  test('the run red again after the re-run: one flaky=no row', ENGINE_TEST, async ($, on) => {
    const w = flakeWorld(on)
    await $.session.start(START)
    await w.pass(6_000)
    await w.rerunDone()
    const started = (w.h.ledger().find(e => e.key === w.key) as unknown as { startedAt: number }).startedAt
    w.world.checks = [w.job(RUN, 'fail', started + 1000)]
    for (let i = 0; i < 4; i++) await w.pass(60_000)
    const rows = w.flakeRows()
    expect(rows).toHaveLength(1)
    const note = rows[0]?.at(-1) ?? ''
    expect(note).toContain('flaky=no')
    expect(note).toContain('failed_jobs=ci,lint')
  })

  test('a push of a new head with a green run: no flake row', ENGINE_TEST, async ($, on) => {
    const w = flakeWorld(on)
    await $.session.start(START)
    await w.pass(6_000)
    await w.rerunDone()
    w.world.head = HEAD2
    w.world.checks = [w.job('18342299777', 'pass', NOW + 30 * MIN)]
    for (let i = 0; i < 4; i++) await w.pass(60_000)
    expect(w.flakeRows()).toEqual([])
  })
})
