"use strict";

// The factory loop v2's patch identity, images/base/callum-flow-patch-id (docs/factory-loop/v2/SPEC.md
// 8.4), run for real against a local bare origin: the loop keys a review's approval by it and the
// merge guard's --patch mode checks it, so a clean merge of main into the PR's branch (what
// `gh pr update-branch` does) must keep it, even where main changed lines next to the PR's, and any
// change to the PR's own lines must change it. It reads only: the checkout it runs in keeps its HEAD
// and its tree. Plugin tests cannot run git, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "images", "base", "callum-flow-patch-id");

let root;

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
const commit = (cwd, message) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};
const lines = (n, at = {}) => Array.from({ length: n }, (_, i) => at[i + 1] ?? String(i + 1)).join("\n") + "\n";

// patchId: the script, run from a checkout; { code, out, err }.
function patchId(cwd, ...args) {
  const r = spawnSync("sh", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-patch-id-")));
});

after(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

// world: a bare origin with main (a 20-line file), a writer's clone that pushes, and the loop's
// clone (the main checkout the loop and the guard run in), cloned before any branch exists.
let worlds = 0;
function world() {
  const dir = path.join(root, `w${++worlds}`);
  fs.mkdirSync(dir);
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const writer = path.join(dir, "writer");
  git(dir, "clone", "-q", origin, writer);
  write(writer, "f.txt", lines(20));
  commit(writer, "base");
  git(writer, "push", "-q", "origin", "HEAD:main");
  const loop = path.join(dir, "loop");
  git(dir, "clone", "-q", origin, loop);
  return { origin, writer, loop };
}

// pr: the writer's branch issue-7 off main, changing line 10, pushed.
function pr(w) {
  git(w.writer, "checkout", "-q", "-b", "issue-7", "origin/main");
  write(w.writer, "f.txt", lines(20, { 10: "ten" }));
  return { head: commit(w.writer, "the change"), push: () => git(w.writer, "push", "-q", "origin", "issue-7") };
}

// moveMain: main changes line 12, two lines from the PR's change, pushed from a clone of its own.
function moveMain(w, at = { 12: "twelve" }) {
  const other = path.join(path.dirname(w.writer), `main-${Object.keys(at).join("-")}`);
  git(path.dirname(w.writer), "clone", "-q", w.origin, other);
  write(other, "f.txt", lines(20, at));
  commit(other, "main moves on");
  git(other, "push", "-q", "origin", "HEAD:main");
}

test("the id is git patch-id --stable of the zero-context diff from the merge base, by branch name or by sha, against main or origin/main", () => {
  const w = world();
  const { head, push } = pr(w);
  push();
  const byBranch = patchId(w.loop, "issue-7", "main");
  assert.equal(byBranch.code, 0, byBranch.err);
  assert.match(byBranch.out, /^[0-9a-f]{40}$/);
  const expected = execFileSync("sh", ["-c", "git diff -U0 --no-color origin/main origin/issue-7 | git patch-id --stable | cut -d' ' -f1"], { cwd: w.loop, encoding: "utf8" }).trim();
  assert.equal(byBranch.out, expected);
  assert.deepEqual(patchId(w.loop, head, "origin/main"), { code: 0, out: expected, err: "" });
});

test("a clean merge of main into the branch keeps the id where main changed lines next to the PR's; git's default context would not", () => {
  const w = world();
  const { push } = pr(w);
  push();
  const before = patchId(w.loop, "issue-7", "main").out;
  const contextBefore = execFileSync("sh", ["-c", "git diff origin/main...origin/issue-7 | git patch-id --stable | cut -d' ' -f1"], { cwd: w.loop, encoding: "utf8" }).trim();
  moveMain(w);
  // gh pr update-branch: GitHub merges main into the PR's branch
  git(w.writer, "fetch", "-q", "origin");
  git(w.writer, "merge", "-q", "--no-edit", "origin/main");
  const updated = git(w.writer, "rev-parse", "HEAD");
  git(w.writer, "push", "-q", "origin", "issue-7");
  const after = patchId(w.loop, updated, "main");
  assert.equal(after.code, 0, after.err);
  assert.equal(after.out, before);
  git(w.loop, "fetch", "-q", "origin");
  const contextAfter = execFileSync("sh", ["-c", "git diff origin/main...origin/issue-7 | git patch-id --stable | cut -d' ' -f1"], { cwd: w.loop, encoding: "utf8" }).trim();
  assert.notEqual(contextAfter, contextBefore, "git's own context lines change the id: the test would prove nothing");
});

test("any change to the PR's own lines changes the id: a push on top, an amended change, a different binary file", () => {
  const w = world();
  const { push } = pr(w);
  push();
  const approved = patchId(w.loop, "issue-7", "main").out;
  write(w.writer, "f.txt", lines(20, { 10: "ten", 15: "fifteen" }));
  const pushed = commit(w.writer, "a person's push");
  git(w.writer, "push", "-q", "origin", "issue-7");
  assert.notEqual(patchId(w.loop, pushed, "main").out, approved);
  // the same files, another edit
  git(w.writer, "checkout", "-q", "-B", "issue-8", "origin/main");
  write(w.writer, "f.txt", lines(20, { 10: "TEN" }));
  const amended = commit(w.writer, "the change, amended");
  git(w.writer, "push", "-q", "origin", "issue-8");
  assert.notEqual(patchId(w.loop, amended, "main").out, approved);
  // two binary changes to one file are told apart (the blobs, not "Binary files differ")
  const ids = ["\u0000\u0001\u0002", "\u0000\u0001\u0003"].map((bytes, i) => {
    git(w.writer, "checkout", "-q", "-B", `bin-${i}`, "origin/main");
    write(w.writer, "blob.bin", bytes);
    const head = commit(w.writer, "binary");
    git(w.writer, "push", "-q", "origin", `bin-${i}`);
    const r = patchId(w.loop, head, "main");
    assert.equal(r.code, 0, r.err);
    return r.out;
  });
  assert.notEqual(ids[0], ids[1]);
});

test("a head the checkout lacks is fetched from origin by its id; the checkout keeps its HEAD and its tree", () => {
  const w = world();
  const { head, push } = pr(w);
  push();
  write(w.loop, "f.txt", "a local edit\n");
  const headBefore = git(w.loop, "rev-parse", "HEAD");
  const status = git(w.loop, "status", "--porcelain");
  assert.throws(() => git(w.loop, "cat-file", "-e", `${head}^{commit}`));
  const r = patchId(w.loop, head, "main");
  assert.equal(r.code, 0, r.err);
  assert.equal(git(w.loop, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(w.loop, "status", "--porcelain"), status);
  assert.equal(git(w.loop, "symbolic-ref", "--short", "HEAD"), "main");
});

test("what cannot be computed exits 1 with the reason; bad usage exits 2", () => {
  const w = world();
  const none = patchId(w.loop, "main", "main");
  assert.equal(none.code, 1);
  assert.match(none.err, /main changes nothing against origin\/main/);
  const missing = patchId(w.loop, "issue-404", "main");
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot fetch origin\/issue-404/);
  const unknownSha = patchId(w.loop, "0".repeat(40), "main");
  assert.equal(unknownSha.code, 1);
  assert.match(unknownSha.err, /is not available from origin/);
  assert.equal(patchId(w.loop, "issue-7", "no-such-base").code, 1);
  for (const args of [[], ["issue-7"], ["issue-7", "main", "extra"], ["-x", "main"], ["issue-7", "--bad"], ["issue-7", "bad..ref"]]) {
    assert.equal(patchId(w.loop, ...args).code, 2, args.join(" "));
  }
});
