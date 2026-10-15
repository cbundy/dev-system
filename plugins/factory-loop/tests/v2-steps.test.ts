// The agent steps (hooks/v2/steps.ts; docs/factory-loop/v2/SPEC.md 4.2, 5.1, 10.8, D-68, D-74),
// generic over their kinds: the agent-step executor writes the answer script's job file and the
// step's record, then spawns the step's own agent type; an answer already recorded for the key is
// the result and nothing is spawned; an answer ends the step when it is read (a writer's ok only at
// its turn's end); one repair message, then unknown (bad-answer). The step modules and contracts
// are a test's own here, since the units that fill them come later; the act step's routing of a
// v2 agent's turn end (act.ts agentAnswered) runs with the real, unbuilt ones.
import { describe, expect, test } from 'claude-code/testing'

import { agentAnswered, ctxOf } from '../hooks/act'
import type { ActEnv, Between } from '../hooks/act'
import { jobPathOf, parseJob } from '../hooks/contract.mjs'
import type { V2Contract } from '../hooks/contract.mjs'
import { answerPath } from '../hooks/exec'
import type { ActIo, SpawnInput } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry } from '../hooks/types'
import { parseStepRecord, stepAnswerPath, stepAnswered, stepExecutor, stepRecordPath, stepRecorded } from '../hooks/v2/steps'
import type { StepDeps, StepModule, StepRecord } from '../hooks/v2/steps'
import { STEP_AGENT } from '../hooks/v2/types'
import type { AgentStep } from '../hooks/v2/types'
import { DEVICE, NOW, PLUGIN_ROOT, config, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const BIN = `${PLUGIN_ROOT}/bin/factory-answer`

// A contract that takes { verdict: ok | no, reason? }, named as the step's own.
const contract: V2Contract = {
  check: input => {
    const o = input as { verdict?: unknown; reason?: unknown } | null
    return o !== null && typeof o === 'object' && (o.verdict === 'ok' || o.verdict === 'no') ? { ok: true, outcome: o } : { ok: false, problems: ['verdict must be ok or no'] }
  },
  summary: () => 'a verdict',
}

// A module whose answer's verdict is the step's result.
function moduleOf(step: AgentStep, contractName: StepModule['contract']): StepModule {
  return {
    step,
    contract: contractName,
    spawn: async (_ctx, action, place) => ({ prompt: `${step} #${action.issue}: answer with ${place.bin} --to ${place.file}`, model: 'sonnet', data: { round: 2 } }),
    result: async (_ctx, _record, answer) => {
      const o = answer as { verdict: string; reason?: string }
      return { event: o.verdict === 'ok' ? 'ok' : 'not-ok', reason: o.reason ?? null, why: null, head: null, choice: null, data: answer }
    },
  }
}

const DEPS: StepDeps = {
  modules: { review: moduleOf('review', 'review'), build: moduleOf('build', 'build') },
  contracts: { review: contract, build: contract },
}

function rt(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP_DIR,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: config({ planner: 'v2' }),
    configProblems: [],
  }
}

function world(spawn: (input: SpawnInput) => { agentId?: string; deny?: string } = () => ({ agentId: 'agent-1' })) {
  const files = new Map<string, string>()
  const spawns: SpawnInput[] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    spawnAgent: async input => {
      spawns.push(input)
      return spawn(input)
    },
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async path => files.get(path) ?? null,
    writeFile: async (path, text) => void files.set(path, text),
  }
  const env: ActEnv = { io, rt: rt(), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return { files, spawns, env }
}

const stepAction = (step: AgentStep, over: Partial<Extract<Action, { kind: 'agent-step' }>> = {}): Extract<Action, { kind: 'agent-step' }> => ({
  kind: 'agent-step',
  key: `i470/ltbq3k0/s3/${step}/a1`,
  class: 'drive',
  rule: 'S2',
  reason: 'step',
  issue: 470,
  step,
  life: 'tbq3k0',
  seq: 3,
  attempt: 1,
  branch: 'issue-470',
  slot: '/slots/1',
  notes: [],
  ...over,
})

// spawned: the step's attempt run through the executor, its entry as the act step leaves it
async function spawned(w: ReturnType<typeof world>, action: Extract<Action, { kind: 'agent-step' }>, deps = DEPS) {
  const entry = start([], action, NOW).entry
  const exec = await stepExecutor(deps)(ctxOf(w.env, state(), entry), action)
  const running: LedgerEntry = exec.status === 'running' && exec.agentId !== undefined ? { ...entry, agentId: exec.agentId } : entry
  return { exec, entry: running }
}

// recorded: the agent records its answer as the answer script writes it
function recorded(w: ReturnType<typeof world>, key: string, contractName: string, answer: unknown) {
  w.files.set(stepAnswerPath(LOOP_DIR, key), `${JSON.stringify({ v: 1, contract: contractName, answer }, null, 2)}\n`)
}

describe('the agent-step executor', () => {
  test('it writes the job file and the step\'s record, then spawns the step\'s own agent type with the answer script on the prompt', async () => {
    const w = world()
    const action = stepAction('review')
    const { exec } = await spawned(w, action)
    expect(exec).toEqual({ status: 'running', agentId: 'agent-1', summary: `factory-loop:reviewer started for #470 (${action.key}): agent-1` })
    const place = stepAnswerPath(LOOP_DIR, action.key)
    expect(place).toBe(`${LOOP_DIR}/answers/i470_ltbq3k0_s3_review_a1.answer.json`)
    expect(parseJob(w.files.get(jobPathOf(place) ?? '') ?? '')).toEqual({ contract: 'review', purpose: null, repo: REPO, issue: 470, branch: 'issue-470', data: { round: 2 } })
    const record = parseStepRecord(w.files.get(stepRecordPath(LOOP_DIR, action.key)) ?? null, DEPS.contracts) as StepRecord
    expect(record).toMatchObject({ v: 2, key: action.key, issue: 470, step: 'review', life: 'tbq3k0', seq: 3, attempt: 1, role: 'reader', subagentType: STEP_AGENT.review, model: 'sonnet', contract: 'review', answerFile: place })
    expect(w.spawns).toEqual([
      { subagentType: 'factory-loop:reviewer', prompt: `review #470: answer with ${BIN} --to ${place}`, description: 'Review #470', name: 'review-470-s3-a1', model: 'sonnet' },
    ])
  })

  test('an answer already recorded for the key is the result, and nothing is spawned (v2 SPEC 10.8)', async () => {
    const w = world()
    const action = stepAction('review')
    await spawned(w, action)
    recorded(w, action.key, 'review', { verdict: 'no', reason: 'a test is weakened' })
    const again = await spawned(w, action)
    expect(again.exec).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'review', result: { event: 'not-ok', reason: 'a test is weakened', why: null } } })
    expect(w.spawns).toHaveLength(1)
  })

  test('a step with no module, or a spawn its module cannot make, is a loop bug: failed, never retried, nothing spawned', async () => {
    const w = world()
    expect((await spawned(w, stepAction('triage'))).exec).toEqual({ status: 'failed', summary: 'refused: no module runs the triage step', noRetry: true })
    const cannot: StepDeps = { ...DEPS, modules: { review: { ...moduleOf('review', 'review'), spawn: async () => 'the brief is missing' } } }
    expect((await spawned(w, stepAction('review'), cannot)).exec).toEqual({ status: 'failed', summary: 'refused: the brief is missing', noRetry: true })
    expect(w.spawns).toEqual([])
  })

  test('a refused or failed spawn is a failed attempt, which plan reads as unknown', async () => {
    expect((await spawned(world(() => ({ deny: 'the companion found no step marker' })), stepAction('build'))).exec).toEqual({
      status: 'failed',
      summary: 'factory-loop:builder denied: the companion found no step marker',
    })
    expect((await spawned(world(() => ({})), stepAction('build'))).exec).toEqual({ status: 'failed', summary: 'factory-loop:builder: started with no agent id' })
  })
})

describe('reading a step\'s answer (v2 SPEC 10.8)', () => {
  test('at the turn\'s end: a valid answer is the result; a bad or missing one asks once more by the repair message', async () => {
    const w = world()
    const action = stepAction('review')
    const { entry } = await spawned(w, action)
    const ctx = ctxOf(w.env, state(), entry)
    const missing = await stepAnswered(ctx, entry, { agentId: 'agent-1', answer: 'done', reason: 'answer' }, DEPS)
    expect(missing.problem).toBe('no answer was recorded with the answer script')
    expect(missing.repair).toBe(`Your answer was not recorded: no answer was recorded with the answer script. Record it now with \`${BIN} --to ${stepAnswerPath(LOOP_DIR, action.key)}\` and the JSON object your prompt asks for, then end your turn.`)
    expect(missing.subagentType).toBe('factory-loop:reviewer')
    expect(missing.exec).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'review', result: { event: 'unknown', why: 'bad-answer' } } })
    recorded(w, action.key, 'review', { verdict: 'maybe' })
    expect((await stepAnswered(ctx, entry, { agentId: 'agent-1', answer: 'done', reason: 'answer' }, DEPS)).problem).toBe(
      'the answer recorded with the answer script does not pass its checks: verdict must be ok or no',
    )
    recorded(w, action.key, 'review', { verdict: 'ok' })
    const ok = await stepAnswered(ctx, entry, { agentId: 'agent-1', answer: 'done', reason: 'answer' }, DEPS)
    expect(ok).toMatchObject({ problem: null, repair: null, exec: { status: 'done', outcome: { kind: 'step', step: 'review', result: { event: 'ok', data: { verdict: 'ok' } } } } })
    // the turn's last words are kept for the owner and the triage
    expect(w.files.get(answerPath(LOOP_DIR, action.key))).toBe('done')
  })

  test('a turn that ended in error, aborted or refused is unknown with no repair: an API error when its words say so', async () => {
    const w = world()
    const { entry } = await spawned(w, stepAction('build'))
    const ctx = ctxOf(w.env, state(), entry)
    const why = async (answer: string, reason: 'error' | 'aborted' | 'refusal') => {
      const r = await stepAnswered(ctx, entry, { agentId: 'agent-1', answer, reason }, DEPS)
      expect(r.repair).toBeNull()
      return r.exec.status === 'done' && r.exec.outcome?.kind === 'step' ? r.exec.outcome.result.why : null
    }
    expect(await why('API Error: 429 rate limit reached', 'error')).toBe('api')
    expect(await why('it stopped', 'aborted')).toBe('agent-dead')
    expect(await why('no', 'refusal')).toBe('agent-dead')
  })

  test('an answer is read every pass: a reader\'s ends its step at once; a writer\'s ok waits for its turn\'s end, its not-ok does not', async () => {
    const w = world()
    const review = await spawned(w, stepAction('review'))
    const build = await spawned(w, stepAction('build', { key: 'i470/ltbq3k0/s3/build/a1' }))
    const ctx = (e: LedgerEntry) => ctxOf(w.env, state(), e)
    expect(await stepRecorded(ctx(review.entry), review.entry, false, DEPS)).toBeNull()
    recorded(w, review.entry.key, 'review', { verdict: 'ok' })
    expect(await stepRecorded(ctx(review.entry), review.entry, false, DEPS)).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'ok' } } })
    recorded(w, build.entry.key, 'build', { verdict: 'ok' })
    expect(await stepRecorded(ctx(build.entry), build.entry, false, DEPS)).toBeNull()
    expect(await stepRecorded(ctx(build.entry), build.entry, true, DEPS)).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'build', result: { event: 'ok' } } })
    recorded(w, build.entry.key, 'build', { verdict: 'no', reason: 'cannot' })
    expect(await stepRecorded(ctx(build.entry), build.entry, false, DEPS)).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'not-ok', reason: 'cannot' } } })
  })

  test('the record reads back exactly as written, and a record that is not one reads as none', async () => {
    const w = world()
    const action = stepAction('build')
    await spawned(w, action)
    const text = w.files.get(stepRecordPath(LOOP_DIR, action.key)) ?? null
    const r = parseStepRecord(text, DEPS.contracts)
    expect(r === null ? null : JSON.parse(JSON.stringify(r))).toEqual(JSON.parse(text ?? 'null'))
    for (const bad of [null, '{', '[]', JSON.stringify({ ...JSON.parse(text ?? '{}'), v: 1 }), JSON.stringify({ ...JSON.parse(text ?? '{}'), step: 'merge' }), JSON.stringify({ ...JSON.parse(text ?? '{}'), contract: 'design' })]) {
      expect(parseStepRecord(bad, DEPS.contracts)).toBeNull()
    }
  })
})

describe('the act step routes a v2 agent\'s turn end to steps.ts (act.ts agentAnswered)', () => {
  test('no answer: one repair message to the step\'s own agent type, the entry runs on; a second miss is unknown (bad-answer)', async () => {
    const w = world()
    // the real, unbuilt modules: the triage step's record names its contract
    const action = stepAction('triage', { key: 'i470/ltbq3k0/s5/triage/a1', seq: 5 })
    const entry: LedgerEntry = { ...start([], action, NOW).entry, agentId: 'agent-7' }
    const record: StepRecord = {
      v: 2,
      key: action.key,
      issue: 470,
      step: 'triage',
      life: 'tbq3k0',
      seq: 5,
      attempt: 1,
      branch: 'issue-470',
      slot: '/slots/1',
      role: 'reader',
      subagentType: STEP_AGENT.triage,
      model: 'opus',
      contract: 'triage',
      data: null,
      answerFile: stepAnswerPath(LOOP_DIR, action.key),
      prompt: 'triage',
    }
    w.files.set(stepRecordPath(LOOP_DIR, action.key), JSON.stringify(record))
    w.env.live.ledger = [entry]
    const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map() }
    const sent: [string, string][] = []
    const repair = async (id: string, _text: string, type: string) => {
      sent.push([id, type])
      return null
    }
    const first = await agentAnswered(w.env, state(), { agentId: 'agent-7', answer: 'I think we should retry', reason: 'answer' }, between, async () => true, repair)
    expect(first).toEqual({ result: 'repair', why: 'no answer was recorded with the answer script', key: action.key })
    expect(sent).toEqual([['agent-7', 'factory-loop:triage']])
    expect(w.env.live.ledger[0]).toMatchObject({ status: 'running', reminded: true })
    const second = await agentAnswered(w.env, state(), { agentId: 'agent-7', answer: 'still no answer', reason: 'answer' }, between, async () => true, repair)
    expect(second).toMatchObject({ result: 'applied', key: action.key, repaired: true })
    expect(w.env.live.ledger[0]).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'triage', result: { event: 'unknown', why: 'bad-answer' } } })
    expect(sent).toHaveLength(1)
  })
})
