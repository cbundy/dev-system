"use strict";

// The factory loop's fast-forward (plugins/factory-loop/hooks/act-merge.ts FF_SCRIPT, #551, #595),
// run for real by sh from a scratch main checkout whose origin is a local bare repo. The pipeline
// commits in its own checkout and pushes, so the implementer's worktree lags its branch by
// exactly those commits; the script must move such a worktree to the run's head, also when the
// loop's own update-behind then pushed a rebased head over it, and refuse a dirty one, a diverged
// one, or an origin that is not the expected head, leaving each as it was.
// parseFastForward (the same module) must read its real output. Plugin tests cannot run a shell,
// so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (scripts/factory-loop-replay.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const ACT_MERGE = path.join(__dirname, "..", "plugins", "factory-loop", "hooks", "act-merge.ts");
const BRANCH = "issue-50-work";

let m;
let root;

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const commit = (cwd, file, text) => {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
};

before(async () => {
  m = await import(ACT_MERGE);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-ff-")));
});

after(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

// world: a bare origin; the main checkout, with the implementer's worktree on the branch at its
// handoff; and the pipeline's checkout, which then pushes two commits of its own on the branch.
let worlds = 0;
function world() {
  const dir = path.join(root, `w${++worlds}`);
  fs.mkdirSync(dir);
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const pipeline = path.join(dir, "pipeline");
  git(dir, "clone", "-q", origin, pipeline);
  commit(pipeline, "a.txt", "one\n");
  git(pipeline, "push", "-q", "origin", "HEAD:main");
  git(pipeline, "switch", "-q", "-c", BRANCH);
  const handoff = commit(pipeline, "b.txt", "the implementer's work\n");
  git(pipeline, "push", "-q", "origin", BRANCH);
  const main = path.join(dir, "main");
  git(dir, "clone", "-q", origin, main);
  const wt = path.join(dir, "slot 3");
  git(main, "worktree", "add", "-q", wt, BRANCH);
  commit(pipeline, "b.txt", "the implementer's work, reviewed\n");
  const head = commit(pipeline, "c.txt", "documented\n");
  git(pipeline, "push", "-q", "origin", BRANCH);
  return { dir, main, wt, pipeline, handoff, head };
}

// rebased: the loop's own update-behind after the run (callum-flow-merge-guard --update-behind):
// main moves on, and from the main checkout the run head is rebased onto it in a scratch worktree
// and pushed over the branch, so origin holds the rebased head and the run head is not on it.
function rebased(w) {
  git(w.pipeline, "switch", "-q", "main");
  commit(w.pipeline, "m.txt", "newer main\n");
  git(w.pipeline, "push", "-q", "origin", "main");
  git(w.main, "fetch", "-q", "origin");
  const scratch = path.join(w.dir, "update-behind");
  git(w.main, "worktree", "add", "-q", "--detach", scratch, w.head);
  git(scratch, "rebase", "-q", "origin/main");
  git(scratch, "push", "-q", `--force-with-lease=refs/heads/${BRANCH}:${w.head}`, "origin", `HEAD:refs/heads/${BRANCH}`);
  const pushed = git(scratch, "rev-parse", "HEAD");
  git(w.main, "worktree", "remove", scratch);
  return pushed;
}

function forward(cwd, head, expect = head, branch = BRANCH) {
  const [cmd, ...args] = m.fastForwardArgv(branch, head, expect);
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, read: m.parseFastForward(r.stdout) };
}

test("a worktree the pipeline's commits left behind is fast-forwarded to the run head, with both heads said", () => {
  const w = world();
  fs.writeFileSync(path.join(w.wt, "notes.md"), "untracked, kept\n");
  const r = forward(w.main, w.head);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "forwarded", line: `FORWARDED ${w.handoff} ${w.head} ${w.wt}` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.head);
  assert.equal(git(w.wt, "symbolic-ref", "--short", "HEAD"), BRANCH);
  assert.equal(fs.readFileSync(path.join(w.wt, "notes.md"), "utf8"), "untracked, kept\n");
  // once there, nothing lags
  assert.deepEqual(forward(w.main, w.head).read, { result: "current", line: `CURRENT ${w.head}` });
});

test("a worktree with uncommitted changes is refused and left as it was", () => {
  const w = world();
  fs.writeFileSync(path.join(w.wt, "b.txt"), "half done\n");
  const r = forward(w.main, w.head);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: `REFUSED ${w.wt} has uncommitted changes` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.handoff);
  assert.equal(fs.readFileSync(path.join(w.wt, "b.txt"), "utf8"), "half done\n");
});

test("a worktree with a commit origin does not have is refused and left as it was", () => {
  const w = world();
  const own = commit(w.wt, "d.txt", "made outside the pipeline\n");
  const r = forward(w.main, w.head);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: `REFUSED ${w.wt} at ${own} is not an ancestor of the run head ${w.head}` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), own);
});

test("a run head that is not origin's is refused: the branch moved, so the guard and the judge look", () => {
  const w = world();
  const r = forward(w.main, w.handoff);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: `REFUSED origin/${BRANCH} is ${w.head}, not the expected head ${w.handoff}` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.handoff);
});

test("the main checkout left behind on the branch is refused and left as it was: the loop never moves it (rule G5)", () => {
  const w = world();
  git(w.wt, "switch", "-q", "--detach");
  git(w.main, "switch", "-q", BRANCH);
  const r = forward(w.main, w.head);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: `REFUSED ${w.main} is the main worktree, which the loop never moves` });
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.handoff);
});

test("a fast-forward that cannot go through (an untracked file in its way) fails, and moves nothing", () => {
  const w = world();
  fs.writeFileSync(path.join(w.wt, "c.txt"), "in the way\n");
  const r = forward(w.main, w.head);
  assert.equal(r.exitCode, 1);
  assert.equal(r.read, null);
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.handoff);
  assert.equal(fs.readFileSync(path.join(w.wt, "c.txt"), "utf8"), "in the way\n");
});

test("the fast-forward runs none of the repo's git hooks: a post-merge npm install could outlast its timeout", () => {
  const w = world();
  // in the repo's own hooks dir, as husky sets core.hooksPath; worktrees share it
  const hooks = path.join(w.dir, "hooks");
  fs.mkdirSync(hooks);
  const marker = path.join(w.dir, "post-merge-ran");
  fs.writeFileSync(path.join(hooks, "post-merge"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(w.main, "config", "core.hooksPath", hooks);
  const r = forward(w.main, w.head);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "forwarded", line: `FORWARDED ${w.handoff} ${w.head} ${w.wt}` });
  assert.equal(fs.existsSync(marker), false);
  // the hook is live: a plain fast-forward runs it
  const more = commit(w.pipeline, "d.txt", "more\n");
  git(w.pipeline, "push", "-q", "origin", BRANCH);
  git(w.wt, "fetch", "-q", "origin");
  git(w.wt, "merge", "--ff-only", "-q", more);
  assert.equal(fs.existsSync(marker), true);
});

test("after the loop's own update-behind, a lagging worktree is fast-forwarded to the run head while origin holds the rebased head", () => {
  const w = world();
  const pushed = rebased(w);
  const r = forward(w.main, w.head, pushed);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "forwarded", line: `FORWARDED ${w.handoff} ${w.head} ${w.wt}` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.head);
  assert.equal(git(w.wt, "symbolic-ref", "--short", "HEAD"), BRANCH);
  assert.equal(git(w.main, "rev-parse", `refs/remotes/origin/${BRANCH}`), pushed);
  assert.deepEqual(forward(w.main, w.head, pushed).read, { result: "current", line: `CURRENT ${w.head}` });
});

test("after the loop's own update-behind, an origin that is not the pushed head, a dirty worktree and a diverged one are refused and left as they were", () => {
  const w = world();
  const pushed = rebased(w);
  const stale = forward(w.main, w.head);
  assert.equal(stale.exitCode, 0, stale.stderr);
  assert.deepEqual(stale.read, { result: "refused", line: `REFUSED origin/${BRANCH} is ${pushed}, not the expected head ${w.head}` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.handoff);
  fs.writeFileSync(path.join(w.wt, "b.txt"), "half done\n");
  const dirty = forward(w.main, w.head, pushed);
  assert.equal(dirty.exitCode, 0, dirty.stderr);
  assert.deepEqual(dirty.read, { result: "refused", line: `REFUSED ${w.wt} has uncommitted changes` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), w.handoff);
  assert.equal(fs.readFileSync(path.join(w.wt, "b.txt"), "utf8"), "half done\n");
  git(w.wt, "checkout", "-q", "--", "b.txt");
  const own = commit(w.wt, "d.txt", "made outside the pipeline\n");
  const diverged = forward(w.main, w.head, pushed);
  assert.equal(diverged.exitCode, 0, diverged.stderr);
  assert.deepEqual(diverged.read, { result: "refused", line: `REFUSED ${w.wt} at ${own} is not an ancestor of the run head ${w.head}` });
  assert.equal(git(w.wt, "rev-parse", "HEAD"), own);
});
