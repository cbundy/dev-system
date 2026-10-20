"use strict";

// The native mode of callum-flow-event (`--type`, dev-system#792): the real script into a scratch
// events dir, the event it writes checked strictly against its schema and read back by the shared
// reader (plugins/factory-loop/hooks/v2/event-reader.ts). Also the refusals, the unchecked writes of
// an unknown type or version, and the degraded paths.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension; plain Node needs the ".ts".
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
const EVENT = path.join(ROOT, "images", "base", "callum-flow-event");
const SHAPES = path.join(ROOT, "images", "base", "factory-event-shapes.json");
const SCHEMAS_DIR = path.join(ROOT, "docs", "factory-events", "schemas");
const READER_REL = path.join("plugins", "factory-loop", "hooks", "v2", "event-reader.ts");
const { run: buildDocs } = require(path.join(ROOT, "scripts", "build-event-docs.js"));

let reader;
let tmp;
let n = 0;

before(async () => {
  reader = await import(path.join(ROOT, READER_REL));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-event-native-"));
});
after(() => {
  if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
});

const VERSIONS = { base_image: "1.2.3", dev_image: "4.5.6", template_version: "7.8.9", plugin_version: "0.1.2", extra: 1 };

// native: run the real script with a fresh scratch events dir; { r, dir, lines, old }.
function native(args, { env = {}, shapes = SHAPES } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `d${n++}-`));
  const versions = path.join(dir, "versions.json");
  fs.writeFileSync(versions, JSON.stringify(VERSIONS));
  const r = spawnSync("/bin/sh", [EVENT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box",
      DEV_VERSIONS_FILE: versions, CALLUM_EVENT_SHAPES: shapes, ...env,
    },
  });
  const fdir = path.join(dir, "factory");
  const lines = fs.existsSync(fdir) ? fs.readdirSync(fdir).flatMap((f) => fs.readFileSync(path.join(fdir, f), "utf8").split("\n").filter(Boolean)) : [];
  const old = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return { r, dir, lines, old };
}

const claimed = ["--type", "claimed", "--issue", "7", "--data", '{"lease_minutes":30}'];

test("a known type is written as one envelope-v1 line to the new log only, and reads back", () => {
  const { r, dir, lines, old } = native(claimed);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(lines.length, 1);
  assert.deepEqual(old, [], "nothing goes to the old log");
  assert.ok(fs.existsSync(path.join(dir, ".wake")));
  assert.equal(fs.statSync(path.join(dir, "factory")).mode & 0o777, 0o700);
  const e = JSON.parse(lines[0]);
  assert.deepEqual(reader.validateStrict("envelope", 1, e), []);
  assert.deepEqual(reader.validateStrict("claimed", 1, e.data), []);
  assert.deepEqual(reader.readEvent(e), { type: "claimed", type_version: 1, data: { lease_minutes: 30, title: null, labels: null, parent: null, score: null, factors: null } });
  assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(e.session_id, null);
  assert.equal(e.issue, 7);
  assert.equal(e.repo, "cbundy/dev-system");
  assert.equal(e.device, "box");
  assert.equal(e.actor, "agent");
  assert.equal(e.type_version, 1);
  assert.deepEqual([e.base_image, e.dev_image, e.template_version, e.plugin_version], ["1.2.3", "4.5.6", "7.8.9", "0.1.2"]);
});

test("the session comes from CLAUDE_CODE_SESSION_ID, and CLAUDE_SESSION_ID wins over it", () => {
  const only = native(claimed, { env: { CLAUDE_CODE_SESSION_ID: "sess-c" } });
  assert.equal(only.r.status, 0, only.r.stderr);
  assert.equal(JSON.parse(only.lines.join("")).session_id, "sess-c");
  const both = native(claimed, { env: { CLAUDE_CODE_SESSION_ID: "sess-c", CLAUDE_SESSION_ID: "sess" } });
  assert.equal(JSON.parse(both.lines.join("")).session_id, "sess");
});

test("the options, the session and the uuid source are used", () => {
  const uuid = path.join(tmp, "uuid");
  fs.writeFileSync(uuid, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\n");
  const { r, dir, lines } = native([...claimed, "--actor", "me", "--repo", "o/r"], { env: { CLAUDE_SESSION_ID: "sess", CALLUM_EVENT_UUID_SOURCE: uuid } });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(lines.join(""));
  assert.equal(e.actor, "me");
  assert.equal(e.session_id, "sess");
  assert.equal(e.event_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(e.repo, "o/r");
  assert.ok(fs.existsSync(path.join(dir, "factory", "o__r.jsonl")));
});

test("without a kernel uuid source the event still gets a valid id", () => {
  const { r, lines } = native(claimed, { env: { CALLUM_EVENT_UUID_SOURCE: path.join(tmp, "missing") } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(reader.validateStrict("envelope", 1, JSON.parse(lines[0])), []);
});

test("every schema's own example goes through the CLI and reads back (the producer fixtures)", () => {
  const shapes = JSON.parse(fs.readFileSync(SHAPES, "utf8"));
  for (const type of Object.keys(shapes.current)) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, `${type}.v${shapes.current[type]}.json`), "utf8"));
    const data = schema.examples[0];
    const { r, lines } = native(["--type", type, "--issue", "3", "--data", JSON.stringify(data)]);
    assert.equal(r.status, 0, `${type}: ${r.stderr}`);
    assert.equal(r.stderr, "", type);
    const e = JSON.parse(lines[0]);
    assert.deepEqual(reader.validateStrict(type, e.type_version, e.data), [], type);
    assert.deepEqual(reader.readEvent(e).data, { ...Object.fromEntries(Object.keys(schema.properties).map((k) => [k, null])), ...data }, type);
  }
});

test("loop_entry: the startup migrate's fields (dev-system#888) are written and validate; an entry without them still does, with the fields read as null", () => {
  const example = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "loop_entry.v1.json"), "utf8")).examples[0];
  const migrate = {
    kind: "task", key: "task:migrate:9", status: "failed", attempts: 1, class: "free", rule: "dev-init",
    started_at: "2026-10-19T01:02:03.456Z", ended_at: "2026-10-19T01:02:04.456Z", agent_id: "box", wake: "migrate",
    database: "fdb", from_version: null, to_version: 9, duration_ms: 1000, outcome: "failed", error: "boom",
  };
  for (const data of [migrate, example]) {
    const { r, lines } = native(["--type", "loop_entry", "--data", JSON.stringify(data)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const e = JSON.parse(lines[0]);
    assert.deepEqual(reader.validateStrict("loop_entry", 1, e.data), []);
    assert.equal(reader.readEvent(e).data.outcome ?? null, data.outcome ?? null);
    assert.equal(reader.readEvent(e).data.database ?? null, data.database ?? null);
  }
  assert.notDeepEqual(reader.validateStrict("loop_entry", 1, { ...migrate, outcome: "exploded" }), []);
});

test("wind_down: a full event is written with no warning and validates; bad ones fail strictly or exit 2", () => {
  const good = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "wind_down.v1.json"), "utf8")).examples[0];
  const write = (data) => native(["--type", "wind_down", "--data", JSON.stringify(data)]);
  const { r, lines } = write(good);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const e = JSON.parse(lines[0]);
  assert.equal(e.issue, null);
  assert.deepEqual(reader.validateStrict("wind_down", 1, e.data), []);
  assert.deepEqual(reader.readEvent(e).data, good);
  const bad = (data) => reader.validateStrict("wind_down", 1, data);
  assert.notDeepEqual(bad({ ...good, outcome: "drain" }), []);
  const { cut_at_stop: _omit, ...noCut } = good;
  assert.notDeepEqual(bad(noCut), []);
  assert.notDeepEqual(bad({ ...good, cut_at_stop_keys: ["not-a-key"] }), []);
  assert.deepEqual(bad({ ...good, trigger: null }), []);
  const missing = write(noCut);
  assert.equal(missing.r.status, 2, missing.r.stderr);
  assert.deepEqual(missing.lines, []);
});

test("main_state: a full event is written and validates; one without green is refused with exit 2", () => {
  const good = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "main_state.v1.json"), "utf8")).examples[1];
  const { r, lines } = native(["--type", "main_state", "--data", JSON.stringify(good)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(reader.validateStrict("main_state", 1, JSON.parse(lines[0]).data), []);
  const { green: _omit, ...noGreen } = good;
  const missing = native(["--type", "main_state", "--data", JSON.stringify(noGreen)]);
  assert.equal(missing.r.status, 2, missing.r.stderr);
  assert.match(missing.r.stderr, /main_state v1: field green is missing/);
  assert.deepEqual(missing.lines, []);
});

test("settings_changed: a full event is written and validates; one without who is refused with exit 2", () => {
  const good = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "settings_changed.v1.json"), "utf8")).examples[0];
  const { r, lines } = native(["--type", "settings_changed", "--data", JSON.stringify(good)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(reader.validateStrict("settings_changed", 1, JSON.parse(lines[0]).data), []);
  const { who: _omit, ...noWho } = good;
  const missing = native(["--type", "settings_changed", "--data", JSON.stringify(noWho)]);
  assert.equal(missing.r.status, 2, missing.r.stderr);
  assert.match(missing.r.stderr, /settings_changed v1: field who is missing/);
  assert.deepEqual(missing.lines, []);
});

test("queue_snapshot: a full event is written and validates; one without taken_at is refused with exit 2; a 51st candidate fails strict validation", () => {
  const good = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "queue_snapshot.v1.json"), "utf8")).examples[0];
  const { r, lines } = native(["--type", "queue_snapshot", "--data", JSON.stringify(good)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(reader.validateStrict("queue_snapshot", 1, JSON.parse(lines[0]).data), []);
  const { taken_at: _omit, ...noTaken } = good;
  const missing = native(["--type", "queue_snapshot", "--data", JSON.stringify(noTaken)]);
  assert.equal(missing.r.status, 2, missing.r.stderr);
  assert.match(missing.r.stderr, /queue_snapshot v1: field taken_at is missing/);
  assert.deepEqual(missing.lines, []);
  const many = Array.from({ length: 51 }, (_, i) => ({ issue: i + 1, rank: i + 1, score: 0, factors: [], claimable: true, why: null }));
  const over = native(["--type", "queue_snapshot", "--data", JSON.stringify({ ...good, considered: 51, candidates: many })]);
  // the native writer checks required fields and JSON types only; the bounds are the strict reader's
  assert.equal(over.r.status, 0, over.r.stderr);
  assert.ok(reader.validateStrict("queue_snapshot", 1, JSON.parse(over.lines[0]).data).some((p) => /candidates.*at most 50 items/.test(p)));
});

test("intake_stamp: a full event is written and validates; one without version is refused with exit 2; an outcome outside the enum fails strict validation", () => {
  const good = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "intake_stamp.v1.json"), "utf8")).examples[0];
  const { r, lines } = native(["--type", "intake_stamp", "--issue", "7", "--data", JSON.stringify(good)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(reader.validateStrict("intake_stamp", 1, JSON.parse(lines[0]).data), []);
  const { version: _omit, ...noVersion } = good;
  const missing = native(["--type", "intake_stamp", "--issue", "7", "--data", JSON.stringify(noVersion)]);
  assert.equal(missing.r.status, 2, missing.r.stderr);
  assert.match(missing.r.stderr, /intake_stamp v1: field version is missing/);
  assert.deepEqual(missing.lines, []);
  assert.notDeepEqual(reader.validateStrict("intake_stamp", 1, { ...good, outcome: "maybe" }), []);
});

test("a type that is a schema file only is written and read with no warning", () => {
  const root = path.join(tmp, "probe-root");
  fs.cpSync(SCHEMAS_DIR, path.join(root, "docs", "factory-events", "schemas"), { recursive: true });
  fs.mkdirSync(path.join(root, "plugins", "factory-loop", "hooks", "v2"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, READER_REL), path.join(root, READER_REL));
  fs.writeFileSync(
    path.join(root, "docs", "factory-events", "schemas", "probe.v1.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema", $id: "probe.v1.json", title: "probe",
      description: "A probe event. Count one per (issue, seq).", "x-issue": "optional", type: "object", additionalProperties: false,
      required: ["word"], properties: { word: { type: "string", description: "A word." }, count: { type: ["integer", "null"], description: "A count." } },
      examples: [{ word: "hi", count: null }],
    }),
  );
  assert.deepEqual(buildDocs({ root, log: () => {} }), []);
  const shapesPath = path.join(root, "images", "base", "factory-event-shapes.json");
  const shapes = JSON.parse(fs.readFileSync(shapesPath, "utf8"));
  assert.equal(shapes.current.probe, 1);
  const { r, lines } = native(["--type", "probe", "--data", '{"word":"hi","count":2}'], { shapes: shapesPath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const e = JSON.parse(lines[0]);
  assert.equal(e.issue, null);
  const rd = reader.createReader(shapes.schemas, shapes.current, {});
  assert.deepEqual(rd.validateStrict("probe", 1, e.data), []);
  assert.deepEqual(rd.readEvent(e).data, { word: "hi", count: 2 });
});

const REFUSED = [
  ["a required field missing", ["--type", "claimed", "--issue", "7", "--data", "{}"], /claimed v1: field lease_minutes is missing/],
  ["a required field of the wrong type", ["--type", "claimed", "--issue", "7", "--data", '{"lease_minutes":"x"}'], /claimed v1: field lease_minutes must be integer, got string/],
  ["a float for an integer", ["--type", "claimed", "--issue", "7", "--data", '{"lease_minutes":1.5}'], /field lease_minutes must be integer/],
  ["an x-issue required type without --issue", ["--type", "claimed", "--data", '{"lease_minutes":30}'], /claimed v1: --issue is required/],
  ["data that is not JSON", ["--type", "claimed", "--issue", "7", "--data", "{nope"], /claimed: --data is not JSON/],
  ["data that is an array", ["--type", "claimed", "--issue", "7", "--data", "[1]"], /--data must be a JSON object/],
  ["no data", ["--type", "claimed", "--issue", "7"], /--data is required/],
  ["a non-numeric issue", ["--type", "claimed", "--issue", "x", "--data", '{"lease_minutes":30}'], /--issue must be a positive integer/],
  ["a zero issue", ["--type", "claimed", "--issue", "0", "--data", '{"lease_minutes":30}'], /--issue must be a positive integer/],
  ["a non-numeric type version", [...claimed, "--type-version", "1x"], /--type-version must be a positive integer/],
  ["a bad type name", ["--type", "Bad-Type", "--data", "{}"], /--type must match/],
  ["an unknown option", [...claimed, "--bogus", "1"], /unknown option '--bogus'/],
];
for (const [name, args, want] of REFUSED) {
  test(`refused with exit 2 and nothing written: ${name}`, () => {
    const { r, dir, lines, old } = native(args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, want);
    assert.match(r.stderr, /^callum-flow-event:/);
    assert.equal(r.stderr.trim().split("\n").length, 1, "one line");
    assert.deepEqual(lines, []);
    assert.deepEqual(old, []);
    assert.equal(fs.existsSync(path.join(dir, ".wake")), false);
  });
}

test("an unknown type, and an unknown version of a known type, are written with one warning", () => {
  for (const [args, label] of [
    [["--type", "mystery", "--data", '{"a":1}'], "mystery v1"],
    [[...claimed, "--type-version", "9"], "claimed v9"],
  ]) {
    const { r, lines } = native(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, `callum-flow-event: warning: unknown factory event: ${label} - written unchecked\n`);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).type_version, Number(label.split(" v")[1]));
  }
});

test("a missing shapes file writes unchecked with one warning", () => {
  const { r, lines } = native(["--type", "claimed", "--data", "{}"], { shapes: path.join(tmp, "nope.json") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /warning: factory-event-shapes\.json not readable .* written unchecked/);
  assert.equal(lines.length, 1);
});

test("without node it warns, writes nothing and exits 0", () => {
  const bin = path.join(tmp, "bin-no-node");
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ["dirname", "hostname", "head", "tr", "cat", "mkdir", "chmod", "touch", "sed", "git", "basename"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found && !fs.existsSync(path.join(bin, tool))) fs.symlinkSync(found, path.join(bin, tool));
  }
  const { r, lines, old } = native(claimed, { env: { PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: node not found/);
  assert.deepEqual(lines, []);
  assert.deepEqual(old, []);
});

test("a log that cannot be written warns and exits 0", () => {
  const { r, dir } = native(claimed, { env: { CALLUM_EVENTS_DIR: "/dev/null/events" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: cannot write .* event not recorded/);
  assert.ok(dir);
});

test("prompt_denied and prompt_waiting: the companion's own data goes through the native mode and reads back (dev-system#1037)", async () => {
  const { promptData } = await import(path.join(ROOT, "plugins", "factory-loop-workspace", "hooks", "prompt.ts"));
  const facts = {
    life: "ss1x2k", seq: 7, step: "build", attempt: 1, agent: "agent-1", agent_type: "factory-loop:builder", tool: "Bash",
    slot: "/slot", session: "s1", transcript: "/t.jsonl", why: "rm of a glob", input: "rm -f $D/*", branch: "issue-571", pr: 612,
  };
  for (const type of ["prompt_denied", "prompt_waiting"]) {
    for (const f of [facts, {}]) {
      const data = promptData(type, f);
      const { r, lines } = native(["--type", type, "--issue", "571", "--repo", "o/r", "--data", JSON.stringify(data)]);
      assert.equal(r.status, 0, `${type}: ${r.stderr}`);
      assert.equal(r.stderr, "", type);
      const e = JSON.parse(lines[0]);
      assert.equal(e.type, type);
      assert.equal(e.issue, 571);
      assert.deepEqual(reader.validateStrict(type, e.type_version, e.data), [], type);
      assert.deepEqual(reader.readEvent(e).data, data, type);
    }
  }
});

test("usage: a spend reading is written with no warning through --data and --note; a string spend_usd is refused (dev-system#1114)", () => {
  const spend = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "usage.v1.json"), "utf8")).examples[1];
  const { r, lines } = native(["--type", "usage", "--data", JSON.stringify(spend)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const e = JSON.parse(lines[0]);
  assert.deepEqual(reader.validateStrict("usage", 1, e.data), []);
  assert.deepEqual(reader.readEvent(e).data, spend);
  const bad = native(["--type", "usage", "--data", JSON.stringify({ ...spend, spend_usd: "42.5" })]);
  assert.equal(bad.r.status, 2, bad.r.stderr);
  assert.deepEqual(bad.lines, []);
  const viaNote = native(["usage", "--note", "auth=api-key spend_usd=42.5 budget_usd=100 budget_resets_at=2026-11-01T00:00:00.000Z source=spend"], { env: { HOME: tmp } });
  assert.equal(viaNote.r.status, 0, viaNote.r.stderr);
  const events = viaNote.lines.map((l) => JSON.parse(l)).filter((x) => x.type === "usage");
  assert.equal(events.length, 1, "the note is dual-written as a usage event");
  assert.equal(events[0].data.spend_usd, 42.5);
  assert.deepEqual(reader.validateStrict("usage", 1, events[0].data), []);
});

// The tools write the new events natively (dev-system#1140): for every call shape a tool makes, the
// type and data are what translate() makes from the old-state line the tool used to write, so no
// reader of the new store can tell the difference. tests/fixtures/factory-events/tool-calls.json holds
// each shape: the old line, and the native call as the tool now makes it (for usage, the data comes
// from the real `usage-check.sh --to-data`). The shell suites of the tools assert the same data
// from the tools themselves.
const TRANSLATE = require(path.join(ROOT, "images", "base", "factory-event-translate.js"));
const USAGE_CHECK = path.join(ROOT, "features", "src", "callum-tools", "usage-check.sh");
const TOOL_CALLS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "factory-events", "tool-calls.json"), "utf8"));

function oldLine(old) {
  return {
    v: 2, ts: "2026-10-20T12:00:00Z", repo: "cbundy/dev-system", device: "box", session_id: null, actor: "agent", issue: null,
    run_id: null, branch: null, pr: null, head: null, note: null, event_id: "c2ceb199-8eed-4bc9-a308-37482c6234f5",
    base_image: null, dev_image: null, template_version: null, plugin_version: null, ...old,
  };
}

test("every tool call shape makes the type and data translate() makes from the old line it used to write", () => {
  assert.ok(TOOL_CALLS.length >= 30, "the fixture covers every tool");
  for (const c of TOOL_CALLS) {
    const t = TRANSLATE.translate(oldLine(c.old), c.old_data === undefined ? undefined : { data: c.old_data, ts: null, sessionId: null });
    assert.ok(t.event, `${c.tool}: the old line translates: ${JSON.stringify(t)}`);
    let nativeCall = c.native;
    if (nativeCall === undefined) {
      const r = spawnSync("/bin/sh", [USAGE_CHECK, "--to-data"], { encoding: "utf8", input: `${c.old.note}\n`, env: { PATH: process.env.PATH, HOME: tmp } });
      assert.equal(r.status, 0, `${c.tool}: ${r.stderr}`);
      nativeCall = { type: "usage", data: JSON.parse(r.stdout) };
    }
    assert.equal(nativeCall.type, t.event.type, c.tool);
    assert.deepEqual(nativeCall.data, t.event.data, c.tool);
    // the real writer takes the native call, validates it strictly and writes that type and data
    const args = ["--type", nativeCall.type, "--data", JSON.stringify(nativeCall.data)];
    if (c.old.issue !== undefined) args.push("--issue", String(c.old.issue));
    if (c.old.actor !== undefined) args.push("--actor", c.old.actor);
    const { r, lines, old } = native(args);
    assert.equal(r.status, 0, `${c.tool}: ${r.stderr}`);
    assert.equal(r.stderr, "", c.tool);
    assert.deepEqual(old, [], `${c.tool}: nothing goes to the old log`);
    assert.equal(lines.length, 1, c.tool);
    const e = JSON.parse(lines[0]);
    assert.equal(e.type, t.event.type, c.tool);
    assert.deepEqual(e.data, t.event.data, c.tool);
    assert.equal(e.issue, t.event.issue, c.tool);
    assert.equal(e.actor, t.event.actor, c.tool);
  }
});

test("the old-state lines of the tools that stopped logging make no new event", () => {
  // design_routed (callum-flow-design-route), superseded (callum-flow-regate) and the pipeline watcher's states
  // (parked, merge_ready, ci_stalled, head_mismatch, conflict, failed, watcher_error) are skipped by name
  for (const state of ["design_routed", "superseded", "parked", "merge_ready", "ci_stalled", "head_mismatch", "conflict", "failed", "watcher_error"]) {
    const t = TRANSLATE.translate(oldLine({ state, issue: 7, note: "x" }));
    assert.deepEqual(t, { skip: state }, state);
  }
  // a dependency strip of the issue reader is a miss, not an event
  const t = TRANSLATE.translate(oldLine({ state: "untrusted_stripped", issue: 7, note: "dependencies=3" }));
  assert.ok(t.miss, JSON.stringify(t));
});
