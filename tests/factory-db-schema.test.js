// The factory database schema against a real PostgreSQL (cbundy/dev-system#646): the event_log
// view versus the event schema files (docs/factory-events/schemas/*.v1.json), and a round trip
// through event_store. Each test makes its own database (tests/lib/factory-db.js).
// The bootstrap's own behaviour is in images/base/test/factory-db-bootstrap.test.sh.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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
const INTS = new Set(["pr", "seq", "round", "attempt", "wait_ms", "run_ms", "concurrency", "queued_behind", "waited_ms", "cap_ms", "running_at_request", "cut_at_stop", "compared", "differences", "live_differences", "settle_seconds", "lease_minutes", "fixes", "triages", "lives", "attempts", "passes", "acting", "errors", "mean_ms", "p50_ms", "p90_ms", "max_ms", "acting_mean_ms", "idle_mean_ms", "pass_every_ms", "observe_mean_ms", "observe_commands_mean_ms", "observe_in_process_mean_ms", "observe_in_process_max_ms", "five_hour_pct", "seven_day_pct", "additions", "deletions", "bucket", "opus_pct", "sonnet_pct", "parent", "milestone_closed", "milestone_open", "flakes", "window_days", "filed_issue", "considered", "free_slots", "folded"]);
const BIGINTS = new Set(["mem_start_bytes", "mem_peak_bytes", "mem_limit_bytes", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]);
const NUMERICS = new Set(["spend_usd", "budget_usd", "cost_usd"]);
const BOOLS = new Set(["old_ok", "new_ok", "restored", "available", "holding", "flaky", "green", "recovered", "owner_serial", "owner_new_off", "needs_owner", "tree_matched"]);
const TIMES = new Set(["seq_at", "state_since", "started_at", "requested_at", "stopped_at", "ended_at", "from_at", "to_at", "five_hour_resets_at", "seven_day_resets_at", "failed_at", "observed_at", "first_flake_at", "budget_resets_at", "taken_at", "merged_at"]);
const JSONS = new Set(["cut_at_stop_keys", "notes", "files", "split_into", "labels", "prs", "failed_tests", "failed_jobs", "old_value", "new_value", "options", "candidates", "rest", "owner_priority", "owner_only", "touches", "dropped", "labels_set", "labels_kept", "file_lines", "issues", "issues_closed", "headlines"]);

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

test("event_log has the envelope columns, device_seq and each x-column field", opts, (t) => {
  const db = createDb(t);
  const have = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_log' ORDER BY ordinal_position").split("\n");
  const want = [...Object.keys(envelope.properties).filter((k) => k !== "data"), "device_seq", ...lifted];
  assert.deepEqual([...have].sort(), [...want].sort(), "a schema that lifts a field needs a view migration");
  assert.equal(new Set(have).size, have.length);
  const types = Object.fromEntries(db.query("SELECT column_name || ' ' || data_type FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_log'").split("\n").map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
  for (const col of lifted) {
    const type = JSONS.has(col) ? "jsonb" : BOOLS.has(col) ? "boolean" : INTS.has(col) ? "integer" : BIGINTS.has(col) ? "bigint" : NUMERICS.has(col) ? "numeric" : TIMES.has(col) ? "timestamp with time zone" : "text";
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
      else if (JSONS.has(col)) assert.deepEqual(row[col], value, `${type}.${col}`);
      else assert.equal(row[col], value, `${type}.${col}`);
    }
  }
});

test("a parked transition's options read back from event_log as a jsonb array", opts, (t) => {
  const db = createDb(t);
  const ex = load("transition.v1.json").examples.find((e) => Array.isArray(e.options));
  assert.ok(ex, "the transition schema has an example with options");
  db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    VALUES (1, gen_random_uuid(), now(), 'transition', 1, 'o/r', 'd', 'a', 7, 1, $j$${JSON.stringify(ex)}$j$::jsonb)`, "writer");
  assert.equal(db.query("SELECT jsonb_typeof(options) || ' ' || jsonb_array_length(options) || ' ' || (options -> 1 ->> 'title') || ' ' || recommended FROM factory.event_log", "reader"), `array ${ex.options.length} ${ex.options[1].title} ${ex.recommended}`);
});

test("merged: file_lines lifts as a jsonb array of per-file counts, and reads NULL on an older merged row", opts, (t) => {
  const db = createDb(t);
  const base = { pr: 1, branch: "b", head: "f94eb46", by: "factory", recovered: false };
  const lines = [{ path: "a.js", additions: 3, deletions: 1 }, { path: "b.sh", additions: 0, deletions: 2 }];
  let seq = 0;
  for (const data of [base, { ...base, files: ["a.js", "b.sh"], file_lines: lines }]) {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), 'merged', 1, 'o/r', 'd', 'a', 7, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  }
  assert.equal(db.query("SELECT coalesce(file_lines::text, 'null') FROM factory.event_log WHERE device_seq = 1", "reader"), "null");
  assert.equal(db.query("SELECT jsonb_typeof(file_lines) || ' ' || jsonb_array_length(file_lines) || ' ' || (file_lines -> 0 ->> 'path') || ' ' || (file_lines -> 1 ->> 'deletions') FROM factory.event_log WHERE device_seq = 2", "reader"), "array 2 a.js 2");
});

test("merged: merged_at lifts as a timestamptz, title stays the ready/claimed text column, and an older merged row reads NULL", opts, (t) => {
  const db = createDb(t);
  const base = { pr: 1, branch: "b", head: "f94eb46", by: "hand", recovered: true };
  [base, { ...base, merged_at: "2026-10-22T21:22:01Z", title: "A merged title" }].forEach((data, i) => {
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), '2026-10-23T16:16:00Z', 'merged', 1, 'o/r', 'd', 'sweep', 7, ${i + 1}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  });
  assert.equal(db.query("SELECT pg_typeof(merged_at)::text FROM factory.event_log LIMIT 1", "reader"), "timestamp with time zone");
  assert.equal(db.query("SELECT merged_at IS NULL AND title IS NULL FROM factory.event_log WHERE device_seq = 1", "reader"), "t");
  assert.equal(db.query("SELECT to_char(merged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') || ' ' || title || ' ' || (ts - merged_at) FROM factory.event_log WHERE device_seq = 2", "reader"), "2026-10-22T21:22:01 A merged title 18:53:59");
});

test("merged: the merge-train fields lift as columns, and an older merged row reads NULL", opts, (t) => {
  const db = createDb(t);
  const base = { pr: 1, branch: "b", head: "f94eb46", by: "factory", recovered: false };
  const tree = "0123456789abcdef0123456789abcdef01234567";
  [base, { ...base, train: "rode", train_reason: null, tested_tree: tree, tree_matched: false }, { ...base, train: "dropped", train_reason: "train-red", tested_tree: null, tree_matched: null }].forEach((data, i) => {
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), 'merged', 1, 'o/r', 'd', 'a', 7, ${i + 1}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  });
  assert.equal(db.query("SELECT pg_typeof(tree_matched)::text FROM factory.event_log LIMIT 1", "reader"), "boolean");
  assert.equal(db.query("SELECT train IS NULL AND train_reason IS NULL AND tested_tree IS NULL AND tree_matched IS NULL FROM factory.event_log WHERE device_seq = 1", "reader"), "t");
  assert.equal(db.query("SELECT train || ' ' || tested_tree || ' ' || tree_matched || ' ' || (train_reason IS NULL) FROM factory.event_log WHERE device_seq = 2", "reader"), `rode ${tree} false true`);
  assert.equal(db.query("SELECT train || ' ' || train_reason || ' ' || (tested_tree IS NULL) FROM factory.event_log WHERE device_seq = 3", "reader"), "dropped train-red true");
  const cols = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'factory_public' AND table_name = 'event_log' ORDER BY ordinal_position").split("\n");
  assert.deepEqual(cols.slice(-6, -1), ["merged_at", "train", "train_reason", "tested_tree", "tree_matched"], "the public view appends them after merged_at");
});

test("released: issues, issues_closed and headlines lift as jsonb arrays, and read NULL on every other type", opts, (t) => {
  const db = createDb(t);
  const [full] = load("released.v1.json").examples;
  const merged = { pr: 1, branch: "b", head: "f94eb46", by: "factory", recovered: false };
  const rows = [["released", full], ["merged", merged]];
  rows.forEach(([type, data], i) => {
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), '${type}', 1, 'o/r', 'd', 'a', 7, ${i + 1}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  });
  assert.equal(db.query("SELECT jsonb_typeof(issues) || ' ' || jsonb_array_length(issues) || ' ' || jsonb_typeof(issues_closed) || ' ' || jsonb_array_length(issues_closed) || ' ' || jsonb_typeof(headlines) || ' ' || (headlines ->> 0) FROM factory.event_log WHERE type = 'released'", "reader"),
    `array ${full.issues.length} array ${full.issues_closed.length} array ${full.headlines[0]}`);
  assert.equal(db.query("SELECT issues IS NULL AND issues_closed IS NULL AND headlines IS NULL FROM factory.event_log WHERE type = 'merged'", "reader"), "t");
});

test("usage: the spend columns are null for an old reading and the given values for a spend reading", opts, (t) => {
  const db = createDb(t);
  const [old, spend] = load("usage.v1.json").examples;
  assert.equal(old.auth, undefined, "the first example is the old shape");
  assert.equal(spend.source, "spend");
  let seq = 0;
  for (const data of [old, spend]) {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), 'usage', 1, 'o/r', 'd', 'a', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  }
  const read = (n) => db.query(`SELECT concat_ws('|', coalesce(auth, 'null'), coalesce(spend_usd::text, 'null'), coalesce(budget_usd::text, 'null'), coalesce(budget_resets_at::text, 'null')) FROM factory.event_log WHERE device_seq = ${n}`, "reader");
  assert.equal(read(1), "null|null|null|null");
  assert.equal(read(2), "api-key|42.5|100|2026-11-01 00:00:00+00");
});

test("loop_entry: the token columns are bigint, null for an old row, the values for a reading, and model lifts into its column", opts, (t) => {
  const db = createDb(t);
  const [old, withTokens] = load("loop_entry.v1.json").examples.filter((e) => e.kind === "agent-step");
  assert.equal(old.input_tokens, undefined, "the first example is the old shape");
  assert.equal(withTokens.model, "claude-opus-5-5");
  let seq = 0;
  for (const data of [old, withTokens, { ...withTokens, input_tokens: 5000000000 }]) {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), 'loop_entry', 1, 'o/r', 'd', 'a', 7, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  }
  const read = (n) => db.query(`SELECT concat_ws('|', coalesce(input_tokens::text, 'null'), coalesce(output_tokens::text, 'null'), coalesce(cache_read_tokens::text, 'null'), coalesce(cache_creation_tokens::text, 'null'), coalesce(model, 'null')) FROM factory.event_log WHERE device_seq = ${n}`, "reader");
  assert.equal(read(1), "null|null|null|null|null");
  assert.equal(read(2), `${withTokens.input_tokens}|${withTokens.output_tokens}|${withTokens.cache_read_tokens}|${withTokens.cache_creation_tokens}|claude-opus-5-5`);
  assert.equal(read(3).split("|")[0], "5000000000", "a total past 2^31 does not overflow");
});

test("cost_usd is numeric on both event types, null for an old row, the value for a reading", opts, (t) => {
  const db = createDb(t);
  const rows = [
    ["loop_entry", load("loop_entry.v1.json").examples.find((e) => e.kind === "agent-step")],
    ["loop_entry", { ...load("loop_entry.v1.json").examples.find((e) => e.kind === "agent-step"), cost_usd: 1.234567 }],
    ["intake_stamp", { ...load("intake_stamp.v1.json").examples[0], cost_usd: 0.000397 }],
  ];
  rows.forEach(([type, data], i) => {
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), '${type}', 1, 'o/r', 'd', 'a', 7, ${i + 1}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  });
  const read = (n) => db.query(`SELECT coalesce(cost_usd::text, 'null') FROM factory.event_log WHERE device_seq = ${n}`, "reader");
  assert.equal(read(1), "null");
  assert.equal(read(2), "1.234567");
  assert.equal(read(3), "0.000397");
  const cols = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'factory_public' AND table_name = 'event_log' ORDER BY ordinal_position").split("\n");
  assert.equal(cols[cols.length - 1], "cost_usd", "the public view appends it last");
  assert.equal(db.query("SELECT pg_typeof(cost_usd)::text FROM factory.event_log LIMIT 1", "reader"), "numeric");
});

test("a re-push of the same event_id makes no second row", opts, (t) => {
  const db = createDb(t);
  const sql = `INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, device_seq, data)
    VALUES (1, gen_random_uuid(), now(), 'claimed', 1, 'o/r', 'd', 'a', 1, '{}')`;
  db.query(sql.replace("gen_random_uuid()", "'3f1c9a52-8b0e-4f7a-9d21-6c4e2b7a1f08'"), "writer");
  assert.throws(() => db.query(sql.replace("gen_random_uuid()", "'3f1c9a52-8b0e-4f7a-9d21-6c4e2b7a1f08'"), "writer"), /duplicate key/);
  assert.equal(db.query("SELECT count(*) FROM factory.event_store"), "1");
});

test("factory.workers and factory.workers_status have config jsonb", opts, (t) => {
  const db = createDb(t);
  for (const rel of ["workers", "workers_status"]) {
    const type = db.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = '${rel}' AND column_name = 'config'`);
    assert.equal(type, "jsonb", `${rel}.config`);
  }
});

test("factory.workers, workers_status and worker_samples have the memory pressure columns", opts, (t) => {
  const db = createDb(t);
  const want = { mem_max_events: "bigint", mem_max_rate_per_min: "real", mem_oom_kills: "bigint", mem_psi_some_avg10: "real", mem_psi_full_avg10: "real" };
  for (const rel of ["workers", "workers_status", "worker_samples"]) {
    for (const [col, type] of Object.entries(want)) {
      const got = db.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = '${rel}' AND column_name = '${col}'`);
      assert.equal(got, type, `${rel}.${col}`);
    }
  }
});

test("factory.workers, workers_status and worker_samples have the GitHub health columns", opts, (t) => {
  const db = createDb(t);
  const want = {
    github_core_remaining: "integer", github_core_limit: "integer", github_core_reset_at: "timestamp with time zone",
    github_graphql_remaining: "integer", github_graphql_limit: "integer", github_graphql_reset_at: "timestamp with time zone",
    github_errors_1h: "integer",
  };
  for (const rel of ["workers", "workers_status", "worker_samples"]) {
    for (const [col, type] of Object.entries(want)) {
      const got = db.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = '${rel}' AND column_name = '${col}'`);
      assert.equal(got, type, `${rel}.${col}`);
    }
  }
  for (const rel of ["workers", "workers_status"]) {
    const got = db.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = '${rel}' AND column_name = 'github_at'`);
    assert.equal(got, "timestamp with time zone", `${rel}.github_at`);
  }
});

test("loop_passes: the observe columns are null for an old minute and the given values for a new one", opts, (t) => {
  const db = createDb(t);
  const [old, , fresh] = load("loop_passes.v1.json").examples;
  assert.equal(old.observe_mean_ms, undefined, "the first example is the old shape");
  assert.equal(fresh.observe_mean_ms, 2600);
  let seq = 0;
  for (const data of [old, fresh]) {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, gen_random_uuid(), now(), 'loop_passes', 1, 'o/r', 'd', 'a', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  }
  const read = (n) => db.query(`SELECT concat_ws('|', coalesce(observe_mean_ms::text, 'null'), coalesce(observe_commands_mean_ms::text, 'null'), coalesce(observe_in_process_mean_ms::text, 'null'), coalesce(observe_in_process_max_ms::text, 'null')) FROM factory.event_log WHERE device_seq = ${n}`, "reader");
  assert.equal(read(1), "null|null|null|null");
  assert.equal(read(2), "2600|2300|300|520");
});

test("regime: rows from before the migration read NULL, and a new row's regime reads from event_log", opts, (t) => {
  const migrations = path.join(__dirname, "..", "images", "base", "factory-db", "migrations");
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-before-regime-"));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  for (const f of fs.readdirSync(migrations)) if (f < "0027") fs.copyFileSync(path.join(migrations, f), path.join(old, f));
  const db = createDb(t, { migrationsDir: old });
  const col = "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_store' AND column_name = 'regime'";
  assert.equal(db.query(col), "0", "the old schema has no regime column");
  const before = crypto.randomUUID();
  const insert = (id, cols, vals) => db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data${cols})
    VALUES (1, '${id}', '2026-10-16T15:45:19.123Z', 'claimed', 1, 'o/r', 'dev', 'agent', 7, 1, '{"lease_minutes":5}'::jsonb${vals})`, "writer");
  insert(before, "", "");
  // Bootstrap again with the full directory, as the next start-up does.
  const r = spawnSync("bash", [path.join(__dirname, "..", "images", "base", "factory-db-bootstrap"), "--db", db.name], {
    encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: process.env.FACTORY_TEST_PG_ADMIN_URL, FACTORY_DB_MIGRATIONS_DIR: migrations },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(db.query(col), "1");
  assert.equal(db.query(`SELECT regime IS NULL FROM factory.event_log WHERE event_id = '${before}'`, "reader"), "t");
  const after = crypto.randomUUID();
  insert(after, ", regime", ", 'testbed'");
  assert.equal(db.query(`SELECT regime FROM factory.event_log WHERE event_id = '${after}'`, "reader"), "testbed");
  const cols = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_log' ORDER BY ordinal_position").split("\n");
  assert.deepEqual(cols.slice(-11, -5), ["regime", "file_lines", "issues", "issues_closed", "headlines", "merged_at"], "OR REPLACE appends: regime keeps its place, 0028's file_lines, 0029's release columns and 0031's merged_at follow it");
});
