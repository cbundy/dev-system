// The saved queries of docs/metrics.md "Settings" (cbundy/dev-system#1013), run as the reader
// role on a real PostgreSQL database with seeded settings_changed events and workers rows.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

function blocks() {
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "metrics.md"), "utf8");
  const start = doc.indexOf("\n## Settings");
  assert.ok(start >= 0, "docs/metrics.md has the section Settings");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 2, "the section holds two SQL blocks");
  return found;
}

test("Settings: one row per fact, newest first; config null until written", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (device, ts, data) => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', 'settings_changed', 1, 'o/a', '${device}', 'agent', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const ev = (key, oldValue, newValue, layer, who, fact) => ({ key, old_value: oldValue, new_value: newValue, layer, who, fact });
  put("d1", "2026-10-19T08:00:00.000Z", ev("maxInFlightIssues", 3, 5, "workspace", "judge", "settings/maxInFlightIssues/a"));
  put("d2", "2026-10-19T08:00:05.000Z", ev("maxInFlightIssues", 3, 5, "workspace", "judge", "settings/maxInFlightIssues/a"));
  put("d1", "2026-10-19T09:00:00.000Z", ev("derived.gateConcurrency", null, 2, null, "plugin", "settings/derived.gateConcurrency/b"));

  db.query("INSERT INTO factory.workers (device, repo, config) VALUES ('w1', 'o/a', '{\"at\":\"2026-10-19T09:00:00.000Z\",\"settings\":{\"maxInFlightIssues\":5}}'::jsonb), ('w2', 'o/a', NULL)", "writer");

  const [a, b] = blocks();
  const rowsA = db.query(a, "reader").split("\n").map((l) => l.split("|"));
  assert.deepEqual(rowsA, [
    ["2026-10-19 09:00:00+00", "o/a", "d1", "derived.gateConcurrency", "", "plugin", "null", "2"],
    ["2026-10-19 08:00:00+00", "o/a", "d1", "maxInFlightIssues", "workspace", "judge", "3", "5"],
  ]);

  const rowsB = db.query(b, "reader").split("\n").map((l) => l.split("|"));
  // settings_age depends on the clock: the fixed snapshot time is in the past, so it is an interval
  // for w1 and empty for w2 (no snapshot).
  assert.match(rowsB[0][3], /^-?\d+ days? |^-?\d{2,}:\d{2}:\d{2}|^-?\d+ (mons?|years?)/);
  assert.deepEqual(rowsB.map((r) => [r[0], r[1], r[2], r[4], r[3] === ""]), [
    ["w1", "o/a", "2026-10-19T09:00:00.000Z", '{"maxInFlightIssues": 5}', false],
    ["w2", "o/a", "", "", true],
  ]);
});
