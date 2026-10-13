// The spawn prompts (prompts.ts, SPEC 6.3): what each template carries, and what none may: a
// brief's content, or a GitHub closing keyword (I-33). Every template is rendered with benign
// inputs, where its own text must hold none of the nine keyword words at all, and with hostile
// inputs in every free-text and id field, where no keyword may come to stand before an issue
// reference and no brief content may get through.
import { describe, expect, test } from 'claude-code/testing'

import { CHECKOUT_RULE, descriptionOf, nameOf, neutral, promptOf } from '../hooks/prompts'
import type { AgentAction, PromptEnv } from '../hooks/prompts'
import { DESIGNER_RESULT, HANDOFF_RESULT } from '../hooks/replies'
import type { AdjudicatorPurpose, FixerPurpose } from '../hooks/types'

const REPO = 'cbundy/dev-system'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-3301234567'
const ENV: PromptEnv = { repo: REPO, modelOverride: null, inFlight: [] }

// Any of GitHub's nine closing keywords, as a word.
const KEYWORD = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i
// A keyword that an issue reference follows closely: what GitHub could read as closing.
const CLOSING_REF = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\W{0,6}(#|gh-\d|https?:|[\w.-]+\/[\w.-]+#)/i

const ADJ_PURPOSES: AdjudicatorPurpose[] = ['gate', 'weakening', 'merge']
const FIXER_PURPOSES: FixerPurpose[] = ['gate', 'conflict', 'regate', 'weakening', 'review', 'guard', 'handoff']

type Fields = {
  issue: number
  notes: string[]
  run: string
  branch: string
  step: string | null
  head: string
  pr: number
  brief: string
  model: string | null
  warns: string[]
  handoffHead: string | null
  verdicts: string[]
  guard: string[]
  instructions: string
}

const BENIGN: Fields = {
  issue: 470,
  notes: ['Prefer the smaller change; the owner wants it before the release.'],
  run: '01K7RRXQ7M2YB9ZB3J8N0V5F6D',
  branch: 'feat/issue-470-agents',
  step: 'review',
  head: '3f2a9c1d4e',
  pr: 512,
  brief: BRIEF,
  model: 'opus',
  warns: ['GUARD test-weakening WARN 3f2a9c1 removed 2 assertions in tests/guard.test.ts'],
  handoffHead: '1a2b3c4d5e',
  verdicts: ['CORRECT: review-1 moved HEAD after recovery must not be accepted.'],
  guard: ['GUARD checks FAIL ci=failure'],
  instructions: 'Restore the assertion in tests/guard.test.ts and re-gate.',
}

// A brief's content, where only its URL may go.
const BRIEF_CONTENT = '## Design brief (designer, 2026-10-13)\n\n## Acceptance criteria\n- Closes #12, the secret plan'
const HOSTILE_TEXT = [
  'Closes #12',
  'fixes cbundy/dev-system#13',
  'RESOLVED: https://github.com/cbundy/dev-system/issues/14',
  'Fix GH-15 now',
  'please close\n#16',
  'it is FIXED  #17',
  '**Resolves** #18',
  'closed: #19 and resolve #20',
  'a value that ends in fix',
  'resolves',
]
const HOSTILE: Fields = {
  issue: 470,
  notes: HOSTILE_TEXT,
  run: '01K7 fixes #1',
  branch: 'feat/issue-470 closes #2',
  step: 'review; resolves #3',
  head: 'closes #4',
  pr: 512,
  brief: BRIEF_CONTENT,
  model: 'opus fixes #5',
  warns: HOSTILE_TEXT,
  handoffHead: 'fixed #6',
  verdicts: HOSTILE_TEXT,
  guard: HOSTILE_TEXT,
  instructions: HOSTILE_TEXT.join('\n'),
}

const base = { reason: 'test' }

function designer(f: Fields): AgentAction {
  return { ...base, kind: 'spawn', agent: 'designer', key: `design:${f.issue}:1`, class: 'develop', rule: 'D2', issue: f.issue, model: f.model, notes: f.notes }
}

function adjudicator(f: Fields, purpose: AdjudicatorPurpose): AgentAction {
  return {
    ...base,
    kind: 'spawn',
    agent: 'adjudicator',
    purpose,
    key: `adjudicate:${f.run}:${f.step}:${f.head}`,
    class: 'drive',
    rule: 'P2',
    issue: f.issue,
    run: f.run,
    branch: f.branch,
    step: purpose === 'gate' ? f.step : null,
    head: f.head,
    pr: f.pr,
    brief: f.brief,
    model: f.model,
    warns: purpose === 'weakening' ? f.warns : [],
    handoffHead: purpose === 'merge' ? f.handoffHead : null,
    verdicts: purpose === 'merge' ? f.verdicts : [],
    guard: purpose === 'merge' ? f.guard : [],
  }
}

function fixer(f: Fields, purpose: FixerPurpose): AgentAction {
  return {
    ...base,
    kind: 'spawn',
    agent: 'fixer',
    purpose,
    key: `fixer:${purpose}:${f.pr}:${f.head}`,
    class: 'drive',
    rule: 'M2',
    issue: f.issue,
    run: f.run,
    branch: f.branch,
    head: f.head,
    pr: f.pr,
    brief: f.brief,
    model: f.model,
    instructions: f.instructions,
  }
}

function delegate(f: Fields): AgentAction {
  return { ...base, kind: 'delegate', key: `delegate:${f.issue}:${f.brief}`, class: 'develop', rule: 'D4', issue: f.issue, brief: f.brief }
}

// every template, by name
function all(f: Fields): [string, AgentAction][] {
  return [
    ['designer', designer(f)],
    ...ADJ_PURPOSES.map((p): [string, AgentAction] => [`adjudicator ${p}`, adjudicator(f, p)]),
    ...FIXER_PURPOSES.map((p): [string, AgentAction] => [`fixer ${p}`, fixer(f, p)]),
    ['implementer', delegate(f)],
  ]
}

function render(action: AgentAction, f: Fields, env: Partial<PromptEnv> = {}): string {
  return promptOf(action, {
    ...ENV,
    modelOverride: f.model,
    inFlight: [
      { branch: 'feat/issue-12-queue', issue: 12 },
      { branch: f.branch, issue: 13 },
    ],
    ...env,
  })
}

const lastLine = (text: string) => text.split('\n').pop()

describe('every template (SPEC 6.3)', () => {
  test('its own text holds no closing keyword at all, nor do its description and name', () => {
    for (const [name, action] of all(BENIGN)) {
      for (const text of [render(action, BENIGN), descriptionOf(action), nameOf(action, 2)]) {
        if (KEYWORD.test(text)) throw new Error(`${name}: ${text.match(KEYWORD)?.[0]} in ${JSON.stringify(text)}`)
      }
    }
  })

  test('hostile inputs: no keyword before an issue reference, no brief content, no garbled id', () => {
    for (const [name, action] of all(HOSTILE)) {
      for (const text of [render(action, HOSTILE, { repo: REPO }), descriptionOf(action), nameOf(action, 1)]) {
        const m = text.match(CLOSING_REF)
        if (m !== null) throw new Error(`${name}: "${m[0]}" in ${JSON.stringify(text)}`)
        expect(text).not.toContain('Design brief')
        expect(text).not.toContain('secret plan')
        for (const id of ['01K7 fixes', 'feat/issue-470 closes', 'review; resolves', 'closes #4', 'opus fixes', 'fixed #6']) expect(text).not.toContain(id)
      }
    }
  })

  test('a repo that is not owner/name builds no URL; the issue number stays', () => {
    const text = render(delegate(BENIGN), BENIGN, { repo: 'evil repo/closes #1' })
    expect(text).toContain('issue #470')
    expect(text).not.toContain('github.com')
    expect(text).not.toMatch(CLOSING_REF)
  })

  test('each points at CLAUDE.md, its own memory file only (D-22), and a per-issue scratch subdirectory (I-95)', () => {
    for (const [name, action] of all(BENIGN)) {
      const text = render(action, BENIGN)
      const type = name.split(' ')[0]
      expect(text).toContain(`Read CLAUDE.md and your memory file .claude/agent-memory/${type}.md first.`)
      for (const other of ['designer', 'implementer', 'adjudicator', 'fixer'].filter(t => t !== type)) expect(text).not.toContain(`agent-memory/${other}.md`)
      expect(text).not.toContain('orchestrator-memory')
      expect(text).toContain('issue-470 subdirectory of your scratchpad directory')
    }
  })

  test('a brief travels as its URL, with the one sanctioned way to read it', () => {
    for (const [name, action] of all(BENIGN)) {
      if (name === 'designer') continue
      expect(render(action, BENIGN)).toContain(`Brief: ${BRIEF}. Read it with \`callum-flow-issue-read --comment ${BRIEF}\`.`)
    }
    const none = render(fixer({ ...BENIGN, brief: '' }, 'conflict'), BENIGN)
    expect(none).toContain('Brief: none known. Read the issue and its comments with `callum-flow-issue-read 470 --comments` instead, and say so.')
  })
})

describe('the main checkout (testbed, 2026-10-13)', () => {
  test('every agent is told never to move or change the main checkout', () => {
    const actions = [adjudicator(BENIGN, 'gate'), adjudicator(BENIGN, 'merge'), adjudicator(BENIGN, 'weakening')]
    for (const action of actions) expect(promptOf(action, ENV)).toContain(CHECKOUT_RULE)
  })
})

describe('the designer', () => {
  const text = render(designer(BENIGN), BENIGN)

  test('the issue with its URL, the branches in flight, the owner notes and the model label', () => {
    expect(text).toContain('Design issue #470 (https://github.com/cbundy/dev-system/issues/470), as your agent definition says.')
    expect(text).toContain('  feat/issue-12-queue, for issue 12')
    expect(text).toContain('  feat/issue-470-agents, for issue 13')
    expect(text).toContain('Owner notes:\n  Prefer the smaller change; the owner wants it before the release.')
    expect(text).toContain('Model override: opus')
  })

  test('ends with the RESULT line of SPEC 7.2 (D-14: until designer.md owns it)', () => {
    expect(lastLine(text)).toBe(DESIGNER_RESULT)
  })

  test('no notes, no branches, no label: those lines are left out', () => {
    const bare = promptOf(designer({ ...BENIGN, notes: [], model: null }), ENV)
    expect(bare).not.toContain('Owner notes')
    expect(bare).not.toContain('Branches in flight')
    expect(bare).not.toContain('Model override')
  })
})

describe('the adjudicator', () => {
  test('gate: the run, branch, step, head and PR, and its own output contract', () => {
    const text = render(adjudicator(BENIGN, 'gate'), BENIGN)
    expect(text).toContain('Adjudicate the review gate of run 01K7RRXQ7M2YB9ZB3J8N0V5F6D for issue #470')
    expect(text).toContain('Where: run 01K7RRXQ7M2YB9ZB3J8N0V5F6D, branch feat/issue-470-agents, head 3f2a9c1d4e, PR #512 (https://github.com/cbundy/dev-system/pull/512).')
    expect(lastLine(text)).toBe('Reply in your output contract and nothing else: verdict lines, then exactly one ACTION line.')
    // the adjudicator spawns nothing: no model line
    expect(text).not.toContain('Model override')
  })

  test("every agent but the designer gets the issue's owner notes before its reading list (testbed, 2026-10-13)", () => {
    const notes = ['Owner chose option (a): keep the whole-word behaviour; amend criterion 4.', 'Fixes #9 too']
    for (const action of [adjudicator(BENIGN, 'gate'), adjudicator(BENIGN, 'merge')]) {
      const lines = promptOf(action, { ...ENV, notes }).split('\n')
      const head = lines.findIndex(l => l.startsWith('Owner notes'))
      expect(head).toBeGreaterThan(-1)
      expect(lines[head + 1]).toBe('  Owner chose option (a): keep the whole-word behaviour; amend criterion 4.')
      // a closing keyword in a note never reaches an agent (I-33)
      expect(lines[head + 2]).toBe('  Fixing #9 too')
      expect(head).toBeLessThan(lines.findIndex(l => l.startsWith('Read CLAUDE.md')))
    }
    expect(promptOf(adjudicator(BENIGN, 'gate'), ENV)).not.toContain('Owner notes')
  })

  test('gate without a step: it finds the step itself', () => {
    const text = render(adjudicator({ ...BENIGN, step: null }, 'gate'), BENIGN)
    expect(text).toContain('find it with `no-mistakes axi status --run 01K7RRXQ7M2YB9ZB3J8N0V5F6D`')
  })

  test('weakening: the guard WARN lines, and how a weakened test is judged', () => {
    const text = render(adjudicator(BENIGN, 'weakening'), BENIGN)
    expect(text).toContain('The warnings:\n  GUARD test-weakening WARN 3f2a9c1 removed 2 assertions in tests/guard.test.ts')
    expect(text).toContain('CORRECT (restore it) unless the brief shows it is absolutely not required')
  })

  test('merge (D-05, SPEC M4, 7.3): ids and pointers only, the three checks, and every reply line', () => {
    const text = render(adjudicator(BENIGN, 'merge'), BENIGN)
    for (const want of [
      'Review PR #512 (https://github.com/cbundy/dev-system/pull/512) of issue #470',
      'Where: run 01K7RRXQ7M2YB9ZB3J8N0V5F6D, branch feat/issue-470-agents, head 3f2a9c1d4e.',
      'The implementer handed off at head 1a2b3c4d5e.',
      `Brief: ${BRIEF}`,
      'The guard lines for this head:\n  GUARD checks FAIL ci=failure',
      "The run's verdict lines:\n  CORRECT: review-1 moved HEAD after recovery must not be accepted.",
      'the commits the pipeline added after the handoff head (`git log 1a2b3c4d5e..3f2a9c1d4e`)',
      'With no such commits, say so and skip this check',
      '`gh pr view 512 --json body,closingIssuesReferences`',
      'a visible (UI) change has screenshot or video evidence',
      '`ACTION: merge`',
      '`ACTION: hold <reason>`',
      '`ACTION: fixer: <instructions>`',
      '`SUMMARY: <what changes for users, one line>`',
      '`BUMP: <patch|minor|major> <reason>`',
      '`FLAGS: <image,template,restart,run-it or none>`',
    ]) {
      expect(text).toContain(want)
    }
    expect(text).not.toContain('diff --git')
  })

  test('merge with no handoff head: the adjudicator finds the pipeline commits itself', () => {
    const text = render(adjudicator({ ...BENIGN, handoffHead: null }, 'merge'), BENIGN)
    expect(text).toContain("The implementer's handoff head is not known")
    expect(text).not.toContain('git log')
  })
})

describe('the fixer and the implementer', () => {
  test('each fixer purpose says why it was sent, then the instructions and the implement-issue skill', () => {
    const seen = new Set<string>()
    for (const purpose of FIXER_PURPOSES) {
      const text = render(fixer(BENIGN, purpose), BENIGN)
      const why = text.split('\n')[0] ?? ''
      expect(why).toMatch(/^Fixer for issue #470 \(https:\/\/github\.com\/cbundy\/dev-system\/issues\/470\): \S/)
      seen.add(why)
      expect(text).toContain('Branch: feat/issue-470-agents. PR #512 (https://github.com/cbundy/dev-system/pull/512). Run 01K7RRXQ7M2YB9ZB3J8N0V5F6D at head 3f2a9c1d4e.')
      expect(text).toContain('Instructions:\n  Restore the assertion in tests/guard.test.ts and re-gate.')
      expect(text).toContain('Load and follow the implement-issue skill')
      expect(text).toContain('Model override: opus')
      expect(lastLine(text)).toBe(HANDOFF_RESULT)
    }
    expect(seen.size).toBe(FIXER_PURPOSES.length)
  })

  test('a fixer sent with no branch (a handoff that named none) is told so', () => {
    expect(render(fixer({ ...BENIGN, branch: '' }, 'handoff'), BENIGN)).toContain('Branch: not known; the run or the PR names it.')
  })

  test('the implementer: the brief URL, the implement-issue skill, the machine line after the handoff', () => {
    const text = render(delegate(BENIGN), BENIGN)
    expect(text.split('\n')[0]).toBe('Implement issue #470 (https://github.com/cbundy/dev-system/issues/470).')
    expect(text).toContain('Load and follow the implement-issue skill for the how')
    expect(text).toContain('After the implement-issue handoff (its section 8)')
    expect(lastLine(text)).toBe(HANDOFF_RESULT)
  })
})

describe('neutral', () => {
  test('a keyword before a reference becomes its participle, in the same case; other text stays', () => {
    expect(neutral('Closes #12')).toBe('Closing #12')
    expect(neutral('fixes cbundy/dev-system#13')).toBe('fixing cbundy/dev-system#13')
    expect(neutral('RESOLVED: https://github.com/o/r/issues/14')).toBe('RESOLVING: https://github.com/o/r/issues/14')
    expect(neutral('**Resolves** #18')).toBe('**Resolving** #18')
    expect(neutral('a value that ends in fix')).toBe('a value that ends in fixing')
    expect(neutral('Fix the timeout in a.ts, then re-gate.')).toBe('Fix the timeout in a.ts, then re-gate.')
    expect(neutral('prefixes #12 and unresolved #13')).toBe('prefixes #12 and unresolved #13')
  })

  test('control characters go, long text is cut', () => {
    expect(neutral('a\u0007b\r\nc')).toBe('a b \nc')
    expect(neutral('x'.repeat(5000))).toHaveLength(4000)
  })
})

describe('descriptionOf and nameOf (D-11: the issue in both)', () => {
  test('a few words with the issue, and a name per type, purpose and attempt', () => {
    expect(descriptionOf(designer(BENIGN))).toBe('Design #470')
    expect(descriptionOf(adjudicator(BENIGN, 'gate'))).toBe('Adjudicate #470 review')
    expect(descriptionOf(adjudicator(BENIGN, 'weakening'))).toBe('Test weakening #470')
    expect(descriptionOf(adjudicator(BENIGN, 'merge'))).toBe('Merge review #470')
    expect(descriptionOf(fixer(BENIGN, 'conflict'))).toBe('Fixer #470 (conflict)')
    expect(descriptionOf(delegate(BENIGN))).toBe('Implement #470')
    expect(nameOf(designer(BENIGN), 1)).toBe('designer-470')
    expect(nameOf(adjudicator(BENIGN, 'merge'), 1)).toBe('adjudicator-470-merge')
    expect(nameOf(fixer(BENIGN, 'regate'), 2)).toBe('fixer-470-regate-2')
    expect(nameOf(delegate(BENIGN), 3)).toBe('implementer-470-3')
  })
})
