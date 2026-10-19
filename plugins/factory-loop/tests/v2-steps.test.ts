// The agent steps (hooks/v2/steps.ts; docs/factory-loop/v2/SPEC.md 4.2, 5.1, 10.8, D-68, D-74),
// generic over their kinds: the agent-step executor writes the answer script's job file and the
// step's record, then spawns the step's own agent type; an answer already recorded for the key is
// the result and nothing is spawned; an answer ends the step when it is read (a writer's ok only at
// its turn's end); one repair message, then unknown (bad-answer). The step modules and contracts
// are a test's own here, since the units that fill them come later; the act step's routing of a
// v2 agent's turn end (act-between.ts agentAnswered) runs with the real, unbuilt ones.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf } from '../hooks/act'
import { agentAnswered } from '../hooks/act-between'
import { reconcilable } from '../hooks/act'
import type { ActEnv, Between } from '../hooks/act'
import { jobPathOf, parseJob } from '../hooks/contract.mjs'
import type { V2Contract } from '../hooks/contract.mjs'
import { entryFromLoop } from '../hooks/derive'
import type { FactoryEvent } from '../hooks/derive'
import { answerPath } from '../hooks/exec'
import type { ActIo, Exec, SpawnInput } from '../hooks/exec'
import { finish, loopEvent, start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry } from '../hooks/types'
import { gateHoldMs, gateSettled } from '../hooks/v2/steps-gate'
import type { GateLine } from '../hooks/v2/sources-interventions'
import { parseStepRecord, stepAnswerPath, stepAnswered, stepAnswers, stepExecutor, stepRecordPath, stepRecorded } from '../hooks/v2/steps'
import type { StepDeps, StepModule, StepRecord } from '../hooks/v2/steps'
import { STEP_AGENT, WHY_CAUSE, unknownResult } from '../hooks/v2/types'
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

// A module whose answer's verdict is the step's result, and what the answer says of itself.
function moduleOf(step: AgentStep, contractName: StepModule['contract']): StepModule {
  return {
    step,
    contract: contractName,
    spawn: async (_ctx, action, place) => ({ prompt: `${step} #${action.issue}: answer with ${place.bin} --to ${place.file}`, model: 'sonnet', data: { round: 2 } }),
    result: async (_ctx, _record, answer) => {
      const o = answer as { verdict: string; reason?: string }
      return { event: o.verdict === 'ok' ? 'ok' : 'not-ok', reason: o.reason ?? null, why: null, head: null, choice: null, data: answer }
    },
    says: answer => ((answer as { verdict: string }).verdict === 'ok' ? 'ok' : 'not-ok'),
  }
}

// A writer's module whose result reads origin, as U5's do: an ok answer with no commit there is
// not-ok (T6), and a failed read is unknown. It counts its reads.
function originModule(origin: 'no-commit' | 'unread'): { module: StepModule; reads: () => number } {
  let reads = 0
  const module: StepModule = {
    ...moduleOf('build', 'build'),
    result: async () => {
      reads += 1
      return origin === 'no-commit' ? { event: 'not-ok', reason: 'no commit on origin', why: null, head: null, choice: null, data: null } : unknownResult('cli', 'git ls-remote failed')
    },
  }
  return { module, reads: () => reads }
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
    config: config(),
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
      { subagentType: 'factory-loop:reviewer', prompt: `review #470: answer with ${BIN} --to ${place}`, description: 'Review #470', name: 'review-470-s3-a1', model: 'sonnet', cwd: '/slots/1' },
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

  test('a turn that ended in error, aborted or refused is unknown with no repair: a rate limit apart from other API errors', async () => {
    const w = world()
    const { entry } = await spawned(w, stepAction('build'))
    const ctx = ctxOf(w.env, state(), entry)
    const result = async (answer: string, reason: 'error' | 'aborted' | 'refusal') => {
      const r = await stepAnswered(ctx, entry, { agentId: 'agent-1', answer, reason }, DEPS)
      expect(r.repair).toBeNull()
      return r.exec.status === 'done' && r.exec.outcome?.kind === 'step' ? r.exec.outcome.result : null
    }
    // a 429 is the outside cause usage: a free re-run the breaker does not count (5.1, 5.3)
    const limited = await result('API Error: 429 {"type":"rate_limit_error"}', 'error')
    expect(limited).toMatchObject({ event: 'unknown', why: 'rate-limited', reason: 'its turn ended: error: API Error: 429 {"type":"rate_limit_error"}' })
    expect(WHY_CAUSE[limited?.why ?? 'api']).toBe('usage')
    expect((await result('Claude usage limit reached. Your limit will reset at 2am', 'error'))?.why).toBe('rate-limited')
    // a 529 or another API error is unexplained, and counts
    for (const words of ['API Error: 529 {"type":"overloaded_error","message":"Overloaded"}', 'API Error: Connection error.']) {
      const r = await result(words, 'error')
      expect(r).toMatchObject({ event: 'unknown', why: 'api', reason: `its turn ended: error: ${words}` })
      expect(WHY_CAUSE[r?.why ?? 'api']).toBeUndefined()
    }
    expect(await result('it stopped', 'aborted')).toMatchObject({ why: 'agent-dead', reason: 'its turn ended: aborted: it stopped' })
    expect((await result('no', 'refusal'))?.why).toBe('agent-dead')
    // the words kept are an excerpt
    expect((await result(`API Error: ${'x'.repeat(400)}`, 'error'))?.reason?.length).toBeLessThanOrEqual(200)
  })

  test('an answer recorded before the turn ended in error is the result; a writer\'s ok is not, as the stop gate never ran (v2 SPEC 10.8)', async () => {
    const w = world()
    const review = await spawned(w, stepAction('review'))
    const build = await spawned(w, stepAction('build', { key: 'i470/ltbq3k0/s3/build/a1' }))
    const ended = async (e: LedgerEntry, reason: 'error' | 'aborted') => {
      const r = await stepAnswered(ctxOf(w.env, state(), e), e, { agentId: 'agent-1', answer: 'API Error: 529 overloaded', reason }, DEPS)
      return r.exec.status === 'done' && r.exec.outcome?.kind === 'step' ? r.exec.outcome.result : null
    }
    recorded(w, review.entry.key, 'review', { verdict: 'ok' })
    expect(await ended(review.entry, 'aborted')).toMatchObject({ event: 'ok', data: { verdict: 'ok' } })
    recorded(w, build.entry.key, 'build', { verdict: 'no', reason: 'cannot' })
    expect(await ended(build.entry, 'error')).toMatchObject({ event: 'not-ok', reason: 'cannot' })
    recorded(w, build.entry.key, 'build', { verdict: 'ok' })
    expect(await ended(build.entry, 'error')).toMatchObject({ event: 'unknown', why: 'api' })
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

  test('a writer\'s ok waits for its turn\'s end on what it says, before origin is read: a result that maps it to not-ok or unknown never ends the step mid-turn', async () => {
    for (const origin of ['no-commit', 'unread'] as const) {
      const w = world()
      const { module, reads } = originModule(origin)
      const deps: StepDeps = { ...DEPS, modules: { ...DEPS.modules, build: module } }
      const build = await spawned(w, stepAction('build'), deps)
      recorded(w, build.entry.key, 'build', { verdict: 'ok' })
      // a pass's read, and the read of every running step a pass makes (act.ts actPass)
      expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, false, deps)).toBeNull()
      expect(await stepAnswers([build.entry], e => ctxOf(w.env, state(), e), deps)).toEqual([])
      expect(reads()).toBe(0)
      // its turn's end reads origin, and the result is the module's
      const event = origin === 'no-commit' ? 'not-ok' : 'unknown'
      expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, true, deps)).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event } } })
      expect(reads()).toBe(1)
    }
  })

  test('a writer\'s module that cannot say what an answer claims has every answer wait for the turn\'s end', async () => {
    const w = world()
    const { says: _says, ...silent } = moduleOf('build', 'build')
    const deps: StepDeps = { ...DEPS, modules: { ...DEPS.modules, build: silent } }
    const build = await spawned(w, stepAction('build'), deps)
    recorded(w, build.entry.key, 'build', { verdict: 'no', reason: 'cannot' })
    expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, false, deps)).toBeNull()
    expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, true, deps)).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'not-ok' } } })
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

describe('a lost store (v2 SPEC 3.3, 10.8)', () => {
  test('a done build step whose transition was not stored yet is not rebuilt: S2 starts the attempt again, and the executor takes the recorded answer without a spawn', async () => {
    const w = world()
    const action = stepAction('build')
    const { entry } = await spawned(w, action)
    recorded(w, action.key, 'build', { verdict: 'ok' })
    const done = finish([entry], action.key, (await stepRecorded(ctxOf(w.env, state(), entry), entry, true, DEPS)) as Exec, NOW)
    const ended = done.find(e => e.key === action.key) as LedgerEntry
    expect(ended).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'ok' } } })
    // its loop event is logged for the trail, and gives no entry back
    const argv = loopEvent(ended) as string[]
    expect(argv[1]).toBe('loop')
    const event: FactoryEvent = { ts: NOW, state: 'loop', issue: 470, run: null, branch: null, pr: null, head: null, note: argv[argv.indexOf('--note') + 1] ?? null, actor: null, device: DEVICE }
    expect(entryFromLoop(event)).toBeNull()
    // the key dispatched again finds the answer, and spawns nothing
    const spawns = w.spawns.length
    const again = await stepExecutor(DEPS)(ctxOf(w.env, state(), start([], action, NOW).entry), action)
    expect(again).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'build', result: { event: 'ok' } } })
    expect(w.spawns).toHaveLength(spawns)
  })
})

describe('the act step routes a v2 agent\'s turn end to steps.ts (act-between.ts agentAnswered)', () => {
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
    const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map(), gateHeld: new Map() }
    const sent: [string, string][] = []
    const repair = async (id: string, _text: string, type: string) => {
      sent.push([id, type])
      return null
    }
    const first = await agentAnswered(w.env, state(), { agentId: 'agent-7', answer: 'I think we should retry', reason: 'answer' }, between, repair)
    expect(first).toEqual({ result: 'repair', why: 'no answer was recorded with the answer script', key: action.key })
    expect(sent).toEqual([['agent-7', 'factory-loop:triage']])
    expect(w.env.live.ledger[0]).toMatchObject({ status: 'running', reminded: true })
    const second = await agentAnswered(w.env, state(), { agentId: 'agent-7', answer: 'still no answer', reason: 'answer' }, between, repair)
    expect(second).toMatchObject({ result: 'applied', key: action.key, repaired: true })
    expect(w.env.live.ledger[0]).toMatchObject({ status: 'done', outcome: { kind: 'step', step: 'triage', result: { event: 'unknown', why: 'bad-answer' } } })
    expect(sent).toHaveLength(1)
  })
})

// --- the stop gate decides when a gated writer's step ends (v2 SPEC 10.6, 10.8, #918) -------------------

const MIN = 60_000
const gated = (w: ReturnType<typeof world>) => {
  w.env.rt = { ...w.env.rt, config: { ...config(), gateCommands: ['npm test'] } }
}
const clock = (w: ReturnType<typeof world>, now: number) => Object.assign(w.env.io, { now: async () => now })
function gateLine(w: ReturnType<typeof world>, over: Record<string, unknown>) {
  const path = `${LOOP_DIR}/companion.jsonl`
  const line = { at: NOW + 5000, cause: 'gate-pass', issue: 470, life: 'tbq3k0', seq: 3, ms: 1000, waitMs: 0, head: null, concurrency: null, ...over }
  w.files.set(path, `${w.files.get(path) ?? ''}${JSON.stringify(line)}\n`)
}
const line = (over: Partial<GateLine>): GateLine => ({ at: NOW + 1000, issue: 470, life: 'tbq3k0', seq: 3, cause: 'gate-pass', head: null, ms: 1, waitMs: 0, concurrency: null, startedAt: null, startedMs: null, derived: null, queuedBehind: null, ...over })
const AT = { issue: 470, life: 'tbq3k0', seq: 3, since: NOW }

describe('gateSettled', () => {
  test('the newest settling line of this issue, life and seq, dated at or after the attempt\'s start', () => {
    expect(gateSettled([], AT)).toEqual({ cause: null })
    expect(gateSettled([line({ seq: 4 }), line({ life: 'other' }), line({ issue: 9 }), line({ at: NOW - 1 })], AT)).toEqual({ cause: null })
    expect(gateSettled([line({ at: NOW })], AT)).toEqual({ cause: 'gate-pass', at: NOW })
    // the hook's catch line has no startedAt, so it is dated by its own time
    expect(gateSettled([line({ cause: 'gate-unknown', at: NOW + 7, startedAt: null, startedMs: null })], AT)).toEqual({ cause: 'gate-unknown', at: NOW + 7 })
  })

  test('a newest gate-fail keeps the step open; a later pass settles it; gate-wait is ignored', () => {
    expect(gateSettled([line({ cause: 'gate-pass', at: NOW + 1 }), line({ cause: 'gate-fail', at: NOW + 2 })], AT)).toEqual({ cause: 'gate-fail' })
    expect(gateSettled([line({ cause: 'gate-fail', at: NOW + 2 }), line({ cause: 'gate-pass', at: NOW + 3 })], AT)).toEqual({ cause: 'gate-pass', at: NOW + 3 })
    expect(gateSettled([line({ cause: 'gate-wait', at: NOW + 9 })], AT)).toEqual({ cause: null })
  })

  test('the hold is the wait, the run and two minutes', () => {
    expect(gateHoldMs({ gateWaitTimeoutMs: 30 * MIN, gateTimeoutMs: 10 * MIN })).toBe(42 * MIN)
  })
})

describe('a gated writer\'s step ends on its settling gate line (#918)', () => {
  test('a not-ok answer (a declined fix) is held with no gate line and after a gate-fail, and ends on a later gate-pass, saying so', async () => {
    const w = world()
    gated(w)
    const build = await spawned(w, stepAction('build'))
    recorded(w, build.entry.key, 'build', { verdict: 'no', reason: 'declined' })
    const pass = () => stepAnswers([build.entry], e => ctxOf(w.env, state(), e), DEPS)
    expect(await pass()).toEqual([])
    gateLine(w, { cause: 'gate-fail', at: NOW + 3000 })
    expect(await pass()).toEqual([])
    gateLine(w, { cause: 'gate-pass', at: NOW + 9000 })
    const [taken] = await pass()
    expect(taken?.exec).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'not-ok', reason: 'declined' } } })
    expect(taken?.exec.summary).toContain(`(after its gate-pass at ${new Date(NOW + 9000).toISOString()})`)
  })

  test('a gate line of an earlier attempt or another seq does not settle it', async () => {
    const w = world()
    gated(w)
    const build = await spawned(w, stepAction('build'))
    recorded(w, build.entry.key, 'build', { verdict: 'ok' })
    gateLine(w, { at: NOW - 5000 })
    gateLine(w, { seq: 4 })
    expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, true, DEPS)).toBeNull()
  })

  test('an ungated writer keeps today\'s rule: its not-ok is taken when read, its ok at the turn\'s end', async () => {
    const w = world()
    const build = await spawned(w, stepAction('build'))
    recorded(w, build.entry.key, 'build', { verdict: 'no', reason: 'cannot' })
    expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, false, DEPS)).toMatchObject({ status: 'done' })
    recorded(w, build.entry.key, 'build', { verdict: 'ok' })
    expect(await stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, false, DEPS)).toBeNull()
  })

  test('a turn that ended in error is unchanged by the gate: a recorded not-ok is kept', async () => {
    const w = world()
    gated(w)
    const build = await spawned(w, stepAction('build'))
    recorded(w, build.entry.key, 'build', { verdict: 'no', reason: 'cannot' })
    const r = await stepAnswered(ctxOf(w.env, state(), build.entry), build.entry, { agentId: 'agent-1', answer: 'API Error: 529', reason: 'error' }, DEPS)
    expect(r.held).toBeUndefined()
    expect(r.exec).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'not-ok' } } })
  })

  test('the hold is bounded: held at the bound, taken past it with a note; an unreadable log is held too', async () => {
    const w = world()
    gated(w)
    const build = await spawned(w, stepAction('build'))
    recorded(w, build.entry.key, 'build', { verdict: 'ok' })
    const hold = new Map<string, number>()
    const bound = gateHoldMs(w.env.rt.config)
    const read = () => stepRecorded(ctxOf(w.env, state(), build.entry), build.entry, true, DEPS, hold)
    clock(w, NOW)
    expect(await read()).toBeNull()
    clock(w, NOW + bound)
    expect(await read()).toBeNull()
    Object.assign(w.env.io, { readFile: async (path: string) => (path.endsWith('companion.jsonl') ? Promise.reject(new Error('EIO')) : (w.files.get(path) ?? null)) })
    expect(await read()).toBeNull()
    clock(w, NOW + bound + 1)
    const taken = await read()
    expect(taken).toMatchObject({ status: 'done', outcome: { kind: 'step', result: { event: 'ok' } } })
    expect(taken?.summary).toContain('(no stop gate line within 42 min)')
    expect(hold.size).toBe(0)
  })

  test('a turn that ends before the gate line is held, the entry runs on, the agent is not lost, and the next pass ends it', async () => {
    const w = world()
    gated(w)
    const build = await spawned(w, stepAction('build'))
    w.env.live.ledger = [build.entry]
    // the real build contract and module, which read a `cannot` from the answer alone
    recorded(w, build.entry.key, 'build', { result: 'cannot', reason: 'no way' })
    const between: Between = { answering: new Set(), completedSeen: new Map(), repairing: new Map(), gateHeld: new Map() }
    const r = await agentAnswered(w.env, state(), { agentId: 'agent-1', answer: 'done', reason: 'answer' }, between)
    expect(r).toEqual({ result: 'held', key: build.entry.key })
    expect(w.env.live.ledger[0]).toMatchObject({ status: 'running' })
    expect(between.gateHeld.has('agent-1')).toBe(true)
    // listed completed, long after: still at work while held
    const listed = [{ id: 'agent-1', status: 'completed' as const }]
    const seen = new Map<string, number>([['agent-1', NOW - MIN]])
    expect(reconcilable(listed, new Set(), seen, NOW + MIN, new Map(), between.gateHeld, gateHoldMs(w.env.rt.config))).toEqual([{ id: 'agent-1', status: 'running' }])
    // past the bound the hold lapses and the list judges it again
    expect(reconcilable(listed, new Set(), seen, NOW + 43 * MIN, new Map(), between.gateHeld, gateHoldMs(w.env.rt.config))).toEqual(listed)
    between.gateHeld.set('agent-1', NOW)
    gateLine(w, {})
    const [taken] = await stepAnswers(w.env.live.ledger, e => ctxOf(w.env, state(), e), undefined, between.gateHeld)
    expect(taken?.exec.summary).toContain('(after its gate-pass at')
    // and a turn that ends after the line is taken at once
    const again = await agentAnswered(w.env, state(), { agentId: 'agent-1', answer: 'done', reason: 'answer' }, between)
    expect(again).toMatchObject({ result: 'applied' })
  })
})
