'use strict';
// Lint-style guard (cbundy/dev-system#307, #311): shipped prose must not tell an agent to
// read issue, comment, PR or timeline text with raw gh. The one sanctioned read path is
// `callum-flow-issue-read`. Writes (`gh issue comment`, `gh pr edit`) are not reads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN = ['plugins', 'docs', 'templates'];
const EXTS = new Set(['.md', '.sh', '.js']);

const RAW_READS = [
  { name: 'gh issue view', re: /\bgh\s+issue\s+view\b/ },
  { name: 'gh issue list', re: /\bgh\s+issue\s+list\b/ },
  { name: 'gh pr view --comments', re: /\bgh\s+pr\s+view\b[^\n]*--comments\b/ },
  { name: 'gh api on a text path', re: /\bgh\s+api\b[^\n]*(issues\/|pulls\/|comments|timeline|reviews)/ },
];

// Lines that mention a raw read without telling an agent to run it. Keyed by file, matched
// by substring so a line move does not break the entry. Keep this list short and justified.
const ALLOW = [
  // Explains why `gh api` is deliberately absent from the allow list; not an instruction.
  { file: 'templates/README.md', includes: '(`gh api -X PUT .../pulls/N/merge`)' },
  // The hook that denies raw reads and the README that documents its deny list name the
  // forms they refuse; neither tells an agent to run them.
  { file: 'plugins/callum-flow/hooks/forbid-raw-gh-read.sh', includes: 'gh issue view/list/status forms' },
  { file: 'plugins/callum-flow/hooks/forbid-raw-gh-read.sh', includes: 'and PRs, gh api paths for issues' },
  { file: 'templates/README.md', includes: 'which denies `gh issue view`' },
];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

function findings(file, text) {
  const rel = path.relative(ROOT, file);
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const r of RAW_READS) {
      if (!r.re.test(line)) continue;
      if (ALLOW.some((a) => a.file === rel && line.includes(a.includes))) continue;
      hits.push(`${rel}:${i + 1}: ${r.name}: ${line.trim()}`);
    }
  });
  return hits;
}

test('shipped prose does not instruct raw issue, comment or PR text reads', () => {
  const files = SCAN.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d), []) : []));
  assert.ok(files.length > 0, 'scanned no files');
  const hits = files.flatMap((f) => findings(f, fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(hits, [], `raw reads bypass callum-flow-issue-read:\n${hits.join('\n')}`);
});

test('the scanner flags raw reads and ignores writes', () => {
  const f = path.join(ROOT, 'fixture.md');
  for (const bad of [
    'gh issue view 5 --comments',
    'gh issue list --label ready',
    'gh pr view 7 --json body --comments',
    'gh api repos/o/r/issues/5/timeline',
    'gh api repos/o/r/pulls/5/reviews',
    'gh api repos/o/r/issues/comments/9',
  ]) assert.strictEqual(findings(f, `run ${bad} now`).length >= 1, true, bad);
  for (const ok of [
    'gh issue comment 5 --body-file x',
    'gh pr view 7 --json closingIssuesReferences',
    'callum-flow-issue-read 5 --comments',
    'gh pr edit 7 --body-file x',
  ]) assert.deepStrictEqual(findings(f, ok), [], ok);
});
