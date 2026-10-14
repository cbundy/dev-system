"use strict";

// The factory loop's fast-forward script (FF_SCRIPT in plugins/factory-loop/hooks/act-merge.ts,
// rule M2, #551, #595) run for real by node against temporary git repositories, with origin's
// branch rebased away from the run head. Plugin tests cannot run a command, so this lives here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The script is an array of string literals; evaluate that array rather than import the module,
// which needs the engine's loader.
const source = fs.readFileSync(path.join(__dirname, "..", "plugins", "factory-loop", "hooks", "act-merge.ts"), "utf8");
const body = /export const FF_SCRIPT = (\[[\s\S]*?\n\])\.join\('\\n'\)/.exec(source);
assert.ok(body, "FF_SCRIPT not found in act-merge.ts");
const FF_SCRIPT = new Function(`return ${body[1]}.join('\\n')`)();

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const ff = (cwd, branch, head, expect) => spawnSync("sh", ["-c", FF_SCRIPT, "ff", branch, head, expect], { cwd, encoding: "utf8" });

// main checkout on main; origin's b is the run head R1 rebased onto a newer main (R2); a pool
// worktree sits on b at W, an ancestor of R1.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff595-"));
  const origin = path.join(dir, "origin.git");
  const main = path.join(dir, "main");
  const slot = path.join(dir, "slot");
  const write = (cwd, file, text) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", file);
  };
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, main);
  write(main, "a", "1");
  git(main, "commit", "-qm", "base");
  git(main, "push", "-q", "origin", "main");
  git(main, "checkout", "-qb", "b");
  write(main, "f", "work");
  git(main, "commit", "-qm", "work");
  const w = git(main, "rev-parse", "HEAD");
  write(main, "g", "pipeline");
  git(main, "commit", "-qm", "pipeline");
  const r1 = git(main, "rev-parse", "HEAD");
  git(main, "checkout", "-q", "main");
  git(main, "worktree", "add", "-q", slot, w);
  git(slot, "checkout", "-qB", "b", w);
  write(main, "m", "newer");
  git(main, "commit", "-qm", "newer main");
  git(main, "push", "-q", "origin", "main");
  git(main, "checkout", "-q", "-b", "tmp", r1);
  git(main, "rebase", "-q", "main");
  const r2 = git(main, "rev-parse", "HEAD");
  git(main, "push", "-q", "origin", "tmp:refs/heads/b");
  git(main, "checkout", "-q", "main");
  return { dir, main, slot, w, r1, r2 };
}

test("a clean worktree behind the run head is forwarded to it, though origin holds the rebased head", () => {
  const f = fixture();
  try {
    assert.match(ff(f.main, "b", f.r1, f.r2).stdout, new RegExp(`FORWARDED ${f.w} ${f.r1} `));
    assert.equal(git(f.slot, "rev-parse", "HEAD"), f.r1);
    assert.match(ff(f.main, "b", f.r1, f.r2).stdout, /^CURRENT /);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a dirty worktree, a diverged one and an origin that is not the expected head are refused", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.slot, "f"), "edited");
    assert.match(ff(f.main, "b", f.r1, f.r2).stdout, /has uncommitted changes/);
    git(f.slot, "checkout", "-q", "--", "f");
    assert.match(ff(f.main, "b", f.r1, f.r1).stdout, /REFUSED origin\/b is/);
    fs.writeFileSync(path.join(f.slot, "own"), "x");
    git(f.slot, "add", "own");
    git(f.slot, "commit", "-qm", "own");
    assert.match(ff(f.main, "b", f.r1, f.r2).stdout, /is not an ancestor of the run head /);
    assert.equal(git(f.slot, "log", "-1", "--format=%s"), "own");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
