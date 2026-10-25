// The restart precheck of `update` (#1345): the check's classification, and the op with each outcome.
import { describe, expect, test } from 'claude-code/testing'

import type { FileIo } from '../hooks/control'
import { controlPath, runOp } from '../hooks/control'
import { opInterventions } from '../hooks/v2/act-events'
import { restartCheck } from '../hooks/update-check'
import type { CheckRun, RestartCheck } from '../hooks/update-check'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const PATHS = { loopDir: '/loop', configDir: '/cfg' }

const runs = (r: Awaited<ReturnType<CheckRun>> | Error) => {
  const calls: { argv: string[]; timeoutMs: number }[] = []
  const run: CheckRun = async (argv, opts) => {
    calls.push({ argv, timeoutMs: opts.timeoutMs })
    if (r instanceof Error) throw r
    return r
  }
  return { run, calls }
}

describe('restartCheck', () => {
  test('exit 0 is ok, and the argv and timeout are the contract', async () => {
    const f = runs({ exitCode: 0, stderr: '' })
    expect(await restartCheck(f.run)).toEqual({ kind: 'ok' })
    expect(f.calls[0]?.argv).toEqual(['dev-restart-self', '--check'])
    expect(f.calls[0]?.timeoutMs).toBeLessThanOrEqual(1000)
  })
  test('exit 1 takes the last stderr line without the prefix', async () => {
    const stderr = 'noise\ndev-restart-self: no Coder session token (set CODER_SESSION_TOKEN); see "Coder CLI" in images/base/README.md.\n'
    expect(await restartCheck(runs({ exitCode: 1, stderr }).run)).toEqual({ kind: 'missing', reason: 'no Coder session token (set CODER_SESSION_TOKEN); see "Coder CLI" in images/base/README.md.' })
  })
  test('exit 2, a throw, a timeout and other exits are unchecked', async () => {
    expect(await restartCheck(runs({ exitCode: 2, stderr: 'usage' }).run)).toEqual({ kind: 'unchecked', why: "this image's dev-restart-self has no --check" })
    expect(await restartCheck(runs(new Error('ENOENT')).run)).toMatchObject({ kind: 'unchecked' })
    expect(await restartCheck(runs({ exitCode: 143, stderr: '', timedOut: true }).run)).toEqual({ kind: 'unchecked', why: 'the check did not answer within 1 s' })
    expect(await restartCheck(runs({ exitCode: 9, stderr: '' }).run)).toMatchObject({ kind: 'unchecked' })
  })
})

describe('runOp update with the check', () => {
  const setup = () => {
    const writes: string[] = []
    const io: FileIo = { readFile: async () => null, writeFile: async path => { writes.push(path) } }
    return { io, writes }
  }
  const check = (result: RestartCheck) => {
    const f = { calls: 0 }
    return { f, restartCheck: async () => { f.calls += 1; return result } }
  }

  test('missing refuses, notes it and writes nothing', async () => {
    const s = setup()
    const c = check({ kind: 'missing', reason: 'no Coder session token' })
    const r = await runOp(s.io, PATHS, 'update x', NOW, { restartCheck: c.restartCheck })
    expect(r).toMatchObject({ ok: false, text: 'Not changed: this workspace cannot restart itself: no Coder session token', noted: 'update-refused no Coder session token', ping: false, logged: null })
    expect(s.writes).toEqual([])
  })
  test('ok accepts as today', async () => {
    const s = setup()
    const r = await runOp(s.io, PATHS, 'update x', NOW, { restartCheck: check({ kind: 'ok' }).restartCheck })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('Update due (x): the loop winds down (up to windDownMinutes), then restarts this workspace.')
    expect(s.writes).toEqual([controlPath(PATHS.loopDir)])
  })
  test('unchecked accepts and says so', async () => {
    const s = setup()
    const r = await runOp(s.io, PATHS, 'update x', NOW, { restartCheck: check({ kind: 'unchecked', why: 'the check did not answer within 1 s' }).restartCheck })
    expect(r.ok).toBe(true)
    expect(r.text.endsWith(' Credentials unchecked: the check did not answer within 1 s.')).toBe(true)
    expect(s.writes).toHaveLength(1)
  })
  test('no check behaves as today; update off, status and an agent run no check', async () => {
    const s = setup()
    expect((await runOp(s.io, PATHS, 'update x', NOW)).text).not.toContain('unchecked')
    const c = check({ kind: 'missing', reason: 'r' })
    await runOp(s.io, PATHS, 'update off', NOW, { restartCheck: c.restartCheck })
    await runOp(s.io, PATHS, 'status', NOW, { restartCheck: c.restartCheck })
    const agent = await runOp(s.io, PATHS, 'update x', NOW, { restartCheck: c.restartCheck, agentId: 'a1' })
    expect(agent.text).toContain('only the main conversation')
    expect(c.f.calls).toBe(0)
  })
})

test('a refusal logs as the intervention op:update-refused with the reason', () => {
  const [e] = opInterventions({ text: 'update-refused no token', name: 'update-refused', issues: [], at: NOW, by: 'person' })
  expect(e).toMatchObject({ cause: 'op:update-refused', reason: 'update-refused no token' })
})
