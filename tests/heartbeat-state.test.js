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
  for (const d of ["events", "claude/projects/p"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
});

function ev(state, issue, extra = {}) {
  return { v: 2, ts: "2026-10-12T10:00:00Z", repo: "o/r", device: DEV, state, issue, ...extra };
}

function writeEvents(lines, name = "o__r.jsonl") {
  fs.writeFileSync(path.join(tmp, "events", name), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
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
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
      DEV_MACHINE_NAME: DEV,
      DEV_CONTEXT_WINDOW_DIR: path.join(tmp, "windows"),
      HEARTBEAT_NOW_MS: String(NOW),
      FABRIEK_HEARTBEAT_STATE_SOURCE: "old",
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

test("no-mistakes state is not read: an open run in NO_MISTAKES_HOME neither makes the beat busy nor adds an entry", () => {
  const home = path.join(tmp, "nm");
  fs.mkdirSync(home, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(home, "state.sqlite"));
  db.exec("CREATE TABLE repos (id TEXT PRIMARY KEY, upstream_url TEXT NOT NULL)");
  db.exec("INSERT INTO repos VALUES ('r', 'https://github.com/o/r.git')");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT, branch TEXT, status TEXT NOT NULL)");
  db.exec("INSERT INTO runs VALUES ('run1', 'r', 'feat/issue-12-x', 'running')");
  db.close();
  assert.deepEqual(run({ NO_MISTAKES_HOME: home }).out.in_flight, []);
  assert.equal(run({ NO_MISTAKES_HOME: home }).out.state, "idle");
  // the same file beside an event: only the event's entry, and no run_id from the run
  writeEvents([ev("claimed", 12)]);
  const { out, stderr } = run({ NO_MISTAKES_HOME: home });
  assert.deepEqual(out.in_flight, [{ repo: "o/r", issue: 12, run_id: null, branch: null, state: "claimed" }]);
  assert.equal(stderr, "");
});

test("an issue entry carries its lowercase repo and the run_id of its own event", () => {
  writeEvents([ev("claimed", 5, { repo: "O/R" }), ev("claimed", 5, { repo: "a/b" }), ev("run_started", 8, { repo: "A/B", run_id: "runB", branch: "feat/issue-8-x" })]);
  const { out } = run();
  assert.deepEqual(out.in_flight, [
    { repo: "o/r", issue: 5, run_id: null, branch: null, state: "claimed" },
    { repo: "a/b", issue: 5, run_id: null, branch: null, state: "claimed" },
    { repo: "a/b", issue: 8, run_id: "runB", branch: "feat/issue-8-x", state: "run_started" },
  ]);
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
  assert.deepEqual(out, { state: "idle", in_flight: [], chat_active_at: null, sessions: [], claude_sessions: { interactive: 0, headless: 0 }, config: null, github_errors_1h: null, skipped_events: [] });
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
      const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new" });
      assert.deepEqual(issuesOf(out), want);
      assert.equal(out.state, want.length ? "busy" : "idle");
    });
  }
}

// A transition into building, fixing or merge-queue is the old delegated, fix_requested or merge_ready line.
for (const flat of [false, true]) {
  const shape = flat ? "event_log row" : "local log";
  const n = (type, issue, extra, o) => nev(type, issue, extra, { flat, ...o });
  const at = (m) => ({ ts: `2026-10-12T10:${String(m).padStart(2, "0")}:00Z` });
  const tr = (from, to, m, branch = "issue-7") => n("transition", 7, { from_state: from, to_state: to, branch }, at(m));
  const branchOf = (lines) => {
    writeNew(lines);
    const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new" });
    return out.in_flight.length ? out.in_flight[0].branch : out.state;
  };

  test(`new (${shape}): a transition into building carries the branch, like old delegated`, () => {
    const lines = [n("claimed", 7, {}, at(0)), tr("queued", "designing", 1), tr("designing", "building", 2)];
    assert.equal(branchOf(lines), "issue-7");
    writeEvents([ev("claimed", 7), ev("delegated", 7, { branch: "issue-7", ts: "2026-10-12T10:02:00Z" })]);
    assert.equal(run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "old" }).out.in_flight[0].branch, "issue-7");
  });
  test(`new (${shape}): implementer_routed after the entry reads null, nothing is carried`, () => {
    assert.equal(branchOf([n("claimed", 7, {}, at(0)), tr("designing", "building", 2), n("implementer_routed", 7, {}, at(3))]), null);
  });
  test(`new (${shape}): merge-queue and fixing entries give the branch, merged gives idle`, () => {
    assert.equal(branchOf([n("claimed", 7, {}, at(0)), tr("building", "merge-queue", 2)]), "issue-7");
    assert.equal(branchOf([n("claimed", 7, {}, at(0)), tr("reviewing", "fixing", 2, "issue-8")]), "issue-8");
    assert.equal(branchOf([n("claimed", 7, {}, at(0)), tr("building", "merge-queue", 2), n("merged", 7, {}, at(3))]), "idle");
  });
  test(`new (${shape}): after merged only a transition into building reopens`, () => {
    const merged = n("merged", 7, {}, at(0));
    assert.equal(branchOf([merged, tr("building", "merge-queue", 2)]), "idle");
    assert.equal(branchOf([merged, tr("reviewing", "fixing", 2)]), "idle");
    assert.equal(branchOf([merged, tr("designing", "building", 2)]), "issue-7");
  });
  test(`new (${shape}): same-state transitions and other targets change nothing`, () => {
    const merged = n("merged", 7, {}, at(0));
    for (const [f, t] of [["building", "building"], ["queued", "reviewing"], ["queued", "designing"], ["building", "parked"]]) {
      assert.equal(branchOf([merged, tr(f, t, 2)]), "idle", `${f}->${t}`);
    }
    assert.equal(branchOf([n("claimed", 7, {}, at(0)), tr("building", "building", 2, "other")]), null);
  });
}

test("new: an in_flight entry has the new type as state, a null run_id and the payload branch", () => {
  writeNew([nev("claimed", 7, { branch: "issue-7" })]);
  const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(out.in_flight, [{ repo: "o/r", issue: 7, run_id: null, branch: "issue-7", state: "claimed" }]);
});

test("new: .shadow and .pushed files are not read", () => {
  writeNew([nev("merged", 1)]);
  for (const d of [".shadow", ".pushed"]) {
    fs.mkdirSync(path.join(tmp, "events", "factory", d), { recursive: true });
    fs.writeFileSync(path.join(tmp, "events", "factory", d, "x.jsonl"), JSON.stringify(nev("claimed", 2)) + "\n");
  }
  fs.writeFileSync(path.join(tmp, "events", "factory", ".shadow", "heartbeat-state.jsonl"), JSON.stringify(nev("claimed", 3)) + "\n");
  const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(out.in_flight, []);
});

test("new: a line longer than a read chunk and a torn line are handled", () => {
  writeNew([nev("claimed", 1, { branch: "x".repeat(200000) })]);
  fs.appendFileSync(path.join(tmp, "events", "factory", "o__r.jsonl"), "{torn\n");
  const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(issuesOf(out), [1]);
});

test("every event schema other than envelope is in exactly one of the lifecycle and noise sets", () => {
  const hb = require(SCRIPT);
  const types = fs.readdirSync(SRC).map((f) => /^(.+)\.v1\.json$/.exec(f)).filter(Boolean).map((m) => m[1]).filter((t) => t !== "envelope");
  assert.ok(types.length >= 20);
  for (const t of types) assert.equal([hb.EV_LIFECYCLE, hb.EV_NOISE].filter((set) => set.has(t)).length, 1, t);
  for (const t of [...hb.EV_LIFECYCLE, ...hb.EV_NOISE]) assert.ok(types.includes(t), `${t} has no schema`);
});

test("an event of a version the shapes file does not list as current is skipped and named, never a failure", () => {
  const stamp = (e, v) => ({ ...e, type_version: v });
  writeNew([stamp(nev("claimed", 5, { branch: "issue-5" }, { flat: true }), 2), stamp(nev("claimed", 6, { branch: "issue-6" }, { flat: true }), 1), stamp(nev("mystery", 7, {}, { flat: true }), 1)]);
  for (const source of ["new", "shadow"]) {
    const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: source });
    assert.deepEqual(issuesOf(out), source === "new" ? [6] : [], source);
    assert.deepEqual(out.skipped_events, [{ type: "claimed", type_version: 2, count: 1 }, { type: "mystery", type_version: 1, count: 1 }], source);
  }
  const old = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "old" });
  assert.deepEqual(old.out.skipped_events, []);
});

test("default is new: an empty variable shows new's answer and writes no shadow record; the old variable and --source old show old's", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("merged", 5)]);
  const dflt = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "" });
  assert.deepEqual(issuesOf(dflt.out), [], "new says 5 is merged");
  assert.deepEqual(shadowRecords(), []);
  const viaVar = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "old" });
  assert.deepEqual(issuesOf(viaVar.out), [5], "old says 5 is in flight");
  const viaFlag = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "" }, { args: ["--source", "old"] });
  assert.deepEqual(issuesOf(viaFlag.out), [5]);
  assert.deepEqual(shadowRecords(), []);
});

test("shadow (opt-in): prints old's output and writes one clean record when the reads agree", () => {
  writeEvents([ev("claimed", 5, { branch: "issue-5" })]);
  writeNew([nev("claimed", 5, { branch: "issue-5" })]);
  const env = { FABRIEK_HEARTBEAT_STATE_SOURCE: "shadow" };
  const shadow = run(env);
  const old = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "old" });
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
  const { out, stderr } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "shadow" });
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
  const env = { FABRIEK_HEARTBEAT_STATE_SOURCE: "shadow" };
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
  const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "shadow", FABRIEK_HEARTBEAT_STATE_NEW_TIMEOUT_MS: "50", HEARTBEAT_TEST_NEW_DELAY_MS: "100" });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(issuesOf(out), [5]);
  const [rec] = shadowRecords();
  assert.match(rec.new_error, /new read timed out after 50 ms/);
  assert.equal(rec.differences, null);
});

test("new: a slow read contributes nothing, with a warning, and the beat still answers", () => {
  writeNew([nev("claimed", 5)]);
  const { out, stderr } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new", FABRIEK_HEARTBEAT_STATE_NEW_TIMEOUT_MS: "50", HEARTBEAT_TEST_NEW_DELAY_MS: "100" });
  assert.deepEqual(out.in_flight, []);
  assert.match(stderr, /new read timed out/);
});

test("new: an unreadable new log warns and the answer comes from chat only", () => {
  fs.writeFileSync(path.join(tmp, "events", "factory"), "a file, not a folder");
  writeChat([prompt(60)]);
  const { out, stderr } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "new" });
  assert.deepEqual(out.in_flight, []);
  assert.equal(out.state, "busy");
  assert.match(stderr, /heartbeat-state: events: /);
});

test("an invalid source warns once, reads old and writes no shadow record", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("merged", 5)]);
  const { out, stderr } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "bogus" });
  assert.deepEqual(issuesOf(out), [5]);
  assert.equal(stderr.match(/invalid source/g).length, 1);
  assert.match(stderr, /: reading old\n$/);
  assert.deepEqual(shadowRecords(), []);
  const flag = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "" }, { args: ["--source", "bogus"] });
  assert.match(flag.stderr, /invalid source.*reading old/);
});

test("--source new overrides the environment", () => {
  writeEvents([ev("claimed", 5)]);
  writeNew([nev("merged", 5)]);
  const { out } = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "old" }, { args: ["--source", "new"] });
  assert.deepEqual(out.in_flight, []);
});

// config: the factory loop's settings snapshot (--repo)
function writeSettings(folder, content) {
  const d = path.join(tmp, "claude", "factory-loop", folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "settings.json"), typeof content === "string" ? content : JSON.stringify(content));
}
const snap = { v: 1, repo: "owner/name", at: "2026-10-19T08:00:00Z", settings: { a: 1 } };

test("config is the repo's settings.json, parsed", () => {
  writeSettings("owner__name", snap);
  const { out, stderr } = run({}, { args: ["--repo", "owner/name"] });
  assert.deepEqual(out.config, snap);
  assert.equal(stderr, "");
});

test("config finds a folder whose case differs from the lowercased repo", () => {
  writeSettings("Owner__Name", snap);
  assert.deepEqual(run({}, { args: ["--repo", "owner/name"] }).out.config, snap);
});

test("config is null with no --repo, and with a missing file or folder (no warning)", () => {
  writeSettings("owner__name", snap);
  assert.equal(run().out.config, null);
  const miss = run({}, { args: ["--repo", "other/repo"] });
  assert.equal(miss.out.config, null);
  assert.equal(miss.stderr, "");
  fs.mkdirSync(path.join(tmp, "claude", "factory-loop", "empty__dir"), { recursive: true });
  assert.equal(run({}, { args: ["--repo", "empty/dir"] }).out.config, null);
});

for (const [name, content] of [
  ["malformed JSON", "{not json"],
  ["a JSON array", "[1,2]"],
  ["a JSON scalar", "7"],
  ["a file over 256 KiB", JSON.stringify({ pad: "x".repeat(256 * 1024) })],
]) {
  test(`config is null for ${name}, with one warning and exit 0`, () => {
    writeSettings("owner__name", content);
    const { out, stderr } = run({}, { args: ["--repo", "owner/name"] });
    assert.equal(out.config, null);
    assert.equal(stderr.match(/heartbeat-state: config: /g).length, 1);
  });
}

test("config is null for an unreadable file", { skip: process.getuid && process.getuid() === 0 }, () => {
  writeSettings("owner__name", snap);
  fs.chmodSync(path.join(tmp, "claude", "factory-loop", "owner__name", "settings.json"), 0);
  const { out, stderr } = run({}, { args: ["--repo", "owner/name"] });
  assert.equal(out.config, null);
  assert.match(stderr, /heartbeat-state: config: /);
});

test("--source and --repo are both parsed, in either order", () => {
  writeSettings("owner__name", snap);
  writeEvents([ev("claimed", 5)]);
  const a = run({}, { args: ["--source", "old", "--repo", "owner/name"] });
  assert.deepEqual(a.out.config, snap);
  assert.deepEqual(issuesOf(a.out), [5]);
  const b = run({ FABRIEK_HEARTBEAT_STATE_SOURCE: "bogus" }, { args: ["--repo=owner/name", "--source=old"] });
  assert.deepEqual(b.out.config, snap);
});

// github_errors_1h: the loop's GitHub API errors of the last hour (github.json beside settings.json)
function writeGithub(content, folder = "owner__name") {
  const d = path.join(tmp, "claude", "factory-loop", folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "github.json"), typeof content === "string" ? content : JSON.stringify(content));
}
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();
const ghFile = (over = {}) => ({ v: 1, repo: "owner/name", at: minutesAgo(1), errors: [minutesAgo(5), minutesAgo(30), minutesAgo(59), minutesAgo(61), minutesAgo(180)], ...over });
const ghRun = () => run({}, { args: ["--repo", "owner/name"] });

test("github_errors_1h counts the errors within the hour", () => {
  writeGithub(ghFile());
  const { out, stderr } = ghRun();
  assert.equal(out.github_errors_1h, 3);
  assert.equal(stderr, "");
});

test("github_errors_1h is 0 for a fresh file with no errors, and finds a folder of another case", () => {
  writeGithub(ghFile({ errors: [] }), "Owner__Name");
  assert.equal(ghRun().out.github_errors_1h, 0);
});

test("github_errors_1h ignores entries that are not times", () => {
  writeGithub(ghFile({ errors: [minutesAgo(2), "soon", 5, null, minutesAgo(-30)] }));
  assert.equal(ghRun().out.github_errors_1h, 1);
});

test("github_errors_1h is null with no --repo, and with no file", () => {
  writeGithub(ghFile());
  assert.equal(run().out.github_errors_1h, null);
  fs.rmSync(path.join(tmp, "claude", "factory-loop", "owner__name", "github.json"));
  const { out, stderr } = ghRun();
  assert.equal(out.github_errors_1h, null);
  assert.equal(stderr, "");
});

for (const [name, content] of [
  ["malformed JSON", "{not json"],
  ["a JSON array", "[1,2]"],
  ["a version other than 1", JSON.stringify(ghFile({ v: 2 }))],
  ["no errors list", JSON.stringify(ghFile({ errors: "x" }))],
  ["an at older than 15 minutes", JSON.stringify(ghFile({ at: minutesAgo(16) }))],
  ["no at", JSON.stringify(ghFile({ at: undefined }))],
  ["a file over 256 KiB", JSON.stringify(ghFile({ pad: "x".repeat(256 * 1024) }))],
]) {
  test(`github_errors_1h is null for ${name}, and the call succeeds`, () => {
    writeGithub(content);
    const { out } = ghRun();
    assert.equal(out.github_errors_1h, null);
    assert.equal(out.config, null);
  });
}
