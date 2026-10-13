// The reply parsers (replies.ts) against replies shaped like the agents' real ones: the
// designer's return with its RESULT line (SPEC 7.2), the adjudicator's output contract
// (plugins/callum-flow/agents/adjudicator.md, SPEC 7.3; finding ids as no-mistakes names them,
// review-<n>), and the implementer's and fixer's handoff (implement-issue section 8) ending in
// the RESULT line prompts.ts asks for. Each also against malformed ones.
import { describe, expect, test } from 'claude-code/testing'

import { ACTIONS_FOR, isBriefUrl, parseAction, parseAdjudicator, parseDesigner, parseHandoff } from '../hooks/replies'

const REPO = 'cbundy/dev-system'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-3301234567'

describe('isBriefUrl', () => {
  test('a comment URL on an issue of this repo, and on the given issue when one is named', () => {
    expect(isBriefUrl(BRIEF, REPO)).toBe(true)
    expect(isBriefUrl(BRIEF, 'CBundy/Dev-System', 470)).toBe(true)
    expect(isBriefUrl(BRIEF, REPO, 471)).toBe(false)
    expect(isBriefUrl('https://github.com/cbundy/plant-console/issues/470#issuecomment-1', REPO)).toBe(false)
    expect(isBriefUrl('https://github.com/cbundy/dev-system/pull/470#issuecomment-1', REPO)).toBe(false)
    expect(isBriefUrl('https://github.com/cbundy/dev-system/issues/470', REPO)).toBe(false)
    expect(isBriefUrl(`${BRIEF} trailing`, REPO)).toBe(false)
    expect(isBriefUrl('## Design brief (designer, 2026-10-13)', REPO)).toBe(false)
  })
})

describe('parseDesigner (SPEC 7.2)', () => {
  const report = (last: string) =>
    [
      `Brief: ${BRIEF}`,
      'Created: none. Dependency order: none. Owner decision pending: no.',
      '',
      'Summary: the loop gains its agent executors; the parsers stay pure and the prompts carry pointers only.',
      '',
      last,
    ].join('\n')

  test('a brief, nothing created, no decision pending', () => {
    expect(parseDesigner(report(`RESULT brief=${BRIEF} created=none pending_decision=no`), REPO, 470)).toEqual({
      kind: 'designer',
      brief: BRIEF,
      created: [],
      pendingDecision: false,
    })
  })

  test('a split: the issues created, in order, once each, and a pending decision', () => {
    expect(parseDesigner(report('RESULT brief=none created=481,482,481 pending_decision=yes'), REPO, 470)).toEqual({
      kind: 'designer',
      brief: null,
      created: [481, 482],
      pendingDecision: true,
    })
  })

  test('trailing blank lines, CRLF and a line wrapped in backticks read the same', () => {
    const text = `Done.\r\n\`RESULT brief=${BRIEF} created=none pending_decision=no\`\r\n\r\n`
    expect(parseDesigner(text, REPO, 470)).toEqual({ kind: 'designer', brief: BRIEF, created: [], pendingDecision: false })
  })

  test('anything but the exact shape as the last line is unparsed, never guessed', () => {
    const unparsed = { kind: 'designer', unparsed: true }
    const bad = [
      // no RESULT line at all: the designer's prose return
      `Brief: ${BRIEF}\nCreated: none\nPending decision: no`,
      // the line, but not last
      `RESULT brief=${BRIEF} created=none pending_decision=no\nThanks!`,
      // a brief on another issue, another repo, or not a comment URL
      `RESULT brief=https://github.com/cbundy/dev-system/issues/471#issuecomment-1 created=none pending_decision=no`,
      `RESULT brief=https://github.com/evil/repo/issues/470#issuecomment-1 created=none pending_decision=no`,
      `RESULT brief=https://github.com/cbundy/dev-system/issues/470 created=none pending_decision=no`,
      // fields out of order, missing, misspelt, or with bad values
      `RESULT created=none brief=${BRIEF} pending_decision=no`,
      `RESULT brief=${BRIEF} created=none`,
      `RESULT brief=${BRIEF} created=none pending_decision=maybe`,
      `RESULT brief=${BRIEF} created=#481 pending_decision=no`,
      `RESULT brief=${BRIEF} created=481,,482 pending_decision=no`,
      `RESULT brief=${BRIEF} created=0 pending_decision=no`,
      `RESULT brief=${BRIEF} created=none pending_decision=no extra=1`,
      'result brief=none created=none pending_decision=no',
      '',
    ]
    for (const text of bad) expect(parseDesigner(text, REPO, 470)).toEqual(unparsed)
  })
})

describe('parseAction: the ACTION line grammar (adjudicator.md)', () => {
  test('approve, with and without a reason, quoted or bare', () => {
    expect(parseAction('approve')).toEqual({ type: 'approve', reason: null })
    expect(parseAction('approve --reason "review-6 is a false positive: the comma form is required"')).toEqual({
      type: 'approve',
      reason: 'review-6 is a false positive: the comma form is required',
    })
    expect(parseAction("approve --reason 'it is fine'")).toEqual({ type: 'approve', reason: 'it is fine' })
    expect(parseAction('approve --reason the test is not required by the brief')).toEqual({ type: 'approve', reason: 'the test is not required by the brief' })
  })

  test('fix: findings, instructions and an added finding, in any order and quoting', () => {
    expect(parseAction('fix --findings review-1,review-3 --instructions "keep the recovery path; assert HEAD is unchanged"')).toEqual({
      type: 'fix',
      findings: 'review-1,review-3',
      instructions: 'keep the recovery path; assert HEAD is unchanged',
      addFinding: null,
    })
    expect(parseAction('fix --instructions restore the assertion in tests/x.test.ts --findings review-2')).toEqual({
      type: 'fix',
      findings: 'review-2',
      instructions: 'restore the assertion in tests/x.test.ts',
      addFinding: null,
    })
    const added = parseAction(`fix --add-finding '{"title": "missed --wait bound", "severity": "warning", "file": "a.ts"}' --instructions "add it"`)
    expect(added).toEqual({
      type: 'fix',
      findings: null,
      instructions: 'add it',
      addFinding: '{"title":"missed --wait bound","severity":"warning","file":"a.ts"}',
    })
    expect(parseAction('fix --add-finding {"title":"a } in a string","n":[1,2]}')).toEqual({
      type: 'fix',
      findings: null,
      instructions: null,
      addFinding: '{"title":"a } in a string","n":[1,2]}',
    })
    // ids spaced out after their commas come back as the list respond takes
    expect(parseAction('fix --findings review-1, review-2')).toEqual({ type: 'fix', findings: 'review-1,review-2', instructions: null, addFinding: null })
    expect(parseAction('fix --findings=review-4 --instructions="escaped \\"quote\\" kept"')).toEqual({
      type: 'fix',
      findings: 'review-4',
      instructions: 'escaped "quote" kept',
      addFinding: null,
    })
  })

  test('skip, fixer, escalate, merge and hold', () => {
    expect(parseAction('skip')).toEqual({ type: 'skip' })
    expect(parseAction('fixer: rebase onto origin/main and restore the deleted guard test')).toEqual({
      type: 'fixer',
      instructions: 'rebase onto origin/main and restore the deleted guard test',
    })
    expect(parseAction('escalate: the brief and the issue disagree on the flag name')).toEqual({ type: 'escalate', why: 'the brief and the issue disagree on the flag name' })
    expect(parseAction('merge')).toEqual({ type: 'merge' })
    expect(parseAction('hold the PR body links the wrong issue')).toEqual({ type: 'hold', reason: 'the PR body links the wrong issue' })
    expect(parseAction('hold: "needs the owner"')).toEqual({ type: 'hold', reason: 'needs the owner' })
  })

  test('malformed lines are null', () => {
    const bad = [
      '',
      'approve please',
      'approve --yes',
      'approve --reason',
      'fix',
      'fix --findings',
      'fix --findings review-1 --yes',
      'fix --findings review-1 --findings review-2',
      'fix --add-finding not-json',
      'fix --add-finding [1,2]',
      "fix --add-finding '{\"title\": \"unterminated}",
      'fix --instructions "unterminated',
      'fixed --findings review-1',
      'fix: --findings review-1',
      'skip now',
      'merge it',
      'hold',
      'fixer:',
      'escalate',
      'rerun',
      'Approve',
      'abort',
    ]
    for (const line of bad) expect(parseAction(line)).toBeNull()
  })
})

describe('parseAdjudicator (SPEC 7.3)', () => {
  test('a gate: verdict lines then one ACTION line', () => {
    const reply = [
      'CORRECT: review-1 moved HEAD after recovery must not be accepted; reproduced with a two-commit branch.',
      'WRONG: review-6 comma form of --accept-dropped is required by the brief.',
      '',
      'ACTION: fix --findings review-1 --instructions "reject a moved HEAD after recovery and add a regression test"',
    ].join('\n')
    expect(parseAdjudicator(reply, 'gate')).toEqual({
      kind: 'adjudicator',
      verdicts: [
        'CORRECT: review-1 moved HEAD after recovery must not be accepted; reproduced with a two-commit branch.',
        'WRONG: review-6 comma form of --accept-dropped is required by the brief.',
      ],
      action: { type: 'fix', findings: 'review-1', instructions: 'reject a moved HEAD after recovery and add a regression test', addFinding: null },
      report: null,
    })
  })

  test('a zero-finding review approves with no verdict lines', () => {
    expect(parseAdjudicator('ACTION: approve\n', 'gate')).toEqual({ kind: 'adjudicator', verdicts: [], action: { type: 'approve', reason: null }, report: null })
  })

  test('a test-weakening review takes the gate answers', () => {
    expect(parseAdjudicator('NIT: the removed test duplicated tests/guard.test.ts:40.\nACTION: skip', 'weakening')?.action).toEqual({ type: 'skip' })
    expect(parseAdjudicator('CORRECT: the assertion is required by criterion 2.\nACTION: fixer: restore the assertion', 'weakening')?.action).toEqual({
      type: 'fixer',
      instructions: 'restore the assertion',
    })
  })

  test('a merge review: its ACTION and the three report lines, flags deduplicated', () => {
    const reply = [
      'NIT: the pipeline renamed a local variable after the handoff; harmless.',
      'ACTION: merge',
      'SUMMARY: The factory loop can now start agents and read their replies.',
      'BUMP: minor - a new plugin capability',
      'FLAGS: image, run-it,image',
    ].join('\n')
    expect(parseAdjudicator(reply, 'merge')).toEqual({
      kind: 'adjudicator',
      verdicts: ['NIT: the pipeline renamed a local variable after the handoff; harmless.'],
      action: { type: 'merge' },
      report: { summary: 'The factory loop can now start agents and read their replies.', bump: 'minor', bumpReason: 'a new plugin capability', flags: ['image', 'run-it'] },
    })
    const hold = parseAdjudicator('ACTION: hold the PR body links #470 with a plain reference\nSUMMARY: x\nBUMP: patch\nFLAGS: none', 'merge')
    expect(hold?.action).toEqual({ type: 'hold', reason: 'the PR body links #470 with a plain reference' })
    expect(hold?.report).toEqual({ summary: 'x', bump: 'patch', bumpReason: '', flags: [] })
  })

  test('each purpose takes only its own ACTIONs', () => {
    expect(ACTIONS_FOR.gate).not.toContain('merge')
    expect(parseAdjudicator('ACTION: merge', 'gate')).toBeNull()
    expect(parseAdjudicator('ACTION: hold wait', 'weakening')).toBeNull()
    const report = '\nSUMMARY: x\nBUMP: patch y\nFLAGS: none'
    expect(parseAdjudicator(`ACTION: approve${report}`, 'merge')).toBeNull()
    expect(parseAdjudicator(`ACTION: fix --findings review-1${report}`, 'merge')).toBeNull()
    expect(parseAdjudicator(`ACTION: escalate: the owner must decide${report}`, 'merge')?.action).toEqual({ type: 'escalate', why: 'the owner must decide' })
    expect(parseAdjudicator(`ACTION: fixer: add the screenshot${report}`, 'merge')?.action).toEqual({ type: 'fixer', instructions: 'add the screenshot' })
  })

  test('prose before the contract is skipped, as a testbed adjudicator wrote it; a misshapen contract line is not prose', () => {
    const reply = [
      'The test failure is environmental: baseline `npm test` passed 8 of 8.',
      '',
      'ENV: The test step failed on a codex 401 from api.openai.com; the code is not at fault.',
      'ACTION: escalate: the codex credentials are missing in the pipeline environment.',
    ].join('\n')
    expect(parseAdjudicator(reply, 'gate')).toEqual({
      kind: 'adjudicator',
      verdicts: ['ENV: The test step failed on a codex 401 from api.openai.com; the code is not at fault.'],
      action: { type: 'escalate', why: 'the codex credentials are missing in the pipeline environment.' },
      report: null,
    })
    expect(parseAdjudicator('Here is my verdict:\n- CORRECT: review-1 real.\nACTION: fix --findings review-1', 'gate')).toBeNull()
    expect(parseAdjudicator('Here it is:\n```\nACTION: approve\n```', 'gate')).toBeNull()
    expect(parseAdjudicator('My verdict:\n**WRONG**: review-1 out of scope.\nACTION: approve', 'gate')).toBeNull()
    expect(parseAdjudicator('My verdict:\n`ACTION`: approve', 'gate')).toBeNull()
  })

  test('prose that opens with a verdict word is still prose (testbed run 2, issue 33, #546)', () => {
    const verdicts = [
      'WRONG: documentation-scope - the brief forbids README.md edits.',
      'WRONG: lint-documentation-scope - the brief names the lint gap a follow-up.',
    ]
    for (const opener of ['CORRECT is not warranted for either one.', 'CORRECT/WRONG judgments:', 'CORRECT/WRONG: judged as WRONG for both.']) {
      const reply = ['Both findings conflict with the brief.', '', opener, '', ...verdicts, 'ACTION: approve --reason the brief forbids both edits'].join('\n')
      expect(parseAdjudicator(reply, 'gate')).toEqual({
        kind: 'adjudicator',
        verdicts,
        action: { type: 'approve', reason: 'the brief forbids both edits' },
        report: null,
      })
    }
  })

  test('unparseable: other lines, not exactly one ACTION, a bad report', () => {
    const bad: [string, 'gate' | 'merge'][] = [
      ['CORRECT: review-1 real.\nThat is my verdict.\nACTION: fix --findings review-1', 'gate'],
      ['- CORRECT: review-1 real.\nACTION: fix --findings review-1', 'gate'],
      ['```\nACTION: approve\n```', 'gate'],
      ['CORRECT: review-1 real.', 'gate'],
      ['ACTION: approve\nACTION: skip', 'gate'],
      ['ACTION: approve --yes', 'gate'],
      ['CORRECT:\nACTION: approve', 'gate'],
      ['MAYBE: review-1\nACTION: approve', 'gate'],
      ['ACTION: approve\nSUMMARY: x', 'gate'],
      ['ACTION: merge\nSUMMARY: x\nBUMP: minor y', 'merge'],
      ['ACTION: merge\nSUMMARY: x\nBUMP: huge y\nFLAGS: none', 'merge'],
      ['ACTION: merge\nSUMMARY: x\nBUMP: minor y\nFLAGS: image,database', 'merge'],
      ['ACTION: merge\nSUMMARY: x\nBUMP: minor y\nFLAGS: none\nFLAGS: image', 'merge'],
      ['ACTION: merge\nSUMMARY:\nBUMP: minor y\nFLAGS: none', 'merge'],
      ['ACTION: merge\nSUMMARY: x\nBUMP: minor y\nFLAGS:', 'merge'],
      ['', 'gate'],
    ]
    for (const [reply, purpose] of bad) expect(parseAdjudicator(reply, purpose)).toBeNull()
  })
})

describe('parseHandoff (implement-issue section 8)', () => {
  const handoff = (result: string, extra = '') =>
    [
      'Worktree: /workspaces/dev-system/.treehouse/dev-system-22f535/4/dev-system, branch feat/issue-470-agents.',
      'Latest commit: 3f2a9c1d.',
      'Run 01K7RRXQ7M2YB9ZB3J8N0V5F6D started; no-mistakes status shows head 3f2a9c1d, which equals the commit.',
      'Verified: npm test, npm run lint.',
      extra,
      result,
    ].join('\n')

  test('a gated implementer: run, head and the branch it chose (an implementer is named none)', () => {
    const text = handoff('RESULT run=01K7RRXQ7M2YB9ZB3J8N0V5F6D head=3f2a9c1d commit=3f2a9c1d gated=yes branch=feat/issue-470-agents pr=none')
    expect(parseHandoff(text, null)).toEqual({ kind: 'handoff', notGated: false, run: '01K7RRXQ7M2YB9ZB3J8N0V5F6D', head: '3f2a9c1d', newBranch: 'feat/issue-470-agents' })
  })

  test('a fixer on the branch it was sent to names no new branch; one that moved does', () => {
    const same = 'RESULT run=01K7S0 head=ABCDEF1234 commit=abcdef1 gated=yes branch=feat/issue-470-agents pr=#512'
    expect(parseHandoff(same, 'feat/issue-470-agents')).toEqual({ kind: 'handoff', notGated: false, run: '01K7S0', head: 'abcdef1234', newBranch: null })
    const moved = 'RESULT run=01K7S1 head=abcdef1 commit=abcdef1 gated=yes branch=feat/issue-470-agents-v2 pr=512'
    expect(parseHandoff(moved, 'feat/issue-470-agents')?.newBranch).toBe('feat/issue-470-agents-v2')
  })

  test('not gated: it says so, or the run head is not its commit', () => {
    expect(parseHandoff('RESULT run=01K7S2 head=aaaaaaa commit=bbbbbbb gated=no branch=feat/issue-470-x pr=none', 'feat/issue-470-x')?.notGated).toBe(true)
    // a mismatch the agent rationalised away still counts
    expect(parseHandoff('RESULT run=01K7S2 head=aaaaaaa commit=bbbbbbb gated=yes branch=feat/issue-470-x pr=none', 'feat/issue-470-x')?.notGated).toBe(true)
  })

  test('a run driven with axi respond: no commit of its own is gated', () => {
    const text = 'Responded --action fix --findings review-1 to the review step.\nRESULT run=01K7S3 head=ccccccc commit=none gated=yes branch=feat/issue-470-x pr=512'
    expect(parseHandoff(text, 'feat/issue-470-x')).toEqual({ kind: 'handoff', notGated: false, run: '01K7S3', head: 'ccccccc', newBranch: null })
  })

  test('the last RESULT line counts', () => {
    const text = 'RESULT run=01OLD head=aaaaaaa commit=aaaaaaa gated=yes branch=feat/issue-470-x pr=none\nRESULT run=01NEW head=bbbbbbb commit=bbbbbbb gated=yes branch=feat/issue-470-x pr=none'
    expect(parseHandoff(text, 'feat/issue-470-x')?.run).toBe('01NEW')
  })

  test('no RESULT line: the words NOT GATED are enough for rule D5, anything else is unparseable', () => {
    const notGated = handoff('', 'Head 9e9e9e9 differs from my commit 3f2a9c1d: NOT GATED, because axi run attached to the live run.')
    expect(parseHandoff(notGated, null)).toEqual({ kind: 'handoff', notGated: true, run: null, head: null, newBranch: null })
    expect(parseHandoff(handoff(''), null)).toBeNull()
    expect(parseHandoff('', null)).toBeNull()
  })

  test('a malformed RESULT line is no RESULT line', () => {
    const bad = [
      'RESULT run=01K7S2 head=xyz commit=none gated=yes branch=feat/issue-470-x pr=none',
      'RESULT run=01K7S2 head=none commit=none gated=maybe branch=feat/issue-470-x pr=none',
      'RESULT run=01K7S2 head=none commit=none gated=yes branch=feat/issue#470 pr=none',
      'RESULT run=01K7S2 head=none commit=none gated=yes branch=feat/issue-470-x pr=PR512',
      'RESULT run=01K7S2 head=none commit=none gated=yes branch=feat/issue-470-x',
      'RESULT run=01K7S2;rm head=none commit=none gated=yes branch=feat/issue-470-x pr=none',
    ]
    for (const line of bad) expect(parseHandoff(line, null)).toBeNull()
  })
})
