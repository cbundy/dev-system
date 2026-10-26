// The pass driver's queue_snapshot write (hooks/driver-pass.ts, hooks/queue-snapshot.ts): only an
// acting pass writes, once on the first pass, never waited on, and a failed send is told once.
import { describe, expect, mock, test } from 'claude-code/testing'

import { resetSnapshots } from '../hooks/queue-snapshot'
import { NOW } from './fixtures'
import { NO_EVENTS, QUIET_BEATS, REPO, TOOLS, ENGINE_TEST, factoryDoc, host } from './host'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const quiet = (argv: string[], s: { stdin?: string }) => {
  switch (argv[0]) {
    case 'fabriek-factory-state':
      return { stdout: factoryDoc([]) }
    case 'dev-query':
      return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
    case `${TOOLS}/queue-watch.sh`:
      return { stdout: 'queue known=none now=none\n' }
    case `${TOOLS}/usage-check.sh`:
      return { stdout: 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth' }
    case 'fabriek-issue-read':
      return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
    case 'treehouse':
      return { stdout: '[]' }
  }
  return undefined
}
const isSnapshot = (argv: string[]) => argv[0] === 'fabriek-event' && argv[1] === '--type' && argv[2] === 'queue_snapshot'
const problemsOf = (h: ReturnType<typeof host>) => h.passes().map(p => (p.problems as string[] | undefined) ?? [])

describe('a pass writes the queue snapshot', () => {
  test('act mode: exactly one queue_snapshot on the first pass, none on the next while nothing changed', ENGINE_TEST, async ($, on) => {
    resetSnapshots()
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: quiet })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    const writes = h.events().filter(isSnapshot)
    expect(writes).toHaveLength(1)
    const data = JSON.parse(writes[0]?.[4] ?? '{}') as { reason: string; folded: number; considered: number }
    expect(data).toMatchObject({ reason: 'changed', folded: 1, considered: 0 })
    expect(h.passes().length).toBeGreaterThanOrEqual(2)
  })

  test('observe mode issues no queue_snapshot', ENGINE_TEST, async ($, on) => {
    resetSnapshots()
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'observe', checkout: '/work' }, run: quiet })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    expect(h.passes().length).toBeGreaterThanOrEqual(1)
    expect(h.events().filter(isSnapshot)).toEqual([])
  })

  test('a send that exits non-zero leaves one problem on the next pass line, and no new send', ENGINE_TEST, async ($, on) => {
    resetSnapshots()
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: (argv, s) => (isSnapshot(argv) ? { exitCode: 1, stderr: 'boom' } : quiet(argv, s)) })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    await clock.advance(60_000)
    await clock.advance(60_000)
    const problems = problemsOf(h).map(p => p.filter(x => x.startsWith('queue snapshot: write failed')))
    expect(problems.flat()).toEqual(['queue snapshot: write failed: exit 1'])
    expect(h.events().filter(isSnapshot)).toHaveLength(1)
  })

  test('a send that never settles still lets the pass end and the next pass start', ENGINE_TEST, async ($, on) => {
    resetSnapshots()
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, mode: 'act', checkout: '/work' }, run: (argv, s) => (isSnapshot(argv) ? new Promise(() => undefined) : quiet(argv, s)) })
    await $.session.start(START)
    await clock.advance(6_000)
    const first = h.passes().length
    expect(first).toBeGreaterThanOrEqual(1)
    await clock.advance(60_000)
    expect(h.passes().length).toBeGreaterThan(first)
    expect(h.last()).toMatchObject({ executed: true })
    expect(problemsOf(h).flat().filter(x => x.startsWith('queue snapshot'))).toEqual([])
  })
})
