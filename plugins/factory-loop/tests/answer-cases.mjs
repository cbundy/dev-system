// One table of structured answers and what the contract says of each (#561), shared by both ends
// of the answer script: tests/answer-contract.test.ts reads each through the loop (the file the
// script writes, checked again at the agent's turn.complete, and the same input through the
// answer tool), and tests/factory-loop-answer.test.js at the repo root runs bin/factory-answer
// on each for real. Both hold every case to the same problems, so the script and the loop cannot
// drift apart unseen. Plain JS, so node and the engine's test kit both import it.

const REPO = 'cbundy/dev-system'
const CONSUMER = 'cbundy/consumer'

// The job of each contract, as the loop writes its job file at the spawn.
export const JOBS = Object.freeze({
  designV2: { contract: 'design-v2', purpose: null, repo: REPO, issue: 470, branch: null },
  // a consumer's design, which may raise an issue upstream (REPO): its job data holds the owner notes of the step
  designUpstream: { contract: 'design-v2', purpose: null, repo: CONSUMER, issue: 470, branch: null, data: { ownerNotes: ['Please raise it upstream in cbundy/dev-system:\nthe reader drops the   quote, it is broken.'] } },
  review: { contract: 'review', purpose: null, repo: REPO, issue: 470, branch: 'issue-470', data: { round: 2 } },
})


// upstreamOf: a valid upstream answer, with the given fields over the defaults.
function upstreamOf(over) {
  return {
    kind: 'upstream',
    upstream: { repo: REPO, request: 'bug', title: 'The reader drops a quote', body: 'callum-flow-issue-read drops the quote in a comment body.\n\nSteps: ...', ...over },
    reason: 'Waits on the reader fix',
    brief: null,
  }
}

// name, the job it answers, the input, and the problems the contract names (none: recorded).
export const CASES = Object.freeze([
  {
    name: 'a v2 wait on a closed issue and a merged PR',
    job: 'designV2',
    input: { kind: 'wait', conditions: [{ kind: 'issue-closed', issue: 57 }, { kind: 'pr-merged', pr: 812 }], reason: 'Needs #57 closed and PR #812 merged first', brief: null },
    problems: [],
  },
  {
    name: 'a v2 wait on a release tag that holds a 7-hex and a 40-hex commit',
    job: 'designV2',
    input: { kind: 'wait', conditions: [{ kind: 'tag-contains', sha: '35bb655' }, { kind: 'tag-contains', sha: '35bb655a1b2c3d4e5f60718293a4b5c6d7e8f901' }], reason: 'Waits on the release that carries both commits', brief: null },
    problems: [],
  },
  {
    name: 'a v2 wait on a release tag with a bad sha, a stray field and a repeated sha',
    job: 'designV2',
    input: {
      kind: 'wait',
      conditions: [{ kind: 'tag-contains', sha: 'xyz' }, { kind: 'tag-contains', sha: '35bb655', extra: 1 }, { kind: 'tag-contains', sha: '35BB655' }],
      reason: 'Waits on a release',
      brief: null,
    },
    problems: [
      'conditions[0].sha "xyz" must be 7 to 40 hex characters (a commit sha)',
      'extra is not a field of conditions[1] (only kind, sha, repo)',
      'conditions[2] repeats tag-contains:35bb655',
    ],
  },
  {
    name: 'a v2 done close on a merged PR, with a commit and a run-it comment of the issue',
    job: 'designV2',
    input: {
      kind: 'done',
      evidence: { pr: 913, commit: 'BD2FEE14', runIt: `https://github.com/${REPO}/issues/470#issuecomment-4242` },
      reason: 'Already shipped in PR 913',
      brief: null,
    },
    problems: [],
  },
  {
    name: 'a v2 done close with neither a PR nor a commit',
    job: 'designV2',
    input: { kind: 'done', evidence: { pr: null, commit: null, runIt: null }, reason: 'Already shipped', brief: null },
    problems: ['evidence needs a merged pr or a commit on the default branch (at least one)'],
  },
  {
    name: 'a v2 done close with a bad PR, a bad commit, a stray evidence field and a run-it of another repo',
    job: 'designV2',
    input: { kind: 'done', evidence: { pr: 0, commit: 'xyz', extra: 1, runIt: 'https://github.com/o/r/issues/470#issuecomment-1' }, reason: 'Already shipped', brief: null },
    problems: [
      'evidence.extra is not a field of the evidence (only pr, commit, runIt)',
      'evidence.pr 0 must be a whole number of at least 1, or null',
      'evidence.commit "xyz" must be 7 to 40 hex characters (a commit sha), or null',
      `evidence.runIt "https://github.com/o/r/issues/470#issuecomment-1" must be a comment URL on this issue: https://github.com/${REPO}/issues/470#issuecomment-<digits>, or null`,
    ],
  },
  {
    name: 'a v2 done close with no evidence, a multi-line reason, a stray field and conditions',
    job: 'designV2',
    input: { kind: 'done', reason: 'one\ntwo', conditions: [], extra: 1, brief: null },
    problems: [
      'extra is not a field of a design answer (only kind, brief, question, context, options, recommendation, reasons, children, conditions, reason, evidence, upstream)',
      'conditions must be absent or null unless kind is wait',
      'evidence is required for done: { pr, commit, runIt }, at least one of pr and commit',
      'reason must be one line',
    ],
  },
  {
    name: 'a v2 done close with no reason',
    job: 'designV2',
    input: { kind: 'done', evidence: { pr: 3, commit: null, runIt: null }, brief: null },
    problems: ['reason is required'],
  },
  {
    name: 'a v2 upstream request on the owner note that holds the quote (whitespace, case and curly quotes ignored)',
    job: 'designUpstream',
    input: upstreamOf({ authority: { kind: 'owner', source: 'note', quote: 'RAISE it upstream in cbundy/dev-system: the reader drops the quote' } }),
    problems: [],
  },
  {
    name: 'a v2 upstream bug request on a confident bug authority',
    job: 'designUpstream',
    input: upstreamOf({ authority: { kind: 'bug', blocking: 'every design of a consumer stalls on it; the workaround is to hand-edit the job file', confidence: 'reproduced: callum-flow-issue-read exits 1 (images/base/callum-flow-issue-read:157)' } }),
    problems: [],
  },
  {
    name: 'a v2 upstream need on a bug authority is refused: a need rests on the owner',
    job: 'designUpstream',
    input: upstreamOf({ request: 'need', authority: { kind: 'bug', blocking: 'it blocks a thing', confidence: 'reproduced it once' } }),
    problems: ['upstream.authority.kind "bug" is allowed only with request "bug"; a need rests on the owner\'s word'],
  },
  {
    name: 'a v2 upstream request whose quote is in no owner note',
    job: 'designUpstream',
    input: upstreamOf({ authority: { kind: 'owner', source: 'note', quote: 'please file this against the other repo' } }),
    problems: ['upstream.authority.quote "please file this against the other repo" is in no owner note of this step: quote the note word for word, or use the URL of the comment or issue that holds it'],
  },
  {
    name: 'a v2 upstream request to a repo outside the list, and a short quote',
    job: 'designUpstream',
    input: upstreamOf({ repo: 'other/repo', authority: { kind: 'owner', source: 'note', quote: 'raise it' } }),
    problems: ['upstream.repo "other/repo" is not one of cbundy/dev-system', 'upstream.authority.quote is 8 characters; 10 to 500'],
  },
  {
    name: "a v2 upstream request to the job's own repo",
    job: 'designV2',
    input: upstreamOf({ authority: { kind: 'bug', blocking: 'it blocks a thing', confidence: 'reproduced it once' } }),
    problems: ["upstream.repo cbundy/dev-system is this issue's own repo; an upstream request goes to another one"],
  },
  {
    name: 'a v2 upstream request with a missing field, stray fields, a multi-line title and a source that is no issue of the job',
    job: 'designUpstream',
    input: { kind: 'upstream', upstream: { repo: 'cbundy/dev-system', request: 'bug', title: 'a\nb', extra: 1, authority: { kind: 'owner', source: 'https://github.com/cbundy/other/issues/1#issuecomment-2', quote: 'raise it upstream please', extra: 1 } }, reason: 'Waits on the fix', brief: null },
    problems: [
      'upstream.extra is not a field of an upstream request (only repo, request, title, body, authority)',
      'upstream.title must be one line',
      'upstream.body is required: text, not undefined',
      'upstream.authority.extra is not a field of an owner authority (only kind, source, quote)',
      'upstream.authority.source "https://github.com/cbundy/other/issues/1#issuecomment-2" must be "note", the URL of this issue (https://github.com/cbundy/consumer/issues/470) or a comment URL on it (...#issuecomment-<digits>)',
    ],
  },
  {
    name: 'an upstream field on another kind of v2 design answer',
    job: 'designV2',
    input: { kind: 'wait', conditions: [{ kind: 'issue-closed', issue: 57 }], reason: 'Waits', brief: null, upstream: { repo: 'cbundy/dev-system' } },
    problems: ['upstream must be absent or null unless kind is upstream'],
  },
  {
    name: 'a v2 review that approves, with a warning',
    job: 'review',
    input: { verdict: 'approve', findings: [{ id: 'r2-1', severity: 'warning', file: 'hooks/x.ts', line: 4, text: 'a nit worth a look' }], summary: 'the change does what the brief asks', bump: 'patch' },
    problems: [],
  },
  {
    name: 'a v2 review that asks for changes with no error finding, a bad bump and a stray field',
    job: 'review',
    input: { verdict: 'changes', findings: [], summary: 'x', bump: 'huge', more: true },
    problems: [
      'more is not a field of a review answer (only verdict, findings, summary, bump)',
      'changes needs at least one error finding: the change a fixer must make',
      'bump "huge" is not one of patch, minor, major',
    ],
  },
])
