// The session title's one flight (title-flight.ts): single flight, a replaced pending title, and a
// rename that never rejects into the caller.
import { describe, expect, test } from 'claude-code/testing'

import { newTitleFlight } from '../hooks/title-flight'
import type { TitleSettled } from '../hooks/title-flight'

type Pending = { title: string; resolve: () => void; reject: (e: Error) => void }

function fake(initial: string | null = null) {
  const state = { title: initial, clock: 1_000 }
  const renames: Pending[] = []
  const settled: TitleSettled[] = []
  const flight = newTitleFlight({
    rename: title => new Promise<void>((resolve, reject) => void renames.push({ title, resolve, reject })),
    now: async () => state.clock,
    title: () => state.title,
    settled: done => {
      if (done.ok) state.title = done.title
      settled.push(done)
    },
  })
  const tick = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return { flight, renames, settled, state, tick }
}

describe('title flight', () => {
  test('want returns at once, and a rename that resolves settles ok with its time', async () => {
    const f = fake()
    expect(f.flight.want('A')).toBeUndefined()
    await f.tick()
    expect(f.renames.map(r => r.title)).toEqual(['A'])
    expect(f.flight.current()).toEqual({ inFlight: 'A', pending: null })
    f.state.clock = 1_250
    f.renames[0]?.resolve()
    await f.tick()
    expect(f.settled).toEqual([{ title: 'A', ok: true, ms: 250, endedAt: 1_250 }])
    expect(f.state.title).toBe('A')
    expect(f.flight.current()).toEqual({ inFlight: null, pending: null })
  })

  test('a rename that fails settles once with an error, and the title stays', async () => {
    const f = fake('old')
    f.flight.want('A')
    await f.tick()
    f.renames[0]?.reject(new Error('rename timed out after 10 s'))
    await f.tick()
    expect(f.settled).toHaveLength(1)
    expect(f.settled[0]).toMatchObject({ title: 'A', ok: false, error: 'rename timed out after 10 s' })
    expect(f.state.title).toBe('old')
    expect(f.flight.current().inFlight).toBeNull()
  })

  test('A, then B, then C while A runs: two renames, A then C, never B', async () => {
    const f = fake()
    f.flight.want('A')
    await f.tick()
    f.flight.want('B')
    f.flight.want('C')
    expect(f.flight.current()).toEqual({ inFlight: 'A', pending: 'C' })
    f.renames[0]?.resolve()
    await f.tick()
    expect(f.renames.map(r => r.title)).toEqual(['A', 'C'])
    f.renames[1]?.resolve()
    await f.tick()
    expect(f.state.title).toBe('C')
    expect(f.settled.map(s => s.title)).toEqual(['A', 'C'])
  })

  test('wanting the in-flight title, or the current one, sends nothing', async () => {
    const f = fake('now')
    f.flight.want('now')
    await f.tick()
    expect(f.renames).toHaveLength(0)
    f.flight.want('A')
    await f.tick()
    f.flight.want('A')
    expect(f.flight.current().pending).toBeNull()
    f.renames[0]?.resolve()
    await f.tick()
    expect(f.renames).toHaveLength(1)
  })

  test('a pending title equal to the one then set is dropped', async () => {
    const f = fake()
    f.flight.want('A')
    await f.tick()
    f.flight.want('B')
    f.flight.want('A')
    f.renames[0]?.resolve()
    await f.tick()
    expect(f.renames).toHaveLength(1)
  })

  test('a rejected rename never rejects out of want, and the next pending title still starts', async () => {
    const f = fake()
    f.flight.want('A')
    await f.tick()
    f.flight.want('B')
    f.renames[0]?.reject(new Error('boom'))
    await f.tick()
    expect(f.renames.map(r => r.title)).toEqual(['A', 'B'])
  })
})
