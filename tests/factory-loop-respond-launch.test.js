"use strict";

// The factory loop's respond launch (plugins/factory-loop/hooks/act-merge.ts LAUNCH_SCRIPT), run
// for real by sh in a scratch git worktree with a stub no-mistakes on PATH (docs/factory-loop/
// SPEC.md 6.1, I-94). no-mistakes picks the run from the working directory's branch, so the
// respond must run in the slot, on the run's branch, and the launch must read back what the
// detached respond said; respondProblem (the same module) must read that real output. Plugin
// tests cannot run a shell, so this lives here.
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
const BRANCH = "issue-470-loop";

let m;
let dir;
let slot;
let other;
let bin;

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

before(async () => {
  m = await import(ACT_MERGE);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-respond-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  slot = fs.realpathSync(dir) + "/slot";
  other = fs.realpathSync(dir) + "/other";
  git(repo, "worktree", "add", "-q", "-b", BRANCH, slot);
  git(repo, "worktree", "add", "-q", "-b", "issue-471-other", other);
  // the stub: records where it ran and with what, says what STUB_SAYS holds, exits STUB_EXIT
  bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "no-mistakes"),
    '#!/bin/sh\npwd > "$STUB_MARK"\nfor a in "$@"; do printf "%s\\n" "$a"; done >> "$STUB_MARK"\nprintf "%s\\n" "$STUB_SAYS"\nexit "$STUB_EXIT"\n',
    { mode: 0o755 },
  );
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

// launch: the argv act-merge.ts runs, through sh, with the stub first on PATH and a 1 s settle.
function launch(where, branch, says, exit, respond = ["no-mistakes", "axi", "respond", "--action", "approve", "--step=review"]) {
  const log = path.join(dir, "logs", `${path.basename(where)}-${says.length}-${exit}.log`);
  const mark = path.join(dir, `mark-${path.basename(where)}-${exit}`);
  fs.rmSync(mark, { force: true });
  const [cmd, ...args] = m.launchArgv(where, branch, log, respond);
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FACTORY_LOOP_RESPOND_SETTLE_S: "1", STUB_MARK: mark, STUB_SAYS: says, STUB_EXIT: String(exit) },
  });
  const ran = fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").split("\n").filter((l) => l !== "") : null;
  return { result: { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }, log, ran };
}

test("in the slot on the run's branch the respond runs there, detached, with its argv whole, and the log ends with its exit", () => {
  const respond = ["no-mistakes", "axi", "respond", "--action", "fix", "--instructions=keep 'both' sides; $(not run) `nor this`"];
  const { result, log, ran } = launch(slot, BRANCH, "responded to review", 0, respond);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(ran, [slot, ...respond.slice(1)]);
  assert.equal(fs.readFileSync(log, "utf8"), "responded to review\nfactory-loop: respond exited 0\n");
  assert.equal(result.stdout, "responded to review\nfactory-loop: respond exited 0\n");
  assert.equal(m.respondProblem(result), null);
});

test("a slot on another branch is refused with exit 3, and respond never runs", () => {
  const { result, ran } = launch(other, BRANCH, "unused", 0);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, `factory-loop: the slot is on issue-471-other, not ${BRANCH}\n`);
  assert.equal(ran, null);
  assert.equal(m.respondProblem(result), `factory-loop: the slot is on issue-471-other, not ${BRANCH}`);
});

test("a slot that is not there is refused with exit 3", () => {
  const { result, ran } = launch(path.join(dir, "gone"), BRANCH, "unused", 0);
  assert.equal(result.exitCode, 3);
  assert.equal(ran, null);
  assert.notEqual(m.respondProblem(result), null);
});

test("respondProblem reads the real read-back: an immediate failure, and no active run", () => {
  const failed = launch(slot, BRANCH, "usage: unknown flag --nope", 2);
  assert.equal(failed.result.exitCode, 0);
  assert.equal(m.respondProblem(failed.result), "respond exited 2: usage: unknown flag --nope");
  const idle = launch(slot, BRANCH, "no active run to respond to", 0);
  assert.equal(m.respondProblem(idle.result), "no active run to respond to");
});
