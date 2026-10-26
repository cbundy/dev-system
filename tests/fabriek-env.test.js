// The fabriek rename's alias window: every callum-flow-<x> command is a thin alias that runs
// fabriek-<x>, FABRIEK_<X> settings win over the old CALLUM_FLOW_<X> names, and the one list of
// settings (images/base/fabriek-env.sh) names every setting the commands read.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BASE = path.join(ROOT, "images", "base");
const COMMANDS = [
  "capture", "claim", "designer-route", "dual-write-check", "evaluate", "event", "evidence-upload", "factory-state",
  "implementer-route", "issue-read", "merge", "merge-guard", "milestone", "patch-id", "released", "rollout", "sweep",
  "test-weakening",
];
const { applyFabriekEnv } = require(path.join(BASE, "fabriek-env.js"));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fabriek-env-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

// A bare environment: no FABRIEK_* or CALLUM_FLOW_* of the machine running the tests leaks in.
function run(file, args, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: scratch, CALLUM_EVENTS_DIR: path.join(scratch, "events"), ...extra };
  const r = spawnSync(file, args, { encoding: "utf8", env, cwd: scratch, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("there is one alias per command, a few lines of sh that only run the fabriek command beside it", () => {
  assert.equal(COMMANDS.length, 18);
  for (const x of COMMANDS) {
    const alias = path.join(BASE, `callum-flow-${x}`);
    assert.ok(fs.existsSync(path.join(BASE, `fabriek-${x}`)), `fabriek-${x} exists`);
    const text = fs.readFileSync(alias, "utf8");
    assert.ok(fs.statSync(alias).mode & 0o100, `${x}: executable`);
    assert.equal(text.split("\n")[0], "#!/bin/sh");
    assert.ok(text.includes(`exec "$(dirname "$0")/fabriek-${x}" "$@"`), `${x}: execs its sibling`);
    assert.ok(text.split("\n").length <= 6, `${x}: holds no logic`);
  }
});

for (const x of COMMANDS) {
  test(`callum-flow-${x} --help gives the same exit code and output as fabriek-${x}`, () => {
    const a = run(path.join(BASE, `callum-flow-${x}`), ["--help"]);
    const n = run(path.join(BASE, `fabriek-${x}`), ["--help"]);
    assert.deepEqual(a, n);
    assert.match(a.stdout + a.stderr, new RegExp(`fabriek-${x}`), "the usage names the new command");
    assert.doesNotMatch(a.stdout + a.stderr, new RegExp(`callum-flow-${x}\\b`));
  });
}

test("fabriek-event reads CALLUM_FLOW_REPO when FABRIEK_REPO is unset, and FABRIEK_REPO wins when both are set", () => {
  const event = path.join(BASE, "fabriek-event");
  const dir = path.join(scratch, "events");
  assert.equal(run(event, ["--path"], { CALLUM_FLOW_REPO: "o/old" }).stdout, `${dir}/o__old.jsonl\n`);
  assert.equal(run(event, ["--path"], { FABRIEK_REPO: "o/new" }).stdout, `${dir}/o__new.jsonl\n`);
  assert.equal(run(event, ["--path"], { FABRIEK_REPO: "o/new", CALLUM_FLOW_REPO: "o/old" }).stdout, `${dir}/o__new.jsonl\n`);
  assert.equal(run(path.join(BASE, "callum-flow-event"), ["--path"], { CALLUM_FLOW_REPO: "o/old" }).stdout, `${dir}/o__old.jsonl\n`);
});

test("fabriek-issue-read reads CALLUM_FLOW_TRUSTED_AUTHORS, and FABRIEK_TRUSTED_AUTHORS wins when both are set", () => {
  const read = path.join(BASE, "fabriek-issue-read");
  const share = { FABRIEK_REPO: "o/r", FABRIEK_SHARE_DIR: BASE };
  const unset = run(read, ["1"], share);
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /FABRIEK_TRUSTED_AUTHORS is not set/);
  const old = run(read, ["1"], { ...share, CALLUM_FLOW_TRUSTED_AUTHORS: "not valid" });
  assert.match(old.stderr, /FABRIEK_TRUSTED_AUTHORS is malformed/, "the old name is read");
  const both = run(read, ["1"], { ...share, CALLUM_FLOW_TRUSTED_AUTHORS: "cbundy:1", FABRIEK_TRUSTED_AUTHORS: "not valid" });
  assert.match(both.stderr, /FABRIEK_TRUSTED_AUTHORS is malformed/, "the new name wins");
  const oldShare = run(read, ["1"], { CALLUM_FLOW_REPO: "o/r", CALLUM_FLOW_SHARE_DIR: BASE, CALLUM_FLOW_TRUSTED_AUTHORS: "not valid" });
  assert.match(oldShare.stderr, /FABRIEK_TRUSTED_AUTHORS is malformed/, "the old share dir setting finds the helpers");
});

test("applyFabriekEnv copies each CALLUM_FLOW_<X> to an unset FABRIEK_<X> and leaves a set one alone", () => {
  const env = applyFabriekEnv({ CALLUM_FLOW_A: "1", CALLUM_FLOW_B: "2", FABRIEK_B: "new", FABRIEK_C: "3", OTHER: "x", CALLUM_FLOW_EMPTY: "" });
  assert.deepEqual(env, { CALLUM_FLOW_A: "1", FABRIEK_A: "1", CALLUM_FLOW_B: "2", FABRIEK_B: "new", FABRIEK_C: "3", OTHER: "x", CALLUM_FLOW_EMPTY: "", FABRIEK_EMPTY: "" });
  const empty = applyFabriekEnv({ CALLUM_FLOW_X: "old", FABRIEK_X: "" });
  assert.equal(empty.FABRIEK_X, "", "an empty FABRIEK_X counts as set");
});

test("fabriek-env.sh does the same as applyFabriekEnv, under a bare PATH", () => {
  const sh = (assign) => run("/bin/sh", ["-c", `. ${BASE}/fabriek-env.sh; printf '%s|%s' "\${FABRIEK_REPO-unset}" "\${FABRIEK_GH_BIN-unset}"`], { PATH: "/nonexistent", ...assign }).stdout;
  assert.equal(sh({}), "unset|unset");
  assert.equal(sh({ CALLUM_FLOW_REPO: "o/r" }), "o/r|unset");
  assert.equal(sh({ CALLUM_FLOW_REPO: "o/r", FABRIEK_REPO: "n/r", CALLUM_FLOW_GH_BIN: "g" }), "n/r|g");
  assert.equal(sh({ CALLUM_FLOW_REPO: "o/r", FABRIEK_REPO: "" }), "|unset", "an empty FABRIEK_REPO counts as set");
});

test("fabriek-env.sh lists every FABRIEK_ setting the base image and the feature scripts read", () => {
  const list = fs.readFileSync(path.join(BASE, "fabriek-env.sh"), "utf8");
  const listed = new Set(list.slice(list.indexOf("for _fe_n in"), list.indexOf("; do")).match(/\b[A-Z][A-Z0-9_]+\b/g));
  const used = new Set();
  const dirs = [BASE, path.join(ROOT, "features", "src", "callum-tools")];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      if (!fs.statSync(file).isFile() || f === "fabriek-env.sh" || f === "fabriek-env.js" || f === "Dockerfile" || f === "README.md") continue;
      for (const m of fs.readFileSync(file, "utf8").matchAll(/\bFABRIEK_([A-Z][A-Z0-9_]*)/g)) used.add(m[1]);
    }
  }
  assert.ok(used.size > 20);
  const missing = [...used].filter((n) => !listed.has(n) && !/_$/.test(n));
  assert.deepEqual(missing, [], "add these to the list in images/base/fabriek-env.sh");
  assert.deepEqual([...listed].filter((n) => !used.has(n)), [], "a listed setting no command reads");
});
