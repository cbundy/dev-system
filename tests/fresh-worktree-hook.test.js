// Tests for the callum-flow fresh-worktree hook (dev-system#392): a SessionStart(startup)
// hook that fast-forwards a just-created Claude Code worktree to the remote tip of the
// default branch. Real temp git repos: a bare origin and a clone whose origin/main is stale.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const HOOK = process.env.HOOK_SCRIPT ||
  path.join(__dirname, "..", "plugins", "callum-flow", "hooks", "fresh-worktree.sh");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Bare origin with c1 and c2; clone whose origin/main sits at c1 (fresh FETCH_HEAD);
// a worktree made the way Claude Code does it.
function fixture({ originHead = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-worktree-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const clone = path.join(dir, "clone");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "a"), "1");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "c1");
  git(seed, "push", "-q", "origin", "main");
  const c1 = git(seed, "rev-parse", "HEAD");
  git(dir, "clone", "-q", origin, clone);
  if (!originHead) git(clone, "remote", "set-head", "origin", "-d");
  fs.writeFileSync(path.join(seed, "b"), "2");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "c2");
  git(seed, "push", "-q", "origin", "main");
  const c2 = git(seed, "rev-parse", "HEAD");
  // A branch-specific fetch makes FETCH_HEAD fresh without moving origin/main.
  git(seed, "push", "-q", "origin", "main:other");
  git(clone, "fetch", "-q", "origin", "other:refs/remotes/origin/other");
  assert.equal(git(clone, "rev-parse", "origin/main"), c1);
  const wt = path.join(clone, ".claude", "worktrees", "x");
  git(clone, "worktree", "add", "-q", "-b", "worktree-x", wt, "origin/main");
  return { dir, origin, clone, wt, c1, c2 };
}

function run(cwd, input) {
  const r = spawnSync(HOOK, [], {
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd, ...input }),
    encoding: "utf-8", env: GIT_ENV,
  });
  assert.equal(r.status, 0, `hook must always exit 0; stderr: ${r.stderr}`);
  return r;
}

function assertNoop(fx, cwd, r, expectHead) {
  assert.equal(r.stdout, "");
  assert.equal(git(cwd, "rev-parse", "HEAD"), expectHead);
  assert.equal(git(fx.clone, "rev-parse", "main"), fx.c1, "local main untouched");
}

test("stale local origin/main: worktree is fast-forwarded to the remote tip", () => {
  const fx = fixture();
  const r = run(fx.wt);
  assert.equal(git(fx.wt, "rev-parse", "HEAD"), fx.c2);
  assert.match(r.stdout, /fast-forwarded/);
  assert.equal(git(fx.clone, "rev-parse", "main"), fx.c1, "main checkout branch untouched");
  assert.equal(git(fx.wt, "symbolic-ref", "--short", "HEAD"), "worktree-x");
});

test("fetch failure: stays at the cached commit, exit 0, stderr names the fallback", () => {
  const fx = fixture();
  git(fx.clone, "remote", "set-url", "origin", path.join(fx.dir, "missing.git"));
  const r = run(fx.wt);
  assertNoop(fx, fx.wt, r, fx.c1);
  assert.match(r.stderr, /could not fetch/);
});

test("no-op cases leave HEAD and tree unchanged", () => {
  const cases = {
    "source resume": (fx) => [fx.wt, { source: "resume" }, fx.c1],
    "dirty tree": (fx) => { fs.writeFileSync(path.join(fx.wt, "a"), "dirty"); return [fx.wt, {}, fx.c1]; },
    "untracked file": (fx) => { fs.writeFileSync(path.join(fx.wt, "new"), "x"); return [fx.wt, {}, fx.c1]; },
    "own commit": (fx) => {
      fs.writeFileSync(path.join(fx.wt, "mine"), "x");
      git(fx.wt, "add", "."); git(fx.wt, "commit", "-q", "-m", "mine");
      return [fx.wt, {}, git(fx.wt, "rev-parse", "HEAD")];
    },
    "HEAD differs from cached origin/main (baseRef head)": (fx) => {
      git(fx.wt, "reset", "-q", "--hard", "HEAD");
      git(fx.clone, "update-ref", "refs/remotes/origin/main", fx.c2);
      return [fx.wt, {}, fx.c1];
    },
    "main checkout": (fx) => [fx.clone, {}, fx.c1],
    "branch not worktree-<name>": (fx) => { git(fx.wt, "checkout", "-q", "-b", "other-branch"); return [fx.wt, {}, fx.c1]; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const fx = fixture();
    const [cwd, input, head] = setup(fx);
    const r = run(cwd, input);
    assert.equal(r.stdout, "", name);
    assert.equal(git(cwd, "rev-parse", "HEAD"), head, name);
  }
});

test("worktree outside .claude/worktrees is left alone", () => {
  const fx = fixture();
  const other = path.join(fx.dir, "elsewhere");
  git(fx.clone, "worktree", "add", "-q", "-b", "worktree-elsewhere", other, "origin/main");
  const r = run(other);
  assertNoop(fx, other, r, fx.c1);
});

test("no origin/HEAD: does nothing", () => {
  const fx = fixture({ originHead: false });
  const r = run(fx.wt);
  assertNoop(fx, fx.wt, r, fx.c1);
});
