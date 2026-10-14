// One table of structured answers and what the contract says of each (#561), shared by both ends
// of the answer script: tests/answer-contract.test.ts reads each through the loop (the file the
// script writes, checked again at the agent's turn.complete, and the same input through the
// answer tool), and tests/factory-loop-answer.test.js at the repo root runs bin/factory-answer
// on each for real. Both hold every case to the same problems, so the script and the loop cannot
// drift apart unseen. Plain JS, so node and the engine's test kit both import it.

const REPO = 'cbundy/dev-system'
const BRIEF = `https://github.com/${REPO}/issues/470#issuecomment-3301234567`

// The job of each agent and purpose, as the loop writes its job file at the spawn.
export const JOBS = Object.freeze({
  gate: { contract: 'verdict', purpose: 'gate', repo: REPO, issue: 470, branch: null },
  weakening: { contract: 'verdict', purpose: 'weakening', repo: REPO, issue: 470, branch: null },
  merge: { contract: 'verdict', purpose: 'merge', repo: REPO, issue: 470, branch: null },
  designer: { contract: 'design', purpose: null, repo: REPO, issue: 470, branch: null },
  implementer: { contract: 'handoff', purpose: null, repo: REPO, issue: 470, branch: null },
  fixer: { contract: 'handoff', purpose: null, repo: REPO, issue: 470, branch: 'feat/issue-470-x' },
})

// name, the job it answers, the input, and the problems the contract names (none: recorded).
export const CASES = Object.freeze([
  {
    name: 'a gate approved, its finding judged WRONG',
    job: 'gate',
    input: { findings: [{ id: 'review-1', verdict: 'WRONG', reason: 'the timeout is handled in parse.ts' }], action: { type: 'approve', reason: 'review-1 is a false positive' } },
    problems: [],
  },
  {
    name: "a gate's CORRECT finding sent to the pipeline, with a gap the reviewer missed",
    job: 'gate',
    input: {
      findings: [{ id: 'review-1', verdict: 'CORRECT', reason: 'a moved HEAD is accepted' }],
      action: { type: 'fix', findings: ['review-1'], instructions: 'reject a moved HEAD', addFinding: { id: 'missed-1', note: 'no test' } },
    },
    problems: [],
  },
  {
    name: 'a gate answer broken everywhere: a bad id, verdict and reason, a merge action, a report field',
    job: 'gate',
    input: { findings: [{ id: 'review 1', verdict: 'MAYBE', reason: '' }], action: { type: 'merge' }, summary: 'x' },
    problems: [
      'findings[0].reason must not be empty',
      'findings[0].verdict must be one of CORRECT, WRONG, NIT, ENV, DUP',
      'findings[0].id "review 1" is not a finding id such as review-1',
      'action must be { type, ... } with type one of approve, fix, skip, fixer, escalate: a gate review takes no other',
      'summary answer a merge review only, and this is a gate review',
    ],
  },
  {
    name: 'a fix that names a WRONG finding and a missed gap, with a stray field',
    job: 'gate',
    input: {
      findings: [{ id: 'review-1', verdict: 'WRONG', reason: 'out of scope', extra: true }],
      action: { type: 'fix', findings: ['review-1', 'missed-1'] },
    },
    problems: [
      'findings[0].extra is not a field here',
      'action.findings: review-1 is judged WRONG, and a fix is for CORRECT or ENV findings',
      'action.findings: missed-1 is a gap the reviewer missed, which the gate does not know: put it in action.addFinding',
    ],
  },
  {
    name: 'a test-weakening review escalated',
    job: 'weakening',
    input: { findings: [], action: { type: 'escalate', why: 'the brief does not say whether the test is still needed' } },
    problems: [],
  },
  {
    name: 'a merge review that merges, with its report',
    job: 'merge',
    input: { findings: [], action: { type: 'merge' }, summary: 'the loop acts on the factory', bump: { level: 'minor', reason: 'a new capability' }, flags: ['image'] },
    problems: [],
  },
  {
    name: 'a merge review short of its report, with a flag the loop does not know',
    job: 'merge',
    input: { findings: [], action: { type: 'hold' }, summary: 'x', flags: ['docs'] },
    problems: ['action.reason is required', 'bump is required: { level: patch|minor|major, reason }', 'flags: "docs" is not one of image, template, restart, run-it'],
  },
  {
    name: 'a design with its brief',
    job: 'designer',
    input: { brief: BRIEF, created: [], pendingDecision: false },
    problems: [],
  },
  {
    name: "a design whose brief is on another issue, its decision flag missing",
    job: 'designer',
    input: { brief: `https://github.com/${REPO}/issues/471#issuecomment-1`, created: [] },
    problems: [
      `brief "https://github.com/${REPO}/issues/471#issuecomment-1" is not a comment URL on ${REPO} issue 470 (https://github.com/${REPO}/issues/470#issuecomment-<id>)`,
      'pendingDecision must be true or false',
    ],
  },
  {
    name: 'a design that leaves the loop nothing to hand on',
    job: 'designer',
    input: { brief: null, created: [], pendingDecision: false },
    problems: ['with no brief, no created issues and no decision pending, the loop has nothing to hand on: give the brief URL'],
  },
  {
    name: "an implementer's gated handoff",
    job: 'implementer',
    input: { run: '01K7RRXQ7M2YB9ZB3J8N0V5F6D', head: 'abc1234', commit: 'abc1234', gated: true, branch: 'feat/issue-470-x', pr: 512 },
    problems: [],
  },
  {
    name: 'a handoff gated with no run',
    job: 'implementer',
    input: { run: null, head: null, commit: null, gated: true, branch: 'feat/issue-470-x', pr: null },
    problems: ['gated is true with run null, and with no pipeline run nothing is gated: give the run, or gated false'],
  },
  {
    name: "a fixer's handoff on a new branch",
    job: 'fixer',
    input: { run: 'R471', head: 'abcdef1', commit: 'abcdef1', gated: true, branch: 'feat/issue-470-x-v2', pr: 561 },
    problems: [],
  },
  {
    name: 'a handoff with bad shapes, a missing field and a stray one',
    job: 'fixer',
    input: { run: 'run 1', head: 'xyz', commit: null, gated: 'yes', branch: 'feat/issue-470-x', notes: 'done' },
    problems: [
      'notes is not a field here',
      'run "run 1" is not a pipeline run id, or null',
      'head "xyz" is not a commit SHA of 7 to 40 hex digits, or null',
      'gated must be true or false',
      'pr is required (null for none)',
    ],
  },
  {
    name: 'an answer that is no object',
    job: 'designer',
    input: ['brief'],
    problems: [
      `brief is required: the brief comment's URL on ${REPO} issue 470, or null`,
      'created must be a list of the issue numbers you created ([] for none)',
      'pendingDecision must be true or false',
    ],
  },
])
