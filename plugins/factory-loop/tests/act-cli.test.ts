// The executors that spend no tokens (act-cli.ts) against a fake ExecCtx: each kind's argv,
// cwd, timeout and stdin, and its outcome for success, each documented failure and a GitHub
// rate limit. Exit codes and output lines are the real CLIs' (images/base/callum-flow-claim,
// callum-flow-sweep, callum-flow-milestone, callum-flow-event, dev-restart-self; gh 2.102;
// treehouse status --json as it printed on 2026-10-13).
import { describe, expect, test } from 'claude-code/testing'

import { WIND_DOWN_WRITE_SCRIPT } from '../hooks/v2/wind-down-files'
import { CLI_TIMEOUT_MS, NO_EXIT, cliExecutors, commandFailure, eventFailure, finish, ownAgent, stepsOf, usageError } from '../hooks/act-cli'
import type { ActIo, Exec, ExecCtx, Executor, RunInit, RunResult } from '../hooks/exec'
import type { Runtime } from '../hooks/observe'
import type { Action, ActionKind, AgentView, LedgerEntry } from '../hooks/types'
import { DEVICE, NOW, PLUGIN_ROOT, config, entry, state } from './fixtures'

const REPO = 'cbundy/dev-system'
const RATE = 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)'

type Call = { argv: string[]; init: RunInit }
type Reply = Partial<RunResult> | Error

const LOOP = '/cfg/factory-loop/cbundy__dev-system'

function runtime(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/workspaces/dev-system',
    loopDir: '/cfg/factory-loop/cbundy__dev-system',
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: '/usr/local/share/callum-tools',
    pluginRoot: PLUGIN_ROOT,
    config: config(),
    configProblems: [],
  }
}

type Over = {
  ledger?: LedgerEntry[]
  agents?: AgentView[]
  stop?: (agentId: string) => Promise<{ stopped: boolean; error?: string }>
  rename?: (title: string) => Promise<void>
  event?: (type: string, data: Record<string, unknown>, at: { issue: number }) => Promise<void>
}

// harness: a fake ExecCtx whose commands answer from `replies` in order (a missing reply is a
// quiet exit 0), recording every command, event, stop and rename.
function harness(replies: Reply[] = [], over: Over = {}) {
  const calls: Call[] = []
  const events: { type: string; data: Record<string, unknown>; issue: number }[] = []
  const stops: string[] = []
  const titles: string[] = []
  let next = 0
  const io: ActIo = {
    now: async () => NOW,
    run: async () => {
      throw new Error('executors run commands through ctx.cmd')
    },
    spawnAgent: async () => ({ deny: 'no agents in this test' }),
    stopAgent: async agentId => {
      stops.push(agentId)
      return over.stop === undefined ? { stopped: true } : over.stop(agentId)
    },
    submit: async () => undefined,
    rename: async text => {
      titles.push(text)
      if (over.rename !== undefined) await over.rename(text)
    },
    usage: async () => ({ fiveHour: null, sevenDay: null }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const ctx: ExecCtx = {
    io,
    rt: runtime(),
    state: state({ ...(over.ledger === undefined ? {} : { ledger: over.ledger }), ...(over.agents === undefined ? {} : { agents: over.agents }) }),
    entry: entry('under-test', 'heartbeat', { status: 'running', endedAt: null }),
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
  return { ctx, calls, events, stops, titles }
}

function executor(kind: ActionKind): Executor {
  const run = cliExecutors[kind]
  if (run === undefined) throw new Error(`no executor for ${kind}`)
  return run
}

async function exec(action: Action, replies: Reply[] = [], over: Over = {}) {
  const h = harness(replies, over)
  const result = await executor(action.kind)(h.ctx, action)
  return { result, ...h }
}

// --- the actions, as plan emits them ---------------------------------------------------------

const base = { class: 'free' as const, reason: 'test' }
const A = {
  heartbeat: (): Action => ({ ...base, kind: 'heartbeat', key: 'heartbeat:0', rule: 'H1', issue: null }),
  sweep: (): Action => ({ ...base, kind: 'sweep', key: 'sweep:0', rule: 'H2', issue: null }),
  claim: (issue: number | null = 470): Action => ({ ...base, class: 'start', kind: 'claim', key: `claim:${issue}:new`, rule: 'D1', issue }),
  close: (): Action => ({ ...base, kind: 'close-issue', key: 'close:470', rule: 'M7', issue: 470 }),
  closeDone: (): Action => ({ ...base, kind: 'close-issue', key: 'i470/follow/close-issue', rule: 'S3', issue: 470, logClosed: true }),
  deleteBranch: (): Action => ({ ...base, kind: 'delete-branch', key: 'i470/follow/delete-branch', rule: 'S3', issue: 470, branch: 'issue-470', sha: 'abc1234def' }),
  releaseParent: (): Action => ({ ...base, kind: 'release-parent', key: 'release-parent:470', rule: 'D3', issue: 470, created: [471, 472] }),
  later: (): Action => ({ ...base, kind: 'milestone-later', key: 'milestone-later:470', rule: 'M7', issue: 470 }),
  restart: (rule = 'H4'): Action => ({ ...base, kind: 'restart-self', key: 'restart:1', rule, issue: null, why: 'image 1.2.3', at: 1 }),
  stop: (agentId = 'a1'): Action => ({ ...base, kind: 'stop-agent', key: `stop:${agentId}`, rule: 'A1', reason: 'timed out', issue: 470, agentId, entry: 'design:470:1' }),
  title: (text = '🔄 dev-system (Q:1 - D:2 - M:0)'): Action => ({ ...base, kind: 'title', key: 'title', rule: 'O1', issue: null, text }),
}

describe('stepsOf: the argv templates (v2 SPEC 13.6.1)', () => {
  const argv = (a: Action) => {
    const steps = stepsOf(a, REPO, LOOP)
    if (typeof steps === 'string') throw new Error(steps)
    return steps.map(s => ('argv' in s ? s.argv : [`event:${s.event}`]))
  }

  test('each kind runs exactly its catalogue row, gh always with --repo', () => {
    expect(argv(A.heartbeat())).toEqual([['callum-flow-claim', '--heartbeat']])
    expect(argv(A.sweep())).toEqual([['callum-flow-sweep']])
    expect(argv(A.claim())).toEqual([['callum-flow-claim', '470']])
    expect(argv(A.close())).toEqual([['gh', 'issue', 'close', '470', '--repo', REPO, '--reason', 'completed']])
    expect(argv(A.releaseParent())).toEqual([['event:abandoned']])
    expect(argv(A.later())).toEqual([['callum-flow-milestone', 'plan', '470', 'later']])
    expect(argv(A.restart())).toEqual([['dev-restart-self']])
    expect(argv(A.restart('R2'))).toEqual([['dev-restart-self']])
    expect(argv({ ...A.restart('R2'), windDownAt: null } as Action)).toEqual([['dev-restart-self']])
  })

  test('R2 with a wind-down writes the request first, in the status file\'s time form', () => {
    const at = Date.UTC(2026, 9, 19, 1, 2, 3, 456)
    const steps = stepsOf({ ...A.restart('R2'), windDownAt: at } as Action, REPO, LOOP)
    if (typeof steps === 'string') throw new Error(steps)
    expect(steps.map(s => ('argv' in s ? s.argv : []))).toEqual([['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'wind-down-request', `${LOOP}/wind-down.request`], ['dev-restart-self']])
    expect(steps[0]).toMatchObject({ stdin: '{"requested_at":"2026-10-19T01:02:03.456Z","trigger":"restart-self"}\n' })
  })

  test('refusals: an issue kind with no issue, restart-self outside H4, a kind that runs no command', () => {
    expect(stepsOf(A.claim(null), REPO, LOOP)).toBe('claim names no issue')
    expect(stepsOf(A.restart('O1'), REPO, LOOP)).toBe('restart-self comes only from rule H4 or R2, not O1')
    expect(stepsOf(A.title(), REPO, LOOP)).toBe('title runs no command')
  })

  test('no template can pass a forbidden flag or command (v2 SPEC 13.6.1)', () => {
    const all = [A.heartbeat(), A.sweep(), A.claim(), A.close(), A.releaseParent(), A.later(), A.restart()]
    for (const a of all) {
      for (const words of argv(a)) {
        const line = words.join(' ')
        expect(line).not.toMatch(/--yes|\brerun\b|\babort\b|\bcoder\b|\bp?kill(all)?\b|pr edit|--add-label|--delete-branch|--force/)
      }
    }
  })
})

describe('the commands each executor runs', () => {
  test('argv, cwd (the main checkout: none given), timeout and stdin, per kind', async () => {
    const cases: [Action, number, string | undefined][] = [
      [A.heartbeat(), 120_000, undefined],
      [A.sweep(), 300_000, undefined],
      [A.claim(), 120_000, undefined],
      [A.close(), 60_000, undefined],
      [A.later(), 60_000, undefined],
      [A.restart(), 600_000, undefined],
    ]
    for (const [action, timeoutMs, stdin] of cases) {
      const { calls } = await exec(action)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.init.cwd).toBeUndefined()
      expect(calls[0]?.init).toEqual(stdin === undefined ? { timeoutMs } : { timeoutMs, stdin })
      expect(CLI_TIMEOUT_MS[action.kind as keyof typeof CLI_TIMEOUT_MS]).toBe(timeoutMs)
    }
  })

})

describe('heartbeat and sweep', () => {
  test('exit 0 is done with the exit code', async () => {
    expect((await exec(A.heartbeat())).result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'leases renewed' })
    expect((await exec(A.sweep())).result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'swept' })
  })

  test('exit 1 (a gh failure) is failed with its stderr, retried by the rule', async () => {
    const { result } = await exec(A.heartbeat(), [{ exitCode: 1, stderr: 'callum-flow-claim: cannot renew the claim on #470\n' }])
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 1, detail: 'callum-flow-claim: cannot renew the claim on #470' },
      summary: 'callum-flow-claim --heartbeat: exit 1: callum-flow-claim: cannot renew the claim on #470',
    })
  })

  test('exit 2 is a usage error: never retried', async () => {
    const { result } = await exec(A.sweep(), [{ exitCode: 2, stderr: 'callum-flow-sweep: takes no arguments\nusage: callum-flow-sweep\n' }])
    expect(result).toMatchObject({ status: 'failed', noRetry: true, outcome: { kind: 'cli', exit: 2 } })
  })

  test('a GitHub rate limit in stderr is flagged for the backoff', async () => {
    const { result } = await exec(A.sweep(), [{ exitCode: 1, stderr: `${RATE}\ncallum-flow-sweep: cannot list In development issues\n` }])
    expect(result).toMatchObject({ status: 'failed', rateLimited: true, outcome: { kind: 'cli', exit: 1 } })
    expect('noRetry' in result).toBe(false)
  })
})

describe('claim', () => {
  test('exit 0: claimed', async () => {
    const { result, calls } = await exec(A.claim())
    expect(calls.map(c => c.argv)).toEqual([['callum-flow-claim', '470']])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'claim', result: 'claimed' }, summary: 'claimed #470' })
  })

  test('exit 3: lost to a live claim, a done outcome plan reads (rule D1)', async () => {
    const stderr = 'callum-flow-claim: #470 is held by coder-plant-console-orchestrator since 2026-10-13T02:00:00Z\n'
    const { result } = await exec(A.claim(), [{ exitCode: 3, stderr }])
    expect(result).toEqual({
      status: 'done',
      outcome: { kind: 'claim', result: 'lost' },
      summary: 'lost #470: callum-flow-claim: #470 is held by coder-plant-console-orchestrator since 2026-10-13T02:00:00Z',
    })
  })

  test('exit 1 (an untrusted author, a gh failure): failed with the detail', async () => {
    const { result } = await exec(A.claim(), [{ exitCode: 1, stderr: 'callum-flow-claim: #470 is not by a trusted author - refusing to claim it\n' }])
    expect(result).toMatchObject({
      status: 'failed',
      outcome: { kind: 'cli', exit: 1, detail: 'callum-flow-claim: #470 is not by a trusted author - refusing to claim it' },
    })
  })

  test('exit 2: usage, never retried; a rate limit is flagged', async () => {
    expect((await exec(A.claim(), [{ exitCode: 2, stderr: 'usage: callum-flow-claim <issue>' }])).result).toMatchObject({ status: 'failed', noRetry: true })
    expect((await exec(A.claim(), [{ exitCode: 1, stderr: RATE }])).result).toMatchObject({ status: 'failed', rateLimited: true })
  })

  test('no issue: refused without running anything', async () => {
    const { result, calls } = await exec(A.claim(null))
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ status: 'failed', summary: 'refused: claim names no issue', noRetry: true })
  })
})

describe('gh writes: close-issue', () => {
  test('close-issue: done on exit 0; gh exit 1 failed; gh exit 2 (cancelled) is retried, not a usage error', async () => {
    expect((await exec(A.close())).result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'closed #470' })
    const failed = (await exec(A.close(), [{ exitCode: 1, stderr: 'GraphQL: Could not resolve to an issue with the number of 470. (repository.issue)' }])).result
    expect(failed).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
    const cancelled = (await exec(A.close(), [{ exitCode: 2 }])).result
    expect(cancelled).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 2 } })
    expect('noRetry' in cancelled).toBe(false)
    expect((await exec(A.close(), [{ exitCode: 1, stderr: 'GraphQL: API rate limit exceeded for user ID 1234.' }])).result).toMatchObject({ rateLimited: true })
  })
})

describe('a done close: close-issue logs closed, delete-branch is leased (8.7)', () => {
  test('close-issue with logClosed runs the same close, then logs `closed` (completed); without it, no event', async () => {
    const plain = await exec(A.close())
    expect(plain.events).toEqual([])
    const { result, calls, events } = await exec(A.closeDone())
    expect(calls.map(c => c.argv)).toEqual([['gh', 'issue', 'close', '470', '--repo', REPO, '--reason', 'completed']])
    expect(events).toEqual([{ type: 'closed', data: { reason: 'completed' }, issue: 470 }])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'closed #470' })
    // a close that failed logs nothing
    const failed = await exec(A.closeDone(), [{ exitCode: 1, stderr: 'boom' }])
    expect(failed.events).toEqual([])
    expect(failed.result).toMatchObject({ status: 'failed' })
    // an event that did not log is the close's failure to retry, the close being idempotent
    const unlogged = await exec(A.closeDone(), [], { event: async () => { throw new Error('callum-flow-event closed: exit 1') } })
    expect(unlogged.result).toMatchObject({ status: 'failed' })
  })

  test('delete-branch pushes a delete leased on the head it read, from the main checkout, in 60 s', async () => {
    const { result, calls } = await exec(A.deleteBranch())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['git', 'push', '--force-with-lease=refs/heads/issue-470:abc1234def', 'origin', ':refs/heads/issue-470'])
    expect(calls[0]?.init).toEqual({ timeoutMs: 60_000 })
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0, detail: 'deleted' }, summary: 'deleted issue-470' })
  })

  test('a rejected lease (the branch moved) is done and kept, an answer; any other failure is failed', async () => {
    const moved = (await exec(A.deleteBranch(), [{ exitCode: 1, stderr: 'To github.com:o/r.git\n ! [rejected]        issue-470 (stale info)\nerror: failed to push some refs' }])).result
    expect(moved).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0, detail: 'kept: moved' }, summary: 'kept issue-470: it moved since it was read' })
    const down = (await exec(A.deleteBranch(), [{ exitCode: 1, stderr: 'fatal: unable to access: Could not resolve host' }])).result
    expect(down).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
    const other = (await exec(A.deleteBranch(), [{ exitCode: 128, stderr: 'fatal: boom' }])).result
    expect(other).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 128 } })
  })
})

// the data of a split's abandoned event with no reasons read
const SPLIT = { reason: 'split', split_into: [] as number[], why_split: null, why_count: null, why_parts: null, why_order: null, child_whys: null, stage: null, lives: null, branch: null, pr: null, detail: '' }

describe('release-parent: only the abandoned event, no label edit (#1353)', () => {
  test('release-parent: runs no command, `abandoned` notes the split', async () => {
    const { result, calls, events } = await exec(A.releaseParent())
    expect(calls).toHaveLength(0)
    expect(events).toEqual([{ type: 'abandoned', data: { ...SPLIT, split_into: [471, 472], detail: 'split into 471,472' }, issue: 470 }])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'released #470, split into 471,472' })
  })

  test('release-parent with the designer\'s reasons: the data is what the translator makes of the old token note', async () => {
    const reasons = { why_split: 'It spans two areas', why_count: 'Two: one per area', why_parts: '100% apart', why_order: 'Independent' }
    const action = { ...A.releaseParent(), reasons, childWhys: ['The loop side', 'The image, side'] } as Action
    const { events, result } = await exec(action)
    expect(events).toEqual([
      {
        type: 'abandoned',
        issue: 470,
        data: {
          reason: 'split',
          split_into: [471, 472],
          why_split: 'It spans two areas',
          why_count: 'Two: one per area',
          why_parts: '100% apart',
          why_order: 'Independent',
          child_whys: ['The loop side', 'The image, side'],
          stage: null,
          lives: null,
          branch: null,
          pr: null,
          detail: 'split into 471,472',
        },
      },
    ])
    expect(result.status).toBe('done')
    // reasons that could not be read name only the children
    const unread = await exec({ ...A.releaseParent(), reasons: null, childWhys: null } as Action)
    expect(unread.events).toEqual([{ type: 'abandoned', data: { ...SPLIT, split_into: [471, 472], detail: 'split into 471,472' }, issue: 470 }])
  })

  test('a repo without an "in development" label: any command would fail, none runs, the split is released', async () => {
    const missing = { exitCode: 1, stderr: "failed to update https://github.com/o/r/issues/470: 'in development' not found" }
    const { result, calls, events } = await exec(A.releaseParent(), [missing, missing])
    expect(calls).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect(result).toMatchObject({ status: 'done' })
  })

  test('a failed event is failed; its usage exit is never retried', async () => {
    const usage = Object.assign(new Error('callum-flow-event: unknown type'), { exitCode: 2 })
    const { result, calls } = await exec(A.releaseParent(), [], { event: async () => Promise.reject(usage) })
    expect(calls).toHaveLength(0)
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 2, detail: 'callum-flow-event: unknown type' },
      summary: 'event abandoned: callum-flow-event: unknown type',
      noRetry: true,
    })
    const other = await exec(A.releaseParent(), [], { event: async () => Promise.reject(new Error('cannot start')) })
    expect(other.result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT } })
    expect('noRetry' in other.result).toBe(false)
  })
})

describe('the milestone', () => {
  test('milestone-later: what moved, or the no-op note of a repo not opted in', async () => {
    const moved = await exec(A.later(), [{ stdout: '#470 moved from (no milestone) to "Later"\n' }])
    expect(moved.result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: '#470 moved from (no milestone) to "Later"' })
    const noop = await exec(A.later(), [{ stderr: 'callum-flow-milestone: no open "Next release" milestone in cbundy/dev-system - nothing to do\n' }])
    expect(noop.result).toMatchObject({ status: 'done', summary: 'callum-flow-milestone: no open "Next release" milestone in cbundy/dev-system - nothing to do' })
  })

  test('milestone-later: exit 1 with no Later milestone is failed', async () => {
    const stderr = 'callum-flow-milestone: no open "Later" milestone in cbundy/dev-system - create it first (this helper never creates milestones)'
    expect((await exec(A.later(), [{ exitCode: 1, stderr }])).result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1, detail: stderr } })
  })
})

describe('restart-self', () => {
  test('from rule H4 it runs dev-restart-self and records the request', async () => {
    const { result, calls } = await exec(A.restart(), [{ stderr: 'dev-restart-self: start build requested.\n' }])
    expect(calls.map(c => c.argv)).toEqual([['dev-restart-self']])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'restart requested' })
  })

  test('with a wind-down it writes the request, then restarts; a failed write never restarts', async () => {
    const R2 = { ...A.restart('R2'), windDownAt: NOW } as Action
    const ok = await exec(R2)
    expect(ok.calls.map(c => c.argv[0] === 'sh' ? c.argv[3] : c.argv)).toEqual(['wind-down-request', ['dev-restart-self']])
    expect(ok.calls[0]?.init.stdin).toBe(`{"requested_at":"${new Date(NOW).toISOString()}","trigger":"restart-self"}\n`)
    expect(ok.result).toMatchObject({ status: 'done' })
    const bad = await exec(R2, [{ exitCode: 1, stderr: 'mv: no space' }])
    expect(bad.calls).toHaveLength(1)
    expect(bad.result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
  })

  test('a failed dev-restart-self takes the request back off', async () => {
    const R2 = { ...A.restart('R2'), windDownAt: NOW } as Action
    const { result, calls } = await exec(R2, [{}, { exitCode: 1, stderr: 'refusing' }])
    expect(result).toMatchObject({ status: 'failed' })
    expect(calls.map(c => c.argv.slice(0, 3))).toEqual([['sh', '-c', WIND_DOWN_WRITE_SCRIPT], ['dev-restart-self'], ['rm', '-f', '--']])
    expect(calls[2]?.argv[3]).toBe(`${LOOP}/wind-down.request`)
    // with no request written, nothing is removed
    expect((await exec(A.restart('R2'), [{ exitCode: 1 }])).calls.map(c => c.argv)).toEqual([['dev-restart-self']])
  })

  test('from any other rule it is refused and never run', async () => {
    const { result, calls } = await exec(A.restart('A1'))
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ status: 'failed', summary: 'refused: restart-self comes only from rule H4 or R2, not A1', noRetry: true })
  })

  test('a refused build (exit 1) is failed; a usage error never retried', async () => {
    const stderr = 'dev-restart-self: refusing: the latest build is stop/running, not start/running. Nothing was changed.'
    expect((await exec(A.restart(), [{ exitCode: 1, stderr }])).result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1, detail: stderr } })
    expect((await exec(A.restart(), [{ exitCode: 2 }])).result).toMatchObject({ status: 'failed', noRetry: true })
  })
})

describe('a command that never exits', () => {
  test('a timeout or a command that cannot start is failed with no exit code', async () => {
    const { result } = await exec(A.sweep(), [new Error('callum-flow-sweep: timed out after 300000 ms')])
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: NO_EXIT, detail: 'callum-flow-sweep: timed out after 300000 ms' },
      summary: 'callum-flow-sweep: callum-flow-sweep: timed out after 300000 ms',
    })
  })
})

describe('stop-agent: only the loop\'s own running agents', () => {
  const running = (agentId: string) => entry('design:470:1', 'spawn', { agent: 'designer', agentId, status: 'running', endedAt: null })

  test('a running entry with that agent id: stopped', async () => {
    const { result, stops } = await exec(A.stop('a1'), [], { ledger: [running('a1')] })
    expect(stops).toEqual(['a1'])
    expect(result).toEqual({ status: 'done', summary: 'stopped a1 (timed out)' })
  })

  test('no such running entry (another agent, or one already ended): refused, TaskStop never called', async () => {
    const ended = { ...running('a1'), status: 'done' as const, endedAt: NOW }
    for (const ledger of [[running('a2')], [ended], []]) {
      const { result, stops } = await exec(A.stop('a1'), [], { ledger })
      expect(stops).toHaveLength(0)
      expect(result).toEqual({ status: 'failed', summary: 'refused: agent a1 is not a running agent of the loop', noRetry: true })
    }
  })

  test('ownAgent reads the running entries only: an ended entry, or an agent the ledger does not hold, is not the loop\'s to stop', () => {
    expect(ownAgent([running('a1')], 'a1')).toBe(true)
    expect(ownAgent([running('a1')], 'a2')).toBe(false)
    expect(ownAgent([{ ...running('a1'), status: 'timed-out' }], 'a1')).toBe(false)
    expect(ownAgent([{ ...running('a1'), status: 'done', endedAt: NOW }], 'a1')).toBe(false)
  })

  test('a stop that is not supported, or throws, is failed with the reason (v2 SPEC 13.13)', async () => {
    const unsupported = await exec(A.stop('a1'), [], { ledger: [running('a1')], stop: async () => ({ stopped: false, error: 'TaskStop is not available to mods' }) })
    expect(unsupported.result).toEqual({ status: 'failed', summary: 'not stopped a1: TaskStop is not available to mods' })
    const threw = await exec(A.stop('a1'), [], { ledger: [running('a1')], stop: async () => Promise.reject(new Error('tool call failed')) })
    expect(threw.result).toEqual({ status: 'failed', summary: 'not stopped a1: tool call failed' })
  })

})

describe('title', () => {
  test('renames the session with the text', async () => {
    const { result, titles, calls } = await exec(A.title())
    expect(calls).toHaveLength(0)
    expect(titles).toEqual(['🔄 dev-system (Q:1 - D:2 - M:0)'])
    expect(result).toEqual({ status: 'running', summary: 'renaming off the pass: 🔄 dev-system (Q:1 - D:2 - M:0)' })
  })

  test('a rename that throws at once is failed (the next pass sets it again)', async () => {
    const { result } = await exec(A.title(), [], { rename: async () => Promise.reject(new Error('command not found: rename')) })
    expect(result).toEqual({ status: 'failed', summary: 'rename failed: command not found: rename' })
  })
})

describe('guards and pure readers', () => {
  test('an executor given another kind refuses it', async () => {
    const h = harness()
    const result: Exec = await executor('claim')(h.ctx, A.sweep())
    expect(h.calls).toHaveLength(0)
    expect(result).toEqual({ status: 'failed', summary: 'refused: the claim executor got a sweep action', noRetry: true })
  })

  test('cliExecutors covers exactly the kinds that spend no tokens and need no parser of their own', () => {
    expect(Object.keys(cliExecutors).sort()).toEqual(
      [
        'claim',
        'close-issue',
        'delete-branch',
        'heartbeat',
        'milestone-later',
        'release-parent',
        'restart-self',
        'stop-agent',
        'sweep',
        'title',
      ].sort(),
    )
  })

  test('usageError: exit 2 for the image\'s CLIs only', () => {
    expect(usageError(['callum-flow-claim', '1'], 2)).toBe(true)
    expect(usageError(['dev-restart-self'], 2)).toBe(true)
    expect(usageError(['gh', 'pr', 'close', '1'], 2)).toBe(false)
    expect(usageError(['treehouse', 'return', '/x'], 2)).toBe(false)
    expect(usageError(['callum-flow-claim', '1'], 1)).toBe(false)
  })

  test('commandFailure keeps the first 2 000 characters of stderr, else stdout', () => {
    const long = 'x'.repeat(2500)
    const r = commandFailure(['callum-flow-sweep'], { exitCode: 1, stdout: 'out', stderr: long })
    expect(r.status === 'failed' && r.outcome?.kind === 'cli' ? r.outcome.detail?.length : null).toBe(2000)
    expect(r.summary.length).toBeLessThanOrEqual(200)
    expect(commandFailure(['callum-flow-sweep'], { exitCode: 1, stdout: 'only stdout', stderr: '' })).toMatchObject({ outcome: { detail: 'only stdout' } })
  })

  test('eventFailure reads an exit code off the error when it has one', () => {
    expect(eventFailure('abandoned', Object.assign(new Error('bad'), { exitCode: 2 }))).toMatchObject({ noRetry: true, outcome: { exit: 2 } })
    expect(eventFailure('abandoned', 'plain text')).toMatchObject({ status: 'failed', outcome: { exit: NO_EXIT, detail: 'plain text' } })
  })

  test('finish: a claim with no lost exit is claimed; a kind that runs no command is refused', () => {
    expect(finish(A.claim(), [{ exitCode: 0, stdout: '', stderr: '' }])).toMatchObject({ outcome: { kind: 'claim', result: 'claimed' } })
    expect(finish(A.title(), [])).toMatchObject({ status: 'failed', noRetry: true })
  })
})
