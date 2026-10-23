// The observe split (observe-clock.ts, #1131): the union of the reads' intervals on a fake clock.
import { describe, expect, test } from 'claude-code/testing'

import { clocked } from '../hooks/observe-clock'
import type { Io } from '../hooks/observe'

// a fake clock and an Io whose calls finish when the test says so
function world() {
  let t = 0
  const waiting: (() => void)[] = []
  const hold = () => new Promise<void>(release => waiting.push(release))
  const io: Io = {
    now: async () => t,
    run: async argv => {
      await hold()
      if (argv[0] === 'boom') throw new Error('boom')
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    readFile: async () => {
      await hold()
      return null
    },
    sessionLimits: async () => {
      await hold()
      return []
    },
    agents: async () => [],
  }
  const init = { cwd: '/', env: {}, timeoutMs: 1 }
  return {
    clock: clocked(io, () => t),
    init,
    at: (n: number) => void (t = n),
    release: async (i: number) => {
      waiting[i]?.()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('clocked', () => {
  test('overlapping calls count once, back-to-back calls add up', async () => {
    const w = world()
    const a = w.clock.io.run(['a'], w.init)
    w.at(10)
    const b = w.clock.io.readFile('/x')
    w.at(30)
    await w.release(0)
    await a
    w.at(50)
    await w.release(1)
    await b
    w.at(60)
    const c = w.clock.io.sessionLimits()
    w.at(70)
    await w.release(2)
    await c
    w.at(100)
    // busy 0-50 and 60-70: 60, not the sum 30 + 40 + 10
    expect(w.clock.split(0, 100)).toEqual({ ms: 100, commandsMs: 60, inProcessMs: 40 })
  })

  test('a window with no call is all in-process', () => {
    const w = world()
    expect(w.clock.split(5, 25)).toEqual({ ms: 20, commandsMs: 0, inProcessMs: 20 })
  })

  test('a call still in flight counts up to the end, and the split never goes negative', async () => {
    const w = world()
    w.at(10)
    const a = w.clock.io.run(['a'], w.init)
    expect(w.clock.split(0, 40)).toEqual({ ms: 40, commandsMs: 30, inProcessMs: 10 })
    expect(w.clock.split(40, 0)).toEqual({ ms: 0, commandsMs: 0, inProcessMs: 0 })
    await w.release(0)
    await a
  })

  test('a call that throws stops counting', async () => {
    const w = world()
    const a = w.clock.io.run(['boom'], w.init)
    w.at(20)
    await w.release(0)
    await expect(a).rejects.toThrow('boom')
    w.at(90)
    expect(w.clock.split(0, 90)).toEqual({ ms: 90, commandsMs: 20, inProcessMs: 70 })
  })
})
