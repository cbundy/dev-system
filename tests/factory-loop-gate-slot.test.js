"use strict";

// plugins/factory-loop-workspace/bin/factory-gate-slot, run for real with flock(1) under a temp loop
// dir (docs/factory-loop/v2/SPEC.md 10.6): the container-wide gate slots that the stop gates and the
// agents' own gate-command runs share. Plugin tests cannot run a command, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (tests/factory-loop-prune.test.js does the same).
require("node:module").register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const WRAPPER = path.join(__dirname, "..", "plugins", "factory-loop-workspace", "bin", "factory-gate-slot");

let dir;
let n = 0;
let slots;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-gate-slot-"));
  slots = await import(path.join(__dirname, "..", "plugins", "factory-loop-workspace", "hooks", "slots.ts"));
});
after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

// fresh: a slot dir of its own for one test
function fresh() {
  return path.join(dir, `slots-${++n}`);
}

function wrapper(slots, args, command, extra = {}) {
  return ["sh", [WRAPPER, "--dir", slots, "--capacity", "1", ...args, "--", ...command], extra];
}

function run(slots, args, command) {
  const [cmd, argv] = wrapper(slots, args, command);
  return spawnSync(cmd, argv, { encoding: "utf8", timeout: 30_000 });
}

// hold: a wrapper run that holds the slot until its `sleep` ends; resolves once it has the slot
function hold(slots, seconds) {
  const [cmd, argv] = wrapper(slots, ["--wait-ms", "0"], ["sleep", String(seconds)]);
  const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a free slot is taken, argv runs and its exit code passes through", () => {
  const r = run(fresh(), ["--wait-ms", "0"], ["sh", "-c", "echo hi; exit 7"]);
  assert.equal(r.status, 7);
  assert.match(r.stdout, /^factory-gate-slot: slot 0 after \d+ ms\nhi\n$/);
});

test("with the slot held and no wait it prints the busy line, exits 75 and runs nothing", async () => {
  const slots = fresh();
  const holder = await hold(slots, 30);
  try {
    const marker = path.join(dir, `ran-${n}`);
    const r = run(slots, ["--wait-ms", "0"], ["touch", marker]);
    assert.equal(r.status, 75);
    assert.match(r.stdout, /^factory-gate-slot: busy: the container's 1 gate slots were all taken for \d+ s; /);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a run with a wait waits for the slot and runs once it frees", async () => {
  const slots = fresh();
  const holder = await hold(slots, 1);
  const t0 = Date.now();
  const [cmd, argv] = wrapper(slots, ["--wait-ms", "20000"], ["echo", "ran"]);
  const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.once("close", r));
  holder.kill("SIGKILL");
  assert.equal(code, 0);
  assert.match(out, /slot 0 after (\d+) ms\nran\n$/);
  assert.ok(Date.now() - t0 >= 700, "it waited for the holder");
  assert.ok(Date.now() - t0 < 15_000, "and not for its whole wait");
});

test("a past-deadline wait is refused", async () => {
  const slots = fresh();
  const holder = await hold(slots, 30);
  try {
    const t0 = Date.now();
    const r = run(slots, ["--wait-ms", "600"], ["echo", "no"]);
    assert.equal(r.status, 75);
    assert.ok(Date.now() - t0 >= 500);
    assert.doesNotMatch(r.stdout, /^no$/m);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a holder killed with SIGKILL frees its slot", async () => {
  const slots = fresh();
  const holder = await hold(slots, 30);
  assert.equal(run(slots, ["--wait-ms", "0"], ["true"]).status, 75);
  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("close", r));
  // the sleep it started is the holder's child and is not holding the slot: fd 9 is closed for it
  const r = run(slots, ["--wait-ms", "2000"], ["true"]);
  assert.equal(r.status, 0, r.stdout);
});

test("a background child the command leaves behind does not keep the slot", () => {
  const slots = fresh();
  const pidFile = path.join(dir, `bg-${n}`);
  const r = run(slots, ["--wait-ms", "0"], ["sh", "-c", `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`]);
  assert.equal(r.status, 0);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid, 0);
    const again = run(slots, ["--wait-ms", "0"], ["true"]);
    assert.equal(again.status, 0, "the slot is free while the daemon lives");
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("--log appends one agent-gate line for a run and one for a refusal", async () => {
  const slots = fresh();
  const log = path.join(dir, `log-${n}.jsonl`);
  const fields = ["--log", log, "--issue", "571", "--life", "ss1x2k", "--seq", "7"];
  run(slots, ["--wait-ms", "0", ...fields], ["sh", "-c", "exit 2"]);
  const holder = await hold(slots, 30);
  try {
    run(slots, ["--wait-ms", "0", ...fields], ["echo", "x"]);
  } finally {
    holder.kill("SIGKILL");
  }
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map(({ at, reason, waitMs, ms, ...rest }) => rest),
    [
      { issue: 571, life: "ss1x2k", seq: 7, cause: "agent-gate", command: "sh -c exit 2", slot: 0, exit: 2, refused: false },
      { issue: 571, life: "ss1x2k", seq: 7, cause: "agent-gate", command: "echo x", slot: null, exit: null, refused: true },
    ],
  );
  assert.ok(typeof lines[0].at === "string" && !Number.isNaN(Date.parse(lines[0].at)));
  assert.equal(typeof lines[0].waitMs, "number");
  assert.equal(typeof lines[0].ms, "number");
  assert.equal(lines[1].ms, 0);
});

test("a bad argument is a usage error, not a run", () => {
  const r = spawnSync("sh", [WRAPPER, "--dir", fresh(), "--capacity", "0", "--", "true"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

// the prelude an agent's Bash call gets, run by a real bash with the real wrapper: a gate command waits
// for the slot (here: is refused at once) and anything else is not touched
test("the prelude runs the real wrapper for npm test and npm run lint, and only for those", async () => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(dir, "calls");
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${calls}'\n`, { mode: 0o755 });
  const slotDir = fresh();
  const log = path.join(dir, "prelude-log.jsonl");
  const prelude = slots.gatePrelude(["npm run lint", "npm test"], { wrapper: WRAPPER, dir: slotDir, capacity: 1, waitMs: 0, log, issue: 5, life: "ab1", seq: 3 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const bash = (cmd) => {
    fs.writeFileSync(calls, "");
    const r = spawnSync("bash", ["-c", `${prelude}\n${cmd}`], { env, encoding: "utf8" });
    return [r.status, r.stdout, fs.readFileSync(calls, "utf8")];
  };
  let [status, out, called] = bash("npm test");
  assert.equal(status, 0);
  assert.match(out, /^factory-gate-slot: slot 0 after \d+ ms\n$/);
  assert.equal(called, "npm test\n");
  [status, out, called] = bash("npm test -- tests/x.test.js; echo \"npm test\"; npm ci; env X=1 npm test");
  assert.equal(out, "npm test\n");
  assert.equal(called, "npm test -- tests/x.test.js\nnpm ci\nnpm test\n");
  // the full gate as an agent runs it: each command of the chain goes through the wrapper
  [status, out, called] = bash("npm run lint && npm test");
  assert.equal(status, 0);
  assert.equal(out.match(/^factory-gate-slot: slot 0 after \d+ ms$/gm).length, 2);
  assert.equal(called, "npm run lint\nnpm test\n");
  // a held slot refuses the gate command at once and never runs npm
  const holder = await hold(slotDir, 30);
  try {
    [status, out, called] = bash("npm run lint");
    assert.equal(status, 75);
    assert.match(out, /busy/);
    assert.equal(called, "");
  } finally {
    holder.kill("SIGKILL");
  }
  const logged = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((l) => [l.cause, l.issue, l.refused, l.command]), [
    ["agent-gate", 5, false, "npm test"],
    ["agent-gate", 5, false, "npm run lint"],
    ["agent-gate", 5, false, "npm test"],
    ["agent-gate", 5, true, "npm run lint"],
  ]);
});

test("a missing flock(1) is a usage error that names it, not a refusal", () => {
  const bin = path.join(dir, `noflock-${n}`);
  fs.mkdirSync(bin);
  for (const t of ["sh", "date", "mkdir", "sed", "tr", "sleep", "true"]) {
    const found = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bin, t));
  }
  const r = spawnSync("/bin/sh", [WRAPPER, "--dir", fresh(), "--capacity", "1", "--", "true"], { env: { PATH: bin }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /flock/);
});
