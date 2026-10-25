// The what-if cost of a wake's time window (hooks/wake-cost.ts, #1336) over a fake argv runner that
// answers stat, find and tail from a file.
import { describe, expect, test } from 'claude-code/testing'

import type { RunInit, RunResult } from '../hooks/exec'
import { WAKE_TAIL_BYTES, readWakeCost } from '../hooks/wake-cost'

const SRC = { configDir: '/cfg', sessionCwd: '/work/space', session: 'sess-1' }
const PATH = '/cfg/projects/-work-space/sess-1.jsonl'
const bytes = (s: string) => new TextEncoder().encode(s).length

// opus-5 input is 5 USD per million tokens
const req = (id: string, at: string | null, inTokens: number, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', requestId: id, ...(at === null ? {} : { timestamp: at }), message: { model, usage: { input_tokens: inTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n'

function fake(files: Record<string, string>, opts: { size?: number; tailFails?: boolean } = {}) {
  const calls: string[][] = []
  const cmd = async (argv: string[], _init: RunInit): Promise<RunResult> => {
    calls.push(argv)
    const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })
    const fail: RunResult = { exitCode: 1, stdout: '', stderr: 'no' }
    if (argv[0] === 'stat') {
      const f = files[argv[3] as string]
      return f === undefined ? fail : ok(`${opts.size ?? bytes(f)}\n`)
    }
    if (argv[0] === 'tail') {
      if (opts.tailFails) return fail
      const f = files[argv[3] as string]
      return f === undefined ? fail : ok(f)
    }
    return fail
  }
  return { cmd, calls }
}

const T = (s: string) => Date.parse(`2026-10-25T${s}Z`)
const FROM = T('10:00:00')
const TO = T('10:10:00')

describe('readWakeCost', () => {
  test('prices only the requests whose time falls inside the window', async () => {
    const f = fake({
      [PATH]:
        req('before', '2026-10-25T09:59:59.000Z', 1_000_000) +
        req('in1', '2026-10-25T10:00:00.000Z', 1_000_000) +
        req('in2', '2026-10-25T10:10:00.000Z', 2_000_000) +
        req('after', '2026-10-25T10:10:01.000Z', 1_000_000) +
        req('untimed', null, 1_000_000),
    })
    expect(await readWakeCost(f.cmd, SRC, FROM, TO)).toEqual({ cost: 15, problem: null })
    expect(f.calls.some(c => c[0] === 'tail' && c[2] === String(WAKE_TAIL_BYTES))).toBe(true)
  })

  test('a missing session file gives null and a problem', async () => {
    const r = await readWakeCost(fake({}).cmd, SRC, FROM, TO)
    expect(r).toEqual({ cost: null, problem: 'session transcript not found' })
    expect((await readWakeCost(fake({}).cmd, { ...SRC, session: '../x' }, FROM, TO)).cost).toBeNull()
  })

  test('an unpriced model inside the window gives null and names the model', async () => {
    const f = fake({ [PATH]: req('a', '2026-10-25T10:01:00.000Z', 10) + req('b', '2026-10-25T10:02:00.000Z', 10, 'claude-future-9') + req('c', '2026-10-25T11:00:00.000Z', 10, 'claude-other-1') })
    expect(await readWakeCost(f.cmd, SRC, FROM, TO)).toEqual({ cost: null, problem: 'unpriced model claude-future-9' })
  })

  test('a tail that starts after the window on a file larger than the tail gives null and a problem', async () => {
    const f = fake({ [PATH]: 'cut-off partial line\n' + req('a', '2026-10-25T10:05:00.000Z', 1_000_000) }, { size: WAKE_TAIL_BYTES + 1 })
    expect(await readWakeCost(f.cmd, SRC, T('09:00:00'), TO)).toEqual({ cost: null, problem: 'wake window older than the read tail' })
  })

  test('a tail that covers the window prices it, and the cut first line is skipped', async () => {
    // the cut line is a request that would be priced were it kept
    const cut = req('cut', '2026-10-25T10:05:00.000Z', 1_000_000).slice(30)
    const f = fake({ [PATH]: cut + req('a', '2026-10-25T09:00:00.000Z', 1) + req('b', '2026-10-25T10:05:00.000Z', 1_000_000) }, { size: WAKE_TAIL_BYTES + 1 })
    expect(await readWakeCost(f.cmd, SRC, T('09:30:00'), TO)).toEqual({ cost: 5, problem: null })
  })

  test('a file that fits the tail needs no coverage check', async () => {
    const f = fake({ [PATH]: req('a', '2026-10-25T10:05:00.000Z', 1_000_000) })
    expect((await readWakeCost(f.cmd, SRC, T('08:00:00'), TO)).cost).toBe(5)
  })

  test('a failing tail or a command that throws gives null and a problem, never a throw', async () => {
    expect((await readWakeCost(fake({ [PATH]: 'x\n' }, { tailFails: true }).cmd, SRC, FROM, TO)).problem).toBe('session transcript unreadable (tail failed)')
    const r = await readWakeCost(async () => { throw new Error('boom') }, SRC, FROM, TO)
    expect(r).toEqual({ cost: null, problem: 'session transcript unreadable: boom' })
  })
})
