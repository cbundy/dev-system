// The rollout executor (act-merge.ts) against a fake ExecCtx: its argv, timeout and stdin, the
// reader of callum-flow-rollout's lines (images/base/callum-flow-rollout and its tests under
// features/test/callum-tools/) and each outcome the rule reads next.
import { describe, expect, test } from 'claude-code/testing'

import { failure, mergeExecutors, parseRollout } from '../hooks/act-merge'
import type { ActIo, Exec, ExecCtx, Executor, RunInit, RunResult } from '../hooks/exec'
import type { Runtime } from '../hooks/observe'
import type { Action, ActionKind, LedgerEntry } from '../hooks/types'
import { DEVICE, NOW, PLUGIN_ROOT, config, entry, state } from './fixtures'

const REPO = 'cbundy/dev-system'
const LOOP_DIR = '/cfg/factory-loop/cbundy__dev-system'
const RATE = 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)'

type Call = { argv: string[]; init: RunInit }
type Reply = Partial<RunResult> | Error

function runtime(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/workspaces/dev-system',
    loopDir: LOOP_DIR,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: '/usr/local/share/callum-tools',
    pluginRoot: PLUGIN_ROOT,
    config: config(),
    configProblems: [],
  }
}

type Over = { ledger?: LedgerEntry[]; attempts?: number; event?: (type: string, data: Record<string, unknown>, at: { issue: number }) => Promise<void> }

// harness: a fake ExecCtx whose commands answer from `replies` in order (a missing reply is a
// quiet exit 0), recording every command and event.
function harness(replies: Reply[] = [], over: Over = {}) {
  const calls: Call[] = []
  const events: { type: string; data: Record<string, unknown>; issue: number }[] = []
  let next = 0
  const io: ActIo = {
    now: async () => NOW,
    run: async () => {
      throw new Error('executors run commands through ctx.cmd')
    },
    spawnAgent: async () => ({ deny: 'no agents in this test' }),
    stopAgent: async () => ({ stopped: false, error: 'no agents in this test' }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: null, sevenDay: null }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const s = state()
  const ctx: ExecCtx = {
    io,
    rt: runtime(),
    state: { ...s, ledger: over.ledger ?? s.ledger },
    entry: entry('under-test', 'respond', { status: 'running', endedAt: null, attempts: over.attempts ?? 1 }),
    cmd: async (argv, init) => {
      calls.push({ argv, init })
      const reply = replies[next++] ?? {}
      if (reply instanceof Error) throw reply
      return { exitCode: 0, stdout: '', stderr: '', ...reply }
    },
    event: async (type, data, at) => {
      events.push({ type, data, issue: at.issue })
      if (over.event !== undefined) await over.event(type, data, at)
    },
    wakeId: () => 'w1',
  }
  return { ctx, calls, events }
}

function executor(kind: ActionKind): Executor {
  const run = mergeExecutors[kind]
  if (run === undefined) throw new Error(`no executor for ${kind}`)
  return run
}

async function exec(action: Action, replies: Reply[] = [], over: Over = {}) {
  const h = harness(replies, over)
  const result = await executor(action.kind)(h.ctx, action)
  return { result, ...h }
}

// --- the actions, as plan emits them -------------------------------------------------------------

const base = { class: 'free' as const, reason: 'test', issue: 50 }
const A = {
  other: (): Action => ({ ...base, kind: 'heartbeat', key: 'heartbeat:0', rule: 'H1', issue: null }),
  rollout: (issue: number | null = 50): Action => ({ ...base, issue, kind: 'rollout', key: `rollout:${issue}`, rule: 'M7', pr: 550 }),
}

describe('parsers, against the CLIs\' own lines (v2 SPEC 13.6.1)', () => {
  test('parseRollout: the three values, and conflict, invalid, unreadable', () => {
    expect(parseRollout('ROLLOUT merge source=brief\n')).toEqual({ rollout: 'merge', source: 'brief', line: 'ROLLOUT merge source=brief' })
    expect(parseRollout('ROLLOUT run-it source=body')).toMatchObject({ rollout: 'run-it', source: 'body' })
    expect(parseRollout('ROLLOUT keep-open source=brief')).toMatchObject({ rollout: 'keep-open' })
    const conflict = "ROLLOUT conflict brief says merge but issue #50 has a '## Run it' heading"
    expect(parseRollout(conflict)).toEqual({ rollout: null, problem: 'conflict', line: conflict })
    expect(parseRollout("ROLLOUT invalid brief Rollout 'sometimes' is not merge, run-it or keep-open")).toMatchObject({ rollout: null, problem: 'invalid' })
    expect(parseRollout('ROLLOUT unreadable cannot read issue #50')).toMatchObject({ rollout: null, problem: 'unreadable' })
    expect(parseRollout('')).toEqual({ rollout: null, problem: 'unknown', line: '' })
  })
})

describe('rollout (rule M7 for a hand merge, D-29)', () => {
  test('the rollout as callum-flow-rollout says it; no close_issue for a hand merge', async () => {
    for (const value of ['merge', 'run-it', 'keep-open'] as const) {
      const { result, calls } = await exec(A.rollout(), [{ stdout: `ROLLOUT ${value} source=brief\n` }])
      expect(calls).toEqual([{ argv: ['callum-flow-rollout', '50'], init: { timeoutMs: 60_000 } }])
      expect(result).toEqual({ status: 'done', outcome: { kind: 'rollout', rollout: value, closeIssue: null }, summary: `ROLLOUT ${value} source=brief` })
    }
  })

  test('conflict, invalid or unreadable: failed with the line, so the owner hears once retries run out', async () => {
    const conflict = "ROLLOUT conflict brief says merge but issue #50 has a '## Run it' heading"
    const { result } = await exec(A.rollout(), [{ exitCode: 1, stdout: `${conflict}\n` }])
    expect(result).toEqual({ status: 'failed', outcome: { kind: 'cli', exit: 1, detail: conflict }, summary: `callum-flow-rollout: exit 1: ${conflict}` })
    const unreadable = (await exec(A.rollout(), [{ exitCode: 1, stdout: 'ROLLOUT unreadable cannot read issue #50\n', stderr: 'callum-flow-rollout: cannot read issue #50\n' }])).result
    expect(unreadable).toMatchObject({ status: 'failed', summary: 'callum-flow-rollout: exit 1: ROLLOUT unreadable cannot read issue #50' })
    expect((await exec(A.rollout(), [{ stdout: 'something else' }])).result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 0 } })
    expect((await exec(A.rollout(), [{ exitCode: 2, stderr: 'usage: callum-flow-rollout <issue>' }])).result).toMatchObject({ noRetry: true })
  })

  test('no issue: refused without running anything', async () => {
    const { result, calls } = await exec(A.rollout(null))
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ status: 'failed', summary: 'refused: a rollout read names no issue', noRetry: true })
  })
})

describe('every executor', () => {
  test('mergeExecutors covers exactly its kinds, and each refuses another kind', async () => {
    expect(Object.keys(mergeExecutors).sort()).toEqual(['rollout'])
    const h = harness()
    const result: Exec = await executor('rollout')(h.ctx, A.other())
    expect(result).toMatchObject({ status: 'failed', noRetry: true })
    expect(h.calls).toHaveLength(0)
  })

  test('failure: exit 2 is a usage error only for the image\'s own CLIs', () => {
    const r = (exitCode: number, stderr = ''): RunResult => ({ exitCode, stdout: '', stderr })
    expect(failure(['callum-flow-rollout', '550'], r(2))).toMatchObject({ noRetry: true })
    expect('noRetry' in failure(['git', 'switch', 'x'], r(2))).toBe(false)
    expect('noRetry' in failure(['treehouse', 'get'], r(2))).toBe(false)
    expect(failure(['callum-flow-rollout', '550'], r(1, RATE))).toMatchObject({ rateLimited: true })
  })
})
