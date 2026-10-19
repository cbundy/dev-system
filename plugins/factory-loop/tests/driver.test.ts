// The pass driver (register.ts) end to end, in the engine's own test host (tests/host.ts):
// files, the store, commands, agents, prompts and /rename are answered by the test's hooks. In
// observe mode a pass reads, plans, logs and titles, and every command's event writes go to the
// sink (v2 SPEC 13.11.1). In act mode the rails come first (v2 SPEC 13.11.2), the ledger lives in $.store,
// the hooks feed it between passes (an agent's answer, a wake's turn), and the owner's controls
// ping the loop (v2 SPEC 13.2, 13.4.3, 13.7, 13.8, 13.10). The engine's test host never hands a plugin's
// $.agent.spawn an agent id, so agents that start are seeded in the store here; act.test.ts runs
// whole spawns through act.ts.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { loopEventArgs } from '../hooks/derive'
import { pruneArgvs } from '../hooks/exec'
import type { LedgerEntry } from '../hooks/types'
import { stepAnswerPath, stepRecordPath } from '../hooks/v2/steps'
import { handshakePath } from '../hooks/v2/workspace'
import { STEP_AGENT } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, OTHER, entry } from './fixtures'
import { CFG_DIR, LOCK, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, SESSION, TOOLS, PROCESS, agentDone, factoryDoc, host as engineHost, iso, ENGINE_TEST } from './host'
import type { Host, HostOptions, Seen } from './host'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
// the first pass of a life brings the main checkout up to date (rule H5), already current here
// The companion plugin's handshake for this session, written far ahead so it never goes stale: the
// workspace rail passes and no owner notice about the companion takes the wake slot (v2 SPEC 10.9).
// tests/v2-workspace.test.ts covers the rail itself.
const HANDSHAKE = { [handshakePath(`${CFG_DIR}/factory-loop`, SESSION)]: JSON.stringify({ v: 1, session: SESSION, process: PROCESS, version: '0.38.2', at: iso(NOW + 400 * 24 * 60 * MIN) }) }
const host: typeof engineHost = (on, opts = {}) => engineHost(on, { ...opts, files: { ...HANDSHAKE, ...opts.files } })

const settingsRead = (s: Seen) => s.argv[0] === 'git' && (s.argv[1] === 'show' || s.argv[1] === 'symbolic-ref')

// the claim of 470 at this clock, under v2's key (v2/keys.ts)
const CLAIM_KEY = 'i470/claim/tmtsc5'
const CLAIMED = 'claimed #470 on issue-470'
// the hourly release review of this clock, a task wake the model answers (v2 O3)
const RELEASE_KEY = 'task:release:unknown:2026-10-13T03'
const ACT = { repo: REPO, mode: 'act', checkout: '/work' }
const SINK = `${LOOP_DIR}/sink-events`
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-9001'
const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
const WATCH_LOCK = '/tmp/orchestrator-watch-cbundy_dev-system.lock'

// --- observe mode (the shadow's shape: runSource events, another device's work) ------------------

const FACTORY = factoryDoc([
  { issue: 45, stage: 'parked', entered_at: iso(NOW - 600_000), holder: DEVICE, run: 'R45', pr: 545, stuck: null, github: null },
])
const EVENTS = [
  'ts,state,issue,run_id,branch,pr,head,note,actor,device',
  `${iso(NOW - 600_000)},parked,45,R45,feat/issue-45-x,,h1,,watcher,${DEVICE}`,
  `${iso(NOW - 300_000)},renewed,45,,,,,lease: 120,agent,${DEVICE}`,
  `${iso(NOW - 300_000)},closed,3,,,,,completed,sweep,${DEVICE}`,
].join('\n')
// The commands an observe pass may run: reads only.
const READS = ['callum-flow-factory-state', 'dev-query', 'callum-flow-issue-read', `${TOOLS}/usage-check.sh`, 'callum-flow-milestone', 'git', 'stat']

function shadow(on: Parameters<typeof host>[0], reads: Record<string, string> = {}, config: Record<string, unknown> = {}, originFile?: () => string | undefined) {
  return host(on, {
    config: { repo: REPO, runSource: 'events', shadowDevice: DEVICE, checkout: '/work', ...config },
    env: { DEV_MACHINE_NAME: 'coder-spike' },
    run: argv => {
      // the repo's settings are origin's default branch's (v2 SPEC section 15)
      if (argv.join(' ') === 'git show origin/main:.claude/factory-loop.json') {
        const body = originFile?.()
        return body === undefined ? { exitCode: 128, stderr: "fatal: path '.claude/factory-loop.json' does not exist in 'origin/main'" } : { stdout: body }
      }
      switch (argv[0]) {
        case 'callum-flow-factory-state':
          return { stdout: FACTORY }
        case 'dev-query':
          return { stdout: EVENTS }
        case 'callum-flow-issue-read':
          return { stdout: reads[argv.slice(1).join(' ')] ?? JSON.stringify({ issues: [], stripped: 0 }) }
        case `${TOOLS}/usage-check.sh`:
          return { stdout: USAGE }
      }
      return undefined
    },
  })
}

describe('observe mode (v2 SPEC 13.11.1)', () => {
  test('one pass reads, plans, logs and titles, and runs only reads, their events to the sink', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // 45 is read open: an issue whose state a failed read leaves unknown gets no agent (#556)
    const issue45 = { issue: { number: 45, title: 'Work', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }
    const h = shadow(on, { '--json 45': JSON.stringify(issue45) })
    await $.session.start(START)
    await clock.advance(6_000)

    // v2 counts its own records, which none of this world's runs make
    expect(h.titles).toEqual(['🔄 dev-system (Q:0 - D:0 - M:0) · observe'])
    expect(h.passes()).toHaveLength(1)
    expect(h.last()).toMatchObject({ mode: 'observe', executed: false, device: DEVICE, tier: 'normal' })
    // parked #45 holds a live claim of this device with no record: the ghost is planned for release (R1), and not run
    expect(h.last().actions).toEqual([expect.objectContaining({ kind: 'label', rule: 'R1', issue: 45 })])
    expect([...h.files.keys()]).toContain(`${LOOP_DIR}/decisions-${iso(NOW).slice(0, 10)}.jsonl`)

    // nothing but reads ran, and every one of them wrote its events to the sink
    expect(h.commands().filter(s => !READS.includes(s.argv[0] ?? '')).map(s => s.argv.join(' '))).toEqual([])
    expect(h.commands().filter(s => !settingsRead(s)).every(s => s.env.CALLUM_EVENTS_DIR === SINK && s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
    // the state was recorded for the replay tools
    expect([...h.files.keys()].some(p => p.startsWith(`${LOOP_DIR}/states/`))).toBe(true)
  })

  test('it never keeps a ledger, takes the act lock, spawns or wakes the model', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on)
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    await $.turn.complete({ turnId: 't1', answer: 'ANSWER w1 merge', reason: 'answer', durationMs: 10, isAborted: false })
    expect(h.passes()).toHaveLength(2)
    expect([...h.store.keys()]).toEqual([])
    expect(h.files.has(LOCK)).toBe(false)
    expect(h.spawns).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test('the repo-local settings are loaded through the config loader (v2 SPEC 13.4.2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on, {}, {}, () => h.files.get('/work/.claude/factory-loop.json'))
    h.files.set('/work/.claude/factory-loop.json', JSON.stringify({ readyLabel: 'go', queueEvery: '10m', colour: 'blue' }))
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.seen.some(s => s.argv.join(' ') === 'callum-flow-issue-read --json --list --label go')).toBe(true)
    expect(h.last().config).toEqual(['colour: unknown setting'])
    // the configured labels reach the CLIs through the environment
    expect(h.commands().find(s => s.argv[0] === 'callum-flow-factory-state')?.env).toMatchObject({ CALLUM_FLOW_READY_LABEL: 'go', CALLUM_FLOW_IN_DEV_LABEL: 'in development' })
    // the queue is read every 10 minutes now, so the next pass does not read it again
    const before = h.seen.filter(s => s.argv.includes('--list')).length
    await clock.advance(60_000)
    expect(h.seen.filter(s => s.argv.includes('--list')).length).toBe(before)
  })

  test('a tracker named in only has its timeline read, then its sub-issues (D-35)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const issue40 = { issue: { number: 40, title: 'Epic: the loop', state: 'open', labels: [], sub_issues_summary: { total: 2 } }, stripped: 0 }
    const timeline = {
      events: [41, 42].map(n => ({ event: 'sub_issue_added', created_at: iso(NOW - 60_000 * n), sub_issue: { number: n, state: 'open' } })),
      stripped: 0,
    }
    const h = shadow(on, { '--json 40': JSON.stringify(issue40), '--json --timeline 40': JSON.stringify(timeline) })
    h.files.set(`${LOOP_DIR}/control.json`, JSON.stringify({ only: [40] }))
    await $.session.start(START)
    await clock.advance(6_000)
    const read = () => h.seen.filter(s => s.argv[0] === 'callum-flow-issue-read').map(s => s.argv.slice(1).join(' '))
    expect(read().some(r => /^--json --issues .*\b40\b/.test(r))).toBe(true)
    expect(read()).toContain('--json --timeline 40')
    await clock.advance(60_000)
    expect(read().some(r => /^--json --issues .*\b41\b.*\b42\b/.test(r))).toBe(true)
  })

  test('binDir goes ahead of PATH and toolsDir places the watchers (a testbed)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on, {}, { binDir: '/work/images/base', toolsDir: '/work/features/src/callum-tools' })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.commands().find(s => s.argv[0] === 'callum-flow-factory-state')?.env.PATH).toStartWith('/work/images/base:')
    expect(h.seen.some(s => s.argv[0] === '/work/features/src/callum-tools/usage-check.sh')).toBe(true)
  })

  test('once a day the loop dir loses its files older than a week (v2 SPEC 13.11.6)', ENGINE_TEST, async ($, on) => {
    // two minutes before midnight
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 13, 23, 58) })
    const h = shadow(on)
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    const prunes = () => h.seen.filter(s => s.argv[0] === 'find').map(s => s.argv)
    expect(prunes()).toEqual(pruneArgvs(LOOP_DIR, 7))
    expect(prunes()[0]).toContain(`${LOOP_DIR}/answers/*`)
    // the next day, once more
    await clock.advance(2 * MIN)
    expect(prunes()).toHaveLength(4)
  })

  // a row of the conversation as session.append carries it
  const row = (origin: { kind: 'composer' } | { kind: 'plugin'; name: string }, text: string, uuid: string) => ({
    door: 'prompt' as const,
    origin,
    uuid,
    message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'text' as const, text }] },
  })

  test('with no session.start (a plugin /reload-plugins adds), the first session.append starts the loop (v2 SPEC 13.2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on)
    mock.session(on)
    await $.session.append(row({ kind: 'composer' }, 'hello', 'u1'))
    await clock.advance(6_000)
    expect(h.passes()).toHaveLength(1)
  })

  test('a session no person reaches (a -p run, such as a pipeline review) never runs the loop, whatever its rows (D-61)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act' } })
    mock.session(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.session.append(row({ kind: 'composer' }, 'review this diff', 'u1'))
    await clock.advance(5 * 60_000)
    expect(h.seen).toEqual([])
    expect(h.titles).toEqual([])
  })

  test('the note /rename leaves for the model is blanked as it is stored; other rows are kept (v2 SPEC 13.9.1, FINDINGS check 3)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    shadow(on)
    const session = mock.session(on)
    await $.session.start(START)
    await clock.advance(6_000)
    await $.session.append(row({ kind: 'plugin', name: 'factory-loop' }, 'The user named this session "🔄 dev-system"', 'u1'))
    await $.session.append(row({ kind: 'composer' }, 'I named this session myself', 'u2'))
    // the session keeps a blanked row as its stand-in text, about 3 tokens
    expect(session.appended().map(r => r.message.content)).toEqual([
      [{ type: 'text', text: '(no content)' }],
      [{ type: 'text', text: 'I named this session myself' }],
    ])
  })

  test('mode off reads nothing and says so in the title', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'off' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    // the repo's settings are read from origin first (v2 SPEC section 15); nothing else
    expect(h.seen.map(s => s.argv.slice(0, 2).join(' '))).toEqual(['git symbolic-ref', 'git show'])
  })
})

// --- act mode ---------------------------------------------------------------------------------------

type Issue = { stage: string; since: number; run?: string | null; pr?: number | null }

// factory: a small world of canned CLIs: issue 470 in the queue or at a stage, the rest quiet.
type Answer = { exitCode?: number; stdout?: string; stderr?: string }
function factory(over: { queue?: number[]; issue?: Issue | null; beats?: string; release?: boolean; run?: (argv: string[], s: Seen) => Answer | Promise<Answer> | undefined } = {}) {
  const w = { queue: over.queue ?? [], issue: over.issue ?? null, beats: over.beats ?? QUIET_BEATS, release: over.release ?? false }
  const run = (argv: string[], s: Seen) => {
    const own = over.run?.(argv, s)
    if (own !== undefined) return own
    const [cmd, ...args] = argv
    switch (cmd) {
      case 'callum-flow-factory-state': {
        const i = w.issue
        const row = i === null ? null : { issue: 470, stage: i.stage, entered_at: iso(i.since), holder: DEVICE, run: i.run ?? null, pr: i.pr ?? null, stuck: null, github: null }
        return { stdout: factoryDoc(row === null ? [] : [row]) }
      }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? w.beats : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: `queue known=${args[args.indexOf('--known') + 1] ?? 'none'} now=${w.queue.join(',') || 'none'}\n` }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read':
        if (args.includes('--comments')) return { stdout: JSON.stringify({ comments: [], stripped: 0 }) }
        // observe mode reads the queue itself; act mode through queue-watch.sh --once
        if (args.includes('--list')) return { stdout: JSON.stringify({ issues: w.queue.map(number => ({ number })), stripped: 0 }) }
        if (args.join(' ') === '--json 470') {
          const issue = { number: 470, title: 'The loop acts', state: 'open', labels: [{ name: 'ready' }], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }
          return { stdout: JSON.stringify({ issue, stripped: 0 }) }
        }
        return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: '[]' }
      case 'callum-flow-implementer-route':
        return { stdout: 'sonnet\n' }
      case 'callum-flow-milestone':
        // a closed item in the Next release milestone: the hourly release review is due (rule O3)
        return w.release ? { stdout: 'Next release (v1.0.0)\nExpected: patch\n#469 closed  Done\n' } : undefined
      case 'gh':
        // the open PRs a claim adopts: none
        return args[0] === 'pr' && args[1] === 'list' ? { stdout: '[]' } : undefined
    }
    return undefined
  }
  return { w, run }
}

const ledgerOf = (entries: LedgerEntry[]) => ({ [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries } })
const lease = (session: string, expiresAt: number) => JSON.stringify({ session, renewedAt: NOW - MIN, expiresAt })

// factoryOp: the owner types /factory <args> at the prompt.
async function factoryOp($: Engine, args: string) {
  return $.command.run({ command: 'factory', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

describe('act mode: the pass (v2 SPEC 13.2, 13.7, 13.12)', () => {
  test('the rails pass, the pass acts in plan order, and the store keeps the ledger', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    expect([...h.registered].sort()).toEqual(['/factory', 'mcp__factory-loop__answer', 'mcp__factory-loop__control'])
    await clock.advance(6_000)

    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: true, ledgerSource: 'none', device: DEVICE })
    expect(line.rails).toBeUndefined()
    expect(line.outcomes).toEqual([
      { key: CLAIM_KEY, status: 'done', ms: 0, summary: CLAIMED },
      { key: 'sweep:0', status: 'done', ms: 0, summary: 'swept' },
    ])
    expect(line.commands).toContain('callum-flow-claim 470')
    expect(h.entry(CLAIM_KEY)).toMatchObject({ status: 'done', attempts: 1, outcome: { kind: 'adopt', branch: 'issue-470' } })
    expect(JSON.parse(h.files.get(LOCK) ?? '{}')).toMatchObject({ session: SESSION, expiresAt: NOW + 5_000 + 15 * MIN })
    expect(h.store.get(`queue-known:${REPO}`)).toEqual([470])
    // act mode's commands write real events: no sink
    // (the reads of the repo's settings from origin run before the environment is built, and carry none)
    expect(h.commands().filter(s => !settingsRead(s)).every(s => s.env.CALLUM_EVENTS_DIR === undefined && s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
    expect(h.titles).toEqual(['🔄 dev-system (Q:1 - D:0 - M:0)'])
    // no full states in act mode
    expect([...h.files.keys()].some(p => p.startsWith(`${LOOP_DIR}/states/`))).toBe(false)
  })

  const rails: { name: string; files?: Record<string, string>; env?: Record<string, string>; beats?: string; run?: (argv: string[]) => { exitCode?: number; stdout?: string } | undefined; reason: string; tell: string | null; lockless?: boolean }[] = [
    { name: "another session's act lock", files: { [LOCK]: lease('session-other', NOW + 10 * MIN) }, reason: 'act lock: session session-other holds it', tell: null },
    { name: 'DEV_ROLE unset', env: { DEV_ROLE: '' }, reason: 'role: DEV_ROLE is unset, act needs orchestrator', tell: null },
    {
      name: 'a live watcher lock',
      files: { [`${WATCH_LOCK}/pid`]: '4242\n' },
      run: argv => (argv[0] === 'cat' && argv[1] === '/proc/4242/cmdline' ? { stdout: 'sh\u0000/usr/local/share/callum-tools/orchestrator-watch.sh\u0000' } : argv[0] === 'sh' ? { exitCode: 0 } : undefined),
      reason: `old watcher: orchestrator-watch.sh holds ${WATCH_LOCK} (pid 4242)`,
      tell: 'TELL old-watcher id=w',
    },
    { name: "another orchestrator's heartbeat", beats: `device,age_s\n${OTHER},30\n`, reason: 'heartbeat: another orchestrator on this repo is up', tell: 'TELL heartbeat-other id=w' },
    {
      name: 'a failed startup migrate',
      files: { '/tmp/dev-factory-db-migrate.json': JSON.stringify({ outcome: 'failed', at: new Date(NOW - 60_000).toISOString(), to_version: 12, error: 'connecting as x_migrator failed' }) },
      reason: 'schema: migrate to 12 failed: connecting as x_migrator failed',
      tell: 'TELL schema-behind id=w',
    },
    {
      name: 'a checkout of another repo',
      run: argv => (argv.join(' ') === 'git remote get-url origin' ? { stdout: 'git@github.com:cbundy/plant-console.git\n' } : undefined),
      reason: 'repo: the checkout /work is cbundy/plant-console, not cbundy/dev-system',
      tell: null,
      lockless: true,
    },
  ]
  for (const r of rails) {
    test(`a rail refuses act: ${r.name}; the pass runs as observe`, ENGINE_TEST, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const { run } = factory({ queue: [470], beats: r.beats, run: r.run })
      const h = host(on, { config: ACT, run, files: r.files, env: r.env })
      await $.session.start(START)
      await clock.advance(6_000)
      const line = h.last()
      expect(line).toMatchObject({ mode: 'act', executed: false })
      expect((line.rails as string[]).join(' | ')).toContain(r.reason)
      // it planned the claim and ran nothing but reads, their events to the sink
      expect((line.actions as { key: string }[]).map(a => a.key)).toContain(CLAIM_KEY)
      expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim' || s.argv[0] === 'callum-flow-sweep')).toBe(false)
      expect(h.commands().filter(s => s.argv[0] === 'callum-flow-factory-state').every(s => s.env.CALLUM_EVENTS_DIR === SINK)).toBe(true)
      expect(h.titles.at(-1)).toContain('· observe')
      // a session a rail refuses never takes the act lock
      if (r.lockless === true) expect(h.files.has(LOCK)).toBe(false)
      // the rail's notice goes out once, under its own key, and never again for that spell
      await clock.advance(60_000)
      const told = h.prompts.filter(p => r.tell !== null && p.startsWith(r.tell))
      expect(told).toHaveLength(r.tell === null ? 0 : 1)
      expect(h.prompts).toHaveLength(r.tell === null ? 0 : 1)
    })
  }

  test('a heartbeat notice keeps its key in the ledger and is logged as a loop event', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ beats: `device,age_s\n${OTHER},30\n` })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.ledger()).toMatchObject([{ key: `tell:heartbeat-other:${NOW + 5_000}`, status: 'running' }])
    // the spell is remembered beside the ledger, so a reload does not tell it again
    expect(h.store.get(`rails:${REPO}`)).toEqual({ heartbeat: { since: NOW + 5_000, device: OTHER }, watcher: null })
    expect(h.last().told).toEqual([`tell:heartbeat-other:${NOW + 5_000}`])
    expect(h.events().filter(e => (e.at(-1) ?? '').startsWith('kind=tell'))).toHaveLength(1)
    expect(h.prompts[0]).toStartWith(`TELL heartbeat-other id=w`)
    expect(h.prompts[0]).toContain(`device=${OTHER}`)
  })

  test('the kill switch stops act mode within a pass: nothing read, nothing run', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run, files: { [`${CFG_DIR}/factory-loop/OFF`]: '' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    // the repo's settings are read from origin first (v2 SPEC section 15); nothing else is
    expect(h.seen.map(s => s.argv.slice(0, 2).join(' '))).toEqual(['git symbolic-ref', 'git show'])
    // and it notes the kill switch as a person's edit, in the one store key the loop keeps for that
    expect([...h.store.keys()]).toEqual([`files:${REPO}`])
    // removing it resumes the configured mode at the next pass
    h.files.delete(`${CFG_DIR}/factory-loop/OFF`)
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true })
  })

  test('the kill switch set mid-pass stops it between actions: the rest are skipped and logged (v2 SPEC 13.11.3, #557)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let h: Host | undefined
    // the owner creates the switch while the claim runs, before the pass's sweep
    const { run } = factory({
      queue: [470],
      run: argv => {
        if (argv[0] === 'callum-flow-claim') h?.files.set(`${CFG_DIR}/factory-loop/OFF`, '')
        return undefined
      },
    })
    h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const outcomes = (h.last().outcomes ?? []) as { key: string; status: string; summary: string }[]
    expect(outcomes.map(o => [o.key, o.status, o.summary])).toEqual([
      [CLAIM_KEY, 'done', CLAIMED],
      ['sweep:0', 'skipped', 'kill switch'],
    ])
    // the sweep never ran nor entered the ledger, and the title says off at once
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-sweep')).toBe(false)
    expect(h.ledger().map(e => e.key)).toEqual([CLAIM_KEY])
    expect(h.titles.at(-1)).toBe('🔄 dev-system · off')
  })

  test('a restart mid-action: running commands are lost, agents are reconciled against the list (v2 SPEC 13.7.5)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const started = NOW - 10 * MIN
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'running', startedAt: started, endedAt: null }),
      entry('design:470:1', 'agent-step', { step: 'design', class: 'develop', issue: 470, status: 'running', startedAt: started, endedAt: null, agentId: 'agent-alive' }),
      entry('fixer:gate:R:review:h', 'agent-step', { step: 'fix', class: 'drive', issue: 471, status: 'running', startedAt: started, endedAt: null, agentId: 'agent-gone' }),
    ])
    const h = host(on, { config: ACT, run, store })
    h.agents.push({ id: 'agent-alive', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.entry('heartbeat:0')).toMatchObject({ status: 'lost', summary: 'lost: the loop reloaded mid-action' })
    expect(h.entry('fixer:gate:R:review:h')).toMatchObject({ status: 'lost', summary: 'lost: gone from the agent list' })
    expect(h.entry('design:470:1')).toMatchObject({ status: 'running', agentId: 'agent-alive' })
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'store' })
    // the lost agent's loop event; command entries log their own events, never a loop event
    const loops = h.events().map(e => e.at(-1) ?? '').filter(n => n.startsWith('kind='))
    expect(loops.some(n => n.startsWith('kind=agent-step key=fixer:gate:R:review:h status=lost'))).toBe(true)
    expect(loops.some(n => n.includes('key=heartbeat:0'))).toBe(false)
  })

  test('the restart for an update ran: the update is done and the drain ends (rule H4)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([entry('restart:777', 'restart-self', { rule: 'H4', status: 'running', startedAt: NOW - MIN, endedAt: null })])
    const h = host(on, { config: ACT, run, store, files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: 777 } }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.entry('restart:777')).toMatchObject({ status: 'lost' })
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ updateDue: null })
    expect(h.lines().some(l => l.control === 'update off')).toBe(true)
    expect((h.last().skipped as { rule: string }[]).filter(s => s.rule === 'H4')).toEqual([])
  })

  test('a restart that returned keeps the drain and stops acting until the workspace is replaced (rule H4, D-15)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const f = factory()
    const store = ledgerOf([entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })])
    const h = host(on, { config: { ...ACT, windDownMinutes: 0 }, run: f.run, store, files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: 777 } }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    // the drain is complete: dev-restart-self asks Coder for the new workspace and returns
    expect(h.commands().filter(s => s.argv[0] === 'dev-restart-self')).toHaveLength(1)
    expect(h.entry('restart:777')).toMatchObject({ status: 'done' })
    // minutes pass before the container goes: the update is not done, nothing more acts, nothing is told
    f.w.queue = [470]
    h.files.set(`${LOOP_DIR}/control.json`, JSON.stringify({ updateDue: { reason: 'image', at: 777 } }))
    await clock.advance(60_000)
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ updateDue: { at: 777 } })
    expect(h.last()).toMatchObject({ executed: false })
    expect((h.last().rails as string[]).join(' ')).toContain('restart: dev-restart-self asked for a new workspace')
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect(h.commands().filter(s => s.argv[0] === 'dev-restart-self')).toHaveLength(1)
  })

  test('R2 with wind-down on: the request is written before the restart, then the loop winds down, starts nothing, and forgets a restart that never came (D-15)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const f = factory()
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('queue-merge:5', 'queue-merge', { class: 'drive', status: 'running', startedAt: NOW - MIN, endedAt: null }),
    ])
    const h = host(on, { config: { ...ACT, titleEvery: '1s' }, run: f.run, store, files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: 777 } }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    const names = h.commands().map(s => (s.argv[0] === 'sh' && s.argv[3] === 'wind-down-request' ? 'write-request' : s.argv[0]))
    expect(names.filter(n => n === 'write-request' || n === 'dev-restart-self')).toEqual(['write-request', 'dev-restart-self'])
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/wind-down.request`) ?? '{}')).toMatchObject({ trigger: 'restart-self' })
    expect(h.entry('restart:777')).toMatchObject({ status: 'done' })
    // the next pass acts in wind-down: the status file is written and nothing starts
    f.w.queue = [470]
    h.files.set(`${LOOP_DIR}/control.json`, JSON.stringify({ updateDue: { reason: 'image', at: 777 } }))
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true })
    expect(h.titles.at(-1)).toContain('winding down')
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/wind-down.status.json`) ?? '{}')).toMatchObject({ cap_ms: 10 * MIN, running: { steps: [] } })
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect(h.commands().filter(s => s.argv[0] === 'dev-restart-self')).toHaveLength(1)
    // the stop script removed the request: still nothing starts, and no status file is written for it
    h.files.delete(`${LOOP_DIR}/wind-down.request`)
    h.files.delete(`${LOOP_DIR}/wind-down.status.json`)
    await clock.advance(60_000)
    expect(h.files.has(`${LOOP_DIR}/wind-down.status.json`)).toBe(false)
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    // the restart never came: past the cap and the margin the loop plans normally again
    await clock.advance(16 * MIN)
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(true)
    expect(h.events().filter(e => e.some(n => n.includes('wind-down-stale'))).length).toBeGreaterThan(0)
  })

  test('the new workspace finds the restart done before it loaded: the update is done (rule H4)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([entry('restart:777', 'restart-self', { rule: 'H4', status: 'done', startedAt: NOW - 3 * MIN, endedAt: NOW - 3 * MIN })])
    const h = host(on, { config: ACT, run, store, files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: 777 } }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ updateDue: null })
    expect(h.last()).toMatchObject({ executed: true })
  })

  test('a GitHub rate limit is kept in the store: the next passes skip the GitHub reads and say gh wait (v2 SPEC 13.10 item 2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470], run: argv => (argv[0] === 'callum-flow-claim' ? { exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)' } : undefined) })
    const h = host(on, { config: { ...ACT, titleEvery: '1s' }, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.store.get(`backoff:${REPO}`)).toBe(NOW + 5_000 + 15 * MIN)
    // two minutes on the queue would be read again, but GitHub waits
    const reads = () => h.commands().filter(s => s.argv[0] === `${TOOLS}/queue-watch.sh` || s.argv[0] === 'callum-flow-issue-read').length
    const before = reads()
    await clock.advance(2 * MIN)
    expect(reads()).toBe(before)
    expect(h.titles.at(-1)).toContain('gh wait')
  })

  test('a starved queue keeps its spell in the store from the first pass, the pass line carries it, and a pass that claims ends it (S1)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let blocked = 1
    let queueDown = false
    const { run } = factory({
      queue: [470],
      run: argv => {
        if (queueDown && argv[0] === `${TOOLS}/queue-watch.sh`) return { exitCode: 1, stderr: 'boom' }
        if (argv[0] !== 'callum-flow-issue-read' || argv.slice(1).join(' ') !== '--json 470') return undefined
        const issue = { number: 470, title: 'The loop acts', state: 'open', labels: [{ name: 'ready' }], issue_dependencies_summary: { blocked_by: blocked }, sub_issues_summary: { total: 0 } }
        return { stdout: JSON.stringify({ issue, blocked_by: [], blocking: [], stripped: 0 }) }
      },
    })
    const h = host(on, { config: { ...ACT, titleEvery: '1s' }, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const since = h.store.get(`starved:${REPO}`)
    expect(since).toBe(NOW + 5_000)
    expect(h.last().starved).toEqual({ since: new Date(NOW + 5_000).toISOString(), minutes: 0 })
    // a second starved pass keeps the spell's start
    await clock.advance(10 * MIN)
    expect(h.store.get(`starved:${REPO}`)).toBe(since)
    expect((h.last().starved as { minutes: number }).minutes).toBeGreaterThanOrEqual(9)
    // a pass that cannot read the queue knows nothing: the spell stands
    queueDown = true
    await clock.advance(2 * MIN)
    expect(h.last().starved).toBeUndefined()
    expect(h.store.get(`starved:${REPO}`)).toBe(since)
    queueDown = false
    // the blocker clears: the pass claims, and the spell ends
    blocked = 0
    await clock.advance(10 * MIN)
    expect(h.store.has(`starved:${REPO}`)).toBe(false)
    expect(h.last().starved).toBeUndefined()
  })

  test('a rate-cap hold is one loop event per cap per hour (v2 SPEC 13.11.4, D-24)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const claims = Array.from({ length: 30 }, (_, i) => entry(`claim:${200 + i}:x`, 'claim', { class: 'start', issue: 200 + i, startedAt: NOW - 30 * MIN, endedAt: NOW - 30 * MIN }))
    const h = host(on, { config: ACT, run, store: ledgerOf([entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }), ...claims]) })
    await $.session.start(START)
    await clock.advance(6_000)
    const held = `kind=start key=cap:start:${Math.floor((NOW + 5_000) / 3_600_000)} status=held`
    expect(h.last().capped).toEqual(['start'])
    expect(h.events().filter(e => e.at(-1) === held)).toEqual([['callum-flow-event', 'loop', '--note', held]])
    await clock.advance(60_000)
    expect(h.last().capped).toEqual(['start'])
    expect(h.events().filter(e => e.at(-1) === held)).toHaveLength(1)
  })

  test('three passes in a row that throw tell the owner once, and the title shows error (v2 SPEC 13.10 item 9)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const good = h.titles.at(-1) ?? ''
    h.failAppends = true
    for (let i = 0; i < 4; i++) await clock.advance(60_000)
    expect(h.titles.at(-1)).toBe(`${good} · error`)
    expect(h.prompts.filter(p => p.startsWith('TELL pass-error id=w'))).toHaveLength(1)
    expect(h.prompts[0]).toContain('passes=3')
    h.failAppends = false
    // the error title started the throttle window: the plan title returns once titleEveryMs has passed
    await clock.advance(60_000)
    expect(h.titles.at(-1)).toBe(`${good} · error`)
    await clock.advance(5 * MIN)
    expect(h.titles.at(-1)).toBe(good)
  })

  test('passes that fail now and then never rename more than once per titleEveryMs (O1)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const before = h.titles.length
    for (let i = 0; i < 20; i++) {
      h.failAppends = i % 2 === 0
      await clock.advance(60_000)
    }
    expect(h.titles.length - before).toBeLessThanOrEqual(8) // the error title goes out at once, the plan title waits: two renames per window, not one per pass (was 20)
  })

  test('session.end releases this session\'s act lock, so the next session acts at once', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(JSON.parse(h.files.get(LOCK) ?? '{}').expiresAt).toBeGreaterThan(clock.now())
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } })
    expect(JSON.parse(h.files.get(LOCK) ?? '{}')).toMatchObject({ session: SESSION, expiresAt: clock.now() })
  })
})

describe('act mode: the one writer, and reads that fail (v2 SPEC 13.3.3, 13.7.5, 13.11.2)', () => {
  const ledgerKey = `ledger:${REPO}`
  const otherLease = (expiresAt: number) => JSON.stringify({ session: 'session-other', renewedAt: NOW - MIN, expiresAt })

  // another session takes the lock while the claim runs (this one's lease ran out under it); its
  // own lease may still be live, or have run out in turn
  for (const [name, expiresAt] of [['live', NOW + 30 * MIN], ['expired since', NOW + 1_000]] as const) {
    test(`a session that loses the act lock mid-pass (the other lease ${name}) runs nothing more and never writes the ledger again`, ENGINE_TEST, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      let atLoss = ''
      let h: Host | undefined
      const { run } = factory({
        queue: [470],
        run: argv => {
          if (argv[0] === 'callum-flow-claim' && h !== undefined) {
            h.files.set(LOCK, otherLease(expiresAt))
            atLoss = JSON.stringify(h.store.get(ledgerKey))
          }
          return undefined
        },
      })
      h = host(on, { config: ACT, run })
      await $.session.start(START)
      await clock.advance(6_000)
      const line = h.last()
      expect(line.outcomes).toEqual([
        { key: CLAIM_KEY, status: 'done', ms: 0, summary: CLAIMED },
        { key: 'sweep:0', status: 'skipped', ms: 0, summary: "held: the act lock is no longer this session's" },
      ])
      expect(h.commands().some(s => s.argv[0] === 'callum-flow-sweep')).toBe(false)
      // the store keeps what it held when the lock was lost: the claim running, as the next holder will find it
      expect(JSON.stringify(h.store.get(ledgerKey))).toBe(atLoss)
      expect(h.entry(CLAIM_KEY)).toMatchObject({ status: 'running' })
      expect((line.problems as string[]).join(' ')).toContain('session session-other')
      if (name === 'live') {
        // the next pass stays in observe
        await clock.advance(60_000)
        expect(h.last()).toMatchObject({ executed: false })
        expect((h.last().rails as string[]).join(' ')).toContain('act lock: session session-other holds it')
        expect(JSON.stringify(h.store.get(ledgerKey))).toBe(atLoss)
      }
    })
  }

  test("an agent's answer while another session holds the lock is left to that session: no load, no event, no write", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry(`design:470:${since}`, 'agent-step', { step: 'design', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store, files: { [LOCK]: otherLease(NOW + 30 * MIN) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: false })
    const before = JSON.stringify(h.store.get(ledgerKey))
    await agentDone($, h, 'agent-1', 'Brief posted.')
    // the observe pass's own probe of the new event log is no event of this answer
    expect(h.events().filter(e => e[1] !== '--new-only')).toEqual([])
    expect(JSON.stringify(h.store.get(ledgerKey))).toBe(before)
  })

  test("a lease taken over from another session reloads the store's ledger, which that session kept, before anything acts", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const f = factory()
    const h = host(on, { config: ACT, run: f.run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: true })
    // meanwhile another session held the lock, ran out of claim attempts on 470, and its lease expired
    f.w.queue = [470]
    h.files.set(LOCK, otherLease(NOW + 30_000))
    h.store.set(ledgerKey, {
      v: 1,
      savedAt: NOW + 20_000,
      entries: [
        entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW + 5_000, endedAt: NOW + 5_000 }),
        entry(CLAIM_KEY, 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: NOW + 10_000, endedAt: NOW + 20_000 }),
      ],
    })
    // the queue is read again two minutes after its last read
    await clock.advance(3 * MIN)
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'store' })
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect(h.last().skipped).toContainEqual({ rule: 'S1', issue: 470, why: `exhausted: ${CLAIM_KEY}` })
  })

  test('an agent list that cannot be read marks no agent lost and spawns nothing (v2 SPEC 13.3.3, 13.10 item 4)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const key = `design:470:${since}`
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(key, 'agent-step', { step: 'design', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store })
    h.failList = true
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: true })
    expect(h.entry(key)).toMatchObject({ status: 'running', agentId: 'agent-1' })
    expect(h.events().some(e => (e.at(-1) ?? '').includes('status=lost'))).toBe(false)
    expect(h.spawns).toEqual([])
  })

  test('a store that cannot be read is never replaced: nothing acts and nothing is written (v2 SPEC 13.7.5)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run })
    h.failGet = key => key === ledgerKey
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: false })
    expect(line.rails as string[]).toContain('ledger: not loaded, so nothing is acted on this pass')
    expect((line.problems as string[]).join(' ')).toContain('ledger: the store could not be read')
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim' || s.argv[0] === 'callum-flow-sweep')).toBe(false)
    expect(h.spawns).toEqual([])
    expect(h.store.has(ledgerKey)).toBe(false)
  })

  test('a ledger the store will not take starts nothing, is reported, and shows error until a save succeeds', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run })
    h.failSet = key => key === ledgerKey
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect((line.outcomes as { status: string; summary: string }[]).map(o => [o.status, o.summary])).toEqual([
      ['skipped', 'held: the ledger was not saved, so nothing starts'],
      ['skipped', 'held: the ledger was not saved, so nothing starts'],
    ])
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-sweep' || s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect((line.problems as string[]).join(' ')).toContain('ledger: not saved, so nothing starts until a save succeeds')
    expect((line.problems as string[]).join(' ')).toContain(`store: ${ledgerKey} could not be written`)
    expect(h.titles.at(-1)).toEndWith(' · error')
    // the store takes it again: the loop acts, and the title clears
    h.failSet = () => false
    await clock.advance(60_000)
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(true)
    // the error title started the throttle window: the plan title returns once titleEveryMs has passed
    await clock.advance(5 * MIN)
    expect(h.titles.at(-1)).not.toContain('error')
  })

  test('every attempt is in the store, running, before its command runs (v2 SPEC 13.7.5)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen: Record<string, string | undefined> = {}
    let h: Host | undefined
    const { run } = factory({
      queue: [470],
      run: argv => {
        if (argv[0] === 'callum-flow-sweep') seen.sweep = h?.entry('sweep:0')?.status
        if (argv[0] === 'callum-flow-claim') seen.claim = h?.entry(CLAIM_KEY)?.status
        return undefined
      },
    })
    h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(seen).toEqual({ claim: 'running', sweep: 'running' })
    expect(h.entry(CLAIM_KEY)?.status).toBe('done')
    expect(h.entry('sweep:0')?.status).toBe('done')
  })

  test('a long step never outlives the lease: a pass renews it on a timer while it runs (v2 SPEC 13.11.2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let release: () => void = () => undefined
    const slow = new Promise<Answer>(resolve => (release = () => resolve({})))
    const { run } = factory({ queue: [470], run: argv => (argv[0] === 'callum-flow-claim' ? slow : undefined) })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    // the claim is still running 14 minutes on: the lease runs well past now
    await clock.advance(14 * MIN)
    expect(h.commands().filter(s => s.argv[0] === 'callum-flow-claim')).toHaveLength(1)
    expect(JSON.parse(h.files.get(LOCK) ?? '{}').expiresAt).toBeGreaterThan(clock.now() + 10 * MIN)
    release()
    await clock.settle()
    expect(h.entry(CLAIM_KEY)).toMatchObject({ status: 'done' })
  })
})

describe('act mode: a lease taken over during a long step', () => {
  test("a renewal that finds another session's lease, even expired, never writes this session's ledger over that session's (v2 SPEC 13.11.2)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let release: () => void = () => undefined
    const slow = new Promise<Answer>(resolve => (release = () => resolve({})))
    const { run } = factory({ queue: [470], run: argv => (argv[0] === 'callum-flow-claim' ? slow : undefined) })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    // while the claim runs, another session held the lock, kept its own ledger, and its lease ran out
    const theirs = { v: 1, savedAt: NOW + 10_000, entries: [entry('sweep:9', 'sweep', { status: 'done', startedAt: NOW + 9_000, endedAt: NOW + 9_000 })] }
    h.files.set(LOCK, JSON.stringify({ session: 'session-other', renewedAt: NOW + 6_000, expiresAt: NOW + 7_000 }))
    h.store.set(`ledger:${REPO}`, theirs)
    await clock.advance(60_000)
    release()
    await clock.settle()
    expect(h.passes()[0]?.problems).toEqual(['act lock: session session-other held it during this pass; this one keeps the ledger no longer'])
    // their ledger stands, reloaded by the next pass; this session's stale one (its sweep:0) never landed
    const keys = h.ledger().map(e => e.key)
    expect(keys).toContain('sweep:9')
    expect(keys).not.toContain('sweep:0')
  })
})

describe('act mode: between passes (v2 SPEC 13.2, 13.8.2, 13.10 item 4)', () => {
  // a triage step at work on 470 (v2 SPEC 10.8): its entry, and the record its spawn wrote, naming
  // the file it answers in with the answer script. With the test's engine, a repair message resumes
  // the agent as the engine does.
  const KEY = 'i470/ltbq3k0/s5/triage/a1'
  const stepRecord = JSON.stringify({
    v: 2,
    key: KEY,
    issue: 470,
    step: 'triage',
    life: 'tbq3k0',
    seq: 5,
    attempt: 1,
    branch: 'issue-470',
    slot: '/slots/1',
    role: 'reader',
    subagentType: STEP_AGENT.triage,
    model: 'opus',
    contract: 'triage',
    data: null,
    answerFile: stepAnswerPath(LOOP_DIR, KEY),
    prompt: 'triage',
  })
  const triageAt = (on: Parameters<typeof host>[0], send: HostOptions['send'], engine?: HostOptions['engine']) => {
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(KEY, 'agent-step', { step: 'triage', class: 'drive', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run: factory().run, store, send, engine, files: { [stepRecordPath(LOOP_DIR, KEY)]: stepRecord } })
    h.agents.push({ id: 'agent-1', type: STEP_AGENT.triage, status: 'running', description: 'Triage #470' })
    return { h, key: KEY }
  }
  const NO_ANSWER = 'no answer was recorded with the answer script'

  test("an agent of the loop whose turn ends with no recorded answer gets one repair message, then its attempt ends unknown; the decision log says which path each took, and a pass follows (v2 SPEC 10.8)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { h, key } = triageAt(on, undefined, undefined)
    await $.session.start(START)
    await clock.advance(6_000)
    const passes = h.passes().length
    // an agent the loop never spawned changes nothing and pings nothing
    await agentDone($, h, 'agent-someone-else', 'all done')
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(passes)

    await agentDone($, h, 'agent-1', 'I think we should retry')
    expect(h.sends.map(s => s.to)).toEqual(['agent-1'])
    const text = h.sends[0]?.text ?? ''
    expect(text).toContain(`Your answer was not recorded: ${NO_ANSWER}.`)
    expect(text).toMatch(new RegExp(`\\S+/bin/factory-answer --to ${stepAnswerPath(LOOP_DIR, key).replace(/[.]/g, '\\.')}`))
    expect(h.entry(key)).toMatchObject({ status: 'running', attempts: 1, reminded: true })
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', key, answer: 'repair', why: NO_ANSWER }))
    // its words are saved for the owner and the triage
    expect(h.files.get(`${LOOP_DIR}/answers/${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`)).toBe('I think we should retry')

    // the resumed agent ends its turn again with nothing recorded: the attempt ends, with no second message
    const a = h.agents.find(x => x.id === 'agent-1')
    if (a !== undefined) a.status = 'running'
    await agentDone($, h, 'agent-1', 'still nothing')
    expect(h.sends).toHaveLength(1)
    expect(h.entry(key)).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'triage', result: { event: 'unknown', why: 'bad-answer' } } })
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', key, answer: 'script', status: 'done', afterRepair: true }))
    // the ping: the next pass is asked for by the agent (#552)
    await clock.advance(5_000)
    expect(h.last()).toMatchObject({ trigger: 'agent agent-1' })
  })

  test('a repair message the engine does not deliver ends the attempt at once, and the decision log says so (#548)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { h, key } = triageAt(on, () => 'no such agent')
    await $.session.start(START)
    await clock.advance(6_000)
    await agentDone($, h, 'agent-1', 'All good.')
    expect(h.sends).toEqual([])
    expect(h.entry(key)).toMatchObject({ status: 'done', attempts: 1, reminded: true, outcome: { kind: 'step', result: { event: 'unknown', why: 'bad-answer' } } })
    expect(h.entry(key)?.summary).toContain('the repair message was not delivered: no such agent')
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', key, answer: 'script', status: 'done', repairRefused: 'no such agent' }))
  })

  test("the repair message reaches an agent of the loop's own type, which the model is never offered: the engine resumes only a type it offers, so the loop offers it while its message is on its way (#559)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { h, key } = triageAt(on, undefined, $)
    const offer = () => $.agent.offer({ agent: STEP_AGENT.triage, description: 'an agent', source: 'plugin', provider: { plugin: 'factory-loop', tier: 'user' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(await offer()).toEqual({ isOffered: false })
    await agentDone($, h, 'agent-1', 'All good.')
    expect(h.sends.map(s => s.to)).toEqual(['agent-1'])
    expect(h.entry(key)).toMatchObject({ status: 'running', attempts: 1, reminded: true })
    // the type is hidden from the model again once the message is delivered
    expect(await offer()).toEqual({ isOffered: false })
  })

  test("a repair message the engine refuses: the decision log keeps the engine's words whole, the entry a clipped copy (#559)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const refusal = `Agent "agent-1" is stopped (completed) and could not be resumed: ${'the transcript could not be read; '.repeat(6)}start a new agent if the work is still needed.`
    const { h, key } = triageAt(on, () => refusal)
    await $.session.start(START)
    await clock.advance(6_000)
    await agentDone($, h, 'agent-1', 'All good.')
    expect(h.entry(key)).toMatchObject({ status: 'done', attempts: 1 })
    expect(h.entry(key)?.summary).toEndWith('...')
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', key, answer: 'script', status: 'done', repairRefused: refusal }))
  })

  test('a repair message that hangs is undelivered after 10 s, so it never holds the agent\'s turn.complete: the attempt ends (#548)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { h, key } = triageAt(on, () => new Promise<string | undefined>(() => undefined))
    await $.session.start(START)
    await clock.advance(6_000)
    let settled = false
    const ended = $.turn.complete({ agentId: 'agent-1', answer: 'All good.', reason: 'answer', turnId: 'turn-agent-1', durationMs: 1000, isAborted: false }).then(r => {
      settled = true
      return r
    })
    await clock.advance(9_000)
    expect(settled).toBe(false)
    expect(h.entry(key)).toMatchObject({ status: 'running', reminded: true })
    await clock.advance(1_000)
    await ended
    expect(h.entry(key)).toMatchObject({ status: 'done', attempts: 1 })
    expect(h.entry(key)?.summary).toContain('the repair message was not delivered: repair message: no answer within 10 s')
  })

  test('a wake answered through the main loop: turn.start takes the turn, an ANSWER closes it, a silent turn gets one reminder', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ release: true })
    const store = ledgerOf([entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)

    // a closed item in the milestone: the release review wakes the model
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toContain(RELEASE_KEY)
    const wake = h.prompts[0] ?? ''
    expect(wake).toStartWith('TASK release id=w')
    const id = /id=(\S+)/.exec(wake)?.[1] ?? ''

    // its turn ends without an answer: one reminder
    const before = h.seen.length
    await $.turn.start({ text: `The factory-loop plugin sent a message:\n${wake}`, turnId: 'turn-1' })
    await $.turn.complete({ turnId: 'turn-1', answer: 'Looking at the milestone.', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.settle()
    expect(h.prompts[1]).toStartWith(`TASK release id=${id}`)
    expect(h.prompts[1]?.split('\n')[0]).toEndWith('reminder=1')
    expect(h.entry(RELEASE_KEY)).toMatchObject({ status: 'running', turnId: 'turn-1', reminded: true })

    // the reminder's turn answers: the wake is done and the loop is pinged
    const passes = h.passes().length
    await $.turn.start({ text: h.prompts[1] ?? '', turnId: 'turn-2' })
    await $.turn.complete({ turnId: 'turn-2', answer: `ANSWER ${id} done`, reason: 'answer', durationMs: 900, isAborted: false })
    expect(h.entry(RELEASE_KEY)).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'done' } })
    // the turns' loop event (the wake's end; its turn taking its id and its reminder change nothing
    // an event says) is a real one in act mode: none goes to the sink (v2 SPEC 13.7.4, D-09)
    const hooked = h.seen.slice(before).filter(s => s.argv[0] === 'callum-flow-event')
    expect(hooked.length).toBeGreaterThan(0)
    expect(hooked.every(s => s.env.CALLUM_EVENTS_DIR === undefined)).toBe(true)
    await clock.advance(5_000)
    expect(h.passes().length).toBeGreaterThan(passes)
  })

  // run 2 (#536): a wake's turn starts inside its submit, as the engine starts it, and its one
  // start was logged twice, by turn.start and by the executor's finish
  const loopStatuses = (h: Host, kind: string) =>
    h.events().map(e => e.at(-1) ?? '').filter(n => n.startsWith(`kind=${kind} `)).map(n => /status=(\S+)/.exec(n)?.[1])

  test('each ledger transition logs one loop event: a task whose turns start inside their submits, its reminder included', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ release: true })
    const store = ledgerOf([entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })])
    let turns = 0
    const h = host(on, { config: ACT, run, store, submit: text => void $.turn.start({ text, turnId: `turn-${++turns}` }) })
    await $.session.start(START)
    await clock.advance(6_000)

    // the pass wakes the model for the review; its turn says nothing, so it is reminded
    expect(h.entry(RELEASE_KEY)).toMatchObject({ status: 'running', turnId: 'turn-1' })
    expect(loopStatuses(h, 'task')).toEqual(['running'])
    await $.turn.complete({ turnId: 'turn-1', answer: 'Looking at the milestone.', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.settle()
    expect(h.entry(RELEASE_KEY)).toMatchObject({ status: 'running', reminded: true, turnId: 'turn-2' })
    // the reminder's turn answers
    const id = /id=(\S+)/.exec(h.prompts[0] ?? '')?.[1] ?? ''
    await $.turn.complete({ turnId: 'turn-2', answer: `ANSWER ${id} done`, reason: 'answer', durationMs: 900, isAborted: false })
    expect(h.entry(RELEASE_KEY)).toMatchObject({ status: 'done' })
    expect(loopStatuses(h, 'task')).toEqual(['running', 'done'])
  })

  test("each ledger transition logs one loop event: a rail's tell whose turn starts inside its submit", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ beats: `device,age_s\n${OTHER},30\n` })
    let turns = 0
    const h = host(on, { config: ACT, run, submit: text => void $.turn.start({ text, turnId: `turn-${++turns}` }) })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.entry(`tell:heartbeat-other:${NOW + 5_000}`)).toMatchObject({ status: 'running', turnId: 'turn-1' })
    expect(loopStatuses(h, 'tell')).toEqual(['running'])
    await $.turn.complete({ turnId: 'turn-1', answer: '[ACTION] Owner: stop the other orchestrator.', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.advance(60_000)
    expect(h.entry(`tell:heartbeat-other:${NOW + 5_000}`)).toMatchObject({ status: 'done' })
    expect(loopStatuses(h, 'tell')).toEqual(['running', 'done'])
  })

  test('each ledger transition logs one loop event: a wake a reload left open logs nothing when its turn starts, then its end', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const key = 'task:redrive:issue-470-x:abc'
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(key, 'task', { wake: 'redrive', class: 'drive', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, wakeId: 'w1', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    await $.turn.start({ text: 'TASK redrive id=w1 repo=cbundy/dev-system issue=470', turnId: 'turn-1' })
    expect(h.entry(key)).toMatchObject({ status: 'running', turnId: 'turn-1' })
    expect(loopStatuses(h, 'task')).toEqual([])
    await $.turn.complete({ turnId: 'turn-1', answer: 'ANSWER w1 done', reason: 'answer', durationMs: 900, isAborted: false })
    expect(loopStatuses(h, 'task')).toEqual(['done'])
  })

  test('each wake gets its own id, pass after pass (v2 SPEC 13.8.1)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const f = factory({ release: true })
    const store = ledgerOf([entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })])
    const h = host(on, { config: ACT, run: f.run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    const first = /id=(\S+)/.exec(h.prompts[0] ?? '')?.[1] ?? ''
    expect(await $.tool.call({ tool: 'mcp__factory-loop__answer', id: first, decision: 'done' })).toMatchObject({ result: expect.stringContaining('Recorded') })
    // another orchestrator comes up: its notice is the next wake
    f.w.beats = `device,age_s\n${OTHER},30\n`
    await clock.advance(60_000)
    const second = /id=(\S+)/.exec(h.prompts.find(p => p.startsWith('TELL heartbeat-other')) ?? '')?.[1] ?? ''
    expect(second).not.toBe('')
    expect(second).not.toBe(first)
  })

  test("a rail's notice whose spell ended before a wake let it out is never sent (v2 SPEC 13.11.2)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const f = factory({ beats: `device,age_s\n${OTHER},30\n` })
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('judge:sequence:512:abc1234', 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - MIN, endedAt: null, wakeId: 'w9', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run: f.run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    // the notice waits for the open judge; meanwhile the other orchestrator goes quiet
    expect(h.prompts).toEqual([])
    f.w.beats = QUIET_BEATS
    await clock.advance(60_000)
    await $.tool.call({ tool: 'mcp__factory-loop__answer', id: 'w9', decision: 'merge' })
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('TELL heartbeat-other'))).toEqual([])
  })

  test('a change of repo loads that repo\'s ledger before anything acts', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let origin = REPO
    const other = 'cbundy/other'
    const f = factory({
      run: argv => {
        if (argv.join(' ') === 'git remote get-url origin') return { stdout: `https://github.com/${origin}.git\n` }
        if (argv[0] === 'callum-flow-factory-state' && argv.includes(other)) return { stdout: JSON.stringify({ at: iso(NOW), repos: [{ repo: other, issues: [], recent: [] }] }) }
        return undefined
      },
    })
    const h = host(on, {
      config: ACT,
      run: f.run,
      store: {
        [`ledger:${other}`]: { v: 1, savedAt: NOW - MIN, entries: [entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - MIN, endedAt: NOW - MIN }), entry(CLAIM_KEY, 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN })] },
      },
    })
    await $.session.start(START)
    await clock.advance(6_000)
    // the workspace now names another repo, whose queue has 470, and whose ledger ran out of claims on it
    origin = other
    h.files.set(`${CFG_DIR}/factory-loop/config.json`, JSON.stringify({ ...ACT, repo: other }))
    f.w.queue = [470]
    await clock.advance(3 * MIN)
    expect(h.files.has(`${CFG_DIR}/factory-loop/cbundy__other/act.lock`)).toBe(true)
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    const lines = (h.files.get(`${CFG_DIR}/factory-loop/cbundy__other/decisions-${iso(NOW).slice(0, 10)}.jsonl`) ?? '').split('\n').filter(l => l !== '')
    expect(JSON.parse(lines.at(-1) ?? '{}').skipped).toContainEqual({ rule: 'S1', issue: 470, why: `exhausted: ${CLAIM_KEY}` })
  })

  test('the answer tool closes an open wake; from inside an agent it is refused', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('judge:sequence:512:abc1234', 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - MIN, endedAt: null, wakeId: 'w9', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    const fromAgent = await $.tool.call({ tool: 'mcp__factory-loop__answer', id: 'w9', decision: 'merge', agentId: 'agent-1' })
    expect(fromAgent).toMatchObject({ deny: expect.stringContaining('only the main conversation') })
    const r = await $.tool.call({ tool: 'mcp__factory-loop__answer', id: 'w9', decision: 'merge' })
    expect(r).toMatchObject({ result: 'Recorded: w9 merge. No ANSWER block is needed.' })
    await clock.settle()
    expect(h.entry('judge:sequence:512:abc1234')).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'merge' } })
  })

  // two open wakes, where the loop event of the first one's end hangs until the test lets it go:
  // the hook work that logs it holds the hook queue meanwhile, as a busy session does (#558)
  const heldQueue = (on: Parameters<typeof host>[0]) => {
    const first = 'task:redrive:issue-470-x:abc'
    const second = 'judge:sequence:512:abc1234'
    const held = `kind=task key=${first} status=done`
    let release: () => void = () => undefined
    const holding = new Promise<Answer>(resolve => (release = () => resolve({})))
    const { run } = factory({ run: argv => (argv[0] === 'callum-flow-event' && (argv.at(-1) ?? '').startsWith(held) ? holding : undefined) })
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(first, 'task', { wake: 'redrive', class: 'drive', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, wakeId: 'w1', session: SESSION }),
      entry(second, 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - 9 * MIN, endedAt: null, wakeId: 'w2', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run, store })
    return { h, first, second, release: () => release() }
  }

  test("the owner's answer and control tools are answered while other hook work holds the queue; a wake's answer is saved at once, the events, lines and pings follow (#558)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { h, first, second, release } = heldQueue(on)
    await $.session.start(START)
    await clock.advance(6_000)
    // the main loop answers the first wake: its loop event hangs, and the hook queue with it
    const turn = $.turn.complete({ turnId: 'turn-1', answer: 'ANSWER w1 done', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.settle()
    expect(h.entry(first)).toMatchObject({ status: 'done' })
    const answers: unknown[] = []
    void $.tool.call({ tool: 'mcp__factory-loop__answer', id: 'w2', decision: 'hold', reason: 'held' }).then(r => answers.push(r))
    await clock.settle()
    void $.tool.call({ tool: 'mcp__factory-loop__control', op: 'pause 470' }).then(r => answers.push(r))
    await clock.settle()
    expect(answers).toEqual([{ result: expect.stringContaining('Recorded: w2 hold') }, { result: expect.stringContaining('Paused #470') }])
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ paused: [470] })
    // the second wake's answer is in the store at once; its loop event and the op's line wait their turn
    expect(h.entry(second)).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'hold' } })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${second} status=done`))).toBe(false)
    expect(h.lines().some(l => l.control === 'pause 470')).toBe(false)

    release()
    await turn
    await clock.settle()
    expect(h.entry(second)).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'hold' } })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${second} status=done`))).toBe(true)
    expect(h.lines().some(l => l.control === 'pause 470')).toBe(true)
  })

  test("the loop's own agent types are never offered to the model, v2's steps included; the callum-flow ones are (#548)", ENGINE_TEST, async ($, on) => {
    host(on, { config: ACT })
    const offer = (agent: string) => $.agent.offer({ agent, description: 'an agent', source: 'plugin', provider: { plugin: agent.split(':')[0] ?? '', tier: 'user' } })
    for (const agent of ['factory-loop:adjudicator', 'factory-loop:designer', ...new Set(Object.values(STEP_AGENT))]) expect(await offer(agent)).toEqual({ isOffered: false })
    expect(await offer('callum-flow:adjudicator')).toEqual({ isOffered: true })
    expect(await offer('callum-flow:designer')).toEqual({ isOffered: true })
  })

})

describe('act mode: engine calls, timeouts and what may run (v2 SPEC 13.4.2, 13.6.1, 13.8.2, 13.10 item 7, 13.11.3, 13.13)', () => {
  test('shadowDevice stands in only while nothing executes: act mode plans as this device (v2 SPEC 13.4.2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const head = 'a'.repeat(40)
    const { run } = factory({
      queue: [470],
      run: argv => {
        if (argv[0] === 'callum-flow-factory-state') {
          return { stdout: factoryDoc([{ issue: 471, stage: 'parked', entered_at: iso(NOW - 10 * MIN), holder: OTHER, run: '01K7S1AAAAAAAAAAAAAAAAAAAA', pr: 571, stuck: null, github: null }]) }
        }
        if (argv[0] === `${TOOLS}/pipeline-watch.sh`) return { stdout: `parked issue-471-other 01K7S1AAAAAAAAAAAAAAAAAAAA step=review pr=571 head=${head}\n` }
        // a live issue is read whoever holds it (#556): it is still open
        if (argv.join(' ') === 'callum-flow-issue-read --json 471') {
          const issue = { number: 471, title: 'Other work', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }
          return { stdout: JSON.stringify({ issue, stripped: 0 }) }
        }
        return undefined
      },
    })
    const h = host(on, { config: { ...ACT, shadowDevice: OTHER }, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ executed: true, device: DEVICE })
    // the other device's parked run is not this loop's to drive; the claim is this device's own
    expect((line.actions as { key: string }[]).map(a => a.key)).toEqual([CLAIM_KEY, 'sweep:0'])
    expect(h.spawns).toEqual([])
    expect(h.commands().find(s => s.argv[0] === 'callum-flow-claim')?.argv).toEqual(['callum-flow-claim', '470'])
  })

  test('a judge past its timeout is held in the pass, logged, and the notice it held back goes out (v2 SPEC 13.8.2, 13.10 item 8)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ queue: [470] })
    const judge = 'judge:sequence:512:abc1234'
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      // a claim that used up its attempts: the owner is told (rule S1), once the judge no longer holds the wake
      entry(CLAIM_KEY, 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: since, endedAt: NOW - 10 * MIN }),
      entry(judge, 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - 31 * MIN, endedAt: null, wakeId: 'w9', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.entry(judge)).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'hold' } })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${judge} status=done`))).toBe(true)
    expect(h.prompts.filter(p => p.startsWith('TELL stalled id=w'))).toHaveLength(1)
  })

  test('a ledger rebuilt from the event log after a lost store is the one the loop keeps and acts on (v2 SPEC 13.7.5)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const told = entry('tell:stalled:i470/claim/old:1', 'tell', { wake: 'stalled', class: 'owner', rule: 'S1', issue: 470, status: 'done', startedAt: NOW - 29 * MIN, endedAt: NOW - 28 * MIN })
    const row = (e: LedgerEntry) => `${iso(e.endedAt ?? e.startedAt)},loop,470,,,,,"${loopEventArgs(e).at(-1)}",loop,${DEVICE}`
    const events = [NO_EVENTS.trim(), row(told)].join('\n') + '\n'
    const { run } = factory({ run: (argv, s) => (argv[0] === 'dev-query' && !(s.stdin ?? '').includes('workers_status') ? { stdout: events } : undefined) })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'events' })
    expect(h.entry(told.key)).toMatchObject({ status: 'done', wake: 'stalled' })
    // the notice was told before the store was lost: it is not told twice
    expect(h.prompts).toEqual([])
  })

  test('a wake the event log rebuilds from an earlier session is lost at once, so the next pass can wake (v2 SPEC 13.7.5, O2)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // run 1 left a judge open; run 2 starts with the store cleared
    const judge = 'judge:sequence:512:abc1234'
    const open = entry(judge, 'judge', { wake: 'sequence', class: 'drive', rule: 'M5', issue: 470, pr: 512, status: 'running', startedAt: NOW - 13 * MIN, endedAt: null })
    const row = (e: LedgerEntry) => `${iso(e.endedAt ?? e.startedAt)},loop,470,,,,,"${loopEventArgs(e).at(-1)}",loop,${DEVICE}`
    const events = [NO_EVENTS.trim(), row(open)].join('\n') + '\n'
    const { run } = factory({ run: (argv, s) => (argv[0] === 'dev-query' && !(s.stdin ?? '').includes('workers_status') ? { stdout: events } : undefined) })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'events' })
    // nobody can answer it: lost with its attempt given back, so its rule decides again
    expect(h.entry(judge)).toMatchObject({ status: 'lost', attempts: 0, summary: 'lost: it was open before this load' })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${judge} status=lost`))).toBe(true)
    expect((h.last().skipped as { why: string }[]).map(s => s.why)).not.toContain('a wake is open')
  })

  test('usage past Stop all skips the token-spending action, with no attempt counted (v2 SPEC 13.10 item 7)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run })
    h.usage = [{ kind: 'five_hour', percentUsed: 96 }]
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ tier: 'stop-all' })
    expect(h.last().skipped).toContainEqual(expect.objectContaining({ issue: 470, why: expect.stringContaining('tier stop-all') }))
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect(h.entry(CLAIM_KEY)).toBeUndefined()
  })

  // a claim that used up its attempts: the loop tells the owner (rule S1), a tell wake
  const stalled = (submit: HostOptions['submit']) => async ($: Engine, on: Parameters<typeof host>[0]) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(CLAIM_KEY, 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: NOW - 15 * MIN, endedAt: NOW - 2 * MIN, summary: 'gh: HTTP 500' }),
    ])
    const h = host(on, { config: ACT, run, store, submit })
    await $.session.start(START)
    await clock.advance(6_000)
    return { clock, h, wake: `tell:stalled:${CLAIM_KEY}:${NOW - 2 * MIN}` }
  }

  test('a wake prompt the engine drops is never left open: it uses no attempt, and the next pass asks again (v2 SPEC 13.8.1)', ENGINE_TEST, async ($, on) => {
    let drops = 1
    const { clock, h, wake } = await stalled(() => (drops-- > 0 ? { drop: 'the session is shutting down' } : undefined))($, on)
    expect(h.entry(wake)).toBeUndefined()
    const out = (h.last().outcomes as { key: string; status: string; summary: string }[]).find(o => o.key === wake)
    expect(out).toMatchObject({ status: 'skipped' })
    expect(out?.summary).toContain('dropped: the session is shutting down')
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('TELL stalled id=w'))).toHaveLength(2)
    expect(h.entry(wake)).toMatchObject({ status: 'running', attempts: 1 })
  })

  test('a busy session never holds a pass: the wake is taken as queued after 5 s, and a later drop asks again', ENGINE_TEST, async ($, on) => {
    let drop: (r: { drop?: string }) => void = () => undefined
    let first = true
    const { clock, h, wake } = await stalled(() => (first ? ((first = false), new Promise(resolve => (drop = resolve))) : undefined))($, on)
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(1)
    expect(h.entry(wake)).toMatchObject({ status: 'running' })
    drop({ drop: 'the queue was cleared' })
    await clock.settle()
    // lost with its attempt given back, and its end logged, since its start was
    expect(h.entry(wake)).toMatchObject({ status: 'lost', attempts: 0, summary: 'submit dropped: the queue was cleared' })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=tell key=${wake} status=lost`))).toBe(true)
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('TELL stalled id=w'))).toHaveLength(2)
    expect(h.entry(wake)).toMatchObject({ status: 'running', attempts: 1 })
  })

  test("a rail's notice the engine drops after the submit goes out again (v2 SPEC 13.9.2, 13.11.2)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let drop: (r: { drop?: string }) => void = () => undefined
    let first = true
    const { run } = factory({ beats: `device,age_s\n${OTHER},30\n` })
    const h = host(on, { config: ACT, run, submit: () => (first ? ((first = false), new Promise(resolve => (drop = resolve))) : undefined) })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(5_000)
    expect(h.prompts.filter(p => p.startsWith('TELL heartbeat-other'))).toHaveLength(1)
    drop({ drop: 'the queue was cleared' })
    await clock.settle()
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('TELL heartbeat-other'))).toHaveLength(2)
    // delivered this time: told once more, never again
    await $.turn.start({ text: h.prompts.at(-1) ?? '', turnId: 'turn-1' })
    await $.turn.complete({ turnId: 'turn-1', answer: '[ACTION] Owner: stop the other orchestrator.', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('TELL heartbeat-other'))).toHaveLength(2)
  })

  test("a wake another session submitted is lost with its session; one this session's reload left open stays (v2 SPEC 13.7.5)", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('task:redrive:issue-470-x:abc', 'task', { wake: 'redrive', class: 'drive', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, wakeId: 'w1', session: 'session-before' }),
      entry('judge:sequence:512:abc1234', 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, wakeId: 'w2', session: 'session-before' }),
      entry('tell:blind:0', 'tell', { wake: 'blind', class: 'owner', status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, wakeId: 'w3', session: 'session-before' }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    // each with its attempt given back, so its rule decides again rather than holding on a fallback
    expect(h.entry('task:redrive:issue-470-x:abc')).toMatchObject({ status: 'lost', attempts: 0, summary: 'lost: its session ended' })
    expect(h.entry('judge:sequence:512:abc1234')).toMatchObject({ status: 'lost', attempts: 0 })
    expect(h.entry('judge:sequence:512:abc1234')?.outcome).toBeUndefined()
    expect(h.entry('tell:blind:0')).toMatchObject({ status: 'lost', attempts: 0 })
    // none holds the one open wake any longer (rule O2)
    expect(h.ledger().filter(e => e.status === 'running')).toEqual([])
  })

  test("a reload within one session keeps that session's open wake", ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('task:redrive:issue-470-x:abc', 'task', { wake: 'redrive', class: 'drive', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, wakeId: 'w1', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.entry('task:redrive:issue-470-x:abc')).toMatchObject({ status: 'running' })
  })

  for (const [name, stop] of [['the kill switch', 'OFF'], ['mode observe', 'observe']] as const) {
    test(`under ${name} an open wake gets no reminder and its turn changes nothing (v2 SPEC 13.11.1, 13.11.3)`, ENGINE_TEST, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const { run } = factory()
      const judge = 'judge:sequence:512:abc1234'
      const store = ledgerOf([
        entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
        entry(judge, 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - MIN, endedAt: null, wakeId: 'w9', session: SESSION, summary: 'JUDGE sequence id=w9 repo=cbundy/dev-system pr=512' }),
      ])
      const h = host(on, { config: ACT, run, store })
      await $.session.start(START)
      await clock.advance(6_000)
      if (stop === 'OFF') h.files.set(`${CFG_DIR}/factory-loop/OFF`, '')
      else h.files.set(`${CFG_DIR}/factory-loop/config.json`, JSON.stringify({ ...ACT, mode: 'observe' }))
      await clock.advance(60_000)
      const prompts = h.prompts.length
      const events = h.events().length
      await $.turn.start({ text: 'JUDGE sequence id=w9 repo=cbundy/dev-system pr=512', turnId: 'turn-1' })
      await $.turn.complete({ turnId: 'turn-1', answer: 'Thinking it over.', reason: 'answer', durationMs: 900, isAborted: false })
      await clock.settle()
      expect(h.prompts).toHaveLength(prompts)
      expect(h.events()).toHaveLength(events)
      expect(h.entry(judge)).toMatchObject({ status: 'running' })
      expect(h.entry(judge)?.reminded).toBeUndefined()
    })
  }
})

describe('act mode: the owner\'s controls (v2 SPEC 13.4.3, D-38)', () => {
  test('/factory ops write control.json, log the change, ping a pass; status reads the last pass', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)

    expect(await factoryOp($, 'pause 470')).toMatchObject({ text: 'Paused #470: no action on it until unpause; its claim still renews.' })
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ paused: [470] })
    // its line and ping follow the answer (#558)
    await clock.settle()
    expect(h.lines().some(l => l.control === 'pause 470')).toBe(true)
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(2)

    const status = await factoryOp($, 'status')
    expect(status.text).toStartWith('Pass 2, 1s ago: act, tier normal, 0 actions, 0 for the owner.')
    expect(status.text).toContain('Directives: paused #470.')

    const tool = await $.tool.call({ tool: 'mcp__factory-loop__control', op: 'new off' })
    expect(tool).toMatchObject({ result: 'New work off: no new claims, designs or implementations; work in flight goes on.' })
    const agentOp = await $.tool.call({ tool: 'mcp__factory-loop__control', op: 'new on', agentId: 'agent-1' })
    expect(agentOp).toMatchObject({ deny: 'Not changed: only the main conversation sets owner directives.' })
    expect(await factoryOp($, 'pause')).toMatchObject({ text: 'pause: takes one issue number. Usage: pause <N>' })
  })

  test('/factory config shows the settings of the last pass, not the files as they are now (#698)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const file = `${CFG_DIR}/factory-loop/config.json`
    const before = (await factoryOp($, 'config')).text
    expect(before).toContain('passEvery       1m')
    expect(before).toContain('act')
    // the file changes after the pass, and no pass has run since
    h.files.set(file, JSON.stringify({ ...JSON.parse(h.files.get(file) ?? '{}'), passEvery: '5m' }))
    expect((await factoryOp($, 'config')).text).toBe(before)
    const control = h.files.get(`${LOOP_DIR}/control.json`)
    const tool = await $.tool.call({ tool: 'mcp__factory-loop__control', op: 'config', agentId: 'agent-1' })
    expect(tool).toMatchObject({ result: before })
    expect(h.files.get(`${LOOP_DIR}/control.json`)).toBe(control)
    await clock.advance(61_000)
    expect((await factoryOp($, 'config')).text).toContain('passEvery       5m')
  })

  test('/factory retry clears the issue\'s exhausted entries in the ledger', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: NOW - 30 * MIN, endedAt: NOW - 20 * MIN }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    const r = await factoryOp($, 'retry 470')
    expect(r.text).toBe('Retry #470: cleared 1 exhausted action (claim:470:new); its rules try again from the next pass.')
    // cleared in memory at once, and in the store once the op has its answer (#558)
    await clock.settle()
    expect(h.entry('claim:470:new')).toMatchObject({ attempts: 0, summary: 'attempts cleared by the owner (/factory retry)' })
  })

  test('passes start at least 5 s apart, and a ping storm falls back to the timer and tells the owner once (D-39)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    // two pings at once: one more pass, 5 s after the last one started (at 5 s)
    await factoryOp($, 'serial on')
    await factoryOp($, 'serial off')
    await clock.advance(3_000)
    expect(h.passes()).toHaveLength(1)
    await clock.advance(1_000)
    expect(h.passes()).toHaveLength(2)

    for (let i = 0; i < 60 && !h.prompts.some(p => p.startsWith('TELL breaker')); i++) {
      await factoryOp($, i % 2 === 0 ? 'serial on' : 'serial off')
      await clock.advance(5_000)
    }
    expect(h.prompts.filter(p => p.startsWith('TELL breaker id=w'))).toHaveLength(1)
    expect(h.prompts.find(p => p.startsWith('TELL breaker'))).toContain('kind=ping')
    expect(h.lines().some(l => l.breaker !== undefined)).toBe(true)
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith('kind=breaker key=breaker:pings:'))).toBe(true)
    // pings are ignored now: an op changes control.json, and no pass follows until the timer's next
    // tick (every 60 s from the session's start), which runs exactly one
    const before = h.passes().length
    const tick = NOW + Math.ceil((clock.now() + 1 - NOW) / 60_000) * 60_000
    await factoryOp($, 'serial on')
    await clock.advance(tick - 1 - clock.now())
    expect(h.passes().length).toBe(before)
    await clock.advance(6_000)
    expect(h.passes().length).toBe(before + 1)
    // and the timer goes on while pings are ignored
    await factoryOp($, 'serial off')
    await clock.advance(60_000)
    expect(h.passes().length).toBe(before + 2)
  })

  test('two owner ops at once both land in control.json: they run one at a time', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    await Promise.all([factoryOp($, 'pause 470'), factoryOp($, 'skip 471')])
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ paused: [470], skip: [471] })
  })

  test('an op whose own work outruns 2 s answers within it: refused, writing nothing, before its change; unsure once its write began (#558)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const control = `${LOOP_DIR}/control.json`
    let slow: { op: 'read' | 'write'; until: Promise<void> } | null = null
    let release: () => void = () => undefined
    const holdNext = (op: 'read' | 'write') => (slow = { op, until: new Promise<void>(resolve => (release = resolve)) })
    const h = host(on, { config: ACT, run: factory().run, hold: (path, op) => (path === control && slow?.op === op ? slow.until : undefined) })
    await $.session.start(START)
    await clock.advance(6_000)
    const answers: unknown[] = []

    // control.json's read hangs: refused at 2 s, and the op writes nothing once the read returns
    holdNext('read')
    void $.tool.call({ tool: 'mcp__factory-loop__control', op: 'pause 470' }).then(r => answers.push(r))
    await clock.advance(2_000)
    expect(answers).toEqual([{ deny: 'factory-loop: the op could not run in time; nothing was changed.' }])
    slow = null
    release()
    await clock.settle()
    expect(h.files.has(control)).toBe(false)
    expect(h.lines().some(l => l.control === 'pause 470')).toBe(false)

    // its write hangs: the answer says it may have taken, and once written it is logged as a change
    holdNext('write')
    void $.tool.call({ tool: 'mcp__factory-loop__control', op: 'skip 471' }).then(r => answers.push(r))
    await clock.advance(2_000)
    expect(answers[1]).toEqual({ deny: 'factory-loop: the op was still being written when it had to answer; /factory status shows whether it took.' })
    slow = null
    release()
    await clock.settle()
    expect(JSON.parse(h.files.get(control) ?? '{}')).toMatchObject({ skip: [471], paused: [] })
    expect(h.lines().some(l => l.control === 'skip 471')).toBe(true)
  })
})

describe('the pass summary event (#680)', () => {
  const passesEvents = (h: Host) => h.events().filter(e => (e.at(-1) ?? '').startsWith('kind=passes '))
  const field = (argv: string[], name: string) => (argv.at(-1) ?? '').split(' ').find(t => t.startsWith(`${name}=`))?.slice(name.length + 1)

  test('act mode sends one per minute, its count the decision log lines whose time falls in the minute', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: { ...ACT, passEveryMs: 20_000 }, run })
    await $.session.start(START)
    await clock.advance(5 * 60_000 + 1_000)
    const events = passesEvents(h)
    // the minutes that ended: the first at NOW + 1 min, none from the one still open
    expect(events).toHaveLength(5)
    expect(events[0]).toEqual(['callum-flow-event', 'loop', '--note', expect.stringContaining('kind=passes key=passes:')])
    const lines = h.passes()
    expect(lines.length).toBeGreaterThan(10)
    events.forEach((e, i) => {
      const from = NOW + i * 60_000
      expect(field(e, 'key')).toBe(`passes:${from}`)
      expect(field(e, 'status')).toBe('done')
      expect(field(e, 'from')).toBe(iso(from))
      expect(field(e, 'to')).toBe(iso(from + 60_000))
      const inMinute = lines.filter(l => Date.parse(String(l.at)) >= from && Date.parse(String(l.at)) < from + 60_000)
      expect(Number(field(e, 'passes'))).toBe(inMinute.length)
      expect(field(e, 'mode')).toBe('act')
      expect(field(e, 'planner')).toBe('v2')
      expect(field(e, 'pass_every_ms')).toBe('20000')
    })
    // no per-pass event: only the minutes' summaries
    expect(h.events().filter(e => (e.at(-1) ?? '').startsWith('kind=passes'))).toHaveLength(5)
  })

  test('a minute in which a pass hangs sends passes=0', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let hang = false
    const { run } = factory({
      run: argv => {
        if (hang && argv[0] === 'callum-flow-factory-state') return gate.then(() => ({ stdout: factoryDoc([]) }))
        return undefined
      },
    })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(10_000)
    expect(h.passes()).toHaveLength(1)
    hang = true
    await clock.advance(4 * 60_000)
    const counts = passesEvents(h).map(e => field(e, 'passes'))
    expect(counts.length).toBeGreaterThanOrEqual(3)
    expect(counts[0]).toBe('1')
    expect(counts.slice(2)).toContain('0')
    const empty = passesEvents(h).find(e => field(e, 'passes') === '0')
    expect(field(empty ?? [], 'mean_ms')).toBe('none')
    expect(field(empty ?? [], 'acting_mean_ms')).toBe('none')
    release()
  })

  for (const [name, config, files] of [
    ['mode off', { ...ACT, mode: 'off' }, {}],
    ['the kill switch', ACT, { [`${CFG_DIR}/factory-loop/OFF`]: '' }],
    ['observe mode', { ...ACT, mode: 'observe' }, {}],
  ] as const) {
    test(`${name} sends none`, ENGINE_TEST, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const { run } = factory()
      const h = host(on, { config, run, files })
      await $.session.start(START)
      await clock.advance(4 * 60_000)
      expect(passesEvents(h)).toEqual([])
    })
  }

  test('the kill switch set after passes ran stops the summaries', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(2 * 60_000 + 1_000)
    const before = passesEvents(h).length
    expect(before).toBe(2)
    h.files.set(`${CFG_DIR}/factory-loop/OFF`, '')
    await clock.advance(3 * 60_000)
    expect(passesEvents(h)).toHaveLength(before)
  })
})
