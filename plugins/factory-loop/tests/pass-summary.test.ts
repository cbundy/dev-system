// The minute summary carries the orchestrator's tokens (#1302): a minute not sent still advances the
// transcript offset, and a runtime without a config dir sends null fields.
import { describe, expect, test } from 'claude-code/testing'

import type { RunResult } from '../hooks/exec'
import { flushMinute, holdsLock } from '../hooks/pass-summary'
import type { SummaryHost } from '../hooks/pass-summary'
import type { Runtime } from '../hooks/observe'

const PATH = '/cfg/projects/-w/s1.jsonl'
const bytes = (s: string) => new TextEncoder().encode(s).length
const line = (id: string, n: number) => JSON.stringify({ type: 'assistant', requestId: id, message: { model: 'm', usage: { input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n'

function setup(withDir: boolean) {
  let file = '\n'
  const sent: Record<string, unknown>[] = []
  const rt = { mode: 'act', repo: 'r', config: { passEveryMs: 1 }, ...(withDir ? { configDir: '/cfg', sessionCwd: '/w', workspace: { session: 's1' } } : {}) } as unknown as Runtime
  const host: SummaryHost = {
    rt: () => rt,
    killed: async () => false,
    send: async (_rt, argv) => void sent.push(JSON.parse(argv[4] as string)),
    run: async (_rt, argv): Promise<RunResult> => {
      if (argv[0] === 'stat') return { exitCode: 0, stdout: `${bytes(file)}\n`, stderr: '' }
      if (argv[0] === 'dd') return { exitCode: 0, stdout: new TextDecoder().decode(new TextEncoder().encode(file).subarray(Number((argv[3] as string).slice(5)))), stderr: '' }
      return { exitCode: 1, stdout: '', stderr: '' }
    },
  }
  const $ = { clock: { now: async () => 10 * 60_000 + 5 } } as never
  return { host, sent, $, append: (s: string) => void (file += s) }
}

describe('flushMinute tokens', () => {
  test('an unsent minute still advances the offset, so the next sent minute holds only its own tokens', async () => {
    const t = setup(true)
    holdsLock(true)
    await flushMinute(t.$, t.host)
    expect(t.sent[0]?.input_tokens).toBeNull()
    t.append(line('a', 100))
    holdsLock(false)
    await flushMinute(t.$, t.host)
    expect(t.sent).toHaveLength(1)
    t.append(line('b', 7))
    holdsLock(true)
    await flushMinute(t.$, t.host)
    expect(t.sent[1]).toMatchObject({ input_tokens: 7, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })
  })

  test('a runtime without a config dir sends null fields', async () => {
    const t = setup(false)
    holdsLock(true)
    await flushMinute(t.$, t.host)
    expect(t.sent[0]).toMatchObject({ input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null })
  })
})
