// The saved queries of docs/metrics.md "2c. Wind-downs" (cbundy/dev-system#840), run as the reader
// role on a real PostgreSQL database with seeded wind_down and transition events.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

// The three SQL blocks of the section, by heading.
function blocks() {
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "metrics.md"), "utf8");
  const start = doc.indexOf("\n## 2c. Wind-downs");
  assert.ok(start >= 0, "docs/metrics.md has section 2c");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 3, "section 2c holds three SQL blocks");
  return found;
}

const sub = (sql, repo, since) => sql.replaceAll(":'repo'", `'${repo}'`).replaceAll(":'since'", `'${since}'`);

// nearest-rank percentile
const pct = (values, p) => {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)];
};

const SEQ_KEY = (issue, life, step) => `i${issue}/l${life}/s3/${step}/a1`;
const REVIEW_KEY = (issue, life) => `i${issue}/l${life}/review/0821e6a/r2/a1`;

test("section 2c: per-stop rows, summary and cut-step re-runs", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (repo, type, issue, data, ts = "2026-10-17T12:00:00.000Z") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'dev', 'agent', ${issue ?? "NULL"}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const stop = (repo, requested, waited, outcome, cutKeys, runningKeys = cutKeys) => {
    const at = (ms) => new Date(Date.parse(requested) + ms).toISOString();
    put(repo, "wind_down", null, {
      requested_at: requested, stopped_at: at(waited), waited_ms: waited, cap_ms: 300000, outcome,
      running_at_request: runningKeys.length, running_at_request_keys: runningKeys,
      cut_at_stop: cutKeys.length, cut_at_stop_keys: cutKeys, trigger: "restart-self",
    });
  };
  const transition = (issue, life, step, via, row, at) =>
    put("o/r", "transition", issue, { life, seq: 4, table_row: row, via, step, seq_at: at, state_since: at });

  const k1 = SEQ_KEY(11, "aa1", "build");
  const k2 = SEQ_KEY(12, "bb2", "build");
  const k3 = REVIEW_KEY(13, "cc3");
  const k4 = SEQ_KEY(14, "dd4", "build");
  stop("o/r", "2026-10-17T10:00:00.000Z", 1000, "idle", []);
  stop("o/r", "2026-10-17T11:00:00.000Z", 300000, "cap", [k1, k2, k3], [k1, k2, k3]);
  stop("o/r", "2026-10-17T12:00:00.000Z", 300000, "cap", [k4]);
  stop("o/r", "2026-10-17T12:00:00.000Z", 300000, "cap", [k4]); // a retried write
  stop("o/r", "2026-10-17T13:00:00.000Z", 5000, "now", []);
  stop("o/other", "2026-10-17T11:30:00.000Z", 9000, "cap", [SEQ_KEY(99, "zz9", "build")]);
  stop("o/r", "2026-10-01T10:00:00.000Z", 7000, "cap", [SEQ_KEY(98, "yy8", "build")]);
  // k1: the free re-run; k2: spent free re-run; k3: review re-run, free; k4: none. An earlier
  // transition before the stop must not count.
  transition(11, "aa1", "build", "free:load", "U1", "2026-10-17T10:30:00.000Z");
  transition(11, "aa1", "build", "free:load", "U1", "2026-10-17T11:06:00.000Z");
  transition(11, "aa1", "build", "unknown:agent-dead", "T9", "2026-10-17T11:09:00.000Z");
  transition(12, "bb2", "build", "unknown:agent-dead", "T9", "2026-10-17T11:07:00.000Z");
  transition(13, "cc3", "review", "free:load", "U1", "2026-10-17T11:08:00.000Z");

  const [a, b, c] = blocks();
  const run = (sql) => db.query(sub(sql, "o/r", "2026-10-10T00:00:00Z"), "reader");

  const rowsA = run(a).split("\n").map((l) => l.split("|"));
  assert.equal(rowsA.length, 4, "one row per stop, the retried write once");
  assert.deepEqual(rowsA.map((r) => Number(r[5])).sort((x, y) => x - y), [1000, 5000, 300000, 300000]);
  const waited = rowsA.map((r) => Number(r[5]));
  assert.equal(pct(waited, 50), 5000);
  assert.equal(pct(waited, 90), 300000);

  assert.equal(run(b), "o/r|4|0.500|1.00");

  const rowsC = run(c).split("\n").map((l) => l.split("|"));
  const byKey = Object.fromEntries(rowsC.map((r) => [r[2], r]));
  assert.equal(rowsC.length, 4);
  // columns: repo, requested_at, key, issue, life, step, rerun_at, rerun_via, table_row
  assert.deepEqual(byKey[k1].slice(3, 6), ["11", "aa1", "build"]);
  assert.deepEqual(byKey[k1].slice(7), ["free:load", "U1"]);
  assert.deepEqual(byKey[k2].slice(7), ["unknown:agent-dead", "T9"]);
  assert.deepEqual(byKey[k3].slice(3, 6), ["13", "cc3", "review"]);
  assert.deepEqual(byKey[k3].slice(7), ["free:load", "U1"]);
  assert.deepEqual(byKey[k4].slice(6), ["", "", ""], "no re-run yet");
});
