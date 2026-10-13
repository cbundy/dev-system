import { describe, expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

import { counts, dueAlerts, repoSlug, statusText, versionsText } from '../hooks/format'

const FACTORY = JSON.stringify({
  repos: [
    {
      repo: 'cbundy/dev-system',
      issues: [
        { stage: 'queued' },
        { stage: 'queued' },
        { stage: 'designing' },
        { stage: 'designing' },
        { stage: 'implementing' },
        { stage: 'in pipeline' },
        { stage: 'parked' },
        { stage: 'ready to merge' },
        { stage: 'merged' },
        { stage: 'closed without merge' },
      ],
    },
  ],
})
const SNAPSHOT = JSON.stringify({
  plugin_version: '0.27.0',
  base_image: '2.27.0',
  components: [{ name: 'no-mistakes', running: '1.84.0' }],
})
// 2026-10-11T20:41:00Z
const NOW = Date.UTC(2026, 9, 11, 20, 41)
const START: SessionStartInput = { cwd: '/work', surface: 'terminal', isInteractive: true }
// /hud typed on a phone, through Remote Control.
const HUD: CommandRunInput = {
  command: 'hud',
  args: '',
  origin: { kind: 'bridge' },
  presentation: { isFullscreen: false, columns: 40 },
}

describe('format', () => {
  test('counts the live stages, folding parked into pipe', () => {
    expect(counts(FACTORY, 1)).toEqual({ live: 6, design: 2, dev: 1, pipe: 2, merge: 1, queued: 2, at: 1 })
    expect(counts('not json', 1)).toBeUndefined()
    expect(counts('{}', 1)).toBeUndefined()
  })

  test('reads the repo from https and ssh remotes', () => {
    expect(repoSlug('https://github.com/cbundy/dev-system.git\n')).toBe('cbundy/dev-system')
    expect(repoSlug('git@github.com:cbundy/dev-system')).toBe('cbundy/dev-system')
    expect(repoSlug('https://gitlab.com/a/b.git')).toBeUndefined()
  })

  test('the line: time, context, usage, factory, versions; stale counts show their age', () => {
    const readout = {
      context: { window: 200_000, percent: 41.3 },
      limits: [
        { kind: 'five_hour', percentUsed: 72.1 },
        { kind: 'seven_day', percentUsed: 53 },
      ],
      factory: counts(FACTORY, NOW),
      isFactoryShown: true,
      isFactoryLoading: false,
      versions: 'cc 2.1.296 flow 0.27.0',
    }
    expect(statusText(readout, NOW, 'UTC')).toBe(
      '20:41  ctx 42%  5h 73%  7d 53%  | 6 live: design 2 dev 1 pipe 2 merge 1 | queued 2  | cc 2.1.296 flow 0.27.0',
    )
    expect(statusText(readout, NOW + 7 * 60_000, 'UTC')).toContain('| queued 2 (7m old)')
    expect(statusText({ ...readout, isFactoryShown: false }, NOW, 'UTC')).toBe(
      '20:41  ctx 42%  5h 73%  7d 53%  | cc 2.1.296 flow 0.27.0',
    )
    expect(statusText({ ...readout, factory: undefined, isFactoryLoading: true }, NOW, 'UTC')).toContain(
      '| factory loading',
    )
  })

  test('versions from the snapshot, or Claude Code alone without one', () => {
    expect(versionsText('2.1.296 (Claude Code)', SNAPSHOT)).toBe('cc 2.1.296 flow 0.27.0 img 2.27.0 nm 1.84.0')
    expect(versionsText('2.1.296', undefined)).toBe('cc 2.1.296')
    expect(versionsText('2.1.296', 'garbage')).toBe('cc 2.1.296')
  })

  test('alerts at context 85% and usage 90%, each once', () => {
    const limits = [
      { kind: 'five_hour', percentUsed: 91 },
      { kind: 'seven_day', percentUsed: 50 },
    ]
    expect(dueAlerts({ window: 1, percent: 86 }, limits, [])).toEqual([
      ['context-85', 'Context is 86% full'],
      ['five_hour-90', '5h usage is at 91%'],
    ])
    expect(dueAlerts({ window: 1, percent: 86 }, limits, ['context-85', 'five_hour-90'])).toEqual([])
    expect(dueAlerts({ window: 1, percent: 10 }, [], [])).toEqual([])
  })
})

// world: the engine beneath the plugin, answered from fixtures; returns what was drawn.
function world(on: On, factory: string | null = FACTORY) {
  const clock = mock.clock(on, { now: NOW })
  const drawn = {
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    runs: [] as string[],
    writes: [] as string[],
    clock,
  }
  const ran = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.status', ($, e) => {
    drawn.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    drawn.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000, percent: 20 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 30 }],
    },
  }))
  on('session.version', () => ({ value: { version: '2.1.296' } }))
  on('fs.read', () => ({ value: SNAPSHOT }))
  on('fs.write', ($, e) => {
    drawn.writes.push(`${e.path} ${e.text}`)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('process.run', ($, e) => {
    drawn.runs.push(e.argv.join(' '))
    if (e.argv[0] === 'git') return ran('git@github.com:cbundy/dev-system.git\n')
    return factory === null ? ran('', 1) : ran(factory)
  })
  return drawn
}

describe('in a session', () => {
  test('an orchestrator gets the factory counts for its repo', async ($, on) => {
    mock.env(on, { DEV_ROLE: 'orchestrator', TZ: 'UTC' })
    const drawn = world(on)
    await $.session.start(START)
    await drawn.clock.settle()
    expect(drawn.runs).toContain('callum-flow-factory-state --repo cbundy/dev-system --github off --format json')
    expect(drawn.status.at(-1)).toBe(
      '20:41  ctx 20%  5h 30%  | 6 live: design 2 dev 1 pipe 2 merge 1 | queued 2  | cc 2.1.296 flow 0.27.0 img 2.27.0 nm 1.84.0',
    )
  })

  test('a dev session shows no factory counts and runs no factory-state', async ($, on) => {
    mock.env(on, { DEV_ROLE: 'dev', TZ: 'UTC' })
    const drawn = world(on)
    await $.session.start(START)
    expect(drawn.runs).toEqual([])
    expect(drawn.status.at(-1)).toBe('20:41  ctx 20%  5h 30%  | cc 2.1.296 flow 0.27.0 img 2.27.0 nm 1.84.0')
  })

  test('the factory option forces the counts on', { options: { factory: 'on' } }, async ($, on) => {
    mock.env(on, { DEV_ROLE: 'dev', TZ: 'UTC' })
    const drawn = world(on)
    await $.session.start(START)
    await drawn.clock.settle()
    expect(drawn.status.at(-1)).toContain('| 6 live: ')
  })

  test('a failing factory-state drops the factory segment, not the line', async ($, on) => {
    mock.env(on, { DEV_ROLE: 'orchestrator', TZ: 'UTC' })
    const drawn = world(on, null)
    await $.session.start(START)
    await drawn.clock.settle()
    expect(drawn.status.at(-1)).toBe('20:41  ctx 20%  5h 30%  | cc 2.1.296 flow 0.27.0 img 2.27.0 nm 1.84.0')
  })

  test('a measurement redraws and toasts each threshold once', async ($, on) => {
    mock.env(on, { DEV_ROLE: 'dev', TZ: 'UTC' })
    const drawn = world(on)
    await $.session.start(START)
    const high = {
      context: { window: 200_000, percent: 88 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 95 }],
      changed: ['context' as const],
    }
    await $.session.measure(high)
    await $.session.measure(high)
    expect(drawn.status.at(-1)).toContain('ctx 88%  7d 95%')
    expect(drawn.toasts).toEqual(['Context is 88% full', '7d usage is at 95%'])
  })

  for (const reason of ['clear', 'resume'] as const) {
    test(`a ${reason} starts the context, toasts and /hud over for the next conversation`, async ($, on) => {
      mock.env(on, { DEV_ROLE: 'dev', TZ: 'UTC' })
      const drawn = world(on)
      await $.session.start(START)
      const high = {
        context: { window: 200_000, percent: 88 },
        rateLimits: [],
        changed: ['context' as const],
      }
      await $.session.measure(high)
      await $.command.run(HUD)
      expect(drawn.status.at(-1)).toBeUndefined()
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
      expect(drawn.status.at(-1)).toBe('20:41  | cc 2.1.296 flow 0.27.0 img 2.27.0 nm 1.84.0')
      await $.session.measure(high)
      expect(drawn.status.at(-1)).toContain('ctx 88%')
      expect(drawn.toasts.filter(text => text === 'Context is 88% full')).toHaveLength(2)
    })
  }

  test('/hud hides and shows it, without a word to the conversation', async ($, on) => {
    mock.env(on, { DEV_ROLE: 'dev', TZ: 'UTC' })
    const drawn = world(on)
    await $.session.start(START)
    expect(await $.command.run(HUD)).toEqual({})
    expect(drawn.status.at(-1)).toBeUndefined()
    expect(drawn.toasts.at(-1)).toBe('HUD hidden in this conversation')
    await $.command.run(HUD)
    expect(drawn.status.at(-1)).toContain('ctx 20%')
  })

  test('records the context window per session for the heartbeat, once per change', async ($, on) => {
    mock.env(on, { DEV_ROLE: 'dev', TZ: 'UTC', DEV_CONTEXT_WINDOW_DIR: '/w' })
    const drawn = world(on)
    await $.session.start(START)
    const measured = (window: number) => ({ context: { window, percent: 5 }, rateLimits: [], changed: ['context' as const] })
    await $.session.measure(measured(200_000))
    await $.session.measure(measured(1_000_000))
    expect(drawn.writes).toEqual(['/w/s1 200000\n', '/w/s1 1000000\n'])
  })
})
