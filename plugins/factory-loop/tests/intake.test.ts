// The intake reader's dry run (issue #1151; epic #995): the answer contract field by field, the parse
// of the reader's final message, the notice and the prompt, `/factory stamp <N>` through the control
// parser, and the whole dry run in the engine's test host (tests/host.ts) with the issue read and git
// stubbed: it answers at once, spawns the reader on the resolved model, notices once, and leaves
// GitHub, the events, the store and the ledger as they were.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { CONTROL_TOOL, FACTORY_COMMAND, HINT_OPS, MEANING, OPS, USAGE, formatOp, helpText, hintText, issuesOf, parseOp } from '../hooks/control'
import { checkIntake } from '../hooks/v2/contracts-intake.mjs'
import { startStamp, stampEnded, stampJob } from '../hooks/driver-stamp'
import { S } from '../hooks/driver-state'
import { INTAKE_AGENT, parseIntakeAnswer, readIssue, stampNotice, startingText, topLevelListing } from '../hooks/v2/intake'
import { COMMAND_RULE } from '../hooks/v2/prompts-triage'
import { intakePrompt } from '../hooks/v2/prompts-intake'
import type { Runtime } from '../hooks/observe'
import { NOW } from './fixtures'
import { LOOP_DIR, REPO, agentDone, host, ENGINE_TEST } from './host'
import type { Host, Reply } from './host'

const AREAS = ['factory', 'product']
const GOOD = { area: 'factory', needs_owner: false, reason: 'a loop change', touches: ['plugins', 'docs'] }

describe('checkIntake (contracts-intake.mjs)', () => {
  test('a valid answer is ok, trimmed, with nothing dropped', () => {
    expect(checkIntake({ ...GOOD, reason: '  a loop change  ' }, AREAS)).toEqual({ kind: 'ok', area: 'factory', needsOwner: false, reason: 'a loop change', touches: ['plugins', 'docs'], dropped: [], problems: [] })
    expect(checkIntake({ ...GOOD, touches: [] }, AREAS).kind).toBe('ok')
  })

  const cases: [string, Record<string, unknown>, string[]][] = [
    ['an area outside intakeAreas', { ...GOOD, area: 'other' }, ['area']],
    ['an area that is no text', { ...GOOD, area: 3 }, ['area']],
    ['needs_owner as text', { ...GOOD, needs_owner: 'yes' }, ['needs_owner']],
    ['a reason with a newline', { ...GOOD, reason: 'a\nb' }, ['reason']],
    ['an empty reason', { ...GOOD, reason: '   ' }, ['reason']],
    ['a reason of 201 characters', { ...GOOD, reason: 'x'.repeat(201) }, ['reason']],
    ['touches that is no list', { ...GOOD, touches: 'plugins' }, ['touches']],
    ['one bad touches entry', { ...GOOD, touches: ['plugins', 'a/b'] }, ['touches']],
    ['an entry of ..', { ...GOOD, touches: ['..'] }, ['touches']],
    ['an entry of .', { ...GOOD, touches: ['.'] }, ['touches']],
    ['an entry that is no text', { ...GOOD, touches: [3] }, ['touches']],
    ['a duplicate entry', { ...GOOD, touches: ['docs', 'docs'] }, ['touches']],
    ['21 entries', { ...GOOD, touches: Array.from({ length: 21 }, (_, i) => `d${i}`) }, ['touches']],
    ['an unknown key', { ...GOOD, extra: 1 }, ['extra']],
    ['an absent field', { area: 'factory', needs_owner: false, reason: 'ok' }, ['touches']],
  ]
  for (const [name, input, dropped] of cases) {
    test(`${name} is dropped, named, and the rest is kept`, () => {
      const r = checkIntake(input, AREAS)
      expect(r.kind).toBe('dropped')
      expect(r.dropped).toEqual(dropped)
      expect(r.problems).toHaveLength(dropped.length)
    })
  }

  test('20 distinct entries are kept', () => {
    const touches = Array.from({ length: 20 }, (_, i) => `d${i}`)
    expect(checkIntake({ ...GOOD, touches }, AREAS)).toMatchObject({ kind: 'ok', touches })
  })

  test('one bad touches entry drops the whole field and only it', () => {
    expect(checkIntake({ ...GOOD, touches: ['plugins', '..'] }, AREAS)).toMatchObject({ area: 'factory', needsOwner: false, reason: 'a loop change', touches: null })
  })

  test('needs_owner true with no valid reason drops both fields; with one, keeps them', () => {
    for (const bad of [undefined, '', 'a\nb', 'x'.repeat(201), 4]) {
      const r = checkIntake({ ...GOOD, needs_owner: true, reason: bad }, AREAS)
      expect(r).toMatchObject({ kind: 'dropped', area: 'factory', needsOwner: null, reason: null })
      expect(r.dropped.sort()).toEqual(['needs_owner', 'reason'])
    }
    expect(checkIntake({ ...GOOD, needs_owner: true, reason: 'needs a decision' }, AREAS)).toMatchObject({ kind: 'ok', needsOwner: true, reason: 'needs a decision' })
  })

  test('needs_owner false drops a bad reason on its own', () => {
    expect(checkIntake({ ...GOOD, reason: '' }, AREAS)).toMatchObject({ kind: 'dropped', needsOwner: false, reason: null, dropped: ['reason'] })
  })

  test('a bad needs_owner leaves a valid reason', () => {
    expect(checkIntake({ ...GOOD, needs_owner: 'maybe' }, AREAS)).toMatchObject({ needsOwner: null, reason: 'a loop change' })
  })

  test('failed: no object, or every field bad', () => {
    for (const input of [[], [GOOD], 'text', 5, null, undefined]) expect(checkIntake(input, AREAS)).toMatchObject({ kind: 'failed', area: null, needsOwner: null, reason: null, touches: null })
    const r = checkIntake({ area: 'x', needs_owner: 'y', reason: '', touches: 'z' }, AREAS)
    expect(r.kind).toBe('failed')
    expect(r.dropped.sort()).toEqual(['area', 'needs_owner', 'reason', 'touches'])
    expect(checkIntake({}, AREAS).kind).toBe('failed')
  })
})

describe('parseIntakeAnswer', () => {
  const json = JSON.stringify(GOOD)
  test('bare JSON, fenced JSON and prose around one object all give the result', () => {
    for (const text of [json, `${json}\n`, `\`\`\`json\n${json}\n\`\`\``, `Here is my answer:\n${json}\nThat is all.`]) {
      expect(parseIntakeAnswer(text, AREAS)).toMatchObject({ kind: 'ok', area: 'factory' })
    }
  })
  test('braces inside a string do not end the object', () => {
    const text = `prose ${JSON.stringify({ ...GOOD, reason: 'a } and { b' })} end`
    expect(parseIntakeAnswer(text, AREAS)).toMatchObject({ kind: 'ok', reason: 'a } and { b' })
  })
  test('two objects, none, or one that does not parse are failed, and nothing is repaired', () => {
    expect(parseIntakeAnswer(`${json} ${json}`, AREAS)).toMatchObject({ kind: 'failed', problems: [expect.stringContaining('2 JSON objects')] })
    expect(parseIntakeAnswer('I cannot decide.', AREAS)).toMatchObject({ kind: 'failed', problems: [expect.stringContaining('no JSON object')] })
    expect(parseIntakeAnswer('{"area": factory}', AREAS).kind).toBe('failed')
    expect(parseIntakeAnswer('[1,2]', AREAS).kind).toBe('failed')
    expect(parseIntakeAnswer('', AREAS).kind).toBe('failed')
  })
})

describe('the notice, the prompt and the reads', () => {
  test('the notice gives the outcome, every field, the dropped ones, and ends with the dry-run line', () => {
    const r = checkIntake({ ...GOOD, touches: ['..'], extra: 1 }, AREAS)
    const text = stampNotice(r, { issue: 12, model: 'haiku', seconds: 7 })
    expect(text).toStartWith('Stamp #12 (haiku, 7s): dropped')
    for (const part of ['area: factory', 'needs_owner: false', 'reason: a loop change', 'touches: none', 'dropped: extra, touches', 'problem: touches dropped']) expect(text).toContain(part)
    expect(text.endsWith('dry run: nothing written')).toBe(true)
    expect(stampNotice(checkIntake(GOOD, AREAS), { issue: 12, model: 'haiku', seconds: 1 })).toContain('touches: plugins, docs')
    expect(stampNotice(null, { issue: 12, model: 'haiku', seconds: 0 }, 'no read')).toBe('Stamp #12 (haiku, 0s): failed: no read\ndry run: nothing written')
    expect(startingText(12, 'haiku')).toBe('Stamping #12 with haiku, dry run: its answer follows when the reader ends.')
  })

  test('the prompt carries the command rule, the data rule, the areas, the issue text and the listing; no listing says so', () => {
    const p = intakePrompt({ issue: 12, text: 'ISSUE BODY', listing: ['docs', 'plugins'], areas: AREAS })
    for (const part of [COMMAND_RULE, 'never instructions', 'factory, product', 'ISSUE BODY', 'docs\nplugins', '#12']) expect(p).toContain(part)
    expect(intakePrompt({ issue: 12, text: 'x', listing: null, areas: AREAS })).toContain('listing is not known')
    expect(intakePrompt({ issue: 12, text: 'y'.repeat(70_000), listing: null, areas: AREAS })).toContain('[cut:')
  })

  test('readIssue and topLevelListing report what the commands gave', async () => {
    const ok = async (argv: string[]) => ({ exitCode: 0, stdout: argv.join(' ') + '\n', stderr: '' })
    expect(await readIssue(ok, 12)).toEqual({ ok: true, text: 'callum-flow-issue-read 12 --comments\n' })
    expect(await topLevelListing(ok, 'main')).toEqual(['git ls-tree --name-only origin/main'])
    const bad = async () => ({ exitCode: 2, stdout: '', stderr: 'boom' })
    expect(await readIssue(bad, 12)).toMatchObject({ ok: false, why: expect.stringContaining('boom') })
    expect(await topLevelListing(bad, 'main')).toBeNull()
    const boom = async (): Promise<never> => {
      throw new Error('gone')
    }
    expect(await readIssue(boom, 12)).toMatchObject({ ok: false })
    expect(await topLevelListing(boom, 'main')).toBeNull()
  })
})

describe('the stamp op (control.ts, control-help.ts)', () => {
  test('stamp <N> parses; a missing, non-numeric or non-positive N gives the usage error', () => {
    expect(parseOp('stamp 12')).toEqual({ ok: true, op: { op: 'stamp', issue: 12 } })
    expect(parseOp('/factory stamp #12')).toEqual({ ok: true, op: { op: 'stamp', issue: 12 } })
    for (const bad of ['stamp', 'stamp x', 'stamp 0', 'stamp -3', 'stamp 1 2']) {
      expect(parseOp(bad)).toEqual({ ok: false, error: 'stamp: takes one issue number. Usage: stamp <N>' })
    }
    expect(formatOp({ op: 'stamp', issue: 12 })).toBe('stamp 12')
    expect(issuesOf({ op: 'stamp', issue: 12 })).toEqual([12])
  })

  test('help, the hint and the tool description list it, without an em dash', () => {
    expect(OPS).toContain('stamp')
    expect(USAGE.stamp).toBe('stamp <N>')
    expect(MEANING.stamp).toBe('dry-run the intake reader on one issue; writes nothing')
    expect(HINT_OPS.some(([name]) => name === 'stamp')).toBe(true)
    expect(helpText()).toContain('stamp <N>')
    expect(hintText()).toContain('stamp <N>')
    expect(CONTROL_TOOL.description).toContain('stamp <N>')
    const dash = String.fromCharCode(0x2014)
    for (const text of [helpText(), hintText(), CONTROL_TOOL.description ?? '', FACTORY_COMMAND.description, startingText(1, 'haiku'), stampNotice(null, { issue: 1, model: 'm', seconds: 0 }, 'why')]) expect(text.includes(dash)).toBe(false)
  })
})

// --- the dry run, end to end ---------------------------------------------------------------------
//
// The engine's test host hands a plugin's $.agent.spawn no agent id (tests/driver.test.ts, header), so
// the whole run to a reader's answer is driven below through a fake $ (driver-stamp.ts), and the
// host tests cover the command, the reply, the spawn and the failures that need no id.

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const ISSUE = 'Title: Make the loop faster\n\nBody of issue 12.\n\n--- comment by owner ---\nplease'
const ANSWER = JSON.stringify({ area: 'factory', needs_owner: true, reason: 'needs a choice', touches: ['plugins', 'docs'] })

async function factoryOp($: Engine, args: string) {
  return $.command.run({ command: 'factory', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

type Gate = { agentId?: string; deny?: string }

// a world with the issue read and git stubbed, 5 s in so the first pass has read the checkout
function world(on: Parameters<typeof host>[0], over: { config?: Record<string, unknown>; read?: Reply; spawn?: () => Gate | Promise<Gate> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const h = host(on, {
    config: { repo: REPO, runSource: 'events', shadowDevice: 'dev', checkout: '/work', ...over.config },
    run: argv => {
      if (argv[0] === 'callum-flow-issue-read' && argv[1] === '12' && argv[2] === '--comments') return over.read ?? { stdout: ISSUE }
      if (argv[0] === 'git' && argv[1] === 'ls-tree') return { stdout: 'docs\nplugins\nREADME.md\n' }
      return undefined
    },
    ...(over.spawn === undefined ? {} : { spawn: over.spawn }),
  })
  return { clock, h }
}

const extra = (h: Host, before: number) => h.commands().slice(before).map(s => s.argv.join(' '))
const snapshot = (h: Host) => JSON.stringify([...h.store.entries()])

describe('/factory stamp <N> in the engine test host', () => {
  for (const mode of ['observe', 'act'] as const) {
    test(`${mode} mode, intakeStamp off: it answers at once, spawns the reader on the model and writes nothing`, ENGINE_TEST, async ($, on) => {
      let release: (r: Gate) => void = () => undefined
      const gate = new Promise<Gate>(res => {
        release = res
      })
      const { clock, h } = world(on, { config: { mode, intakeModel: 'sonnet' }, spawn: () => gate })
      await $.session.start(START)
      await clock.advance(6_000)
      const stored = snapshot(h)
      const before = h.commands().length
      const prompts = h.prompts.length

      const reply = await factoryOp($, 'stamp 12')
      // the reply came back while the spawn is still unresolved
      expect(reply.text).toBe('Stamping #12 with sonnet, dry run: its answer follows when the reader ends.')
      await clock.settle()
      expect(h.spawns).toHaveLength(1)
      expect(h.prompts).toHaveLength(prompts)
      // a second stamp of the same issue starts nothing
      expect((await factoryOp($, 'stamp 12')).text).toBe('already stamping #12')
      await clock.settle()
      expect(h.spawns).toHaveLength(1)

      const spawn = h.spawns[0]
      expect(spawn).toMatchObject({ subagentType: INTAKE_AGENT, model: 'sonnet' })
      expect(spawn?.prompt).toContain('Body of issue 12.')
      expect(spawn?.prompt).toContain('docs\nplugins\nREADME.md')
      expect(spawn?.prompt.startsWith('factory-slot:')).toBe(false)

      release({ deny: 'test host' })
      await clock.settle()
      expect(h.prompts.slice(prompts)).toEqual([expect.stringContaining('failed: the reader could not start (test host)')])

      // only the two reads ran: no gh, no event; the store (ledger, records, stamps) is as it was
      expect(extra(h, before).filter(c => !c.startsWith('callum-flow-event --new-only'))).toEqual(['callum-flow-issue-read 12 --comments', 'git ls-tree --name-only origin/main'])
      expect(h.events().filter(e => e.includes('--type'))).toEqual([])
      expect(snapshot(h)).toBe(stored)
      expect(h.stops).toEqual([])
      expect(h.lines().filter(l => l.stamp === 12)).toEqual([expect.objectContaining({ stamp: 12, outcome: 'failed', model: 'sonnet', seconds: 0 })])

      // the stamp is over: it can run again
      expect((await factoryOp($, 'stamp 12')).text).toStartWith('Stamping #12')
      await clock.settle()
    })
  }

  test('the model is intakeModel, haiku by default', ENGINE_TEST, async ($, on) => {
    const { clock, h } = world(on)
    await $.session.start(START)
    await clock.advance(6_000)
    expect((await factoryOp($, 'stamp 12')).text).toStartWith('Stamping #12 with haiku,')
    await clock.settle()
    expect(h.spawns[0]?.model).toBe('haiku')
  })

  test('the control tool takes it, an agent may too (a view op), and a bad N is refused', ENGINE_TEST, async ($, on) => {
    const { clock, h } = world(on)
    await $.session.start(START)
    await clock.advance(6_000)
    expect(await $.tool.call({ tool: 'mcp__factory-loop__control', op: 'stamp x' })).toMatchObject({ deny: 'stamp: takes one issue number. Usage: stamp <N>' })
    expect(await $.tool.call({ tool: 'mcp__factory-loop__control', op: 'stamp 12', agentId: 'agent-9' })).toMatchObject({ result: expect.stringContaining('Stamping #12 with haiku') })
    await clock.settle()
    expect(h.spawns).toHaveLength(1)
  })

  test('a failed issue read is reported at once as a failed stamp, with its reason, and spawns nothing', ENGINE_TEST, async ($, on) => {
    const { clock, h } = world(on, { read: { exitCode: 1, stderr: 'rate limited' } })
    await $.session.start(START)
    await clock.advance(6_000)
    const prompts = h.prompts.length
    await factoryOp($, 'stamp 12')
    await clock.settle()
    expect(h.spawns).toEqual([])
    const notices = h.prompts.slice(prompts)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('failed: the issue could not be read')
    expect(notices[0]).toContain('rate limited')
    expect(notices[0]?.endsWith('dry run: nothing written')).toBe(true)
    expect(h.lines().filter(l => l.stamp === 12)).toEqual([expect.objectContaining({ outcome: 'failed' })])
    // it is over: the next stamp is not "already stamping"
    expect((await factoryOp($, 'stamp 12')).text).toStartWith('Stamping #12')
    await clock.settle()
  })

  test('without a known default branch the listing is left out and the prompt says so', ENGINE_TEST, async ($, on) => {
    const { clock, h } = world(on)
    await $.session.start(START)
    // no pass yet: the checkout state is not known
    await factoryOp($, 'stamp 12')
    await clock.settle()
    expect(h.spawns[0]?.prompt).toContain('listing is not known')
    expect(h.commands().some(s => s.argv[0] === 'git' && s.argv[1] === 'ls-tree')).toBe(false)
  })

  test('a turn end of an agent that is no stamp starts no notice and leaves the stamp waiting', ENGINE_TEST, async ($, on) => {
    let release: (r: Gate) => void = () => undefined
    const { clock, h } = world(on, { config: { mode: 'act' }, spawn: () => new Promise<Gate>(res => (release = res)) })
    await $.session.start(START)
    await clock.advance(6_000)
    await factoryOp($, 'stamp 12')
    await clock.settle()
    await agentDone($, h, 'someone-else', 'ANSWER x')
    await clock.settle()
    expect(h.prompts.filter(p => p.startsWith('Stamp #'))).toEqual([])
    expect((await factoryOp($, 'stamp 12')).text).toBe('already stamping #12')
    release({ deny: 'end of test' })
    await clock.settle()
  })
})

// a fake $ for the reader's whole run: the issue read, the listing, the spawn (with an id), the notices, the clock's timers
function fake(over: { read?: { exitCode: number; stdout: string; stderr: string }; spawn?: Gate } = {}) {
  let now = NOW
  const prompts: string[] = []
  const spawns: Record<string, unknown>[] = []
  const logged: string[] = []
  const timers: { ms: number; fn: () => void; live: boolean }[] = []
  const $ = {
    clock: {
      now: async () => now,
      after: (ms: number, fn: () => void) => {
        const t = { ms, fn, live: true }
        timers.push(t)
        return {
          cancel: () => {
            t.live = false
          },
        }
      },
    },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        if (argv[0] === 'sh') {
          logged.push(init?.stdin ?? '')
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'callum-flow-issue-read') return over.read ?? { exitCode: 0, stdout: ISSUE, stderr: '' }
        return { exitCode: 0, stdout: 'docs\nplugins\n', stderr: '' }
      },
    },
    agent: {
      spawn: async (args: Record<string, unknown>) => {
        spawns.push(args)
        return over.spawn ?? { agentId: 'reader-1' }
      },
    },
    prompt: {
      submit: async (p: { text: string }) => {
        prompts.push(p.text)
        return {}
      },
    },
  } as unknown as EngineInterface
  const rt = { repo: REPO, cwd: '/work', env: {}, loopDir: LOOP_DIR, config: { intakeModel: 'haiku', intakeAreas: AREAS } } as unknown as Runtime
  return {
    $,
    rt,
    prompts,
    spawns,
    logged,
    advance: (ms: number) => {
      now += ms
      for (const t of timers.filter(x => x.live && x.ms <= ms)) {
        t.live = false
        t.fn()
      }
    },
  }
}

async function stamp(f: ReturnType<typeof fake>, issue = 12) {
  S.stamping.clear()
  S.checkout = { branch: 'main', head: null, defaultBranch: 'main', dirty: [] }
  S.stampJob = (rt, run) => void stampJob(f.$, rt, run)
  const reply = startStamp(f.rt, issue, NOW)
  // the job runs on its own; let its awaits finish
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 5))
  return reply
}

const turn = (answer: string, reason = 'answer') => ({ agentId: 'reader-1', answer, reason })

describe('a stamp from the reply to the notice (driver-stamp.ts, fake $)', () => {
  test('the reader is spawned on the model with the issue and the listing; its answer gives one notice and one log line; nothing else is written', async () => {
    const f = fake()
    expect(await stamp(f)).toBe('Stamping #12 with haiku, dry run: its answer follows when the reader ends.')
    expect(f.spawns).toHaveLength(1)
    expect(f.spawns[0]).toMatchObject({ subagentType: INTAKE_AGENT, model: 'haiku' })
    expect(String(f.spawns[0]?.prompt)).toContain('Body of issue 12.')
    expect(String(f.spawns[0]?.prompt)).toContain('docs\nplugins')
    expect(startStamp(f.rt, 12, NOW)).toBe('already stamping #12')

    f.advance(7_000)
    expect(await stampEnded(f.$, turn(`\`\`\`json\n${ANSWER}\n\`\`\``))).toBe(true)
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]).toStartWith('Stamp #12 (haiku, 7s): ok')
    expect(f.prompts[0]).toContain('needs_owner: true')
    expect(f.prompts[0]).toContain('reason: needs a choice')
    expect(f.prompts[0]).toContain('touches: plugins, docs')
    expect(f.prompts[0]?.endsWith('dry run: nothing written')).toBe(true)
    expect(f.logged).toHaveLength(1)
    expect(JSON.parse(f.logged[0] ?? '{}')).toMatchObject({ stamp: 12, outcome: 'ok', model: 'haiku', seconds: 7 })
    expect(S.stamping.size).toBe(0)
    // the same agent's turn is not a stamp's any more
    expect(await stampEnded(f.$, turn(ANSWER))).toBe(false)
    expect(f.prompts).toHaveLength(1)
  })

  test('a turn end of another agent is not a stamp: false, no notice, the stamp stays', async () => {
    const f = fake()
    await stamp(f)
    expect(await stampEnded(f.$, { agentId: 'other', answer: 'ANSWER x', reason: 'answer' })).toBe(false)
    expect(f.prompts).toEqual([])
    expect(S.stamping.size).toBe(1)
  })

  test('an answer with a dropped field is dropped, and the notice names it', async () => {
    const f = fake()
    await stamp(f)
    await stampEnded(f.$, turn(JSON.stringify({ area: 'nope', needs_owner: false, reason: 'r', touches: [] })))
    expect(f.prompts[0]).toStartWith('Stamp #12 (haiku, 0s): dropped')
    expect(f.prompts[0]).toContain('dropped: area')
  })

  test('an unreadable answer is failed, once, with no repair', async () => {
    const f = fake()
    await stamp(f)
    await stampEnded(f.$, turn('I think it is a factory issue.'))
    expect(f.prompts).toEqual([expect.stringContaining('Stamp #12 (haiku, 0s): failed')])
  })

  test('a turn that ends without an answer is failed', async () => {
    const f = fake()
    await stamp(f)
    await stampEnded(f.$, turn('', 'aborted'))
    expect(f.prompts).toEqual([expect.stringContaining('ended without an answer (aborted)')])
  })

  test('a reader that does not end within 10 minutes is failed once and forgotten', async () => {
    const f = fake()
    await stamp(f)
    f.advance(9 * 60_000)
    expect(f.prompts).toEqual([])
    f.advance(10 * 60_000)
    await new Promise(r => setTimeout(r, 5))
    expect(f.prompts).toEqual([expect.stringContaining('did not end its turn within 10 minutes')])
    expect(S.stamping.size).toBe(0)
    // a late turn end reports nothing more
    expect(await stampEnded(f.$, turn(ANSWER))).toBe(false)
    expect(f.prompts).toHaveLength(1)
  })

  test('a failed issue read and a refused spawn are failed stamps with their reasons', async () => {
    const a = fake({ read: { exitCode: 1, stdout: '', stderr: 'no such issue' } })
    await stamp(a)
    expect(a.prompts).toEqual([expect.stringContaining('failed: the issue could not be read (exit 1: no such issue)')])
    expect(a.spawns).toEqual([])
    const b = fake({ spawn: { deny: 'no such agent' } })
    await stamp(b)
    expect(b.prompts).toEqual([expect.stringContaining('failed: the reader could not start (no such agent)')])
    expect(S.stamping.size).toBe(0)
  })
})

