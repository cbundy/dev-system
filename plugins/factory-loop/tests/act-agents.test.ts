// The agent executors (act-agents.ts) against a fake ExecCtx: what spawn and delegate hand
// $.agent.spawn, the delegate's order (route, `delegated` event, implementer), each failure
// before anything is logged, and onAgentAnswer per agent type with the events its outcome logs.
// Output lines and exit codes are the real CLIs': images/base/callum-flow-implementer-route
// prints one model alias (exit 0, warnings on stderr; exit 2 on a usage error), and
// callum-flow-event exits non-zero only on a usage error (exit 2).
import { describe, expect, test } from 'claude-code/testing'

import {
  ROUTE_TIMEOUT_MS,
  agentExecutors,
  agentOf,
  inFlightOf,
  interim,
  jobOf,
  modelLabelOf,
  onAgentAnswer,
  parseRecord,
  purposeOfKey,
  readAnswer,
  readScriptAnswer,
  routedModel,
  SCRIPT_RECORD,
  SUBAGENT_OF,
  scriptPlaceOf,
  spawnInputOf,
  spawnRecordPath,
  stillAtWork,
} from '../hooks/act-agents'
import { TOOL_OF } from '../hooks/agent-tools'
import { answerText, jobPathOf, jobText } from '../hooks/contract.mjs'
import type { Job } from '../hooks/contract.mjs'
import { answerPath, scriptAnswerPath } from '../hooks/exec'
import type { ActIo, AgentAnswer, EventFields, Exec, ExecCtx, Executor, RunInit, RunResult, SpawnInput } from '../hooks/exec'
import type { Runtime } from '../hooks/observe'
import type { Action, ActionKind, Config, LedgerEntry, State } from '../hooks/types'
import { DEVICE, NOW, PLUGIN_ROOT, config, entry, issue, run, state } from './fixtures'

const REPO = 'cbundy/dev-system'
const LOOP = '/cfg/factory-loop/cbundy__dev-system'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-3301234567'
const RUN = '01K7RRXQ7M2YB9ZB3J8N0V5F6D'
const BRANCH = 'feat/issue-470-agents'

type Reply = Partial<RunResult> | Error
type SpawnReply = { agentId?: string; deny?: string } | Error

function runtime(over: Partial<Config> = {}): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/workspaces/dev-system',
    loopDir: LOOP,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: '/usr/local/share/callum-tools',
    pluginRoot: PLUGIN_ROOT,
    config: config(over),
    configProblems: [],
  }
}

type Over = {
  replies?: Reply[]
  spawn?: SpawnReply
  event?: (state: string, fields: EventFields) => Promise<void>
  writeFails?: boolean
  files?: Record<string, string>
  state?: Partial<State>
  entry?: LedgerEntry
  config?: Partial<Config>
}

// harness: a fake ExecCtx. Commands answer from `replies` in order (a missing reply is a quiet
// exit 0), the spawn answers `spawn`; every command, event, spawn and file write goes into one
// ordered log, so the tests can check what ran and in which order.
function harness(over: Over = {}) {
  const log: string[] = []
  const calls: { argv: string[]; init: RunInit }[] = []
  const events: { state: string; fields: EventFields }[] = []
  const spawns: SpawnInput[] = []
  const files = new Map<string, string>(Object.entries(over.files ?? {}))
  let next = 0
  const io: ActIo = {
    now: async () => NOW,
    run: async () => {
      throw new Error('executors run commands through ctx.cmd')
    },
    spawnAgent: async input => {
      log.push(`spawn ${input.subagentType}`)
      spawns.push(input)
      const reply = over.spawn ?? { agentId: 'agent-1' }
      if (reply instanceof Error) throw reply
      return reply
    },
    stopAgent: async () => ({ stopped: false, error: 'not in this test' }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: null, sevenDay: null }),
    readFile: async path => files.get(path) ?? null,
    writeFile: async (path, text) => {
      if (over.writeFails) throw new Error('EROFS: read-only file system')
      log.push(`write ${path}`)
      files.set(path, text)
    },
  }
  const ctx: ExecCtx = {
    io,
    rt: runtime(over.config),
    state: state(over.state ?? {}),
    entry: over.entry ?? entry('under-test', 'spawn', { status: 'running', endedAt: null }),
    cmd: async (argv, init) => {
      log.push(`cmd ${argv.join(' ')}`)
      calls.push({ argv, init })
      const reply = over.replies?.[next++] ?? {}
      if (reply instanceof Error) throw reply
      return { exitCode: 0, stdout: '', stderr: '', ...reply }
    },
    event: async (s, fields) => {
      log.push(`event ${s}`)
      events.push({ state: s, fields })
      if (over.event !== undefined) await over.event(s, fields)
    },
    wakeId: () => 'w1',
  }
  return { ctx, log, calls, events, spawns, files }
}

function executor(kind: ActionKind): Executor {
  const exec = agentExecutors[kind]
  if (exec === undefined) throw new Error(`no executor for ${kind}`)
  return exec
}

async function exec(action: Action, over: Over = {}) {
  const h = harness(over)
  const result = await executor(action.kind)(h.ctx, action)
  return { result, ...h }
}

// --- the actions, as plan emits them -----------------------------------------------------------

const base = { reason: 'test' }
const A = {
  designer: (model: string | null = 'opus'): Action => ({
    ...base,
    kind: 'spawn',
    agent: 'designer',
    key: 'design:470:1000',
    class: 'develop',
    rule: 'D2',
    issue: 470,
    model,
    notes: ['Prefer the smaller change.'],
  }),
  adjudicator: (purpose: 'gate' | 'weakening' | 'merge' = 'gate'): Action => ({
    ...base,
    kind: 'spawn',
    agent: 'adjudicator',
    purpose,
    key: purpose === 'gate' ? `adjudicate:${RUN}:review:3f2a9c1d` : `adjudicate-${purpose}:512:3f2a9c1d`,
    class: 'drive',
    rule: purpose === 'gate' ? 'P2' : purpose === 'merge' ? 'M4' : 'M3',
    issue: 470,
    run: RUN,
    branch: BRANCH,
    step: purpose === 'gate' ? 'review' : null,
    head: '3f2a9c1d',
    pr: 512,
    brief: BRIEF,
    model: null,
    warns: [],
    handoffHead: null,
    verdicts: [],
    guard: [],
  }),
  fixer: (branch = BRANCH): Action => ({
    ...base,
    kind: 'spawn',
    agent: 'fixer',
    purpose: 'conflict',
    key: 'fixer:conflict:512:3f2a9c1d',
    class: 'drive',
    rule: 'M2',
    issue: 470,
    run: RUN,
    branch,
    head: '3f2a9c1d',
    pr: 512,
    brief: BRIEF,
    model: 'opus',
    instructions: 'conflicts with main. Keep both sides of colliding additions.',
  }),
  delegate: (brief = BRIEF): Action => ({ ...base, kind: 'delegate', key: `delegate:470:${brief}`, class: 'develop', rule: 'D4', issue: 470, brief }),
}

// --- pure helpers ------------------------------------------------------------------------------

describe('the pure helpers', () => {
  test('routedModel: exactly one alias line, else null', () => {
    expect(routedModel('sonnet\n')).toBe('sonnet')
    expect(routedModel('\nclaude-opus-5-5\n\n')).toBe('claude-opus-5-5')
    expect(routedModel('')).toBeNull()
    expect(routedModel('sonnet\nopus\n')).toBeNull()
    expect(routedModel('model: opus\n')).toBeNull()
  })

  test('purposeOfKey: plan key families', () => {
    expect(purposeOfKey(`adjudicate:${RUN}:review:3f2a9c1d`)).toBe('gate')
    expect(purposeOfKey(`adjudicate:${RUN}:review:3f2a9c1d:r1`)).toBe('gate')
    expect(purposeOfKey('adjudicate-weakening:512:3f2a9c1d')).toBe('weakening')
    expect(purposeOfKey('adjudicate-merge:512:3f2a9c1d:r2')).toBe('merge')
    expect(purposeOfKey('fixer:gate:x')).toBeNull()
  })

  test('agentOf: the spawn type; a delegate runs the implementer', () => {
    expect(agentOf(entry('k', 'spawn', { agent: 'fixer' }))).toBe('fixer')
    expect(agentOf(entry('k', 'delegate'))).toBe('implementer')
    expect(agentOf(entry('k', 'spawn'))).toBeNull()
    expect(agentOf(entry('k', 'guard'))).toBeNull()
  })

  test('modelLabelOf: the first model: label in sorted order, lower-cased', () => {
    const s = state({ issues: [issue(470, { labels: ['enhancement', 'model:Sonnet', 'model:opus'] }), issue(471)] })
    expect(modelLabelOf(s, 470)).toBe('opus')
    expect(modelLabelOf(s, 471)).toBeNull()
    expect(modelLabelOf(s, 999)).toBeNull()
  })

  test('inFlightOf: the other issues current branches, superseded runs left out', () => {
    const s = state({ runs: [run(12, 'running'), run(470, 'parked'), run(13, 'parked', { superseded: true })] })
    expect(inFlightOf(s, 470)).toEqual([{ branch: 'feat/issue-12-work', issue: 12 }])
  })

  test('spawnInputOf: the agent type, the issue in description and name, the model only when known', () => {
    const opts = { repo: REPO, attempt: 1, modelOverride: null, inFlight: [] }
    const designer = spawnInputOf(A.designer() as Extract<Action, { kind: 'spawn' }>, { ...opts, model: 'opus' })
    expect(designer.subagentType).toBe('factory-loop:designer')
    expect(designer.description).toBe('Design #470')
    expect(designer.name).toBe('designer-470')
    expect(designer.model).toBe('opus')
    const plain = spawnInputOf(A.designer(null) as Extract<Action, { kind: 'spawn' }>, { ...opts, model: null })
    expect('model' in plain).toBe(false)
    const unsafe = spawnInputOf(A.designer() as Extract<Action, { kind: 'spawn' }>, { ...opts, model: 'opus --yes' })
    expect('model' in unsafe).toBe(false)
  })

  test('every agent is spawned as a type that reaches its answer tool: the loop owns the adjudicator and designer, whose callum-flow tools lists leave it out (#548)', () => {
    // tests/factory-loop-agents.test.js checks each type's definition lists ToolSearch and TOOL_OF,
    // or lists no tools at all
    expect(SUBAGENT_OF).toEqual({
      adjudicator: 'factory-loop:adjudicator',
      designer: 'factory-loop:designer',
      implementer: 'callum-flow:implementer',
      fixer: 'callum-flow:fixer',
    })
    expect(Object.keys(TOOL_OF).sort()).toEqual(Object.keys(SUBAGENT_OF).sort())
    const opts = { repo: REPO, attempt: 1, model: null, modelOverride: null, inFlight: [] }
    const types = [A.designer(), A.adjudicator('gate'), A.adjudicator('merge'), A.fixer(), A.delegate()].map(a => spawnInputOf(a as Parameters<typeof spawnInputOf>[0], opts).subagentType)
    expect(types).toEqual(['factory-loop:designer', 'factory-loop:adjudicator', 'factory-loop:adjudicator', 'callum-flow:fixer', 'callum-flow:implementer'])
  })

  test('parseRecord: the branch, purpose and answer channel a spawn record holds; a record from before the channel names none', () => {
    expect(parseRecord(JSON.stringify({ branch: BRANCH, purpose: 'merge', channel: 'script' }))).toEqual({ branch: BRANCH, purpose: 'merge', channel: 'script' })
    expect(parseRecord(JSON.stringify({ branch: BRANCH, purpose: 'merge' }))).toEqual({ branch: BRANCH, purpose: 'merge', channel: null })
    expect(parseRecord(JSON.stringify({ branch: '', purpose: 'other', channel: 'answerTools' }))).toEqual({ branch: null, purpose: null, channel: null })
    expect(parseRecord('not json')).toBeNull()
    expect(parseRecord(null)).toBeNull()
  })

  test('interim: an answer with no machine line; a failed turn or a loop bug never is (#545)', () => {
    const said = { agentId: 'agent-1', answer: 'still exploring', reason: 'answer' as const }
    expect(interim(said, { status: 'done', outcome: { kind: 'designer', unparsed: true }, summary: '' })).toBe(true)
    expect(interim(said, { status: 'failed', summary: 'the handoff has no RESULT line' })).toBe(true)
    expect(interim(said, { status: 'done', outcome: { kind: 'designer', brief: null, created: [], pendingDecision: false }, summary: '' })).toBe(false)
    expect(interim(said, { status: 'failed', summary: 'names no adjudicator purpose', noRetry: true })).toBe(false)
    expect(interim({ ...said, reason: 'error' }, { status: 'failed', summary: 'its turn ended: error' })).toBe(false)
  })

  test('stillAtWork: holding background work, or a sub-agent of its own at work; its own running is no proof (#545)', () => {
    expect(stillAtWork([{ id: 'a', status: 'waiting' }], 'a')).toBe(true)
    expect(stillAtWork([{ id: 'a', status: 'running' }, { id: 'x', status: 'running', parentId: 'a' }], 'a')).toBe(true)
    expect(stillAtWork([{ id: 'a', status: 'running' }, { id: 'x', status: 'pending', parentId: 'a' }], 'a')).toBe(true)
    expect(stillAtWork([{ id: 'a', status: 'running' }], 'a')).toBe(false)
    expect(stillAtWork([{ id: 'a', status: 'running' }, { id: 'x', status: 'completed', parentId: 'a' }, { id: 'y', status: 'idle', parentId: 'a' }], 'a')).toBe(false)
    // another agent's waiting or child says nothing of this one
    expect(stillAtWork([{ id: 'b', status: 'waiting' }, { id: 'x', status: 'running', parentId: 'b' }], 'a')).toBe(false)
    expect(stillAtWork([], 'a')).toBe(false)
  })
})

// --- spawn ---------------------------------------------------------------------------------------

describe('spawn (SPEC 6.1)', () => {
  test('the designer: its agent, the issue model label, the branches in flight; running with its agent id', async () => {
    const { result, spawns, files, log } = await exec(A.designer(), { state: { runs: [run(12, 'running'), run(470, 'parked')] } })
    expect(result).toEqual({ status: 'running', agentId: 'agent-1', summary: 'factory-loop:designer (opus) started for #470: agent-1' })
    expect(spawns).toHaveLength(1)
    const input = spawns[0] as SpawnInput
    expect(input.subagentType).toBe('factory-loop:designer')
    expect(input.model).toBe('opus')
    expect(input.description).toBe('Design #470')
    expect(input.name).toBe('designer-470')
    expect(input.prompt).toContain('feat/issue-12-work, for issue 12')
    expect(input.prompt).not.toContain('feat/issue-470-work')
    expect(input.prompt).toContain('Model override: opus')
    // the answer script's job file and the spawn record go first, so the answer can never arrive
    // before them
    const path = spawnRecordPath(LOOP, 'design:470:1000')
    const place = scriptPlaceOf({ pluginRoot: PLUGIN_ROOT, loopDir: LOOP }, entry('under-test', 'spawn', { status: 'running', endedAt: null }))
    expect(log).toEqual([`write ${jobPathOf(place.file)}`, `write ${path}`, 'spawn factory-loop:designer'])
    expect(JSON.parse(files.get(path) ?? '{}')).toMatchObject({ key: 'design:470:1000', agent: 'designer', purpose: null, branch: null, issue: 470, channel: 'script', answerFile: place.file, prompt: input.prompt })
  })

  // the actions under test, the tool each answers with, and the job its answer is checked against
  const answering = (): [Action, string, Job][] => [
    [A.designer(), TOOL_OF.designer, { contract: 'design', purpose: null, repo: REPO, issue: 470, branch: null }],
    [A.adjudicator('gate'), TOOL_OF.adjudicator, { contract: 'verdict', purpose: 'gate', repo: REPO, issue: 470, branch: null }],
    [A.adjudicator('weakening'), TOOL_OF.adjudicator, { contract: 'verdict', purpose: 'weakening', repo: REPO, issue: 470, branch: null }],
    [A.adjudicator('merge'), TOOL_OF.adjudicator, { contract: 'verdict', purpose: 'merge', repo: REPO, issue: 470, branch: null }],
    [A.fixer(), TOOL_OF.fixer, { contract: 'handoff', purpose: null, repo: REPO, issue: 470, branch: BRANCH }],
    [A.delegate(), TOOL_OF.implementer, { contract: 'handoff', purpose: null, repo: REPO, issue: 470, branch: null }],
  ]

  test('the script channel (the default, #561): each spawn writes the job its answer is checked against beside an answer file unique to its attempt, and its prompt names the script and that file', async () => {
    for (const [action, tool, job] of answering()) {
      const replies = action.kind === 'delegate' ? [{ stdout: 'opus\n' }] : []
      const attempt = entry(action.key, action.kind, { status: 'running', endedAt: null, attempts: 2, startedAt: NOW + 7 })
      const r = await exec(action, { replies, entry: attempt })
      const place = scriptPlaceOf({ pluginRoot: PLUGIN_ROOT, loopDir: LOOP }, attempt)
      expect(place).toEqual({ bin: `${PLUGIN_ROOT}/bin/factory-answer`, file: scriptAnswerPath(LOOP, attempt) })
      expect(place.file).toEndWith(`.a2.${NOW + 7}.answer.json`)
      expect(r.files.get(jobPathOf(place.file) ?? '')).toBe(jobText(job))
      const prompt = r.spawns[0]?.prompt ?? ''
      expect(prompt).toContain(`\n${place.bin} --to ${place.file} <<'JSON'\n`)
      expect(prompt).not.toContain(tool)
      expect(JSON.parse(r.files.get(spawnRecordPath(LOOP, action.key)) ?? '{}')).toMatchObject({ channel: 'script', answerFile: place.file, attempt: 2 })
    }
  })

  test('the tool and text channels write no job file: the tool channel asks for the agent\'s tool first, the text channel for its machine line alone (#548, #560)', async () => {
    for (const [action, tool] of answering()) {
      const replies = action.kind === 'delegate' ? [{ stdout: 'opus\n' }] : []
      const tools = await exec(action, { replies, config: { answerChannel: 'tool' } })
      expect(tools.spawns[0]?.prompt).toContain(`calling ${tool}`)
      expect(tools.spawns[0]?.prompt).not.toContain('answer script')
      const text = await exec(action, { replies, config: { answerChannel: 'text' } })
      expect(text.spawns[0]?.prompt).not.toMatch(/mcp__factory-loop__|ToolSearch|answer script|factory-answer/)
      for (const [r, channel] of [[tools, 'tool'], [text, 'text']] as const) {
        expect([...r.files.keys()].filter(p => p.endsWith('.job.json'))).toEqual([])
        expect(JSON.parse(r.files.get(spawnRecordPath(LOOP, action.key)) ?? '{}')).toMatchObject({ channel, answerFile: null })
      }
    }
  })

  test('on the script channel, a job file that cannot be written, or a plugin root a prompt may not carry, asks for text instead', async () => {
    const failing = await exec(A.adjudicator('gate'), { writeFails: true })
    expect(failing.result.status).toBe('running')
    expect(failing.spawns[0]?.prompt).not.toMatch(/answer script|factory-answer/)
    expect((failing.spawns[0]?.prompt ?? '').split('\n').pop()).toBe('Reply in your output contract and nothing else: verdict lines, then exactly one ACTION line.')
    const h = harness()
    h.ctx.rt = { ...h.ctx.rt, pluginRoot: '/home/some one/plugins/factory-loop' }
    await executor('spawn')(h.ctx, A.adjudicator('gate'))
    expect(h.spawns[0]?.prompt).not.toMatch(/answer script|factory-answer/)
    expect([...h.files.keys()].filter(p => p.endsWith('.job.json'))).toEqual([])
    expect(JSON.parse(h.files.get(spawnRecordPath(LOOP, A.adjudicator('gate').key)) ?? '{}')).toMatchObject({ channel: 'text', answerFile: null })
  })

  test('an adjudicator and a fixer: the record keeps the branch and the purpose the answer needs', async () => {
    const adj = await exec(A.adjudicator('merge'))
    expect(adj.spawns[0]?.subagentType).toBe('factory-loop:adjudicator')
    expect('model' in (adj.spawns[0] ?? {})).toBe(false)
    expect(adj.spawns[0]?.name).toBe('adjudicator-470-merge')
    expect(JSON.parse(adj.files.get(spawnRecordPath(LOOP, 'adjudicate-merge:512:3f2a9c1d')) ?? '{}')).toMatchObject({ purpose: 'merge', branch: BRANCH, run: RUN })
    const fix = await exec(A.fixer(), { entry: entry('fixer:conflict:512:3f2a9c1d', 'spawn', { status: 'running', endedAt: null, attempts: 2 }) })
    expect(fix.spawns[0]?.subagentType).toBe('callum-flow:fixer')
    expect(fix.spawns[0]?.model).toBe('opus')
    expect(fix.spawns[0]?.name).toBe('fixer-470-conflict-2')
    expect(JSON.parse(fix.files.get(spawnRecordPath(LOOP, 'fixer:conflict:512:3f2a9c1d')) ?? '{}')).toMatchObject({ purpose: null, branch: BRANCH, attempt: 2 })
  })

  test('a fixer sent with no branch records none', async () => {
    const { files } = await exec(A.fixer(''))
    expect(JSON.parse(files.get(spawnRecordPath(LOOP, 'fixer:conflict:512:3f2a9c1d')) ?? '{}').branch).toBeNull()
  })

  test('a deny, a throw and a start with no agent id are failed attempts', async () => {
    const denied = await exec(A.designer(), { spawn: { deny: 'agent type factory-loop:designer not found' } })
    expect(denied.result).toEqual({ status: 'failed', summary: 'factory-loop:designer denied: agent type factory-loop:designer not found' })
    const threw = await exec(A.designer(), { spawn: new Error('session not bound') })
    expect(threw.result).toEqual({ status: 'failed', summary: 'factory-loop:designer: the spawn threw: session not bound' })
    const noId = await exec(A.designer(), { spawn: {} })
    expect(noId.result.status).toBe('failed')
  })

  test('a record that cannot be written does not stop the spawn', async () => {
    const { result } = await exec(A.designer(), { writeFails: true })
    expect(result).toEqual({ status: 'running', agentId: 'agent-1', summary: 'factory-loop:designer (opus) started for #470: agent-1; spawn record not saved' })
  })

  test('refused: another kind, or a spawn with no issue', async () => {
    const wrong = await executor('spawn')(harness().ctx, A.delegate())
    expect(wrong).toEqual({ status: 'failed', summary: 'refused: the spawn executor got a delegate action', noRetry: true })
    const noIssue = await exec({ ...A.designer(), issue: null } as Action)
    expect(noIssue.result).toMatchObject({ status: 'failed', noRetry: true })
    expect(noIssue.spawns).toHaveLength(0)
  })
})

// --- delegate ------------------------------------------------------------------------------------

describe('delegate (SPEC 6.1, I-32)', () => {
  test('route, then the delegated event, then the implementer on the routed model', async () => {
    const { result, log, calls, events, spawns } = await exec(A.delegate(), {
      replies: [{ stdout: 'opus\n', stderr: '' }],
      state: { issues: [issue(470, { labels: ['model:opus'] })] },
    })
    const place = scriptPlaceOf({ pluginRoot: PLUGIN_ROOT, loopDir: LOOP }, entry('under-test', 'spawn', { status: 'running', endedAt: null }))
    expect(log).toEqual([
      'cmd callum-flow-implementer-route 470',
      'event delegated',
      `write ${jobPathOf(place.file)}`,
      `write ${spawnRecordPath(LOOP, `delegate:470:${BRIEF}`)}`,
      'spawn callum-flow:implementer',
    ])
    expect(calls[0]?.init).toEqual({ timeoutMs: ROUTE_TIMEOUT_MS })
    expect(events).toEqual([{ state: 'delegated', fields: { issue: 470, note: `brief ${BRIEF}` } }])
    const input = spawns[0] as SpawnInput
    expect(input.model).toBe('opus')
    expect(input.description).toBe('Implement #470')
    expect(input.name).toBe('implementer-470')
    expect(input.prompt).toContain(`Brief: ${BRIEF}.`)
    expect(input.prompt).toContain('Model override: opus')
    expect(result).toEqual({ status: 'running', agentId: 'agent-1', summary: 'callum-flow:implementer (opus) started for #470: agent-1' })
  })

  test('a hashed or default route is no model override for the implementer to pass on', async () => {
    const { spawns } = await exec(A.delegate(), { replies: [{ stdout: 'sonnet\n', stderr: 'callum-flow-implementer-route: warning: cannot read the labels of #470; routing to sonnet\n' }] })
    expect(spawns[0]?.model).toBe('sonnet')
    expect(spawns[0]?.prompt).not.toContain('Model override')
  })

  test('a route failure is failed before anything is logged or spawned', async () => {
    const usage = await exec(A.delegate(), {
      replies: [{ exitCode: 2, stderr: "callum-flow-implementer-route: issue must be a number, got 'x'\nusage: callum-flow-implementer-route <issue>\n" }],
    })
    expect(usage.result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 2, detail: "callum-flow-implementer-route: issue must be a number, got 'x'\nusage: callum-flow-implementer-route <issue>" },
      summary: 'callum-flow-implementer-route: exit 2: usage: callum-flow-implementer-route <issue>',
      noRetry: true,
    })
    expect(usage.events).toHaveLength(0)
    expect(usage.spawns).toHaveLength(0)

    const limited = await exec(A.delegate(), { replies: [{ exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)' }] })
    expect(limited.result).toMatchObject({ status: 'failed', rateLimited: true })
    expect(limited.result).not.toHaveProperty('noRetry')

    const garbled = await exec(A.delegate(), { replies: [{ stdout: 'sonnet\nopus\n' }] })
    expect(garbled.result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 0 } })
    expect(garbled.events).toHaveLength(0)
    expect(garbled.spawns).toHaveLength(0)

    const threw = await exec(A.delegate(), { replies: [new Error('timed out after 60000 ms')] })
    expect(threw.result).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: -1, detail: 'timed out after 60000 ms' } })
    expect(threw.spawns).toHaveLength(0)
  })

  test('a failed delegated event stops it before the spawn; a usage error is never retried', async () => {
    const usageError = Object.assign(new Error('callum-flow-event: unknown state'), { exitCode: 2 })
    const { result, spawns } = await exec(A.delegate(), {
      replies: [{ stdout: 'sonnet\n' }],
      event: async () => {
        throw usageError
      },
    })
    expect(result).toEqual({
      status: 'failed',
      outcome: { kind: 'cli', exit: 2, detail: 'callum-flow-event: unknown state' },
      summary: 'event delegated: callum-flow-event: unknown state',
      noRetry: true,
    })
    expect(spawns).toHaveLength(0)
  })

  test('a deny after the event is a failed attempt (the retry logs delegated again)', async () => {
    const { result, events } = await exec(A.delegate(), { replies: [{ stdout: 'sonnet\n' }], spawn: { deny: 'no' } })
    expect(result).toEqual({ status: 'failed', summary: 'callum-flow:implementer denied: no' })
    expect(events).toHaveLength(1)
  })

  test('a brief that is not a comment URL on the repo is refused before any command (I-33)', async () => {
    for (const brief of ['## Design brief\n## Acceptance criteria', 'https://github.com/evil/repo/issues/470#issuecomment-1']) {
      const { result, calls, events, spawns } = await exec(A.delegate(brief))
      expect(result).toMatchObject({ status: 'failed', noRetry: true })
      expect(calls).toHaveLength(0)
      expect(events).toHaveLength(0)
      expect(spawns).toHaveLength(0)
    }
  })

  test('no argv or spawn input carries a forbidden flag or command (SPEC 6.1)', async () => {
    const { calls, spawns } = await exec(A.delegate(), { replies: [{ stdout: 'sonnet\n' }] })
    for (const c of calls) expect(c.argv.join(' ')).not.toMatch(/--yes|\brerun\b|\babort\b|\bcoder\b|\bp?kill(all)?\b|pr edit|--add-label/)
    for (const s of spawns) expect(Object.values(SUBAGENT_OF)).toContain(s.subagentType)
  })
})

// --- onAgentAnswer -------------------------------------------------------------------------------

const answer = (text: string, reason: AgentAnswer['reason'] = 'answer'): AgentAnswer => ({ agentId: 'agent-1', answer: text, reason })

function running(key: string, kind: 'spawn' | 'delegate', agent: LedgerEntry['agent'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(key, kind, { agent, status: 'running', endedAt: null, agentId: 'agent-1', issue: 470, ...over })
}

async function answered(e: LedgerEntry, text: string, over: Over & { reason?: AgentAnswer['reason'] } = {}) {
  const h = harness({ ...over, entry: e })
  const { exec: result, problem } = await onAgentAnswer(h.ctx, e, answer(text, over.reason))
  return { result, problem, ...h }
}

describe('onAgentAnswer', () => {
  const designer = running('design:470:1000', 'spawn', 'designer')
  const gate = running(`adjudicate:${RUN}:review:3f2a9c1d`, 'spawn', 'adjudicator', { run: RUN, head: '3f2a9c1d' })
  const fixer = running('fixer:conflict:512:3f2a9c1d', 'spawn', 'fixer', { run: RUN, pr: 512, head: '3f2a9c1d' })
  const implementer = running(`delegate:470:${BRIEF}`, 'delegate', 'implementer')
  const record = (key: string, branch: string | null, purpose: string | null = null) => ({ [spawnRecordPath(LOOP, key)]: JSON.stringify({ branch, purpose }) })

  test('every answer is saved whole first, at answerPath', async () => {
    const text = `Summary.\nRESULT brief=${BRIEF} created=none pending_decision=no`
    const { files, log } = await answered(designer, text)
    expect(log[0]).toBe(`write ${answerPath(LOOP, 'design:470:1000')}`)
    expect(files.get(answerPath(LOOP, 'design:470:1000'))).toBe(text)
  })

  test('the designer: parsed, or unparsed for judge(report); no events', async () => {
    const parsed = await answered(designer, `Summary.\nRESULT brief=${BRIEF} created=481,482 pending_decision=no`)
    expect(parsed.result).toEqual({
      status: 'done',
      outcome: { kind: 'designer', brief: BRIEF, created: [481, 482], pendingDecision: false },
      summary: `designer #470: brief ${BRIEF}, created 481,482, pending decision no`,
    })
    expect(parsed.events).toHaveLength(0)
    const prose = await answered(designer, `Brief: ${BRIEF}\nNo owner decision.`)
    expect(prose.result).toEqual({ status: 'done', outcome: { kind: 'designer', unparsed: true }, summary: 'designer #470: no RESULT line; the report is saved for judge(report)' })
  })

  test('an adjudicator: each verdict line logged as a verdict event with the branch the spawn named', async () => {
    const reply = 'CORRECT: review-1 moved HEAD after recovery must not be accepted.\nNIT: review-2 naming.\nACTION: fix --findings review-1 --instructions "reject a moved HEAD"'
    const { result, events } = await answered(gate, reply, { files: record(gate.key, BRANCH, 'gate') })
    expect(result).toEqual({
      status: 'done',
      outcome: {
        kind: 'adjudicator',
        verdicts: ['CORRECT: review-1 moved HEAD after recovery must not be accepted.', 'NIT: review-2 naming.'],
        action: { type: 'fix', findings: 'review-1', instructions: 'reject a moved HEAD', addFinding: null, ignore: 'review-2' },
        report: null,
      },
      summary: 'adjudicator #470 (gate): ACTION fix, 2 verdict lines',
    })
    expect(events).toEqual([
      { state: 'verdict', fields: { issue: 470, run: RUN, branch: BRANCH, note: 'CORRECT: review-1 moved HEAD after recovery must not be accepted.' } },
      { state: 'verdict', fields: { issue: 470, run: RUN, branch: BRANCH, note: 'NIT: review-2 naming.' } },
    ])
  })

  test('with no spawn record, the run in the state names the branch', async () => {
    const { events } = await answered(gate, 'WRONG: review-6 false positive.\nACTION: approve', { state: { runs: [run(470, 'parked', { run: RUN, branch: 'feat/issue-470-from-state' })] } })
    expect(events[0]?.fields.branch).toBe('feat/issue-470-from-state')
  })

  test('a merge review: the purpose from the key, with its report', async () => {
    const merge = running('adjudicate-merge:512:3f2a9c1d', 'spawn', 'adjudicator', { run: RUN, pr: 512 })
    const { result } = await answered(merge, 'ACTION: merge\nSUMMARY: Agents start from the loop.\nBUMP: minor new capability\nFLAGS: none')
    expect(result).toMatchObject({
      status: 'done',
      outcome: { kind: 'adjudicator', action: { type: 'merge' }, report: { summary: 'Agents start from the loop.', bump: 'minor', bumpReason: 'new capability', flags: [] } },
      summary: 'adjudicator #470 (merge): ACTION merge, 0 verdict lines, bump minor, flags none',
    })
  })

  test('an unparseable adjudicator reply is a failed attempt (rule P2 retries); nothing is logged; the problem names the line (#548)', async () => {
    const { result, problem, events, files } = await answered(gate, 'CORRECT: review-1 is real.\nI looked at the run and it seems fine.\nACTION: approve')
    const why = 'a line after the first contract line that is not a contract line: "I looked at the run and it seems fine."'
    expect(result).toEqual({ status: 'failed', summary: `adjudicator #470: the gate reply does not parse: ${why}` })
    expect(problem).toBe(why)
    expect(events).toHaveLength(0)
    expect(files.has(answerPath(LOOP, gate.key))).toBe(true)
  })

  test('a fixer that moved to a new branch supersedes the old run (I-39); one that stayed does not', async () => {
    const moved = 'Rebased; regate moved me.\nRESULT run=01K7S1NEW head=abcdef1 commit=abcdef1 gated=yes branch=feat/issue-470-agents-v2 pr=512'
    const a = await answered(fixer, moved, { files: record(fixer.key, BRANCH) })
    expect(a.result).toEqual({
      status: 'done',
      outcome: { kind: 'handoff', notGated: false, run: '01K7S1NEW', head: 'abcdef1', newBranch: 'feat/issue-470-agents-v2' },
      summary: 'fixer #470: run 01K7S1NEW, head abcdef1, branch feat/issue-470-agents-v2',
    })
    expect(a.events).toEqual([{ state: 'superseded', fields: { issue: 470, run: RUN, note: 'by feat/issue-470-agents-v2' } }])
    const stayed = await answered(fixer, `RESULT run=01K7S1NEW head=abcdef1 commit=abcdef1 gated=yes branch=${BRANCH} pr=512`, { files: record(fixer.key, BRANCH) })
    expect(stayed.events).toHaveLength(0)
    expect(stayed.result).toMatchObject({ status: 'done', outcome: { newBranch: null } })
  })

  test('a fixer whose branch is not known supersedes nothing', async () => {
    const { events, result } = await answered(fixer, 'RESULT run=01K7S1NEW head=abcdef1 commit=abcdef1 gated=yes branch=feat/issue-470-agents-v2 pr=none')
    expect(events).toHaveLength(0)
    expect(result).toMatchObject({ outcome: { newBranch: 'feat/issue-470-agents-v2' } })
  })

  test('an implementer: its handoff, NOT GATED when it says so, never a superseded event', async () => {
    const gated = await answered(implementer, `Done.\nRESULT run=${RUN} head=3f2a9c1 commit=3f2a9c1 gated=yes branch=${BRANCH} pr=none`)
    expect(gated.result).toEqual({
      status: 'done',
      outcome: { kind: 'handoff', notGated: false, run: RUN, head: '3f2a9c1', newBranch: BRANCH },
      summary: `implementer #470: run ${RUN}, head 3f2a9c1, branch ${BRANCH}`,
    })
    expect(gated.events).toHaveLength(0)
    const notGated = await answered(implementer, 'axi run attached to the live run: NOT GATED.')
    expect(notGated.result).toEqual({
      status: 'done',
      outcome: { kind: 'handoff', notGated: true, run: null, head: null, newBranch: null },
      summary: 'implementer #470: run none, head none, NOT GATED',
    })
    const prose = await answered(implementer, 'All done, PR opened.')
    expect(prose.result).toEqual({ status: 'failed', summary: 'implementer #470: the handoff does not parse: no RESULT line, and it does not say NOT GATED' })
    expect(prose.problem).toBe('no RESULT line, and it does not say NOT GATED')
    expect(gated.problem).toBeNull()
  })

  test('a turn that ended in error, aborted or refused is failed, its answer still saved', async () => {
    for (const reason of ['error', 'aborted', 'refusal'] as const) {
      const { result, files, events } = await answered(gate, 'ACTION: approve', { reason })
      expect(result).toEqual({ status: 'failed', summary: `adjudicator #470: its turn ended: ${reason}` })
      expect(files.get(answerPath(LOOP, gate.key))).toBe('ACTION: approve')
      expect(events).toHaveLength(0)
    }
  })

  test('a failed save or event keeps the reading and says so', async () => {
    const unsaved = await answered(designer, `RESULT brief=${BRIEF} created=none pending_decision=no`, { writeFails: true })
    expect(unsaved.result).toMatchObject({ status: 'done', outcome: { kind: 'designer', brief: BRIEF } })
    expect((unsaved.result as Extract<Exec, { status: 'done' }>).summary).toMatch(/; answer not saved: EROFS/)
    const unlogged = await answered(gate, 'CORRECT: review-1 real.\nACTION: fixer: rewrite the parser', {
      event: async () => {
        throw new Error('callum-flow-event failed')
      },
    })
    expect(unlogged.result).toMatchObject({ status: 'done', outcome: { action: { type: 'fixer', instructions: 'rewrite the parser' } } })
    expect((unlogged.result as Extract<Exec, { status: 'done' }>).summary).toMatch(/; 1 of 1 events not logged$/)
  })

  test('an entry that ran no agent is a loop bug, never retried', async () => {
    const { result } = await answered(entry('guard:512:h:1', 'guard', { status: 'running', endedAt: null }), 'x')
    expect(result).toEqual({ status: 'failed', summary: 'guard:512:h:1: no agent entry', noRetry: true })
  })

  test('readAnswer is pure: the same entry and answer give the same Exec and events', () => {
    const info = { repo: REPO, branch: BRANCH, purpose: null }
    const a = readAnswer(gate, answer('DUP: review-3 handled in round 1.\nACTION: skip'), info)
    expect(a).toEqual(readAnswer(gate, answer('DUP: review-3 handled in round 1.\nACTION: skip'), info))
    expect(a.events).toEqual([{ state: 'verdict', fields: { issue: 470, run: RUN, branch: BRANCH, note: 'DUP: review-3 handled in round 1.' } }])
  })
})

// --- the answer script's file (#561) ------------------------------------------------------------

describe('onAgentAnswer: the file recorded with the answer script', () => {
  const gate = running(`adjudicate:${RUN}:review:3f2a9c1d`, 'spawn', 'adjudicator', { run: RUN, head: '3f2a9c1d', attempts: 1, startedAt: NOW - 600_000 })
  const merge = running('adjudicate-merge:512:3f2a9c1d', 'spawn', 'adjudicator', { run: RUN, pr: 512, head: '3f2a9c1d', attempts: 1, startedAt: NOW - 600_000 })
  const fileOf = (e: LedgerEntry) => scriptAnswerPath(LOOP, e)
  const job = { contract: 'verdict' as const, purpose: 'gate' as const, repo: REPO, issue: 470, branch: null }
  const VERDICT = { findings: [{ id: 'review-1', verdict: 'WRONG', reason: 'the timeout is handled in parse.ts' }], action: { type: 'approve', reason: 'a false positive' } }
  // the file as the script writes it (contract.mjs answerText: the same function it calls)
  const written = (input: unknown) => {
    const body = answerText(job, input)
    if (!body.ok) throw new Error(body.problems.join('; '))
    return body.outcome
  }
  const record = (e: LedgerEntry, channel = 'script') => ({ [spawnRecordPath(LOOP, e.key)]: JSON.stringify({ branch: BRANCH, purpose: null, channel }) })

  test('a valid file at the path issued for this attempt is read first and checked again: done through the script, its verdicts logged, the text and the record saved together', async () => {
    const body = written(VERDICT)
    const r = await answered(gate, 'I judged it; the answer is recorded.', { files: { [fileOf(gate)]: body, ...record(gate) } })
    expect(r.result).toEqual({
      status: 'done',
      outcome: { kind: 'adjudicator', verdicts: ['WRONG: review-1: the timeout is handled in parse.ts'], action: { type: 'approve', reason: 'a false positive' }, report: null },
      summary: 'adjudicator #470 (gate, script): ACTION approve, 1 verdict line',
    })
    expect(r.problem).toBeNull()
    expect(r.events).toEqual([{ state: 'verdict', fields: { issue: 470, run: RUN, branch: BRANCH, note: 'WRONG: review-1: the timeout is handled in parse.ts' } }])
    expect(r.files.get(answerPath(LOOP, gate.key))).toBe(`I judged it; the answer is recorded.\n\n${SCRIPT_RECORD}\n\n${body}`)
    const taken = await onAgentAnswer(harness({ entry: gate, files: { [fileOf(gate)]: body, ...record(gate) } }).ctx, gate, answer('done'))
    expect(taken).toMatchObject({ via: 'script', channel: 'script' })
    // a turn that ended in error after the answer was recorded keeps the answer
    expect((await answered(gate, '', { reason: 'error', files: { [fileOf(gate)]: body } })).result).toMatchObject({ status: 'done', outcome: { action: { type: 'approve' } } })
  })

  test('only the path issued for this attempt is read: another attempt\'s file, another entry\'s or a stale one is never taken', async () => {
    const body = written(VERDICT)
    const others = [
      scriptAnswerPath(LOOP, { ...gate, attempts: 2 }),
      scriptAnswerPath(LOOP, { ...gate, startedAt: gate.startedAt - 1 }),
      scriptAnswerPath(LOOP, merge),
      `${LOOP}/answers/anything.answer.json`,
    ]
    for (const other of others) {
      const r = await answered(gate, 'All good.', { files: { [other]: body } })
      expect(r.result).toMatchObject({ status: 'failed' })
      expect(r.problem).toBe('no ACTION line')
    }
  })

  test('with no file, the text is read as before', async () => {
    const r = await answered(gate, 'WRONG: review-1 handled.\nACTION: approve')
    expect(r.result).toMatchObject({ status: 'done', summary: 'adjudicator #470 (gate): ACTION approve, 1 verdict line' })
    expect((await onAgentAnswer(harness({ entry: gate }).ctx, gate, answer('ACTION: approve'))).via).toBe('text')
  })

  test('a file that fails its checks is refused: the text is read instead, and when that fails too the problem names both', async () => {
    const broken = JSON.stringify({ v: 1, contract: 'verdict', answer: { findings: [], action: { type: 'merge' } } })
    const both = await onAgentAnswer(harness({ entry: gate, files: { [fileOf(gate)]: broken } }).ctx, gate, answer('All good.'))
    expect(both.via).toBe('text')
    expect(both.exec.status).toBe('failed')
    const refusal =
      'the answer recorded with the answer script does not pass its checks: action must be { type, ... } with type one of approve, fix, skip, fixer, escalate: a gate review takes no other'
    expect(both.scriptProblem).toBe(refusal)
    expect(both.problem).toBe(`${refusal}; and the reply: no ACTION line`)
    // the text is sound: it is taken, and the refused file is still named for the decision log
    const text = await onAgentAnswer(harness({ entry: gate, files: { [fileOf(gate)]: broken } }).ctx, gate, answer('WRONG: review-1 handled.\nACTION: approve'))
    expect(text).toMatchObject({ via: 'text', problem: null, scriptProblem: refusal, exec: { status: 'done' } })
    // a file the script did not write, or one of another contract
    const files: [string, string][] = [
      ['not json', 'the answer file is not JSON'],
      [JSON.stringify(VERDICT), 'the answer file is not in the shape the answer script writes'],
      [JSON.stringify({ v: 1, contract: 'design', answer: {} }), 'the answer file holds a "design" answer, and this agent answers with verdict'],
    ]
    for (const [body, why] of files) {
      const r = await onAgentAnswer(harness({ entry: gate, files: { [fileOf(gate)]: body } }).ctx, gate, answer('All good.'))
      expect(r.scriptProblem).toBe(`the answer recorded with the answer script does not pass its checks: ${why}`)
    }
  })

  test('the loop checks a file against what it knows, never the job file beside it: a merge review needs its report whatever a job file says', async () => {
    const lying = { [jobPathOf(fileOf(merge)) ?? '']: jobText({ ...job, purpose: 'gate' }) }
    const gateShaped = JSON.stringify({ v: 1, contract: 'verdict', answer: VERDICT })
    const r = await onAgentAnswer(harness({ entry: merge, files: { ...lying, [fileOf(merge)]: gateShaped } }).ctx, merge, answer('All good.'))
    expect(r.via).toBe('text')
    expect(r.scriptProblem).toContain('action must be { type, ... } with type one of merge, hold, fixer, escalate: a merge review takes no other')
  })

  test('readScriptAnswer is pure, and each agent\'s file is checked against its own job (jobOf)', () => {
    const info = { repo: REPO, branch: BRANCH, purpose: null }
    const body = written(VERDICT)
    expect(readScriptAnswer(gate, body, info)).toEqual(readScriptAnswer(gate, body, info))
    expect(jobOf(gate, 'adjudicator', info)).toEqual(job)
    expect(jobOf(merge, 'adjudicator', info)).toEqual({ ...job, purpose: 'merge' })
    expect(jobOf(running('adjudicate-x:1', 'spawn', 'adjudicator'), 'adjudicator', info)).toBeNull()
    expect(jobOf(running('fixer:conflict:512:h', 'spawn', 'fixer'), 'fixer', info)).toEqual({ contract: 'handoff', purpose: null, repo: REPO, issue: 470, branch: BRANCH })
    expect(jobOf(running(`delegate:470:${BRIEF}`, 'delegate', 'implementer'), 'implementer', info)).toEqual({ contract: 'handoff', purpose: null, repo: REPO, issue: 470, branch: null })
    expect(jobOf(running('design:470:1', 'spawn', 'designer'), 'designer', info)).toEqual({ contract: 'design', purpose: null, repo: REPO, issue: 470, branch: null })
  })
})
