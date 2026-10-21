// The token totals and model of an agent step (v2/step-tokens.ts, #657): the pure reading of a
// transcript, and the file, lookup and nested-agent reading around it over a fake file system.
import { describe, expect, test } from 'claude-code/testing'

import type { RunInit, RunResult } from '../hooks/exec'
import { NO_TOKENS, readStepTokens, tokensOf, transcriptPath } from '../hooks/v2/step-tokens'

type Usage = { in?: number; out?: number; read?: number; create?: number }
const line = (requestId: string | null, model: string, u: Usage) =>
  JSON.stringify({
    type: 'assistant',
    ...(requestId === null ? {} : { requestId }),
    message: { model, usage: { input_tokens: u.in ?? 0, output_tokens: u.out ?? 0, cache_read_input_tokens: u.read ?? 0, cache_creation_input_tokens: u.create ?? 0 } },
  })

describe('tokensOf', () => {
  test('counts usage once per requestId (the last line wins), keeps a line without one, skips garbage, takes the model of most turns', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      line('r1', 'claude-sonnet-5', { in: 1, out: 2, read: 100, create: 10 }),
      line('r1', 'claude-sonnet-5', { in: 1, out: 50, read: 100, create: 10 }),
      'not json at all {',
      line('r2', 'claude-opus-5-5', { in: 3, out: 4, read: 200, create: 0 }),
      line(null, 'claude-opus-5-5', { in: 5, out: 6 }),
      line('r4', '<synthetic>', {}),
      '',
    ].join('\n')
    expect(tokensOf(text)).toEqual({ input: 9, output: 60, cacheRead: 300, cacheCreation: 10, model: 'claude-opus-5-5' })
  })

  test('a tie of models goes to the one seen later; no turn is no model', () => {
    expect(tokensOf([line('a', 'm1', {}), line('b', 'm2', {})].join('\n')).model).toBe('m2')
    expect(tokensOf([line('a', 'm2', {}), line('b', 'm1', {})].join('\n')).model).toBe('m1')
    expect(tokensOf('')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: null })
  })
})

const CONFIG = '/cfg'
const CWD = '/work/my.repo'
const SESSION = 'sess-1'
const DIR = `${CONFIG}/projects/-work-my-repo/${SESSION}/subagents`

// files: path -> text; the command runner answers find and grep over them the way the real ones do
function world(files: Record<string, string>) {
  const cmds: string[][] = []
  const readFile = async (p: string) => files[p] ?? null
  const cmd = async (argv: string[], _init: RunInit): Promise<RunResult> => {
    cmds.push(argv)
    const ok = (stdout: string): RunResult => ({ exitCode: stdout === '' ? 1 : 0, stdout, stderr: '' })
    if (argv[0] === 'find') {
      const tail = (argv[argv.indexOf('-path') + 1] ?? '').replace(/^\*/, '')
      return ok(
        Object.keys(files)
          .filter(p => p.endsWith(tail))
          .join('\n'),
      )
    }
    if (argv[0] === 'grep') {
      const needle = argv[argv.length - 2] ?? ''
      const dir = argv[argv.length - 1] ?? ''
      return ok(
        Object.keys(files)
          .filter(p => p.startsWith(`${dir}/`) && p.endsWith('.meta.json') && (files[p] ?? '').includes(needle))
          .join('\n'),
      )
    }
    return { exitCode: 127, stdout: '', stderr: 'no' }
  }
  return { cmds, io: { readFile }, cmd }
}
const src = (agentId: string) => ({ configDir: CONFIG, sessionCwd: CWD, session: SESSION, agentId })
const file = (id: string) => `${DIR}/agent-${id}.jsonl`
const meta = (id: string) => `${DIR}/agent-${id}.meta.json`

describe('readStepTokens', () => {
  test('the transcript path is the config dir, the munged cwd, the session and the agent', () => {
    expect(transcriptPath(CONFIG, CWD, SESSION, 'a1')).toBe(file('a1'))
  })

  test('reads the file at the primary path with no command', async () => {
    const w = world({ [file('a1')]: line('r1', 'claude-opus-5-5', { in: 1, out: 2, read: 3, create: 4 }) })
    expect(await readStepTokens(w.io, w.cmd, src('a1'))).toEqual({
      fields: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4, model: 'claude-opus-5-5' },
      problem: null,
    })
    expect(w.cmds.filter(c => c[0] === 'find')).toEqual([])
  })

  test('absent there, one bounded find over the projects locates it', async () => {
    const other = `${CONFIG}/projects/-elsewhere/${SESSION}/subagents/agent-a1.jsonl`
    const w = world({ [other]: line('r1', 'm', { in: 7 }) })
    const r = await readStepTokens(w.io, w.cmd, src('a1'))
    expect(r.fields.input_tokens).toBe(7)
    expect(w.cmds.find(c => c[0] === 'find')).toEqual(['find', `${CONFIG}/projects`, '-maxdepth', '4', '-path', `*/${SESSION}/subagents/agent-a1.jsonl`])
  })

  test('absent everywhere: null fields and a reason; an unsafe id or no session reads nothing', async () => {
    const w = world({})
    expect(await readStepTokens(w.io, w.cmd, src('a1'))).toEqual({ fields: NO_TOKENS, problem: 'transcript not found' })
    expect((await readStepTokens(w.io, w.cmd, { ...src('a1'), session: '' })).fields).toEqual(NO_TOKENS)
    expect((await readStepTokens(w.io, w.cmd, src('a*'))).fields).toEqual(NO_TOKENS)
  })

  test('a failing file read is null fields and a reason, never a throw', async () => {
    const cmd = async (): Promise<RunResult> => ({ exitCode: 1, stdout: '', stderr: '' })
    const r = await readStepTokens({ readFile: async () => { throw new Error('EIO') } }, cmd, src('a1'))
    expect(r.fields).toEqual(NO_TOKENS)
    expect(r.problem).toBe('transcript unreadable: EIO')
  })

  test('adds nested agents recursively, keeps the model of the step agent, skips a meta that is not JSON', async () => {
    const w = world({
      [file('a1')]: line('r1', 'claude-opus-5-5', { in: 1, out: 1 }),
      [file('b1')]: line('r2', 'claude-sonnet-5', { in: 10, out: 10, read: 5 }),
      [file('c1')]: line('r3', 'claude-sonnet-5', { in: 100, create: 7 }),
      [file('d1')]: line('r4', 'claude-sonnet-5', { in: 1000 }),
      [meta('b1')]: '{"agentType":"x","parentAgentId":"a1","spawnDepth":2}',
      [meta('c1')]: '{"parentAgentId":"b1"}',
      [meta('d1')]: '{"parentAgentId":"a1"',
    })
    const r = await readStepTokens(w.io, w.cmd, src('a1'))
    expect(r.fields).toEqual({ input_tokens: 111, output_tokens: 11, cache_read_tokens: 5, cache_creation_tokens: 7, model: 'claude-opus-5-5' })
    expect(r.problem).toBeNull()
  })
})
