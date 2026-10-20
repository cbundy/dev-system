// Tests for images/base/release-contents.js (dev-system#1010): the one definition of what a
// release carried.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const rc = require("../images/base/release-contents.js");

const BODY = fs.readFileSync(path.join(__dirname, "fixtures", "release-contents", "v0.62.0-body.md"), "utf-8");

test("previousTag ignores release candidates and takes the highest final tag below", () => {
  const tags = ["v0.9.0", "v0.10.0", "v0.11.0-rc.1", "v0.11.0", "v0.12.0-rc.1", "vfoo", "v0.12.0-rc.2"];
  assert.equal(rc.previousTag(tags, "0.12.0"), "v0.11.0");
  assert.equal(rc.previousTag(tags, "0.12.0-rc.2"), "v0.11.0");
  assert.equal(rc.previousTag(tags, "v0.11.0"), "v0.10.0");
  assert.equal(rc.previousTag(tags, "0.9.0"), null);
  assert.equal(rc.previousTag([], "1.0.0"), null);
});

test("compareVersions and isFinal", () => {
  assert.equal(rc.compareVersions("v0.10.0", "v0.9.0"), 1);
  assert.equal(rc.compareVersions("0.1.0-rc.1", "0.1.0"), -1);
  assert.equal(rc.isFinal("v0.1.0"), true);
  assert.equal(rc.isFinal("v0.1.0-rc.1"), false);
});

test("parseCommit reads the trailing (#N) of a squash subject", () => {
  assert.deepEqual(rc.parseCommit({ subject: "feat: a thing (#12)", body: "b" }), { subject: "feat: a thing (#12)", body: "b", pr: "12" });
  assert.equal(rc.parseCommit({ subject: "Direct push to main" }).pr, null);
  assert.equal(rc.parseCommit({ subject: "mentions (#3) mid-subject" }).pr, null);
});

// A history with a merge: base <- m1(#11) <- m2(#12) <- merge(m2, s1), s1 on a side branch.
function history() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-contents-"));
  const git = (...a) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base (#1)");
  git("tag", "v0.1.0");
  git("checkout", "-q", "-b", "side");
  git("commit", "-q", "--allow-empty", "-m", "side work (#99)");
  git("checkout", "-q", "main");
  git("commit", "-q", "--allow-empty", "-m", "first (#11)");
  git("commit", "-q", "--allow-empty", "-m", "second (#12)");
  git("merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
  return { dir, git };
}

test("gitRangeCommits reads only first-parent commits, newest first", () => {
  const { dir } = history();
  try {
    const commits = rc.gitRangeCommits(dir, "v0.1.0..HEAD");
    assert.deepEqual(commits.map((c) => c.pr), [null, "12", "11"]);
    assert.equal(commits[0].subject, "Merge branch side");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("firstParentChain over a compare-shaped list gives the same PRs as gitRangeCommits", () => {
  const { dir, git } = history();
  try {
    const fmt = "%H%x1f%P%x1f%s";
    const rows = git("log", "--format=" + fmt, "v0.1.0..HEAD").split("\n").map((l) => l.split("\x1f"));
    // The compare endpoint lists oldest first and only commits not reachable from the base.
    const compare = rows.reverse().map(([sha, parents, subject]) => ({ sha, parents: parents.split(" ").filter(Boolean).map((s) => ({ sha: s })), commit: { message: subject } }));
    const head = git("rev-parse", "HEAD");
    const chain = rc.firstParentChain(compare, head);
    const viaApi = chain.map((c) => rc.parseCommit({ subject: c.commit.message }).pr);
    assert.deepEqual(viaApi, rc.gitRangeCommits(dir, "v0.1.0..HEAD").map((c) => c.pr));
    assert.equal(chain.length, 3, "the side commit is not on the chain");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prLinks reads Refs and Part of for this repo only", () => {
  const repo = "cbundy/dev-system";
  assert.deepEqual(rc.prLinks("Refs #3\nPart of #4\nrefs cbundy/dev-system#5", repo), [3, 4, 5]);
  assert.deepEqual(rc.prLinks("PART OF #8", repo), [8]);
  assert.deepEqual(rc.prLinks("Refs o/x#6\nClosing #7\nCloses #9", repo), []);
  assert.deepEqual(rc.prLinks("", repo), []);
  assert.deepEqual(rc.prLinks(null, repo), []);
});

test("contents dedupes, orders ascending and drops a cross-repo closing ref", () => {
  const repo = "cbundy/dev-system";
  const node = (number, nameWithOwner = repo) => ({ number, repository: { nameWithOwner } });
  const out = rc.contents(
    [
      { number: 30, body: "Refs #5\nPart of #40", closing: [node(20), node(7, "other/repo")] },
      { number: 20, body: "Refs #20", closing: [node(10), node(20, "CBUNDY/dev-system")] },
      { number: 30, body: "", closing: [] },
    ],
    repo,
  );
  assert.deepEqual(out, { prs: [30, 20], issues_closed: [10, 20], issues: [5, 10, 20, 40] });
});

test("headlines of the v0.62.0 body are the seven bold titles, without Upgrade, Verify or Technical changes", () => {
  assert.deepEqual(rc.headlines(BODY), [
    "The loop migrates the factory database at start-up",
    "Release events in the factory log",
    "A claim records its score",
    "The settings in force, on disk",
    "Dependency facts for scoring",
    "A split child that needs the owner is asked, not silent",
    "Tests no longer touch the real databases",
  ]);
  const withTech = `${BODY}\n<details>\n<summary>Technical changes</summary>\n\n- **Not a headline** - x\n</details>\n`;
  assert.equal(rc.headlines(withTech).length, 7);
});

test("headlines: an empty body, a bullet with no bold lead, and a long title", () => {
  assert.deepEqual(rc.headlines(""), []);
  assert.deepEqual(rc.headlines(undefined), []);
  assert.deepEqual(rc.headlines("## New\n\n- plain bullet\n- **Kept** - yes\n"), ["Kept"]);
  const long = "x".repeat(250);
  assert.deepEqual(rc.headlines(`## New\n\n- **  ${long}  ** - d\n`), ["x".repeat(200)]);
});
