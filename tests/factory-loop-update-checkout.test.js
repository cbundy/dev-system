"use strict";

// The factory loop's update of the main checkout (plugins/factory-loop/hooks/act-merge.ts
// CHECKOUT_SCRIPT, rule H5, #555), run for real by sh from a scratch main checkout whose origin is
// a local bare repo. Merges land on origin's main from elsewhere, so the checkout agents begin in
// falls behind; the script must fast-forward it to origin's main, and refuse a dirty one, one on
// another branch or detached, or one with commits origin lacks, leaving each as it was.
// parseUpdateCheckout (the same module) must read its real output. Plugin tests cannot run a
// shell, so this lives here, beside tests/factory-loop-fast-forward.test.js.
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-checkout-")));
});

after(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

// world: a bare origin; the main checkout, cloned at the first commit; then two merges pushed to
// origin's main from another clone, as callum-flow-merge lands them.
let worlds = 0;
function world() {
  const dir = path.join(root, `w${++worlds}`);
  fs.mkdirSync(dir);
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const merger = path.join(dir, "merger");
  git(dir, "clone", "-q", origin, merger);
  const stale = commit(merger, "a.txt", "one\n");
  git(merger, "push", "-q", "origin", "HEAD:main");
  const main = path.join(dir, "main");
  git(dir, "clone", "-q", origin, main);
  commit(merger, "a.txt", "one, merged\n");
  const head = commit(merger, "b.txt", "another merge\n");
  git(merger, "push", "-q", "origin", "HEAD:main");
  return { dir, main, merger, stale, head };
}

// hooked: a post-merge hook in the repo's own hooks dir (as husky sets core.hooksPath for its npm
// install), which leaves a marker when it runs.
function hooked(cwd, dir) {
  const hooks = path.join(dir, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const marker = path.join(dir, "post-merge-ran");
  fs.writeFileSync(path.join(hooks, "post-merge"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(cwd, "config", "core.hooksPath", hooks);
  return marker;
}

function update(cwd, branch = "main") {
  const [cmd, ...args] = m.updateCheckoutArgv(branch);
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, read: m.parseUpdateCheckout(r.stdout) };
}

test("a main checkout behind origin is fast-forwarded to origin's main, with both commits said", () => {
  const w = world();
  fs.writeFileSync(path.join(w.main, "notes.md"), "untracked, kept\n");
  const r = update(w.main);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "updated", line: `UPDATED ${w.stale} ${w.head}` });
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.head);
  assert.equal(git(w.main, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(fs.readFileSync(path.join(w.main, "b.txt"), "utf8"), "another merge\n");
  assert.equal(fs.readFileSync(path.join(w.main, "notes.md"), "utf8"), "untracked, kept\n");
  // once there, nothing to do
  assert.deepEqual(update(w.main).read, { result: "current", line: `CURRENT ${w.head}` });
});

test("a main checkout with uncommitted changes is refused and left as it was", () => {
  const w = world();
  fs.writeFileSync(path.join(w.main, "a.txt"), "half done\n");
  const r = update(w.main);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: "REFUSED the main checkout has uncommitted changes" });
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.stale);
  assert.equal(fs.readFileSync(path.join(w.main, "a.txt"), "utf8"), "half done\n");
});

test("a main checkout on another branch, or detached, is refused and left as it was", () => {
  const w = world();
  git(w.main, "switch", "-q", "-c", "issue-4-elsewhere");
  const other = update(w.main);
  assert.equal(other.exitCode, 0, other.stderr);
  assert.deepEqual(other.read, { result: "refused", line: "REFUSED the main checkout is on issue-4-elsewhere, not main" });
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.stale);
  assert.equal(git(w.main, "symbolic-ref", "--short", "HEAD"), "issue-4-elsewhere");
  git(w.main, "switch", "-q", "--detach");
  const detached = update(w.main);
  assert.deepEqual(detached.read, { result: "refused", line: "REFUSED the main checkout is detached" });
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.stale);
});

test("a main checkout with a commit origin does not have is refused and left as it was", () => {
  const w = world();
  const own = commit(w.main, "c.txt", "made by hand in the main checkout\n");
  const r = update(w.main);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: `REFUSED the main checkout at ${own} has commits not on origin/main` });
  assert.equal(git(w.main, "rev-parse", "HEAD"), own);
});

test("an update that cannot go through (an untracked file in its way) fails, and moves nothing", () => {
  const w = world();
  fs.writeFileSync(path.join(w.main, "b.txt"), "in the way\n");
  const r = update(w.main);
  assert.equal(r.exitCode, 1);
  assert.equal(r.read, null);
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.stale);
  assert.equal(fs.readFileSync(path.join(w.main, "b.txt"), "utf8"), "in the way\n");
});

test("an origin that cannot be fetched is a failure, and moves nothing", () => {
  const w = world();
  git(w.main, "remote", "set-url", "origin", path.join(root, "no-such-origin.git"));
  const r = update(w.main);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /factory-loop: cannot fetch origin\/main/);
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.stale);
});

test("the update runs none of the repo's git hooks: a post-merge npm install could outlast its timeout", () => {
  const w = world();
  const marker = hooked(w.main, w.dir);
  const r = update(w.main);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "updated", line: `UPDATED ${w.stale} ${w.head}` });
  assert.equal(fs.existsSync(marker), false);
  // the hook is live: a plain fast-forward runs it
  commit(w.merger, "c.txt", "one more merge\n");
  git(w.merger, "push", "-q", "origin", "HEAD:main");
  git(w.main, "fetch", "-q", "origin");
  git(w.main, "merge", "--ff-only", "-q", "origin/main");
  assert.equal(fs.existsSync(marker), true);
});

test("run from a linked worktree on the default branch, the update refuses and moves nothing: only the main checkout follows origin", () => {
  const w = world();
  git(w.main, "switch", "-q", "--detach");
  const linked = path.join(w.dir, "slot 1");
  git(w.main, "worktree", "add", "-q", linked, "main");
  const r = update(linked);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.read, { result: "refused", line: `REFUSED ${linked} is a linked worktree, not the main checkout` });
  assert.equal(git(linked, "rev-parse", "HEAD"), w.stale);
  assert.equal(git(w.main, "rev-parse", "HEAD"), w.stale);
});
