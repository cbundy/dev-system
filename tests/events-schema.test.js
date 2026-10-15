// The factory event contract (docs/events.md, cbundy/dev-system#534): the JSON Schemas in
// schemas/events/ against the writer's closed vocabulary (images/base/callum-flow-event), the
// saved examples, the real writer, and the guide's event catalogue. A state added to or removed
// from the writer without its schema, example and catalogue row fails here.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");
const Ajv2020 = require("ajv/dist/2020").default;

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "schemas", "events");
const WRITER = path.join(ROOT, "images", "base", "callum-flow-event");
const GUIDE = path.join(ROOT, "docs", "events.md");
const BASE_ID = "https://raw.githubusercontent.com/cbundy/dev-system/main/schemas/events/";

const rel = (file) => path.relative(DIR, file).split(path.sep).join("/");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

// The writer's vocabulary, from its own STATES= line.
function writerStates() {
  const m = /^STATES="([^"]+)"$/m.exec(fs.readFileSync(WRITER, "utf8"));
  assert.ok(m, "callum-flow-event has a STATES=\"...\" line");
  return m[1].split(/\s+/).sort();
}

const schemaFiles = walk(DIR).filter((f) => f.endsWith(".schema.json")).sort();
const stateFiles = schemaFiles.filter((f) => rel(f).startsWith("states/"));
const payloadFiles = schemaFiles.filter((f) => rel(f).startsWith("data/"));
const exampleFiles = walk(path.join(DIR, "examples")).filter((f) => f.endsWith(".jsonl")).sort();
const stateOf = (file) => path.basename(file).replace(/\.(schema\.json|jsonl)$/, "");
// A retired state keeps its schema, marked `deprecated: true`, so its rows still validate.
const allStates = () => stateFiles.map(stateOf).sort();
const liveStates = () => stateFiles.filter((f) => readJson(f).deprecated !== true).map(stateOf).sort();

let ajv;
let validate;
before(() => {
  ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const f of schemaFiles) ajv.addSchema(readJson(f));
  validate = ajv.getSchema(`${BASE_ID}event.schema.json`);
  assert.ok(validate, "schemas/events/event.schema.json is loaded");
});

const errors = (v) => ajv.errorsText(v.errors, { separator: "\n  " });

// examples: every saved example line, with where it came from.
function examples() {
  return exampleFiles.flatMap((f) =>
    fs.readFileSync(f, "utf8").split("\n").map((line, i) => ({ file: f, at: `${rel(f)}:${i + 1}`, line })).filter((e) => e.line.trim() !== ""),
  );
}

test("every schema file names its own path as $id and is valid draft 2020-12", () => {
  assert.ok(schemaFiles.length > 0);
  for (const f of schemaFiles) {
    const s = readJson(f);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", rel(f));
    assert.equal(s.$id, BASE_ID + rel(f), rel(f));
    assert.equal(typeof s.description, "string", `${rel(f)} has a description`);
  }
});

test("one live state schema per state in callum-flow-event's vocabulary, and no other", () => {
  assert.deepEqual(liveStates(), writerStates(), "the states not marked deprecated are exactly the writer's");
});

test("each state schema pins its state and only narrows envelope fields", () => {
  const envelope = Object.keys(readJson(path.join(DIR, "envelope.v2.schema.json")).properties);
  for (const f of stateFiles) {
    const s = readJson(f);
    const state = stateOf(f);
    assert.equal(s.title, state, rel(f));
    assert.deepEqual(s.properties.state, { const: state }, `${rel(f)} pins state`);
    assert.ok("data" in s.properties, `${rel(f)} says which payloads it accepts (data: false for none)`);
    for (const k of Object.keys(s.properties)) assert.ok(envelope.includes(k), `${rel(f)}: ${k} is no envelope field (a fact of its own belongs in data)`);
    for (const k of ["allOf", "additionalProperties", "unevaluatedProperties"]) assert.equal(s[k], undefined, `${rel(f)}: the envelope is applied by event.schema.json, by version`);
  }
});

// The writer's own per-state rules: the states that may leave out --issue, and superseded's --run.
test("each state schema requires exactly the subject fields callum-flow-event enforces", () => {
  const src = fs.readFileSync(WRITER, "utf8");
  const m = /case "\$state" in\n\s*([a-z_ |]+)\) ;;\n\s*\*\) \[ -n "\$issue" \] \|\| usage "--issue is required/.exec(src);
  assert.ok(m, "callum-flow-event has its `case \"$state\" in <exempt>) ;; *) [ -n \"$issue\" ] || usage ...` rule");
  const exempt = m[1].split("|").map((x) => x.trim());
  const needsRun = [...src.matchAll(/\[ "\$state" != ([a-z_]+) \] \|\| \[ -n "\$run" \]/g)].map((x) => x[1]);
  assert.deepEqual(needsRun, ["superseded"], "the writer requires --run for superseded only");
  for (const state of writerStates()) {
    const p = readJson(path.join(DIR, "states", `${state}.schema.json`)).properties;
    assert.equal(p.issue?.type === "integer", !exempt.includes(state), `${state}: issue required by the schema exactly when the writer requires --issue`);
    assert.equal(p.run_id?.type === "string", needsRun.includes(state), `${state}: run_id required by the schema exactly when the writer requires --run`);
  }
});

test("event.schema.json dispatches every state, retired ones too, to its schema", () => {
  const index = readJson(path.join(DIR, "event.schema.json"));
  const states = allStates();
  assert.deepEqual([...index.properties.state.enum].sort(), states);
  assert.deepEqual(index.allOf[0], {
    if: { properties: { v: { const: 1 } }, required: ["v"] },
    then: { $ref: "envelope.v1.schema.json" },
    else: { $ref: "envelope.v2.schema.json" },
  }, "the envelope is chosen by v");
  const dispatched = index.allOf
    .slice(1)
    .map((b) => {
      const state = b.if.properties.state.const;
      assert.deepEqual(b.then, { $ref: `states/${state}.schema.json` }, `the branch for ${state}`);
      return state;
    });
  assert.deepEqual(dispatched.sort(), states);
});

test("every payload schema is data/<name>/v<N>.schema.json and pins its name and version", () => {
  const versions = new Map();
  for (const f of payloadFiles) {
    const m = /^data\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)\/v([1-9][0-9]*)\.schema\.json$/.exec(rel(f));
    assert.ok(m, `${rel(f)} is named data/<name>/v<N>.schema.json`);
    const [, name, n] = m;
    const s = readJson(f);
    assert.deepEqual(s.properties.schema, { const: name }, `${rel(f)} pins schema`);
    assert.deepEqual(s.properties.version, { const: Number(n) }, `${rel(f)} pins version`);
    assert.ok(s.required.includes("schema") && s.required.includes("version"), `${rel(f)} requires schema and version`);
    versions.set(name, [...(versions.get(name) ?? []), Number(n)]);
  }
  for (const [name, list] of versions) {
    assert.deepEqual(list.sort((a, b) => a - b), list.map((_, i) => i + 1), `${name}: versions run from v1 with none removed`);
  }
});

test("every payload version stays accepted by some state, and has a saved example", () => {
  const refs = new Set();
  for (const f of stateFiles) {
    const text = JSON.stringify(readJson(f).properties.data);
    for (const m of text.matchAll(/"\$ref":"\.\.\/data\/([^"]+)"/g)) refs.add(`data/${m[1]}`);
  }
  const used = new Set(examples().map((e) => JSON.parse(e.line).data).filter(Boolean).map((d) => `data/${d.schema}/v${d.version}.schema.json`));
  for (const f of payloadFiles) {
    assert.ok(refs.has(rel(f)), `${rel(f)} is accepted by a state schema (old versions are never dropped)`);
    assert.ok(used.has(rel(f)), `${rel(f)} has an example in schemas/events/examples/`);
  }
});

test("every state has saved examples, and each one validates", () => {
  assert.deepEqual(exampleFiles.map(stateOf).sort(), allStates(), "one examples/<state>.jsonl per state");
  for (const e of examples()) {
    let ev;
    assert.doesNotThrow(() => (ev = JSON.parse(e.line)), `${e.at} is JSON`);
    assert.equal(ev.state, stateOf(e.file), `${e.at} is a ${stateOf(e.file)} event`);
    assert.ok(validate(ev), `${e.at}:\n  ${errors(validate)}`);
  }
});

// Other suites' event-log fixtures are full lines too: they must be lines a writer could produce.
test("the event-log fixtures of other suites validate", () => {
  const fixtures = ["tests/fixtures/evaluate/events/acme__widgets.jsonl", "tests/fixtures/evaluate/two-device/events.jsonl"];
  for (const f of fixtures) {
    fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (line.trim() === "") return;
      assert.ok(validate(JSON.parse(line)), `${f}:${i + 1}:\n  ${errors(validate)}`);
    });
  }
});

test("the schemas refuse what the contract forbids", () => {
  const good = JSON.parse(fs.readFileSync(path.join(DIR, "examples", "claimed.jsonl"), "utf8").split("\n")[0]);
  const refused = (what, ev) => assert.equal(validate(ev), false, `refuses ${what}`);
  assert.ok(validate(good), errors(validate));
  refused("a state outside the vocabulary", { ...good, state: "claimedd" });
  refused("another envelope version", { ...good, v: 3 });
  refused("a v1 line with v2's version fields", { ...good, v: 1 });
  refused("a top-level key the envelope does not define", { ...good, extra: 1 });
  refused("a missing envelope key", Object.fromEntries(Object.entries(good).filter(([k]) => k !== "head")));
  refused("an empty string for an absent value", { ...good, branch: "" });
  refused("a state's required field left null", { ...good, issue: null });
  refused("a payload on a state that defines none", { ...good, data: { schema: "x", version: 1 } });
  refused("a timestamp with a zone offset", { ...good, ts: "2026-10-15T09:00:00+01:00" });
});

// The writer itself: each example's caller-given fields, passed to the real callum-flow-event,
// give a line that validates and carries those fields back.
let dir;
after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

test("callum-flow-event writes every example as a valid line with the same fields", () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-schema-"));
  const flags = { issue: "--issue", run_id: "--run", branch: "--branch", pr: "--pr", head: "--head", note: "--note", actor: "--actor" };
  for (const e of examples()) {
    const ev = JSON.parse(e.line);
    if (ev.v !== 2) continue; // the writer writes only the current envelope
    if (ev.data !== undefined) continue; // payloads need --data, which the writer does not take yet
    if (!writerStates().includes(ev.state)) continue; // a retired state
    const events = fs.mkdtempSync(path.join(dir, "e-"));
    const argv = [ev.state, "--repo", ev.repo];
    for (const [field, flag] of Object.entries(flags)) if (ev[field] !== null) argv.push(flag, String(ev[field]));
    const r = spawnSync("sh", [WRITER, ...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: events, DEV_MACHINE_NAME: ev.device, CLAUDE_SESSION_ID: "s-1", DEV_VERSIONS_FILE: path.join(events, "none.json") },
    });
    assert.equal(r.status, 0, `${e.at}: exit ${r.status}: ${r.stderr}`);
    const log = path.join(events, ev.repo.replace("/", "__") + ".jsonl");
    assert.ok(fs.existsSync(log), `${e.at}: the writer wrote no line (it needs jq on PATH): ${r.stderr}`);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, `${e.at}: one line written`);
    const out = JSON.parse(lines[0]);
    assert.ok(validate(out), `${e.at}: the writer's line:\n  ${errors(validate)}`);
    for (const field of ["state", ...Object.keys(flags)]) assert.deepEqual(out[field], ev[field], `${e.at}: ${field}`);
  }
});

test("the guide's catalogue has one row per state, and links its schema", () => {
  const text = fs.readFileSync(GUIDE, "utf8");
  const section = /^## Event catalogue\n([\s\S]*?)(?=^## )/m.exec(text);
  assert.ok(section, "docs/events.md has an '## Event catalogue' section followed by another section");
  const rows = [...section[1].matchAll(/^\| \[`([a-z_]+)`\]\(\.\.\/schemas\/events\/states\/([a-z_]+)\.schema\.json\) \|/gm)];
  for (const [, state, file] of rows) assert.equal(file, state, `the ${state} row links its own schema`);
  assert.deepEqual(rows.map((r) => r[1]).sort(), allStates());
});
