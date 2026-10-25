"use strict";

// The merge train's executors (plugins/factory-loop/hooks/v2/act-train.ts, docs/factory-loop/v2/SPEC.md
// 9.8) run for real by git against a local bare origin and a main checkout: the build pushes a train
// commit whose tree is merge-tree(H', N) and whose parents are H' and N, changes no branch of N or the
// head and no working tree, and makes the same commit every time; the delete and the sweep remove only
// `factory-train/*` refs. Plugin tests cannot run a command, so this lives here (the shapes of the
// plans and the argv are in plugins/factory-loop/tests/v2-train.test.ts).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (tests/factory-loop-prune.test.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const HOOKS = path.join(__dirname, "..", "plugins", "factory-loop", "hooks");

let dir;
let origin;
let checkout;
let train;
let env;

// git over the scratch repos with no identity of the user's: HOME is the scratch folder, so the
// executor's own author and committer are what makes the commit.
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const originRefs = () => git(origin, "for-each-ref", "--format=%(refname) %(objectname)");
const refsOf = (cwd) => git(cwd, "for-each-ref", "--format=%(refname) %(objectname)");

// the ExecCtx the executor needs: ctx.cmd runs a command from the main checkout
const ctx = {
  cmd: async (argv, init) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: checkout, env: { ...env, ...(init.env ?? {}) }, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
};

let heads;
const build = (over = {}) => ({
  kind: "queue-train",
  op: "build",
  key: "i2/lx/queue/train/a-b-c/s5",
  class: "free",
  rule: "Q3",
  reason: "test",
  issue: 2,
  pr: 602,
  branch: "pr-2",
  rider: heads.n,
  headIssue: 1,
  headPr: 601,
  headBranch: "pr-1",
  head: heads.h,
  main: heads.main,
  maxAttempts: 1,
  ...over,
});

before(async () => {
  train = await import(path.join(HOOKS, "v2", "act-train.ts"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-train-"));
  env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  // a seed with trunk and three branches off it: the head (edits f1), the next PR (edits f2), a clash (edits f1)
  const seed = path.join(dir, "seed");
  git(dir, "init", "-q", "-b", "trunk", "seed");
  git(seed, "config", "user.email", "t@example.com");
  git(seed, "config", "user.name", "t");
  fs.writeFileSync(path.join(seed, "f1"), "a\nb\nc\n");
  fs.writeFileSync(path.join(seed, "f2"), "x\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  const edit = (file, line, name) => {
    git(seed, "switch", "-q", "--detach", "trunk");
    fs.appendFileSync(path.join(seed, file), line);
    git(seed, "commit", "-qam", name);
    git(seed, "update-ref", `refs/heads/${name}`, "HEAD");
  };
  edit("f1", "h\n", "pr-1");
  edit("f2", "n\n", "pr-2");
  edit("f1", "c\n", "pr-3");
  git(dir, "clone", "-q", "--bare", "seed", "origin.git");
  origin = path.join(dir, "origin.git");
  git(dir, "clone", "-q", origin, "main");
  checkout = path.join(dir, "main");
  heads = { main: git(origin, "rev-parse", "trunk"), h: git(origin, "rev-parse", "pr-1"), n: git(origin, "rev-parse", "pr-2"), clash: git(origin, "rev-parse", "pr-3") };
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

const run = (action) => train.executors["queue-train"](ctx, action);

test("build: pushes the train commit as factory-train/i<N>-<tree7>, its tree merge-tree(H', N) and its parents H' and N, and changes nothing else", async () => {
  const before = { origin: originRefs(), local: refsOf(checkout), head: git(checkout, "rev-parse", "HEAD"), files: git(checkout, "ls-files", "-s") };
  const out = await run(build());
  assert.equal(out.status, "done", JSON.stringify(out));
  const o = out.outcome;
  assert.equal(o.drop, null);
  assert.equal(o.branch, `factory-train/i2-${o.tree.slice(0, 7)}`);
  // what origin holds: the branch at the train commit, whose tree is the merge of the head and the next PR
  assert.equal(git(origin, "rev-parse", `refs/heads/${o.branch}`), o.train);
  assert.equal(git(origin, "rev-parse", `${o.train}^{tree}`), o.tree);
  assert.equal(git(origin, "merge-tree", "--write-tree", heads.h, heads.n), o.tree);
  assert.equal(git(origin, "rev-list", "--parents", "-n", "1", o.train), `${o.train} ${heads.h} ${heads.n}`);
  assert.equal(git(origin, "show", `${o.train}:f1`), "a\nb\nc\nh");
  assert.equal(git(origin, "show", `${o.train}:f2`), "x\nn");
  assert.equal(git(origin, "log", "-1", "--format=%an <%ae> %cn <%ce> %at %ct", o.train), "factory-loop <factory-loop@users.noreply.github.com> factory-loop <factory-loop@users.noreply.github.com> 0 0");
  assert.deepEqual({ headIssue: o.headIssue, head: o.head, rider: o.rider, main: o.main }, { headIssue: 1, head: heads.h, rider: heads.n, main: heads.main });
  // no branch of N or of the head moved, and only the train's ref was added on origin
  assert.equal(originRefs().split("\n").filter((l) => !l.includes("factory-train/")).join("\n"), before.origin);
  assert.equal(originRefs().split("\n").filter((l) => l.includes("factory-train/")).length, 1);
  // and nothing in the main checkout: its branches, HEAD, index and working tree are as they were (git
  // itself notes the pushed train in the remote-tracking ref of the push, which is no branch of anyone's)
  assert.equal(refsOf(checkout).split("\n").filter((l) => !l.includes("/factory-train/")).join("\n"), before.local);
  assert.equal(git(checkout, "for-each-ref", "refs/heads").split("\n").length, 1);
  assert.equal(git(checkout, "rev-parse", "HEAD"), before.head);
  assert.equal(git(checkout, "ls-files", "-s"), before.files);
  assert.equal(git(checkout, "status", "--porcelain"), "");
  assert.equal(git(checkout, "status", "--porcelain", "--untracked-files=all"), "");
});

test("build: the same inputs make the same commit, so a retried build pushes nothing new and is done again", async () => {
  const a = await run(build());
  const b = await run(build());
  assert.equal(b.status, "done", JSON.stringify(b));
  assert.equal(b.outcome.train, a.outcome.train);
  assert.equal(originRefs().split("\n").filter((l) => l.includes("factory-train/")).length, 1);
});

test("the train's tree is what the guard computes once the head has merged: merging the next PR onto a main that holds the head gives the tested tree", async () => {
  const out = await run(build());
  // the head merged by a fast-forward of trunk (a squash merge leaves the same tree)
  git(origin, "update-ref", "refs/heads/trunk", heads.h);
  try {
    assert.equal(git(origin, "merge-tree", "--write-tree", "trunk", heads.n), out.outcome.tree);
    assert.equal(git(origin, "rev-parse", "trunk^{tree}"), git(origin, "rev-parse", `${heads.h}^{tree}`));
  } finally {
    git(origin, "update-ref", "refs/heads/trunk", heads.main);
  }
});

test("build: a branch that moved or is gone is the drop head-moved; a conflict is the drop conflict; neither pushes a ref", async () => {
  const before = originRefs();
  const moved = await run(build({ rider: heads.clash }));
  assert.equal(moved.status, "done");
  assert.deepEqual({ train: moved.outcome.train, tree: moved.outcome.tree, drop: moved.outcome.drop }, { train: null, tree: null, drop: "head-moved" });
  const gone = await run(build({ branch: "no-such-branch" }));
  assert.equal(gone.outcome.drop, "head-moved");
  // the next PR clashes with the head: both edit f1
  const clash = await run(build({ branch: "pr-3", rider: heads.clash }));
  assert.equal(clash.status, "done", JSON.stringify(clash));
  assert.deepEqual({ train: clash.outcome.train, drop: clash.outcome.drop }, { train: null, drop: "conflict" });
  assert.equal(originRefs(), before);
});

test("delete: removes the one train branch, tolerates one already gone, and refuses any branch outside factory-train/", async () => {
  const built = await run(build({ branch: "pr-2" }));
  const branch = built.outcome.branch;
  const action = { kind: "queue-train", op: "delete", key: "k", class: "free", rule: "Q3", reason: "x", issue: 2, branch, end: "merged", maxAttempts: 3 };
  const out = await run(action);
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(originRefs().includes(branch), false);
  assert.equal((await run(action)).status, "done");
  for (const refused of ["trunk", "pr-1", "factory-train", "refs/heads/trunk"]) {
    const r = await run({ ...action, branch: refused });
    assert.equal(r.status, "failed");
    assert.equal(r.noRetry, true);
  }
  assert.equal(git(origin, "rev-parse", "trunk"), heads.main);
  assert.equal(git(origin, "rev-parse", "pr-1"), heads.h);
});

test("sweep: removes the factory-train/* branches no live train names and nothing else", async () => {
  for (const name of ["factory-train/i7-1111111", "factory-train/i8-2222222", "factory-train/i9-3333333"]) git(origin, "update-ref", `refs/heads/${name}`, heads.h);
  const action = { kind: "queue-train", op: "sweep", key: "train/sweep/1", class: "free", rule: "Q3", reason: "x", issue: null, keep: ["factory-train/i8-2222222"], maxAttempts: 1 };
  const out = await run(action);
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.deepEqual(out.outcome.removed.sort(), ["factory-train/i7-1111111", "factory-train/i9-3333333"]);
  const left = originRefs().split("\n").map((l) => l.split(" ")[0]);
  assert.deepEqual(left.filter((r) => r.startsWith("refs/heads/factory-train/")), ["refs/heads/factory-train/i8-2222222"]);
  for (const kept of ["refs/heads/trunk", "refs/heads/pr-1", "refs/heads/pr-2", "refs/heads/pr-3"]) assert.ok(left.includes(kept), kept);
  // the sweep with nothing to keep leaves none
  const all = await run({ ...action, keep: [] });
  assert.deepEqual(all.outcome.removed, ["factory-train/i8-2222222"]);
  assert.equal(originRefs().includes("factory-train/"), false);
});
