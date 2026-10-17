// The translator from today's event lines to the new events (images/base/factory-event-translate.js,
// dev-system#648; the mapping is docs/factory-events/translator.md). The corpus in
// tests/fixtures/factory-events/ holds real lines (from the factory's own event log) and hand-made
// ones for shapes with no real example; expected.jsonl is the golden output of the whole corpus.
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("node:module");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (tests/factory-events.test.js does the same).
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
const MODULE = path.join(ROOT, "images", "base", "factory-event-translate.js");
const FIXTURES = path.join(__dirname, "fixtures", "factory-events");
const HOOKS = path.join(ROOT, "plugins", "factory-loop", "hooks");
const { translate, tokensOf, noteToken, MAPPED_STATES, SKIPPED_STATES } = require(MODULE);

const jsonl = (file) =>
  fs
    .readFileSync(path.join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
const oldLines = jsonl("old-lines.jsonl");
const expected = jsonl("expected.jsonl");

let reader;
let schemaEvents;
let passes;
before(async () => {
  reader = await import(path.join(HOOKS, "v2", "event-reader.ts"));
  schemaEvents = await import(path.join(HOOKS, "v2", "events.ts"));
  passes = await import(path.join(HOOKS, "passes.ts"));
});

// What the corpus skips, by name and count.
const EXPECTED_SKIPS = {
  "loop kind=spawn": 3,
  "loop kind=delegate": 3,
  "loop kind=judge": 2,
  "loop kind=breaker": 1,
  "loop key=cap:* status=held": 2,
  "verdict NIT": 1,
  "verdict DUP": 1,
  "verdict ENV": 1,
  delegated: 2,
  fix_requested: 3,
  merge_ready: 2,
  prompt_denied: 1,
  prompt_waiting: 1,
  briefed: 1,
  design_routed: 1,
  run_started: 1,
  parked: 1,
  failed: 1,
  head_mismatch: 1,
  conflict: 1,
  ci_stalled: 1,
  rebased_behind: 1,
  superseded: 1,
  watcher_error: 1,
};

// A line to change: the first corpus line of a state.
const sample = (state, pick = () => true) => structuredClone(oldLines.find((l) => l.state === state && pick(l)));
const withNote = (line, note) => ({ ...line, note });
const missOf = (line, opts) => {
  const r = translate(line, opts);
  assert.deepEqual(Object.keys(r), ["miss"], `expected a miss, got ${JSON.stringify(r).slice(0, 300)}`);
  return r.miss;
};

test("the corpus: each old line gives its golden event or a skip by name, and nothing else", () => {
  const events = [];
  const skips = {};
  for (const line of oldLines) {
    const r = translate(line);
    assert.equal(Object.keys(r).length, 1, `exactly one of event, skip, miss: ${line.event_id}`);
    assert.equal(r.miss, undefined, `${line.state} ${line.event_id}: ${r.miss}`);
    if (r.skip !== undefined) skips[r.skip] = (skips[r.skip] ?? 0) + 1;
    else events.push(r.event);
  }
  assert.deepEqual(skips, EXPECTED_SKIPS);
  assert.deepEqual(events, expected);
  assert.equal(events.length + Object.values(skips).reduce((a, b) => a + b, 0), oldLines.length);
});

test("every event is valid strictly (envelope and payload) and readEvent returns it unchanged", () => {
  for (const e of expected) {
    assert.deepEqual(reader.validateStrict("envelope", 1, e), [], e.event_id);
    assert.equal(e.envelope, 1);
    assert.equal(e.type_version, 1);
    assert.deepEqual(reader.validateStrict(e.type, 1, e.data), [], `${e.type} ${e.event_id}`);
    // An optional field the translator leaves out comes back from the reader as null.
    const got = reader.readEvent(e);
    const added = Object.keys(got.data).filter((k) => !(k in e.data));
    for (const k of added) assert.equal(got.data[k], null, `${e.type} ${k}`);
    assert.deepEqual({ ...got, data: Object.fromEntries(Object.entries(got.data).filter(([k]) => !added.includes(k))) }, { type: e.type, type_version: 1, data: e.data }, e.event_id);
  }
});

test("each event shares its old line's event_id, and the old line is left untouched", () => {
  const before = JSON.stringify(oldLines);
  const ids = new Set(oldLines.map((l) => l.event_id));
  assert.equal(ids.size, oldLines.length, "the corpus has unique event_ids");
  for (const e of expected) assert.ok(ids.has(e.event_id));
  for (const line of oldLines) translate(line);
  assert.equal(JSON.stringify(oldLines), before);
});

test("coverage: the corpus produces every current type, and every writer state is mapped or skipped by name", () => {
  const made = new Set(expected.map((e) => e.type));
  for (const type of Object.keys(schemaCurrent())) assert.ok(made.has(type), `no corpus line produces ${type}`);
  const states = writerStates();
  assert.ok(states.length > 20);
  for (const s of states) assert.ok(MAPPED_STATES.includes(s) || SKIPPED_STATES.includes(s), `callum-flow-event writes ${s}, which the translator neither maps nor skips`);
  for (const s of [...MAPPED_STATES, ...SKIPPED_STATES]) assert.ok(states.includes(s) || s === "renewed" || s === "reclaimed", `${s} is not a writer state`);
});

function writerStates() {
  const writer = fs.readFileSync(path.join(ROOT, "images", "base", "callum-flow-event"), "utf8");
  return /^STATES="([^"]+)"/m.exec(writer)[1].split(" ");
}

function schemaCurrent() {
  const CURRENT = {};
  for (const f of fs.readdirSync(path.join(ROOT, "docs", "factory-events", "schemas"))) {
    const m = /^([a-z_]+)\.v(\d+)\.json$/.exec(f);
    if (m !== null && m[1] !== "envelope") CURRENT[m[1]] = Math.max(CURRENT[m[1]] ?? 0, Number(m[2]));
  }
  return CURRENT;
}

test("coverage: the plugin's CURRENT catalogue matches the schemas the corpus is checked against", async () => {
  const { CURRENT } = await import(path.join(HOOKS, "v2", "event-schemas.ts"));
  assert.deepEqual(CURRENT, schemaCurrent());
});

test("coverage: every row of translator.md has a corpus line, and each shape is in the golden output", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "factory-events", "translator.md"), "utf8");
  const rowStates = new Set();
  for (const row of doc.split("\n").filter((l) => l.startsWith("| `"))) {
    const first = row.split("|")[1];
    for (const m of first.matchAll(/`([a-z_]+)`/g)) if (writerStates().includes(m[1])) rowStates.add(m[1]);
  }
  const corpusStates = new Set(oldLines.map((l) => l.state));
  assert.ok(rowStates.has("claim_lost") && rowStates.has("reclaimed") && rowStates.has("loop"));
  for (const s of rowStates) assert.ok(corpusStates.has(s), `translator.md has a row for ${s}, the corpus no line`);
  const data = (type) => expected.filter((e) => e.type === type).map((e) => e.data);
  const has = (type, pred, what) => assert.ok(data(type).some(pred), `no ${type} fixture for ${what}`);
  has("claim_lost", (d) => d.race === false && d.holder_since !== null, "held by");
  has("claim_lost", (d) => d.race === true && d.holder !== null, "race lost to a device");
  has("claim_lost", (d) => d.race === true && d.holder === null, "race lost to another device");
  has("requeued", (d) => d.reason === "lease-expired", "lease expired");
  has("requeued", (d) => d.reason === "reconcile" && d.lives !== null && d.branch !== null, "reconcile with lives and a branch");
  has("requeued", (d) => d.reason === "reconcile" && d.lives === null && d.pr !== null, "reconcile with the pr token");
  for (const reason of ["rejected", "reconcile", "dropped", "split", "triage", "other"]) has("abandoned", (d) => d.reason === reason, `abandoned ${reason}`);
  has("abandoned", (d) => d.reason === "split" && d.split_into.length === 2, "split into a list");
  for (const by of ["factory", "hand"]) for (const recovered of [true, false]) if (!(by === "hand" && !recovered)) has("merged", (d) => d.by === by && d.recovered === recovered, `merged ${by} ${recovered}`);
  for (const source of ["issue", "pr", "comment", "comments", "timeline", "list"]) has("untrusted_stripped", (d) => d.source === source, `stripped ${source}`);
  has("usage", (d) => d.available === true, "a usage reading");
  has("usage", (d) => d.available === false && d.reasons.length === 2, "usage unavailable");
  has("finding_handled", (d) => d.outcome === "fixed", "CORRECT");
  has("finding_handled", (d) => d.outcome === "declined", "WRONG");
  has("claimed", (d) => d.lease_minutes === 120, "the null-note default");
  has("claimed", (d) => d.lease_minutes === 90, "a lease note");
  has("claim_renewed", () => true, "renewed");
  has("closed", (d) => d.reason === null, "an empty closed note");
  has("closed", (d) => d.reason !== null, "a closed reason");
  has("transition", (d) => d.lives === 1, "the lives default");
  has("intervention", (d) => d.life === null && d.fact === null, "a hand rescue");
  has("implementer_routed", (d) => d.bucket === null, "bucket -");
  has("implementer_routed", (d) => d.bucket !== null, "a bucket");
  has("test_weakened", (d) => d.kinds.length > 0, "kinds");
  for (const kind of ["agent-step", "tell", "task"]) has("loop_entry", (d) => d.kind === kind, `loop ${kind}`);
  has("loop_entry", (d) => d.ended_at !== null, "an ended entry");
  has("loop_passes", (d) => d.passes === 0 && d.mean_ms === null, "an empty minute");
  has("loop_passes", (d) => d.idle_mean_ms === null && d.acting > 0, "none for idle_mean_ms");
  has("loop_passes", (d) => d.acting_mean_ms === null && d.passes > 0, "none for acting_mean_ms");
});

test("a loop kind=passes line never becomes a loop_entry, and a task line with out= and decision= is dropped to its entry", () => {
  const passesLine = oldLines.find((l) => l.state === "loop" && /kind=passes/.test(l.note));
  assert.equal(translate(passesLine).event.type, "loop_passes");
  const task = withNote(sample("loop", (l) => /kind=task/.test(l.note ?? "")), "kind=task key=task:release:2:none status=done attempts=1 class=drive rule=O3 started=1792184909172 ended=1792185127762 wake=release out=wake decision=hold agent=x");
  const r = translate(task);
  assert.equal(r.event.type, "loop_entry");
  assert.equal(r.event.data.ended_at, "2026-10-16T21:12:07.762Z");
  assert.deepEqual(Object.keys(r.event.data).sort(), ["agent_id", "attempts", "class", "ended_at", "key", "kind", "rule", "started_at", "status", "wake"]);
});

test("passes: a note built by the real passesNote from closeMinute translates to a valid loop_passes", () => {
  const minute = Date.UTC(2026, 9, 17, 0, 46);
  const settings = { mode: "act", planner: "v2", passEveryMs: 10000 };
  const book = new Map();
  passes.notePass(book, minute + 5000, 120.4, true, false);
  passes.notePass(book, minute + 15000, 3000, false, true);
  passes.notePass(book, minute + 25000, 450, false, false);
  const busy = passes.closeMinute(book, minute, settings);
  const empty = passes.closeMinute(new Map(), minute + 60000, { mode: "off", planner: "v1", passEveryMs: 5000 });
  assert.equal(busy.passes, 3);
  assert.equal(empty.passes, 0);
  const base = oldLines.find((l) => l.state === "loop" && /kind=passes/.test(l.note));
  for (const summary of [busy, empty]) {
    const note = passes.passesNote(summary);
    const r = translate({ ...base, note });
    assert.ok(r.event, `${note}: ${JSON.stringify(r)}`);
    assert.deepEqual(reader.validateStrict("loop_passes", 1, r.event.data), []);
    assert.equal(r.event.data.from_at, new Date(summary.from).toISOString());
    assert.equal(r.event.data.to_at, new Date(summary.to).toISOString());
    assert.equal(r.event.data.passes, summary.passes);
    assert.equal(r.event.data.mean_ms, summary.mean);
    assert.equal(r.event.data.p50_ms, summary.p50);
    assert.equal(r.event.data.p90_ms, summary.p90);
    assert.equal(r.event.data.max_ms, summary.max);
    assert.equal(r.event.data.acting_mean_ms, summary.actingMean);
    assert.equal(r.event.data.idle_mean_ms, summary.idleMean);
    assert.equal(r.event.data.errors, summary.errors);
    assert.equal(r.event.data.mode, summary.settings.mode);
    assert.equal(r.event.data.pass_every_ms, summary.settings.passEveryMs);
  }
});

test("passes: an extra token, a missing token, a status other than done and a key not matching from are misses", () => {
  const base = oldLines.find((l) => l.state === "loop" && /kind=passes/.test(l.note));
  const note = base.note;
  assert.match(missOf(withNote(base, `${note} extra=1`)), /^loop: unexpected token extra=/);
  assert.match(missOf(withNote(base, note.replace(" errors=0", ""))), /^loop: missing token errors=/);
  assert.match(missOf(withNote(base, note.replace("status=done", "status=running"))), /status=running is not done/);
  assert.match(missOf(withNote(base, note.replace(/key=passes:\d+/, "key=passes:1"))), /key=passes:1 is not passes:<epoch ms of from>/);
  assert.match(missOf(withNote(base, note.replace(/mode=\w+/, "mode=turbo"))), /mode is not valid/);
  assert.match(missOf(withNote(base, note.replace(/passes=(\d+) /, "passes=many "))), /bad number passes=many/);
  assert.match(missOf(withNote(base, note.replace(/from=\S+/, "from=yesterday"))), /bad time from=yesterday/);
});

test("misses name their cause and give no event", () => {
  const extra = (state, pick) => missOf(withNote(sample(state, pick), `${sample(state, pick).note} surprise=1`));
  assert.match(extra("transition"), /^transition: unexpected token surprise=/);
  assert.match(extra("reviewed"), /^reviewed: unexpected token surprise=/);
  assert.match(extra("intervention"), /^intervention: unexpected token surprise=/);
  assert.match(extra("loop", (l) => /kind=agent-step/.test(l.note ?? "")), /^loop: unexpected token surprise=/);
  assert.match(extra("implementer_routed"), /^implementer_routed: unexpected token surprise=/);
  assert.match(extra("test_weakened"), /^test_weakened: unexpected token surprise=/);
  assert.match(extra("usage", (l) => /five_hour=/.test(l.note ?? "")), /^usage: unexpected token surprise=/);
  const release = (state) => sample(state, (l) => /^reason=reconcile/.test(l.note ?? ""));
  for (const state of ["abandoned"]) assert.match(missOf(withNote(release(state), `${release(state).note} surprise=1`)), /^abandoned: unexpected token surprise=/);
  const reclaimed = { ...sample("claimed"), state: "reclaimed", note: "reason=reconcile outcome=requeue lives=1 stage=queued pr=none checked=x surprise=1" };
  assert.match(missOf(reclaimed), /^reclaimed: unexpected token surprise=/);
  assert.match(missOf({ ...reclaimed, note: "reason=reconcile outcome=leave lives=1 stage=queued pr=none checked=x" }), /reclaimed outcome=leave is not requeue/);

  const noId = sample("ready");
  delete noId.event_id;
  assert.equal(missOf(noId), "ready: the line has no event_id");
  assert.equal(missOf({ ...noId, event_id: "" }), "ready: the line has no event_id");
  assert.match(missOf({ ...noId, event_id: "not-a-uuid" }), /^ready: event_id is not a UUID/);
  assert.equal(missOf({ ...sample("ready"), state: "frobnicated" }), "frobnicated: unknown state");
  assert.match(missOf({ ...sample("ready"), state: undefined }), /^\?: the line has no state/);
  assert.match(missOf(withNote(sample("claimed"), "lease: lots")), /^claimed: note matches no lease shape/);
  assert.match(missOf(withNote(sample("claimed"), "lease: 0")), /lease_minutes is not valid/);
  assert.match(missOf(withNote(sample("transition"), sample("transition").note.replace(/seq=\d+/, "seq=x"))), /^transition: bad number seq=x/);
  assert.match(missOf(withNote(sample("transition"), sample("transition").note.replace(/seqAt=\d+/, "seqAt=x"))), /^transition: bad time seqAt=x/);
  assert.match(missOf(withNote(sample("transition"), sample("transition").note.replace(/ via=\S+/, ""))), /^transition: missing token via=/);
  assert.match(missOf(withNote(sample("transition"), sample("transition").note.replace("to=queued", "to=nowhere"))), /to_state is not valid/);
  assert.match(missOf(withNote(sample("test_weakened"), "step=none commit=abcdef0 restored=yes kinds=none files=a.js")), /^test_weakened: kinds is not valid/);
  assert.match(missOf({ ...sample("ready"), ts: "yesterday" }), /^ready: bad time ts=/);
  assert.match(missOf({ ...sample("ready"), issue: null }), /^ready: ready needs an issue/);
  assert.match(missOf({ ...sample("reviewed"), pr: null }), /^reviewed: pr is not valid/);
  assert.match(missOf({ ...sample("merged"), head: "NOT-HEX" }), /^merged: head is not valid/);
  assert.match(missOf(withNote(sample("verdict", (l) => /^CORRECT/.test(l.note)), "MAYBE: r1-1 text")), /^verdict: note matches no verdict shape/);
  assert.match(missOf(withNote(sample("untrusted_stripped"), "somewhere else")), /^untrusted_stripped: note matches no untrusted_stripped shape/);
  assert.match(missOf(withNote(sample("abandoned"), "reason=reconcile outcome=maybe stage=queued pr=none checked=x")), /^abandoned: abandoned outcome=maybe/);
  assert.match(missOf(withNote(sample("abandoned"), "reason=mystery note=x")), /^abandoned: abandoned reason=mystery/);
  assert.match(missOf("{not json"), /^\?: the line is not JSON/);
  assert.match(missOf("[1]"), /^\?: the line is not an object/);
  for (const text of ["claim_lost-text", "held by x", "race lost"]) assert.match(missOf(withNote({ ...sample("ready"), state: "claim_lost" }, text)), /^claim_lost: note matches no claim_lost shape/);
});

test("a miss is never a partial event: it has no event key at all", () => {
  const r = translate(withNote(sample("transition"), "row=T1 life=x"));
  assert.deepEqual(Object.keys(r), ["miss"]);
});

test("determinism: the same line twice gives deep-equal output, and dual-write opts set ts and session_id exactly", () => {
  const opts = { ts: "2026-10-17T01:02:03.456Z", sessionId: "11111111-2222-3333-4444-555555555555" };
  for (const line of oldLines) {
    assert.deepEqual(translate(line), translate(line));
    assert.deepEqual(translate(JSON.stringify(line)), translate(line), "a string and its parsed object agree");
    const r = translate(line, opts);
    if (r.event === undefined) continue;
    assert.equal(r.event.ts, opts.ts);
    assert.equal(r.event.session_id, opts.sessionId);
    const replay = translate(line).event;
    assert.deepEqual({ ...r.event, ts: 0, session_id: 0 }, { ...replay, ts: 0, session_id: 0 });
    assert.equal(replay.ts, `${line.ts.slice(0, -1)}.000Z`);
    assert.equal(replay.session_id, line.session_id);
    assert.equal(translate(line, { ts: opts.ts }).event.session_id, null);
  }
  assert.match(missOf(sample("ready"), { ts: "2026-10-17T01:02:03Z" }), /ts from the writer is not ISO with milliseconds/);
});

test("the module reads no clock, environment, file or network in translate", () => {
  const src = fs.readFileSync(MODULE, "utf8");
  const body = src.slice(0, src.indexOf("// --- the CLI"));
  for (const bad of [/Date\.now/, /new Date\(\)/, /process\.env/, /require\(/, /Math\.random/, /fetch\(/]) assert.doesNotMatch(body, bad);
});

test("parity: the translator's token parse equals the plugin's tokensOf and noteToken on every corpus note", () => {
  const notes = oldLines.map((l) => l.note ?? null);
  notes.push("a=1 a=2 b= =c d none=x", "", null, "x=%ZZ y=%6Eone z=none");
  for (const note of notes) {
    assert.deepEqual([...tokensOf(note)], [...schemaEvents.tokensOf(note)], String(note));
    for (const key of new Set([...schemaEvents.tokensOf(note).keys(), "absent"])) {
      assert.equal(noteToken(note, key), schemaEvents.noteToken(note, key), `${key} of ${String(note)}`);
    }
  }
});

function cli(args, input) {
  const r = spawnSync(process.execPath, [MODULE, ...args], { input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("CLI: the corpus piped through gives expected.jsonl and exit 0, with a summary on stderr", () => {
  const input = fs.readFileSync(path.join(FIXTURES, "old-lines.jsonl"), "utf8");
  const r = cli([], input);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, fs.readFileSync(path.join(FIXTURES, "expected.jsonl"), "utf8"));
  assert.match(r.err, /^summary: transition translated=14 skipped=0 missed=0$/m);
  assert.match(r.err, /^summary: delegated translated=0 skipped=2 missed=0$/m);
  assert.doesNotMatch(r.err, /miss:/);
});

test("CLI: one miss line gives exit 1, one stderr line naming it, and the rest still translate", () => {
  const input = fs.readFileSync(path.join(FIXTURES, "old-lines.jsonl"), "utf8");
  const bad = JSON.stringify({ ...sample("ready"), state: "frobnicated" });
  const r = cli([], `${input}\n${bad}\n`);
  assert.equal(r.code, 1);
  const lines = r.err.split("\n").filter((l) => l.includes("miss:"));
  assert.deepEqual(lines, [`line ${oldLines.length + 2}: miss: frobnicated: unknown state`]);
  assert.match(r.err, /^summary: frobnicated translated=0 skipped=0 missed=1$/m);
  assert.equal(r.out, fs.readFileSync(path.join(FIXTURES, "expected.jsonl"), "utf8"));
});

test("CLI: --ts and --session-id make it dual write", () => {
  const line = JSON.stringify(oldLines.find((l) => l.state === "ready"));
  const r = cli(["--ts", "2026-10-17T01:02:03.456Z", "--session-id", "abc"], `${line}\n`);
  assert.equal(r.code, 0, r.err);
  const e = JSON.parse(r.out);
  assert.equal(e.ts, "2026-10-17T01:02:03.456Z");
  assert.equal(e.session_id, "abc");
  assert.equal(cli(["--nope"], "").code, 2);
});
