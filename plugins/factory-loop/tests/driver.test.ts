// The pass driver (register.ts) end to end, in the engine's own test host (tests/host.ts):
// files, the store, commands, agents, prompts and /rename are answered by the test's hooks. In
// observe mode a pass reads, plans, logs and titles, and every command's event writes go to the
// sink (SPEC 11.1). In act mode the rails come first (SPEC 11.2), the ledger lives in $.store,
// the hooks feed it between passes (an agent's answer, a wake's turn), and the owner's controls
// ping the loop (SPEC 2, 4.3, 7, 8, 10). The engine's test host never hands a plugin's
// $.agent.spawn an agent id, so agents that start are seeded in the store here; act.test.ts runs
// whole spawns through act.ts.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { loopEventArgs } from '../hooks/derive'
import { answerPath, pruneArgvs } from '../hooks/exec'
import type { LedgerEntry } from '../hooks/types'
import { DEVICE, MIN, NOW, OTHER, entry } from './fixtures'
import { CFG_DIR, LOCK, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, SESSION, TOOLS, agentDone, factoryDoc, host, iso } from './host'
import type { Host, HostOptions, Seen } from './host'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
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
const READS = ['callum-flow-factory-state', 'dev-query', 'callum-flow-issue-read', `${TOOLS}/usage-check.sh`, 'callum-flow-milestone', 'git']

function shadow(on: Parameters<typeof host>[0], reads: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  return host(on, {
    config: { repo: REPO, runSource: 'events', shadowDevice: DEVICE, checkout: '/work', ...config },
    env: { DEV_MACHINE_NAME: 'coder-spike' },
    run: argv => {
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

describe('observe mode (SPEC 11.1)', () => {
  test('one pass reads, plans, logs and titles, and runs only reads, their events to the sink', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on)
    await $.session.start(START)
    await clock.advance(6_000)

    expect(h.titles).toEqual(['🔄 dev-system (Q:0 - D:1 - M:0) · observe'])
    expect(h.passes()).toHaveLength(1)
    expect(h.last()).toMatchObject({ mode: 'observe', executed: false, device: DEVICE, tier: 'normal' })
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual([`adjudicate:R45:park@${NOW - 600_000}:h1`])
    expect([...h.files.keys()]).toContain(`${LOOP_DIR}/decisions-${iso(NOW).slice(0, 10)}.jsonl`)

    // nothing but reads ran, and every one of them wrote its events to the sink
    expect(h.commands().filter(s => !READS.includes(s.argv[0] ?? '')).map(s => s.argv.join(' '))).toEqual([])
    expect(h.commands().every(s => s.env.CALLUM_EVENTS_DIR === SINK && s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
    // the state was recorded for the replay tools
    expect([...h.files.keys()].some(p => p.startsWith(`${LOOP_DIR}/states/`))).toBe(true)
  })

  test('it never keeps a ledger, takes the act lock, spawns or wakes the model', async ($, on) => {
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

  test('the repo-local settings are loaded through the config loader (SPEC 4.2)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on)
    h.files.set('/work/.claude/factory-loop.json', JSON.stringify({ readyLabel: 'go', queueEvery: '10m', colour: 'blue' }))
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.seen.some(s => s.argv.join(' ') === 'callum-flow-issue-read --json --list --label go')).toBe(true)
    expect(h.last().config).toEqual(['colour: unknown setting'])
    // the configured labels reach the CLIs through the environment
    expect(h.commands()[0]?.env).toMatchObject({ CALLUM_FLOW_READY_LABEL: 'go', CALLUM_FLOW_IN_DEV_LABEL: 'in development' })
    // the queue is read every 10 minutes now, so the next pass does not read it again
    const before = h.seen.filter(s => s.argv.includes('--list')).length
    await clock.advance(60_000)
    expect(h.seen.filter(s => s.argv.includes('--list')).length).toBe(before)
  })

  test('a tracker named in only has its timeline read, then its sub-issues (D-35)', async ($, on) => {
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
    expect(read()).toContain('--json 40')
    expect(read()).toContain('--json --timeline 40')
    await clock.advance(60_000)
    expect(read()).toContain('--json 41')
    expect(read()).toContain('--json 42')
  })

  test('binDir goes ahead of PATH and toolsDir places the watchers (a testbed)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on, {}, { binDir: '/work/images/base', toolsDir: '/work/features/src/callum-tools' })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.commands()[0]?.env.PATH).toStartWith('/work/images/base:')
    expect(h.seen.some(s => s.argv[0] === '/work/features/src/callum-tools/usage-check.sh')).toBe(true)
  })

  test('once a day the loop dir loses its files older than a week (SPEC 11.6)', async ($, on) => {
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

  test('with no session.start (a plugin /reload-plugins adds), the first session.append starts the loop (SPEC 2)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on)
    mock.session(on)
    await $.session.append(row({ kind: 'composer' }, 'hello', 'u1'))
    await clock.advance(6_000)
    expect(h.passes()).toHaveLength(1)
  })

  test('a session no person reaches (a -p run, such as a pipeline review) never runs the loop, whatever its rows (D-61)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act' } })
    mock.session(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.session.append(row({ kind: 'composer' }, 'review this diff', 'u1'))
    await clock.advance(5 * 60_000)
    expect(h.seen).toEqual([])
    expect(h.titles).toEqual([])
  })

  test('the note /rename leaves for the model is blanked as it is stored; other rows are kept (SPEC 9.1, FINDINGS check 3)', async ($, on) => {
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

  test('mode off reads nothing and says so in the title', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'off' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    expect(h.seen).toEqual([])
  })
})

// --- act mode ---------------------------------------------------------------------------------------

type Issue = { stage: string; since: number; run?: string | null; pr?: number | null }

// factory: a small world of canned CLIs: issue 470 in the queue or at a stage, the rest quiet.
type Answer = { exitCode?: number; stdout?: string; stderr?: string }
function factory(over: { queue?: number[]; issue?: Issue | null; beats?: string; run?: (argv: string[], s: Seen) => Answer | Promise<Answer> | undefined } = {}) {
  const w = { queue: over.queue ?? [], issue: over.issue ?? null, beats: over.beats ?? QUIET_BEATS }
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

describe('act mode: the pass (SPEC 2, 7, 12)', () => {
  test('the rails pass, the pass acts in plan order, and the store keeps the ledger', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    expect([...h.registered].sort()).toEqual(['/factory', 'mcp__factory-loop__answer', 'mcp__factory-loop__control', 'mcp__factory-loop__design', 'mcp__factory-loop__handoff', 'mcp__factory-loop__verdict'])
    await clock.advance(6_000)

    const line = h.last()
    expect(line).toMatchObject({ mode: 'act', executed: true, ledgerSource: 'none', device: DEVICE })
    expect(line.rails).toBeUndefined()
    expect(line.outcomes).toEqual([
      { key: 'sweep:0', status: 'done', ms: 0, summary: 'swept' },
      { key: 'claim:470:new', status: 'done', ms: 0, summary: 'claimed #470' },
    ])
    expect(line.commands).toContain('callum-flow-claim 470')
    expect(h.entry('claim:470:new')).toMatchObject({ status: 'done', attempts: 1, outcome: { kind: 'claim', result: 'claimed' } })
    expect(JSON.parse(h.files.get(LOCK) ?? '{}')).toMatchObject({ session: SESSION, expiresAt: NOW + 5_000 + 15 * MIN })
    expect(h.store.get(`queue-known:${REPO}`)).toEqual([470])
    // act mode's commands write real events: no sink
    expect(h.commands().every(s => s.env.CALLUM_EVENTS_DIR === undefined && s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
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
      name: 'a checkout of another repo',
      run: argv => (argv.join(' ') === 'git remote get-url origin' ? { stdout: 'git@github.com:cbundy/plant-console.git\n' } : undefined),
      reason: 'repo: the checkout /work is cbundy/plant-console, not cbundy/dev-system',
      tell: null,
      lockless: true,
    },
  ]
  for (const r of rails) {
    test(`a rail refuses act: ${r.name}; the pass runs as observe`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const { run } = factory({ queue: [470], beats: r.beats, run: r.run })
      const h = host(on, { config: ACT, run, files: r.files, env: r.env })
      await $.session.start(START)
      await clock.advance(6_000)
      const line = h.last()
      expect(line).toMatchObject({ mode: 'act', executed: false })
      expect((line.rails as string[]).join(' | ')).toContain(r.reason)
      // it planned the claim and ran nothing but reads, their events to the sink
      expect((line.actions as { key: string }[]).map(a => a.key)).toContain('claim:470:new')
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

  test('a heartbeat notice keeps its key in the ledger and is logged as a loop event', async ($, on) => {
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

  test('the kill switch stops act mode within a pass: nothing read, nothing run', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470] })
    const h = host(on, { config: ACT, run, files: { [`${CFG_DIR}/factory-loop/OFF`]: '' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    expect(h.seen).toEqual([])
    expect([...h.store.keys()]).toEqual([])
    // removing it resumes the configured mode at the next pass
    h.files.delete(`${CFG_DIR}/factory-loop/OFF`)
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true })
  })

  test('a restart mid-action: running commands are lost, agents are reconciled against the list (SPEC 7.5)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const started = NOW - 10 * MIN
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'running', startedAt: started, endedAt: null }),
      entry('design:470:1', 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: started, endedAt: null, agentId: 'agent-alive' }),
      entry('fixer:gate:R:review:h', 'spawn', { agent: 'fixer', class: 'drive', issue: 471, status: 'running', startedAt: started, endedAt: null, agentId: 'agent-gone' }),
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
    expect(loops.some(n => n.startsWith('kind=spawn key=fixer:gate:R:review:h status=lost'))).toBe(true)
    expect(loops.some(n => n.includes('key=heartbeat:0'))).toBe(false)
  })

  test('the restart for an update ran: the update is done and the drain ends (rule H4)', async ($, on) => {
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

  test('a restart that returned keeps the drain and stops acting until the workspace is replaced (rule H4, D-15)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const f = factory()
    const store = ledgerOf([entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })])
    const h = host(on, { config: ACT, run: f.run, store, files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: 777 } }) } })
    await $.session.start(START)
    await clock.advance(6_000)
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

  test('the new workspace finds the restart done before it loaded: the update is done (rule H4)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const store = ledgerOf([entry('restart:777', 'restart-self', { rule: 'H4', status: 'done', startedAt: NOW - 3 * MIN, endedAt: NOW - 3 * MIN })])
    const h = host(on, { config: ACT, run, store, files: { [`${LOOP_DIR}/control.json`]: JSON.stringify({ updateDue: { reason: 'image', at: 777 } }) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ updateDue: null })
    expect(h.last()).toMatchObject({ executed: true })
  })

  test('a GitHub rate limit is kept in the store: the next passes skip the GitHub reads and say gh wait (SPEC 10.2)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory({ queue: [470], run: argv => (argv[0] === 'callum-flow-claim' ? { exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)' } : undefined) })
    const h = host(on, { config: ACT, run })
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

  test('a rate-cap hold is one loop event per cap per hour (SPEC 11.4, D-24)', async ($, on) => {
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

  test('three passes in a row that throw tell the owner once, and the title shows error (SPEC 10.9)', async ($, on) => {
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
    await clock.advance(60_000)
    expect(h.titles.at(-1)).toBe(good)
  })

  test('session.end releases this session\'s act lock, so the next session acts at once', async ($, on) => {
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

describe('act mode: the one writer, and reads that fail (SPEC 3.3, 7.5, 11.2)', () => {
  const ledgerKey = `ledger:${REPO}`
  const otherLease = (expiresAt: number) => JSON.stringify({ session: 'session-other', renewedAt: NOW - MIN, expiresAt })

  // another session takes the lock while the sweep runs (this one's lease ran out under it); its
  // own lease may still be live, or have run out in turn
  for (const [name, expiresAt] of [['live', NOW + 30 * MIN], ['expired since', NOW + 1_000]] as const) {
    test(`a session that loses the act lock mid-pass (the other lease ${name}) runs nothing more and never writes the ledger again`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      let atLoss = ''
      let h: Host | undefined
      const { run } = factory({
        queue: [470],
        run: argv => {
          if (argv[0] === 'callum-flow-sweep' && h !== undefined) {
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
        { key: 'sweep:0', status: 'done', ms: 0, summary: 'swept' },
        { key: 'claim:470:new', status: 'skipped', ms: 0, summary: "held: the act lock is no longer this session's" },
      ])
      expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
      // the store keeps what it held when the lock was lost: the sweep running, as the next holder will find it
      expect(JSON.stringify(h.store.get(ledgerKey))).toBe(atLoss)
      expect(h.entry('sweep:0')).toMatchObject({ status: 'running' })
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

  test("an agent's answer while another session holds the lock is left to that session: no load, no event, no write", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry(`design:470:${since}`, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store, files: { [LOCK]: otherLease(NOW + 30 * MIN) } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: false })
    const before = JSON.stringify(h.store.get(ledgerKey))
    await agentDone($, h, 'agent-1', `RESULT brief=${BRIEF} created=none pending_decision=no`)
    expect(h.events()).toEqual([])
    expect(JSON.stringify(h.store.get(ledgerKey))).toBe(before)
  })

  test("a lease taken over from another session reloads the store's ledger, which that session kept, before anything acts", async ($, on) => {
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
        entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: NOW + 10_000, endedAt: NOW + 20_000 }),
      ],
    })
    // the queue is read again two minutes after its last read
    await clock.advance(3 * MIN)
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'store' })
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect(h.last().skipped).toContainEqual({ rule: 'D1', issue: 470, why: 'exhausted: claim:470:new' })
  })

  test('an agent list that cannot be read marks no agent lost and spawns nothing (SPEC 3.3, 10.4)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const key = `design:470:${since}`
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
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

  test('a store that cannot be read is never replaced: nothing acts and nothing is written (SPEC 7.5)', async ($, on) => {
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

  test('a ledger the store will not take starts nothing, is reported, and shows error until a save succeeds', async ($, on) => {
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
    expect(h.titles.at(-1)).not.toContain('error')
  })

  test('every attempt is in the store, running, before its command or spawn runs, and its end before its loop event (SPEC 7.5)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const key = `design:470:${since}`
    const seen: Record<string, string | undefined> = {}
    let h: Host | undefined
    const { run } = factory({
      issue: { stage: 'designing', since },
      run: argv => {
        if (argv[0] === 'callum-flow-sweep') seen.sweep = h?.entry('sweep:0')?.status
        const note = argv[0] === 'callum-flow-event' && argv[1] === 'loop' ? (argv.at(-1) ?? '') : ''
        if (note.startsWith(`kind=spawn key=${key} `)) seen.loop = h?.entry(key)?.status
        return undefined
      },
    })
    const store = ledgerOf([
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
    ])
    h = host(on, {
      config: ACT,
      run,
      store,
      spawn: () => {
        seen.spawn = h?.entry(key)?.status
        return { agentId: 'agent-1' }
      },
    })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(seen.sweep).toBe('running')
    expect(seen.spawn).toBe('running')
    // the loop event of the attempt's end goes out once the store has that end
    expect(seen.loop).toBe(h.entry(key)?.status)
    expect(seen.loop).not.toBe('running')
  })

  test('a long step never outlives the lease: a pass renews it on a timer while it runs (SPEC 11.2)', async ($, on) => {
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
    expect(h.entry('claim:470:new')).toMatchObject({ status: 'done' })
  })
})

describe('act mode: a lease taken over during a long step', () => {
  test("a renewal that finds another session's lease, even expired, never writes this session's ledger over that session's (SPEC 11.2)", async ($, on) => {
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

describe('act mode: between passes (SPEC 2, 8.2, 10.4)', () => {
  test("an agent's turn.complete records its answer and pings a pass", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(`design:470:${since}`, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.passes()).toHaveLength(1)
    // the first pass after a load renews the claim (rule H1); the designer runs on
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual(['heartbeat:0'])

    // an agent the loop never spawned changes nothing and pings nothing
    await agentDone($, h, 'agent-someone-else', 'all done')
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(1)

    const before = h.seen.length
    await agentDone($, h, 'agent-1', `Brief posted.\nRESULT brief=${BRIEF} created=none pending_decision=no`)
    expect(h.entry(`design:470:${since}`)).toMatchObject({ status: 'done', outcome: { kind: 'designer', brief: BRIEF, created: [], pendingDecision: false } })
    expect(h.files.get(answerPath(LOOP_DIR, `design:470:${since}`))).toContain('RESULT brief=')
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=spawn key=design:470:${since} status=done`))).toBe(true)
    // the answer's events are real ones in act mode: none goes to the sink (SPEC 7.4, D-09)
    const hooked = h.seen.slice(before).filter(s => s.argv[0] === 'callum-flow-event')
    expect(hooked.length).toBeGreaterThan(0)
    expect(hooked.every(s => s.env.CALLUM_EVENTS_DIR === undefined && s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
    // the ping: a pass 5 s after the last one, which delegates
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(2)
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual([`delegate:470:${BRIEF}`])
    expect(h.commands().some(s => s.argv.join(' ') === 'callum-flow-implementer-route 470')).toBe(true)
    expect(h.events()).toContainEqual(['callum-flow-event', 'delegated', '--issue', '470', '--note', `brief ${BRIEF}`])
    expect(h.spawns.map(s => s.description)).toEqual(['Implement #470'])
    // the implementer goes out on the routed model, with its name (the engine's test kit resolves
    // no plugin agent type, so the hook sees none; act.test.ts checks the type through ActIo)
    expect(h.spawns[0]).toMatchObject({ model: 'sonnet', name: 'implementer-470', description: 'Implement #470' })
    // the kit also hands a plugin's $.agent.spawn no agent id (only core sets one), so the delegate
    // is recorded as a start with no agent id; act.test.ts runs a whole spawn
    expect(h.entry(`delegate:470:${BRIEF}`)).toMatchObject({ status: 'failed', summary: 'callum-flow:implementer: started with no agent id' })
  })

  test("an agent's interim message while its own sub-agent runs leaves its entry running; its final answer is the one recorded (#545)", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    // the designer started an explorer in the background, which still runs
    h.agents.push({ id: 'agent-x', type: 'Explore', status: 'running', description: 'Explore the code', parentId: 'agent-1' })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.passes()).toHaveLength(1)

    // its turn ends on an interim message with no RESULT line: the entry runs on and no wake goes out
    const interim = "The explorer is still running. I'll wait for its notification before posting."
    await $.turn.complete({ agentId: 'agent-1', answer: interim, reason: 'answer', turnId: 'turn-a1', durationMs: 1000, isAborted: false })
    expect(h.entry(key)).toMatchObject({ status: 'running', agentId: 'agent-1' })
    expect(h.lines().some(l => JSON.stringify(l).includes('interim answer'))).toBe(true)
    await clock.advance(60_000)
    expect(h.prompts).toEqual([])
    expect(h.entry(key)).toMatchObject({ status: 'running' })

    // the explorer ends, and the designer's next turn posts the brief: that answer is recorded
    const x = h.agents.find(a => a.id === 'agent-x')
    if (x !== undefined) x.status = 'completed'
    await agentDone($, h, 'agent-1', `Brief posted.\nRESULT brief=${BRIEF} created=none pending_decision=no`)
    expect(h.entry(key)).toMatchObject({ status: 'done', outcome: { kind: 'designer', brief: BRIEF, created: [], pendingDecision: false } })
    expect(h.files.get(answerPath(LOOP_DIR, key))).toContain('RESULT brief=')
    await clock.advance(5_000)
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual([`delegate:470:${BRIEF}`])
  })

  test("a stopped agent's answer with no machine line still goes to the model (#545)", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    // a sub-agent it ran in the foreground has ended
    h.agents.push({ id: 'agent-x', type: 'Explore', status: 'completed', description: 'Explore the code', parentId: 'agent-1' })
    await $.session.start(START)
    await clock.advance(6_000)

    // listed running at its own turn.complete, as every agent is as it ends: no proof it works on.
    // Its missing line first gets the one repair message (#548), so the entry runs on
    await agentDone($, h, 'agent-1', 'I looked into it but could not settle the design.')
    expect(h.sends.map(s => s.to)).toEqual(['agent-1'])
    expect(h.sends[0]?.text).toContain('The factory loop could not read your answer: no RESULT line.')
    expect(h.entry(key)).toMatchObject({ status: 'running', attempts: 1, reminded: true })
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', key, answer: 'repair', why: 'no RESULT line' }))
    // still no line after it: the report goes to the model, as before
    await agentDone($, h, 'agent-1', 'I still could not settle it.')
    expect(h.sends).toHaveLength(1)
    expect(h.entry(key)).toMatchObject({ status: 'done', outcome: { kind: 'designer', unparsed: true } })
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', key, answer: 'text', status: 'done', afterRepair: true }))
    await clock.advance(5_000)
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual([`judge:report:${key}`])
  })

  test('a wake answered through the main loop: turn.start takes the turn, an ANSWER closes it, a silent turn gets one reminder', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'done', startedAt: NOW - 15 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'designer', unparsed: true } }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)

    // the designer's report did not parse: judge(report) wakes the model with the saved answer
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual(['heartbeat:0', `judge:report:${key}`])
    const wake = h.prompts[0] ?? ''
    expect(wake).toStartWith('JUDGE report id=w')
    expect(wake).toContain(`saved answer: ${answerPath(LOOP_DIR, key)}`)
    const id = /id=(\S+)/.exec(wake)?.[1] ?? ''

    // its turn ends without an answer: one reminder
    const before = h.seen.length
    await $.turn.start({ text: `The factory-loop plugin sent a message:\n${wake}`, turnId: 'turn-1' })
    await $.turn.complete({ turnId: 'turn-1', answer: 'Looking at the report.', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.settle()
    expect(h.prompts[1]).toStartWith(`JUDGE report id=${id}`)
    expect(h.prompts[1]?.split('\n')[0]).toEndWith('reminder=1')
    expect(h.entry(`judge:report:${key}`)).toMatchObject({ status: 'running', turnId: 'turn-1', reminded: true })

    // the reminder's turn answers: the wake is done and the loop is pinged
    await $.turn.start({ text: h.prompts[1] ?? '', turnId: 'turn-2' })
    const fields = JSON.stringify({ brief: BRIEF, created: [], pendingDecision: false })
    await $.turn.complete({ turnId: 'turn-2', answer: `ANSWER ${id} parsed\nfields: ${fields}`, reason: 'answer', durationMs: 900, isAborted: false })
    expect(h.entry(`judge:report:${key}`)).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'parsed' } })
    // the turns' loop event (the wake's end; its turn taking its id and its reminder change nothing
    // an event says) is a real one in act mode: none goes to the sink (SPEC 7.4, D-09)
    const hooked = h.seen.slice(before).filter(s => s.argv[0] === 'callum-flow-event')
    expect(hooked.length).toBeGreaterThan(0)
    expect(hooked.every(s => s.env.CALLUM_EVENTS_DIR === undefined)).toBe(true)
    await clock.advance(5_000)
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual([`delegate:470:${BRIEF}`])
  })

  // run 2 (#536): a wake's turn starts inside its submit, as the engine starts it, and its one
  // start was logged twice, by turn.start and by the executor's finish
  const loopStatuses = (h: Host, kind: string) =>
    h.events().map(e => e.at(-1) ?? '').filter(n => n.startsWith(`kind=${kind} `)).map(n => /status=(\S+)/.exec(n)?.[1])

  test('each ledger transition logs one loop event: a judge whose turns start inside their submits, its reminder included', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'done', startedAt: NOW - 15 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'designer', unparsed: true } }),
    ])
    let turns = 0
    const h = host(on, { config: ACT, run, store, submit: text => void $.turn.start({ text, turnId: `turn-${++turns}` }) })
    await $.session.start(START)
    await clock.advance(6_000)

    // the pass wakes the model for the report; its turn says nothing, so it is reminded
    const judgeKey = `judge:report:${key}`
    expect(h.entry(judgeKey)).toMatchObject({ status: 'running', turnId: 'turn-1' })
    expect(loopStatuses(h, 'judge')).toEqual(['running'])
    await $.turn.complete({ turnId: 'turn-1', answer: 'Looking at the report.', reason: 'answer', durationMs: 900, isAborted: false })
    await clock.settle()
    expect(h.entry(judgeKey)).toMatchObject({ status: 'running', reminded: true, turnId: 'turn-2' })
    // the reminder's turn answers
    const id = /id=(\S+)/.exec(h.prompts[0] ?? '')?.[1] ?? ''
    const fields = JSON.stringify({ brief: BRIEF, created: [], pendingDecision: false })
    await $.turn.complete({ turnId: 'turn-2', answer: `ANSWER ${id} parsed\nfields: ${fields}`, reason: 'answer', durationMs: 900, isAborted: false })
    expect(h.entry(judgeKey)).toMatchObject({ status: 'done' })
    expect(loopStatuses(h, 'judge')).toEqual(['running', 'done'])
  })

  test("each ledger transition logs one loop event: a rail's tell whose turn starts inside its submit", async ($, on) => {
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

  test('each ledger transition logs one loop event: a wake a reload left open logs nothing when its turn starts, then its end', async ($, on) => {
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

  test('each wake gets its own id, pass after pass (SPEC 8.1)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const f = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'done', startedAt: NOW - 15 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'designer', unparsed: true } }),
    ])
    const h = host(on, { config: ACT, run: f.run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    const first = /id=(\S+)/.exec(h.prompts[0] ?? '')?.[1] ?? ''
    expect(await $.tool.call({ tool: 'mcp__factory-loop__answer', id: first, decision: 'hold' })).toMatchObject({ result: expect.stringContaining('Recorded') })
    // another orchestrator comes up: its notice is the next wake
    f.w.beats = `device,age_s\n${OTHER},30\n`
    await clock.advance(60_000)
    const second = /id=(\S+)/.exec(h.prompts.find(p => p.startsWith('TELL heartbeat-other')) ?? '')?.[1] ?? ''
    expect(second).not.toBe('')
    expect(second).not.toBe(first)
  })

  test("a rail's notice whose spell ended before a wake let it out is never sent (SPEC 11.2)", async ($, on) => {
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

  test('a change of repo loads that repo\'s ledger before anything acts', async ($, on) => {
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
        [`ledger:${other}`]: { v: 1, savedAt: NOW - MIN, entries: [entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - MIN, endedAt: NOW - MIN }), entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'failed', attempts: 3, startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN })] },
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
    expect(JSON.parse(lines.at(-1) ?? '{}').skipped).toContainEqual({ rule: 'D1', issue: 470, why: 'exhausted: claim:470:new' })
  })

  test('the answer tool closes an open wake; from inside an agent it is refused', async ($, on) => {
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
    expect(h.entry('judge:sequence:512:abc1234')).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'merge' } })
  })

  test("an agent's answer tool: refused for a caller the loop does not wait on, denied with what to correct, then recorded with a pass after it (#548)", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('claim:470:new', 'claim', { class: 'start', issue: 470, status: 'done', startedAt: since, endedAt: since, outcome: { kind: 'claim', result: 'claimed' } }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 10 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.passes()).toHaveLength(1)
    const answer = { tool: 'mcp__factory-loop__design', brief: BRIEF, created: [], pendingDecision: false } as const

    // the main conversation, and an agent the loop did not start (the designer's explorer)
    expect(await $.tool.call(answer)).toMatchObject({ deny: expect.stringContaining('the main conversation is none') })
    expect(await $.tool.call({ ...answer, agentId: 'agent-x' })).toMatchObject({ deny: expect.stringContaining('waiting on no answer from this agent') })
    // a broken call: denied with what to correct, the entry untouched
    expect(await $.tool.call({ tool: 'mcp__factory-loop__design', brief: BRIEF, created: [], agentId: 'agent-1' })).toMatchObject({
      deny: expect.stringContaining('pendingDecision must be true or false. Correct the call and call mcp__factory-loop__design again.'),
    })
    expect(h.entry(key)).toMatchObject({ status: 'running' })
    // corrected in the same turn: recorded at once, and the decision log says which path each call took
    expect(await $.tool.call({ ...answer, agentId: 'agent-1' })).toMatchObject({ result: expect.stringContaining('Recorded: designer #470 (tool): brief') })
    expect(h.entry(key)).toMatchObject({ status: 'done', outcome: { kind: 'designer', brief: BRIEF, created: [], pendingDecision: false } })
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', tool: 'mcp__factory-loop__design', key, answer: 'tool refused' }))
    expect(h.lines()).toContainEqual(expect.objectContaining({ agent: 'agent-1', tool: 'mcp__factory-loop__design', key, answer: 'tool' }))
    // the turn's closing words change nothing and log nothing
    const logged = h.lines().length
    await agentDone($, h, 'agent-1', 'Recorded through the tool; done.')
    expect(h.lines()).toHaveLength(logged)
    expect(h.sends).toEqual([])
    // the ping: the next pass delegates, its trigger the agent as for a text answer (#552)
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(2)
    expect(h.last()).toMatchObject({ trigger: 'agent agent-1' })
    expect((h.last().actions as { key: string }[]).map(a => a.key)).toEqual([`delegate:470:${BRIEF}`])
  })

  test('outside act mode the agent tools record nothing', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = shadow(on)
    await $.session.start(START)
    await clock.advance(6_000)
    const r = await $.tool.call({ tool: 'mcp__factory-loop__verdict', findings: [], action: { type: 'approve' }, agentId: 'agent-1' })
    expect(r).toMatchObject({ deny: 'Not recorded: no factory loop keeps a ledger in this session; reply with your text lines instead.' })
    expect(h.store.size).toBe(0)
  })
})

describe('act mode: engine calls, timeouts and what may run (SPEC 4.2, 6.1, 8.2, 10.7, 11.3, 13)', () => {
  test('shadowDevice stands in only while nothing executes: act mode plans as this device (SPEC 4.2, 5.4)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const head = 'a'.repeat(40)
    const { run } = factory({
      queue: [470],
      run: argv => {
        if (argv[0] === 'callum-flow-factory-state') {
          return { stdout: factoryDoc([{ issue: 471, stage: 'parked', entered_at: iso(NOW - 10 * MIN), holder: OTHER, run: '01K7S1AAAAAAAAAAAAAAAAAAAA', pr: 571, stuck: null, github: null }]) }
        }
        if (argv[0] === `${TOOLS}/pipeline-watch.sh`) return { stdout: `parked issue-471-other 01K7S1AAAAAAAAAAAAAAAAAAAA step=review pr=571 head=${head}\n` }
        return undefined
      },
    })
    const h = host(on, { config: { ...ACT, shadowDevice: OTHER }, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const line = h.last()
    expect(line).toMatchObject({ executed: true, device: DEVICE })
    // the other device's parked run is not this loop's to drive; the claim is this device's own
    expect((line.actions as { key: string }[]).map(a => a.key)).toEqual(['sweep:0', 'claim:470:new'])
    expect(h.spawns).toEqual([])
    expect(h.commands().find(s => s.argv[0] === 'callum-flow-claim')?.argv).toEqual(['callum-flow-claim', '470'])
  })

  test('a judge past its timeout is held in the pass, logged, and the notice it held back goes out (SPEC 8.2, 10.8)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const judge = 'judge:sequence:512:abc1234'
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(`design:470:${since}`, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'failed', attempts: 2, startedAt: since, endedAt: NOW - 10 * MIN }),
      entry(judge, 'judge', { wake: 'sequence', class: 'drive', issue: 470, pr: 512, status: 'running', startedAt: NOW - 31 * MIN, endedAt: null, wakeId: 'w9', session: SESSION }),
    ])
    const h = host(on, { config: ACT, run, store })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.entry(judge)).toMatchObject({ status: 'done', outcome: { kind: 'wake', decision: 'hold' } })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${judge} status=done`))).toBe(true)
    expect(h.prompts.filter(p => p.startsWith('TELL agent-failed id=w'))).toHaveLength(1)
  })

  test('a ledger rebuilt from the event log after a lost store is the one the loop keeps and acts on (SPEC 7.5, D-18)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 60 * MIN
    const designer = entry(`design:470:${since}`, 'spawn', {
      agent: 'designer', class: 'develop', rule: 'D2', issue: 470, status: 'done', startedAt: since, endedAt: NOW - 30 * MIN, agentId: 'agent-1',
      outcome: { kind: 'designer', brief: BRIEF, created: [], pendingDecision: true },
    })
    const told = entry(`tell:decision:470:${BRIEF}`, 'tell', { wake: 'decision', class: 'owner', rule: 'D3', issue: 470, status: 'done', startedAt: NOW - 29 * MIN, endedAt: NOW - 28 * MIN })
    const row = (e: LedgerEntry) => `${iso(e.endedAt ?? e.startedAt)},loop,470,,,,,"${loopEventArgs(e).at(-1)}",loop,${DEVICE}`
    const events = [NO_EVENTS.trim(), row(designer), row(told)].join('\n') + '\n'
    const { run } = factory({ issue: { stage: 'designing', since }, run: (argv, s) => (argv[0] === 'dev-query' && !(s.stdin ?? '').includes('workers_status') ? { stdout: events } : undefined) })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'events' })
    expect(h.entry(designer.key)).toMatchObject({ status: 'done', outcome: { kind: 'designer', pendingDecision: true } })
    expect(h.entry(told.key)).toMatchObject({ status: 'done' })
    // the design waits on the owner: no designer again, and the decision is not told twice
    const keys = (h.last().actions as { key: string }[]).map(a => a.key)
    expect(keys.filter(k => k.startsWith('design:') || k.startsWith('tell:decision:'))).toEqual([])
    expect(h.spawns).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test('a wake the event log rebuilds from an earlier session is lost at once, so the next pass can wake (SPEC 7.5, O2)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 60 * MIN
    // run 1 left a guard-fail judge open and a designer out of attempts; run 2 starts with the store cleared
    const designer = entry(`design:470:${since}`, 'spawn', {
      agent: 'designer', class: 'develop', rule: 'D2', issue: 470, status: 'failed', attempts: 2, startedAt: since, endedAt: NOW - 20 * MIN, agentId: 'agent-1',
    })
    const judge = 'judge:guard-fail:512:abc1234'
    const open = entry(judge, 'judge', { wake: 'guard-fail', class: 'drive', rule: 'M2', issue: 470, pr: 512, status: 'running', startedAt: NOW - 13 * MIN, endedAt: null })
    const row = (e: LedgerEntry) => `${iso(e.endedAt ?? e.startedAt)},loop,470,,,,,"${loopEventArgs(e).at(-1)}",loop,${DEVICE}`
    const events = [NO_EVENTS.trim(), row(designer), row(open)].join('\n') + '\n'
    const { run } = factory({ issue: { stage: 'designing', since }, run: (argv, s) => (argv[0] === 'dev-query' && !(s.stdin ?? '').includes('workers_status') ? { stdout: events } : undefined) })
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.last()).toMatchObject({ executed: true, ledgerSource: 'events' })
    // nobody can answer it: lost with its attempt given back, so its rule decides again
    expect(h.entry(judge)).toMatchObject({ status: 'lost', attempts: 0, summary: 'lost: it was open before this load' })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${judge} status=lost`))).toBe(true)
    // and it holds no other wake: the owner hears about the designer in the same pass
    expect(h.prompts.filter(p => p.startsWith('TELL agent-failed id=w'))).toHaveLength(1)
    expect(h.last().skipped).not.toContainEqual(expect.stringContaining('a wake is open'))
  })

  test('usage that crosses Stop all mid-pass skips the next token-spending action, with no attempt counted (SPEC 10.7)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let h: Host | undefined
    const { run } = factory({
      queue: [470],
      run: argv => {
        // the session's own reading climbs while the sweep runs
        if (argv[0] === 'callum-flow-sweep' && h !== undefined) h.usage = [{ kind: 'five_hour', percentUsed: 96 }]
        return undefined
      },
    })
    h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    const claim = (h.last().outcomes as { key: string; status: string; summary: string }[]).find(o => o.key === 'claim:470:new')
    expect(claim).toMatchObject({ status: 'skipped' })
    expect(claim?.summary).toContain('usage: tier stop-all forbids start (5h 96%')
    expect(h.commands().some(s => s.argv[0] === 'callum-flow-claim')).toBe(false)
    expect(h.entry('claim:470:new')).toBeUndefined()
  })

  const stale = (stop?: HostOptions['stop']) => async ($: Engine, on: Parameters<typeof host>[0]) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 90 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(`design:470:${since}`, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'running', startedAt: NOW - 61 * MIN, endedAt: null, agentId: 'agent-1' }),
    ])
    const h = host(on, { config: ACT, run, store, stop })
    h.agents.push({ id: 'agent-1', type: 'callum-flow:designer', status: 'running', description: 'Design #470' })
    await $.session.start(START)
    await clock.advance(6_000)
    return { clock, h, key: `design:470:${since}` }
  }

  test('a spawn that never starts fails after a minute, and the loop runs on (SPEC 6.1)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const key = `design:470:${since}`
    const { run } = factory({ issue: { stage: 'designing', since } })
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
    ])
    const h = host(on, { config: ACT, run, store, spawn: () => new Promise(() => undefined) })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.passes()).toHaveLength(0)
    await clock.advance(60_000)
    expect(h.passes().length).toBeGreaterThan(0)
    expect((h.passes()[0]?.outcomes as { key: string; status: string }[]).find(o => o.key === key)).toMatchObject({ status: 'failed' })
    expect(h.entry(key)).toMatchObject({ status: 'failed' })
    expect(h.entry(key)?.summary).toContain('no answer within 60 s')
  })

  test('a timed-out agent is stopped with TaskStop on its own id (SPEC A1, 13)', async ($, on) => {
    const { h, key } = await stale()($, on)
    expect(h.stops).toEqual(['agent-1'])
    expect(h.entry('stop:agent-1')).toMatchObject({ status: 'done' })
    expect(h.entry(key)).toMatchObject({ status: 'timed-out', summary: 'timed out: stopped' })
  })

  test('a TaskStop that never answers fails after 30 s, and the loop runs on; a refused one fails (SPEC 6.1, 13)', async ($, on) => {
    const { clock, h, key } = await stale(() => new Promise(() => undefined))($, on)
    expect(h.passes()).toHaveLength(0)
    await clock.advance(30_000)
    expect(h.passes()).toHaveLength(1)
    expect(h.entry('stop:agent-1')).toMatchObject({ status: 'failed' })
    expect(h.entry('stop:agent-1')?.summary).toContain('no answer within 30 s')
    expect(h.entry(key)).toMatchObject({ status: 'timed-out', summary: 'timed out: the stop failed, the agent may still run' })
    await clock.advance(60_000)
    expect(h.passes()).toHaveLength(2)
  })

  test('a TaskStop the engine refuses is a failed stop with its reason', async ($, on) => {
    const { h } = await stale(() => ({ deny: 'TaskStop: no such tool' }))($, on)
    expect(h.entry('stop:agent-1')).toMatchObject({ status: 'failed' })
    expect(h.entry('stop:agent-1')?.summary).toContain('TaskStop: no such tool')
  })

  const unparsed = (submit: HostOptions['submit']) => async ($: Engine, on: Parameters<typeof host>[0]) => {
    const clock = mock.clock(on, { now: NOW })
    const since = NOW - 20 * MIN
    const { run } = factory({ issue: { stage: 'designing', since } })
    const key = `design:470:${since}`
    const store = ledgerOf([
      entry('sweep:0', 'sweep', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('heartbeat:0', 'heartbeat', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry(key, 'spawn', { agent: 'designer', class: 'develop', issue: 470, status: 'done', startedAt: NOW - 15 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'designer', unparsed: true } }),
    ])
    const h = host(on, { config: ACT, run, store, submit })
    await $.session.start(START)
    await clock.advance(6_000)
    return { clock, h, wake: `judge:report:${key}` }
  }

  test('a wake prompt the engine drops is never left open: it uses no attempt, and the next pass asks again (SPEC 8.1)', async ($, on) => {
    let drops = 1
    const { clock, h, wake } = await unparsed(() => (drops-- > 0 ? { drop: 'the session is shutting down' } : undefined))($, on)
    expect(h.entry(wake)).toBeUndefined()
    const out = (h.last().outcomes as { key: string; status: string; summary: string }[]).find(o => o.key === wake)
    expect(out).toMatchObject({ status: 'skipped' })
    expect(out?.summary).toContain('dropped: the session is shutting down')
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('JUDGE report id=w'))).toHaveLength(2)
    expect(h.entry(wake)).toMatchObject({ status: 'running', attempts: 1 })
  })

  test('a busy session never holds a pass: the wake is taken as queued after 5 s, and a later drop asks again', async ($, on) => {
    let drop: (r: { drop?: string }) => void = () => undefined
    let first = true
    const { clock, h, wake } = await unparsed(() => (first ? ((first = false), new Promise(resolve => (drop = resolve))) : undefined))($, on)
    await clock.advance(5_000)
    expect(h.passes()).toHaveLength(1)
    expect(h.entry(wake)).toMatchObject({ status: 'running' })
    drop({ drop: 'the queue was cleared' })
    await clock.settle()
    // lost with its attempt given back, and its end logged, since its start was
    expect(h.entry(wake)).toMatchObject({ status: 'lost', attempts: 0, summary: 'submit dropped: the queue was cleared' })
    expect(h.events().some(e => (e.at(-1) ?? '').startsWith(`kind=judge key=${wake} status=lost`))).toBe(true)
    await clock.advance(60_000)
    expect(h.prompts.filter(p => p.startsWith('JUDGE report id=w'))).toHaveLength(2)
    expect(h.entry(wake)).toMatchObject({ status: 'running', attempts: 1 })
  })

  test("a rail's notice the engine drops after the submit goes out again (SPEC 9.2, 11.2)", async ($, on) => {
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

  test("a wake another session submitted is lost with its session; one this session's reload left open stays (SPEC 7.5)", async ($, on) => {
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

  test("a reload within one session keeps that session's open wake", async ($, on) => {
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
    test(`under ${name} an open wake gets no reminder and its turn changes nothing (SPEC 11.1, 11.3)`, async ($, on) => {
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

describe('act mode: the owner\'s controls (SPEC 4.3, D-38)', () => {
  test('/factory ops write control.json, log the change, ping a pass; status reads the last pass', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)

    expect(await factoryOp($, 'pause 470')).toMatchObject({ text: 'Paused #470: no action on it until unpause; its claim still renews.' })
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ paused: [470] })
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

  test('/factory retry clears the issue\'s exhausted entries in the ledger', async ($, on) => {
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
    expect(h.entry('claim:470:new')).toMatchObject({ attempts: 0, summary: 'attempts cleared by the owner (/factory retry)' })
  })

  test('passes start at least 5 s apart, and a ping storm falls back to the timer and tells the owner once (D-39)', { timeoutMs: 30_000 }, async ($, on) => {
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

  test('two owner ops at once both land in control.json: they run one at a time', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { run } = factory()
    const h = host(on, { config: ACT, run })
    await $.session.start(START)
    await clock.advance(6_000)
    await Promise.all([factoryOp($, 'pause 470'), factoryOp($, 'skip 471')])
    expect(JSON.parse(h.files.get(`${LOOP_DIR}/control.json`) ?? '{}')).toMatchObject({ paused: [470], skip: [471] })
  })
})
