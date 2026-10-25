// The orchestrator's own tokens per minute (hooks/session-tokens.ts, #1302) over a fake file and a
// fake argv runner that answers stat, dd and find from it.
import { describe, expect, test } from 'claude-code/testing'

import type { RunInit, RunResult } from '../hooks/exec'
import { CHUNK_BYTES, newSessionTokenState, readSessionTokens } from '../hooks/session-tokens'

const SRC = { configDir: '/cfg', sessionCwd: '/work/space', session: 'sess-1' }
const PATH = '/cfg/projects/-work-space/sess-1.jsonl'

const bytes = (s: string) => new TextEncoder().encode(s).length
const line = (requestId: string | null, u: { in?: number; out?: number; read?: number; create?: number }) =>
  JSON.stringify({
    type: 'assistant',
    ...(requestId === null ? {} : { requestId }),
    message: { model: 'm', usage: { input_tokens: u.in ?? 0, output_tokens: u.out ?? 0, cache_read_input_tokens: u.read ?? 0, cache_creation_input_tokens: u.create ?? 0 } },
  })

function fake(files: Record<string, string>, opts: { ddFails?: boolean } = {}) {
  const calls: string[][] = []
  const cmd = async (argv: string[], _init: RunInit): Promise<RunResult> => {
    calls.push(argv)
    const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })
    const fail: RunResult = { exitCode: 1, stdout: '', stderr: 'no' }
    if (argv[0] === 'stat') {
      const f = files[argv[3] as string]
      return f === undefined ? fail : ok(`${bytes(f)}\n`)
    }
    if (argv[0] === 'dd') {
      if (opts.ddFails) return fail
      const f = files[(argv[1] as string).slice(3)]
      if (f === undefined) return fail
      const skip = Number((argv[3] as string).slice(5))
      const count = Number((argv[4] as string).slice(6))
      return ok(new TextDecoder().decode(new TextEncoder().encode(f).subarray(skip, skip + count)))
    }
    if (argv[0] === 'find') {
      const hit = Object.keys(files).find(p => p.endsWith('/sess-1.jsonl') && p.startsWith('/cfg/projects/'))
      return hit === undefined ? fail : ok(`${hit}\n`)
    }
    return fail
  }
  return { cmd, calls, files }
}

describe('readSessionTokens', () => {
  test('the first read is a null baseline at the file size; later reads count the added requests once', async () => {
    const f = fake({ [PATH]: line('r0', { in: 99 }) + '\n' })
    const h = newSessionTokenState()
    expect(await readSessionTokens(f.cmd, h, SRC)).toEqual({ tokens: null, cost: null, problem: 'no baseline' })
    expect(h.state?.offset).toBe(bytes(f.files[PATH] as string))
    f.files[PATH] += [line('r1', { in: 1, out: 2, read: 3, create: 4 }), line('r1', { in: 1, out: 2, read: 3, create: 4 }), line(null, { out: 10 })].join('\n') + '\n'
    expect(await readSessionTokens(f.cmd, h, SRC)).toEqual({ tokens: { input: 1, output: 12, cacheRead: 3, cacheCreation: 4 }, cost: null, problem: null, unpriced: ['m'] })
    expect((await readSessionTokens(f.cmd, h, SRC)).tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
  })

  test('a half-written last line waits, and the offset lands after the last newline with multi-byte text before it', async () => {
    const first = JSON.stringify({ type: 'user', message: { content: 'héllo ✓' } }) + '\n'
    const f = fake({ [PATH]: first })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    const whole = JSON.stringify({ type: 'user', message: { content: 'ünï ✓ ✓' } }) + '\n' + line('r1', { in: 5 })
    f.files[PATH] += whole
    expect((await readSessionTokens(f.cmd, h, SRC)).tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
    const full = (f.files[PATH] as string).slice(0, (f.files[PATH] as string).lastIndexOf('\n') + 1)
    expect(h.state?.offset).toBe(bytes(full))
    f.files[PATH] += '\n'
    expect((await readSessionTokens(f.cmd, h, SRC)).tokens?.input).toBe(5)
  })

  test('a request whose lines straddle two reads counts once', async () => {
    const f = fake({ [PATH]: '\n' })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    f.files[PATH] += line('r1', { in: 2 }) + '\n'
    expect((await readSessionTokens(f.cmd, h, SRC)).tokens?.input).toBe(2)
    f.files[PATH] += line('r1', { in: 2 }) + '\n' + line('r2', { in: 7 }) + '\n'
    expect((await readSessionTokens(f.cmd, h, SRC)).tokens?.input).toBe(7)
  })

  test('a new session id resets to a null baseline', async () => {
    const f = fake({ [PATH]: '\n', '/cfg/projects/-work-space/sess-2.jsonl': 'x\n' })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    const r = await readSessionTokens(f.cmd, h, { ...SRC, session: 'sess-2' })
    expect(r).toEqual({ tokens: null, cost: null, problem: 'no baseline' })
    expect(h.state?.session).toBe('sess-2')
  })

  test('a shrunk file, a missing file and an unsafe session id give null and a problem', async () => {
    const f = fake({ [PATH]: line('r1', {}) + '\n' })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    f.files[PATH] = '\n'
    expect((await readSessionTokens(f.cmd, h, SRC)).problem).toBe('session transcript shrank')
    delete f.files[PATH]
    expect((await readSessionTokens(f.cmd, h, SRC)).problem).toBe('session transcript not found')
    expect(await readSessionTokens(f.cmd, h, { ...SRC, session: '../x' })).toEqual({ tokens: null, cost: null, problem: 'session transcript not found (no session)' })
  })

  test('the find fallback locates a transcript under another project folder', async () => {
    const other = '/cfg/projects/-elsewhere/sess-1.jsonl'
    const f = fake({ [other]: 'a\n' })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    expect(h.state?.path).toBe(other)
    expect(f.calls.some(c => c[0] === 'find' && c.includes('-maxdepth') && c.includes('2'))).toBe(true)
  })

  test('a dd failure gives null and never throws', async () => {
    const f = fake({ [PATH]: 'a\n' }, { ddFails: true })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    f.files[PATH] += line('r1', { in: 1 }) + '\n'
    const r = await readSessionTokens(f.cmd, h, SRC)
    expect(r.tokens).toBeNull()
    expect(r.problem).toContain('dd failed')
    const boom = await readSessionTokens(async () => { throw new Error('boom') }, newSessionTokenState(), SRC)
    expect(boom.tokens).toBeNull()
  })

  test('a read larger than the cap continues next minute; a full chunk with no newline resets', async () => {
    const l = line('r1', { in: 1 }) + '\n'
    const n = Math.ceil((CHUNK_BYTES + 10) / bytes(l))
    const f = fake({ [PATH]: '\n' })
    const h = newSessionTokenState()
    await readSessionTokens(f.cmd, h, SRC)
    let body = ''
    for (let i = 0; i < n; i++) body += line(`q${i}`, { in: 1 }) + '\n'
    f.files[PATH] += body
    const a = await readSessionTokens(f.cmd, h, SRC)
    const b = await readSessionTokens(f.cmd, h, SRC)
    expect((a.tokens?.input ?? 0) + (b.tokens?.input ?? 0)).toBe(n)
    expect(a.tokens?.input).toBeLessThan(n)

    f.files[PATH] += 'x'.repeat(CHUNK_BYTES + 1)
    const c = await readSessionTokens(f.cmd, h, SRC)
    expect(c).toEqual({ tokens: null, cost: null, problem: 'session transcript chunk has no newline' })
    expect(h.state?.offset).toBe(bytes(f.files[PATH] as string))
  })

  describe('cost', () => {
    const priced = (id: string, model: string, u: { in?: number; out?: number; c5?: number; c1?: number }) =>
      JSON.stringify({
        type: 'assistant',
        requestId: id,
        message: {
          model,
          usage: {
            input_tokens: u.in ?? 0,
            output_tokens: u.out ?? 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: (u.c5 ?? 0) + (u.c1 ?? 0),
            cache_creation: { ephemeral_5m_input_tokens: u.c5 ?? 0, ephemeral_1h_input_tokens: u.c1 ?? 0 },
          },
        },
      }) + '\n'

    test('requests on two priced models cost their hand-computed sum, with the 5m and 1h cache split', async () => {
      const f = fake({ [PATH]: '\n' })
      const h = newSessionTokenState()
      await readSessionTokens(f.cmd, h, SRC)
      // opus-5: input 5, output 25, 5m write 6.25, 1h write 10 per million
      f.files[PATH] += priced('a', 'claude-opus-5-5', { in: 1_000_000, out: 100_000, c5: 1_000_000, c1: 1_000_000 }) + priced('b', 'claude-opus-5-5', { in: 1_000_000 })
      const r = await readSessionTokens(f.cmd, h, SRC)
      expect(r.cost).toBe(5 + 2.5 + 6.25 + 10 + 5)
      expect(r.unpriced).toBeUndefined()
      expect(r.tokens?.input).toBe(2_000_000)
    })

    test('an unpriced model gives a null cost, keeps the tokens and names the model', async () => {
      const f = fake({ [PATH]: '\n' })
      const h = newSessionTokenState()
      await readSessionTokens(f.cmd, h, SRC)
      f.files[PATH] += priced('a', 'claude-opus-5-5', { in: 10 }) + priced('b', 'claude-future-9', { in: 20 })
      const r = await readSessionTokens(f.cmd, h, SRC)
      expect(r.cost).toBeNull()
      expect(r.unpriced).toEqual(['claude-future-9'])
      expect(r.tokens?.input).toBe(30)
    })

    test('a read with no new bytes costs 0, and a request straddling two reads is priced once', async () => {
      const f = fake({ [PATH]: '\n' })
      const h = newSessionTokenState()
      await readSessionTokens(f.cmd, h, SRC)
      expect((await readSessionTokens(f.cmd, h, SRC)).cost).toBe(0)
      f.files[PATH] += priced('a', 'claude-opus-5-5', { in: 1_000_000 })
      expect((await readSessionTokens(f.cmd, h, SRC)).cost).toBe(5)
      f.files[PATH] += priced('a', 'claude-opus-5-5', { in: 1_000_000 }) + priced('b', 'claude-opus-5-5', { in: 1_000_000 })
      expect((await readSessionTokens(f.cmd, h, SRC)).cost).toBe(5)
    })
  })
})
