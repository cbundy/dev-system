// factory.issue_state_at, factory.issue_state and factory.stuck_rules (migration 0033,
// cbundy/dev-system#1292) against a real PostgreSQL: the factory loop v2's state of every issue,
// derived in the database by the rules of docs/factory-state.md "The issue_state view". Each case of
// tests/fixtures/factory-issue-state/cases.json loads its events into factory.event_store as the
// writer role, reads factory.issue_state_at(<at>) as the reader role and compares the columns the
// case names (a case that expects null has no row). One database per test (tests/lib/factory-db.js).
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "images", "base", "factory-db", "migrations");
const BOOTSTRAP = path.join(ROOT, "images", "base", "factory-db-bootstrap");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "factory-issue-state", "cases.json"), "utf8"));
const COLUMNS = [
  "repo", "issue", "state", "step", "attempt", "life", "seq", "state_since", "branch", "pr", "why", "question", "decision", "context",
  "options", "recommended", "recommendation", "holder", "claimed_at", "lease_until", "lease_lapsed", "ended", "stuck_minutes", "stuck",
];
const TIMES = new Set(["state_since", "claimed_at", "lease_until"]);

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };
const lit = (s) => `$q$${s}$q$`;

// The case's events as INSERT rows for factory.event_store. A data key starting with _ is not
// payload: _device (default dev-a) and _v (the type version, default 1).
function insertSql(cases) {
  const rows = [];
  let n = 0;
  for (const c of cases) {
    for (const [type, ts, raw] of c.events) {
      const data = { ...raw };
      const device = data._device ?? "dev-a";
      const version = data._v ?? 1;
      for (const k of Object.keys(data)) if (k.startsWith("_") || k === "issue") delete data[k];
      if (type === "transition") {
        data.seq_at ??= ts;
        data.state_since ??= ts;
      }
      n += 1;
      rows.push(`(1, '${crypto.randomUUID()}', ${lit(ts)}, '${type}', ${version}, ${lit(c.repo ?? FIXTURE.repo)}, ${lit(device)}, 'agent', ${c.issue}, ${n}, ${lit(JSON.stringify(data))}::jsonb)`);
    }
  }
  return `INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data) VALUES ${rows.join(",\n")}`;
}

// The view's rows at `at`, as the reader role, keyed by "repo#issue".
function rowsAt(db, at, fn = `factory.issue_state_at('${at}')`) {
  const out = db.query(`SET TimeZone = 'UTC'; SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.repo, t.issue), '[]') FROM ${fn} t`, "reader");
  const byKey = new Map();
  for (const r of JSON.parse(out)) {
    for (const k of TIMES) if (r[k] !== null) r[k] = new Date(r[k]).toISOString();
    byKey.set(`${r.repo}#${r.issue}`, r);
  }
  return byKey;
}

const keyOf = (c) => `${(c.repo ?? FIXTURE.repo).toLowerCase()}#${c.issue}`;

test("every case of the fixture reads as its expected row", opts, (t) => {
  const db = createDb(t);
  db.query(insertSql(FIXTURE.cases), "writer");
  const rows = rowsAt(db, FIXTURE.at);
  const wanted = new Set();
  for (const c of FIXTURE.cases) {
    const key = keyOf(c);
    if (c.expect === null) {
      assert.equal(rows.has(key), false, `${c.name}: expected no row, got ${JSON.stringify(rows.get(key))}`);
      continue;
    }
    wanted.add(key);
    const row = rows.get(key);
    assert.ok(row, `${c.name}: no row`);
    assert.deepEqual(Object.keys(row).sort(), [...COLUMNS].sort(), `${c.name}: the columns`);
    const want = { repo: key.split("#")[0], issue: c.issue, ...c.expect };
    for (const [col, v] of Object.entries(want)) assert.deepEqual(row[col], v, `${c.name}: ${col}`);
  }
  assert.deepEqual([...rows.keys()].sort(), [...wanted].sort(), "no row beyond the cases'");
});

test("the 24 hour window moves with the instant asked about, and the view is the function at now()", opts, (t) => {
  const db = createDb(t);
  const closed = FIXTURE.cases.find((c) => c.issue === 8);
  db.query(insertSql([closed]), "writer");
  assert.equal(rowsAt(db, "2026-10-20T12:00:00Z").size, 1, "closed 23h59m before");
  assert.equal(rowsAt(db, "2026-10-20T12:01:00Z").size, 0, "closed 24h00m before");
  assert.equal(rowsAt(db, "2026-10-19T12:00:00Z").size, 0, "before the event: it is not read");
  assert.equal(rowsAt(db, null, "factory.issue_state").size, 0, "the real clock is far past it");
  const now = new Date().toISOString();
  db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    VALUES (1, gen_random_uuid(), '${now}', 'ready', 1, 'o/r', 'd', 'a', 5, 99, '{}'::jsonb)`, "writer");
  assert.equal(rowsAt(db, null, "factory.issue_state").get("o/r#5").state, "queued");
});

test("the stuck defaults are the tool's thresholds for v2 states", opts, (t) => {
  const db = createDb(t);
  const got = db.query("SELECT state || '=' || coalesce(minutes::text, 'null') FROM factory.stuck_rules ORDER BY state", "reader").split("\n");
  assert.deepEqual(got, [
    "building=60", "designing=240", "fixing=null", "merge-queue=30", "parked=30", "queued=null", "reviewing=null", "waiting=null",
  ]);
});

test("the reader reads both views and runs the function; the writer cannot change a threshold or a view", opts, (t) => {
  const db = createDb(t);
  const as = (role, sql) => spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", db.url, "-c", `SET ROLE "${db.name}_${role}"; ${sql}`], { encoding: "utf8" });
  for (const sql of ["SELECT count(*) FROM factory.issue_state", "SELECT count(*) FROM factory.stuck_rules", "SELECT count(*) FROM factory.issue_state_at(now())"]) {
    assert.equal(as("reader", sql).status, 0, `reader: ${sql}`);
    assert.equal(as("writer", sql).status, 0, `writer: ${sql}`);
  }
  for (const sql of [
    "INSERT INTO factory.stuck_rules (state, minutes) VALUES ('queued', 1)",
    "UPDATE factory.stuck_rules SET minutes = 1",
    "CREATE OR REPLACE VIEW factory.stuck_rules AS SELECT 'queued'::text AS state, 1 AS minutes",
    "CREATE OR REPLACE VIEW factory.issue_state AS SELECT 1 AS issue",
    "CREATE OR REPLACE FUNCTION factory.issue_state_at(at timestamptz) RETURNS int LANGUAGE sql AS 'SELECT 1'",
  ]) {
    for (const role of ["writer", "reader"]) {
      const r = as(role, sql);
      assert.notEqual(r.status, 0, `${role} ran: ${sql}`);
      assert.match(r.stderr, /permission denied|must be owner|cannot (insert|update)|cannot change return type/, `${role}: ${sql}: ${r.stderr}`);
    }
  }
  const fn = db.query("SELECT prosecdef FROM pg_proc WHERE proname = 'issue_state_at' AND pronamespace = 'factory'::regnamespace");
  assert.equal(fn, "f", "the function is not SECURITY DEFINER");
});

test("the panel role reaches none of the new objects", opts, (t) => {
  const panelPassword = crypto.randomBytes(8).toString("hex");
  const db = createDb(t, { panelPassword });
  for (const sql of ["SELECT 1 FROM factory.issue_state", "SELECT 1 FROM factory.stuck_rules", "SELECT 1 FROM factory.issue_state_at(now())"]) {
    const r = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", db.panelUrl, "-c", sql], { encoding: "utf8" });
    assert.notEqual(r.status, 0, `the panel ran: ${sql}`);
    assert.match(r.stderr, /permission denied/);
  }
});

test("0033 applies to a database at 0032, and a second run changes nothing", opts, (t) => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-at-0032-"));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  for (const f of fs.readdirSync(MIGRATIONS)) if (f < "0033") fs.copyFileSync(path.join(MIGRATIONS, f), path.join(old, f));
  const db = createDb(t, { migrationsDir: old });
  const exists = "SELECT count(*) FROM pg_class WHERE relnamespace = 'factory'::regnamespace AND relname IN ('issue_state', 'stuck_rules')";
  assert.equal(db.query(exists), "0");
  assert.equal(db.query("SELECT max(version) FROM factory.schema_migrations"), "32");
  const boot = () => spawnSync("bash", [BOOTSTRAP, "--db", db.name], {
    encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: process.env.FACTORY_TEST_PG_ADMIN_URL, FACTORY_DB_MIGRATIONS_DIR: MIGRATIONS },
  });
  const first = boot();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(db.query(exists), "2");
  assert.equal(db.query("SELECT max(version) FROM factory.schema_migrations"), "37");
  const snapshot = () => db.query("SELECT string_agg(version::text || ':' || applied_at::text, ',' ORDER BY version) FROM factory.schema_migrations")
    + db.query("SELECT pg_get_viewdef('factory.issue_state'::regclass) || pg_get_functiondef('factory.issue_state_at'::regproc) || pg_get_viewdef('factory.stuck_rules'::regclass)");
  const before = snapshot();
  const second = boot();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(snapshot(), before, "the second run changed the schema or its record");
  assert.match(second.stdout, /schema version 37/);
});

test("the SQL has no DISTINCT ON and no @>, and uses a window function", () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, "0033_issue_state.sql"), "utf8").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /distinct\s+on/i);
  assert.doesNotMatch(sql, /@>/);
  assert.match(sql, /row_number\(\)/);
  assert.doesNotMatch(sql, /security\s+definer/i);
});
