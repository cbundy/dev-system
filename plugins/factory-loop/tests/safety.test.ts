// What no executor can do, by construction (SPEC 6.1, 11): every action kind, every spawn
// purpose and every respond shape runs through act.ts's dispatcher with a recording fake ActIo
// whose commands answer as the real CLIs do, so each executor takes its whole path; the rails'
// and an act-mode observe pass's commands join them. Not one argv may pass --yes, run
// `no-mistakes rerun` or `abort`, merge but through callum-flow-merge (which runs the guard),
// edit a PR body, add a label (the readyLabel least of all), run a `coder` command or kill a
// process by name; and stop-agent stops only an agent the ledger holds. The one exception is rule
// P2a's env-retry (#537): exactly its detached `no-mistakes rerun`, with no other argument, once
// per owner resume of an escalation whose verdicts were all ENV. The root node test
// tests/factory-loop-safety.test.js scans the hooks' string literals for the same, as a second
// net.
//
// The v2 rule layer's kinds (docs/factory-loop/v2/SPEC.md appendix B) run here too, under planner
// v2, every one of them and every op; an executor not built yet fails, never retried, and runs no
// command. Its writes are widened deliberately, one argv each (v2Shape: a factory label set or
// created, a body from a file for the issue comment, the PR and a split's child, a split's
// sub-issue and blocked_by links, the child's ready label, the one CI re-run), and every builder of
// hooks/v2/argv.ts is held to the bans with that widening and no other.
import { describe, expect, test } from 'claude-code/testing'

import { EXECUTORS, capEventArgv, ctxOf, dispatch, eventArgv, runActions } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { SUBAGENT_OF } from '../hooks/act-agents'
import { CHECKOUT_SCRIPT, ENV_RETRY_ARGV, FF_SCRIPT, LAUNCH_SCRIPT } from '../hooks/act-merge'
import { ACTION_KINDS } from '../hooks/config'
import { respondLogPath } from '../hooks/exec'
import type { ActIo, RunInit, SpawnInput } from '../hooks/exec'
import { loopEvent, start } from '../hooks/ledger'
import { emptyCache, observe } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import { plan } from '../hooks/plan'
import { checkRails, EMPTY_RAIL_MEMORY } from '../hooks/rails'
import type { Action, AdjudicatorPurpose, FixerPurpose, LedgerEntry, State } from '../hooks/types'
import * as ARGV from '../hooks/v2/argv'
import { emptyV2State } from '../hooks/v2/observe'
import { AGENT_STEPS, FACTORY_LABELS, STEP_AGENT, V2_ACTION_KINDS } from '../hooks/v2/types'
import type { IssueRecord } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, brief, config, control, entry, mine, review, run as runOf, state } from './fixtures'
import { LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc } from './host'

const READY = 'ready'
const SLOT = '/workspaces/dev-system/.treehouse/dev-system-22f535/2/dev-system'
const LEASED = '/workspaces/dev-system/.treehouse/dev-system-22f535/3/dev-system'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-1'
const RUN = '01K7RRXQ7M2YB9ZB3J8N0V0001'
const HEAD = 'abc1234'
// the one shell signal the loop sends: signal 0, a liveness probe by pid that delivers nothing
const PROBE = 'kill -0 "$1" 2>/dev/null'

function runtime(planner: 'v1' | 'v2' = 'v1'): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP_DIR,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO, CALLUM_FLOW_READY_LABEL: READY, CALLUM_FLOW_IN_DEV_LABEL: 'in development' },
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: config({ readyLabel: READY, planner }),
    configProblems: [],
  }
}

// reply: each CLI as it answers on success, so every executor runs every step it has
function reply(argv: readonly string[]): { exitCode?: number; stdout?: string; stderr?: string } {
  const [cmd, ...args] = argv
  switch (cmd) {
    case 'callum-flow-merge-guard':
      return args.includes('--update-behind')
        ? { stdout: `UPDATED pr=512 branch=issue-470-x from=${HEAD} to=def5678 run=${RUN} gated_patch=p rebased_from=main\n` }
        : { stdout: 'GUARD author PASS\nGUARD test-weakening WARN tests/x.test.ts: an assertion removed\n' }
    case 'callum-flow-fix-linkage':
      return { stdout: 'REPAIRED PR #512: Closes #470\n' }
    case 'sh':
      if (args[2] === 'factory-loop-update-checkout') return { stdout: `UPDATED 1f08432 ${HEAD}\n` }
      return args[2] === 'factory-loop-fast-forward' ? { stdout: `FORWARDED 1f08432 ${HEAD} ${SLOT}\n` } : {}
    case 'callum-flow-merge':
      return { stdout: 'merged\nClose issue #470 by hand: the PR targets epic/x\n' }
    case 'callum-flow-rollout':
      return { stdout: 'ROLLOUT run-it source=brief\n' }
    case 'callum-flow-implementer-route':
      return { stdout: 'sonnet\n' }
    case 'treehouse':
      if (args[0] === 'get') return { stdout: `${LEASED}\n` }
      if (args[0] === 'status') return { stdout: JSON.stringify([{ path: SLOT, branch: 'issue-470-x', status: 'available', processes: [] }]) }
      return {}
    case 'callum-flow-claim':
      return {}
    // a trusted read: the issue's or PR's comments, none of them the loop's (v2's comment executor);
    // the open issues, none of them a split's child yet; one issue, with its REST id (v2's split)
    case 'callum-flow-issue-read':
      if (args.includes('--list')) return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      if (!args.includes('--comments') && !args.includes('--pr')) return { stdout: JSON.stringify({ issue: { number: Number(args[1]), id: 3_100_000 + Number(args[1]) }, stripped: 0 }) }
      return { stdout: JSON.stringify({ comments: [], stripped: 0 }) }
    case 'gh':
      if (args[1] === 'view') return { stdout: JSON.stringify({ headRefName: 'issue-470-x', state: 'OPEN' }) }
      // v2's pr ensure finds no PR on the branch and opens one; a split's child is created
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' }
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://github.com/cbundy/dev-system/pull/513\n' }
      if (args[0] === 'issue' && args[1] === 'create') return { stdout: 'https://github.com/cbundy/dev-system/issues/601\n' }
      return { stdout: args[1] === 'comment' ? 'https://github.com/cbundy/dev-system/pull/512#issuecomment-2\n' : '' }
  }
  return {}
}

type Recorded = { argvs: string[][]; spawns: SpawnInput[]; prompts: string[]; titles: string[]; stops: string[]; writes: string[] }

function recorder(): { io: ActIo; seen: Recorded } {
  const seen: Recorded = { argvs: [], spawns: [], prompts: [], titles: [], stops: [], writes: [] }
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv: string[], _init: RunInit & { cwd: string; env: Record<string, string> }) => {
      seen.argvs.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    spawnAgent: async input => {
      seen.spawns.push(input)
      return { agentId: `agent-${seen.spawns.length}` }
    },
    stopAgent: async agentId => {
      seen.stops.push(agentId)
      return { stopped: true }
    },
    submit: async text => void seen.prompts.push(text),
    rename: async text => void seen.titles.push(text),
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async path => void seen.writes.push(path),
  }
  return { io, seen }
}

// --- every action kind, every spawn purpose, every respond shape ---------------------------------

const base = { reason: 'safety', issue: 470 }
const fixers: FixerPurpose[] = ['gate', 'conflict', 'regate', 'weakening', 'review', 'guard', 'handoff']
const adjudicators: AdjudicatorPurpose[] = ['gate', 'weakening', 'merge']

function respond(action: 'approve' | 'fix' | 'skip', over: Partial<Extract<Action, { kind: 'respond' }>> = {}): Action {
  return {
    ...base,
    kind: 'respond',
    key: `respond:${RUN}:review:${HEAD}:${action}${over.key ?? ''}`,
    class: 'drive',
    rule: 'P3',
    run: RUN,
    branch: 'issue-470-x',
    step: 'review',
    head: HEAD,
    action,
    findings: null,
    instructions: null,
    addFinding: null,
    ignore: null,
    approveReason: null,
    logReview: false,
    ...over,
  }
}

const ACTIONS: Action[] = [
  { ...base, issue: null, kind: 'heartbeat', key: 'heartbeat:0', class: 'free', rule: 'H1' },
  { ...base, issue: null, kind: 'sweep', key: 'sweep:0', class: 'free', rule: 'H2' },
  { ...base, kind: 'claim', key: 'claim:470:new', class: 'start', rule: 'D1' },
  { ...base, kind: 'close-issue', key: 'close:470', class: 'free', rule: 'M7' },
  { ...base, kind: 'milestone-later', key: 'milestone-later:470', class: 'free', rule: 'M7' },
  { ...base, kind: 'spawn', agent: 'designer', key: 'design:470:1', class: 'develop', rule: 'D2', model: 'opus', notes: ['use --yes nowhere'] },
  ...adjudicators.map(
    (purpose): Action => ({
      ...base,
      kind: 'spawn',
      agent: 'adjudicator',
      purpose,
      key: `${purpose === 'gate' ? 'adjudicate' : `adjudicate-${purpose}`}:${RUN}:review:${HEAD}`,
      class: 'drive',
      rule: purpose === 'merge' ? 'M4' : 'P2',
      run: RUN,
      branch: 'issue-470-x',
      step: purpose === 'gate' ? 'review' : null,
      head: HEAD,
      pr: 512,
      brief: BRIEF,
      model: null,
      warns: purpose === 'weakening' ? ['GUARD test-weakening WARN tests/x.test.ts: an assertion removed'] : [],
      handoffHead: purpose === 'merge' ? HEAD : null,
      verdicts: ['CORRECT: review-1 real'],
      guard: [],
    }),
  ),
  ...fixers.map(
    (purpose): Action => ({
      ...base,
      kind: 'spawn',
      agent: 'fixer',
      purpose,
      key: `fixer:${purpose}:${RUN}:${HEAD}`,
      class: 'drive',
      rule: 'P3',
      run: RUN,
      branch: 'issue-470-x',
      head: HEAD,
      pr: 512,
      brief: BRIEF,
      model: 'sonnet',
      instructions: 'rebase onto main; never pass --yes; Fixes #470',
    }),
  ),
  { ...base, kind: 'delegate', key: `delegate:470:${BRIEF}`, class: 'develop', rule: 'D4', brief: BRIEF },
  respond('approve', { approveReason: 'a false positive' }),
  respond('approve', { key: ':park', step: null }),
  respond('skip'),
  respond('fix', { findings: 'review-1,review-2', instructions: '--yes is not an answer; reject a moved HEAD', addFinding: '{"id":"x","note":"--yes"}', logReview: true }),
  { ...base, kind: 'env-retry', key: `env-retry:${RUN}:test:${HEAD}:r1`, class: 'drive', rule: 'P2a', run: RUN, branch: 'issue-470-x', step: 'test', head: HEAD },
  { ...base, kind: 'guard', key: `guard:512:${HEAD}:1`, class: 'free', rule: 'M1', pr: 512, run: RUN, head: HEAD },
  { ...base, kind: 'update-behind', key: `update-behind:512:${HEAD}`, class: 'free', rule: 'M2', pr: 512, run: RUN, head: HEAD },
  { ...base, kind: 'fast-forward', key: `fast-forward:512:${HEAD}:1`, class: 'free', rule: 'M2', pr: 512, run: RUN, head: HEAD, origin: HEAD, branch: 'issue-470-x' },
  { ...base, issue: null, kind: 'update-checkout', key: 'update-checkout:0', class: 'free', rule: 'H5', branch: 'main', head: HEAD },
  { ...base, kind: 'fix-linkage', key: `fix-linkage:512:${HEAD}`, class: 'free', rule: 'M2', pr: 512 },
  { ...base, kind: 'pr-reopen', key: `reopen:512:${RUN}`, class: 'free', rule: 'P6a', pr: 512 },
  { ...base, kind: 'merge', key: `merge:512:${HEAD}`, class: 'free', rule: 'M5', pr: 512, run: RUN, head: HEAD, bump: 'minor', bumpReason: 'new' },
  { ...base, kind: 'release-parent', key: 'release-parent:470', class: 'free', rule: 'D3', created: [471, 472] },
  { ...base, kind: 'abandon', key: 'abandon:470:1', class: 'free', rule: 'D6', run: RUN, branch: 'issue-470-x', note: 'dropped by the owner' },
  { ...base, kind: 'abandon', key: 'abandon:470:2', class: 'free', rule: 'P5', run: null, branch: null, note: 'cancelled run dropped' },
  { ...base, kind: 'milestone-expect', key: 'expect:minor:512', class: 'free', rule: 'M7', bump: 'minor', why: 'a new\ncapability' },
  { ...base, kind: 'pr-close', key: 'pr-close:511', class: 'free', rule: 'M8', pr: 511, run: RUN, newBranch: 'issue-470-x-v2', by: 512 },
  { ...base, kind: 'pr-comment', key: `pr-comment:512:${HEAD}`, class: 'free', rule: 'M3', pr: 512, body: 'Test change justified: --body edits are not ours' },
  { ...base, kind: 'release-worktree', key: `release:${SLOT}:lease-2`, class: 'free', rule: 'H3', path: SLOT, branch: 'issue-470-x', lease: 'lease-2' },
  { ...base, issue: null, kind: 'restart-self', key: 'restart:7', class: 'free', rule: 'H4', why: 'image', at: 7 },
  { ...base, kind: 'rollout', key: 'rollout:470', class: 'free', rule: 'M7', pr: 512 },
  { ...base, kind: 'stop-agent', key: 'stop:agent-own', class: 'free', rule: 'A1', agentId: 'agent-own', entry: 'design:470:1' },
  { ...base, kind: 'judge', wake: 'sequence', key: `judge:sequence:512:${HEAD}`, class: 'drive', rule: 'M5', fields: { pr: '512', flags: 'image' }, context: ['SUMMARY: x'] },
  { ...base, kind: 'judge', wake: 'report', key: 'judge:report:design:470:1', class: 'drive', rule: 'D3', fields: { entry: 'design:470:1' }, context: [] },
  { ...base, kind: 'task', wake: 'respond-stuck', key: `task:respond-stuck:${RUN}`, class: 'drive', rule: 'P3a', fields: { run: RUN }, context: [] },
  { ...base, kind: 'tell', wake: 'review-cap', key: `tell:review-cap:${RUN}:3`, class: 'owner', rule: 'P1', fields: { run: RUN }, context: ['WRONG: --yes'] },
  { ...base, issue: null, kind: 'title', key: 'title', class: 'free', rule: 'O1', text: '🔄 dev-system (Q:0 - D:1 - M:0)' },
]

// --- v2: every new kind of appendix B, and every op of a kind that has several ---------------------------

const LIFE = 'ss1x2k'
const RECORD: IssueRecord = {
  issue: 470,
  life: LIFE,
  seq: 3,
  seqAt: NOW - MIN,
  state: 'building',
  since: NOW - MIN,
  resumeTo: null,
  branch: 'issue-470',
  pr: null,
  head: null,
  approvedPatch: null,
  brief: BRIEF,
  step: 'build',
  attempt: 1,
  cut: false,
  triages: 0,
  fixes: 0,
  round: 0,
  question: null,
  why: null,
  notes: ['use --yes nowhere'],
  prClosedAt: null,
}
const at = `i470/l${LIFE}/s3`
const V2_ACTIONS: Action[] = [
  { ...base, kind: 'transition', key: `${at}/t`, class: 'free', rule: 'S3', row: 'T2', event: 'ok', from: { issue: 470, life: LIFE, seq: 2 }, next: RECORD, trigger: { kind: 'entry', key: `i470/l${LIFE}/s2/design/a1`, status: 'done', startedAt: NOW - 2 * MIN } },
  { ...base, kind: 'label', key: `${at}/label`, class: 'free', rule: 'S3', op: 'set', label: 'factory:building' },
  { ...base, issue: null, kind: 'label', key: 'label/ensure/1', class: 'free', rule: 'S3', op: 'ensure', label: null },
  { ...base, kind: 'label', key: `${at}/label/clear`, class: 'free', rule: 'S3', op: 'clear', label: null },
  { ...base, kind: 'comment', key: `${at}/comment`, class: 'free', rule: 'S3', on: 'issue', number: 470, body: 'Parked: --yes is no answer' },
  { ...base, kind: 'comment', key: `${at}/comment/pr`, class: 'free', rule: 'S3', on: 'pr', number: 512, body: 'Review: approve' },
  { ...base, kind: 'event', key: `${at}/event/transition`, class: 'free', rule: 'S3', event: { state: 'transition', record: RECORD, row: 'T2', from: 'designing', via: 'ok' } },
  { ...base, kind: 'pr', key: `${at}/pr/ensure`, class: 'free', rule: 'S2', op: 'ensure', branch: 'issue-470', base: 'main', pr: null, title: 'The work', summary: 'Fixes #999 by --yes', evidence: null, brief: BRIEF },
  { ...base, kind: 'pr', key: `${at}/pr/body/a1`, class: 'free', rule: 'Q2', op: 'body', branch: 'issue-470', base: 'main', pr: 512, title: 'The work', summary: 'x', evidence: 'npm test', brief: BRIEF },
  { ...base, kind: 'split', key: `${at}/child/a`, class: 'free', rule: 'S3', parent: 470, child: { key: 'a', title: 'Part one', body: 'Do it', blockedBy: [], ready: true }, blockedBy: [] },
  ...AGENT_STEPS.map((step): Action => ({ ...base, kind: 'agent-step', key: `${at}/${step}/a1`, class: step === 'design' || step === 'build' ? 'develop' : 'drive', rule: 'S2', step, life: LIFE, seq: 3, attempt: 1, branch: 'issue-470', slot: SLOT, notes: ['--yes'] })),
  { ...base, kind: 'ci-rerun', key: `i470/l${LIFE}/rerun/r1/18342299123`, class: 'free', rule: 'S2', pr: 512, runId: '18342299123', round: 1 },
  { ...base, kind: 'queue-update', key: `i470/l${LIFE}/queue/update/9e01b77`, class: 'free', rule: 'Q1', pr: 512, base: '9e01b77', head: HEAD },
  { ...base, kind: 'queue-merge', key: `i470/l${LIFE}/queue/merge/abc1234`, class: 'free', rule: 'Q2', pr: 512, head: HEAD, patch: 'f00dfeed' },
  { ...base, kind: 'slot', key: `i470/l${LIFE}/lease/1`, class: 'free', rule: 'W1', op: 'lease', life: LIFE, path: null, lease: null, branch: null, marker: null, maxAttempts: 3 },
  { ...base, kind: 'slot', key: `${at}/prepare/a1`, class: 'free', rule: 'S2', op: 'prepare', life: LIFE, path: SLOT, lease: 'lease-2', branch: 'issue-470', marker: { v: 1, repo: REPO, issue: 470, life: LIFE, seq: 3, step: 'build', role: 'writer', branch: 'issue-470', gateCommands: ['npm test'], gateTimeoutMs: 600_000, loopDir: LOOP_DIR }, maxAttempts: 1 },
  { ...base, kind: 'slot', key: `${at}/kill`, class: 'free', rule: 'S3', op: 'kill', life: LIFE, path: SLOT, lease: 'lease-2', branch: null, marker: null, maxAttempts: 1 },
  { ...base, kind: 'slot', key: 'slot/lease-2/free', class: 'free', rule: 'W2', op: 'free', life: LIFE, path: SLOT, lease: 'lease-2', branch: null, marker: null, maxAttempts: 2 },
]

// v2Shape: the argv is one of v2's widened writes, exactly, for its own action's kind (appendix B):
// which bans it may pass, the others still applying.
const FACTORY = (l: string) => Object.values(FACTORY_LABELS).some(x => x.name === l)
function v2Shape(argv: readonly string[], action: Action | undefined): { labels?: boolean; body?: boolean; prEdit?: boolean; api?: boolean; rerun?: boolean; ready?: boolean } {
  const is = (...shape: (string | ((s: string) => boolean))[]) => shape.length === argv.length && shape.every((p, i) => (typeof p === 'string' ? p === argv[i] : p(argv[i] ?? '')))
  const num = (s: string) => /^[1-9]\d*$/.test(s)
  const text = (s: string) => s !== '' && !s.startsWith('-')
  switch (action?.kind) {
    case 'label':
      return is('gh', 'issue', 'edit', num, '--repo', REPO, '--add-label', FACTORY) ||
        is('gh', 'issue', 'edit', num, '--repo', REPO, '--add-label', FACTORY, '--remove-label', l => l.split(',').every(FACTORY)) ||
        is('gh', 'label', 'create', FACTORY, '--repo', REPO, '--color', c => /^[0-9a-f]{6}$/.test(c), '--description', text, '--force')
        ? { labels: true }
        : {}
    case 'comment':
      return is('gh', 'issue', 'comment', num, '--repo', REPO, '--body-file', '-') ? { body: true } : {}
    case 'pr':
      if (is('gh', 'pr', 'create', '--repo', REPO, '--base', text, '--head', text, '--title', text, '--body-file', '-')) return { body: true }
      return is('gh', 'pr', 'edit', num, '--repo', REPO, '--body-file', '-') ? { body: true, prEdit: true } : {}
    case 'split':
      if (is('gh', 'issue', 'create', '--repo', REPO, '--title', text, '--body-file', '-')) return { body: true }
      if (is('gh', 'issue', 'edit', num, '--repo', REPO, '--add-label', READY)) return { labels: true, ready: true }
      // the links, and the reads of the links already there (GET, ids only)
      return is('gh', 'api', '--method', 'POST', p => new RegExp(`^repos/${REPO}/issues/[1-9]\\d*/(sub_issues|dependencies/blocked_by)$`).test(p), '-F', f => /^(sub_issue_id|issue_id)=[1-9]\d*$/.test(f)) ||
        is('gh', 'api', p => new RegExp(`^repos/${REPO}/issues/[1-9]\\d*/(sub_issues|dependencies/blocked_by)$`).test(p), '--paginate', '--jq', '.[].id')
        ? { api: true }
        : {}
    case 'ci-rerun':
      return is('gh', 'run', 'rerun', num, '--failed', '--repo', REPO) ? { rerun: true } : {}
    default:
      return {}
  }
}

function world(): { state: State; ledger: LedgerEntry[] } {
  const own = entry('design:470:1', 'spawn', { agent: 'designer', status: 'running', endedAt: null, agentId: 'agent-own', startedAt: NOW - MIN })
  // agents whose answer is in (#548): one still at work, one ended
  const answered = entry('fixer:guard:471:h', 'spawn', { agent: 'fixer', issue: 471, status: 'done', agentId: 'agent-answered', startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN })
  const ended = entry('fixer:guard:472:h', 'spawn', { agent: 'fixer', issue: 472, status: 'done', agentId: 'agent-ended', startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN })
  const ledger = [own, answered, ended]
  const pool = { free: 10, total: 16, slots: [{ path: SLOT, branch: 'issue-470-x', state: 'leased', dirty: false, busy: false, lease: null, leasedAt: null, leaseBranch: 'issue-470-x' }] }
  const agents = [
    { id: 'agent-own', type: 'factory-loop:designer', status: 'running' as const },
    { id: 'agent-answered', type: 'callum-flow:fixer', status: 'waiting' as const },
    { id: 'agent-ended', type: 'callum-flow:fixer', status: 'completed' as const },
    // the model's own agent, at work: listed, but never the loop's
    { id: 'the-models-own-agent', type: 'general-purpose', status: 'running' as const },
  ]
  // the v2 records the pass planned from: the triage step reads its record's counts from them
  return { state: { ...state({ ledger, pool, agents }), v2: emptyV2State(NOW, [RECORD]) }, ledger }
}

// everything one action sends out: commands, events, spawns, prompts, stops, titles
async function run(action: Action, poolless = false, attempt = 1, planner: 'v1' | 'v2' = 'v1'): Promise<Recorded & { status: string; summary: string }> {
  const { io, seen } = recorder()
  const w = world()
  const s = poolless ? { ...w.state, pool: { free: 10, total: 16, slots: [] } } : w.state
  const env: ActEnv = { io, rt: runtime(planner), live: { ledger: w.ledger }, commands: [], wakeId: () => 'w1', session: 'session-1', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  const started = { ...start(w.ledger, action, NOW).entry, attempts: attempt }
  const exec = await dispatch(ctxOf(env, s, started), action)
  return { ...seen, status: exec.status, summary: exec.summary }
}

// --- the bans, one argv at a time -------------------------------------------------------------------

// envRetryLaunch: the one rerun allowed (#537): rule P2a's env-retry, launched detached with
// exactly ENV_RETRY_ARGV, `no-mistakes rerun` and no other argument, after the launch's fixed
// slot, branch and log.
function envRetryLaunch(argv: readonly string[], action: Action | undefined): boolean {
  if (action?.kind !== 'env-retry' || action.rule !== 'P2a') return false
  if (argv.length !== 9 || argv[0] !== 'sh' || argv[1] !== '-c' || argv[2] !== LAUNCH_SCRIPT) return false
  return ENV_RETRY_ARGV.length === 2 && argv[7] === 'no-mistakes' && argv[8] === 'rerun' && ENV_RETRY_ARGV.every((a, i) => argv[7 + i] === a)
}

// scriptGit: each git command in a shell script that is neither a read nor a fast-forward (of a
// worktree, #551, or of the main checkout, #555), the one git write a script may make, and that
// one only with the repo's hooks off (`-c core.hooksPath=/dev/null`: a post-merge npm install
// could outlast its timeout). An allowlist, so a new verb is banned until it is listed here; any
// option before the verb but `-C <path>`, and that one `-c` before a fast-forward, is unknown,
// so banned too.
const SCRIPT_GIT_READS = ['fetch', 'rev-parse', 'status', 'merge-base', 'symbolic-ref']
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null']
function scriptGit(script: string): string[] {
  const out: string[] = []
  for (const m of script.matchAll(/\bgit((?:[ \t]+[^\s;|&()]+){1,6})/g)) {
    const words = (m[1] ?? '').trim().split(/\s+/)
    let at = words[0] === '-C' ? 2 : 0
    const hooksOff = words[at] === HOOKS_OFF[0] && words[at + 1] === HOOKS_OFF[1]
    if (hooksOff) at += 2
    const [verb = '', next = ''] = words.slice(at)
    const read = SCRIPT_GIT_READS.includes(verb) || (verb === 'worktree' && next === 'list')
    const ok = hooksOff ? verb === 'merge' && next === '--ff-only' : read
    if (!ok) out.push(`a shell script that runs git ${words.slice(0, at + 2).join(' ')}`)
  }
  return out
}

function bans(argv: readonly string[], action?: Action): string[] {
  // the rerun's launch is held to every other ban, its two-word command left out
  if (envRetryLaunch(argv, action)) return bans(argv.slice(0, 7))
  const out: string[] = []
  const [cmd = '', ...args] = argv
  const v2 = v2Shape(argv, action)
  if (argv.some(a => a === '--yes' || a.startsWith('--yes='))) out.push('--yes')
  if (argv.some(a => (a === 'rerun' && v2.rerun !== true) || a === 'abort')) out.push('rerun/abort')
  if (cmd === 'no-mistakes' && !(args[0] === 'axi' && args[1] === 'respond')) out.push(`no-mistakes ${args.slice(0, 2).join(' ')}`)
  if (cmd === 'coder' || argv.includes('coder')) out.push('coder')
  if (cmd === 'pkill' || cmd === 'killall') out.push(cmd)
  if (cmd === 'kill' && args.some(a => !/^-?\d+$/.test(a))) out.push('kill by name')
  if (cmd === 'sh' && args[0] === '-c') {
    const script = args[1] ?? ''
    if (/\b(pkill|killall|coder)\b/.test(script)) out.push('a shell script with a broad kill or coder')
    if (/\bkill\b/.test(script) && script !== PROBE) out.push('a shell script that kills')
    if (/(^|\s)--yes\b|\brerun\b|\babort\b/.test(script)) out.push('a shell script with --yes, rerun or abort')
    out.push(...scriptGit(script))
  }
  if (cmd === 'gh') {
    if (args[0] === 'pr' && ((args[1] === 'edit' && v2.prEdit !== true) || args[1] === 'merge')) out.push(`gh pr ${args[1]}`)
    if (args.some(a => a.startsWith('--body')) && !(args[0] === 'pr' && args[1] === 'comment') && !(v2.body === true && args.includes('--body-file'))) out.push('--body outside a PR comment')
    if (args.includes('api') && v2.api !== true) out.push('gh api')
    if ((args[args.indexOf('--repo') + 1] !== REPO || !args.includes('--repo')) && v2.api !== true) out.push('gh without --repo <the repo>')
  }
  // reading the queue by its label is fine; adding one anywhere is not, but v2's own factory labels
  // and a split's ready child
  const adds = argv.flatMap((a, i) => (a === '--add-label' ? [argv[i + 1] ?? ''] : a.startsWith('--add-label=') ? [a.slice('--add-label='.length)] : []))
  const labelWrite = cmd === 'gh' && (args[1] === 'edit' || args[1] === 'create') && args.includes('--label')
  if ((adds.length > 0 || labelWrite || (cmd === 'gh' && args[0] === 'label')) && v2.labels !== true) out.push('a label added')
  if (adds.some(l => l.split(',').some(x => x.trim().toLowerCase() === READY)) && v2.ready !== true) out.push('the readyLabel')
  // git switches a leased slot to its branch, or reads: the origin, the main checkout's default
  // branch and status (#544), which never move it, and v2's direct read of a branch on origin, with
  // the fetch, count and ancestry a writer's answer is confirmed by (10.8), which move no branch
  const verb = args[0] === '--no-optional-locks' ? args[1] : args[0]
  const confirm = (verb === 'fetch' && args.join(' ') === 'fetch --quiet origin') || (verb === 'rev-list' && args[1] === '--count') || (verb === 'merge-base' && args[1] === '--is-ancestor')
  if (cmd === 'git' && !['switch', 'remote', 'symbolic-ref', 'status', 'ls-remote'].includes(verb ?? '') && !(confirm && action?.kind === 'agent-step')) out.push(`git ${verb}`)
  return out
}

// One sample argv of every builder of hooks/v2/argv.ts, with the kind of the action that runs it.
const V2_ARGVS: [Action['kind'], string[]][] = [
  ['label', ARGV.labelSetArgv(REPO, 470, 'factory:building', ['factory:queued', 'factory:designing', 'factory:reviewing', 'factory:fixing', 'factory:merge-queue', 'factory:parked'])],
  ['label', ARGV.labelSetArgv(REPO, 470, 'factory:queued', [])],
  ['label', ARGV.labelClearArgv(REPO, 470, ['factory:building', 'In development'])],
  ...Object.values(FACTORY_LABELS).map((l): [Action['kind'], string[]] => ['label', ARGV.labelCreateArgv(REPO, l)]),
  ['comment', ARGV.issueCommentArgv(REPO, 470)],
  ['comment', ARGV.prCommentArgv(REPO, 512)],
  ['comment', ARGV.commentsReadArgv('issue', 470)],
  ['comment', ARGV.commentsReadArgv('pr', 512)],
  ['claim', ARGV.openPrsArgv(REPO)],
  ['pr', ARGV.branchPrsArgv(REPO, 'issue-470')],
  ['pr', ARGV.prReopenArgv(REPO, 512)],
  ['pr', ARGV.prCreateArgv(REPO, 'main', 'issue-470', 'The work')],
  ['pr', ARGV.prBodyArgv(REPO, 512)],
  ['pr', ARGV.prReadArgv(512)],
  ['pr', ARGV.rolloutArgv(470)],
  ['split', ARGV.issueCreateArgv(REPO, 'Part one')],
  ['split', ARGV.subIssueArgv(REPO, 470, 3_100_200)],
  ['split', ARGV.blockedByArgv(REPO, 471, 3_100_201)],
  ['split', ARGV.childReadyArgv(REPO, 471, READY)],
  ['split', ARGV.openIssuesArgv()],
  ['split', ARGV.issueReadArgv(471)],
  ['split', ARGV.subIssuesReadArgv(REPO, 470)],
  ['split', ARGV.blockersReadArgv(REPO, 471)],
  ['ci-rerun', ARGV.prChecksArgv(REPO, 512)],
  ['ci-rerun', ARGV.runRerunArgv(REPO, '18342299123')],
  ['queue-update', ARGV.updateBranchArgv(REPO, 512)],
  ['queue-merge', ARGV.queueMergeArgv(512, 'f00dfeed')],
  ['queue-merge', ARGV.patchIdArgv('issue-470', 'origin/main')],
  ['agent-step', ARGV.lsRemoteArgv('issue-470')],
  ['agent-step', ARGV.fetchArgv()],
  ['agent-step', ARGV.beyondBaseArgv('main', 'abc1234')],
  ['agent-step', ARGV.isAncestorArgv('abc1234', 'def5678')],
  ['agent-step', ARGV.implementerRouteArgv(470)],
  ['claim', ARGV.claimArgv(470)],
  ['heartbeat', ARGV.heartbeatArgv([470, 471])],
  ['slot', ARGV.slotLeaseArgv(470, LIFE)],
  ['slot', ARGV.slotPrepareArgv(SLOT, 'lease-2', 'issue-470', '{"v":1}')],
  ['slot', ARGV.slotKillArgv(SLOT)],
  ['slot', ARGV.slotFreeArgv(SLOT, 'lease-2')],
]
const kindAction = (kind: Action['kind']): Action | undefined => [...V2_ACTIONS, ...ACTIONS].find(a => a.kind === kind)

describe('the v2 kinds and their argvs (v2 SPEC appendix B)', () => {
  test('every v2 kind runs under planner v2: an executor not built yet fails, never retried, before any command; one built stays inside the bans and spawns only its step\'s agent', async () => {
    for (const action of V2_ACTIONS) {
      const r = await run(action, false, 1, 'v2')
      const stub = r.status === 'failed' && /not built yet \(U\d+\)/.test(r.summary)
      expect({ key: action.key, ran: r.status !== 'failed' || stub }).toEqual({ key: action.key, ran: true })
      if (stub) expect({ key: action.key, argvs: r.argvs, spawns: r.spawns.length }).toEqual({ key: action.key, argvs: [], spawns: 0 })
      for (const argv of r.argvs) expect({ key: action.key, argv, bans: bans(argv, action) }).toEqual({ key: action.key, argv, bans: [] })
      for (const sp of r.spawns) expect(sp.subagentType).toBe(action.kind === 'agent-step' ? STEP_AGENT[action.step] : `no spawn from ${action.kind}`)
    }
  })

  test('every builder of argv.ts stays inside the bans for its own kind, and its widened writes are banned for any other', () => {
    for (const [kind, argv] of V2_ARGVS) {
      expect({ kind, argv, bans: bans(argv, kindAction(kind)) }).toEqual({ kind, argv, bans: [] })
      const widened = bans(argv).length > 0
      if (widened) expect({ kind, argv, banned: bans(argv, kindAction('transition')).length > 0 }).toEqual({ kind, argv, banned: true })
    }
    // exactly the shapes: another label, the ready label outside a split, a body inline, another
    // endpoint, a second argument, or no --failed is still banned
    const label = kindAction('label')
    const split = kindAction('split')
    const bad: [string[], Action | undefined][] = [
      [['gh', 'issue', 'edit', '470', '--repo', REPO, '--add-label', 'ready'], label],
      [['gh', 'issue', 'edit', '470', '--repo', REPO, '--add-label', 'factory:building', '--remove-label', 'ready'], label],
      [['gh', 'label', 'create', 'ready', '--repo', REPO, '--color', 'ffffff', '--description', 'x', '--force'], label],
      [['gh', 'label', 'delete', 'factory:queued', '--repo', REPO, '--yes'], label],
      [['gh', 'issue', 'comment', '470', '--repo', REPO, '--body', 'x'], kindAction('comment')],
      [['gh', 'pr', 'edit', '512', '--repo', REPO, '--body', 'x'], kindAction('pr')],
      [['gh', 'pr', 'edit', '512', '--repo', REPO, '--add-label', 'x'], kindAction('pr')],
      [['gh', 'pr', 'merge', '512', '--repo', REPO], kindAction('pr')],
      [['gh', 'api', '--method', 'DELETE', `repos/${REPO}/issues/470/sub_issues`, '-F', 'sub_issue_id=1'], split],
      [['gh', 'api', '--method', 'POST', 'repos/other/repo/issues/470/sub_issues', '-F', 'sub_issue_id=1'], split],
      [['gh', 'api', '--method', 'POST', `repos/${REPO}/issues/470/labels`, '-F', 'labels=ready'], split],
      [['gh', 'issue', 'edit', '471', '--repo', REPO, '--add-label', 'ready'], label],
      [['gh', 'run', 'rerun', '183', '--repo', REPO], kindAction('ci-rerun')],
      [['gh', 'run', 'rerun', '183', '--failed', '--repo', REPO], label],
      [['no-mistakes', 'rerun'], kindAction('ci-rerun')],
      [['gh', 'pr', 'create', '--repo', REPO, '--base', 'main', '--head', 'issue-470', '--title', 'x', '--body-file', '-', '--yes'], kindAction('pr')],
    ]
    for (const [argv, action] of bad) expect({ argv, kind: action?.kind, banned: bans(argv, action).length > 0 }).toEqual({ argv, kind: action?.kind, banned: true })
  })
})

describe('the argv safety net (SPEC 6.1)', () => {
  test('the bans catch every forbidden argv, and pass the loop\'s own forms', () => {
    const bad: string[][] = [
      ['no-mistakes', 'axi', 'respond', '--action', 'approve', '--yes'],
      ['no-mistakes', 'axi', 'respond', '--yes=true'],
      ['no-mistakes', 'rerun'],
      ['no-mistakes', 'axi', 'abort'],
      ['coder', 'restart', 'spike-reconcile-mod'],
      ['pkill', '-f', 'orchestrator-watch'],
      ['killall', 'node'],
      ['kill', '-9', 'claude'],
      ['sh', '-c', 'pkill -f watcher'],
      ['sh', '-c', 'kill "$1"', 'sh', '42'],
      ['gh', 'pr', 'edit', '512', '--repo', REPO, '--body', 'x'],
      ['gh', 'pr', 'merge', '512', '--repo', REPO],
      ['gh', 'issue', 'edit', '470', '--repo', REPO, '--add-label', 'ready'],
      ['gh', 'issue', 'edit', '470', '--repo', REPO, '--add-label=Ready'],
      ['gh', 'issue', 'close', '470'],
      ['gh', 'api', 'repos/x/pulls/1', '--repo', REPO],
      ['git', 'merge', 'main'],
      ['git', 'push', '--force'],
      ['git', 'checkout', 'main'],
      ['git', '--no-optional-locks', 'checkout', 'main'],
      ['sh', '-c', 'git -C "$1" merge "$2"', 'sh', '/w', 'main'],
      ['sh', '-c', 'git -C "$1" reset --hard "$2"', 'sh', '/w', 'abc1234'],
      ['sh', '-c', 'git push origin HEAD'],
      // a script's git is an allowlist: none of these discards work or writes history and passes
      ['sh', '-c', 'git -C "$p" switch --discard-changes x'],
      ['sh', '-c', 'git restore .'],
      ['sh', '-c', 'git branch -f x y'],
      ['sh', '-c', 'git update-ref refs/heads/x y'],
      ['sh', '-c', 'git worktree remove --force /w'],
      ['sh', '-c', 'git -c k=v reset --hard'],
      ['sh', '-c', 'git -c k=v merge --ff-only x'],
      // a fast-forward runs only with the repo's hooks off, and that option allows nothing else
      ['sh', '-c', 'git -C "$p" merge --ff-only x'],
      ['sh', '-c', 'git merge --ff-only --quiet x'],
      ['sh', '-c', 'git -c core.hooksPath=/dev/null reset --hard'],
      ['sh', '-c', 'git -C "$p" -c core.hooksPath=/dev/null merge x'],
      ['sh', '-c', 'git -c core.hooksPath=/tmp/h merge --ff-only x'],
      ['sh', '-c', 'st=$(git --git-dir=/w/.git status)'],
      ['sh', '-c', 'x=1; git -C "$p" merge --squash y'],
    ]
    for (const argv of bad) expect({ argv, banned: bans(argv).length > 0 }).toEqual({ argv, banned: true })
    expect(bans(['gh', 'issue', 'edit', '470', '--repo', REPO, '--add-label', 'ready'])).toContain('the readyLabel')
    const good: string[][] = [
      ['sh', '-c', PROBE, 'sh', '4242'],
      ['gh', 'pr', 'comment', '512', '--repo', REPO, '--body-file', '-'],
      ['gh', 'issue', 'edit', '470', '--repo', REPO, '--remove-label', 'in development'],
      [`${TOOLS}/queue-watch.sh`, '--once', '--repo', REPO, '--label', READY, '--known', 'none'],
      ['no-mistakes', 'axi', 'respond', '--action', 'fix', '--instructions=--yes is not an answer'],
      ['git', 'switch', 'issue-470-x'],
      ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      ['sh', '-c', 'git merge-base --is-ancestor "$1" "$2" && git -C "$3" -c core.hooksPath=/dev/null merge --ff-only --quiet "$2"', 'sh', 'a', 'b', '/w'],
      ['sh', '-c', LAUNCH_SCRIPT, 'factory-loop-respond', '/w', 'b', '/l'],
      ['sh', '-c', FF_SCRIPT, 'factory-loop-fast-forward', 'b', 'h', 'h'],
      ['sh', '-c', CHECKOUT_SCRIPT, 'factory-loop-update-checkout', 'main'],
    ]
    for (const argv of good) expect({ argv, bans: bans(argv) }).toEqual({ argv, bans: [] })
  })

  test('the actions under test cover every action kind, spawn purpose and respond shape', () => {
    expect(ACTION_KINDS.filter(kind => !ACTIONS.some(a => a.kind === kind) && !V2_ACTIONS.some(a => a.kind === kind))).toEqual([])
    expect(V2_ACTION_KINDS.filter(kind => !V2_ACTIONS.some(a => a.kind === kind))).toEqual([])
    expect(ACTION_KINDS.filter(kind => EXECUTORS[kind] === undefined)).toEqual([])
    const purposes = ACTIONS.flatMap(a => (a.kind === 'spawn' && a.agent !== 'designer' ? [`${a.agent}:${a.purpose}`] : []))
    expect(purposes.sort()).toEqual([...adjudicators.map(p => `adjudicator:${p}`), ...fixers.map(p => `fixer:${p}`)].sort())
  })

  test('no executor passes --yes, reruns, aborts, merges past the guard, edits a PR body, adds a label, runs coder or kills by name', async () => {
    const all: string[][] = []
    for (const action of ACTIONS) {
      for (const poolless of action.kind === 'respond' || action.kind === 'env-retry' ? [false, true] : [false]) {
        const r = await run(action, poolless)
        expect(r.status === 'failed' ? `${action.key}: ${r.summary}` : 'ran').toBe('ran')
        all.push(...r.argvs)
        for (const argv of r.argvs) expect({ key: action.key, argv, bans: bans(argv, action) }).toEqual({ key: action.key, argv, bans: [] })
        // only spawn and delegate start an agent, each exactly its agent's type (the loop's own
        // adjudicator and designer, the callum-flow implementer and fixer)
        const agent = action.kind === 'delegate' ? 'implementer' : action.kind === 'spawn' ? action.agent : null
        for (const s of r.spawns) expect(s.subagentType).toBe(agent === null ? `no spawn from ${action.kind}` : SUBAGENT_OF[agent])
      }
    }
    // the merge goes only through callum-flow-merge, which runs the guard inside it
    expect(all.filter(a => a.includes('merge') || a[0] === 'callum-flow-merge').map(a => a[0])).toEqual(['callum-flow-merge'])
    // no-mistakes runs only inside the detached launch: `axi respond`, or env-retry's rerun (its
    // slot found, then leased)
    const nm = all.filter(a => a.includes('no-mistakes'))
    expect(nm.every(a => a[0] === 'sh' && a[2] === LAUNCH_SCRIPT && (a.includes('respond') || a.slice(7).join(' ') === 'no-mistakes rerun'))).toBe(true)
    expect(nm.filter(a => a.includes('rerun')).length).toBe(2)
  })

  test("every file an executor writes is the loop's own, in its loop dir: spawn records, and only the answer script's job files in answers/, never an answer file (#561)", async () => {
    const writes: string[] = []
    for (const action of ACTIONS) writes.push(...(await run(action)).writes)
    const agents = ACTIONS.filter(a => a.kind === 'spawn' || a.kind === 'delegate')
    // one job file and one spawn record per agent the loop starts, on the default script channel
    expect(writes.filter(p => p.endsWith('.job.json'))).toHaveLength(agents.length)
    expect(writes.filter(p => p.startsWith(`${LOOP_DIR}/spawns/`))).toHaveLength(agents.length)
    for (const p of writes) {
      const own = p.startsWith(`${LOOP_DIR}/spawns/`) || (p.startsWith(`${LOOP_DIR}/answers/`) && p.endsWith('.job.json')) || p.startsWith(`${LOOP_DIR}/respond/`)
      expect({ path: p, own }).toEqual({ path: p, own: true })
      expect(p.split('/')).not.toContain('..')
    }
    // the answer script is named only from the plugin's own root, with this attempt's file
    for (const action of agents) {
      const prompt = (await run(action)).spawns[0]?.prompt ?? ''
      const named = [...prompt.matchAll(/(\S+\/bin\/factory-answer) --to (\S+)/g)]
      expect(named).toHaveLength(1)
      expect(named[0]?.[1]).toBe(`${PLUGIN_ROOT}/bin/factory-answer`)
      expect(named[0]?.[2]).toStartWith(`${LOOP_DIR}/answers/`)
    }
  })

  test('the loop\'s own events and the rails\' probes stay inside the bans; only signal 0 is sent', async () => {
    const own: string[][] = [eventArgv('loop', { note: 'kind=tell key=k status=running' }), capEventArgv('claim:470', NOW), capEventArgv('spawn', NOW)]
    for (const e of [entry('design:470:1', 'spawn', { agent: 'designer' }), entry('tell:x', 'tell', { wake: 'blind' })]) {
      const argv = loopEvent(e)
      if (argv !== null) own.push(argv)
    }
    // the rails, with an old watcher's lock in place, so every probe runs
    const seen: string[][] = []
    await checkRails(
      {
        cmd: async argv => {
          seen.push(argv)
          if (argv[0] === 'dev-query') return { exitCode: 0, stdout: QUIET_BEATS, stderr: '' }
          if (argv[0] === 'cat') return { exitCode: 0, stdout: 'sh\u0000orchestrator-watch.sh\u0000', stderr: '' }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
        readFile: async path => (path.endsWith('/pid') ? '4242\n' : null),
      },
      { repo: REPO, device: DEVICE, session: 's', loopDir: LOOP_DIR, config: runtime().config, env: {}, now: NOW, memory: EMPTY_RAIL_MEMORY },
    )
    expect(seen).toContainEqual(['sh', '-c', PROBE, 'sh', '4242'])
    // an act-mode observe pass: the one-shot watchers and the reads
    const io: Io = {
      now: async () => NOW,
      run: async argv => {
        seen.push([...argv])
        const out =
          argv[0] === 'callum-flow-factory-state'
            ? factoryDoc([])
            : argv[0] === 'dev-query'
              ? NO_EVENTS
              : argv[0] === `${TOOLS}/queue-watch.sh`
                ? 'queue known=none now=none\n'
                : ''
        return { exitCode: 0, stdout: out, stderr: '' }
      },
      readFile: async () => null,
      sessionLimits: async () => [],
      agents: async () => [],
    }
    await observe(io, runtime(), emptyCache(), NOW, null, { ledger: null, githubBackoffUntil: null, queueKnown: null })
    for (const argv of [...own, ...seen]) expect({ argv, bans: bans(argv) }).toEqual({ argv, bans: [] })
  })

  test('stop-agent stops only an agent the ledger holds running, or one whose answer is in that the list shows at work; any other is refused before TaskStop', async () => {
    const own = await run({ ...base, kind: 'stop-agent', key: 'stop:agent-own', class: 'free', rule: 'A1', agentId: 'agent-own', entry: 'design:470:1' })
    expect(own).toMatchObject({ status: 'done', stops: ['agent-own'] })
    const answered = await run({ ...base, kind: 'stop-agent', key: 'stop:agent-answered', class: 'free', rule: 'A1', agentId: 'agent-answered', entry: 'fixer:guard:471:h' })
    expect(answered).toMatchObject({ status: 'done', stops: ['agent-answered'] })
    for (const agentId of ['agent-stranger', 'the-models-own-agent', 'agent-ended']) {
      const other = await run({ ...base, kind: 'stop-agent', key: `stop:${agentId}`, class: 'free', rule: 'A2', agentId, entry: 'design:470:1' })
      expect(other).toMatchObject({ status: 'failed', stops: [], summary: `refused: agent ${agentId} is not a running agent of the loop` })
    }
  })

  test('the one rerun cannot widen: only env-retry of rule P2a, only `no-mistakes rerun`, once per resume (#537)', async () => {
    const envRetry = ACTIONS.find(a => a.kind === 'env-retry') as Action
    const launch = (tail: string[]) => ['sh', '-c', LAUNCH_SCRIPT, 'factory-loop-respond', SLOT, 'issue-470-x', respondLogPath(LOOP_DIR, envRetry.key, 1), ...tail]
    expect(bans(launch(['no-mistakes', 'rerun']), envRetry)).toEqual([])
    // any other action, rule, argument or form is banned
    const respondAction = ACTIONS.find(a => a.kind === 'respond') as Action
    const widened: [string[], Action][] = [
      [launch(['no-mistakes', 'rerun']), respondAction],
      [launch(['no-mistakes', 'rerun']), { ...envRetry, rule: 'P3' }],
      [launch(['no-mistakes', 'rerun', '--yes']), envRetry],
      [launch(['no-mistakes', 'rerun', '--intent', 'x']), envRetry],
      [launch(['no-mistakes', 'axi', 'abort']), envRetry],
      [launch(['no-mistakes', 'axi', 'respond', '--action', 'approve', '--yes']), envRetry],
      [['no-mistakes', 'rerun'], envRetry],
      [['sh', '-c', 'no-mistakes rerun'], envRetry],
      [['sh', '-c', `${LAUNCH_SCRIPT}\nno-mistakes rerun`, 'x', SLOT, 'issue-470-x', 'log', 'no-mistakes', 'rerun'], envRetry],
    ]
    for (const [argv, action] of widened) expect({ argv, rule: action.rule, banned: bans(argv, action).length > 0 }).toEqual({ argv, rule: action.rule, banned: true })
    // the executor runs exactly that launch, from the slot on the run's branch
    expect(await run(envRetry)).toMatchObject({ status: 'done', argvs: [launch(['no-mistakes', 'rerun'])] })
    // and refuses, before any command, another rule, a key that is no resume round, or a second attempt
    const refusals: [Action, number][] = [
      [{ ...envRetry, rule: 'P3' }, 1],
      [{ ...envRetry, key: `env-retry:${RUN}:test:${HEAD}` }, 1],
      [envRetry, 2],
    ]
    for (const [action, attempt] of refusals) {
      const r = await run(action, false, attempt)
      expect({ key: action.key, rule: action.rule, attempt, status: r.status, argvs: r.argvs }).toEqual({ key: action.key, rule: action.rule, attempt, status: 'failed', argvs: [] })
    }
  })

  test('a code failure is never rerun: plan plans env-retry only when every verdict of the resumed escalation is ENV (#537)', () => {
    const at = '01M4RQ0045AAAA:test:head45'
    const VERDICTS = ['ENV: codex 401', 'CORRECT: a real bug', 'WRONG: a false positive', 'NIT: style', 'DUP: seen before']
    // every subset of the five verdict kinds, the empty one included, with and without a resume note
    for (const withNote of [false, true]) for (let mask = 0; mask < 1 << VERDICTS.length; mask++) {
      const verdicts = VERDICTS.filter((_, i) => (mask & (1 << i)) !== 0)
      const s = state({
        issues: [mine(45, 'in pipeline', { delegatedBrief: brief(45), run: '01M4RQ0045AAAA', pr: 545 })],
        runs: [runOf(45, 'failed', { step: 'test' })],
        control: control({ resumed: [{ subject: 'run:01M4RQ0045AAAA', at: NOW - MIN }], notes: withNote ? [{ issue: 45, text: 'change it', at: NOW - 2 * MIN }] : [] }),
      })
      const adj = entry(`adjudicate:${at}`, 'spawn', { agent: 'adjudicator', class: 'drive', issue: 45, run: '01M4RQ0045AAAA', outcome: review({ type: 'escalate', why: 'x' }, null, verdicts) })
      const kinds = plan({ ...s, ledger: [...s.ledger, adj] }, config()).actions.map(a => a.kind)
      const envOnly = verdicts.length > 0 && verdicts.every(v => v.startsWith('ENV:'))
      expect({ verdicts, withNote, rerun: kinds.includes('env-retry') }).toEqual({ verdicts, withNote, rerun: envOnly && !withNote })
      expect({ verdicts, withNote, fixer: kinds.includes('spawn') }).toEqual({ verdicts, withNote, fixer: !(envOnly && !withNote) })
    }
  })

  test('restart-self runs only for rule H4 or v2\'s R2, and a pass of every action at once stays inside the bans', async () => {
    const wrong = await run({ ...base, issue: null, kind: 'restart-self', key: 'restart:8', class: 'free', rule: 'O1', why: 'x', at: 8 })
    expect(wrong).toMatchObject({ status: 'failed', argvs: [] })
    const r2 = await run({ ...base, issue: null, kind: 'restart-self', key: 'restart:9', class: 'free', rule: 'R2', why: 'x', at: 9 }, false, 1, 'v2')
    expect(r2).toMatchObject({ status: 'done', argvs: [['dev-restart-self']] })
    const { io, seen } = recorder()
    const w = world()
    const env: ActEnv = { io, rt: runtime(), live: { ledger: w.ledger }, commands: [], wakeId: () => 'w1', session: 'session-1', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
    await runActions(env, w.state, ACTIONS)
    // the pass's one env-retry may launch its rerun; every other argv stays inside the bans
    const envRetry = ACTIONS.find(a => a.kind === 'env-retry')
    for (const argv of seen.argvs) expect({ argv, bans: bans(argv, envRetry) }).toEqual({ argv, bans: [] })
  })
})
