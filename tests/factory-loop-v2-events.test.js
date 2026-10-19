"use strict";

// Every event the factory loop v2 writes (docs/factory-loop/v2/SPEC.md 7.1) is built by
// plugins/factory-loop/hooks/v2/events.ts, and must be one the real images/base/callum-flow-event
// takes: a refused one is a usage error the loop only notes, and its fact is lost. This runs the
// real CLI into a scratch log with an event of every kind v2 writes, then reads each line back
// with events.ts's own parser, as record.ts and the factory tools do, so the format survives the
// trip through the log's JSON. Plugin tests cannot run a command, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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

const ROOT = path.join(__dirname, "..");
const EVENTS = path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "events.ts");
const EVENT = path.join(ROOT, "images", "base", "callum-flow-event");
const NOW = Date.UTC(2026, 9, 15, 9, 30);
const HEAD = "0821e6a3c0f4b1d2e5a6978877665544332211ff";

let ev;
let dir;
let reader;
const { translate } = require(path.join(ROOT, "images", "base", "factory-event-translate.js"));

before(async () => {
  ev = await import(EVENTS);
  reader = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "event-reader.ts"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-"));
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

// log: the argv run by the real callum-flow-event, into the scratch log only; the line written.
function log(argv) {
  assert.equal(argv[0], "callum-flow-event");
  const file = path.join(dir, "cbundy__dev-system.jsonl");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
  });
  assert.equal(r.status, 0, `${argv.slice(0, 2).join(" ")} was refused: ${r.stderr}`);
  assert.equal(r.stderr, "", `${argv.slice(0, 2).join(" ")} warned`);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, before + 1, "one line per event");
  checkNew(lines[lines.length - 1], argv);
  return JSON.parse(lines[lines.length - 1]);
}

// checkNew: the new event the real writer put beside the old line, when the translator maps the line:
// valid strictly, read back by the shared reader, and equal to the translator's own output for it.
// A skipped state wrote none. A miss would have warned, and the caller fails on that.
function checkNew(oldText, argv) {
  const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
  const got = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const seen = newSeen.get(file) ?? 0;
  const r = translate(oldText, { ts: "", sessionId: "s" });
  if (r.skip !== undefined) {
    assert.equal(got.length, seen, `${argv[1]} is skipped by name and writes no new event`);
    return;
  }
  assert.equal(got.length, seen + 1, `${argv[1]} writes one new event`);
  newSeen.set(file, got.length);
  const e = JSON.parse(got[got.length - 1]);
  const want = translate(oldText, { ts: e.ts, sessionId: "s" });
  assert.deepEqual(e, want.event, `${argv[1]}: the new event is the translator's`);
  assert.deepEqual(reader.validateStrict("envelope", 1, e), []);
  assert.deepEqual(reader.validateStrict(e.type, 1, e.data), []);
  // An optional field the translator leaves out comes back from the reader as null; nothing else changes.
  const back = reader.readEvent(e);
  const added = Object.keys(back.data).filter((k) => !(k in e.data));
  for (const k of added) assert.equal(back.data[k], null, `${e.type} ${k}`);
  assert.deepEqual({ ...back, data: Object.fromEntries(Object.entries(back.data).filter(([k]) => !added.includes(k))) }, { type: e.type, type_version: 1, data: e.data });
}
const newSeen = new Map();

const record = (over) => ({
  issue: 571,
  life: "ss1x2k",
  seq: 7,
  seqAt: NOW - 60_000,
  state: "parked",
  since: NOW - 60_000,
  resumeTo: "building",
  branch: "issue-571",
  pr: 621,
  head: "abc1234def5678abc1234def5678abc1234def56",
  approvedPatch: null,
  brief: "https://github.com/cbundy/dev-system/issues/571#issuecomment-1",
  step: null,
  attempt: 1,
  cut: false,
  triages: 2,
  fixes: 0,
  round: 1,
  question: "The builder says it cannot: the API it needs is gone. Drop it, or point it at the new one?",
  why: null,
  notes: ["the owner: keep it small", "a, b and none"],
  prClosedAt: null,
  wait: null,
  lives: 1,
  ...over,
});

const events = () => [
  { state: "transition", record: record(), row: "T7", from: "building", via: "not-ok" },
  { state: "transition", record: record({ state: "queued", seq: 0, pr: null, head: null, resumeTo: null, step: "lease", question: null, notes: [] }), row: "S0", from: null, via: "claim" },
  // a waiting transition carries its wait conditions through the translator; the cleared one reads them as none
  { state: "transition", record: record({ state: "waiting", resumeTo: "designing", pr: null, head: null, question: null, wait: [{ kind: "issue-closed", issue: 57 }, { kind: "pr-merged", pr: 812 }] }), row: "T16", from: "designing", via: "wait" },
  { state: "transition", record: record({ state: "designing", resumeTo: null, pr: null, head: null, question: null, wait: null }), row: "C1", from: "waiting", via: "cleared" },
  { state: "transition", record: record({ state: "closed", why: "merged", step: null, question: null }), row: "T13", from: "merge-queue", via: "ok" },
  // a record at the table's bounds: a question of 2000 characters and 8 notes of 1000, each whole
  { state: "transition", record: record({ question: "which API, at 100%? ".repeat(100), notes: Array.from({ length: 8 }, (_, i) => `check-${i}, red at 100% `.repeat(50).slice(0, 1000)) }), row: "U4", from: "building", via: "unknown" },
  { state: "reviewed", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", verdict: "changes", round: 2, patch: "3fa2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4", errors: 1, warnings: 2, infos: 0, reviewer: "adjudicator", answer: "/home/x/.claude/factory-loop/o__r/answers/i571_review.json" },
  ev.intervention("loop", "unknown:timeout", "i571/lss1x2k/s7/t", "the build ran past 90 minutes", { issue: 571, life: "ss1x2k", pr: null }),
  // a ci-rerun's second row, the flake verdict (rules-flakes.ts): it shares the first row's fact
  { ...ev.intervention("loop", "ci-rerun", "i571/lss1x2k/rerun/r1/18342299123", "ci flake: run 18342299123 passed on its re-run on 0821e6a", { issue: 571, life: "ss1x2k", pr: 621 }), flaky: true, head: HEAD, failed_jobs: ["ci"], failed_tests: ["tests/a.test.js", "a, b"] },
  { ...ev.intervention("loop", "ci-rerun", "i571/lss1x2k/rerun/r1/18342299123", "not a flake: ci failed again", { issue: 571, life: "ss1x2k", pr: 621 }), flaky: false, head: HEAD, failed_jobs: null, failed_tests: null },
  ev.intervention("person", "op:mode", "op/fleet/mode-act", "mode act", { issue: null, life: null, pr: null }),
  ev.intervention("person", "control-file", "control-file/fleet/lss2", "control.json changed with no op: paused #571", { issue: 571, life: null, pr: null }),
  { state: "reclaimed", issue: 533, branch: "issue-533", pr: null, stage: "queued", checked: "no live step: no slot, no run, no PR activity in 6 h", reason: "reconcile", outcome: "requeue", lives: 2 },
  { state: "abandoned", issue: 589, branch: "fix/issue-589-x", pr: 626, stage: "in pipeline", checked: "no run updated since 02:35", reason: "reconcile", outcome: "leave", lives: null },
  { state: "abandoned", issue: 590, branch: "issue-590", pr: null, stage: "implementing", checked: "a live claim with no record", reason: "reconcile", outcome: "reject", lives: 3 },
  { state: "abandoned", issue: 600, branch: "issue-600", pr: null, head: null, note: "split into 601,602" },
  { state: "delegated", issue: 571, branch: "issue-571", pr: null, head: null, note: "brief https://github.com/cbundy/dev-system/issues/571#issuecomment-1" },
  { state: "fix_requested", issue: 571, branch: "issue-571", pr: 621, head: null, note: "ci" },
  { state: "merge_ready", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "approved" },
  { state: "verdict", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "WRONG: r2-1 the test already covers it" },
  { state: "merged", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "merged by the loop; its log was lost" },
];

test("every event v2 builds is one callum-flow-event takes, and reads back from the log as it went in", () => {
  for (const e of events()) {
    const line = log(ev.eventArgv(e));
    assert.equal(line.state, e.state);
    const row = { state: line.state, issue: line.issue, branch: line.branch, pr: line.pr, head: line.head, note: line.note };
    const back = ev.parseEvent(row);
    // the log keeps an empty note as null; the parser reads it as empty
    assert.deepEqual(back, e, `${e.state} did not read back`);
  }
});

test("a via=dual-write transition goes through the real writer: the old line reads back, and the new log's line carries the same life, seq and via", () => {
  const e = { state: "transition", record: record(), row: "T7", from: "building", via: "dual-write" };
  const line = log(ev.eventArgv(e));
  const back = ev.parseEvent({ state: line.state, issue: line.issue, branch: line.branch, pr: line.pr, head: line.head, note: line.note });
  assert.deepEqual(back, e);
  const newLines = fs.readFileSync(path.join(dir, "factory", "cbundy__dev-system.jsonl"), "utf8").split("\n").filter(Boolean);
  const got = JSON.parse(newLines[newLines.length - 1]);
  const read = reader.readEvent(got);
  assert.equal(got.issue, 571);
  assert.equal(read.type, "transition");
  assert.equal(read.data.via, "dual-write");
  assert.equal(read.data.life, "ss1x2k");
  assert.equal(read.data.seq, 7);
});

test("a v2 split's token note goes through the real writer: the loop reads it back, and the new log's abandoned carries the reasons", () => {
  const reasons = { why_split: "Spans the loop, 100% of the image", why_count: "Two: one per side", why_parts: "The image ships on its own", why_order: "none" };
  const note = ev.splitNote([601, 602], reasons, ["The loop side, with a comma", "The image side"]);
  assert.ok(!note.includes("\n") && note.startsWith("reason=split note=split%20into%20601,602 why_split="));
  const line = log(["callum-flow-event", "abandoned", "--issue", "600", "--branch", "issue-600", "--note", note]);
  const back = ev.parseEvent({ state: line.state, issue: line.issue, branch: line.branch, pr: line.pr, head: line.head, note: line.note });
  assert.deepEqual(back, { state: "abandoned", issue: 600, branch: "issue-600", pr: null, head: null, note: "split into 601,602" });
  const newLines = fs.readFileSync(path.join(dir, "factory", "cbundy__dev-system.jsonl"), "utf8").split("\n").filter(Boolean);
  const read = reader.readEvent(JSON.parse(newLines[newLines.length - 1]));
  assert.equal(read.type, "abandoned");
  assert.deepEqual(read.data.split_into, [601, 602]);
  assert.deepEqual({ ...reasons }, { why_split: read.data.why_split, why_count: read.data.why_count, why_parts: read.data.why_parts, why_order: read.data.why_order });
  assert.deepEqual(read.data.child_whys, ["The loop side, with a comma", "The image side"]);
  // without reasons the old words are kept, and the new fields read as null
  assert.equal(ev.splitNote([601, 602], null, null), "split into 601,602");
  const old = log(["callum-flow-event", "abandoned", "--issue", "603", "--note", ev.splitNote([604, 605], null, null)]);
  const oldRead = reader.readEvent(JSON.parse(fs.readFileSync(path.join(dir, "factory", "cbundy__dev-system.jsonl"), "utf8").split("\n").filter(Boolean).pop()));
  assert.equal(old.note, "split into 604,605");
  assert.deepEqual([oldRead.data.split_into, oldRead.data.why_split, oldRead.data.child_whys], [[604, 605], null, null]);
});

test("a fixer's verdict is logged as the fixer; every other event as the CLI's default actor", () => {
  for (const e of events()) {
    const line = log(ev.eventArgv(e));
    assert.equal(line.actor, e.state === "verdict" ? "fixer" : "agent", e.state);
  }
});

// A gate_run is written in the new format alone (rules-gates.ts): the real callum-flow-event takes
// the argv events.ts builds in native mode, warns of nothing, and writes a line the shared reader and
// the strict schema accept, with the issue, the payload and no old-format line.
test("a gate_run goes through the real writer's native mode: exit 0, no warning, and a line that matches the schema", () => {
  const data = { life: "ss1x2k", seq: 7, head: HEAD, result: "pass", wait_ms: 184000, run_ms: 412000, concurrency: 1, queued_behind: 2, started_at: "2026-10-15T09:20:06.252Z" };
  const e = { state: "gate_run", issue: 571, data };
  const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  const argv = ev.eventArgv(e);
  assert.deepEqual(argv.slice(0, 4), ["callum-flow-event", "--type", "gate_run", "--data"]);
  const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "", `gate_run warned: ${r.stderr}`);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, before + 1, "one line");
  newSeen.set(file, lines.length);
  const got = JSON.parse(lines[lines.length - 1]);
  assert.equal(got.type, "gate_run");
  assert.equal(got.issue, 571);
  assert.deepEqual(got.data, data);
  assert.deepEqual(reader.validateStrict("envelope", 1, got), []);
  assert.deepEqual(reader.validateStrict("gate_run", 1, got.data), []);
  // the reader gives the optional flake fields, which an older writer never sends, as null
  assert.deepEqual(reader.readEvent(got), { type: "gate_run", type_version: 1, data: { ...data, flaky: null, failed_tests: null, failed_at: null } });
});

// A comment_posted (rules-entry.ts) is native like gate_run: the real writer takes the argv events.ts
// builds, with no warning, and the line matches the strict schema and reads back equal.
test("a comment_posted goes through the real writer's native mode: exit 0, no warning, and a line that matches the schema", () => {
  const data = { life: "ss1x2k", seq: 7, to_state: "parked", comment_url: "https://github.com/cbundy/dev-system/issues/571#issuecomment-1" };
  const e = { state: "comment_posted", issue: 571, data };
  const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  const argv = ev.eventArgv(e);
  assert.deepEqual(argv, ["callum-flow-event", "--type", "comment_posted", "--data", JSON.stringify(data), "--issue", "571"]);
  const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "", `comment_posted warned: ${r.stderr}`);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, before + 1, "one line");
  newSeen.set(file, lines.length);
  const got = JSON.parse(lines[lines.length - 1]);
  assert.equal(got.type, "comment_posted");
  assert.equal(got.issue, 571);
  assert.deepEqual(got.data, data);
  assert.deepEqual(reader.validateStrict("envelope", 1, got), []);
  assert.deepEqual(reader.validateStrict("comment_posted", 1, got.data), []);
  assert.deepEqual(reader.readEvent(got), { type: "comment_posted", type_version: 1, data });
});

// A shadow_read (sources-records.ts) is written in the new format alone and for no issue: the argv has no
// --issue, the real writer takes it with no warning, and its line matches the strict schema.
test("a shadow_read goes through the real writer's native mode: no issue, no warning, and a line that matches the schema", async () => {
  const records = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "sources-records.ts"));
  const compared = records.compareRebuilds([], [], "box", NOW, NOW).data;
  assert.equal(compared.reader, "loop-records");
  const found = { reader: "loop-records", tool: "factory-loop", compared: 42, differences: 2, live_differences: 3, diff_keys: ["12", "15"], old_ok: true, new_ok: false, settle_seconds: 600, detail: "#12 round: old 0, new 4" };
  for (const data of [compared, found]) {
    const argv = ev.eventArgv({ state: "shadow_read", data });
    assert.deepEqual(argv, ["callum-flow-event", "--type", "shadow_read", "--data", JSON.stringify(data)]);
    const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", `shadow_read warned: ${r.stderr}`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, before + 1, "one line");
    newSeen.set(file, lines.length);
    const got = JSON.parse(lines[lines.length - 1]);
    assert.equal(got.type, "shadow_read");
    assert.equal(got.issue ?? null, null);
    assert.deepEqual(got.data, data);
    assert.deepEqual(reader.validateStrict("envelope", 1, got), []);
    assert.deepEqual(reader.validateStrict("shadow_read", 1, got.data), []);
  }
});

test("a flake row goes through the real writer and translator; its once-key differs from the first row's, which is unchanged", () => {
  const at = { issue: 571, life: "ss1x2k", pr: 621 };
  const fact = "i571/lss1x2k/rerun/r1/18342299123";
  const first = ev.intervention("loop", "ci-rerun", fact, "a failed check re-run (r1/18342299123)", at);
  const flake = { ...ev.intervention("loop", "ci-rerun", fact, "ci flake", at), flaky: true, head: HEAD, failed_jobs: ["ci"], failed_tests: ["a,b"] };
  assert.ok(!ev.eventNote(first).includes("flaky="), "the first row's note is as it was");
  const firstLine = log(ev.eventArgv(first));
  assert.equal(ev.onceKey(firstLine), `intervention 571 ci-rerun ${fact}`);
  const line = log(ev.eventArgv(flake));
  assert.equal(ev.onceKey(line), `intervention 571 ci-rerun ${fact} flake`);
  const lines = fs.readFileSync(path.join(dir, "factory", "cbundy__dev-system.jsonl"), "utf8").split("\n").filter(Boolean);
  const read = reader.readEvent(JSON.parse(lines[lines.length - 1]));
  assert.equal(read.type, "intervention");
  assert.deepEqual([read.data.flaky, read.data.head, read.data.failed_jobs, read.data.failed_tests], [true, HEAD, ["ci"], ["a,b"]]);
});

test("the operator's hand-recorded rescue, as the playbook writes it, reads as a person intervention", () => {
  const line = log(["callum-flow-event", "intervention", "--issue", "571", "--note", "who=person cause=rescue reason=patched%20the%20trust%20file"]);
  assert.deepEqual(ev.parseIntervention({ ...line, run: undefined }), {
    state: "intervention",
    who: "person",
    cause: "rescue",
    reason: "patched the trust file",
    issue: 571,
    life: null,
    pr: null,
    fact: "",
  });
});

// The dual-write check (docs/factory-events/translator.md): every line of the corpus rebuilt as
// callum-flow-event arguments and run through the real writer makes no miss, and the new events per
// type are the mapped old lines minus the named skips.
test("the corpus through the real writer: zero misses, and the events are the corpus's", () => {
  const corpus = path.join(ROOT, "tests", "fixtures", "factory-events");
  const read = (f) => fs.readFileSync(path.join(corpus, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-dual-write-"));
  try {
    const made = [];
    for (const old of read("old-lines.jsonl")) {
      const uuid = path.join(root, "uuid");
      fs.writeFileSync(uuid, `${old.event_id}\n`);
      const args = ["--actor", old.actor, "--repo", old.repo];
      for (const [flag, v] of [["--issue", old.issue], ["--run", old.run_id], ["--branch", old.branch], ["--pr", old.pr], ["--head", old.head], ["--note", old.note]]) {
        if (v !== null && v !== undefined) args.push(flag, String(v));
      }
      const r = spawnSync("sh", [EVENT, old.state, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, CALLUM_EVENTS_DIR: root, CALLUM_EVENT_UUID_SOURCE: uuid, DEV_MACHINE_NAME: old.device, DEV_VERSIONS_FILE: path.join(root, "none.json") },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, "", `${old.state} ${old.event_id} warned: ${r.stderr}`);
      made.push(old.state);
    }
    const olds = fs.readFileSync(path.join(root, "cbundy__dev-system.jsonl"), "utf8").split("\n").filter(Boolean);
    const news = fs.readFileSync(path.join(root, "factory", "cbundy__dev-system.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(olds.length, made.length);
    const byId = new Map(news.map((e) => [e.event_id, e]));
    for (const text of olds) {
      const o = JSON.parse(text);
      const r = translate(text, { ts: byId.get(o.event_id)?.ts });
      if (r.skip !== undefined) assert.equal(byId.has(o.event_id), false, `${o.state} is skipped`);
      else assert.deepEqual(byId.get(o.event_id), r.event, o.event_id);
    }
    const count = (events) => Object.fromEntries([...events.reduce((m, e) => m.set(e.type, (m.get(e.type) ?? 0) + 1), new Map())].sort());
    assert.deepEqual(count(news), count(read("expected.jsonl")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
