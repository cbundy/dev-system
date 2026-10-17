// The shared event reader (plugins/factory-loop/hooks/v2/event-reader.ts, dev-system#691): every
// example in docs/factory-events/schemas/ is valid strictly and through the reader, the reader
// refuses what it must, upgrades older versions, and the strict validator catches each keyword.
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (tests/factory-loop-v2-events.test.js does the same).
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
const SCHEMAS = path.join(ROOT, "docs", "factory-events", "schemas");
const READER = path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "event-reader.ts");

let reader;
before(async () => {
  reader = await import(READER);
});

const files = fs.readdirSync(SCHEMAS).filter((f) => /^[a-z_]+\.v\d+\.json$/.test(f));
const load = (f) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, f), "utf-8"));

test("every example of every schema passes validateStrict against its own version", () => {
  assert.ok(files.length > 10);
  for (const f of files) {
    const [, type, version] = /^([a-z_]+)\.v(\d+)\.json$/.exec(f);
    for (const ex of load(f).examples) {
      assert.deepEqual(reader.validateStrict(type, Number(version), ex), [], `${f}: ${JSON.stringify(ex)}`);
    }
  }
});

test("every event example comes back from readEvent valid against its type's current version", () => {
  for (const f of files) {
    const [, type, version] = /^([a-z_]+)\.v(\d+)\.json$/.exec(f);
    if (type === "envelope") continue;
    for (const ex of load(f).examples) {
      const got = reader.readEvent({ type, type_version: Number(version), data: ex });
      assert.equal(got.type, type);
      assert.equal(got.type_version, Number(version));
      assert.deepEqual(reader.validateStrict(type, got.type_version, got.data), [], f);
      // An optional field an example leaves out comes back as null; every other field is unchanged.
      const optional = Object.keys(load(f).properties).filter((k) => !load(f).required.includes(k) && !(k in ex));
      assert.deepEqual(got.data, { ...ex, ...Object.fromEntries(optional.map((k) => [k, null])) }, `${f}: nothing else changes`);
    }
  }
});

test("the envelope example passes validateStrict and readEvent takes the whole envelope", () => {
  const env = load("envelope.v1.json").examples[0];
  assert.deepEqual(reader.validateStrict("envelope", 1, env), []);
  assert.deepEqual(reader.readEvent(env), { type: "claimed", type_version: 1, data: { lease_minutes: 120 } });
});

test("readEvent refuses an unknown envelope, type and version with the exact message", () => {
  const env = load("envelope.v1.json").examples[0];
  assert.throws(() => reader.readEvent({ ...env, envelope: 2 }), /unknown factory event envelope: 2/);
  assert.throws(() => reader.readEvent({ type: "transition", type_version: 3, data: {} }), { message: "unknown factory event: transition v3" });
  assert.throws(() => reader.readEvent({ type: "nope", type_version: 1, data: {} }), { message: "unknown factory event: nope v1" });
  assert.throws(() => reader.readEvent({ type: "envelope", type_version: 1, data: {} }), { message: "unknown factory event: envelope v1" });
  assert.throws(() => reader.readEvent({ type: "claimed", type_version: "1", data: {} }), /unknown factory event: claimed v1/);
});

test("readEvent names the type, version and field of a missing or mistyped required field", () => {
  assert.throws(() => reader.readEvent({ type: "claimed", type_version: 1, data: {} }), /claimed v1: field lease_minutes is missing/);
  assert.throws(() => reader.readEvent({ type: "claimed", type_version: 1, data: { lease_minutes: "2" } }), /claimed v1: field lease_minutes must be integer, got string/);
  assert.throws(() => reader.readEvent({ type: "claimed", type_version: 1, data: { lease_minutes: 1.5 } }), /field lease_minutes must be integer/);
});

test("readEvent gives the optional merged size fields as null for a payload without them", () => {
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs/factory-events/schemas/merged.v1.json"), "utf8")).examples[0];
  const got = reader.readEvent({ type: "merged", type_version: 1, data: old });
  assert.equal(got.data.files, null);
  assert.equal(got.data.additions, null);
  assert.equal(got.data.deletions, null);
});

test("validateStrict rejects a bad merged files, additions or deletions", () => {
  const base = { pr: 1, branch: "b", head: "f94eb46", by: "factory", recovered: false };
  const strict = (extra) => reader.validateStrict("merged", 1, { ...base, ...extra });
  assert.deepEqual(strict({ files: null, additions: null, deletions: null }), []);
  assert.deepEqual(strict({}), []);
  for (const extra of [{ additions: -1 }, { deletions: 1.5 }, { files: [1] }, { files: [""] }, { files: "a.js" }]) {
    assert.notDeepEqual(strict(extra), [], JSON.stringify(extra));
  }
});

const shape2 = {
  v1: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "integer" }, old: { type: ["string", "null"] } } },
  v2: { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: { type: "integer" }, b: { type: "string" }, c: { type: ["string", "null"] } } },
};

test("readEvent drops unknown fields, and an absent optional field comes back as null", () => {
  const got = reader.readEvent({ type: "claimed", type_version: 1, data: { lease_minutes: 5, extra: true } });
  assert.deepEqual(got.data, { lease_minutes: 5 });
  // No real type has an optional field yet: the synthetic catalogue below gives one.
  const r = reader.createReader({ "t.v1": shape2.v2 }, { t: 1 }, {});
  assert.deepEqual(r.readEvent({ type: "t", type_version: 1, data: { a: 1, b: "x" } }).data, { a: 1, b: "x", c: null });
});

test("a synthetic two-version catalogue upgrades a v1 event to v2", () => {
  const upgrade = reader.createReader({ "t.v1": shape2.v1, "t.v2": shape2.v2 }, { t: 2 }, { "t.v1": (d) => ({ a: d.a, b: `was ${d.a}` }) });
  const got = upgrade.readEvent({ type: "t", type_version: 1, data: { a: 7, junk: 1 } });
  assert.deepEqual(got, { type: "t", type_version: 2, data: { a: 7, b: "was 7", c: null } });
  assert.deepEqual(upgrade.readEvent({ type: "t", type_version: 2, data: { a: 1, b: "x" } }).data, { a: 1, b: "x", c: null });
  const noStep = reader.createReader({ "t.v1": shape2.v1, "t.v2": shape2.v2 }, { t: 2 }, {});
  assert.throws(() => noStep.readEvent({ type: "t", type_version: 1, data: { a: 1 } }), /t v1: no upgrade step from v1 to v2/);
});

test("the real catalogue has no upgrade steps yet", () => {
  assert.deepEqual(reader.UPGRADES, {});
});

test("validateStrict catches a violation of each supported keyword and an unknown field", () => {
  const prop = (p, extra = {}) => ({ "x.v1": { type: "object", additionalProperties: false, required: ["v"], properties: { v: p }, ...extra } });
  const check = (p, value) => reader.createReader(prop(p), { x: 1 }, {}).validateStrict("x", 1, { v: value });
  const bad = (p, value, re) => {
    const got = check(p, value);
    assert.ok(got.some((l) => re.test(l)), `${JSON.stringify(p)} ${JSON.stringify(value)}: ${got.join("; ")}`);
  };
  const ok = (p, value) => assert.deepEqual(check(p, value), []);

  bad({ type: "string" }, 1, /v: must be string/);
  bad({ type: "integer" }, 1.5, /must be integer/);
  bad({ type: "string" }, null, /must be string, got null/);
  ok({ type: ["string", "null"] }, null);
  bad({ enum: ["a", null] }, "b", /v: must be one of "a", null/);
  bad({ const: 1 }, 2, /must be 1/);
  bad({ type: "string", pattern: "^a+$" }, "b", /must match/);
  bad({ type: "integer", minimum: 2 }, 1, /at least 2/);
  bad({ type: "integer", maximum: 2 }, 3, /at most 2/);
  bad({ type: "string", minLength: 2 }, "a", /at least 2 characters/);
  bad({ type: "string", maxLength: 2 }, "abc", /at most 2 characters/);
  bad({ type: "array", minItems: 2 }, [1], /at least 2 items/);
  bad({ type: "array", maxItems: 1 }, [1, 2], /at most 1 items/);
  bad({ type: "array", items: { type: "string" } }, ["a", 1], /v\[1\]: must be string/);
  bad({ type: "string", format: "date-time" }, "yesterday", /date-time/);
  bad({ type: "string", format: "date-time" }, "2026-13-45T99:00:00Z", /date-time/);
  ok({ type: "string", format: "date-time" }, "2026-10-16T15:59:06.252Z");
  ok({ type: "integer", minimum: 1, maximum: 3 }, 3);

  const r = reader.createReader(prop({ type: "string" }), { x: 1 }, {});
  assert.deepEqual(r.validateStrict("x", 1, { v: "a", extra: 1 }), ["extra: unknown field"]);
  assert.deepEqual(r.validateStrict("x", 1, {}), ["v: is required"]);
  assert.deepEqual(r.validateStrict("x", 2, {}), ["unknown factory event: x v2"]);
});
