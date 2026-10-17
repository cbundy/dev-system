// The designer's, the builder's and the fixer's steps (docs/factory-loop/v2/SPEC.md 4.2, 5.1, 7.1,
// 8.1, 8.7, 9.7, 10.2 to 10.5, 10.8): their answer contracts (contracts-work.mjs), their prompts
// (prompts-work.ts), how each step runs and reads its answer (steps-work.ts, through the generic
// agent-step executor with the real step modules and contracts), and the designer's plan side
// (rules-work.ts, through planV2): the brief posted before the step is ok, the question parked, the
// split's children made in their order before the step is not-ok. Keys are found by the key codec
// (keys.ts), never as literals.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { jobPathOf, parseJob } from '../hooks/contract.mjs'
import type { ActIo, SpawnInput } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { commentBody } from '../hooks/v2/act-state'
import { CONTRACTS, rolloutOf, rolloutReasonOf } from '../hooks/v2/contracts-work.mjs'
import { childKey, entryKey, lifeOf, prepareKey, reviewKey, stepKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { COMMAND_RULE, FOREGROUND_RULE, TEST_POLICY, buildPrompt, checkId, checkIdsOf, checkNote, designPrompt, fixPrompt, neutralBody } from '../hooks/v2/prompts-work'
import type { FixInput, WorkInput } from '../hooks/v2/prompts-work'
import { fixWhyOf } from '../hooks/v2/rules-agent'
import { stepAnswerPath, stepAnswered, stepExecutor, stepRecorded } from '../hooks/v2/steps'
import { errorFindings, routedModel } from '../hooks/v2/steps-work'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES } from '../hooks/v2/types'
import type { AgentStep, IssueRecord, IssueState, Lease, StepResult, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, issue, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 2 * HOUR)
const SHA = (c: string) => c.repeat(40).slice(0, 40)
const BRIEF_URL = (n: number) => `https://github.com/${REPO}/issues/${n}#issuecomment-${1000 + n}`
const BIN = `${PLUGIN_ROOT}/bin/factory-answer`
const BRIEF = ['## Design brief (designer, 2026-10-13)', '', '## Acceptance criteria', '- it works', '', '## Observability', 'none - no new decision', '', '## Rollout', 'merge - a self-contained change', ''].join('\n')

// --- worlds, as v2-state.test.ts builds them ------------------------------------------------------------

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, state: 'building', step: 'build', since: NOW - 20 * MIN, ...over }
}

const SLOT = (n: number) => `/slots/${n}`
const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: SLOT(r.issue), lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })
const OK = { ok: true, at: NOW }

function world(records: IssueRecord[], over: Partial<State> = {}, v2: Partial<V2State> = {}): State {
  const s = baseState(over)
  return { ...s, v2: { ...emptyV2State(NOW, records), sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK }, leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor), ...v2 } }
}

const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })
const plan = (s: State): PlanResult => planV2(s, CFG)
const of = (r: PlanResult, n: number): Action[] => r.actions.filter(a => a.issue === n && a.kind !== 'title')
const said = (r: PlanResult, n: number) => r.skipped.filter(s => s.issue === n).map(s => s.why)
const transitionOf = (r: PlanResult, n: number) => r.actions.find((a): a is Extract<Action, { kind: 'transition' }> => a.kind === 'transition' && a.issue === n)

function done(key: string, kind: LedgerEntry['kind'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(key, kind, { startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, ...over })
}

function stepDone(r: IssueRecord, step: AgentStep, result: Partial<StepResult>, over: Partial<LedgerEntry> = {}): LedgerEntry {
  const full: StepResult = { event: 'ok', reason: null, why: null, head: null, choice: null, data: null, ...result }
  return done(stepKey(r, step, r.attempt), 'agent-step', { issue: r.issue, class: step === 'design' || step === 'build' ? 'develop' : 'drive', step, agentId: 'agent-1', outcome: { kind: 'step', step, result: full }, ...over })
}

// --- the contracts (8.1, 8.7, 9.7) ---------------------------------------------------------------------------

const check = (name: 'design-v2' | 'build' | 'fix', input: unknown, data?: Record<string, unknown>) =>
  CONTRACTS[name].check(input, { contract: name, purpose: null, repo: REPO, issue: 300, branch: 'issue-300', ...(data === undefined ? {} : { data }) })
const problems = (name: 'design-v2' | 'build' | 'fix', input: unknown, data?: Record<string, unknown>) => {
  const c = check(name, input, data)
  return c.ok ? [] : c.problems
}

const REASONS = { why_split: 'It spans the loop and the image', why_count: 'Two: one per side', why_parts: 'The image ships on its own', why_order: 'The image waits on the loop' }

describe('the design-v2 contract (8.7)', () => {
  test('a brief with its heading and a Rollout callum-flow-rollout reads is taken whole; a question and a split too', () => {
    expect(check('design-v2', { kind: 'brief', brief: BRIEF })).toEqual({ ok: true, outcome: { kind: 'brief', brief: BRIEF.trim(), question: null, reasons: null, children: [] } })
    expect(check('design-v2', { kind: 'question', question: 'Which API?', brief: null })).toEqual({ ok: true, outcome: { kind: 'question', brief: null, question: 'Which API?', reasons: null, children: [] } })
    const children = [
      { key: 'a', title: 'Part one', why: 'The loop side', body: BRIEF, blockedBy: [], ready: true },
      { key: 'b', title: 'Part two', why: 'The image side', body: BRIEF, blockedBy: ['a'], ready: false },
    ]
    // texts are kept trimmed
    expect(check('design-v2', { kind: 'split', brief: 'the plan', reasons: { ...REASONS, why_count: '  Two: one per side  ' }, children })).toEqual({
      ok: true,
      outcome: { kind: 'split', brief: 'the plan', question: null, reasons: REASONS, children: children.map(c => ({ ...c, body: c.body.trim() })) },
    })
  })

  test('a blockedBy entry may be #<N>, an existing issue; the issue being split, a malformed reference and a stranger are each refused', () => {
    const child = (key: string, blockedBy: unknown[] = []) => ({ key, title: `Part ${key}`, why: `why ${key}`, body: BRIEF, blockedBy, ready: true })
    const split = (...children: unknown[]) => ({ kind: 'split', brief: 'p', reasons: REASONS, children })
    const out = check('design-v2', split(child('a'), child('b', ['a', '#57'])))
    expect(out).toMatchObject({ ok: true })
    if (out.ok) expect(out.outcome.children[1]?.blockedBy).toEqual(['a', '#57'])
    const dup = check('design-v2', split(child('a', ['#57', '#57']), child('b')))
    if (dup.ok) expect(dup.outcome.children[0]?.blockedBy).toEqual(['#57'])
    else throw new Error('refused')
    // the same external issue on two children forms no cycle
    expect(problems('design-v2', split(child('a', ['#57']), child('b', ['#57', 'a'])))).toEqual([])
    for (const bad of ['#0', '#x', '#057']) {
      expect(problems('design-v2', split(child('a', [bad]), child('b')))).toEqual([`children[0].blockedBy "${bad}" is not an issue reference: write #<N>, N a positive number with no leading zero`])
    }
    for (const bad of ['57', 57, 'zz']) {
      expect(problems('design-v2', split(child('a', [bad]), child('b')))).toEqual([`children[0].blockedBy ${JSON.stringify(bad)} is neither the key of another child nor an existing issue #<N>`])
    }
    expect(problems('design-v2', split(child('a', ['#300']), child('b')))).toEqual(['children[0].blockedBy #300 is the issue being split, which stays open, so the child would wait forever'])
  })

  test('every problem is named at once: the heading, the Rollout, a stray field, the field another kind needs', () => {
    expect(problems('design-v2', { kind: 'brief', brief: 'no heading\n## Rollout\nship it', extra: 1 })).toEqual([
      'extra is not a field of a design answer (only kind, brief, question, context, options, recommendation, reasons, children)',
      'brief must start with its heading: ## Design brief (designer, <YYYY-MM-DD>)',
      'brief\'s ## Rollout must start with one of merge, run-it, keep-open, not "ship"',
      'brief must have an ## Observability section: each decision the change adds and where it is recorded, or "none - no new decision"',
    ])
    expect(problems('design-v2', { kind: 'question' })).toEqual(['question is required'])
    expect(problems('design-v2', { kind: 'brief', brief: BRIEF, question: 'why?' })).toEqual(['question must be absent or null here'])
    expect(problems('design-v2', { kind: 'nope' })).toEqual(['kind "nope" is not one of brief, question, split', 'brief is required'])
    expect(problems('design-v2', 'a brief')).toHaveLength(1)
  })

  test('a brief must say what it makes observable: an empty or missing ## Observability is refused', () => {
    const OBS = '## Observability\nnone - no new decision\n\n'
    expect(problems('design-v2', { kind: 'brief', brief: BRIEF.replace(OBS, '') })).toEqual([
      'brief must have an ## Observability section: each decision the change adds and where it is recorded, or "none - no new decision"',
    ])
    expect(problems('design-v2', { kind: 'brief', brief: BRIEF.replace(OBS, '## Observability\n\n') })).toHaveLength(1)
    expect(problems('design-v2', { kind: 'brief', brief: BRIEF.replace('none - no new decision', '- the split choice - abandoned.reasons - why issues split') })).toEqual([])
  })

  test('a split has 2 to 10 children with unique keys, siblings it is blocked by, and no cycle', () => {
    const child = (key: string, blockedBy: string[] = []) => ({ key, title: `Part ${key}`, why: `why ${key}`, body: BRIEF, blockedBy, ready: true })
    expect(problems('design-v2', { kind: 'split', brief: 'p', reasons: REASONS, children: [child('a')] })).toEqual(['children has 1; a split has 2 to 10'])
    expect(problems('design-v2', { kind: 'split', brief: 'p', reasons: REASONS, children: [child('a', ['c']), child('a')] })).toEqual(['children[0].blockedBy "c" is neither the key of another child nor an existing issue #<N>', 'children[1].key a is used twice'])
    expect(problems('design-v2', { kind: 'split', brief: 'p', reasons: REASONS, children: [child('a', ['b']), child('b', ['a'])] })).toEqual(["children's blockedBy make a cycle: a -> b -> a"])
    expect(problems('design-v2', { kind: 'split', brief: 'p', reasons: REASONS, children: [child('A b'), { ...child('c'), title: 'two\nlines', ready: 'yes' }] })).toEqual([
      'children[0].key "A b" must be a short lower-case key: letters, digits and dashes, at most 24',
      'children[1].title must be one line',
      'children[1].ready must be true or false',
    ])
  })

  test('rolloutOf reads the Rollout as callum-flow-rollout does: the first line under its heading, outside fenced code', () => {
    expect(rolloutOf('## Rollout\n\n**Run-it** - the epic says so\n')).toBe('run-it')
    expect(rolloutOf('```\n## Rollout\nmerge\n```\n## rollout\nkeep-open - x')).toBe('keep-open')
    expect(rolloutOf('## Rollout\n## Next\nmerge')).toBeNull()
    expect(rolloutOf('no section')).toBeNull()
  })

  test('rolloutReasonOf reads the reason after the value and its dash, ignoring fenced code', () => {
    expect(rolloutReasonOf('## Rollout\nkeep-open - research spike, no code\n')).toBe('research spike, no code')
    expect(rolloutReasonOf('```\n## Rollout\nmerge - no\n```\n## Rollout\n**run-it** \u2014 its own Run it')).toBe('its own Run it')
    expect(rolloutReasonOf('## Rollout\nmerge')).toBe('')
    expect(rolloutReasonOf('no section')).toBeNull()
  })

  test('a split must give four reasons and a why for each child, each short text; every problem is named at once', () => {
    const child = (key: string) => ({ key, title: `Part ${key}`, why: `why ${key}`, body: BRIEF, blockedBy: [], ready: true })
    const split = (extra: Record<string, unknown>) => ({ kind: 'split', brief: 'p', children: [child('a'), child('b')], ...extra })
    expect(problems('design-v2', split({}))).toEqual(['reasons is required for a split: { why_split, why_count, why_parts, why_order }'])
    expect(problems('design-v2', split({ reasons: null }))).toEqual(['reasons is required for a split: { why_split, why_count, why_parts, why_order }'])
    expect(problems('design-v2', split({ reasons: 'because' }))).toEqual(['reasons must be an object { why_split, why_count, why_parts, why_order }, not "because"'])
    expect(problems('design-v2', split({ reasons: ['x'] }))).toHaveLength(1)
    for (const key of Object.keys(REASONS)) {
      const { [key]: _gone, ...without } = REASONS as Record<string, string>
      expect(problems('design-v2', split({ reasons: without }))).toEqual([`reasons.${key} is required`])
      expect(problems('design-v2', split({ reasons: { ...REASONS, [key]: '   ' } }))).toEqual([`reasons.${key} must be text, not "   "`])
      expect(problems('design-v2', split({ reasons: { ...REASONS, [key]: 'x'.repeat(501) } }))).toEqual([`reasons.${key} is 501 characters; at most 500`])
      expect(problems('design-v2', split({ reasons: { ...REASONS, [key]: 'x'.repeat(500) } }))).toEqual([])
    }
    expect(problems('design-v2', split({ reasons: { ...REASONS, why_extra: 'x' } }))).toEqual(['why_extra is not a field of reasons (only why_split, why_count, why_parts, why_order)'])
    const kids = (c: Record<string, unknown>) => split({ reasons: REASONS, children: [c, child('b')] })
    const { why: _why, ...noWhy } = child('a')
    expect(problems('design-v2', kids(noWhy))).toEqual(['children[0] (a).why is required'])
    expect(problems('design-v2', kids({ ...child('a'), why: ' ' }))).toEqual(['children[0] (a).why must be text, not " "'])
    expect(problems('design-v2', kids({ ...child('a'), why: 'two\nlines' }))).toEqual(['children[0] (a).why must be one line'])
    expect(problems('design-v2', kids({ ...child('a'), why: 'x'.repeat(201) }))).toEqual(['children[0] (a).why is 201 characters; at most 200'])
    expect(problems('design-v2', kids({ ...child('a'), why: 'x'.repeat(200) }))).toEqual([])
    expect(problems('design-v2', { kind: 'brief', brief: BRIEF, reasons: REASONS })).toEqual(['reasons must be absent or null unless kind is split'])
    expect(problems('design-v2', { kind: 'question', question: 'q?', reasons: REASONS })).toEqual(['reasons must be absent or null unless kind is split'])
    expect(problems('design-v2', { kind: 'brief', brief: BRIEF, reasons: null })).toEqual([])
  })

  test('a keep-open that says the issue is part of something larger is refused, in a brief and in a split child; other reasons are taken', () => {
    const rollout = (line: string) => BRIEF.replace('merge - a self-contained change', line)
    const split = (body: string) => ({ kind: 'split', brief: 'p', reasons: REASONS, children: [{ key: 'a', title: 'A', why: 'a', body, blockedBy: [], ready: true }, { key: 'b', title: 'B', why: 'b', body: BRIEF, blockedBy: [], ready: true }] })
    for (const reason of ['one part of epic #724', 'part of epic #724', 'Part of #724, split by the factory loop', 'a sub-issue of the plan', 'child of #5', 'the EPIC']) {
      const line = `keep-open - ${reason}`
      expect(problems('design-v2', { kind: 'brief', brief: rollout(line) })[0]).toMatch(/a split child is done when its PR merges, so its Rollout is merge/)
      const out = problems('design-v2', split(rollout(line)))
      expect(out).toHaveLength(1)
      expect(out[0]).toMatch(/^children\[0\] \(a\) body's ## Rollout is keep-open because it is part of something larger/)
    }
    for (const line of ['keep-open - research spike, no code to ship', 'keep-open - a proposal', 'run-it - its own ## Run it', 'merge - part of an epic, done when merged', 'keep-open - the Done-when needs a person (departure)']) {
      expect(problems('design-v2', { kind: 'brief', brief: rollout(line) })).toEqual([])
      expect(problems('design-v2', split(rollout(line)))).toEqual([])
    }
  })

  test('a split child body with no Rollout, or a Rollout that is not merge, run-it or keep-open, is refused naming the child', () => {
    const split = (body: string) => ({ kind: 'split', brief: 'p', reasons: REASONS, children: [{ key: 'a', title: 'A', why: 'a', body: BRIEF, blockedBy: [], ready: true }, { key: 'b', title: 'B', why: 'b', body, blockedBy: [], ready: true }] })
    expect(problems('design-v2', split('just a body'))).toEqual(["children[1] (b) body's ## Rollout must start with one of merge, run-it, keep-open"])
    expect(problems('design-v2', split(BRIEF.replace('merge - a self-contained change', 'ship - now')))).toEqual(['children[1] (b) body\'s ## Rollout must start with one of merge, run-it, keep-open, not "ship"'])
  })
})

describe('the build and fix contracts (8.1, 9.7)', () => {
  test('built names its head, a one-line title, a summary and its evidence; cannot names only its reason', () => {
    const built = { result: 'built', head: SHA('A'), title: 'Add the thing', summary: 'It adds the thing.', evidence: 'npm test: 3 pass' }
    expect(check('build', built)).toEqual({ ok: true, outcome: { ...built, head: SHA('a'), reason: null } })
    expect(check('build', { result: 'cannot', reason: 'the API is missing' })).toEqual({ ok: true, outcome: { result: 'cannot', head: null, title: null, summary: null, evidence: null, reason: 'the API is missing' } })
    expect(problems('build', { result: 'built', head: 'xyz', title: `${'t'.repeat(73)}`, summary: '' })).toEqual([
      'head "xyz" is not a commit SHA of 7 to 40 hex digits',
      'title is 73 characters; at most 72',
      'summary must be text, not ""',
    ])
    expect(problems('build', { result: 'cannot', reason: 'r', head: SHA('a') })).toEqual(['head must be absent or null here'])
  })

  test('fix: each finding fixed or declined with a reason; a declined fix pushes nothing and declines all; the job names the findings each needing a disposition', () => {
    const fixed = { result: 'fixed', head: SHA('b'), summary: 'fixed the parser', findings: [{ id: 'r2-1', disposition: 'fixed', reason: 'done' }, { id: 'r2-2', disposition: 'declined', reason: 'wrong' }] }
    expect(check('fix', fixed, { findings: ['r2-1', 'r2-2'] })).toEqual({ ok: true, outcome: { ...fixed, evidence: null } })
    expect(problems('fix', fixed, { findings: ['r2-1', 'r2-3'] })).toEqual(['finding r2-3 has no disposition: fix it, or decline it with a reason'])
    expect(problems('fix', { result: 'declined', summary: 's', findings: [] })).toEqual(['a declined fix names each finding it declines, with its reason'])
    expect(problems('fix', { result: 'declined', summary: 's', head: SHA('c'), findings: [{ id: 'r2-1', disposition: 'fixed', reason: 'x' }] })).toEqual([
      'head must be absent or null here',
      'findings: r2-1 is fixed, so the result is fixed, with the head you pushed',
    ])
    expect(problems('fix', { result: 'fixed', summary: 's', findings: [{ id: 'r2-1', disposition: 'maybe' }, { id: 'r2-1', disposition: 'fixed', reason: 'x' }] })).toEqual([
      'head is required: the commit you pushed, 7 to 40 hex digits',
      'findings[0].disposition "maybe" is not one of fixed, declined',
      'findings[0].reason is required',
      'findings[1].id r2-1 is given twice',
    ])
  })

  test('fix: the answer may give the PR\'s evidence, as a build does, fixed or declined', () => {
    const shot = 'Screenshot: ![page](https://github.com/o/r/blob/abc1234/docs/shot.png?raw=true)'
    const fixed = { result: 'fixed', head: SHA('b'), summary: 'added the screenshot', evidence: shot, findings: [{ id: 'r2-1', disposition: 'fixed', reason: 'done' }] }
    expect(check('fix', fixed)).toEqual({ ok: true, outcome: fixed })
    const declined = { result: 'declined', summary: 's', evidence: shot, findings: [{ id: 'r2-1', disposition: 'declined', reason: 'it was there' }] }
    expect(check('fix', declined)).toEqual({ ok: true, outcome: { ...declined, head: null } })
    expect(problems('fix', { ...fixed, evidence: 'e'.repeat(4001) })).toEqual(['evidence is 4001 characters; at most 4000'])
    expect(problems('fix', { ...fixed, evidence: 7 })).toEqual([expect.stringMatching(/^evidence /)])
  })
})

// --- the prompts (5.1, 8.7, 9.7, 10.3 to 10.5) -------------------------------------------------------------------

const SCRATCH = `${LOOP_DIR}/scratch/300-${LIFE}-s2`
const PLACE = { bin: BIN, file: `${LOOP_DIR}/answers/x.answer.json` }
function input(over: Partial<WorkInput> = {}): WorkInput {
  return { repo: REPO, issue: 300, slot: SLOT(300), branch: 'issue-300', base: 'main', head: null, pr: null, brief: BRIEF_URL(300), attempt: 1, notes: [], prior: null, leftovers: null, gateCommands: ['npm run lint', 'npm test'], scratch: SCRATCH, place: PLACE, ...over }
}
const fixInput = (over: Partial<FixInput> = {}): FixInput => ({ ...input(), round: 2, why: 'review', reviewAnswer: `${LOOP_DIR}/answers/r.answer.json`, findings: ['r2-1'], ...over })

describe('the work prompts (prompts-work.ts)', () => {
  const all = () => [designPrompt({ ...input(), inFlight: [{ issue: 301, branch: 'issue-301' }] }), buildPrompt(input()), fixPrompt(fixInput())]

  test('each starts with the slot line, carries CLAUDE.md, the foreground and command rules, and the answer script with this attempt\'s file', () => {
    for (const p of all()) {
      expect(p.split('\n')[0]).toBe(`factory-slot: ${SLOT(300)}`)
      expect(p).toContain(`Read CLAUDE.md first. ${FOREGROUND_RULE} ${COMMAND_RULE}`)
      expect(p).toContain(`${BIN} --to ${PLACE.file}`)
      expect(p).toContain(`https://github.com/${REPO}/issues/300`)
    }
    // no slot, no slot line
    expect(buildPrompt(input({ slot: null })).startsWith('You are the factory loop\'s builder')).toBe(true)
  })

  test('each names the step\'s scratch folder once as $TMPDIR, and none sends the agent to /tmp', () => {
    for (const p of all()) {
      expect(p.split(`Your scratch folder is ${SCRATCH}.`)).toHaveLength(2)
      expect(p).toContain('It is $TMPDIR in every Bash call. Write scratch files only there: not in the system temp folder and not in the session scratchpad.')
      expect(p).not.toContain('/tmp')
    }
  })

  test('no prompt names the pipeline the loop no longer runs, or asks for what the write guard refuses', () => {
    for (const p of all()) {
      expect(p).not.toMatch(/\baxi\b|no-mistakes|implement-issue/)
      expect(p).not.toMatch(/gh (pr|issue) (create|edit|comment|close|merge)|--force|git rebase|git switch -c|git checkout -b/)
    }
  })

  test('writers commit and push the record\'s branch only, run the gates, and carry the test policy; the designer reads only', () => {
    for (const p of [buildPrompt(input()), fixPrompt(fixInput())]) {
      expect(p).toContain('push only with `git push origin issue-300`')
      expect(p).toContain(TEST_POLICY)
      expect(p).toContain('When you end your turn the loop runs `npm run lint`, then `npm test` in this slot')
      expect(p).toContain("While debugging, run only the suite you are changing, as the repo's CLAUDE.md names, then the full commands once.")
    }
    // a repo that sets no gate commands has no stop gate: the writer is not told one backs it
    for (const p of [buildPrompt(input({ gateCommands: [] })), fixPrompt({ ...fixInput(), gateCommands: [' ', ''] })]) {
      expect(p).toContain('in the foreground and let them finish: they must pass before you answer. While debugging, run only the suite you are changing, as the repo\'s CLAUDE.md names, then the full commands once. CI on the PR is the final gate.')
      expect(p).not.toContain('When you end your turn the loop runs')
    }
    const design = designPrompt({ ...input(), inFlight: [{ issue: 301, branch: 'issue-301' }, { issue: 300, branch: 'issue-300' }] })
    expect(design).toContain('A split child is a whole issue')
    expect(design).toContain('never because it is part of an epic or a split')
    // the split shape names the reasons, their four keys and each child's why
    expect(design).toContain('"reasons": {"why_split"')
    for (const k of ['why_split', 'why_count', 'why_parts', 'why_order']) expect(design).toContain(`"${k}"`)
    expect(design).toContain('"title": "<one line>", "why": "<one line>"')
    expect(design).toContain('you change nothing in the repository')
    expect(design).not.toContain('git push origin')
    expect(design).toContain('  issue-301, for issue #301')
    expect(design).not.toContain('issue-300, for issue #300')
    expect(design).toContain(`write it to ${SCRATCH}/factory-design-300.md with Bash`)
    expect(design).toContain(`jq -n --rawfile brief ${SCRATCH}/factory-design-300.md '{"kind": "brief", "brief": $brief}' | ${BIN} --to ${PLACE.file}`)
  })

  test('writers are told how an image reaches the PR body the loop writes: by a URL, the repo\'s route, a commit-pinned blob URL', () => {
    for (const p of [buildPrompt(input()), fixPrompt(fixInput())]) {
      expect(p).toContain(`https://github.com/${REPO}/blob/<sha>/<path>?raw=true`)
      expect(p).toContain('the repo\'s documented evidence route')
    }
    expect(fixPrompt(fixInput())).toContain('"evidence"')
    // a repo's own screenshot command starts its server and stops it: the command rule lets it run
    expect(COMMAND_RULE).toContain('A repo command that starts what it needs and stops it before it exits counts as a command known to exit.')
    // the rule about a glob under a variable ends it (#674): the agents' definitions carry it word for word
    expect(COMMAND_RULE.endsWith('Never `rm` a glob under an unguarded variable: use `"${VAR:?}"/*` or a literal path.')).toBe(true)
  })

  test('free text is neutralized: a closing keyword in a note or a check name links nothing; ids that are not ids are dropped', () => {
    const p = fixPrompt(fixInput({ notes: ['Fixes #12 then closes #13', checkNote('ci resolves #14', 'https://github.com/x/y/actions/runs/1')], findings: ['r2-1', 'bad id; rm -rf'] }))
    expect(p).toContain('Fixing #12 then closing #13')
    expect(p).toContain('ci resolving #14')
    expect(p).toContain('Give each of these findings a disposition: r2-1.')
    expect(p).not.toContain('rm -rf')
    expect(buildPrompt(input({ branch: 'issue-300; rm -rf /' }))).not.toContain('rm -rf')
    expect(buildPrompt(input({ brief: 'https://evil.example/x' }))).toContain('Design brief: none recorded.')
  })

  test('a retry names the previous attempt\'s result, its files and, to a writer, the leftovers patch (5.1)', () => {
    const prior = { key: 'i300/lx/s3/build/a1', status: 'done (unknown: timeout)', summary: 'build #300: unknown', reason: 'the step ran past its 90 min', files: [`${LOOP_DIR}/spawns/x.json`] }
    const leftovers = `${LOOP_DIR}/leftovers/300-${LIFE}-s4-1760000000000.patch`
    for (const p of [buildPrompt(input({ attempt: 2, prior, leftovers })), fixPrompt(fixInput({ attempt: 2, prior, leftovers }))]) {
      expect(p).toContain('This is attempt 2. The previous attempt (i300/lx/s3/build/a1) ended done (unknown: timeout): build #300: unknown')
      expect(p).toContain('    the step ran past its 90 min')
      expect(p).toContain(`  file: ${LOOP_DIR}/spawns/x.json`)
      expect(p).toContain(`saved as a patch: ${leftovers}`)
    }
    // the designer is a reader: it gets the previous attempt, never a patch to apply
    const design = designPrompt({ ...input({ attempt: 2, prior, leftovers }), inFlight: [] })
    expect(design).toContain('This is attempt 2. The previous attempt (i300/lx/s3/build/a1)')
    expect(design).not.toContain('git apply')
    expect(design).not.toContain(leftovers)
  })

  test('the fixer is told why it runs: the review\'s findings and answer, a failed check\'s log, a conflict to merge', () => {
    expect(fixPrompt(fixInput())).toContain(`The review's answer, with every finding: ${LOOP_DIR}/answers/r.answer.json`)
    const note = checkNote('Base image result', 'https://github.com/x/y/actions/runs/7/job/70')
    const ci = fixPrompt(fixInput({ why: 'ci', pr: 512, notes: [note], findings: checkIdsOf([note]) }))
    expect(ci).toContain('The notes below name each failed check with its id and run link (when none does, list them with `gh pr checks 512')
    expect(ci).toContain('  failed check check:7-70: Base image result, https://github.com/x/y/actions/runs/7/job/70')
    expect(ci).toContain('Give each of these findings a disposition: check:7-70.')
    expect(fixPrompt(fixInput({ why: 'conflict' }))).toContain('Merge origin/main into issue-300')
    expect(fixPrompt(fixInput({ why: null }))).toContain('the notes below say what')
  })

  test('a failed check\'s id fits the fix contract whatever its name: its run and job, else its name with dashes', () => {
    const ids = [
      checkId('Base image result', 'https://github.com/x/y/actions/runs/7/job/70'),
      checkId('test (ubuntu-latest, 20)', 'https://github.com/x/y/actions/runs/8'),
      checkId('test (ubuntu-latest, 20)', null),
      checkId('  ', 'https://example.com/status'),
    ]
    expect(ids).toEqual(['check:7-70', 'check:8', 'check:test-ubuntu-latest-20', 'check:unnamed'])
    for (const id of ids) expect(problems('fix', { result: 'declined', summary: 's', findings: [{ id, disposition: 'declined', reason: 'main is red' }] })).toEqual([])
    // each once, from the notes alone
    expect(checkIdsOf(['the review asked for more', checkNote('a', 'https://github.com/x/y/actions/runs/1/job/2'), checkNote('a', 'https://github.com/x/y/actions/runs/1/job/2')])).toEqual(['check:1-2'])
  })

  test('neutralBody keeps a long text whole, past neutral()\'s 4000 characters, with its indents and every closing keyword rewritten', () => {
    const long = [BRIEF, ...Array.from({ length: 400 }, (_, i) => `  - line ${i}: fixes #${i}`)].join('\n')
    const out = neutralBody(long)
    expect(out.length).toBeGreaterThan(8000)
    expect(out).toContain('## Rollout\nmerge - a self-contained change')
    expect(out).toContain('  - line 399: fixing #399')
    expect(out).not.toMatch(/\bfixes #/)
    expect(neutralBody('x'.repeat(100), 50)).toHaveLength(50)
    // the comment a brief is posted as carries it whole (act-state.ts commentBody)
    expect(commentBody(long, 'k')).toContain('line 399')
  })

  test('neutralBody keeps every blank line and indent, at any length, and never cuts a long line', () => {
    // paragraphs and indented code across what were 3500-character blocks
    const para = (i: number) => `Paragraph ${i}: ${'word '.repeat(150).trim()}`
    const text = Array.from({ length: 12 }, (_, i) => `${para(i)}\n\n    code ${i}();\n`).join('\n')
    expect(text.length).toBeGreaterThan(9000)
    expect(neutralBody(text)).toBe(text.trimEnd())
    // one line past neutral()'s 4000 characters is kept whole
    const line = `${'a'.repeat(5000)} fixes #12 ${'b'.repeat(100)}`
    expect(neutralBody(line)).toBe(`${'a'.repeat(5000)} fixing #12 ${'b'.repeat(100)}`)
    // a reference on the next line is still a reference; leading blank lines go, indents stay
    expect(neutralBody('\n\n  closes\n#12\r\nok\u0007')).toBe('  closing\n#12\nok')
  })
})

// --- the steps, run and read (steps-work.ts through steps.ts) --------------------------------------------------

type Reply = { exitCode?: number; stdout?: string; stderr?: string }

function rt(): Runtime {
  return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: CFG, configProblems: [] }
}

// harness: the act step's world for one record's agent step: a recording ActIo whose commands
// answer by reply, a file system, and the state the pass planned from.
function harness(r: IssueRecord, reply: (argv: string[]) => Reply = () => ({}), ledger: LedgerEntry[] = [], over: Partial<State> = {}) {
  const files = new Map<string, string>()
  const spawns: SpawnInput[] = []
  const runs: { argv: string[]; cwd: string | undefined }[] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => {
      runs.push({ argv: [...argv], cwd: init.cwd })
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    spawnAgent: async input => {
      spawns.push(input)
      return { agentId: 'agent-1' }
    },
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async path => files.get(path) ?? null,
    writeFile: async (path, text) => void files.set(path, text),
  }
  const env: ActEnv = { io, rt: rt(), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  const s = withLedger(world([r], over), ledger)
  const action = (step: AgentStep): Extract<Action, { kind: 'agent-step' }> => ({
    kind: 'agent-step',
    key: stepKey(r, step, r.attempt),
    class: step === 'design' || step === 'build' ? 'develop' : 'drive',
    rule: 'S2',
    reason: 'step',
    issue: r.issue,
    step,
    life: r.life,
    seq: r.seq,
    attempt: r.attempt,
    branch: r.branch,
    slot: SLOT(r.issue),
    notes: ['owner: keep it small'],
  })
  const spawn = async (step: AgentStep) => {
    const a = action(step)
    const e = start([], a, NOW).entry
    const exec = await stepExecutor()(ctxOf(env, s, e), a)
    return { exec, entry: exec.status === 'running' && exec.agentId !== undefined ? { ...e, agentId: exec.agentId } : e }
  }
  const answer = (step: AgentStep, contract: string, value: unknown) => files.set(stepAnswerPath(LOOP_DIR, action(step).key), `${JSON.stringify({ v: 1, contract, answer: value })}\n`)
  // the result the step's entry ends with at its turn's end, or read by a pass before it
  const atEnd = async (e: LedgerEntry) => (await stepAnswered(ctxOf(env, s, e), e, { agentId: 'agent-1', answer: 'done', reason: 'answer' })).exec
  const early = async (e: LedgerEntry) => stepRecorded(ctxOf(env, s, e), e, false)
  // the turn ended in error after the answer was recorded
  const inError = async (e: LedgerEntry) => (await stepAnswered(ctxOf(env, s, e), e, { agentId: 'agent-1', answer: 'API Error: 500', reason: 'error' })).exec
  return { files, spawns, runs, spawn, answer, atEnd, early, inError }
}

const resultOf = (exec: { outcome?: unknown }): StepResult => (exec.outcome as { result: StepResult }).result

// origin: git's answers for a branch whose head is `head` with `beyond` commits past main, the
// answered head an ancestor of it or not.
function origin(branch: string, head: string | null, beyond = 2, ancestor = true): (argv: string[]) => Reply {
  return argv => {
    if (argv[0] === 'callum-flow-implementer-route') return { stdout: 'opus\n' }
    if (argv[1] === 'ls-remote') return { stdout: head === null ? '' : `${head}\trefs/heads/${branch}\n` }
    if (argv[1] === 'rev-list') return { stdout: `${beyond}\n` }
    if (argv[1] === 'merge-base') return { exitCode: ancestor ? 0 : 1 }
    return {}
  }
}

describe('the build step (4.2, 7.1, 10.8)', () => {
  const r = rec(300, { state: 'building', step: 'build', brief: BRIEF_URL(300) })
  const built = { result: 'built', head: SHA('a'), title: 'Add it', summary: 'It adds it.', evidence: null }

  test('it runs on the routed model (the route logs implementer_routed), spawns the builder in its slot, and writes the build contract\'s job', async () => {
    const h = harness(r, origin('issue-300', SHA('a')))
    const { exec } = await h.spawn('build')
    expect(exec).toMatchObject({ status: 'running', agentId: 'agent-1' })
    expect(h.runs[0]?.argv).toEqual(['callum-flow-implementer-route', '300'])
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]).toMatchObject({ subagentType: 'factory-loop:builder', model: 'opus', name: 'build-300-s3-a1' })
    expect(h.spawns[0]?.prompt.split('\n')[0]).toBe(`factory-slot: ${SLOT(300)}`)
    expect(h.spawns[0]?.prompt).toContain('owner: keep it small')
    expect(h.spawns[0]?.prompt).toContain(`Your scratch folder is ${LOOP_DIR}/scratch/300-${LIFE}-s3.`)
    const job = [...h.files.keys()].find(k => k.endsWith('.job.json')) ?? ''
    expect(jobPathOf(stepAnswerPath(LOOP_DIR, stepKey(r, 'build', 1)))).toBe(job)
    expect(parseJob(h.files.get(job) ?? '')).toEqual({ contract: 'build', purpose: null, repo: REPO, issue: 300, branch: 'issue-300' })
  })

  test('a route that fails or prints no model refuses the attempt, never retried, and spawns nothing', async () => {
    for (const reply of [{ exitCode: 2, stderr: 'usage' }, { stdout: 'sonnet\nopus\n' }]) {
      const h = harness(r, () => reply)
      expect((await h.spawn('build')).exec).toMatchObject({ status: 'failed', noRetry: true, summary: expect.stringContaining('refused: callum-flow-implementer-route 300') })
      expect(h.spawns).toEqual([])
    }
    expect(routedModel('opus\n')).toBe('opus')
    expect(routedModel('opus sonnet')).toBeNull()
  })

  test('built is ok at its turn\'s end, with origin\'s head, once origin holds the answered head and commits beyond the base; read earlier it waits for the stop gate', async () => {
    const head = SHA('b')
    const h = harness(r, origin('issue-300', head))
    const { entry: e } = await h.spawn('build')
    h.answer('build', 'build', built)
    expect(await h.early(e)).toBeNull()
    const exec = await h.atEnd(e)
    expect(resultOf(exec)).toMatchObject({ event: 'ok', head, data: { title: 'Add it', summary: 'It adds it.', head: SHA('a') } })
    // origin was read in the slot: ls-remote, fetch, ancestry, count
    expect(h.runs.slice(1).map(x => [x.argv.slice(0, 3).join(' '), x.cwd])).toEqual([
      ['git ls-remote origin', SLOT(300)],
      ['git fetch --quiet', SLOT(300)],
      ['git merge-base --is-ancestor', SLOT(300)],
      ['git rev-list --count', SLOT(300)],
    ])
  })

  test('no branch on origin, or none beyond the base, is not-ok (no-commit); a head origin does not hold, or a failed read, is unknown', async () => {
    const cases: [ReturnType<typeof origin>, Partial<StepResult>][] = [
      [origin('issue-300', null), { event: 'not-ok', reason: 'no-commit' }],
      [origin('issue-300', SHA('c'), 0), { event: 'not-ok', reason: 'no-commit' }],
      [origin('issue-300', SHA('c'), 2, false), { event: 'unknown', why: 'bad-answer' }],
      [argv => (argv[1] === 'ls-remote' ? { exitCode: 128, stderr: 'fatal: unable to access' } : origin('issue-300', SHA('c'))(argv)), { event: 'unknown', why: 'cli' }],
      [argv => (argv[1] === 'fetch' ? { exitCode: 1, stderr: 'could not fetch' } : origin('issue-300', SHA('c'))(argv)), { event: 'unknown', why: 'cli' }],
    ]
    for (const [reply, want] of cases) {
      const h = harness(r, reply)
      const { entry: e } = await h.spawn('build')
      h.answer('build', 'build', built)
      expect(resultOf(await h.atEnd(e))).toMatchObject(want)
    }
  })

  test('cannot ends the step when read, before the turn\'s end, with the builder\'s reason for the table (T6)', async () => {
    const h = harness(r, origin('issue-300', SHA('a')))
    const { entry: e } = await h.spawn('build')
    h.answer('build', 'build', { result: 'cannot', reason: 'the API is missing' })
    const exec = await h.early(e)
    expect(exec === null ? null : resultOf(exec)).toMatchObject({ event: 'not-ok', reason: 'cannot', data: { text: 'the API is missing' } })
    expect(h.runs.filter(x => x.argv[0] === 'git')).toEqual([])
  })

  test('a writer is told the newest leftovers file its life\'s slot ops saved (rules-agent.ts leftoversOf, 5.1, 10.2); none saved, no patch; the designer never', async () => {
    const saved = (key: string, op: 'prepare' | 'free', file: string | null, at: number) =>
      done(key, 'slot', { issue: 300, startedAt: at - 1000, endedAt: at, outcome: { kind: 'slot', op, path: SLOT(300), lease: 'L300', head: SHA('a'), killed: 0, leftovers: file } })
    const older = `${LOOP_DIR}/leftovers/300-${LIFE}-free-1.patch`
    const newer = `${LOOP_DIR}/leftovers/300-${LIFE}-s3-2.patch`
    const other = `${LOOP_DIR}/leftovers/300-${lifeOf(NOW - 9 * HOUR)}-s9-3.patch`
    const ledger = [saved('free:L300', 'free', older, NOW - 10 * MIN), saved(prepareKey(r, 1), 'prepare', newer, NOW - 5 * MIN), saved('free:L9', 'free', other, NOW - MIN)]
    const h = harness(r, origin('issue-300', SHA('a')), ledger)
    await h.spawn('build')
    expect(h.spawns[0]?.prompt).toContain(`saved as a patch: ${newer}.`)
    expect(h.spawns[0]?.prompt).not.toContain(older)
    expect(h.spawns[0]?.prompt).not.toContain(other)
    const clean = harness(r, origin('issue-300', SHA('a')), [saved(prepareKey(r, 1), 'prepare', null, NOW - 5 * MIN)])
    await clean.spawn('build')
    expect(clean.spawns[0]?.prompt).not.toContain('saved as a patch')
    const designer = harness(rec(300, { state: 'designing', step: 'design' }), () => ({}), ledger)
    await designer.spawn('design')
    expect(designer.spawns[0]?.prompt).not.toContain(newer)
  })
})

describe('the fix step (8.6, 9.7, 10.8)', () => {
  const r = rec(310, { state: 'fixing', step: 'fix', seq: 6, round: 2, pr: 512, head: SHA('a'), brief: BRIEF_URL(310) })
  const prepared = (head: string) => done(prepareKey(r, 1), 'slot', { issue: 310, outcome: { kind: 'slot', op: 'prepare', path: SLOT(310), lease: 'L310', head, killed: 0 } })
  const t9 = done(transitionKey(r), 'transition', { issue: 310, outcome: { kind: 'transition', row: 'T9', event: 'not-ok', cause: null, from: 'reviewing', to: 'fixing', step: 'review', stored: true, via: 'fix:review' } })
  const review = done(reviewKey(r, SHA('e'), 2, 1), 'agent-step', {
    issue: 310,
    step: 'review',
    outcome: { kind: 'step', step: 'review', result: { event: 'not-ok', reason: 'changes', why: null, head: null, choice: null, data: { findings: [{ id: 'r2-1', severity: 'error' }, { id: 'r2-2', severity: 'info' }] } } },
  })
  const declined = { result: 'declined', summary: 'both wrong', findings: [{ id: 'r2-1', disposition: 'declined', reason: 'the test covers it' }] }

  test('sent by a review, it is told the review\'s answer, and its job requires a disposition for each error finding', async () => {
    const h = harness(r, origin('issue-310', SHA('a')), [t9, review])
    await h.spawn('fix')
    expect(h.spawns[0]).toMatchObject({ subagentType: 'factory-loop:fixer', name: 'fix-310-s6-a1' })
    expect(h.spawns[0]?.prompt).toContain('The review of round 2 asked for changes.')
    expect(h.spawns[0]?.prompt).toContain(`${LOOP_DIR}/answers/`)
    const job = [...h.files.entries()].find(([k]) => k.endsWith('.job.json'))?.[1] ?? ''
    expect(parseJob(job)).toMatchObject({ contract: 'fix', data: { findings: ['r2-1'] } })
    expect(errorFindings(review)).toEqual(['r2-1'])
    expect(errorFindings(null)).toEqual([])
  })

  test('every finding declined and no new head is not-ok, read at once, the reasons for the next round (T12)', async () => {
    const h = harness(r, origin('issue-310', SHA('a')), [prepared(SHA('a'))])
    const { entry: e } = await h.spawn('fix')
    h.answer('fix', 'fix', declined)
    const exec = await h.early(e)
    expect(exec === null ? null : resultOf(exec)).toMatchObject({ event: 'not-ok', reason: 'declined', data: { notes: ['the fixer declined r2-1: the test covers it'] } })
  })

  test('a declined answer is never ok: origin moved, no prepared head, or a turn that ended in error, it is not-ok with its reasons', async () => {
    const want = { event: 'not-ok', reason: 'declined', head: null, data: { notes: ['the fixer declined r2-1: the test covers it'] } }
    // the fixer pushed something, then declined: read before its turn ends
    const moved = harness(r, origin('issue-310', SHA('b')), [prepared(SHA('a'))])
    const m = await moved.spawn('fix')
    moved.answer('fix', 'fix', declined)
    const exec = await moved.early(m.entry)
    expect(exec === null ? null : resultOf(exec)).toMatchObject(want)
    expect(resultOf(await moved.atEnd(m.entry))).toMatchObject(want)
    expect(resultOf(await moved.inError(m.entry))).toMatchObject(want)
    // no prepared head to compare with
    const unprepared = harness({ ...r, pr: null, head: null }, origin('issue-310', SHA('b')))
    const u = await unprepared.spawn('fix')
    unprepared.answer('fix', 'fix', declined)
    const early = await unprepared.early(u.entry)
    expect(early === null ? null : resultOf(early)).toMatchObject(want)
  })

  test('a retried fixer keeps the reason it was sent for: after a U2 retry it is still told the review, and its job still requires r2-1', async () => {
    const r2 = { ...r, seq: 7, attempt: 2 }
    const u2 = done(transitionKey(r2), 'transition', { issue: 310, outcome: { kind: 'transition', row: 'U2', event: 'unknown', cause: null, from: 'fixing', to: 'fixing', step: 'fix', stored: true, via: 'unknown:timeout' } })
    const h = harness(r2, origin('issue-310', SHA('a')), [t9, u2, review])
    await h.spawn('fix')
    expect(h.spawns[0]?.prompt).toContain('The review of round 2 asked for changes.')
    const job = [...h.files.entries()].find(([k]) => k.endsWith('.job.json'))?.[1] ?? ''
    expect(parseJob(job)).toMatchObject({ contract: 'fix', data: { findings: ['r2-1'] } })
  })

  test('fixWhyOf: the newest transition of the life that sent the record toward a fixer, up to its seq', () => {
    const tr = (seq: number, row: string, from: IssueState, to: IssueState, via: string) =>
      done(transitionKey({ ...r, seq }), 'transition', { issue: 310, outcome: { kind: 'transition', row, event: 'not-ok', cause: null, from, to, step: null, stored: true, via } })
    const why = (seq: number, ...ledger: LedgerEntry[]) => fixWhyOf(world([{ ...r, seq }], { ledger }), { ...r, seq })
    // T9, then a free re-run and a triage's retry inside fixing
    expect(why(8, tr(6, 'T9', 'reviewing', 'fixing', 'fix:ci'), tr(7, 'U1', 'fixing', 'fixing', 'free:usage'), tr(8, 'X1', 'fixing', 'fixing', 'triage:retry'))).toBe('ci')
    // a triage's fix (X2) is its own reason; X4 shares its via but parks, so it is not one
    expect(why(9, tr(6, 'T9', 'reviewing', 'fixing', 'fix:ci'), tr(8, 'X2', 'fixing', 'fixing', 'triage:fix'), tr(9, 'X4', 'fixing', 'parked', 'triage:fix'))).toBe('triage')
    // parked at the fix cap, resumed through queued (P1, T1): the cap's reason
    expect(why(9, tr(6, 'T9', 'reviewing', 'fixing', 'fix:review'), tr(7, 'T10', 'reviewing', 'parked', 'fix-cap:conflict'), tr(8, 'P1', 'parked', 'queued', 'unpark:op'), tr(9, 'T1', 'queued', 'fixing', 'lease'))).toBe('conflict')
    // a later seq's transition, another life's, or none: not this fixing's
    expect(why(6, tr(6, 'T9', 'reviewing', 'fixing', 'fix:review'), tr(7, 'T9', 'reviewing', 'fixing', 'fix:ci'))).toBe('review')
    expect(why(6)).toBeNull()
  })

  test('sent by red CI, the failed checks come from the record\'s notes (T9), and its job requires a disposition for each', async () => {
    const note = checkNote('Base image result', 'https://github.com/x/y/actions/runs/7/job/70')
    const rc = { ...r, notes: [note] }
    const t9ci = done(transitionKey(rc), 'transition', { issue: 310, outcome: { kind: 'transition', row: 'T9', event: 'not-ok', cause: null, from: 'merge-queue', to: 'fixing', step: 'queue', stored: true, via: 'fix:ci' } })
    const h = harness(rc, origin('issue-310', SHA('a')), [t9ci])
    await h.spawn('fix')
    expect(h.spawns[0]?.prompt).toContain('A check on the PR failed after its one re-run.')
    expect(h.spawns[0]?.prompt).toContain('Give each of these findings a disposition: check:7-70.')
    const job = [...h.files.entries()].find(([k]) => k.endsWith('.job.json'))?.[1] ?? ''
    expect(parseJob(job)).toMatchObject({ contract: 'fix', data: { findings: ['check:7-70'] } })
  })

  test('a new head against the prepared one is ok at the turn\'s end; a fix that says it pushed while origin did not move is unknown', async () => {
    const moved = harness(r, origin('issue-310', SHA('b')), [prepared(SHA('a'))])
    const { entry: e } = await moved.spawn('fix')
    moved.answer('fix', 'fix', { result: 'fixed', head: SHA('b'), summary: 'fixed', findings: [{ id: 'r2-1', disposition: 'fixed', reason: 'done' }] })
    expect(await moved.early(e)).toBeNull()
    expect(resultOf(await moved.atEnd(e))).toMatchObject({ event: 'ok', head: SHA('b') })
    const still = harness(r, origin('issue-310', SHA('a')), [prepared(SHA('a'))])
    const s2 = await still.spawn('fix')
    still.answer('fix', 'fix', { result: 'fixed', head: SHA('b'), summary: 'fixed', findings: [] })
    expect(resultOf(await still.atEnd(s2.entry))).toMatchObject({ event: 'unknown', why: 'bad-answer' })
  })
})

describe('the design step (8.7)', () => {
  test('the designer is spawned as a reader on the issue\'s model label, and its answer means a brief (ok), a question or a split (not-ok)', async () => {
    const r = rec(320, { state: 'designing', step: 'design' })
    const h = harness(r, () => ({}), [], { issues: [issue(320, { labels: ['model:sonnet', 'ready'] })] })
    await h.spawn('design')
    expect(h.spawns[0]).toMatchObject({ subagentType: 'factory-loop:designer-v2', model: 'sonnet' })
    expect(h.runs).toEqual([])
    const { entry: e } = await h.spawn('design')
    h.answer('design', 'design-v2', { kind: 'question', question: 'Which API?' })
    expect(resultOf(await h.atEnd(e))).toMatchObject({ event: 'not-ok', reason: 'question' })
    h.answer('design', 'design-v2', { kind: 'brief', brief: BRIEF })
    expect(resultOf(await h.atEnd(e))).toMatchObject({ event: 'ok', data: { kind: 'brief', brief: BRIEF.trim() } })
  })
})

// --- the designer's plan side (rules-work.ts, through planV2) ---------------------------------------------------

const DESIGNED = (brief: string) => ({ kind: 'brief', brief, question: null, children: [] })

describe('the designer\'s plan (8.7, T2 to T4)', () => {
  const r = rec(330, { state: 'designing', step: 'design' })
  const comment = entryKey(r, 'comment')
  const answered = (data: unknown, event: 'ok' | 'not-ok' = 'ok') => stepDone(r, 'design', { event, reason: event === 'ok' ? null : 'question', data })

  test('a brief is posted on the issue, whole, before the step is ok; its comment\'s URL is the record\'s brief (T2)', () => {
    const long = `${BRIEF}\n${'x'.repeat(6000)}`
    const p = plan(withLedger(world([r]), [answered(DESIGNED(long))]))
    expect(transitionOf(p, 330)).toBeUndefined()
    expect(of(p, 330)).toEqual([expect.objectContaining({ kind: 'comment', key: comment, on: 'issue', number: 330, body: long })])
    const running = plan(withLedger(world([r]), [answered(DESIGNED(long)), entry(comment, 'comment', { issue: 330, status: 'running', endedAt: null })]))
    expect(of(running, 330)).toEqual([])
    expect(said(running, 330)).toContain('the brief on the issue: it runs')
    const posted = plan(withLedger(world([r]), [answered(DESIGNED(long)), done(comment, 'comment', { issue: 330, outcome: { kind: 'cli', exit: 0, detail: BRIEF_URL(330) } })]))
    expect(transitionOf(posted, 330)).toMatchObject({ row: 'T2', next: { state: 'building', brief: BRIEF_URL(330) } })
  })

  test('a brief comment that used up its attempts holds the record, and the owner hears (4.5)', () => {
    const p = plan(withLedger(world([r]), [answered(DESIGNED(BRIEF)), entry(comment, 'comment', { issue: 330, status: 'failed', attempts: 3, summary: 'gh issue comment: exit 1' })]))
    expect(transitionOf(p, 330)).toBeUndefined()
    expect(said(p, 330)).toContain(`stalled: ${comment}: gh issue comment: exit 1`)
  })

  test('a question parks the record with it at once, posting nothing (T3)', () => {
    const p = plan(withLedger(world([r]), [answered({ kind: 'question', brief: null, question: 'Which API?', children: [] }, 'not-ok')]))
    expect(of(p, 330).filter(a => a.kind === 'comment')).toEqual([])
    expect(transitionOf(p, 330)).toMatchObject({ row: 'T3', next: { state: 'parked', question: 'Which API?', resumeTo: 'designing' } })
  })

  test('a split makes each child once the siblings it waits on exist, then posts the plan, then closes the record (T4); the parent\'s release lists the children', () => {
    const children = [
      { key: 'b', title: 'Part two', why: 'Waits on the owner', body: 'two', blockedBy: ['a'], ready: false },
      { key: 'a', title: 'Part one', why: 'The loop side', body: 'one', blockedBy: [], ready: true },
      { key: 'c', title: 'Part three', why: 'The image side', body: 'three', blockedBy: [], ready: true },
    ]
    const split = stepDone(r, 'design', { event: 'not-ok', reason: 'split', data: { kind: 'split', brief: 'the plan', question: null, reasons: REASONS, children } })
    const first = plan(withLedger(world([r]), [split]))
    const made = (a: Action) => (a.kind === 'split' ? [a.child.key, a.blockedBy] : [])
    expect(of(first, 330).map(made)).toEqual([['a', []], ['c', []]])
    const child = (key: string, n: number) => done(childKey(r, key), 'split', { issue: 330, outcome: { kind: 'split', child: n } })
    const second = plan(withLedger(world([r]), [split, child('a', 601), child('c', 603)]))
    expect(of(second, 330).map(made)).toEqual([['b', [601]]])
    expect(transitionOf(second, 330)).toBeUndefined()
    const third = plan(withLedger(world([r]), [split, child('a', 601), child('c', 603), child('b', 602)]))
    const post = of(third, 330).find((a): a is Extract<Action, { kind: 'comment' }> => a.kind === 'comment')
    expect(post?.body).toBe(
      [
        'the plan',
        '',
        'Why this split:',
        `- Why split: ${REASONS.why_split}`,
        `- Why this many parts: ${REASONS.why_count}`,
        `- Why these parts: ${REASONS.why_parts}`,
        `- Why this order: ${REASONS.why_order}`,
        '',
        'Split by the factory loop into:',
        '- #602: Part two - Waits on the owner (waits on an owner decision)',
        '- #601: Part one - The loop side',
        '- #603: Part three - The image side',
      ].join('\n'),
    )
    const posted = done(entryKey(r, 'comment'), 'comment', { issue: 330, outcome: { kind: 'cli', exit: 0, detail: BRIEF_URL(330) } })
    const t = transitionOf(plan(withLedger(world([r]), [split, child('a', 601), child('c', 603), child('b', 602), posted])), 330)
    expect(t).toMatchObject({ row: 'T4', next: { state: 'closed', why: 'split', notes: ['split into #602, #601, #603'] } })
    if (t === undefined) return
    const after = plan(withLedger(world([t.next]), [split, child('a', 601), child('c', 603), child('b', 602), posted, done(t.key, 'transition', { issue: 330, outcome: { kind: 'transition', row: 'T4', event: 'not-ok', cause: null, from: 'designing', to: 'closed', step: 'design', stored: true, via: 'split' } })]))
    expect(of(after, 330).find(a => a.kind === 'release-parent')).toMatchObject({ created: [601, 602, 603], reasons: REASONS, childWhys: ['The loop side', 'Waits on the owner', 'The image side'] })
    // the design entry gone from the ledger: the release still happens, with null reasons
    const gone = plan(withLedger(world([t.next]), [child('a', 601), child('c', 603), child('b', 602), posted, done(t.key, 'transition', { issue: 330, outcome: { kind: 'transition', row: 'T4', event: 'not-ok', cause: null, from: 'designing', to: 'closed', step: 'design', stored: true, via: 'split' } })]))
    expect(of(gone, 330).find(a => a.kind === 'release-parent')).toMatchObject({ created: [601, 602, 603], reasons: null, childWhys: null })
  })

  test('an older design answer with no reasons or whys still plans: the comment lists the children as before, the release carries null', () => {
    const children = [
      { key: 'a', title: 'Part one', body: 'one', blockedBy: [], ready: true },
      { key: 'b', title: 'Part two', body: 'two', blockedBy: [], ready: true },
    ]
    const split = stepDone(r, 'design', { event: 'not-ok', reason: 'split', data: { kind: 'split', brief: 'the plan', question: null, children } })
    const child = (key: string, n: number) => done(childKey(r, key), 'split', { issue: 330, outcome: { kind: 'split', child: n } })
    const post = of(plan(withLedger(world([r]), [split, child('a', 601), child('b', 602)])), 330).find((a): a is Extract<Action, { kind: 'comment' }> => a.kind === 'comment')
    expect(post?.body).toBe('the plan\n\nSplit by the factory loop into:\n- #601: Part one\n- #602: Part two')
  })

  test('a child blocked by an existing issue is made in the first pass with it, and its sibling follows with both', () => {
    const children = [
      { key: 'a', title: 'Part one', body: 'one', blockedBy: ['#57'], ready: true },
      { key: 'b', title: 'Part two', body: 'two', blockedBy: ['a', '#57'], ready: true },
    ]
    const split = stepDone(r, 'design', { event: 'not-ok', reason: 'split', data: { kind: 'split', brief: 'the plan', question: null, children } })
    const made = (a: Action) => (a.kind === 'split' ? [a.child.key, a.blockedBy] : [])
    expect(of(plan(withLedger(world([r]), [split])), 330).map(made)).toEqual([['a', [57]]])
    const a = done(childKey(r, 'a'), 'split', { issue: 330, outcome: { kind: 'split', child: 601 } })
    expect(of(plan(withLedger(world([r]), [split, a])), 330).map(made)).toEqual([['b', [601, 57]]])
  })

  test('a design answer with no kind the plan reads goes down the unknown path', () => {
    expect(transitionOf(plan(withLedger(world([r]), [answered({ brief: 'x' })])), 330)).toMatchObject({ row: 'U2', via: 'unknown:bad-answer' })
  })
})

describe('the builder\'s and the fixer\'s results through the table (T5, T6, T11, T12)', () => {
  test('a build with its head on origin goes to reviewing; no commit to triage; a fixer\'s new head back to review, its declines too, as notes', () => {
    const b = rec(340)
    expect(transitionOf(plan(withLedger(world([b]), [stepDone(b, 'build', { event: 'ok', head: SHA('a'), data: { result: 'built', title: 't' } })])), 340)).toMatchObject({ row: 'T5', next: { state: 'reviewing', head: SHA('a'), round: 1 } })
    expect(transitionOf(plan(withLedger(world([b]), [stepDone(b, 'build', { event: 'not-ok', reason: 'no-commit', data: { text: 'origin has no branch issue-340' } })])), 340)).toMatchObject({
      row: 'T6',
      next: { step: 'triage', notes: [expect.stringContaining('origin has no branch issue-340')] },
    })
    const f = rec(341, { state: 'fixing', step: 'fix', round: 1 })
    expect(transitionOf(plan(withLedger(world([f]), [stepDone(f, 'fix', { event: 'ok', head: SHA('b') })])), 341)).toMatchObject({ row: 'T11', next: { state: 'reviewing', head: SHA('b'), round: 2 } })
    const notes = ['the fixer declined r1-1: the test covers it']
    expect(transitionOf(plan(withLedger(world([f]), [stepDone(f, 'fix', { event: 'not-ok', reason: 'declined', data: { notes } })])), 341)).toMatchObject({ row: 'T12', next: { state: 'reviewing', notes, round: 2 } })
  })
})
