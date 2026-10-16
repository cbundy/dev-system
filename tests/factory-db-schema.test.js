// The factory database schema against a real PostgreSQL (cbundy/dev-system#646): the event_log
// view versus the event schema files (docs/factory-events/schemas/*.v1.json), and a round trip
// through event_store. Each test makes its own database (tests/lib/factory-db.js).
// The bootstrap's own behaviour is in images/base/test/factory-db-bootstrap.test.sh.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const SCHEMAS = path.join(__dirname, "..", "docs", "factory-events", "schemas");
const schemaFiles = fs.readdirSync(SCHEMAS).filter((f) => f.endsWith(".v1.json") && f !== "envelope.v1.json").sort();
const load = (f) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, f), "utf8"));
const envelope = load("envelope.v1.json");

// The view's lifted columns: every field marked "x-column": true, once by name.
const lifted = new Set();
for (const f of schemaFiles) {
  for (const [field, def] of Object.entries(load(f).properties)) if (def["x-column"] === true) lifted.add(field);
}
const INTS = new Set(["pr", "seq", "round", "attempt"]);
const TIMES = new Set(["seq_at", "state_since"]);

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

test("event_log has the envelope columns, device_seq and each x-column field", opts, (t) => {
  const db = createDb(t);
  const have = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_log' ORDER BY ordinal_position").split("\n");
  const want = [...Object.keys(envelope.properties).filter((k) => k !== "data"), "device_seq", ...lifted];
  assert.deepEqual([...have].sort(), [...want].sort(), "a schema that lifts a field needs a view migration");
  assert.equal(new Set(have).size, have.length);
  const types = Object.fromEntries(db.query("SELECT column_name || ' ' || data_type FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_log'").split("\n").map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
  for (const col of lifted) {
    const type = INTS.has(col) ? "integer" : TIMES.has(col) ? "timestamp with time zone" : "text";
    assert.equal(types[col], type, `event_log.${col}`);
  }
  assert.equal(types.ts, "timestamp with time zone");
  assert.equal(types.issue, "integer");
  assert.equal(types.device_seq, "bigint");
});

test("event_store holds every column event_log shows, plus data", opts, (t) => {
  const db = createDb(t);
  const store = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_store'").split("\n");
  for (const col of Object.keys(envelope.properties)) assert.ok(store.includes(col), `event_store.${col}`);
  assert.ok(store.includes("device_seq"));
  assert.equal(db.query("SELECT pg_get_viewdef('factory.event_log'::regclass) ~ '(@>|DISTINCT ON)'"), "f");
});

test("every schema example round-trips through event_store and event_log", opts, (t) => {
  const db = createDb(t);
  const rows = [];
  let seq = 0;
  for (const f of schemaFiles) {
    const schema = load(f);
    const type = f.replace(".v1.json", "");
    for (const data of schema.examples) {
      const id = crypto.randomUUID();
      seq += 1;
      const issue = schema["x-issue"] === "none" ? "NULL" : "7";
      db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, session_id, issue, device_seq, data)
        VALUES (1, '${id}', '2026-10-16T15:45:19.123Z', '${type}', 1, 'o/r', 'dev', 'agent', NULL, ${issue}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
      rows.push({ id, type, schema, data, seq });
    }
  }
  assert.ok(rows.length >= schemaFiles.length, "every schema has an example");
  for (const { id, type, schema, data, seq: deviceSeq } of rows) {
    const row = JSON.parse(db.query(`SELECT row_to_json(e) FROM factory.event_log e WHERE event_id = '${id}'`, "reader"));
    assert.equal(row.type, type);
    assert.equal(row.device_seq, deviceSeq);
    assert.equal(Date.parse(row.ts), Date.parse("2026-10-16T15:45:19.123Z"));
    const stored = JSON.parse(db.query(`SELECT data FROM factory.event_store WHERE event_id = '${id}'`));
    assert.deepEqual(stored, data, `${type}: data round trip`);
    for (const col of lifted) {
      const own = schema.properties[col]?.["x-column"] === true;
      const value = own ? (data[col] ?? null) : null;
      if (value !== null && TIMES.has(col)) assert.equal(Date.parse(row[col]), Date.parse(value), `${type}.${col}`);
      else assert.equal(row[col], value, `${type}.${col}`);
    }
  }
});

test("a re-push of the same event_id makes no second row", opts, (t) => {
  const db = createDb(t);
  const sql = `INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, device_seq, data)
    VALUES (1, gen_random_uuid(), now(), 'claimed', 1, 'o/r', 'd', 'a', 1, '{}')`;
  db.query(sql.replace("gen_random_uuid()", "'3f1c9a52-8b0e-4f7a-9d21-6c4e2b7a1f08'"), "writer");
  assert.throws(() => db.query(sql.replace("gen_random_uuid()", "'3f1c9a52-8b0e-4f7a-9d21-6c4e2b7a1f08'"), "writer"), /duplicate key/);
  assert.equal(db.query("SELECT count(*) FROM factory.event_store"), "1");
});
