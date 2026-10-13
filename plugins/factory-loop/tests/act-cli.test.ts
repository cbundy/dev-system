// The executors that spend no tokens (act-cli.ts) against a fake ExecCtx: each kind's argv,
// cwd, timeout and stdin, and its outcome for success, each documented failure and a GitHub
// rate limit. Exit codes and output lines are the real CLIs' (images/base/callum-flow-claim,
// callum-flow-sweep, callum-flow-milestone, callum-flow-event, dev-restart-self; gh 2.102;
// treehouse status --json as it printed on 2026-10-13).
import { describe, expect, test } from 'claude-code/testing'

import { CLI_TIMEOUT_MS, NO_EXIT, cliExecutors, commandFailure, eventFailure, finish, ownAgent, slotState, stepsOf, usageError } from '../hooks/act-cli'
import type { ActIo, EventFields, Exec, ExecCtx, Executor, RunInit, RunResult } from '../hooks/exec'
import type { Runtime } from '../hooks/observe'
import type { Action, ActionKind, LedgerEntry } from '../hooks/types'
import { DEVICE, NOW, config, entry, state } from './fixtures'

const REPO = 'cbundy/dev-system'
const IN_DEV = 'in development'
const SLOT = '/workspaces/dev-system/.treehouse/dev-system-22f535/2/dev-system'
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
    loopDir: '/cfg/factory-loop/cbundy__dev-system',
    sink: null,
    config: config(),
    configProblems: [],
  }
}

type Over = {
  ledger?: LedgerEntry[]
  stop?: (agentId: string) => Promise<{ stopped: boolean; error?: string }>
  rename?: (title: string) => Promise<void>
  event?: (state: string, fields: EventFields) => Promise<void>
}

// harness: a fake ExecCtx whose commands answer from `replies` in order (a missing reply is a
// quiet exit 0), recording every command, event, stop and rename.
function harness(replies: Reply[] = [], over: Over = {}) {
  const calls: Call[] = []
  const events: { state: string; fields: EventFields }[] = []
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
    state: state(over.ledger === undefined ? {} : { ledger: over.ledger }),
    entry: entry('under-test', 'heartbeat', { status: 'running', endedAt: null }),
    cmd: async (argv, init) => {
      calls.push({ argv, init })
      const reply = replies[next++] ?? {}
      if (reply instanceof Error) throw reply
      return { exitCode: 0, stdout: '', stderr: '', ...reply }
    },
    event: async (s, fields) => {
      events.push({ state: s, fields })
      if (over.event !== undefined) await over.event(s, fields)
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
  releaseParent: (): Action => ({ ...base, kind: 'release-parent', key: 'release-parent:470', rule: 'D3', issue: 470, created: [471, 472] }),
  abandon: (run: string | null = '01RUN', branch: string | null = 'feat/issue-470-x'): Action => ({
    ...base,
    kind: 'abandon',
    key: 'abandon:470:1',
    rule: 'D6',
    issue: 470,
    run,
    branch,
    note: 'dropped by the owner',
  }),
  later: (): Action => ({ ...base, kind: 'milestone-later', key: 'milestone-later:470', rule: 'M7', issue: 470 }),
  expect: (why = 'a new CLI flag'): Action => ({ ...base, kind: 'milestone-expect', key: 'expect:minor:512', rule: 'M7', issue: 470, bump: 'minor', why }),
  reopen: (): Action => ({ ...base, kind: 'pr-reopen', key: 'reopen:512:01RUN', rule: 'P6a', issue: 470, pr: 512 }),
  comment: (): Action => ({ ...base, kind: 'pr-comment', key: 'pr-comment:512:h1', rule: 'M3', issue: 470, pr: 512, body: 'Accepted:\n\nCORRECT: x' }),
  release: (): Action => ({ ...base, kind: 'release-worktree', key: `release:${SLOT}:feat/issue-470-x`, rule: 'H3', issue: 470, path: SLOT, branch: 'feat/issue-470-x' }),
  restart: (rule = 'H4'): Action => ({ ...base, kind: 'restart-self', key: 'restart:1', rule, issue: null, why: 'image 1.2.3', at: 1 }),
  stop: (agentId = 'a1'): Action => ({ ...base, kind: 'stop-agent', key: `stop:${agentId}`, rule: 'A1', reason: 'timed out', issue: 470, agentId, entry: 'design:470:1' }),
  title: (text = '🔄 dev-system (Q:1 - D:2 - M:0)'): Action => ({ ...base, kind: 'title', key: 'title', rule: 'O1', issue: null, text }),
}

const STATUS_RETURNED = JSON.stringify([
  { name: '1', path: '/workspaces/dev-system/.treehouse/dev-system-22f535/1/dev-system', status: 'leased', branch: 'feat/factory-loop', processes: [] },
  { name: '2', path: SLOT, status: 'available', branch: '', detached: true, processes: [] },
])
const STATUS_HELD = STATUS_RETURNED.replace('"available"', '"in-use"')

describe('stepsOf: the argv templates (SPEC 6.1)', () => {
  const argv = (a: Action) => {
    const steps = stepsOf(a, REPO, IN_DEV)
    if (typeof steps === 'string') throw new Error(steps)
    return steps.map(s => ('argv' in s ? s.argv : [`event:${s.event}`]))
  }

  test('each kind runs exactly its catalogue row, gh always with --repo', () => {
    expect(argv(A.heartbeat())).toEqual([['callum-flow-claim', '--heartbeat']])
    expect(argv(A.sweep())).toEqual([['callum-flow-sweep']])
    expect(argv(A.claim())).toEqual([['callum-flow-claim', '470']])
    expect(argv(A.close())).toEqual([['gh', 'issue', 'close', '470', '--repo', REPO, '--reason', 'completed']])
    expect(argv(A.releaseParent())).toEqual([['gh', 'issue', 'edit', '470', '--repo', REPO, '--remove-label', IN_DEV], ['event:abandoned']])
    expect(argv(A.abandon())).toEqual([['gh', 'issue', 'edit', '470', '--repo', REPO, '--remove-label', IN_DEV], ['event:abandoned']])
    expect(argv(A.later())).toEqual([['callum-flow-milestone', 'plan', '470', 'later']])
    expect(argv(A.expect())).toEqual([['callum-flow-milestone', 'expect', 'minor', 'a new CLI flag']])
    expect(argv(A.reopen())).toEqual([
      ['gh', 'pr', 'close', '512', '--repo', REPO],
      ['gh', 'pr', 'reopen', '512', '--repo', REPO],
    ])
    expect(argv(A.comment())).toEqual([['gh', 'pr', 'comment', '512', '--repo', REPO, '--body-file', '-']])
    expect(argv(A.release())).toEqual([['treehouse', 'return', SLOT], ['treehouse', 'status', '--json']])
    expect(argv(A.restart())).toEqual([['dev-restart-self']])
  })

  test('a multi-line bump reason becomes the one line the milestone CLI takes', () => {
    expect(argv(A.expect('adds a flag\n  and a mode\t'))).toEqual([['callum-flow-milestone', 'expect', 'minor', 'adds a flag and a mode']])
  })

  test('refusals: an issue kind with no issue, restart-self outside H4, a kind that runs no command', () => {
    expect(stepsOf(A.claim(null), REPO, IN_DEV)).toBe('claim names no issue')
    expect(stepsOf(A.restart('O1'), REPO, IN_DEV)).toBe('restart-self comes only from rule H4, not O1')
    expect(stepsOf(A.title(), REPO, IN_DEV)).toBe('title runs no command')
  })

  test('no template can pass a forbidden flag or command (SPEC 6.1)', () => {
    const all = [A.heartbeat(), A.sweep(), A.claim(), A.close(), A.releaseParent(), A.abandon(), A.later(), A.expect(), A.reopen(), A.comment(), A.release(), A.restart()]
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
      [A.expect(), 60_000, undefined],
      [A.comment(), 60_000, 'Accepted:\n\nCORRECT: x'],
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

  test('treehouse return gets an empty stdin, so a discard prompt can only decline', async () => {
    const { calls } = await exec(A.release(), [{}, { stdout: STATUS_RETURNED }])
    expect(calls.map(c => c.init)).toEqual([{ timeoutMs: 120_000, stdin: '' }, { timeoutMs: 120_000 }])
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

describe('gh writes: close-issue, pr-comment, pr-reopen', () => {
  test('close-issue: done on exit 0; gh exit 1 failed; gh exit 2 (cancelled) is retried, not a usage error', async () => {
    expect((await exec(A.close())).result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'closed #470' })
    const failed = (await exec(A.close(), [{ exitCode: 1, stderr: 'GraphQL: Could not resolve to an issue with the number of 470. (repository.issue)' }])).result
    expect(failed).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
    const cancelled = (await exec(A.close(), [{ exitCode: 2 }])).result
    expect(cancelled).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 2 } })
    expect('noRetry' in cancelled).toBe(false)
    expect((await exec(A.close(), [{ exitCode: 1, stderr: 'GraphQL: API rate limit exceeded for user ID 1234.' }])).result).toMatchObject({ rateLimited: true })
  })

  test('pr-comment: the body goes on stdin, the comment URL into the summary', async () => {
    const url = 'https://github.com/cbundy/dev-system/pull/512#issuecomment-99'
    const { result, calls } = await exec(A.comment(), [{ stdout: `${url}\n` }])
    expect(calls[0]?.init.stdin).toBe('Accepted:\n\nCORRECT: x')
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: `commented on PR #512: ${url}` })
    expect((await exec(A.comment(), [{ exitCode: 1, stderr: RATE }])).result).toMatchObject({ status: 'failed', rateLimited: true })
  })

  test('pr-reopen: close then reopen; a failed close never reopens, a failed reopen names its step', async () => {
    const ok = await exec(A.reopen())
    expect(ok.calls.map(c => c.argv[2])).toEqual(['close', 'reopen'])
    expect(ok.calls.map(c => c.init)).toEqual([{ timeoutMs: 60_000 }, { timeoutMs: 60_000 }])
    expect(ok.result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'PR #512 closed and reopened' })

    const closeFailed = await exec(A.reopen(), [{ exitCode: 1, stderr: "Pull request #512 can't be closed because it was already merged" }])
    expect(closeFailed.calls).toHaveLength(1)
    expect(closeFailed.result).toMatchObject({ status: 'failed', summary: "gh pr close: exit 1: Pull request #512 can't be closed because it was already merged" })

    const reopenFailed = await exec(A.reopen(), [{}, { exitCode: 1, stderr: RATE }])
    expect(reopenFailed.calls).toHaveLength(2)
    expect(reopenFailed.result).toMatchObject({ status: 'failed', rateLimited: true, outcome: { kind: 'cli', exit: 1 } })
    expect(reopenFailed.result.summary).toStartWith('gh pr reopen: exit 1')
  })
})

describe('release-parent and abandon: the label, then the event, stopping at the first failure', () => {
  test('release-parent: the claim label comes off, then `abandoned` notes the split', async () => {
    const { result, calls, events } = await exec(A.releaseParent())
    expect(calls.map(c => c.argv)).toEqual([['gh', 'issue', 'edit', '470', '--repo', REPO, '--remove-label', IN_DEV]])
    expect(calls[0]?.init).toEqual({ timeoutMs: 60_000 })
    expect(events).toEqual([{ state: 'abandoned', fields: { issue: 470, note: 'split into 471,472' } }])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'released #470, split into 471,472' })
  })

  test('abandon: the event carries the run and branch when known, and leaves out what is not', async () => {
    const known = await exec(A.abandon())
    expect(known.calls.map(c => c.init)).toEqual([{ timeoutMs: 60_000 }])
    expect(known.events).toEqual([
      { state: 'abandoned', fields: { issue: 470, run: '01RUN', branch: 'feat/issue-470-x', note: 'dropped by the owner' } },
    ])
    expect(known.result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'abandoned #470' })
    const unknown = await exec(A.abandon(null, null))
    expect(unknown.events[0]?.fields).toEqual({ issue: 470, note: 'dropped by the owner' })
    expect(Object.keys(unknown.events[0]?.fields ?? {}).sort()).toEqual(['issue', 'note'])
  })

  test('a failed label edit logs no event; a rate limit is flagged', async () => {
    const { result, events } = await exec(A.abandon(), [{ exitCode: 1, stderr: RATE }])
    expect(events).toHaveLength(0)
    expect(result).toMatchObject({ status: 'failed', rateLimited: true, outcome: { kind: 'cli', exit: 1 } })
  })

  test('a failed event is failed; its usage exit is never retried', async () => {
    const usage = Object.assign(new Error('callum-flow-event: unknown state'), { exitCode: 2 })
    const { result, calls } = await exec(A.releaseParent(), [], { event: async () => Promise.reject(usage) })
    expect(calls).toHaveLength(1)
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 2, detail: 'callum-flow-event: unknown state' },
      summary: 'event abandoned: callum-flow-event: unknown state',
      noRetry: true,
    })
    const other = await exec(A.abandon(), [], { event: async () => Promise.reject(new Error('cannot start')) })
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

  test('milestone-expect: the line it set; a usage error is never retried', async () => {
    const { result } = await exec(A.expect(), [{ stdout: 'Expected: minor - a new CLI flag\n' }])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'Expected: minor - a new CLI flag' })
    const usage = await exec(A.expect(), [{ exitCode: 2, stderr: 'callum-flow-milestone: the reason must not be empty' }])
    expect(usage.result).toMatchObject({ status: 'failed', noRetry: true })
  })
})

describe('release-worktree', () => {
  test('returned, and treehouse status shows the slot available', async () => {
    const { result, calls } = await exec(A.release(), [{}, { stdout: STATUS_RETURNED }])
    expect(calls.map(c => c.argv)).toEqual([['treehouse', 'return', SLOT], ['treehouse', 'status', '--json']])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: `returned ${SLOT}` })
  })

  test('exit 0 but the slot is still held, or not listed: failed', async () => {
    expect((await exec(A.release(), [{}, { stdout: STATUS_HELD }])).result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 0, detail: `${SLOT} is in-use after treehouse return` },
      summary: `${SLOT} is in-use after treehouse return`,
    })
    expect((await exec(A.release(), [{}, { stdout: '[]' }])).result).toMatchObject({ status: 'failed', outcome: { detail: `${SLOT} is not listed after treehouse return` } })
  })

  test('a failed return skips the status read; treehouse exit 2 is not a usage error', async () => {
    const { result, calls } = await exec(A.release(), [{ exitCode: 2, stderr: 'error: foreign process remains' }])
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 2 } })
    expect('noRetry' in result).toBe(false)
  })

  test('a failed status read is failed', async () => {
    expect((await exec(A.release(), [{}, { exitCode: 1, stderr: 'not a git repository' }])).result).toMatchObject({
      status: 'failed',
      summary: 'treehouse status: exit 1: not a git repository',
    })
  })
})

describe('restart-self', () => {
  test('from rule H4 it runs dev-restart-self and records the request', async () => {
    const { result, calls } = await exec(A.restart(), [{ stderr: 'dev-restart-self: start build requested.\n' }])
    expect(calls.map(c => c.argv)).toEqual([['dev-restart-self']])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: 'restart requested' })
  })

  test('from any other rule it is refused and never run', async () => {
    const { result, calls } = await exec(A.restart('A1'))
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ status: 'failed', summary: 'refused: restart-self comes only from rule H4, not A1', noRetry: true })
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

  test('a stop that is not supported, or throws, is failed with the reason (SPEC 13)', async () => {
    const unsupported = await exec(A.stop('a1'), [], { ledger: [running('a1')], stop: async () => ({ stopped: false, error: 'TaskStop is not available to mods' }) })
    expect(unsupported.result).toEqual({ status: 'failed', summary: 'not stopped a1: TaskStop is not available to mods' })
    const threw = await exec(A.stop('a1'), [], { ledger: [running('a1')], stop: async () => Promise.reject(new Error('tool call failed')) })
    expect(threw.result).toEqual({ status: 'failed', summary: 'not stopped a1: tool call failed' })
  })

  test('ownAgent reads running entries only', () => {
    expect(ownAgent([running('a1')], 'a1')).toBe(true)
    expect(ownAgent([running('a1')], 'a2')).toBe(false)
    expect(ownAgent([{ ...running('a1'), status: 'timed-out' }], 'a1')).toBe(false)
  })
})

describe('title', () => {
  test('renames the session with the text', async () => {
    const { result, titles, calls } = await exec(A.title())
    expect(calls).toHaveLength(0)
    expect(titles).toEqual(['🔄 dev-system (Q:1 - D:2 - M:0)'])
    expect(result).toEqual({ status: 'done', summary: '🔄 dev-system (Q:1 - D:2 - M:0)' })
  })

  test('a failed rename is failed (the next pass sets it again)', async () => {
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
        'abandon',
        'claim',
        'close-issue',
        'heartbeat',
        'milestone-expect',
        'milestone-later',
        'pr-comment',
        'pr-reopen',
        'release-parent',
        'release-worktree',
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

  test('slotState reads treehouse status --json', () => {
    expect(slotState(STATUS_RETURNED, SLOT)).toBe('available')
    expect(slotState(STATUS_HELD, SLOT)).toBe('in-use')
    expect(slotState('[]', SLOT)).toBeNull()
    expect(slotState('not json', SLOT)).toBeNull()
  })

  test('finish: a claim with no lost exit is claimed; a kind that runs no command is refused', () => {
    expect(finish(A.claim(), [{ exitCode: 0, stdout: '', stderr: '' }])).toMatchObject({ outcome: { kind: 'claim', result: 'claimed' } })
    expect(finish(A.title(), [])).toMatchObject({ status: 'failed', noRetry: true })
  })
})
