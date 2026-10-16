"use strict";

// The factory loop v2's slot tool, plugins/factory-loop/bin/factory-slot (docs/factory-loop/v2/SPEC.md
// 10.1, 10.2, 10.8), over real git: an origin, a main checkout and pool slots that are real
// worktrees of it, with a fake treehouse that keeps the pool's leases in a file and records each
// call. A lease is kept across retries; prepare saves a slot's uncommitted work, and the commits on
// its branch that origin does not have, as a patch that applies onto the retry's start, resets the
// slot onto origin's branch even while another worktree has that branch checked out, starts a new
// branch from origin's default with no upstream, and writes the step marker into the slot's git dir;
// kill ends the slot's processes; free saves (and names the file), resets and returns the slot on its
// lease only. Every op refuses a slot the loop did not lease, and stays inside the budget it is given.
// Plugin tests cannot run a command, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOOL = path.join(__dirname, "..", "plugins", "factory-loop", "bin", "factory-slot");
const LIFE = "t2k1x0";
const DAY = 86_400_000;

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-slot-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// The fake treehouse: the pool in pool.json, each call appended to calls.jsonl.
const FAKE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dir = process.env.FAKE_DIR;
const file = path.join(dir, "pool.json");
const pool = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const save = () => fs.writeFileSync(file, JSON.stringify(pool));
if (process.env.FAKE_HANG === args[0]) {
  // a get that still fetches: it would lease once it ends, which it never does
  setInterval(() => {}, 1000);
} else if (args[0] === "status") {
  process.stdout.write(JSON.stringify(pool));
} else if (args[0] === "get") {
  const w = pool.find((s) => s.status === "available");
  if (!w) {
    process.stderr.write("the pool is full\\n");
    process.exit(1);
  }
  Object.assign(w, { status: "leased", lease_id: "lease-" + pool.indexOf(w) + "-" + Date.now(), lease_holder: opt("--lease-holder"), leased_at: new Date().toISOString() });
  save();
  process.stdout.write(JSON.stringify({ path: w.path, lease_id: w.lease_id, lease_holder: w.lease_holder, leased_at: w.leased_at, base_branch: opt("--base") }));
} else if (args[0] === "return") {
  const w = pool.find((s) => s.path === args[1]);
  if (!w || w.lease_id !== opt("--if-lease-id")) {
    process.stderr.write("lease precondition failed\\n");
    process.exit(1);
  }
  const dirty = spawnSync("git", ["-C", w.path, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim() !== "";
  if (dirty && !args.includes("--force")) {
    process.stderr.write("worktree not returned: it has uncommitted changes\\n");
    process.exit(3);
  }
  Object.assign(w, { status: "available", lease_id: "", lease_holder: "", leased_at: null });
  save();
} else {
  process.exit(2);
}
`;

// world: an origin with main and issue-5 (one commit ahead), a main checkout, three slots as
// worktrees of it (2 has issue-5 checked out, as a stale slot would), and a fake treehouse over them.
function world() {
  const dir = fs.mkdtempSync(path.join(tmp, "world-"));
  const origin = path.join(dir, "origin.git");
  const checkout = path.join(dir, "checkout");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, checkout]);
  fs.writeFileSync(path.join(checkout, "a.txt"), "one\n");
  fs.writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "first");
  git(checkout, "push", "-q", "origin", "HEAD:main");
  git(checkout, "switch", "-q", "-c", "issue-5");
  fs.writeFileSync(path.join(checkout, "b.txt"), "the builder's work\n");
  git(checkout, "add", "b.txt");
  git(checkout, "commit", "-q", "-m", "work on 5");
  git(checkout, "push", "-q", "origin", "issue-5");
  git(checkout, "switch", "-q", "main");
  git(checkout, "branch", "-q", "-D", "issue-5");
  git(checkout, "remote", "set-head", "origin", "main");
  git(checkout, "fetch", "-q", "origin");
  const slots = [1, 2, 3].map((n) => {
    const p = path.join(dir, "pool", String(n), "repo");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    git(checkout, "worktree", "add", "-q", "--detach", p, "origin/main");
    return p;
  });
  git(slots[1], "switch", "-q", "-c", "issue-5", "origin/issue-5");
  fs.writeFileSync(path.join(slots[1], "stale.txt"), "a stale slot's own file\n");
  const pool = slots.map((p, i) => ({ name: String(i + 1), path: p, status: "available", branch: "", lease_id: "", lease_holder: "", leased_at: null, processes: [] }));
  fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify(pool));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const bin = path.join(dir, "treehouse");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "fake.js")}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const loopDir = path.join(dir, "loop");
  const env = { ...process.env, FAKE_DIR: dir, CALLUM_FLOW_TREEHOUSE_BIN: bin, FACTORY_SLOT_KILL_GRACE_MS: "300" };
  return {
    dir,
    origin,
    checkout,
    slots,
    loopDir,
    run: (...args) => spawnSync(TOOL, args, { cwd: checkout, encoding: "utf8", env, timeout: 60_000 }),
    runWith: (extra, ...args) => spawnSync(TOOL, args, { cwd: checkout, encoding: "utf8", env: { ...env, ...extra }, timeout: 60_000 }),
    pool: () => JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8")),
    setPool: (fn) => fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify(fn(JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8"))))),
    calls: () => (fs.existsSync(path.join(dir, "calls.jsonl")) ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args) : []),
  };
}

const field = (out, word, name) => (new RegExp(`^${word} .*?${name}=(\\S+)`, "m").exec(out) || [])[1];

function leased(w, issue = 5) {
  const r = w.run("lease", String(issue), LIFE);
  assert.equal(r.status, 0, r.stderr);
  return { path: field(r.stdout, "LEASED", "path"), lease: field(r.stdout, "LEASED", "lease") };
}

function marker(w, over = {}) {
  return JSON.stringify({ v: 1, repo: "acme/widgets", issue: 5, life: LIFE, seq: 4, step: "build", role: "writer", branch: "issue-5", gateCommands: ["npm test"], gateTimeoutMs: 600_000, loopDir: w.loopDir, ...over });
}

// sleeper: a process whose working directory is the slot; with `stubborn` it ignores SIGTERM.
function sleeper(cwd, stubborn = false) {
  const code = stubborn ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", code], { cwd, stdio: "ignore", detached: true });
  child.unref();
  return child;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = () => new Promise((r) => setTimeout(r, 300));

test("lease: one slot leased for the life's holder from origin's default branch; a retry keeps it and leases no second slot", () => {
  const w = world();
  const first = leased(w);
  assert.equal(first.path, w.slots[0]);
  assert.match(first.lease, /^lease-0-/);
  assert.deepEqual(w.pool()[0], { ...w.pool()[0], status: "leased", lease_holder: `factory-loop:5:${LIFE}` });
  assert.deepEqual(leased(w), first);
  const gets = w.calls().filter((a) => a[0] === "get");
  assert.deepEqual(gets, [["get", "--lease", "--lease-holder", `factory-loop:5:${LIFE}`, "--base", "main", "--json"]]);
  // another issue gets its own
  assert.equal(leased(w, 6).path, w.slots[1]);
  // usage
  assert.equal(w.run("lease", "five", LIFE).status, 2);
  assert.equal(w.run("lease", "5").status, 2);
});

test("prepare: leftovers saved as a patch that applies back, the slot reset onto origin's branch though a stale slot has it checked out, and the marker in its git dir", async () => {
  const w = world();
  const s = leased(w);
  // an earlier attempt's uncommitted work, a process left behind, and an ignored file that stays
  fs.writeFileSync(path.join(s.path, "a.txt"), "one, edited\n");
  fs.writeFileSync(path.join(s.path, "new.txt"), "untracked work\n");
  fs.mkdirSync(path.join(s.path, "node_modules"));
  fs.writeFileSync(path.join(s.path, "node_modules", "dep.js"), "x\n");
  const left = sleeper(s.path);
  await settle();
  const staleHead = git(w.slots[1], "rev-parse", "HEAD");
  const r = w.run("prepare", s.path, s.lease, "issue-5", marker(w));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(field(r.stdout, "PREPARED", "head"), git(w.origin, "rev-parse", "refs/heads/issue-5"));
  assert.match(r.stdout, /^KILLED 1$/m, "the process it ended is counted");
  assert.equal(git(s.path, "symbolic-ref", "--short", "HEAD"), "issue-5");
  assert.equal(git(s.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/issue-5");
  assert.equal(git(s.path, "status", "--porcelain"), "", "the tree is clean: the marker is not in it");
  assert.ok(fs.existsSync(path.join(s.path, "node_modules", "dep.js")), "ignored files stay");
  await settle();
  assert.ok(!alive(left.pid), "the left-behind process was ended");
  // the marker, in the slot's own git dir, with every field the loop gave
  const gitDir = git(s.path, "rev-parse", "--absolute-git-dir");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gitDir, "factory-step.json"), "utf8")), JSON.parse(marker(w)));
  // the stale slot keeps its files and its HEAD
  assert.equal(git(w.slots[1], "rev-parse", "HEAD"), staleHead);
  assert.ok(fs.existsSync(path.join(w.slots[1], "stale.txt")));
  // the leftovers: named for the issue, life and seq, and they apply back onto the head they were on;
  // the first line names what they were taken against
  const file = field(r.stdout, "LEFTOVERS", "file");
  assert.equal(path.dirname(file), path.join(w.loopDir, "leftovers"));
  assert.match(path.basename(file), new RegExp(`^5-${LIFE}-s4-\\d+\\.patch$`));
  assert.match(fs.readFileSync(file, "utf8").split("\n")[0], /^factory-slot leftovers: against [0-9a-f]{40} \(HEAD\), from HEAD [0-9a-f]{40}\. Apply with: git apply --3way/);
  const scratch = path.join(w.dir, "apply");
  git(w.checkout, "worktree", "add", "-q", "--detach", scratch, "origin/main");
  git(scratch, "apply", file);
  assert.equal(fs.readFileSync(path.join(scratch, "a.txt"), "utf8"), "one, edited\n");
  assert.equal(fs.readFileSync(path.join(scratch, "new.txt"), "utf8"), "untracked work\n");
  // a clean slot prepared again saves nothing
  const again = w.run("prepare", s.path, s.lease, "issue-5", marker(w, { seq: 5 }));
  assert.equal(again.status, 0, again.stderr);
  assert.equal(field(again.stdout, "LEFTOVERS", "file"), undefined);
  assert.match(again.stdout, /^KILLED 0$/m);
  assert.equal(fs.readdirSync(path.join(w.loopDir, "leftovers")).length, 1);
});

test("prepare: a branch origin does not have starts from origin's default with no upstream; pushed work survives a retry, and work committed but never pushed is in its leftovers", () => {
  const w = world();
  const s = leased(w, 7);
  const mk = (over) => marker(w, { issue: 7, branch: "issue-7", ...over });
  const r = w.run("prepare", s.path, s.lease, "issue-7", mk({}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(field(r.stdout, "PREPARED", "head"), git(w.origin, "rev-parse", "refs/heads/main"));
  assert.equal(git(s.path, "symbolic-ref", "--short", "HEAD"), "issue-7");
  assert.equal(spawnSync("git", ["-C", s.path, "rev-parse", "--abbrev-ref", "@{upstream}"]).status, 128, "no upstream: a bare push cannot reach main");
  // the builder commits and pushes, then commits once more without pushing
  fs.writeFileSync(path.join(s.path, "c.txt"), "pushed\n");
  git(s.path, "add", "c.txt");
  git(s.path, "commit", "-q", "-m", "pushed");
  git(s.path, "push", "-q", "origin", "issue-7");
  const pushed = git(s.path, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(s.path, "d.txt"), "not pushed\n");
  git(s.path, "add", "d.txt");
  git(s.path, "commit", "-q", "-m", "local only");
  fs.writeFileSync(path.join(s.path, "e.txt"), "not even committed\n");
  const local = git(s.path, "rev-parse", "HEAD");
  const retry = w.run("prepare", s.path, s.lease, "issue-7", mk({ seq: 6 }));
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(field(retry.stdout, "PREPARED", "head"), pushed, "the retry starts from origin's head");
  assert.ok(!fs.existsSync(path.join(s.path, "d.txt")), "the reset moved the branch past the local commit");
  // the leftovers hold the local commit and the uncommitted file, taken against origin's head, so they
  // apply onto the retry's start
  const file = field(retry.stdout, "LEFTOVERS", "file");
  assert.ok(file, "the unpushed commit is saved");
  assert.equal(fs.readFileSync(file, "utf8").split("\n")[0], `factory-slot leftovers: against ${pushed}, from HEAD ${local}, with its 1 commit(s) not on origin. Apply with: git apply --3way <this file>`);
  git(s.path, "apply", "--check", file);
  git(s.path, "apply", file);
  assert.equal(fs.readFileSync(path.join(s.path, "d.txt"), "utf8"), "not pushed\n");
  assert.equal(fs.readFileSync(path.join(s.path, "e.txt"), "utf8"), "not even committed\n");
});

test("prepare: commits on a branch origin never had are saved against the merge base with origin's default, and apply onto the new start; a fresh slot's base is never in them", () => {
  const w = world();
  const s = leased(w, 9);
  const mk = (over) => marker(w, { issue: 9, branch: "issue-9", ...over });
  assert.equal(field(w.run("prepare", s.path, s.lease, "issue-9", mk({})).stdout, "LEFTOVERS", "file"), undefined, "a fresh slot leaves nothing");
  fs.writeFileSync(path.join(s.path, "f.txt"), "first\n");
  git(s.path, "add", "f.txt");
  git(s.path, "commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(s.path, "g.txt"), "second\n");
  git(s.path, "add", "g.txt");
  git(s.path, "commit", "-q", "-m", "two");
  // main moves on at origin meanwhile: its change is not the slot's work
  const other = path.join(w.dir, "other");
  spawnSync("git", ["clone", "-q", w.origin, other]);
  fs.writeFileSync(path.join(other, "main.txt"), "main moved\n");
  git(other, "add", "main.txt");
  git(other, "commit", "-q", "-m", "main moves");
  git(other, "push", "-q", "origin", "HEAD:main");
  const r = w.run("prepare", s.path, s.lease, "issue-9", mk({ seq: 2 }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(field(r.stdout, "PREPARED", "head"), git(w.origin, "rev-parse", "refs/heads/main"));
  const file = field(r.stdout, "LEFTOVERS", "file");
  assert.match(fs.readFileSync(file, "utf8"), /with its 2 commit\(s\) not on origin/);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /main\.txt/, "main's own change is not in them");
  git(s.path, "apply", file);
  assert.deepEqual(["f.txt", "g.txt", "main.txt"].map((f) => fs.existsSync(path.join(s.path, f))), [true, true, true]);
});

test("prepare refuses a slot that is not the record's: another lease, another issue's holder, a person's lease, a path outside the pool; a bad marker is a usage error; nothing is touched", () => {
  const w = world();
  const s = leased(w);
  fs.writeFileSync(path.join(s.path, "work.txt"), "keep me\n");
  const cases = [
    ["prepare", s.path, "lease-other", "issue-5", marker(w)],
    ["prepare", s.path, s.lease, "issue-5", marker(w, { issue: 6 })],
    ["prepare", path.join(w.dir, "elsewhere"), s.lease, "issue-5", marker(w)],
  ];
  for (const args of cases) {
    const r = w.run(...args);
    assert.equal(r.status, 3, `${args.join(" ")}: ${r.stderr}`);
  }
  w.setPool((p) => p.map((x) => (x.path === s.path ? { ...x, lease_holder: "callum" } : x)));
  assert.equal(w.run("prepare", s.path, s.lease, "issue-5", marker(w)).status, 3);
  w.setPool((p) => p.map((x) => (x.path === s.path ? { ...x, lease_holder: `factory-loop:5:${LIFE}` } : x)));
  for (const bad of ["{", marker(w, { branch: "issue-9" }), marker(w, { loopDir: "relative/dir" }), marker(w, { role: "admin" })]) {
    assert.equal(w.run("prepare", s.path, s.lease, "issue-5", bad).status, 2, bad);
  }
  assert.equal(w.run("prepare", s.path, s.lease, "not a branch..", marker(w, { branch: "not a branch.." })).status, 2);
  assert.equal(fs.readFileSync(path.join(s.path, "work.txt"), "utf8"), "keep me\n");
  assert.ok(!fs.existsSync(path.join(w.loopDir, "leftovers")));
});

test("kill: every process in the slot ends, a stubborn one by SIGKILL after the grace; the tool refuses a path outside the pool or a slot the loop did not lease", async () => {
  const w = world();
  const s = leased(w);
  fs.mkdirSync(path.join(s.path, "sub"));
  const procs = [sleeper(s.path), sleeper(path.join(s.path, "sub")), sleeper(s.path, true)];
  const outside = sleeper(w.slots[2]);
  await settle();
  const r = w.run("kill", s.path);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "KILLED 3");
  await settle();
  for (const p of procs) assert.ok(!alive(p.pid), `pid ${p.pid} survived`);
  assert.ok(alive(outside.pid), "a process in another slot is left alone");
  assert.equal(w.run("kill", w.slots[2]).status, 3, "a slot nobody leased");
  assert.equal(w.run("kill", w.dir).status, 3, "a path outside the pool");
  assert.ok(alive(outside.pid));
  process.kill(outside.pid, "SIGKILL");
  assert.equal(w.run("kill", s.path).stdout.trim(), "KILLED 0");
});

test("free: the slot's work saved, the slot reset and returned on its lease only; again, or on another lease, it is gone and nothing is touched; old leftovers are pruned", async () => {
  const w = world();
  const s = leased(w);
  const old = path.join(w.loopDir, "leftovers", "1-old-s1-1.patch");
  const recent = path.join(w.loopDir, "leftovers", "2-new-s1-1.patch");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  for (const f of [old, recent]) fs.writeFileSync(f, "x\n");
  fs.utimesSync(old, (Date.now() - 8 * DAY) / 1000, (Date.now() - 8 * DAY) / 1000);
  fs.writeFileSync(path.join(s.path, "a.txt"), "changed\n");
  const left = sleeper(s.path);
  await settle();
  const r = w.run("free", s.path, s.lease, w.loopDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(field(r.stdout, "FREED", "path"), s.path);
  assert.match(r.stdout, /^KILLED 1$/m, "the process it ended is counted");
  await settle();
  assert.ok(!alive(left.pid));
  assert.equal(w.pool()[0].status, "available");
  assert.deepEqual(w.calls().filter((a) => a[0] === "return"), [["return", s.path, "--if-lease-id", s.lease, "--force"]]);
  assert.equal(git(s.path, "status", "--porcelain"), "");
  const saved = fs.readdirSync(path.join(w.loopDir, "leftovers")).filter((f) => f.startsWith(`5-${LIFE}-free-`));
  assert.equal(saved.length, 1);
  assert.equal(field(r.stdout, "LEFTOVERS", "file"), path.join(w.loopDir, "leftovers", saved[0]), "the free names the file it saved");
  assert.ok(!fs.existsSync(old), "a patch older than 7 days is pruned");
  assert.ok(fs.existsSync(recent));
  // a second free finds the lease gone and touches nothing
  const again = w.run("free", s.path, s.lease, w.loopDir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), `GONE path=${s.path}`);
  // the slot leased again by someone else: the old lease's free leaves it alone
  const next = leased(w, 8);
  assert.equal(next.path, s.path);
  fs.writeFileSync(path.join(s.path, "theirs.txt"), "the new holder's\n");
  assert.equal(w.run("free", s.path, s.lease, w.loopDir).stdout.trim(), `GONE path=${s.path}`);
  assert.ok(fs.existsSync(path.join(s.path, "theirs.txt")));
  assert.equal(w.calls().filter((a) => a[0] === "return").length, 1);
  // a person's lease is refused
  w.setPool((p) => p.map((x) => (x.path === s.path ? { ...x, lease_holder: "callum" } : x)));
  assert.equal(w.run("free", s.path, next.lease, w.loopDir).status, 3);
  assert.equal(w.run("free", s.path, next.lease, "relative").status, 2);
});

test("free: a commit on the slot's branch that was never pushed is saved against origin's branch, and the file is named", () => {
  const w = world();
  const s = leased(w);
  assert.equal(w.run("prepare", s.path, s.lease, "issue-5", marker(w)).status, 0);
  const start = git(s.path, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(s.path, "h.txt"), "parked work\n");
  git(s.path, "add", "h.txt");
  git(s.path, "commit", "-q", "-m", "parked");
  const r = w.run("free", s.path, s.lease, w.loopDir);
  assert.equal(r.status, 0, r.stderr);
  const file = field(r.stdout, "LEFTOVERS", "file");
  assert.match(path.basename(file), new RegExp(`^5-${LIFE}-free-\\d+\\.patch$`));
  assert.match(fs.readFileSync(file, "utf8").split("\n")[0], new RegExp(`^factory-slot leftovers: against ${start}, from HEAD [0-9a-f]{40}, with its 1 commit`));
  assert.equal(spawnSync("git", ["-C", s.path, "symbolic-ref", "-q", "HEAD"]).status, 1, "it goes back detached");
  assert.equal(git(s.path, "rev-parse", "HEAD"), start, "at the branch's start");
  // a clean slot with nothing unpushed frees with no file
  const t = leased(w, 6);
  assert.equal(w.run("free", t.path, t.lease, w.loopDir).stdout.trim(), `FREED path=${t.path}\nKILLED 0`);
});

test("--budget-ms bounds the whole op: a treehouse get that hangs is ended inside it, and the op fails, worth a retry", () => {
  const w = world();
  const began = Date.now();
  const r = w.runWith({ FAKE_HANG: "get" }, "--budget-ms", "1500", "lease", "5", LIFE);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(Date.now() - began < 15_000, "it ended inside the budget, not at the per-command timeout");
  assert.match(r.stderr, /treehouse get/);
  assert.deepEqual(w.pool().map((x) => x.status), ["available", "available", "available"], "no lease was taken");
  for (const bad of [["--budget-ms"], ["--budget-ms", "0", "kill", w.slots[0]], ["--budget-ms", "soon", "kill", w.slots[0]]]) assert.equal(w.run(...bad).status, 2, bad.join(" "));
  const ok = leased(w);
  assert.equal(w.run("--budget-ms", "60000", "kill", ok.path).stdout.trim(), "KILLED 0");
});

test("a failed pool read fails the op, worth a retry; an unknown op is a usage error", () => {
  const w = world();
  fs.writeFileSync(path.join(w.dir, "pool.json"), "not json");
  const r = w.run("kill", w.slots[0]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^factory-slot: /);
  assert.equal(w.run("wipe", w.slots[0]).status, 2);
  assert.equal(w.run().status, 2);
});
