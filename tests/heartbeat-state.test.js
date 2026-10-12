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

function run() {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CALLUM_EVENTS_DIR: path.join(tmp, "events"),
      NO_MISTAKES_HOME: path.join(tmp, "nm"),
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
      DEV_MACHINE_NAME: DEV,
      DEV_CONTEXT_WINDOW_DIR: path.join(tmp, "windows"),
      HEARTBEAT_NOW_MS: String(NOW),
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
  assert.deepEqual(out, { state: "idle", in_flight: [], chat_active_at: null, sessions: [] });
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
function registerSession(id, { pid = process.pid, procStart } = {}) {
  const stat = () => fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const start = procStart ?? stat().slice(stat().lastIndexOf(")") + 2).split(" ")[19];
  fs.mkdirSync(path.join(tmp, "claude", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "claude", "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, procStart: start }));
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
