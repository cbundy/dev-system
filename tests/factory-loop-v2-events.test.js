"use strict";

// Every event the factory loop v2 writes (docs/factory-loop/v2/SPEC.md 7.1) is built by
// plugins/factory-loop/hooks/v2/events.ts as a native call, `fabriek-event --type <type> --data
// <json>`, and must be one the real images/base/fabriek-event takes: a refused one is a usage
// error the loop only notes, and its fact is lost. This runs the real CLI into a scratch log with an
// event of every kind v2 writes and checks the line against what the translator makes of the old
// format's line for the same event (kept here as a fixture-side helper), so the new store holds what
// it held when the loop wrote notes. Plugin tests cannot run a command, so this lives here.
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
const NATIVE = path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "event-native.ts");
const EVENT = path.join(ROOT, "images", "base", "fabriek-event");
const NOW = Date.UTC(2026, 9, 15, 9, 30);
const HEAD = "0821e6a3c0f4b1d2e5a6978877665544332211ff";

let ev;
let native;
let dir;
let reader;
let rebuilt;
const { translate } = require(path.join(ROOT, "images", "base", "factory-event-translate.js"));

before(async () => {
  ev = await import(EVENTS);
  native = await import(NATIVE);
  reader = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "event-reader.ts"));
  rebuilt = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "park-parts.ts"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-"));
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

const ENV = (d) => ({ PATH: process.env.PATH, CALLUM_EVENTS_DIR: d, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(d, "none.json") });
const linesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const newLog = (d) => path.join(d, "factory", "cbundy__dev-system.jsonl");
const oldLog = (d) => path.join(d, "cbundy__dev-system.jsonl");

// log: the argv run by the real fabriek-event, into the scratch dir; the new log's line written.
function log(argv, d = dir) {
  assert.equal(argv[0], "fabriek-event");
  const before = linesOf(newLog(d)).length;
  const r = spawnSync("sh", [EVENT, ...argv.slice(1)], { encoding: "utf8", env: ENV(d) });
  assert.equal(r.status, 0, `${argv.slice(0, 5).join(" ")} was refused: ${r.stderr}`);
  assert.equal(r.stderr, "", `${argv.slice(0, 5).join(" ")} warned`);
  const lines = linesOf(newLog(d));
  assert.equal(lines.length, before + 1, "one line per event");
  return JSON.parse(lines[lines.length - 1]);
}

// oldArgv: the argv the loop wrote before it went native (the old state, its columns and its note),
// built from the kept note builders. It is the fixture the native data is held to: translate() of
// the old line it makes is the data the new store held.
function oldArgv(e) {
  const c = ev.eventColumns(e);
  const argv = ["fabriek-event", e.state];
  if (c.issue !== null) argv.push("--issue", String(c.issue));
  if (c.branch !== null) argv.push("--branch", c.branch);
  if (c.pr !== null) argv.push("--pr", String(c.pr));
  if (c.head !== null) argv.push("--head", c.head);
  if (e.state === "verdict") argv.push("--actor", "fixer");
  argv.push("--note", ev.eventNote(e));
  return argv;
}

// oldLineOf: the line the old writer built from an old argv (fabriek-event writes it to no log any
// more, cbundy/dev-system#1143, but still builds it for the translator): its columns, as the writer filled them.
function oldLineOf(argv) {
  const opt = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const num = (v) => (v === null ? null : Number(v));
  const branch = opt("--branch");
  const issue = opt("--issue") ?? (/issue-(\d+)/.exec(branch ?? "") ?? [])[1] ?? null;
  const row = {
    v: 2, ts: "2026-10-15T09:30:00Z", repo: "cbundy/dev-system", device: "box", session_id: "s", actor: opt("--actor") ?? "agent", state: argv[0],
    issue: num(issue), run_id: opt("--run"), branch, pr: num(opt("--pr")), head: opt("--head"), note: opt("--note"), event_id: crypto.randomUUID(),
    base_image: null, dev_image: null, template_version: null, plugin_version: null,
  };
  return { text: JSON.stringify(row), row };
}

// oldLine: the old line for an event and the translator's event for it; the real writer takes the same
// argv (in its own scratch dir), writes the translator's event to the new log and nothing to the old one.
function oldLine(e) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-old-"));
  try {
    const argv = oldArgv(e).slice(1);
    const r = spawnSync("sh", [EVENT, ...argv], { encoding: "utf8", env: ENV(d) });
    assert.equal(r.status, 0, `${e.state} was refused: ${r.stderr}`);
    assert.equal(linesOf(oldLog(d)).length, 0, `${e.state} wrote the old log`);
    const { text, row } = oldLineOf(argv);
    const translated = translate(text, { ts: "2026-10-15T09:30:00.000Z", sessionId: "s" });
    if (translated.event !== undefined) assert.equal(JSON.parse(linesOf(newLog(d)).pop()).type, translated.event.type, `${e.state}: the writer's event`);
    return { text, row, translated };
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
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
  conflicts: 2,
  envBlocked: null,
  round: 1,
  parts: null,
  question: "The builder says it cannot: the API it needs is gone. Drop it, or point it at the new one?",
  why: null,
  notes: ["the owner: keep it small", "a, b and none"],
  prClosedAt: null,
  wait: null,
  lives: 1,
  ...over,
});

const FULL_PARTS = {
  decision: "Which API, at 100%? a=b none",
  context: "Two callers differ.\nnone",
  options: [
    { key: "A", title: "v1 = old", detail: "keeps 100% of callers" },
    { key: "B", title: "none", detail: null },
  ],
  recommended: "B",
  recommendation: "newer, simpler",
};
const PARK_QUESTION = "Which API, at 100%? a=b none\n\n#### Context\n\nTwo callers differ.";

const events = () => [
  { state: "transition", record: record(), row: "T7", from: "building", via: "not-ok" },
  { state: "transition", record: record({ state: "queued", seq: 0, pr: null, head: null, resumeTo: null, step: "lease", question: null, notes: [] }), row: "S0", from: null, via: "claim" },
  // a waiting transition carries its wait conditions through the translator; the cleared one reads them as none
  { state: "transition", record: record({ state: "waiting", resumeTo: "designing", pr: null, head: null, question: null, wait: [{ kind: "issue-closed", issue: 57 }, { kind: "pr-merged", pr: 812 }] }), row: "T16", from: "designing", via: "wait" },
  { state: "transition", record: record({ state: "designing", resumeTo: null, pr: null, head: null, question: null, wait: null }), row: "C1", from: "waiting", via: "cleared" },
  { state: "transition", record: record({ state: "closed", why: "merged", step: null, question: null }), row: "T13", from: "merge-queue", via: "ok" },
  // a structured park: every part, then the decision alone, then a park with no parts (the X4 fixer fallback)
  { state: "transition", record: record({ state: "parked", question: PARK_QUESTION, parts: FULL_PARTS }), row: "T3", from: "designing", via: "question" },
  { state: "transition", record: record({ state: "parked", question: "Which API?", parts: { decision: "Which API?", context: null, options: null, recommended: null, recommendation: null } }), row: "T3", from: "designing", via: "question" },
  { state: "transition", record: record({ state: "parked", question: "the triage chose a fixer, which is not possible here", parts: null }), row: "X4", from: "building", via: "triage:fix" },
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
  { state: "verdict", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "WRONG: r2-1 the test already covers it" },
  { state: "merged", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "merged by the loop; its log was lost" },
  { state: "merged", issue: 572, branch: "issue-572", pr: 622, head: "abc1234", note: "merged by the factory loop" },
  { state: "merged", issue: 573, branch: "issue-573", pr: 623, head: "abc1234", note: "merged by hand" },
  { state: "verdict", issue: 571, branch: "issue-571", pr: 621, head: null, note: "CORRECT: r2-2: fixed the off-by-one" },
  { state: "abandoned", issue: 601, branch: "issue-601", pr: null, head: null, note: "dropped by the owner" },
  { state: "abandoned", issue: 602, branch: null, pr: null, head: null, note: "triage: the issue is a duplicate" },
];

test("every event v2 builds is the translator's event for its old line, and one the real writer takes: one new line, none in the old log", () => {
  const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-native-"));
  try {
    for (const e of events()) {
      const argv = ev.eventArgv(e);
      const old = oldLine(e);
      assert.equal(old.translated.skip, undefined, `${e.state}: the old line translates`);
      const want = old.translated.event;
      // the old line carries no size: the executor reads it (cbundy/dev-system#752), null here
      if (want.type === "merged") want.data = { ...want.data, files: null, file_lines: null, additions: null, deletions: null, merged_at: null, title: null };
      assert.deepEqual(argv.slice(0, 5), ["fabriek-event", "--type", want.type, "--data", argv[4]], e.state);
      assert.deepEqual(JSON.parse(argv[4]), want.data, `${e.state}: the data is the translator's`);
      const got = log(argv, nativeDir);
      assert.equal(linesOf(oldLog(nativeDir)).length, 0, `${e.state} wrote the old log`);
      assert.equal(got.type, want.type);
      assert.equal(got.issue ?? null, want.issue ?? null, `${e.state}: the issue`);
      assert.equal(got.actor, e.state === "verdict" ? "fixer" : "agent", `${e.state}: the actor`);
      assert.deepEqual(got.data, want.data, `${e.state}: the written data`);
      assert.deepEqual(reader.validateStrict("envelope", 1, got), []);
      assert.deepEqual(reader.validateStrict(got.type, 1, got.data), []);
      // An optional field the writer leaves out comes back from the reader as null; nothing else changes.
      const back = reader.readEvent(got);
      const added = Object.keys(back.data).filter((k) => !(k in got.data));
      for (const k of added) assert.equal(back.data[k], null, `${got.type} ${k}`);
      assert.deepEqual(Object.fromEntries(Object.entries(back.data).filter(([k]) => !added.includes(k))), got.data);
      // the old line still reads back as the event, for the readers of the old source
      assert.deepEqual(ev.parseEvent({ state: old.row.state, issue: old.row.issue, branch: old.row.branch, pr: old.row.pr, head: old.row.head, note: old.row.note }), e, `${e.state} did not read back`);
    }
    assert.equal(linesOf(newLog(nativeDir)).length, events().length);
  } finally {
    fs.rmSync(nativeDir, { recursive: true, force: true });
  }
});

test("no argv the loop builds names an old state or carries a note, a column flag or --new-only", () => {
  for (const e of events()) {
    const argv = ev.eventArgv(e);
    assert.deepEqual(argv.slice(0, 2), ["fabriek-event", "--type"], e.state);
    for (const flag of ["--note", "--branch", "--pr", "--head", "--new-only", "--run"]) assert.ok(!argv.includes(flag), `${e.state} carries ${flag}`);
    assert.ok(!["delegated", "fix_requested", "merge_ready", "reclaimed", "verdict"].includes(argv[2]), `${e.state} names the old state ${argv[2]}`);
    assert.deepEqual(argv.filter((a) => a.startsWith("--")), ["--type", "--data", ...(argv.includes("--issue") ? ["--issue"] : []), ...(argv.includes("--actor") ? ["--actor"] : [])]);
  }
});

test("the skipped states delegated, fix_requested and merge_ready are no longer written: eventArgv builds none for them", () => {
  for (const state of ["delegated", "fix_requested", "merge_ready"]) {
    assert.throws(() => ev.eventArgv({ state, issue: 571, branch: "issue-571", pr: null, head: null, note: "x" }), /not an event v2 writes/);
  }
  assert.deepEqual(ev.V2_EVENT_STATES, ["transition", "reviewed", "intervention", "reclaimed", "abandoned", "merged", "verdict"]);
  assert.ok(!events().some((e) => ["delegated", "fix_requested", "merge_ready"].includes(e.state)));
});

test("the new store gives the same records, facts and once keys from the native lines as from the translated ones", async () => {
  const records = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "record.ts"));
  const facts = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "sources-facts.ts"));
  const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-rows-"));
  try {
    const nativeRows = [];
    const translatedRows = [];
    for (const e of events()) {
      const got = log(ev.eventArgv(e), nativeDir);
      const want = oldLine(e).translated.event;
      const row = (x) => Object.fromEntries(Object.entries({ ts: x.ts, envelope: "1", event_id: x.event_id, type: x.type, type_version: "1", repo: "cbundy/dev-system", device: "box", actor: x.actor, session_id: "s", issue: x.issue ?? "", device_seq: "1", data: JSON.stringify(x.data) }).map(([k, v]) => [k, String(v)]));
      nativeRows.push(row(got));
      translatedRows.push(row({ ...got, type: want.type, issue: want.issue, data: want.data }));
    }
    const only = (rows, types) => rows.filter((r) => types.includes(r.type));
    assert.ok(only(nativeRows, ["transition"]).length >= 9);
    assert.deepEqual(records.recordsFromNewRows(only(nativeRows, ["transition"])), records.recordsFromNewRows(only(translatedRows, ["transition"])));
    const fact = only(nativeRows, facts.FACTS_TYPES);
    assert.ok(fact.length >= 6);
    const nativeEvents = facts.eventsFromNewRows(fact);
    assert.deepEqual(nativeEvents, facts.eventsFromNewRows(only(translatedRows, facts.FACTS_TYPES)));
    const keys = nativeEvents.map((x) => ev.onceKey(x)).filter((k) => k !== null);
    assert.ok(keys.length >= 5, "the interventions and reviews have once keys");
  } finally {
    fs.rmSync(nativeDir, { recursive: true, force: true });
  }
});

test("a v2 split's abandoned goes through the real writer: the new log carries the reasons, and is the translator's event for the old token note", () => {
  const reasons = { why_split: "Spans the loop, 100% of the image", why_count: "Two: one per side", why_parts: "The image ships on its own", why_order: "none" };
  const childWhys = ["The loop side, with a comma", "The image side"];
  const data = native.splitAbandonedData([601, 602], reasons, childWhys);
  // the note the loop used to write for it, held to the translator
  const note = `reason=split note=${ev.enc("split into 601,602")} why_split=${ev.enc(reasons.why_split)} why_count=${ev.enc(reasons.why_count)} why_parts=${ev.enc(reasons.why_parts)} why_order=${ev.enc(reasons.why_order)} child_whys=${ev.list(childWhys)}`;
  const old = translate(JSON.stringify({ event_id: "11111111-1111-4111-8111-111111111111", ts: "2026-10-15T09:30:00.000Z", state: "abandoned", issue: 600, branch: null, pr: null, head: null, run_id: null, note, actor: "agent", repo: "cbundy/dev-system", device: "box" }), { ts: "2026-10-15T09:30:00.000Z", sessionId: "s" });
  assert.equal(old.skip, undefined, old.miss);
  assert.deepEqual(data, old.event.data);
  const got = log(["fabriek-event", "--type", "abandoned", "--data", JSON.stringify(data), "--issue", "600"]);
  const read = reader.readEvent(got);
  assert.deepEqual(read.data.split_into, [601, 602]);
  assert.deepEqual([read.data.why_split, read.data.why_count, read.data.why_parts, read.data.why_order], [reasons.why_split, reasons.why_count, reasons.why_parts, reasons.why_order]);
  assert.deepEqual(read.data.child_whys, childWhys);
  // without reasons only the children are named, and the new fields read as null
  const bare = log(["fabriek-event", "--type", "abandoned", "--data", JSON.stringify(native.splitAbandonedData([604, 605], null, null)), "--issue", "603"]);
  const bareRead = reader.readEvent(bare);
  assert.deepEqual([bareRead.data.split_into, bareRead.data.why_split, bareRead.data.child_whys, bareRead.data.detail], [[604, 605], null, null, "split into 604,605"]);
});

test("the loop's closed events go through the real writer: reason completed, for the issue", () => {
  const got = log(["fabriek-event", "--type", "closed", "--data", JSON.stringify(native.closedData("completed")), "--issue", "571"]);
  assert.deepEqual(reader.validateStrict("closed", 1, got.data), []);
  assert.deepEqual([got.type, got.issue, got.data], ["closed", 571, { reason: "completed" }]);
});

test("a structured park goes through the real writer: the new log's payload carries the parts, passes the strict schema and reads back", () => {
  const cases = events().filter((e) => e.state === "transition" && (e.row === "T3" || e.row === "X4"));
  assert.equal(cases.length, 3);
  for (const e of cases) {
    const got = log(ev.eventArgv(e));
    assert.equal(got.type, "transition");
    assert.deepEqual(reader.validateStrict("transition", 1, got.data), []);
    const p = e.record.parts;
    const want = p === null ? [null, null, null, null, null] : [p.decision, p.context, p.options, p.recommended, p.recommendation];
    assert.deepEqual([got.data.decision, got.data.context, got.data.options, got.data.recommended, got.data.recommendation], want);
    // the loop's rebuild from the new log reads the same parts
    assert.deepEqual(rebuilt.partsOfData(got.data), p);
  }
});

test("a via=dual-write transition goes through the real writer, carrying the same life, seq and via", () => {
  const e = { state: "transition", record: record(), row: "T7", from: "building", via: "dual-write" };
  const got = log(ev.eventArgv(e));
  const read = reader.readEvent(got);
  assert.equal(got.issue, 571);
  assert.equal(read.type, "transition");
  assert.deepEqual([read.data.via, read.data.life, read.data.seq], ["dual-write", "ss1x2k", 7]);
});

// A gate_run is written in the new format alone (rules-gates.ts): the real fabriek-event takes
// the argv events.ts builds in native mode, warns of nothing, and writes a line the shared reader and
// the strict schema accept, with the issue, the payload and no old-format line.
for (const [name, extra] of [
  ["without the flake fields", {}],
  ["with a flake", { flaky: true, failed_tests: ["group > fails here", "test isolation: database factory_test_x"], failed_at: "2026-10-15T09:10:00.000Z" }],
  ["with memory readings", { mem_start_bytes: 3221225472, mem_peak_bytes: 5368709120, mem_limit_bytes: 17179869184 }],
]) {
  test(`a gate_run ${name} goes through the real writer's native mode: exit 0, no warning, and a line that matches the schema`, () => {
    const data = { ...extra, life: "ss1x2k", seq: 7, head: HEAD, result: "pass", wait_ms: 184000, run_ms: 412000, concurrency: 1, queued_behind: 2, started_at: "2026-10-15T09:20:06.252Z" };
    const e = { state: "gate_run", issue: 571, data };
    const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    const argv = ev.eventArgv(e);
    assert.deepEqual(argv.slice(0, 4), ["fabriek-event", "--type", "gate_run", "--data"]);
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
    assert.deepEqual(reader.readEvent(got), { type: "gate_run", type_version: 1, data: { flaky: null, failed_tests: null, failed_at: null, mem_start_bytes: null, mem_peak_bytes: null, mem_limit_bytes: null, ...data } });

  });
}

// A comment_posted (rules-entry.ts) is native like gate_run: the real writer takes the argv events.ts
// builds, with no warning, and the line matches the strict schema and reads back equal.
test("a comment_posted goes through the real writer's native mode: exit 0, no warning, and a line that matches the schema", () => {
  const data = { life: "ss1x2k", seq: 7, to_state: "parked", comment_url: "https://github.com/cbundy/dev-system/issues/571#issuecomment-1" };
  const e = { state: "comment_posted", issue: 571, data };
  const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  const argv = ev.eventArgv(e);
  assert.deepEqual(argv, ["fabriek-event", "--type", "comment_posted", "--data", JSON.stringify(data), "--issue", "571"]);
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

// A queue_snapshot (hooks/queue-snapshot.ts) is native like gate_run and written for no issue: the real writer
// takes the argv the loop builds with no warning, and its line matches the strict schema and reads back equal.
test("a queue_snapshot goes through the real writer's native mode: no issue, no warning, and a line that matches the schema", async () => {
  const snap = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "queue-snapshot.ts"));
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ issue: i + 1, rank: i + 1, score: i === 1 ? null : 40 - i, factors: i === 1 ? null : [{ name: "waiting", points: 40 - i }], claimable: i === 0, why: i === 0 ? null : i === 1 ? "unknown" : "blocked" }));
  for (const [n, reason, folded] of [[0, "heartbeat", 0], [3, "changed", 2], [60, "changed", 1]]) {
    const view = { rows: rows(n), considered: n, free_slots: n === 0 ? null : 2, priority: [3], only: [], serial: false, noNewWork: false };
    const data = snap.snapshotData(view, NOW, reason, folded);
    const argv = snap.snapshotArgv(data);
    assert.deepEqual(argv, ["fabriek-event", "--type", "queue_snapshot", "--data", JSON.stringify(data)]);
    const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", `queue_snapshot warned: ${r.stderr}`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, before + 1, "one line");
    newSeen.set(file, lines.length);
    const got = JSON.parse(lines[lines.length - 1]);
    assert.equal(got.type, "queue_snapshot");
    assert.equal(got.issue ?? null, null);
    assert.deepEqual(got.data, data);
    assert.deepEqual(reader.validateStrict("envelope", 1, got), []);
    assert.deepEqual(reader.validateStrict("queue_snapshot", 1, got.data), []);
    assert.deepEqual(reader.readEvent(got), { type: "queue_snapshot", type_version: 1, data });
  }
});

// A milestone_state (rules-release-log.ts, O5) is written in the new format alone, for no issue: the real writer takes
// the argv events.ts builds with no warning, and its line matches the strict schema.
test("a milestone_state goes through the real writer's native mode: no issue, no warning, and a line that matches the schema", () => {
  const readings = [
    { milestone_closed: 3, milestone_open: 1, oldest_closed_at: "2026-10-17T10:00:00.000Z", last_tag: "v0.61.0", oldest_unreleased_merge_at: "2026-10-17T09:55:12.000Z", expected: "minor", holding: true, hold_reason: "an open issue changes the same schema" },
    { milestone_closed: 0, milestone_open: 0, oldest_closed_at: null, last_tag: null, oldest_unreleased_merge_at: null, expected: null, holding: false, hold_reason: null },
  ];
  for (const data of readings) {
    const argv = ev.eventArgv({ state: "milestone_state", data });
    assert.deepEqual(argv, ["fabriek-event", "--type", "milestone_state", "--data", JSON.stringify(data)]);
    const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", `milestone_state warned: ${r.stderr}`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, before + 1, "one line");
    newSeen.set(file, lines.length);
    const got = JSON.parse(lines[lines.length - 1]);
    assert.equal(got.type, "milestone_state");
    assert.equal(got.issue ?? null, null);
    assert.deepEqual(got.data, data);
    assert.deepEqual(reader.validateStrict("envelope", 1, got), []);
    assert.deepEqual(reader.validateStrict("milestone_state", 1, got.data), []);
  }
});

// The reading O5 plans (not a hand-written one) goes through the real writer, for a repo with a tag and one without:
// last_tag is always present, so the writer takes it with exit 0 and no stderr.
test("the milestone_state O5 plans is taken by the real writer, with last_tag for a tag and for none", async () => {
  const { readingOf } = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "rules-release-log.ts"));
  const { emptyV2State } = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "observe.ts"));
  for (const tag of ["v0.61.0", null]) {
    const ctx = {
      state: { milestone: { open: 1, closed: 3, openIssues: [7], expected: "minor", oldestClosedAt: "2026-10-17T10:00:00.000Z" }, release: null, ledger: [] },
      v2: { ...emptyV2State(NOW), tag },
    };
    const data = readingOf(ctx);
    const argv = ev.eventArgv({ state: "milestone_state", data });
    const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    newSeen.set(file, lines.length);
    const got = JSON.parse(lines[lines.length - 1]);
    assert.equal(got.data.last_tag, tag);
    assert.deepEqual(reader.validateStrict("milestone_state", 1, got.data), []);
  }
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
    assert.deepEqual(argv, ["fabriek-event", "--type", "shadow_read", "--data", JSON.stringify(data)]);
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

test("a flake row goes through the real writer; its once-key differs from the first row's, which is unchanged", () => {
  const at = { issue: 571, life: "ss1x2k", pr: 621 };
  const fact = "i571/lss1x2k/rerun/r1/18342299123";
  const first = ev.intervention("loop", "ci-rerun", fact, "a failed check re-run (r1/18342299123)", at);
  const flake = { ...ev.intervention("loop", "ci-rerun", fact, "ci flake", at), flaky: true, head: HEAD, failed_jobs: ["ci"], failed_tests: ["a,b"] };
  assert.ok(!ev.eventNote(first).includes("flaky="), "the first row's note is as it was");
  const firstLine = log(ev.eventArgv(first));
  assert.deepEqual([firstLine.data.flaky, firstLine.data.failed_tests, firstLine.data.failed_jobs, firstLine.data.head], [null, null, null, null]);
  const line = log(ev.eventArgv(flake));
  const read = reader.readEvent(line);
  assert.equal(read.type, "intervention");
  assert.deepEqual([read.data.flaky, read.data.head, read.data.failed_jobs, read.data.failed_tests], [true, HEAD, ["ci"], ["a,b"]]);
  // the once keys the old note gives: the flake row has its own
  assert.equal(ev.onceKey({ state: "intervention", issue: 571, note: ev.eventNote(first) }), `intervention 571 ci-rerun ${fact}`);
  assert.equal(ev.onceKey({ state: "intervention", issue: 571, note: ev.eventNote(flake) }), `intervention 571 ci-rerun ${fact} flake`);
});

test("the operator's hand-recorded rescue, as the playbook writes it in the old format, still reads as a person intervention", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-rescue-"));
  try {
    const r = spawnSync("sh", [EVENT, "intervention", "--issue", "571", "--note", "who=person cause=rescue reason=patched%20the%20trust%20file"], { encoding: "utf8", env: ENV(d) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(linesOf(oldLog(d)).length, 0, "the old log must get no line");
    assert.equal(JSON.parse(linesOf(newLog(d)).pop()).type, "intervention");
    const line = oldLineOf(["intervention", "--issue", "571", "--note", "who=person cause=rescue reason=patched%20the%20trust%20file"]).row;
    assert.deepEqual(ev.parseIntervention({ ...line, run: undefined }), { state: "intervention", who: "person", cause: "rescue", reason: "patched the trust file", issue: 571, life: null, pr: null, fact: "" });
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// The dual-write check (docs/factory-events/translator.md): every line of the corpus rebuilt as
// fabriek-event arguments and run through the real writer makes no miss, and the new events per
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
    assert.equal(fs.existsSync(path.join(root, "cbundy__dev-system.jsonl")), false, "the writer must not create the old log");
    // the old lines the writer built from the corpus's arguments (no longer written anywhere): the corpus's own, without the
    // columns the writer fills from its environment (this test has no session and no version snapshot)
    const olds = read("old-lines.jsonl").map((o) => JSON.stringify({ ...o, session_id: null, base_image: null, dev_image: null, template_version: null, plugin_version: null }));
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

test("the loop's environment (FACTORY_REGIME, CLAUDE_SESSION_ID) puts the regime and the loop's session on the envelope", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-regime-"));
  try {
    const env = { ...ENV(d), FACTORY_REGIME: "testbed", CLAUDE_SESSION_ID: "loop-session-1" };
    const r = spawnSync("sh", [EVENT, "intervention", "--issue", "571", "--note", "who=person cause=rescue reason=patched"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const e = JSON.parse(linesOf(newLog(d)).pop());
    assert.equal(e.regime, "testbed");
    assert.equal(e.session_id, "loop-session-1");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
