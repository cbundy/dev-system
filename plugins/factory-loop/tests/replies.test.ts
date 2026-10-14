// The reply parsers (replies.ts) against replies shaped like the agents' real ones: the
// designer's return with its RESULT line (SPEC 7.2), the adjudicator's output contract
// (plugins/callum-flow/agents/adjudicator.md, SPEC 7.3; finding ids as no-mistakes names them,
// review-<n>), and the implementer's and fixer's handoff (implement-issue section 8) ending in
// the RESULT line prompts.ts asks for. Each also against malformed ones.
import { describe, expect, test } from 'claude-code/testing'

import {
  ACTIONS_FOR,
  DESIGNER_RESULT,
  HANDOFF_RESULT,
  isBriefUrl,
  parseAction,
  parseAdjudicator,
  parseDesigner,
  parseHandoff,
  readAdjudicator,
  readDesigner,
  readHandoff,
} from '../hooks/replies'

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

  test("notes after a complete contract are not read: testbed run 3's merge reviews of PRs 73, 80 and 89 (#559)", () => {
    const pr73 = [
      "I couldn't call the verdict tool: factory-loop registered it, but no `tool.call` hook answered. Here is the fallback answer.",
      '',
      'NIT: documentation-scope - The brief limits changes to `src/same-slug.js` and `test/same-slug.test.js`, so a README mention of `sameSlug` is out of scope.',
      'NIT: lint-documentation - The CLAUDE.md lint wording mismatch was already there before this change, and the brief forbids touching `package.json`.',
      'ACTION: merge',
      'SUMMARY: Adds a `sameSlug(a, b)` helper that compares the slugs of two strings, plus tests.',
      'BUMP: minor New backwards-compatible helper function.',
      'FLAGS: none',
      '',
      'Checks:',
      '- **Commits after the handoff head:** There are none, because the range you gave is empty, so I skipped that check.',
      '- **PR diff against the brief:** Only the two permitted files change. The helper delegates to `slugify`, and the tests cover the accent case, the differing-slug case and a `TypeError` in either position.',
      "- **Linkage:** The PR body says `Closes #61`, and `closingIssuesReferences` lists issue 61, which matches the brief's merge rollout.",
      '- **UI evidence:** The change has no UI, so none is needed.',
      "- **Not run:** I didn't run `npm test` or `npm run lint` myself. The PR body reports a passing test baseline and live checks.",
      "- **Memory file:** `.claude/agent-memory/adjudicator.md` doesn't exist, so I had no memory notes to read.",
    ].join('\n')
    expect(parseAdjudicator(pr73, 'merge')).toEqual({
      kind: 'adjudicator',
      verdicts: [
        'NIT: documentation-scope - The brief limits changes to `src/same-slug.js` and `test/same-slug.test.js`, so a README mention of `sameSlug` is out of scope.',
        'NIT: lint-documentation - The CLAUDE.md lint wording mismatch was already there before this change, and the brief forbids touching `package.json`.',
      ],
      action: { type: 'merge' },
      report: { summary: 'Adds a `sameSlug(a, b)` helper that compares the slugs of two strings, plus tests.', bump: 'minor', bumpReason: 'New backwards-compatible helper function.', flags: [] },
    })
    const pr80 = [
      "I couldn't record the verdict through the tool: the factory-loop plugin has no `tool.call` hook for it and returned an error. Here is the fallback reply.",
      '',
      'NIT: review-1 - the lint script covering only two files is the gap the brief puts out of scope, and `npm test` still syntax-checks the new test file.',
      "NIT: missed-1 - pipeline commit f3c9729 also edits CLAUDE.md to name the two linted files, which is outside the brief's file list, but it is accurate, docs-only and weakens nothing.",
      'ACTION: merge',
      'SUMMARY: slugify now throws RangeError "maxLength must be a positive integer" for any defined maxLength that is not a positive integer, even when the slug fits; the README documents it.',
      'BUMP: patch Small validation guard that rejects previously silently-wrong inputs, with no new API.',
      'FLAGS: none',
      '',
      'Checks:',
      '1. **Post-handoff commit:** f3c9729 is the only pipeline commit on top of the validation commit. It changes the `@param` doc, the README and CLAUDE.md, and touches no tests. Every acceptance criterion holds in the diff:',
      '   - The guard is the first statement under `maxLength !== undefined`, ahead of the trim.',
      '   - The error message matches the brief exactly.',
      '   - `maxLength: 1` still returns "a".',
      '   - Omitting `maxLength` behaves as before.',
      '   - No existing test changed.',
      '2. **Issue link:** `closingIssuesReferences` lists #64 and the PR body says `Closes #64`, which matches the brief\'s Rollout of "merge".',
      '3. **UI evidence:** there is no UI change, so no screenshot or video is needed.',
      '',
      "I read `.claude/agent-memory/adjudicator.md` first, but it doesn't exist. I only read the diff and the brief and ran no tests myself.",
    ].join('\n')
    expect(parseAdjudicator(pr80, 'merge')).toEqual({
      kind: 'adjudicator',
      verdicts: [
        'NIT: review-1 - the lint script covering only two files is the gap the brief puts out of scope, and `npm test` still syntax-checks the new test file.',
        "NIT: missed-1 - pipeline commit f3c9729 also edits CLAUDE.md to name the two linted files, which is outside the brief's file list, but it is accurate, docs-only and weakens nothing.",
      ],
      action: { type: 'merge' },
      report: {
        summary: 'slugify now throws RangeError "maxLength must be a positive integer" for any defined maxLength that is not a positive integer, even when the slug fits; the README documents it.',
        bump: 'patch',
        bumpReason: 'Small validation guard that rejects previously silently-wrong inputs, with no new API.',
        flags: [],
      },
    })
    const pr89 = [
      "I couldn't record the verdict: the `mcp__factory-loop__verdict` tool returned an error saying no `tool.call` hook answered it. So here is the fallback reply.",
      '',
      'NIT: document-1 is a pre-existing `docs/api.md` Errors inaccuracy, unrelated to this PR. `docs/api.md` on this branch is identical to main.',
      'ACTION: merge',
      'SUMMARY: Adds `scripts/script-coverage.js`, which prints a Markdown table of slugify results for ten writing systems, plus a test and a README note.',
      'BUMP: patch New standalone script, test and docs note; no library code change.',
      'FLAGS: none',
      '',
      'What I checked:',
      '- **Pipeline commits after the handoff head:** There are three. The first adds the script and its test. The second adds the README note and removes duplicate sections from `docs/api.md`. The third restores those sections. The net PR diff is only `README.md`, `scripts/script-coverage.js` and `test/script-coverage.test.js`. No test was weakened.',
      "- **PR body linkage:** The body says `Refs #71`, and `closingIssuesReferences` is empty. That matches the brief's keep-open rollout.",
      '- **UI evidence:** The change has no UI, so no screenshot is needed. The body does include the generated table and a CLI transcript.',
      "- **Not checked:** The brief also wants the table posted as a comment on #71. I didn't confirm that, and it isn't something the diff can show.",
    ].join('\n')
    expect(parseAdjudicator(pr89, 'merge')).toEqual({
      kind: 'adjudicator',
      verdicts: ['NIT: document-1 is a pre-existing `docs/api.md` Errors inaccuracy, unrelated to this PR. `docs/api.md` on this branch is identical to main.'],
      action: { type: 'merge' },
      report: {
        summary: 'Adds `scripts/script-coverage.js`, which prints a Markdown table of slugify results for ten writing systems, plus a test and a README note.',
        bump: 'patch',
        bumpReason: 'New standalone script, test and docs note; no library code change.',
        flags: [],
      },
    })
    // a gate review's contract is complete at its ACTION line
    expect(parseAdjudicator('WRONG: review-1 out of scope.\nACTION: approve\n\nWhat I checked: the brief and the diff.', 'gate')).toEqual({
      kind: 'adjudicator',
      verdicts: ['WRONG: review-1 out of scope.'],
      action: { type: 'approve', reason: null },
      report: null,
    })
  })

  test('a contract line after the notes is a second answer: unparseable, as a misshapen one before the contract is (#559)', () => {
    const merge = 'NIT: harmless.\nACTION: merge\nSUMMARY: x\nBUMP: patch y\nFLAGS: none\n\nWhat I checked:\n- the diff.'
    const after = [
      'ACTION: hold the owner must decide',
      'ACTION: merge',
      'CORRECT: review-2 is real after all.',
      'SUMMARY: something else',
      'BUMP: major z',
      'FLAGS: image',
      '- WRONG: review-1 out of scope.',
      '**ACTION**: hold wait',
      '`NIT`: harmless.',
    ]
    for (const line of after) {
      expect(readAdjudicator(`${merge}\n${line}`, 'merge')).toBe(`a contract line after the notes that follow the contract: ${JSON.stringify(line)}`)
    }
    const gate = 'CORRECT: review-1 real.\nACTION: fix --findings review-1\nChecks: I reproduced it.'
    expect(parseAdjudicator(`${gate}\nACTION: approve`, 'gate')).toBeNull()
    expect(parseAdjudicator(`${gate}\n- DUP: review-2 is review-1.`, 'gate')).toBeNull()
    // a misshapen line right after the contract is no note either
    expect(readAdjudicator('ACTION: merge\nSUMMARY: x\nBUMP: patch y\nFLAGS: none\n- NIT: harmless.', 'merge')).toBe(
      'a line after the first contract line that is not a contract line: "- NIT: harmless."',
    )
    // until the contract is complete, a note is a stray line inside it
    expect(readAdjudicator('ACTION: merge\nChecks:\nSUMMARY: x\nBUMP: patch y\nFLAGS: none', 'merge')).toBe('a line after the first contract line that is not a contract line: "Checks:"')
    expect(readAdjudicator('ACTION: merge\nSUMMARY: x\nBUMP: patch y\nWhat I checked:\nFLAGS: none', 'merge')).toBe(
      'a line after the first contract line that is not a contract line: "What I checked:"',
    )
    expect(readAdjudicator('CORRECT: review-1 real.\nWhat I checked: the run.', 'gate')).toBe('a line after the first contract line that is not a contract line: "What I checked: the run."')
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

  test('gated with no run is unreadable, never done: no rule acts on a done handoff that names no run and is gated, so its issue would stall', () => {
    const gaveUp = 'I could not finish.\nRESULT run=none head=none commit=none gated=yes branch=feat/issue-470-x pr=none'
    expect(parseHandoff(gaveUp, null)).toBeNull()
    expect(readHandoff(gaveUp, null)).toBe('the RESULT line says gated=yes with run=none, and with no pipeline run nothing is gated: name the run, or say gated=no')
    // said not gated, it goes to the model (rule D5)
    expect(parseHandoff(gaveUp.replace('gated=yes', 'gated=no'), null)).toEqual({ kind: 'handoff', notGated: true, run: null, head: null, newBranch: 'feat/issue-470-x' })
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

describe('what kept a reply from parsing, for the repair message (#548)', () => {
  test('readAdjudicator names the line or the missing piece', () => {
    expect(readAdjudicator('WRONG: review-1 false positive.\nI checked the run and it looks fine.\nACTION: approve', 'gate')).toBe(
      'a line after the first contract line that is not a contract line: "I checked the run and it looks fine."',
    )
    expect(readAdjudicator('- WRONG: review-1 false positive.\nACTION: approve', 'gate')).toBe('a contract line in the wrong shape: "- WRONG: review-1 false positive."')
    expect(readAdjudicator('WRONG: review-1 false positive.', 'gate')).toBe('no ACTION line')
    expect(readAdjudicator('ACTION: approve\nACTION: skip', 'gate')).toBe('more than one ACTION line')
    expect(readAdjudicator('ACTION: approve --yes', 'gate')).toBe('the ACTION line does not read as any action the contract allows: "ACTION: approve --yes"')
    expect(readAdjudicator('ACTION: merge', 'gate')).toBe('ACTION merge does not answer a gate review, which takes approve, fix, skip, fixer, escalate')
    expect(readAdjudicator('ACTION: approve\nSUMMARY: x', 'weakening')).toBe('SUMMARY answers a merge review only, and this is a weakening review')
    expect(readAdjudicator('ACTION: merge\nSUMMARY: x', 'merge')).toBe('a merge review needs its BUMP, FLAGS lines')
    expect(readAdjudicator('ACTION: merge\nSUMMARY: x\nBUMP: huge\nFLAGS: none', 'merge')).toBe('the BUMP line is not patch, minor or major and its reason: "BUMP: huge"')
    expect(readAdjudicator('ACTION: merge\nSUMMARY: x\nBUMP: patch a fix\nFLAGS: docs', 'merge')).toBe('the FLAGS line is not none or a comma list of image, template, restart, run-it: "FLAGS: docs"')
    // what parses is the outcome parseAdjudicator gives
    expect(readAdjudicator('DUP: review-3 handled.\nACTION: skip', 'gate')).toEqual(parseAdjudicator('DUP: review-3 handled.\nACTION: skip', 'gate'))
  })

  test('readDesigner and readHandoff say where the RESULT line went wrong', () => {
    expect(readDesigner('Brief posted.', REPO, 470)).toBe('no RESULT line')
    expect(readDesigner(`RESULT brief=${BRIEF} created=none pending_decision=no\nThanks!`, REPO, 470)).toBe('the RESULT line is not the last line')
    expect(readDesigner('RESULT brief=none created=none', REPO, 470)).toBe(`the last line is not in the shape ${DESIGNER_RESULT}: "RESULT brief=none created=none"`)
    expect(readDesigner(`RESULT brief=${BRIEF} created=none pending_decision=no`, REPO, 471)).toBe('brief= is neither none nor a comment URL on cbundy/dev-system issue 471')
    expect(readDesigner('RESULT brief=none created=4a pending_decision=no', REPO, 470)).toBe('created= is neither none nor issue numbers joined by commas')
    expect(readHandoff('All done.', null)).toBe('no RESULT line, and it does not say NOT GATED')
    expect(readHandoff('RESULT run=01K7S2 head=xyz commit=none gated=yes branch=b pr=none', null)).toBe(
      `the RESULT line is not in the shape ${HANDOFF_RESULT}: "RESULT run=01K7S2 head=xyz commit=none gated=yes branch=b pr=none"`,
    )
  })
})
