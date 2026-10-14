// The agents' answer tools (agent-tools.ts, #548): each tool's schema is its text contract, and
// each check gives exactly the outcome replies.ts gives for the same answer in text, or every
// problem at once, worded for the model to correct its call. Answers are shaped like the
// agents' real ones (finding ids as no-mistakes names them, review-<n>); the schemas keep to
// what the API takes for a tool (an object at the top, no anyOf there).
import { describe, expect, test } from 'claude-code/testing'

import { AGENT_TOOLS, DESIGN_TOOL, HANDOFF_TOOL, TOOL_OF, VERDICT_TOOL, checkDesign, checkHandoff, checkVerdict } from '../hooks/agent-tools'
import type { ToolCheck } from '../hooks/agent-tools'
import { parseAdjudicator, parseDesigner, parseHandoff } from '../hooks/replies'

const REPO = 'cbundy/dev-system'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-3301234567'
const RUN = '01K7RRXQ7M2YB9ZB3J8N0V5F6D'

function problems<O>(r: ToolCheck<O>): string[] {
  if (r.ok) throw new Error(`expected problems, got ${JSON.stringify(r.outcome)}`)
  return r.problems
}

describe('the tools (SPEC 7.3, #548)', () => {
  test('one per answer: the adjudicator, the designer, the implementer and the fixer, each behind ToolSearch', () => {
    expect(AGENT_TOOLS.map(t => t.name)).toEqual(['verdict', 'design', 'handoff'])
    expect(TOOL_OF).toEqual({
      adjudicator: 'mcp__factory-loop__verdict',
      designer: 'mcp__factory-loop__design',
      implementer: 'mcp__factory-loop__handoff',
      fixer: 'mcp__factory-loop__handoff',
    })
    for (const tool of AGENT_TOOLS) {
      expect(tool.isDeferred).toBe(true)
      const schema = tool.inputSchema as Record<string, unknown>
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      for (const k of ['anyOf', 'oneOf', 'allOf']) expect(k in schema).toBe(false)
    }
    expect((VERDICT_TOOL.inputSchema as { required: string[] }).required).toEqual(['findings', 'action'])
    expect((DESIGN_TOOL.inputSchema as { required: string[] }).required).toEqual(['brief', 'created', 'pendingDecision'])
    expect((HANDOFF_TOOL.inputSchema as { required: string[] }).required).toEqual(['run', 'head', 'commit', 'gated', 'branch', 'pr'])
  })
})

describe('checkVerdict', () => {
  test("a gate's fix: the same outcome as its verdict and ACTION lines", () => {
    const r = checkVerdict(
      {
        findings: [
          { id: 'review-1', verdict: 'CORRECT', reason: 'moved HEAD after recovery must not be accepted.' },
          { id: 'review-2', verdict: 'NIT', reason: 'review-2 naming only.' },
        ],
        action: { type: 'fix', findings: ['review-1'], instructions: 'reject a moved HEAD' },
      },
      'gate',
    )
    const text = parseAdjudicator(
      'CORRECT: review-1: moved HEAD after recovery must not be accepted.\nNIT: review-2 naming only.\nACTION: fix --findings review-1 --instructions "reject a moved HEAD"',
      'gate',
    )
    expect(r).toEqual({ ok: true, outcome: text })
  })

  test('approve, skip, fixer and escalate, each with the fields its line takes', () => {
    expect(checkVerdict({ findings: [], action: { type: 'approve' } }, 'gate')).toEqual({ ok: true, outcome: { kind: 'adjudicator', verdicts: [], action: { type: 'approve', reason: null }, report: null } })
    const wrong = checkVerdict({ findings: [{ id: 'review-6', verdict: 'WRONG', reason: 'the comma form is required by the brief' }], action: { type: 'approve', reason: 'review-6 is a false positive' } }, 'weakening')
    expect(wrong).toMatchObject({ ok: true, outcome: { verdicts: ['WRONG: review-6: the comma form is required by the brief'], action: { type: 'approve', reason: 'review-6 is a false positive' } } })
    expect(checkVerdict({ findings: [{ id: 'review-3', verdict: 'DUP', reason: 'handled in round 1' }], action: { type: 'skip' } }, 'gate')).toMatchObject({ ok: true, outcome: { action: { type: 'skip' } } })
    expect(checkVerdict({ findings: [], action: { type: 'fixer', instructions: 'rebase  and\nre-gate' } }, 'gate')).toMatchObject({ ok: true, outcome: { action: { type: 'fixer', instructions: 'rebase and re-gate' } } })
    expect(checkVerdict({ findings: [{ id: 'test', verdict: 'ENV', reason: 'the registry was down' }], action: { type: 'escalate', why: 'the registry is down' } }, 'gate')).toMatchObject({
      ok: true,
      outcome: { verdicts: ['ENV: test: the registry was down'], action: { type: 'escalate', why: 'the registry is down' } },
    })
  })

  test('each verdict line names its finding once, and stands alone on one line', () => {
    const r = checkVerdict(
      {
        findings: [
          { id: 'review-1', verdict: 'DUP', reason: 'review-10 covers it' },
          { id: 'review-2', verdict: 'DUP', reason: 'review-2: handled\nin round 1' },
        ],
        action: { type: 'skip' },
      },
      'gate',
    )
    expect(r).toMatchObject({ ok: true, outcome: { verdicts: ['DUP: review-1: review-10 covers it', 'DUP: review-2: handled in round 1'] } })
  })

  test('a fix may add a missed finding, as the JSON no-mistakes takes', () => {
    const r = checkVerdict({ findings: [{ id: 'missed-1', verdict: 'CORRECT', reason: 'no bound on --wait' }], action: { type: 'fix', addFinding: { title: 'missed --wait bound', severity: 'warning' } } }, 'gate')
    expect(r).toMatchObject({ ok: true, outcome: { action: { type: 'fix', findings: null, instructions: null, addFinding: '{"title":"missed --wait bound","severity":"warning"}' } } })
  })

  test("a merge review: its summary, bump and flags, as its lines give them", () => {
    const r = checkVerdict({ findings: [], action: { type: 'merge' }, summary: 'Agents answer through a tool.', bump: { level: 'minor', reason: 'new capability' }, flags: ['image', 'image'] }, 'merge')
    const text = parseAdjudicator('ACTION: merge\nSUMMARY: Agents answer through a tool.\nBUMP: minor new capability\nFLAGS: image', 'merge')
    expect(r).toEqual({ ok: true, outcome: text })
    expect(checkVerdict({ findings: [], action: { type: 'hold', reason: 'the owner must pick the rollout' }, summary: 's', bump: { level: 'patch', reason: 'a fix' }, flags: [] }, 'merge')).toMatchObject({
      ok: true,
      outcome: { action: { type: 'hold', reason: 'the owner must pick the rollout' }, report: { flags: [] } },
    })
  })

  test('an action the purpose does not take is refused, naming the ones it does', () => {
    expect(problems(checkVerdict({ findings: [], action: { type: 'merge' } }, 'gate'))).toEqual([
      'action must be { type, ... } with type one of approve, fix, skip, fixer, escalate: a gate review takes no other',
    ])
    expect(problems(checkVerdict({ findings: [], action: { type: 'approve' }, summary: 's', bump: { level: 'patch', reason: 'r' }, flags: [] }, 'merge'))).toEqual([
      'action must be { type, ... } with type one of merge, hold, fixer, escalate: a merge review takes no other',
    ])
    expect(problems(checkVerdict({ findings: [], action: 'approve' }, 'gate'))[0]).toMatch(/^action must be \{ type, \.\.\. \}/)
  })

  test('the finding ids a fix names must be findings judged above, CORRECT or ENV', () => {
    const findings = [
      { id: 'review-1', verdict: 'CORRECT', reason: 'real' },
      { id: 'review-2', verdict: 'WRONG', reason: 'a false positive' },
    ]
    expect(problems(checkVerdict({ findings, action: { type: 'fix', findings: ['review-1', 'review-9', 'review-2', '--yes'] } }, 'gate'))).toEqual([
      'action.findings: review-9 is not one of the findings above',
      'action.findings: review-2 is judged WRONG, and a fix is for CORRECT or ENV findings',
      'action.findings: "--yes" is not a finding id',
    ])
    expect(problems(checkVerdict({ findings, action: { type: 'fix', findings: [] } }, 'gate'))).toEqual([
      'action.findings must be a list of the ids of findings above',
      'action fix needs findings, instructions or addFinding',
    ])
  })

  test('every problem at once: stray fields, bad findings, the fields each action takes, a report on a gate', () => {
    const r = checkVerdict(
      {
        findings: [{ id: 'review 1', verdict: 'MAYBE', reason: '', extra: 1 }, 'CORRECT: review-2', { id: 'review-3', verdict: 'NIT', reason: 'x' }, { id: 'review-3', verdict: 'NIT', reason: 'y' }],
        action: { type: 'approve', instructions: 'do it' },
        summary: 'not for a gate',
        note: 'hi',
      },
      'gate',
    )
    expect(problems(r)).toEqual([
      'note is not a field here',
      'findings[0].extra is not a field here',
      'findings[0].reason must not be empty',
      'findings[0].verdict must be one of CORRECT, WRONG, NIT, ENV, DUP',
      'findings[0].id "review 1" is not a finding id such as review-1',
      'findings[1] must be an object { id, verdict, reason }',
      'findings[3].id review-3 is judged twice',
      'action approve takes reason, not instructions',
      'summary answer a merge review only, and this is a gate review',
    ])
    expect(problems(checkVerdict(undefined, 'gate'))).toEqual([
      'findings must be a list of { id, verdict, reason } ([] when there is nothing to report)',
      'action must be { type, ... } with type one of approve, fix, skip, fixer, escalate: a gate review takes no other',
    ])
  })

  test('a fixer, escalate or hold without its text, and a merge review without its report, are refused', () => {
    expect(problems(checkVerdict({ findings: [], action: { type: 'fixer' } }, 'gate'))).toEqual(['action.instructions is required'])
    expect(problems(checkVerdict({ findings: [], action: { type: 'escalate', why: '  ' } }, 'gate'))).toEqual(['action.why must not be empty'])
    expect(problems(checkVerdict({ findings: [], action: { type: 'merge' } }, 'merge'))).toEqual([
      'summary is required',
      'bump is required: { level: patch|minor|major, reason }',
      'flags is required: a list of image, template, restart, run-it ([] for none)',
    ])
    expect(problems(checkVerdict({ findings: [], action: { type: 'merge' }, summary: 's', bump: { level: 'huge', reason: '' }, flags: ['docs'] }, 'merge'))).toEqual([
      'bump.level must be one of patch, minor, major',
      'bump.reason must not be empty',
      'flags: "docs" is not one of image, template, restart, run-it',
    ])
    expect(problems(checkVerdict({ findings: [], action: { type: 'approve', reason: 'x'.repeat(4001) } }, 'gate'))).toEqual(['action.reason is over 4000 characters'])
  })
})

describe('checkDesign', () => {
  test('the same outcome as the RESULT line', () => {
    expect(checkDesign({ brief: BRIEF, created: [], pendingDecision: false }, REPO, 470)).toEqual({ ok: true, outcome: parseDesigner(`RESULT brief=${BRIEF} created=none pending_decision=no`, REPO, 470) })
    expect(checkDesign({ brief: null, created: [481, 482, 481], pendingDecision: true }, REPO, 470)).toEqual({
      ok: true,
      outcome: parseDesigner('RESULT brief=none created=481,482 pending_decision=yes', REPO, 470),
    })
  })

  test('a brief must be a comment URL on the designed issue of this repo', () => {
    const other = 'https://github.com/cbundy/dev-system/issues/471#issuecomment-1'
    expect(problems(checkDesign({ brief: other, created: [], pendingDecision: false }, REPO, 470))).toEqual([
      `brief "${other}" is not a comment URL on cbundy/dev-system issue 470 (https://github.com/cbundy/dev-system/issues/470#issuecomment-<id>)`,
    ])
    expect(problems(checkDesign({ brief: '## Design brief', created: [], pendingDecision: false }, REPO, 470))[0]).toMatch(/^brief "## Design brief" is not a comment URL/)
  })

  test('missing or misshapen fields, and a result that leaves the loop nothing to do', () => {
    expect(problems(checkDesign({ created: ['481'], extra: true }, REPO, 470))).toEqual([
      'extra is not a field here',
      "brief is required: the brief comment's URL on cbundy/dev-system issue 470, or null",
      'created must be a list of the issue numbers you created ([] for none)',
      'pendingDecision must be true or false',
    ])
    expect(problems(checkDesign({ brief: null, created: [], pendingDecision: false }, REPO, 470))).toEqual([
      'with no brief, no created issues and no decision pending, the loop has nothing to hand on: give the brief URL',
    ])
  })
})

describe('checkHandoff', () => {
  test('the same outcome as the RESULT line: gated, a new branch, a head that is not the commit', () => {
    const base = { run: RUN, head: '3F2A9C1D', commit: '3f2a9c1', gated: true, branch: 'feat/issue-470-agents', pr: 512 }
    expect(checkHandoff(base, null)).toEqual({ ok: true, outcome: parseHandoff(`RESULT run=${RUN} head=3f2a9c1d commit=3f2a9c1 gated=yes branch=feat/issue-470-agents pr=512`, null) })
    expect(checkHandoff(base, 'feat/issue-470-agents')).toMatchObject({ ok: true, outcome: { notGated: false, newBranch: null } })
    expect(checkHandoff({ ...base, commit: 'abcdef1' }, null)).toMatchObject({ ok: true, outcome: { notGated: true } })
    // NOT GATED: nothing ran, nothing committed
    expect(checkHandoff({ run: null, head: null, commit: null, gated: false, branch: null, pr: null }, null)).toEqual({
      ok: true,
      outcome: { kind: 'handoff', notGated: true, run: null, head: null, newBranch: null },
    })
  })

  test('each id has its shape, every field is there, and nothing else is', () => {
    expect(problems(checkHandoff({ run: '01K7 --yes', head: 'HEAD', commit: 'abc', gated: 'yes', branch: 'feat x', pr: 0, url: 'x' }, null))).toEqual([
      'url is not a field here',
      'run "01K7 --yes" is not a pipeline run id, or null',
      'head "HEAD" is not a commit SHA of 7 to 40 hex digits, or null',
      'commit "abc" is not a commit SHA of 7 to 40 hex digits, or null',
      'branch "feat x" is not a branch name, or null',
      'gated must be true or false',
      'pr 0 is not a PR number, or null',
    ])
    expect(problems(checkHandoff({}, null))).toEqual([
      'run is required (null for none)',
      'head is required (null for none)',
      'commit is required (null for none)',
      'branch is required (null for none)',
      'gated must be true or false',
      'pr is required (null for none)',
    ])
  })
})
