// The saved queries of docs/metrics.md "Intake stamp" (cbundy/dev-system#1149), run as the reader
// role on a real PostgreSQL database with seeded intake_stamp and claimed events.
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
  const start = doc.indexOf("\n### Intake stamp");
  assert.ok(start >= 0, "docs/metrics.md has the subsection Intake stamp");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n### ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 5, "the subsection holds five SQL blocks");
  return found;
}

test("Intake stamp: each query counts the seeded stamps and claims", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, ts, issue, data) => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, 'o/a', 'd1', 'agent', ${issue}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const stamp = (ts, issue, outcome, area, needsOwner, kept) =>
    put("intake_stamp", ts, issue, { version: "v" + issue, mode: "run", outcome, area, needs_owner: needsOwner, reason: null, touches: [], dropped: [], labels_set: [], labels_kept: kept, model: "sonnet" });
  stamp("2026-10-19T08:00:00.000Z", 1, "ok", "factory", true, []);
  stamp("2026-10-19T09:00:00.000Z", 2, "ok", "factory", false, ["needs-owner"]);
  stamp("2026-10-19T10:00:00.000Z", 3, "ok", "docs", false, []);
  stamp("2026-10-19T11:00:00.000Z", 4, "failed", null, null, []);
  stamp("2026-10-20T08:00:00.000Z", 5, "dropped", "docs", true, ["x"]);
  const claim = (ts, issue, factors) => put("claimed", ts, issue, { score: 1, factors });
  claim("2026-10-19T12:00:00.000Z", 1, [{ name: "bug", points: 5 }, { name: "overlap", points: -3 }]);
  claim("2026-10-19T13:00:00.000Z", 2, [{ name: "bug", points: 5 }]);
  claim("2026-10-19T14:00:00.000Z", 3, []);
  claim("2026-10-20T12:00:00.000Z", 4, [{ name: "area-factory", points: 2 }]);

  const rows = (sql) => db.query(sql, "reader").split("\n").map((l) => l.split("|"));
  const [a, b, c, d, e] = blocks();
  assert.deepEqual(rows(a), [
    ["2026-10-19 00:00:00+00", "o/a", "failed", "1"],
    ["2026-10-19 00:00:00+00", "o/a", "ok", "3"],
    ["2026-10-20 00:00:00+00", "o/a", "dropped", "1"],
  ]);
  assert.deepEqual(rows(b), [["o/a", "factory", "2"], ["o/a", "docs", "1"]]);
  assert.deepEqual(rows(c), [["2026-10-19 00:00:00+00", "3", "1", "33.3"]]);
  assert.deepEqual(rows(d), [
    ["2026-10-19 00:00:00+00", "4", "1", "25.0"],
    ["2026-10-20 00:00:00+00", "1", "1", "100.0"],
  ]);
  assert.deepEqual(rows(e), [
    ["2026-10-19 00:00:00+00", "3", "1", "33.3"],
    ["2026-10-20 00:00:00+00", "1", "1", "100.0"],
  ]);
});
