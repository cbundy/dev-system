// Tests for images/base/heartbeat-state (cbundy/dev-system#466): the busy rule and chat activity.
// The script runs as a subprocess against fixtures built in a temp dir; time is pinned with
// HEARTBEAT_NOW_MS.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { beforeEach, test } = require("node:test");

const SCRIPT = path.join(__dirname, "..", "images", "base", "heartbeat-state");
const NOW = Date.parse("2026-10-12T12:00:00Z");
const DEV = "dev-box";
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-state-"));
  for (const d of ["events", "nm", "claude/projects/p"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
});

function ev(state, issue, extra = {}) {
  return { v: 2, ts: "2026-10-12T10:00:00Z", repo: "o/r", device: DEV, state, issue, ...extra };
}

function writeEvents(lines, name = "o__r.jsonl") {
  fs.writeFileSync(path.join(tmp, "events", name), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

function writeRuns(rows) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(tmp, "nm", "state.sqlite"));
  db.exec("CREATE TABLE repos (id TEXT PRIMARY KEY, upstream_url TEXT NOT NULL)");
  db.exec("INSERT INTO repos VALUES ('r', 'https://github.com/o/r.git'), ('x', 'git@github.com:Other/X.git')");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT, branch TEXT, status TEXT NOT NULL)");
  for (const [id, branch, status, repo = "r"] of rows) db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?)").run(id, repo, branch, status);
  db.close();
}

// A transcript line `ageS` seconds before NOW; the file is touched at the same time.
function writeChat(lines, { fileAgeS = 0, name = "s.jsonl" } = {}) {
  const f = path.join(tmp, "claude", "projects", "p", name);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = new Date(NOW - fileAgeS * 1000);
  fs.utimesSync(f, t, t);
}
const at = (ageS) => new Date(NOW - ageS * 1000).toISOString();
const prompt = (ageS, extra = {}) => ({ type: "user", timestamp: at(ageS), message: { role: "user", content: "please do the thing" }, ...extra });

function run(extraEnv = {}, { args = [] } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CALLUM_EVENTS_DIR: path.join(tmp, "events"),
      NO_MISTAKES_HOME: path.join(tmp, "nm"),
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
      DEV_MACHINE_NAME: DEV,
      DEV_CONTEXT_WINDOW_DIR: path.join(tmp, "windows"),
      HEARTBEAT_NOW_MS: String(NOW),
      CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "old",
      ...extraEnv,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
}

for (const state of ["claimed", "implementer_routed", "delegated", "run_started", "owner_resumed", "briefed", "parked", "merge_ready"]) {
  test(`an issue whose latest event is ${state} is busy`, () => {
    writeEvents([ev("ready", 5, { ts: "2026-10-12T09:00:00Z" }), ev(state, 5)]);
    const { out } = run();
    assert.equal(out.state, "busy");
    assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[5, state]]);
  });
}

for (const state of ["merged", "abandoned", "claim_lost", "owner_wait", "closed", "ready", "reclaimed"]) {
  test(`an issue whose latest event is ${state} is idle`, () => {
    writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev(state, 5)]);
    const { out } = run();
    assert.equal(out.state, "idle");
    assert.deepEqual(out.in_flight, []);
  });
}

test("noise events never decide an issue: untrusted_stripped after merged stays idle, after claimed stays busy", () => {
  writeEvents([ev("merged", 5), ev("untrusted_stripped", 5, { ts: "2026-10-12T11:00:00Z" }), ev("usage", 5, { ts: "2026-10-12T11:01:00Z" }),
    ev("claimed", 6), ev("watcher_error", 6, { ts: "2026-10-12T11:00:00Z" }), ev("superseded", 6, { ts: "2026-10-12T11:00:00Z" }),
    ev("test_weakened", 6, { ts: "2026-10-12T11:00:00Z" }), ev("renewed", 6, { ts: "2026-10-12T11:00:00Z" }), ev("renewed", 5, { ts: "2026-10-12T11:00:00Z" }), ev("upgrade_deferred", 6, { ts: "2026-10-12T11:00:00Z" }), ev("draining", 5, { ts: "2026-10-12T11:00:00Z" })]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[6, "claimed"]]);
});

test("a loop event (the factory loop's bookkeeping, D-09) never decides an issue", () => {
  // a wake about queued #5 must not make it in flight; an agent end on claimed #6 leaves it claimed
  const loop = (issue, note) => ev("loop", issue, { ts: "2026-10-12T11:00:00Z", note });
  writeEvents([ev("ready", 5), loop(5, "kind=judge key=judge:release status=running"),
    ev("claimed", 6), loop(6, "kind=spawn key=design:6:1 status=done"),
    ev("merged", 7), loop(7, "kind=tell key=tell:merged:7 status=done")]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[6, "claimed"]]);
});

test("the v2 loop's transition, reviewed and intervention events never decide an issue", () => {
  // an intervention derived after a release must not reopen #5; bookkeeping on claimed #6 leaves it claimed
  const later = (state, issue) => ev(state, issue, { ts: "2026-10-12T11:00:00Z" });
  writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev("reclaimed", 5), later("intervention", 5),
    ev("claimed", 6), later("transition", 6), later("reviewed", 6), later("intervention", 6),
    ev("merged", 7), later("transition", 7), later("intervention", 7)]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[6, "claimed"]]);
});

test("the companion's prompt_denied and prompt_waiting are no progress and decide no issue", () => {
  // a refusal logged after a release must not reopen #5; on claimed #6 it leaves it claimed
  const later = (state, issue) => ev(state, issue, { ts: "2026-10-12T11:00:00Z" });
  writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev("reclaimed", 5), later("prompt_denied", 5),
    ev("claimed", 6), later("prompt_denied", 6), later("prompt_waiting", 6),
    ev("merged", 7), later("prompt_waiting", 7)]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[6, "claimed"]]);
});

test("another device's lines are ignored", () => {
  writeEvents([ev("claimed", 5, { device: "other" })]);
  assert.equal(run().out.state, "idle");
});

test("the latest event per (repo, issue) wins, whatever the file order", () => {
  writeEvents([ev("merged", 5, { ts: "2026-10-12T11:00:00Z" }), ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" })]);
  assert.equal(run().out.state, "idle");
});

test("unparseable lines and lines without an issue are skipped", () => {
  writeEvents(["not json", ev("claimed", undefined)]);
  assert.equal(run().out.state, "idle");
});

test("a non-terminal no-mistakes run is busy and carries its issue by branch", () => {
  writeRuns([["run1", "feat/issue-12-x", "running"], ["run2", "feat/issue-13-x", "completed"], ["run3", "feat/issue-14-x", "failed"], ["run4", "feat/issue-15-x", "cancelled"]]);
  const { out } = run();
  assert.equal(out.state, "busy");
  assert.deepEqual(out.in_flight, [{ repo: "o/r", issue: 12, run_id: "run1", branch: "feat/issue-12-x", state: "running" }]);
});

test("a run is joined to its issue by run_started.run_id before the branch rule, and merges into the event entry", () => {
  writeEvents([ev("run_started", 7, { run_id: "runA", branch: "feat/issue-7-x" })]);
  writeRuns([["runA", "weird-branch", "running"]]);
  const { out } = run();
  assert.deepEqual(out.in_flight, [{ repo: "o/r", issue: 7, run_id: "runA", branch: "feat/issue-7-x", state: "run_started" }]);
});

test("an issue entry carries its lowercase repo, and a run joins only the issue of its own repo", () => {
  writeEvents([ev("claimed", 5, { repo: "O/R" }), ev("claimed", 5, { repo: "a/b" }), ev("run_started", 8, { repo: "A/B", run_id: "runB" })]);
  writeRuns([["run1", "feat/issue-5-x", "running"], ["run2", "feat/issue-5-y", "running", "x"], ["runB", "weird-branch", "running"]]);
  const { out } = run();
  assert.deepEqual(out.in_flight, [
    { repo: "o/r", issue: 5, run_id: "run1", branch: "feat/issue-5-x", state: "claimed" },
    { repo: "a/b", issue: 5, run_id: null, branch: null, state: "claimed" },
    { repo: "a/b", issue: 8, run_id: "runB", branch: "weird-branch", state: "run_started" },
    { repo: "other/x", issue: 5, run_id: "run2", branch: "feat/issue-5-y", state: "running" },
  ]);
});

test("the branch rule links only an issue-<N> path segment, as in docs/metrics.md", () => {
  writeRuns([["run1", "fix/reissue-3-cache", "running"], ["run2", "feat/issue-12abc", "running"], ["run3", "issue-4", "running"]]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((e) => [e.run_id, e.issue]), [["run1", null], ["run2", null], ["run3", 4]]);
});

test("an open run on a branch with no issue number is still busy", () => {
  writeRuns([["run9", "scratch", "awaiting_approval"]]);
  const { out } = run();
  assert.equal(out.state, "busy");
  assert.equal(out.in_flight[0].issue, null);
});

test("a typed prompt 2 minutes old is busy, 6 minutes old is idle", () => {
  writeChat([prompt(120)]);
  let { out } = run();
  assert.equal(out.state, "busy");
  assert.equal(out.chat_active_at, at(120));
  assert.deepEqual(out.in_flight, []);
  writeChat([prompt(360)], { fileAgeS: 200 });
  ({ out } = run());
  assert.equal(out.state, "idle");
  assert.equal(out.chat_active_at, at(360));
});

test("a transcript not modified in the last 5 minutes is not read", () => {
  writeChat([prompt(400)], { fileAgeS: 400 });
  const { out } = run();
  assert.equal(out.state, "idle");
  assert.equal(out.chat_active_at, null);
});

test("tool results, task notifications, meta lines and sidechain lines are not chat activity", () => {
  writeChat([
    { type: "user", timestamp: at(10), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } },
    { type: "user", timestamp: at(10), message: { role: "user", content: "<task-notification><task-id>1</task-id><summary>Agent done</summary></task-notification>" } },
    prompt(10, { isMeta: true }),
    prompt(10, { isSidechain: true }),
    { type: "assistant", timestamp: at(10), message: { role: "assistant", content: "hello" } },
  ]);
  const { out } = run();
  assert.equal(out.state, "idle");
  assert.equal(out.chat_active_at, null);
});

test("missing files give idle and no throw", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  const { out } = run();
  assert.deepEqual(out, { state: "idle", in_flight: [], chat_active_at: null, sessions: [], claude_sessions: { interactive: 0, headless: 0 } });
});

test("an unreadable state.sqlite degrades to the other sources and reports on stderr", () => {
  fs.writeFileSync(path.join(tmp, "nm", "state.sqlite"), "not a database");
  writeEvents([ev("claimed", 5)]);
  const { out, stderr } = run();
  assert.equal(out.state, "busy");
  assert.match(stderr, /state\.sqlite/);
});

test("superseded is noise: after merged stays idle, after claimed stays busy", () => {
  writeEvents([ev("merged", 5), ev("superseded", 5, { ts: "2026-10-12T11:00:00Z", run_id: "r1" }),
    ev("claimed", 6), ev("superseded", 6, { ts: "2026-10-12T11:00:00Z", run_id: "r1" })]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[6, "claimed"]]);
});

for (const terminal of ["merged", "abandoned", "closed", "claim_lost"]) {
  test(`run facts replayed after ${terminal} stay idle; a new-life decision reopens the issue`, () => {
    writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev(terminal, 5),
      ev("failed", 5, { ts: "2026-10-12T11:00:00Z" }), ev("head_mismatch", 5, { ts: "2026-10-12T11:01:00Z" }),
      ev("conflict", 5, { ts: "2026-10-12T11:02:00Z" }), ev("ci_stalled", 5, { ts: "2026-10-12T11:03:00Z" }),
      ev("run_started", 5, { ts: "2026-10-12T11:04:00Z", run_id: "old" }), ev("parked", 5, { ts: "2026-10-12T11:05:00Z" })]);
    assert.equal(run().out.state, "idle");
    writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev(terminal, 5),
      ev("failed", 5, { ts: "2026-10-12T11:00:00Z" }), ev("claimed", 5, { ts: "2026-10-12T11:30:00Z" }), ev("parked", 5, { ts: "2026-10-12T11:40:00Z" })]);
    const { out } = run();
    assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[5, "parked"]]);
  });
}

test("implementer_routed (#506) is a new-life decision: after merged or abandoned it reopens the issue", () => {
  for (const terminal of ["merged", "abandoned"]) {
    writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev(terminal, 5),
      ev("implementer_routed", 5, { ts: "2026-10-12T11:00:00Z", note: "model=opus reason=hash bucket=12 pct=50" })]);
    const { out } = run();
    assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[5, "implementer_routed"]], terminal);
  }
});

test("a run named by a superseded event on this device is not busy, even while still running", () => {
  writeEvents([ev("superseded", 12, { run_id: "run1" }), ev("superseded", 13, { run_id: "run2", device: "other" })]);
  writeRuns([["run1", "feat/issue-12-x", "running"], ["run2", "feat/issue-13-x", "running"]]);
  const { out } = run();
  assert.deepEqual(out.in_flight.map((e) => e.run_id), ["run2"]);
});

for (const idle of ["ready", "reclaimed", "owner_wait"]) {
  test(`run facts replayed after ${idle} stay idle; a new run after it is busy`, () => {
    writeEvents([ev("claimed", 5, { ts: "2026-10-12T09:00:00Z" }), ev(idle, 5),
      ev("failed", 5, { ts: "2026-10-12T11:00:00Z" }), ev("head_mismatch", 5, { ts: "2026-10-12T11:01:00Z" }),
      ev("conflict", 5, { ts: "2026-10-12T11:02:00Z" }), ev("ci_stalled", 5, { ts: "2026-10-12T11:03:00Z" })]);
    assert.equal(run().out.state, "idle");
    writeEvents([ev(idle, 5), ev("failed", 5, { ts: "2026-10-12T11:00:00Z" }), ev("run_started", 5, { ts: "2026-10-12T11:30:00Z", run_id: "new" })]);
    const { out } = run();
    assert.deepEqual(out.in_flight.map((i) => [i.issue, i.state]), [[5, "run_started"]]);
  });
}

// A sessions/<pid>.json registration as Claude Code writes it. This test process is
// the live pid; procStart is its real start time unless given.
function registerSession(id, { pid = process.pid, procStart, entrypoint } = {}) {
  const stat = () => fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const start = procStart ?? stat().slice(stat().lastIndexOf(")") + 2).split(" ")[19];
  fs.mkdirSync(path.join(tmp, "claude", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "claude", "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, procStart: start, ...(entrypoint ? { entrypoint } : {}) }));
}
function writeSubagent(parent, agent, last) {
  const dir = path.join(tmp, "claude", "projects", "p", parent, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ type: "user", message: { role: "user", content: "task" } }, last, { type: "system", content: "x" }];
  fs.writeFileSync(path.join(dir, `agent-${agent}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("sessions: a live registered session, its running sub-agents and the window its status line wrote", () => {
  registerSession("s1");
  writeSubagent("s1", "a1", { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } });
  writeSubagent("s1", "a2", { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } });
  writeSubagent("s1", "a3", { type: "user", message: { role: "user", content: [{ type: "tool_result" }] } });
  fs.mkdirSync(path.join(tmp, "windows"));
  fs.writeFileSync(path.join(tmp, "windows", "s1"), "1000000\n");
  const { out } = run();
  assert.deepEqual(out.sessions, [
    { session_id: "s1", parent_session_id: null, context_window: 1000000 },
    { session_id: "agent-a1", parent_session_id: "s1", context_window: null },
    { session_id: "agent-a3", parent_session_id: "s1", context_window: null },
  ]);
});

test("sessions: a registration whose pid was reused by another process, or whose pid is gone, is not live", () => {
  registerSession("s1", { procStart: "1" });
  assert.deepEqual(run().out.sessions, []);
  fs.rmSync(path.join(tmp, "claude", "sessions"), { recursive: true });
  registerSession("s2", { pid: 2 ** 22 + 7, procStart: "1" });
  assert.deepEqual(run().out.sessions, []);
});

test("claude_sessions: top-level sessions split by entrypoint (sdk- is headless), a dead pid and sub-agents count in neither", () => {
  const child = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    registerSession("s-tui", { entrypoint: "cli" });
    registerSession("s-print", { pid: child.pid, entrypoint: "sdk-cli" });
    registerSession("s-dead", { pid: 2 ** 22 + 9, procStart: "1", entrypoint: "cli" });
    writeSubagent("s-tui", "a1", { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } });
    assert.deepEqual(run().out.claude_sessions, { interactive: 1, headless: 1 });
  } finally { child.kill(); }
});

test("claude_sessions: an entry with no entrypoint is interactive, and no registry gives zeros", () => {
  assert.deepEqual(run().out.claude_sessions, { interactive: 0, headless: 0 });
  registerSession("s1");
  assert.deepEqual(run().out.claude_sessions, { interactive: 1, headless: 0 });
});

// ---- the source switch (cbundy/dev-system#900) ----

const SRC = require("node:path").join(__dirname, "..", "docs", "factory-events", "schemas");
const shadowFile = () => path.join(tmp, "events", "factory", ".shadow", "heartbeat-state.jsonl");
const shadowRecords = () => (fs.existsSync(shadowFile()) ? fs.readFileSync(shadowFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

// A new event in the local log's shape (payload under data) or an event_log row's (flat).
function nev(type, issue, extra = {}, { flat = false, device = DEV, ts = "2026-10-12T10:00:00Z" } = {}) {
  const base = { ts, type, repo: "o/r", device, issue };
  return flat ? { ...base, ...extra } : { ...base, data: extra };
}
function writeNew(lines, name = "o__r.jsonl") {
  fs.mkdirSync(path.join(tmp, "events", "factory"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "events", "factory", name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const issuesOf = (out) => out.in_flight.map((i) => i.issue).sort((a, b) => a - b);

for (const flat of [false, true]) {
  const shape = flat ? "event_log row" : "local log";
  const n = (type, issue, extra, o) => nev(type, issue, extra, { flat, ...o });
  const early = { ts: "2026-10-12T09:00:00Z" };
  const rules = [
    ["claimed is busy", [n("claimed", 1)], [1]],
    ["merged is idle", [n("claimed", 1, {}, early), n("merged", 1)], []],
    ["requeued is idle", [n("claimed", 1, {}, early), n("requeued", 1)], []],
    ["claim_lost then claimed is busy", [n("claimed", 1, {}, early), n("claim_lost", 1, {}, { ts: "2026-10-12T09:30:00Z" }), n("claimed", 1)], [1]],
    ["implementer_routed after merged reopens", [n("merged", 1, {}, early), n("implementer_routed", 1)], [1]],
    ["finding_handled after merged stays idle", [n("merged", 1, {}, early), n("finding_handled", 1)], []],
    ["noise never decides", [n("claimed", 1, {}, early), ...["transition", "loop_entry", "intervention", "claim_renewed"].map((t) => n(t, 1))], [1]],
    ["noise after merged never reopens", [n("merged", 1, {}, early), ...["transition", "loop_entry", "intervention", "claim_renewed"].map((t) => n(t, 1))], []],
    ["another device is ignored", [n("claimed", 1, {}, { device: "other" })], []],
    ["equal times keep the file order", [n("merged", 1), n("claimed", 1)], [1]],
  ];
  for (const [name, lines, want] of rules) {
    test(`new (${shape}): ${name}`, () => {
      writeNew(lines);
      const { out } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "new" });
      assert.deepEqual(issuesOf(out), want);
      assert.equal(out.state, want.length ? "busy" : "idle");
    });
  }
}

test("new: an in_flight entry has the new type as state, a null run_id and the payload branch", () => {
  writeNew([nev("claimed", 7, { branch: "issue-7" })]);
  const { out } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(out.in_flight, [{ repo: "o/r", issue: 7, run_id: null, branch: "issue-7", state: "claimed" }]);
});

test("new: .shadow and .pushed files are not read, and runs join by branch", () => {
  writeNew([nev("merged", 1)]);
  for (const d of [".shadow", ".pushed"]) {
    fs.mkdirSync(path.join(tmp, "events", "factory", d), { recursive: true });
    fs.writeFileSync(path.join(tmp, "events", "factory", d, "x.jsonl"), JSON.stringify(nev("claimed", 2)) + "\n");
  }
  fs.writeFileSync(path.join(tmp, "events", "factory", ".shadow", "heartbeat-state.jsonl"), JSON.stringify(nev("claimed", 3)) + "\n");
  writeRuns([["run1", "issue-4", "running"]]);
  const { out } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(out.in_flight.map((i) => [i.issue, i.run_id]), [[4, "run1"]]);
});

test("new: a line longer than a read chunk and a torn line are handled", () => {
  writeNew([nev("claimed", 1, { branch: "x".repeat(200000) })]);
  fs.appendFileSync(path.join(tmp, "events", "factory", "o__r.jsonl"), "{torn\n");
  const { out } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(issuesOf(out), [1]);
});

test("every event schema other than envelope is in exactly one of the lifecycle and noise sets", () => {
  const hb = require(SCRIPT);
  const types = fs.readdirSync(SRC).map((f) => /^(.+)\.v1\.json$/.exec(f)).filter(Boolean).map((m) => m[1]).filter((t) => t !== "envelope");
  assert.ok(types.length >= 20);
  for (const t of types) assert.equal([hb.EV_LIFECYCLE, hb.EV_NOISE].filter((set) => set.has(t)).length, 1, t);
  for (const t of [...hb.EV_LIFECYCLE, ...hb.EV_NOISE]) assert.ok(types.includes(t), `${t} has no schema`);
});

test("shadow (the default): prints old's output and writes one clean record when the reads agree", () => {
  writeEvents([ev("claimed", 5, { branch: "issue-5" })]);
  writeNew([nev("claimed", 5, { branch: "issue-5" })]);
  const env = { CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "" };
  const shadow = run(env);
  const old = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "old" });
  assert.deepEqual(shadow.out, old.out);
  assert.equal(shadow.out.in_flight[0].state, "claimed");
  const recs = shadowRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].tool, "heartbeat-state");
  assert.equal(recs[0].differences, 0);
  assert.equal(recs[0].new_error, null);
  assert.equal(recs[0].repo, null);
});

test("shadow: a difference prints old's output and is recorded at an in_flight path", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("merged", 5)]);
  const { out, stderr } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "shadow" });
  assert.deepEqual(issuesOf(out), [5]);
  const [rec] = shadowRecords();
  assert.ok(rec.differences > 0);
  assert.match(rec.paths[0].path, /^\$\.(in_flight|state)/);
  assert.ok(rec.paths.some((p) => p.path.startsWith("$.in_flight")));
  assert.match(stderr, /shadow: \d+ difference/);
});

test("shadow: an agreeing run inside the quiet period writes no record, a differing run does", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("claimed", 5)]);
  const env = { CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "shadow" };
  run(env);
  run(env);
  assert.equal(shadowRecords().length, 1);
  writeNew([nev("merged", 5)]);
  run(env);
  assert.equal(shadowRecords().length, 2);
  // an agreeing run after the quiet period appends again
  writeNew([nev("claimed", 5)]);
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(shadowFile(), old, old);
  run(env);
  assert.equal(shadowRecords().length, 3);
});

test("shadow: a slow new read times out, old's answer is printed and new_error names the timeout", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("claimed", 5)]);
  const t0 = Date.now();
  const { out } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "shadow", CALLUM_FLOW_HEARTBEAT_STATE_NEW_TIMEOUT_MS: "50", HEARTBEAT_TEST_NEW_DELAY_MS: "100" });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(issuesOf(out), [5]);
  const [rec] = shadowRecords();
  assert.match(rec.new_error, /new read timed out after 50 ms/);
  assert.equal(rec.differences, null);
});

test("new: a slow read contributes nothing, with a warning, and the beat still answers", () => {
  writeNew([nev("claimed", 5)]);
  const { out, stderr } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "new", CALLUM_FLOW_HEARTBEAT_STATE_NEW_TIMEOUT_MS: "50", HEARTBEAT_TEST_NEW_DELAY_MS: "100" });
  assert.deepEqual(out.in_flight, []);
  assert.match(stderr, /new read timed out/);
});

test("new: an unreadable new log warns and the answer comes from runs and chat only", () => {
  fs.writeFileSync(path.join(tmp, "events", "factory"), "a file, not a folder");
  writeRuns([["run1", "issue-4", "running"]]);
  const { out, stderr } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(out.in_flight.map((i) => i.issue), [4]);
  assert.match(stderr, /heartbeat-state: events: /);
});

test("an invalid source warns once, reads old and writes no shadow record", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("merged", 5)]);
  const { out, stderr } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "bogus" });
  assert.deepEqual(issuesOf(out), [5]);
  assert.equal(stderr.match(/invalid source/g).length, 1);
  assert.match(stderr, /: reading old\n$/);
  assert.deepEqual(shadowRecords(), []);
  const flag = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "" }, { args: ["--source", "bogus"] });
  assert.match(flag.stderr, /invalid source.*reading old/);
});

test("--source new overrides the environment", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("merged", 5)]);
  const { out } = run({ CALLUM_FLOW_HEARTBEAT_STATE_SOURCE: "old" }, { args: ["--source", "new"] });
  assert.deepEqual(out.in_flight, []);
});
