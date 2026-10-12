// The pass driver end to end, in the engine's own test host: files, commands, usage and
// /rename are answered by the test's hooks. One pass must read the factory, plan, append a
// decision-log line, set the title, and run nothing but reads, with every command's event
// writes sent to the observe-mode sink (SPEC 11.1).
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEVICE, NOW } from './fixtures'

const REPO = 'cbundy/dev-system'
const CFG_DIR = '/cfg'
const LOOP_DIR = `${CFG_DIR}/factory-loop/cbundy__dev-system`
const iso = (ms: number) => new Date(ms).toISOString()

const FACTORY = JSON.stringify({
  at: iso(NOW),
  repos: [
    {
      repo: REPO,
      issues: [
        { issue: 45, stage: 'parked', entered_at: iso(NOW - 600_000), holder: DEVICE, run: 'R45', pr: 545, stuck: null, github: null },
      ],
      recent: [],
    },
  ],
})
const EVENTS = [
  'ts,state,issue,run_id,branch,pr,head,note,actor,device',
  `${iso(NOW - 600_000)},parked,45,R45,feat/issue-45-x,,h1,,watcher,${DEVICE}`,
  `${iso(NOW - 300_000)},renewed,45,,,,,lease: 120,agent,${DEVICE}`,
  `${iso(NOW - 300_000)},closed,3,,,,,completed,sweep,${DEVICE}`,
].join('\n')

// The commands a pass may run: reads, and the decision log's append.
const READS = ['callum-flow-factory-state', 'dev-query', 'callum-flow-issue-read', '/usr/local/share/callum-tools/usage-check.sh', 'callum-flow-milestone', 'git']

type Seen = { argv: string[]; env: Record<string, string>; stdin?: string }

function host(on: On, config: Record<string, unknown>) {
  mock.env(on, { CLAUDE_CONFIG_DIR: CFG_DIR, DEV_MACHINE_NAME: 'coder-spike' })
  const files = new Map<string, string>([[`${CFG_DIR}/factory-loop/config.json`, JSON.stringify(config)]])
  const seen: Seen[] = []
  const titles: string[] = []
  on('fs.exists', async ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', async ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    seen.push({ argv, env: { ...(e.init?.env ?? {}) }, stdin: e.init?.stdin })
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    switch (argv[0]) {
      case 'callum-flow-factory-state':
        return out(FACTORY)
      case 'dev-query':
        return out(EVENTS)
      case 'callum-flow-issue-read':
        return out(JSON.stringify({ issues: [], stripped: 0 }))
      case '/usr/local/share/callum-tools/usage-check.sh':
        return out('five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth')
      default:
        return out('')
    }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000, tokens: 1000, percent: 1 }, rateLimits: [] } }))
  on('agent.list', async () => ({ value: [] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.run', async ($, e) => {
    if (e.command === 'rename') titles.push(e.args)
    return {}
  })
  return { files, seen, titles }
}

describe('driver', () => {
  test('observe mode: one pass reads, plans, logs and titles, and runs only reads', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { repo: REPO, runSource: 'events', shadowDevice: DEVICE, checkout: '/work' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(6_000)

    expect(h.titles).toEqual(['🔄 dev-system · observe · normal 5h 40% 7d 60% · q 0 dev 0 pipe 1 merge 0'])
    const appends = h.seen.filter(s => s.argv[0] === 'sh')
    expect(appends).toHaveLength(1)
    const line = JSON.parse(appends[0]!.stdin ?? '{}')
    expect(line).toMatchObject({ mode: 'observe', executed: false, device: DEVICE, tier: 'normal' })
    expect(line.actions.map((a: { key: string }) => a.key)).toEqual(['adjudicate:R45:null:h1'])
    expect(appends[0]!.argv.at(-1)).toBe(`${LOOP_DIR}/decisions-${iso(NOW).slice(0, 10)}.jsonl`)

    // nothing but reads ran, and every one of them wrote its events to the sink
    const others = h.seen.filter(s => s.argv[0] !== 'sh')
    expect(others.filter(s => !READS.includes(s.argv[0]!)).map(s => s.argv.join(' '))).toEqual([])
    expect(others.every(s => s.env.CALLUM_EVENTS_DIR === `${LOOP_DIR}/sink-events` && s.env.CALLUM_FLOW_REPO === REPO)).toBe(true)
    // the state was recorded for the replay tools
    expect([...h.files.keys()].some(p => p.startsWith(`${LOOP_DIR}/states/`))).toBe(true)
  })

  test('mode off, or the kill switch, reads nothing and says so in the title', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { repo: REPO, mode: 'off' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    expect(h.seen.map(s => s.argv[0])).toEqual([])
  })

  test('act mode in this build executes nothing and says so', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { repo: REPO, mode: 'act', runSource: 'events', shadowDevice: DEVICE })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(6_000)
    const line = JSON.parse(h.seen.find(s => s.argv[0] === 'sh')?.stdin ?? '{}')
    expect(line).toMatchObject({ mode: 'act', executed: false })
    expect(line.note).toContain('no executors')
    // the shadow device never stands in when act is asked for
    expect(line.device).toBe('coder-spike')
  })
})
