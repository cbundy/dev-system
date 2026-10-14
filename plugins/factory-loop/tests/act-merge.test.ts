// The gate and merge executors (act-merge.ts) against a fake ExecCtx: each kind's argv,
// timeout, cwd and stdin, every parser against the real CLIs' lines, and each outcome plan reads
// next. The lines are the CLIs' own (images/base/callum-flow-merge-guard, callum-flow-merge,
// callum-flow-rollout, callum-flow-fix-linkage and their tests under features/test/callum-tools/;
// no-mistakes axi respond --help and its "no active run to respond to"; treehouse get --help).
import { describe, expect, test } from 'claude-code/testing'

import {
  ENV_RETRY_ARGV,
  FF_SCRIPT,
  LAUNCH_SCRIPT,
  LEASE_ARGV,
  MERGE_TIMEOUT_MS,
  NO_EXIT,
  RESPOND_SETTLE_S,
  argvsOf,
  failure,
  fastForwardArgv,
  guardKeyAfter,
  launchArgv,
  leasedPath,
  mergeExecutors,
  mergeRefusal,
  parseCloseIssue,
  parseFastForward,
  parseFixLinkage,
  parseGuard,
  parseRollout,
  parseUpdateBehind,
  respondArgv,
  respondProblem,
  slotFor,
  validBranch,
} from '../hooks/act-merge'
import type { FastForwardAction } from '../hooks/act-merge'
import { respondLogPath } from '../hooks/exec'
import type { ActIo, EventFields, Exec, ExecCtx, Executor, RunInit, RunResult } from '../hooks/exec'
import type { Runtime } from '../hooks/observe'
import { plan } from '../hooks/plan'
import type { Action, ActionKind, LedgerEntry, Pool, Slot } from '../hooks/types'
import { DEVICE, NOW, config, entry, mine, review, run, state, withLedger } from './fixtures'

const REPO = 'cbundy/dev-system'
const LOOP_DIR = '/cfg/factory-loop/cbundy__dev-system'
const RUN = '01M4RQ0050AAAA'
const BRANCH = 'feat/issue-50-work'
const SLOT = '/workspaces/dev-system/.treehouse/dev-system-22f535/3/dev-system'
const OTHER_SLOT = '/workspaces/dev-system/.treehouse/dev-system-22f535/4/dev-system'
const LEASED = '/workspaces/dev-system/.treehouse/dev-system-22f535/7/dev-system'
const GATED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const NEWH = 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432'
const RATE = 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)'

// The guard's recovery texts, verbatim (images/base/callum-flow-merge-guard).
const REBASE_FIX =
  "in a fresh slot on the branch run 'git rebase origin/<base>' keeping the pipeline's commits, then 'callum-flow-regate --issue <N>', 'no-mistakes axi abort', a fresh backgrounded 'axi run --intent ...', and prove the new run's head equals the rebased HEAD (the no-mistakes CI monitor does not rebase a PR that is only behind)"
const BEHIND_FIX = `run 'callum-flow-merge-guard <pr> --update-behind' first (a clean rebase with an unchanged patch needs no new run); only if it fails, re-gate: ${REBASE_FIX}`

// Real guard lines (merge-guard.test.sh, merge.test.sh).
const G = {
  behind: `GUARD mergeable FAIL behind main, ${BEHIND_FIX}`,
  conflict: `GUARD mergeable FAIL conflicts with main, rebase and re-gate: ${REBASE_FIX}`,
  merged: 'GUARD mergeable FAIL PR is MERGED',
  pending: 'GUARD checks FAIL ci=pending',
  noChecks: 'GUARD checks FAIL no checks reported',
  gates: 'GUARD gates FAIL run RUN1 has a step awaiting approval: ci,awaiting_approval,0',
  linkage: 'GUARD linkage FAIL MISMATCH #7 issue=#12 expect=closing via=api actual=[] body=[]',
  author: 'GUARD author FAIL PR #550 was not opened by a trusted author',
  headPass: `GUARD head PASS gated_patch=9f8e7d6c5b4a39281706f5e4d3c2b1a098765432 rebased_from=${GATED}`,
  warn: 'GUARD test-weakening WARN a1b2c3d step=ci files=tests/a.test.js,tests/b.test.sh kinds=removed-assertion,warn-only - have the adjudicator judge it against the brief; restore via fixer unless the removal is justified',
  detector: 'GUARD test-weakening WARN detector error: fatal: bad object',
  verified: `VERIFIED pr=550 branch=${BRANCH} head=${GATED} run=${RUN} issue=50 close_issue= gated_patch= rebased_from=`,
  weakened: `WEAKENED commit=${GATED} step=ci restored=no files=tests/a.test.js,tests/b.test.sh kinds=removed-assertion,warn-only`,
}

// Real update-behind lines (merge-guard.test.sh, the update-behind section).
const UB = {
  updated: `UPDATED pr=550 branch=${BRANCH} from=${GATED} to=${NEWH} run=${RUN} gated_patch=9f8e7d6c5b4a39281706f5e4d3c2b1a098765432 rebased_from=${GATED}`,
  patch: `UPDATE-BEHIND FAIL patch changed by the rebase; fall back to a full re-gate: ${REBASE_FIX}`,
  dirty: `UPDATE-BEHIND FAIL PR conflicts with main; fall back to a full re-gate: ${REBASE_FIX}`,
  clean: 'UPDATE-BEHIND SKIP PR is not behind its base (state=OPEN mergeStateStatus=CLEAN mergeable=MERGEABLE), nothing to rebase; re-run the guard',
  unknown: 'UPDATE-BEHIND SKIP GitHub has not computed mergeability, retry',
}

// Real callum-flow-fix-linkage lines (fix-linkage.test.sh, check-pr-linkage.sh's report).
const FL = {
  match: 'MATCH #550 issue=#50 expect=closing via=api actual=[50] body=[50]',
  skip: 'SKIP #550 epic/big',
  repaired: 'REPAIRED #550 issue=#50 expect=closing via=api actual=[50] body=[50]',
  still: 'MISMATCH #550 issue=#50 expect=closing via=api actual=[] body=[50] after-fix',
  untrusted: 'callum-flow-fix-linkage: PR #550 was not opened by a trusted author; nothing edited',
}

// Real callum-flow-merge lines (merge.test.sh).
const M = {
  close: 'Close issue #12 by hand with a comment naming merged PR #550; GitHub registers no closing references on a non-default base.',
  moved: 'callum-flow-merge: head moved since the check (verified a1b2c3d, now bbbbbbb) - re-gate',
  behind: "callum-flow-merge: GitHub refused: merge state BEHIND (branch rule) - see the guard's mergeable action",
  other: 'callum-flow-merge: GitHub refused the merge (merge state CLEAN), head unchanged - see the error above, retry or check the PR',
}

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
    config: config(),
    configProblems: [],
  }
}

function slot(path: string, branch: string | null, status = 'leased'): Slot {
  return { path, branch, state: status, dirty: null, busy: false }
}

type Over = { ledger?: LedgerEntry[]; pool?: Pool | null; attempts?: number; event?: (state: string, fields: EventFields) => Promise<void> }

// harness: a fake ExecCtx whose commands answer from `replies` in order (a missing reply is a
// quiet exit 0), recording every command and event.
function harness(replies: Reply[] = [], over: Over = {}) {
  const calls: Call[] = []
  const events: { state: string; fields: EventFields }[] = []
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
    state: { ...s, ledger: over.ledger ?? s.ledger, pool: over.pool === undefined ? s.pool : over.pool },
    entry: entry('under-test', 'respond', { status: 'running', endedAt: null, attempts: over.attempts ?? 1 }),
    cmd: async (argv, init) => {
      calls.push({ argv, init })
      const reply = replies[next++] ?? {}
      if (reply instanceof Error) throw reply
      return { exitCode: 0, stdout: '', stderr: '', ...reply }
    },
    event: async (st, fields) => {
      events.push({ state: st, fields })
      if (over.event !== undefined) await over.event(st, fields)
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
  guard: (): Action => ({ ...base, kind: 'guard', key: `guard:550:${GATED}:1`, rule: 'M1', pr: 550, run: RUN, head: GATED }),
  behind: (): Action => ({ ...base, kind: 'update-behind', key: `update-behind:550:${GATED}`, rule: 'M2', pr: 550, run: RUN, head: GATED }),
  linkage: (): Action => ({ ...base, kind: 'fix-linkage', key: `fix-linkage:550:${GATED}`, rule: 'M2', pr: 550 }),
  merge: (issue: number | null = 50): Action => ({
    ...base,
    issue,
    kind: 'merge',
    key: `merge:550:${GATED}`,
    rule: 'M5',
    pr: 550,
    run: RUN,
    head: GATED,
    bump: 'minor',
    bumpReason: 'a new mode',
  }),
  rollout: (issue: number | null = 50): Action => ({ ...base, issue, kind: 'rollout', key: `rollout:${issue}`, rule: 'M7', pr: 550 }),
  respond: (over: Partial<Extract<Action, { kind: 'respond' }>> = {}): Extract<Action, { kind: 'respond' }> => ({
    ...base,
    class: 'drive',
    kind: 'respond',
    key: `respond:${RUN}:review:${GATED}:fix`,
    rule: 'P3',
    run: RUN,
    branch: BRANCH,
    step: 'review',
    head: GATED,
    action: 'fix',
    findings: 'review-1,review-3',
    instructions: null,
    addFinding: null,
    approveReason: null,
    logReview: true,
    ...over,
  }),
}

const LOG = respondLogPath(LOOP_DIR, 'under-test', 1)

describe('argv (SPEC 6.1)', () => {
  test('each kind runs exactly its catalogue row', () => {
    expect(argvsOf(A.guard(), LOOP_DIR)).toEqual([['callum-flow-merge-guard', '550', '--run', RUN]])
    expect(argvsOf(A.behind(), LOOP_DIR)).toEqual([['callum-flow-merge-guard', '550', '--update-behind', '--run', RUN]])
    expect(argvsOf(A.linkage(), LOOP_DIR)).toEqual([['callum-flow-fix-linkage', '550']])
    expect(argvsOf(A.merge(), LOOP_DIR)).toEqual([
      ['callum-flow-merge', '550', '--run', RUN],
      ['callum-flow-rollout', '50'],
    ])
    expect(argvsOf(A.rollout(), LOOP_DIR)).toEqual([['callum-flow-rollout', '50']])
    expect(argvsOf({ kind: 'heartbeat', key: 'heartbeat:0', class: 'free', rule: 'H1', reason: 'x', issue: null }, LOOP_DIR)).toBeNull()
  })

  test('respond: the action and only the flags its adjudicator gave, each value one argv entry', () => {
    const json = '{"id":"f9","severity":"warning","file":"bin/x.sh","description":"it\'s a \\"quoted\\" value  with spaces"}'
    expect(respondArgv(A.respond())).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'fix', '--step=review', '--findings=review-1,review-3'])
    expect(respondArgv(A.respond({ findings: null, instructions: 'Keep both sides; do not touch tests/' }))).toEqual([
      'no-mistakes',
      'axi',
      'respond',
      '--action',
      'fix',
      '--step=review',
      '--instructions=Keep both sides; do not touch tests/',
    ])
    expect(respondArgv(A.respond({ findings: 'f1', instructions: 'fix it', addFinding: json }))).toEqual([
      'no-mistakes',
      'axi',
      'respond',
      '--action',
      'fix',
      '--step=review',
      '--findings=f1',
      '--instructions=fix it',
      `--add-finding=${json}`,
    ])
    // no-mistakes takes --reason only on the test step (the testbed's #11 hit exit 2 on review)
    expect(respondArgv(A.respond({ action: 'approve', step: 'test', findings: null, approveReason: 'the brief allows removing the old flag', logReview: false }))).toEqual([
      'no-mistakes',
      'axi',
      'respond',
      '--action',
      'approve',
      '--step=test',
      '--reason=the brief allows removing the old flag',
    ])
    expect(respondArgv(A.respond({ action: 'approve', findings: null, approveReason: 'the reviewer was wrong', logReview: false }))).toEqual([
      'no-mistakes',
      'axi',
      'respond',
      '--action',
      'approve',
      '--step=review',
    ])
    expect(respondArgv(A.respond({ action: 'approve', step: null, findings: null, approveReason: 'x', logReview: false }))).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'approve'])
    expect(respondArgv(A.respond({ action: 'approve', findings: null }))).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'approve', '--step=review'])
    expect(respondArgv(A.respond({ action: 'skip', findings: null }))).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'skip', '--step=review'])
    // a fix flag never rides on another action, and an empty value is left out
    expect(respondArgv(A.respond({ action: 'skip', findings: 'f1', approveReason: 'x' }))).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'skip', '--step=review'])
    expect(respondArgv(A.respond({ findings: '  ', instructions: '' }))).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'fix', '--step=review'])
    // a gate with no step name (a park seen only in the event log): respond takes the step awaiting approval
    expect(respondArgv(A.respond({ step: null }))).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'fix', '--findings=review-1,review-3'])
  })

  test('the respond plan builds for a gate with no step name launches without --step (a park from the event log, a failed run)', async () => {
    const parkedAt = NOW - 10 * 60_000
    const runs = [
      run(45, 'parked', { step: null, since: parkedAt }),
      run(45, 'failed', { step: null }),
    ]
    for (const r of runs) {
      const gate = r.state === 'parked' ? `park@${parkedAt}` : 'null'
      const adjudicated = entry(`adjudicate:${r.run}:${gate}:${r.head}`, 'spawn', {
        agent: 'adjudicator',
        class: 'drive',
        issue: 45,
        outcome: review({ type: 'approve', reason: 'a false positive' }),
      })
      const s = withLedger(state({ issues: [mine(45, r.state === 'parked' ? 'parked' : 'in pipeline', { pr: 545 })], runs: [r] }), [adjudicated])
      const action = plan(s, config()).actions.find(a => a.kind === 'respond')
      expect(action).toMatchObject({ kind: 'respond', step: null, key: `respond:${r.run}:${gate}:${r.head}:approve` })
      if (action?.kind !== 'respond') throw new Error('plan built no respond')
      const pool: Pool = { free: 3, total: 16, slots: [slot(SLOT, action.branch, 'in-use')] }
      const { result, calls } = await exec(action, [{ stdout: 'run: R\n' }], { pool })
      expect(result).toMatchObject({ status: 'done', summary: `respond --action approve on its gate launched in ${SLOT}` })
      // with no step name nothing says it is the test step, the only one that takes --reason
      expect(calls[0]?.argv.slice(7)).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'approve'])
    }
  })

  test('a value that looks like a flag stays inside its own entry', () => {
    const argv = respondArgv(A.respond({ findings: null, instructions: '--yes' }))
    expect(argv).toEqual(['no-mistakes', 'axi', 'respond', '--action', 'fix', '--step=review', '--instructions=--yes'])
    expect(argv).not.toContain('--yes')
  })

  test('the launch: sh -c with the slot, the branch, the log and the respond argv as positional arguments', () => {
    const respond = respondArgv(A.respond())
    expect(launchArgv(SLOT, BRANCH, LOG, respond)).toEqual(['sh', '-c', LAUNCH_SCRIPT, 'factory-loop-respond', SLOT, BRANCH, LOG, ...respond])
    expect(LAUNCH_SCRIPT).toContain('nohup')
    expect(LAUNCH_SCRIPT).toContain('< /dev/null &')
    expect(LAUNCH_SCRIPT).toContain(`sleep "\${FACTORY_LOOP_RESPOND_SETTLE_S:-${RESPOND_SETTLE_S}}"`)
    // the settle stays well inside the launch timeout
    expect(RESPOND_SETTLE_S * 1000).toBeLessThan(MERGE_TIMEOUT_MS.respond / 2)
    expect(LEASE_ARGV).toEqual(['treehouse', 'get', '--lease', '--lease-holder', 'factory-loop'])
  })

  test('no template can pass a forbidden flag or command (SPEC 6.1)', () => {
    const all: Action[] = [
      A.guard(),
      A.behind(),
      A.linkage(),
      A.merge(),
      A.rollout(),
      A.respond(),
      A.respond({ action: 'approve', findings: null, approveReason: 'ok' }),
      A.respond({ action: 'skip', findings: null }),
    ]
    for (const a of all) {
      for (const words of argvsOf(a, LOOP_DIR) ?? []) {
        expect(words).not.toContain('--yes')
        expect(words).not.toContain('-y')
        // respond targets the run of the slot's branch, never one named by --run (I-94)
        if (a.kind === 'respond') expect(words.some(w => w === '--run' || w.startsWith('--run='))).toBe(false)
        expect(words.join(' ')).not.toMatch(/--yes|\brerun\b|\babort\b|\bcoder\b|\bp?kill(all)?\b|pr edit|pr merge|--add-label|--admin|--force/)
      }
    }
  })

  test('validBranch: only a plain branch name reaches git switch', () => {
    expect(validBranch(BRANCH)).toBe(true)
    expect(validBranch('issue-12')).toBe(true)
    expect(validBranch('-c')).toBe(false)
    expect(validBranch('feat/issue-1 x')).toBe(false)
    expect(validBranch('feat/$(x)')).toBe(false)
    expect(validBranch('')).toBe(false)
  })
})

describe('parsers, against the CLIs\' own lines (SPEC 6.2)', () => {
  test('parseGuard: each FAIL line as { name, reason }, each test-weakening WARN line whole', () => {
    const out = [G.headPass, G.behind, G.pending, G.linkage, G.warn, G.detector, G.verified, G.weakened, ''].join('\n')
    expect(parseGuard(out)).toEqual({
      fails: [
        { name: 'mergeable', reason: `behind main, ${BEHIND_FIX}` },
        { name: 'checks', reason: 'ci=pending' },
        { name: 'linkage', reason: 'MISMATCH #7 issue=#12 expect=closing via=api actual=[] body=[]' },
      ],
      warns: [G.warn, G.detector],
    })
    expect(parseGuard([G.author, G.merged, G.gates, G.noChecks, G.conflict].join('\n')).fails).toEqual([
      { name: 'author', reason: 'PR #550 was not opened by a trusted author' },
      { name: 'mergeable', reason: 'PR is MERGED' },
      { name: 'gates', reason: 'run RUN1 has a step awaiting approval: ci,awaiting_approval,0' },
      { name: 'checks', reason: 'no checks reported' },
      { name: 'mergeable', reason: `conflicts with main, rebase and re-gate: ${REBASE_FIX}` },
    ])
    expect(parseGuard('')).toEqual({ fails: [], warns: [] })
  })

  test('parseUpdateBehind: UPDATED with both heads, FAIL, SKIP', () => {
    expect(parseUpdateBehind(`${UB.updated}\n`)).toEqual({ result: 'updated', branch: BRANCH, from: GATED, to: NEWH, line: UB.updated })
    expect(parseUpdateBehind(UB.patch)).toEqual({ result: 'fail', branch: null, from: null, to: null, line: UB.patch })
    expect(parseUpdateBehind(UB.dirty)?.result).toBe('fail')
    expect(parseUpdateBehind(UB.clean)).toEqual({ result: 'skip', branch: null, from: null, to: null, line: UB.clean })
    expect(parseUpdateBehind(UB.unknown)?.result).toBe('skip')
    // an UPDATED line that lost a head is not one
    expect(parseUpdateBehind(`UPDATED pr=550 branch=${BRANCH} from=${GATED} to= run=${RUN}`)).toBeNull()
    expect(parseUpdateBehind('')).toBeNull()
  })

  test('parseFixLinkage: MATCH, SKIP, REPAIRED, MISMATCH after-fix', () => {
    expect(parseFixLinkage(`${FL.match}\n`)).toEqual({ result: 'match', line: FL.match })
    expect(parseFixLinkage(FL.skip)).toEqual({ result: 'skip', line: FL.skip })
    expect(parseFixLinkage(FL.repaired)).toEqual({ result: 'repaired', line: FL.repaired })
    expect(parseFixLinkage(FL.still)).toEqual({ result: 'mismatch', line: FL.still })
    expect(parseFixLinkage('Repairing PR #550 body...')).toBeNull()
  })

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

  test('parseCloseIssue and mergeRefusal: what callum-flow-merge prints', () => {
    expect(parseCloseIssue(`${M.close}\n`)).toBe(12)
    expect(parseCloseIssue('')).toBeNull()
    expect(mergeRefusal(`GraphQL: refused\n${M.moved}\n`)).toBe(M.moved)
    expect(mergeRefusal(`GraphQL: refused\n${M.behind}\n`)).toBe(M.behind)
    expect(mergeRefusal(M.other)).toBe(M.other)
    expect(mergeRefusal('callum-flow-merge: the guard verified no head sha - not merging')).toBe('callum-flow-merge: the guard verified no head sha - not merging')
    expect(mergeRefusal(`${G.warn}\nsome other error`)).toBeNull()
  })

  test('guardKeyAfter: one past this PR and head\'s guard entries, never a held key', () => {
    const g = (key: string, pr: number, head: string) => entry(key, 'guard', { pr, head })
    expect(guardKeyAfter([], 550, GATED)).toBe(`guard:550:${GATED}:1`)
    const ledger = [g(`guard:550:${GATED}:1`, 550, GATED), g(`guard:550:${GATED}:2`, 550, GATED), g('guard:551:x:1', 551, 'x'), g(`guard:550:${NEWH}:1`, 550, NEWH)]
    expect(guardKeyAfter(ledger, 550, GATED)).toBe(`guard:550:${GATED}:3`)
    // a key already taken (say by an entry missing its pr) is skipped
    expect(guardKeyAfter([...ledger, entry(`guard:550:${GATED}:3`, 'guard')], 550, GATED)).toBe(`guard:550:${GATED}:4`)
  })

  test('slotFor: the slot on the run\'s branch, a held one first; leasedPath: treehouse get\'s path', () => {
    const pool = (slots: Slot[]): Pool => ({ free: 4, total: 16, slots })
    expect(slotFor(null, BRANCH)).toBeNull()
    expect(slotFor(pool([slot(SLOT, 'feat/issue-51-other')]), BRANCH)).toBeNull()
    expect(slotFor(pool([slot(OTHER_SLOT, BRANCH, 'available'), slot(SLOT, BRANCH, 'in-use')]), BRANCH)?.path).toBe(SLOT)
    expect(slotFor(pool([slot(OTHER_SLOT, BRANCH), slot(SLOT, BRANCH)]), BRANCH)?.path).toBe(SLOT)
    expect(slotFor(pool([slot('', BRANCH)]), BRANCH)).toBeNull()
    expect(leasedPath(`${LEASED}\n`)).toBe(LEASED)
    expect(leasedPath('')).toBeNull()
    expect(leasedPath('no free worktree')).toBeNull()
  })

  test('respondProblem: the log read back after the settle', () => {
    const r = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '' })
    expect(respondProblem(r('step: review\nstatus: running\n'))).toBeNull()
    expect(respondProblem(r(''))).toBeNull()
    expect(respondProblem(r('gate: test\nfactory-loop: respond exited 0\n'))).toBeNull()
    expect(respondProblem(r('error: no active run to respond to\n'))).toBe('no active run to respond to')
    expect(respondProblem(r('Error: no active run to respond to\nfactory-loop: respond exited 1\n'))).toBe('no active run to respond to')
    expect(respondProblem(r('Error: unknown flag: --bogus\nfactory-loop: respond exited 2\n'))).toBe('respond exited 2: Error: unknown flag: --bogus')
    expect(respondProblem(r(`factory-loop: the slot is on main, not ${BRANCH}\n`, 3))).toBe(`factory-loop: the slot is on main, not ${BRANCH}`)
    expect(respondProblem({ exitCode: 1, stdout: '', stderr: 'cat: /x.log: No such file or directory\n' })).toBe('cat: /x.log: No such file or directory')
  })
})

describe('guard (rule M1)', () => {
  test('a pass: done with no FAIL; WARN lines are kept whole', async () => {
    const { result, calls } = await exec(A.guard())
    expect(calls).toEqual([{ argv: ['callum-flow-merge-guard', '550', '--run', RUN], init: { timeoutMs: 300_000 } }])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'guard', fails: [], warns: [] }, summary: 'guard PR #550 at a1b2c3d: pass' })
    const warned = (await exec(A.guard(), [{ stdout: `${G.warn}\n` }])).result
    expect(warned).toEqual({ status: 'done', outcome: { kind: 'guard', fails: [], warns: [G.warn] }, summary: 'guard PR #550 at a1b2c3d: pass, 1 test-weakening WARN' })
    const proved = (await exec(A.guard(), [{ stdout: `${G.headPass}\n` }])).result
    expect(proved).toMatchObject({ status: 'done', outcome: { kind: 'guard', fails: [], warns: [] } })
  })

  test('exit 1 with FAIL lines: done with the fails plan classifies (rule M2)', async () => {
    const { result } = await exec(A.guard(), [{ exitCode: 1, stdout: [G.behind, G.pending, G.warn].join('\n') }])
    expect(result).toEqual({
      status: 'done',
      outcome: {
        kind: 'guard',
        fails: [
          { name: 'mergeable', reason: `behind main, ${BEHIND_FIX}` },
          { name: 'checks', reason: 'ci=pending' },
        ],
        warns: [G.warn],
      },
      summary: 'guard PR #550 at a1b2c3d: FAIL mergeable, checks, 1 test-weakening WARN',
    })
  })

  test('a guard that cannot run at all is failed, not an empty pass', async () => {
    const quiet = (await exec(A.guard(), [{ exitCode: 1, stderr: 'sh: 1: jq: not found' }])).result
    expect(quiet).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1, detail: 'sh: 1: jq: not found' } })
    const usage = (await exec(A.guard(), [{ exitCode: 2, stderr: 'callum-flow-merge-guard: jq not found\nusage: callum-flow-merge-guard <pr> ...' }])).result
    expect(usage).toMatchObject({ status: 'failed', noRetry: true, outcome: { kind: 'cli', exit: 2 } })
    const missing = (await exec(A.guard(), [{ exitCode: 127, stderr: 'callum-flow-merge-guard: not found' }])).result
    expect(missing).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 127 } })
    const timedOut = (await exec(A.guard(), [new Error('command timed out after 300000 ms')])).result
    expect(timedOut).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: NO_EXIT, detail: 'command timed out after 300000 ms' },
      summary: 'callum-flow-merge-guard: command timed out after 300000 ms',
    })
  })
})

describe('update-behind (rules M2, M2a, M2b)', () => {
  test('UPDATED: done with both heads, and rebased_behind logged with the pushed head (SPEC 7.4)', async () => {
    const { result, calls, events } = await exec(A.behind(), [{ stdout: `${UB.updated}\n` }])
    expect(calls).toEqual([{ argv: ['callum-flow-merge-guard', '550', '--update-behind', '--run', RUN], init: { timeoutMs: 300_000 } }])
    expect(result).toEqual({
      status: 'done',
      outcome: { kind: 'update-behind', result: 'updated', from: GATED, to: NEWH, line: UB.updated },
      summary: 'rebased PR #550 a1b2c3d -> f0e1d2c',
    })
    expect(events).toEqual([{ state: 'rebased_behind', fields: { issue: 50, run: RUN, branch: BRANCH, pr: 550, head: NEWH } }])
  })

  test('a failed rebased_behind log never fails the update: the push already happened', async () => {
    const { result } = await exec(A.behind(), [{ stdout: UB.updated }], {
      event: async () => {
        throw new Error('callum-flow-event: usage')
      },
    })
    expect(result).toMatchObject({ status: 'done', outcome: { kind: 'update-behind', result: 'updated' } })
    expect(result.summary).toContain('rebased_behind not logged: callum-flow-event: usage')
  })

  test('FAIL: done, so rule M2a spawns the re-gate fixer with the line; nothing is logged', async () => {
    for (const line of [UB.patch, UB.dirty]) {
      const { result, events } = await exec(A.behind(), [{ exitCode: 1, stdout: `${line}\n` }])
      expect(result).toMatchObject({ status: 'done', outcome: { kind: 'update-behind', result: 'fail', from: null, to: null, line } })
      expect(events).toHaveLength(0)
    }
  })

  test('SKIP: a failed attempt with its outcome, so rule M2b retries and then tells', async () => {
    for (const line of [UB.clean, UB.unknown]) {
      const { result, events } = await exec(A.behind(), [{ exitCode: 1, stdout: `${line}\n` }])
      expect(result).toEqual({ status: 'failed', outcome: { kind: 'update-behind', result: 'skip', from: null, to: null, line }, summary: line })
      expect(events).toHaveLength(0)
    }
  })

  test('output that matches its exit or nothing at all is a failure; exit 2 is never retried', async () => {
    expect((await exec(A.behind(), [{ exitCode: 0, stdout: '' }])).result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 0 } })
    expect((await exec(A.behind(), [{ exitCode: 1, stdout: UB.updated }])).result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
    expect((await exec(A.behind(), [{ exitCode: 0, stdout: UB.patch }])).result).toMatchObject({ status: 'failed' })
    const usage = 'callum-flow-merge-guard: --update-behind takes only --run and --base'
    expect((await exec(A.behind(), [{ exitCode: 2, stderr: usage }])).result).toMatchObject({ status: 'failed', noRetry: true })
  })
})

describe('fix-linkage (rule M2)', () => {
  test('MATCH, SKIP and REPAIRED end it', async () => {
    for (const line of [FL.match, FL.skip, FL.repaired]) {
      const { result, calls } = await exec(A.linkage(), [{ stdout: `${line}\n`, stderr: 'Repairing PR #550 body...\n' }])
      expect(calls).toEqual([{ argv: ['callum-flow-fix-linkage', '550'], init: { timeoutMs: 120_000 } }])
      expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 0 }, summary: line })
    }
  })

  test('still mismatched after the repair is an answer, so the guard runs again and a second FAIL tells', async () => {
    const { result } = await exec(A.linkage(), [{ exitCode: 1, stdout: `${FL.still}\n`, stderr: 'Repairing PR #550 body...\n' }])
    expect(result).toEqual({ status: 'done', outcome: { kind: 'cli', exit: 1, detail: FL.still }, summary: `still mismatched: ${FL.still}` })
  })

  test('an error (an untrusted author, a failed edit) is failed and retried; usage is not', async () => {
    const { result } = await exec(A.linkage(), [{ exitCode: 1, stderr: `${FL.untrusted}\n` }])
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 1, detail: FL.untrusted },
      summary: `callum-flow-fix-linkage: exit 1: ${FL.untrusted}`,
    })
    expect((await exec(A.linkage(), [{ exitCode: 1, stderr: RATE }])).result).toMatchObject({ status: 'failed', rateLimited: true })
    expect((await exec(A.linkage(), [{ exitCode: 2, stderr: 'usage: callum-flow-fix-linkage <pr> [--expect closing|refs]' }])).result).toMatchObject({ noRetry: true })
  })
})

describe('merge (rules M5, M6, M7)', () => {
  test('merged: the rollout comes from callum-flow-rollout for the issue', async () => {
    const { result, calls } = await exec(A.merge(), [{ stderr: `${G.warn}\n` }, { stdout: 'ROLLOUT run-it source=brief\n' }])
    expect(calls).toEqual([
      { argv: ['callum-flow-merge', '550', '--run', RUN], init: { timeoutMs: 600_000 } },
      { argv: ['callum-flow-rollout', '50'], init: { timeoutMs: 60_000 } },
    ])
    expect(result).toEqual({
      status: 'done',
      outcome: { kind: 'merge', result: 'merged', rollout: 'run-it', closeIssue: null, line: 'merged PR #550 at a1b2c3d' },
      summary: 'merged PR #550, rollout run-it',
    })
  })

  test('a closing PR on an epic base: the issue to close by hand', async () => {
    const { result } = await exec(A.merge(), [{ stdout: `${M.close}\n` }, { stdout: 'ROLLOUT merge source=brief\n' }])
    expect(result).toEqual({
      status: 'done',
      outcome: { kind: 'merge', result: 'merged', rollout: 'merge', closeIssue: 12, line: M.close },
      summary: 'merged PR #550, rollout merge, close #12 by hand',
    })
  })

  test('a rollout that cannot be read after the merge never fails the merge', async () => {
    for (const reply of [
      { exitCode: 1, stdout: 'ROLLOUT unreadable cannot read issue #50\n' },
      { exitCode: 1, stdout: "ROLLOUT conflict brief says merge but issue #50 has a '## Run it' heading\n" },
      new Error('command timed out after 60000 ms'),
    ]) {
      const { result } = await exec(A.merge(), [{}, reply])
      expect(result).toMatchObject({ status: 'done', outcome: { kind: 'merge', result: 'merged', rollout: null, closeIssue: null } })
      expect(result.summary).toContain('rollout unread')
    }
    // a merge with no issue reads no rollout
    const { calls, result } = await exec(A.merge(null))
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ status: 'done', outcome: { kind: 'merge', result: 'merged', rollout: null } })
  })

  test('a guard FAIL the merge printed is this head\'s next guard outcome, so rule M2 handles it (SPEC 5.5)', async () => {
    const ledger = [
      entry(`guard:550:${GATED}:1`, 'guard', { pr: 550, head: GATED, outcome: { kind: 'guard', fails: [], warns: [] } }),
      entry('guard:551:other:1', 'guard', { pr: 551, head: 'other' }),
    ]
    const { result, calls } = await exec(A.merge(), [{ exitCode: 1, stdout: [G.behind, G.warn].join('\n') }], { ledger })
    expect(calls).toHaveLength(1)
    const line = `GUARD mergeable FAIL behind main, ${BEHIND_FIX}`
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line },
      summary: 'not merged, the guard failed: mergeable',
      extra: [
        {
          key: `guard:550:${GATED}:2`,
          kind: 'guard',
          issue: 50,
          run: RUN,
          pr: 550,
          head: GATED,
          outcome: { kind: 'guard', fails: [{ name: 'mergeable', reason: `behind main, ${BEHIND_FIX}` }], warns: [G.warn] },
        },
      ],
    })
  })

  test('refused by GitHub or the harness: done refused with the line, for rule M6', async () => {
    for (const line of [M.moved, M.behind, M.other]) {
      const { result } = await exec(A.merge(), [{ exitCode: 1, stderr: `GraphQL: refused\n${line}\n` }])
      expect(result).toEqual({ status: 'done', outcome: { kind: 'merge', result: 'refused', rollout: null, closeIssue: null, line }, summary: line })
    }
  })

  test('a rate limit is a failed attempt with the backoff, not a refusal; other failures retry; usage never', async () => {
    const limited = (await exec(A.merge(), [{ exitCode: 1, stderr: `${RATE}\n${M.other}\n` }])).result
    expect(limited).toMatchObject({ status: 'failed', rateLimited: true, outcome: { kind: 'cli', exit: 1 } })
    const unknown = (await exec(A.merge(), [{ exitCode: 1, stderr: 'fatal: not a git repository' }])).result
    expect(unknown).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1, detail: 'fatal: not a git repository' } })
    expect('noRetry' in unknown).toBe(false)
    const usage = (await exec(A.merge(), [{ exitCode: 2, stderr: 'callum-flow-merge: method must be squash, merge or rebase' }])).result
    expect(usage).toMatchObject({ status: 'failed', noRetry: true })
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

describe('respond (rules P3, P3a; SPEC 6.1, I-51 to I-53, I-94)', () => {
  const onBranch: Pool = { free: 3, total: 16, slots: [slot(OTHER_SLOT, 'feat/issue-51-other'), slot(SLOT, BRANCH, 'in-use')] }
  const settled = { stdout: 'run: 01M4RQ0050AAAA\nstep: review\naction: fix\n' }

  test('in the slot on the run\'s branch: one detached launch, done with the slot and log (P3a reads it once settled)', async () => {
    const { result, calls, events } = await exec(A.respond(), [settled], { pool: onBranch })
    expect(calls).toEqual([{ argv: launchArgv(SLOT, BRANCH, LOG, respondArgv(A.respond())), init: { timeoutMs: 30_000 } }])
    expect(result).toEqual({
      status: 'done',
      outcome: { kind: 'respond', slot: SLOT, log: LOG },
      summary: `respond --action fix on review launched in ${SLOT}`,
    })
    // a review fix counts toward the review cap (rule P1, I-52)
    expect(events).toEqual([{ state: 'fix_requested', fields: { issue: 50, run: RUN, branch: BRANCH, note: 'review' } }])
  })

  test('the log is per ledger key and attempt (exec.ts respondLogPath)', async () => {
    const { result, calls } = await exec(A.respond({ logReview: false }), [settled], { pool: onBranch, attempts: 2 })
    const log = respondLogPath(LOOP_DIR, 'under-test', 2)
    expect(log).toBe(`${LOOP_DIR}/respond/under-test-2.log`)
    expect(respondLogPath(LOOP_DIR, `respond:${RUN}:review:h1:fix:retry`, 1)).toBe(`${LOOP_DIR}/respond/respond_${RUN}_review_h1_fix_retry-1.log`)
    expect(calls[0]?.argv[6]).toBe(log)
    expect(result).toMatchObject({ status: 'done', outcome: { kind: 'respond', slot: SLOT, log } })
  })

  test('approve and skip log nothing; only a review fix logs fix_requested', async () => {
    for (const action of [A.respond({ action: 'approve', findings: null, approveReason: 'ok', logReview: false }), A.respond({ action: 'skip', findings: null, logReview: false })]) {
      const { events, calls, result } = await exec(action, [settled], { pool: onBranch })
      expect(events).toHaveLength(0)
      expect(calls[0]?.argv.slice(7)).toEqual(respondArgv(action))
      expect(result.status).toBe('done')
    }
  })

  test('a failed fix_requested log is noted, never a second respond', async () => {
    const { result } = await exec(A.respond(), [settled], {
      pool: onBranch,
      event: async () => {
        throw new Error('callum-flow-event: usage')
      },
    })
    expect(result.status).toBe('done')
    expect(result.summary).toContain('fix_requested not logged')
  })

  test('no slot has the branch: a slot is leased, switched to the branch, and the respond launched there', async () => {
    const pool: Pool = { free: 3, total: 16, slots: [slot(OTHER_SLOT, 'feat/issue-51-other')] }
    const { result, calls } = await exec(A.respond(), [{ stdout: `${LEASED}\n`, stderr: 'treehouse: leased slot 7\n' }, {}, settled], { pool })
    expect(calls).toEqual([
      { argv: ['treehouse', 'get', '--lease', '--lease-holder', 'factory-loop'], init: { timeoutMs: 120_000, stdin: '' } },
      { argv: ['git', 'switch', BRANCH], init: { timeoutMs: 120_000, cwd: LEASED } },
      { argv: launchArgv(LEASED, BRANCH, LOG, respondArgv(A.respond())), init: { timeoutMs: 30_000 } },
    ])
    expect(result).toEqual({
      status: 'done',
      outcome: { kind: 'respond', slot: LEASED, log: LOG },
      summary: `respond --action fix on review launched in leased ${LEASED}`,
    })
    // an unread pool leases too: git switch refuses a branch another worktree holds
    expect((await exec(A.respond(), [{ stdout: LEASED }, {}, settled], { pool: null })).calls[0]?.argv).toEqual([...LEASE_ARGV])
  })

  test('no slot can be leased: failed, nothing launched', async () => {
    const { result, calls, events } = await exec(A.respond(), [{ exitCode: 1, stderr: 'treehouse: the pool is full (16 of 16 worktrees in use)\n' }], { pool: { free: 0, total: 16, slots: [] } })
    expect(calls).toHaveLength(1)
    expect(events).toHaveLength(0)
    expect(result).toMatchObject({ status: 'failed', summary: 'treehouse get: exit 1: treehouse: the pool is full (16 of 16 worktrees in use)' })
    const noPath = (await exec(A.respond(), [{ stdout: '' }], { pool: { free: 1, total: 16, slots: [] } })).result
    expect(noPath).toMatchObject({ status: 'failed', summary: 'treehouse get: exit 0: treehouse printed no slot path' })
  })

  test('the branch cannot be switched to: the leased slot goes back to the pool, failed', async () => {
    const used = `fatal: '${BRANCH}' is already used by worktree at '${SLOT}'`
    const { result, calls, events } = await exec(A.respond(), [{ stdout: LEASED }, { exitCode: 128, stderr: `${used}\n` }], { pool: { free: 3, total: 16, slots: [] } })
    expect(calls.map(c => c.argv)).toEqual([[...LEASE_ARGV], ['git', 'switch', BRANCH], ['treehouse', 'return', LEASED]])
    expect(calls[2]?.init).toEqual({ timeoutMs: 120_000, stdin: '' })
    expect(events).toHaveLength(0)
    expect(result).toEqual({ status: 'failed', outcome: { kind: 'cli', exit: 128, detail: used }, summary: `no slot on ${BRANCH}: ${used}` })
  })

  test('the log read back: no active run, an immediate error or a slot off the branch is failed', async () => {
    const cases: [Partial<RunResult>, string][] = [
      [{ stdout: 'Error: no active run to respond to\nfactory-loop: respond exited 1\n' }, 'no active run to respond to'],
      [{ stdout: 'no active run to respond to\n' }, 'no active run to respond to'],
      [{ stdout: 'Error: invalid --add-finding: unexpected end of JSON input\nfactory-loop: respond exited 1\n' }, 'respond exited 1: Error: invalid --add-finding: unexpected end of JSON input'],
      [{ exitCode: 3, stdout: `factory-loop: the slot is on main, not ${BRANCH}\n` }, `factory-loop: the slot is on main, not ${BRANCH}`],
    ]
    for (const [reply, why] of cases) {
      const { result, events } = await exec(A.respond(), [reply], { pool: onBranch })
      expect(result).toEqual({ status: 'failed', outcome: { kind: 'respond', slot: SLOT, log: LOG }, summary: `respond --action fix in ${SLOT}: ${why}` })
      // a respond that did not take is no review fix round
      expect(events).toHaveLength(0)
    }
    const timedOut = (await exec(A.respond(), [new Error('command timed out after 30000 ms')], { pool: onBranch })).result
    expect(timedOut).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT } })
  })

  test('a branch name respond cannot switch to is refused before anything runs', async () => {
    const { result, calls } = await exec(A.respond({ branch: '--detach' }), [], { pool: onBranch })
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ status: 'failed', noRetry: true })
  })
})

describe('env-retry (rule P2a, #537)', () => {
  const onBranch: Pool = { free: 3, total: 16, slots: [slot(SLOT, BRANCH, 'in-use')] }
  const retry = (over: Partial<Extract<Action, { kind: 'env-retry' }>> = {}): Action => ({
    ...base,
    class: 'drive',
    kind: 'env-retry',
    key: `env-retry:${RUN}:test:${GATED}:r1`,
    rule: 'P2a',
    run: RUN,
    branch: BRANCH,
    step: 'test',
    head: GATED,
    ...over,
  })

  test('the rerun with no flag at all, launched detached from the slot on the branch, or a leased one', async () => {
    expect(ENV_RETRY_ARGV).toEqual(['no-mistakes', 'rerun'])
    expect(argvsOf(retry(), LOOP_DIR)?.pop()).toEqual(launchArgv('<slot>', BRANCH, respondLogPath(LOOP_DIR, retry().key, 1), ENV_RETRY_ARGV))
    const { result, calls, events } = await exec(retry(), [{ stdout: 'run 01M4RQ0050BBBB started\n' }], { pool: onBranch })
    expect(calls).toEqual([{ argv: launchArgv(SLOT, BRANCH, LOG, ENV_RETRY_ARGV), init: { timeoutMs: 30_000 } }])
    expect(events).toHaveLength(0)
    expect(result).toEqual({ status: 'done', outcome: { kind: 'respond', slot: SLOT, log: LOG }, summary: `env-retry of a1b2c3d on ${BRANCH} launched in ${SLOT}` })
    const leased = await exec(retry(), [{ stdout: LEASED }, {}, {}], { pool: { free: 3, total: 16, slots: [] } })
    expect(leased.calls.map(c => c.argv)).toEqual([[...LEASE_ARGV], ['git', 'switch', BRANCH], launchArgv(LEASED, BRANCH, LOG, ENV_RETRY_ARGV)])
  })

  test('a rerun that exited at once is failed with its last line', async () => {
    const { result } = await exec(retry(), [{ stdout: 'Error: no runs found for this branch\nfactory-loop: respond exited 1\n' }], { pool: onBranch })
    expect(result).toEqual({ status: 'failed', outcome: { kind: 'respond', slot: SLOT, log: LOG }, summary: `env-retry of a1b2c3d in ${SLOT}: exited 1: Error: no runs found for this branch` })
  })

  test('refused before anything runs: another rule, a key that is no resume round, a second attempt, a bad branch', async () => {
    const cases: [Action, number][] = [
      [retry({ rule: 'P3' }), 1],
      [retry({ key: `env-retry:${RUN}:test:${GATED}` }), 1],
      [retry(), 2],
      [retry({ branch: '--detach' }), 1],
    ]
    for (const [action, attempts] of cases) {
      const { result, calls } = await exec(action, [], { pool: onBranch, attempts })
      expect({ key: action.key, calls: calls.length, result }).toMatchObject({ key: action.key, calls: 0, result: { status: 'failed', noRetry: true } })
    }
  })
})

describe('every executor', () => {
  test('mergeExecutors covers exactly its kinds, and each refuses another kind', async () => {
    expect(Object.keys(mergeExecutors).sort()).toEqual(['env-retry', 'fast-forward', 'fix-linkage', 'guard', 'merge', 'respond', 'rollout', 'update-behind'])
    for (const kind of Object.keys(mergeExecutors) as ActionKind[]) {
      const h = harness()
      const other: Action = kind === 'guard' ? A.linkage() : A.guard()
      const result: Exec = await executor(kind)(h.ctx, other)
      expect(result).toMatchObject({ status: 'failed', noRetry: true })
      expect(h.calls).toHaveLength(0)
    }
  })

  test('failure: exit 2 is a usage error only for the image\'s own CLIs', () => {
    const r = (exitCode: number, stderr = ''): RunResult => ({ exitCode, stdout: '', stderr })
    expect(failure(['callum-flow-merge', '550'], r(2))).toMatchObject({ noRetry: true })
    expect('noRetry' in failure(['git', 'switch', BRANCH], r(2))).toBe(false)
    expect('noRetry' in failure(['treehouse', 'get'], r(2))).toBe(false)
    expect(failure(['callum-flow-merge', '550'], r(1, RATE))).toMatchObject({ rateLimited: true })
  })
})

// --- fast-forward (rules M1, M2, #551) -----------------------------------------------------------

const WT = '/workspaces/dev-system/.treehouse/dev-system-22f535/3/dev-system'
const HANDOFF = '1f08432aa1f08432aa1f08432aa1f08432aa1f08'

describe('fast-forward: a worktree the pipeline left behind (#551)', () => {
  const ff = (over: Partial<FastForwardAction> = {}): FastForwardAction => ({
    ...base,
    kind: 'fast-forward',
    key: `fast-forward:550:${GATED}:1`,
    rule: 'M2',
    pr: 550,
    run: RUN,
    head: GATED,
    branch: BRANCH,
    ...over,
  })

  test('one sh -c from the main checkout, with the branch and the run head as positional arguments', async () => {
    expect(argvsOf(ff(), LOOP_DIR)).toEqual([['sh', '-c', FF_SCRIPT, 'factory-loop-fast-forward', BRANCH, GATED]])
    expect(fastForwardArgv(BRANCH, GATED)).toEqual(['sh', '-c', FF_SCRIPT, 'factory-loop-fast-forward', BRANCH, GATED])
    const { calls } = await exec(ff(), [{ stdout: `CURRENT ${GATED}\n` }])
    expect(calls).toEqual([{ argv: fastForwardArgv(BRANCH, GATED), init: { timeoutMs: MERGE_TIMEOUT_MS['fast-forward'] } }])
  })

  test('the script moves a worktree only by a fast-forward, after origin, the tree and ancestry are checked', () => {
    expect(FF_SCRIPT).toContain('merge --ff-only')
    expect(FF_SCRIPT).toContain('status --porcelain --untracked-files=no')
    expect(FF_SCRIPT).toContain('merge-base --is-ancestor "$at" "$head"')
    expect(FF_SCRIPT).toContain('if [ "$origin" != "$head" ]')
    // the main checkout is never moved (rule G5 tells the owner instead)
    expect(FF_SCRIPT).toContain('[ "$p" != "$main" ] || { echo "REFUSED')
    expect(FF_SCRIPT).not.toMatch(/\b(push|reset|rebase|checkout|clean|stash)\b/)
    // every check comes before the first move
    expect(FF_SCRIPT.indexOf('merge --ff-only')).toBeGreaterThan(FF_SCRIPT.indexOf('merge-base --is-ancestor'))
  })

  test('FORWARDED, CURRENT and REFUSED are answers, logged with both heads', async () => {
    const moved = await exec(ff(), [{ stdout: `FORWARDED ${HANDOFF} ${GATED} ${WT}\n` }])
    expect(moved.result).toEqual({
      status: 'done',
      outcome: { kind: 'fast-forward', result: 'forwarded', line: `FORWARDED ${HANDOFF} ${GATED} ${WT}` },
      summary: `PR #550: FORWARDED ${HANDOFF} ${GATED} ${WT}`,
    })
    const current = await exec(ff(), [{ stdout: `CURRENT ${GATED}\n` }])
    expect(current.result).toMatchObject({ status: 'done', outcome: { kind: 'fast-forward', result: 'current' } })
    const dirty = await exec(ff(), [{ stdout: `REFUSED ${WT} has uncommitted changes\n` }])
    expect(dirty.result).toMatchObject({ status: 'done', outcome: { kind: 'fast-forward', result: 'refused', line: `REFUSED ${WT} has uncommitted changes` } })
    expect(parseFastForward(`FORWARDED a ${GATED} /w/1\nFORWARDED b ${GATED} /w/2\n`)).toEqual({ result: 'forwarded', line: `FORWARDED a ${GATED} /w/1; FORWARDED b ${GATED} /w/2` })
    expect(parseFastForward('')).toBeNull()
  })

  test('a fetch or a fast-forward that fails is a failed attempt; a bad branch or head is refused before any command', async () => {
    const failed = await exec(ff(), [{ exitCode: 1, stderr: `factory-loop: the fast-forward of ${WT} failed\n` }])
    expect(failed.result).toMatchObject({ status: 'failed', summary: `fast-forward: exit 1: factory-loop: the fast-forward of ${WT} failed` })
    const silent = await exec(ff(), [{ exitCode: 0, stdout: 'nothing said\n' }])
    expect(silent.result).toMatchObject({ status: 'failed' })
    for (const bad of [ff({ branch: '--upload-pack=x' }), ff({ head: 'HEAD~1' }), ff({ head: '$(id)' })]) {
      const r = await exec(bad)
      expect(r.result).toMatchObject({ status: 'failed', noRetry: true })
      expect(r.calls).toEqual([])
    }
  })

  test('plan\'s fast-forward for a lagging worktree runs as is', async () => {
    const lag = { name: 'head', reason: `run=${GATED} origin=${GATED} pr=${GATED} worktree=${HANDOFF} (run ${RUN}); fix: ...` }
    const guard = entry(`guard:550:${GATED}:1`, 'guard', { issue: 50, pr: 550, head: GATED, startedAt: NOW - 120_000, endedAt: NOW - 60_000, outcome: { kind: 'guard', fails: [lag], warns: [] } })
    const s = withLedger(state({ issues: [mine(50, 'ready to merge', { pr: 550 })], runs: [run(50, 'merge-ready', { head: GATED, branch: BRANCH, run: RUN })] }), [guard])
    const action = plan(s, config()).actions.find(a => a.kind === 'fast-forward')
    expect(action).toMatchObject({ key: `fast-forward:550:${GATED}:1`, head: GATED, branch: BRANCH })
    if (action === undefined) throw new Error('plan built no fast-forward')
    const { result } = await exec(action, [{ stdout: `FORWARDED ${HANDOFF} ${GATED} ${WT}\n` }])
    expect(result).toMatchObject({ status: 'done', outcome: { result: 'forwarded' } })
  })
})
