// The saved query of docs/metrics.md "Update restarts that failed" (cbundy/dev-system#1346),
// run as the reader role on a real PostgreSQL database with seeded interventions.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

function block() {
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "metrics.md"), "utf8");
  const start = doc.indexOf("\n### Update restarts that failed");
  assert.ok(start >= 0, "docs/metrics.md has the subsection");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n### ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 1);
  return found[0];
}

test("Update restarts that failed: counts update-failed per repo, device and day and ignores other causes", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (repo, device, cause, detail, ts = "2026-10-19T08:00:00.000Z") => {
    seq += 1;
    const data = { who: "loop", cause, life: null, fact: `${cause}/fleet/${seq}`, pr: null, detail, flaky: null, failed_tests: null, failed_jobs: null };
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', 'intervention', 1, '${repo}', '${device}', 'loop', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  put("o/a", "d1", "update-failed", "no token");
  put("o/a", "d1", "update-failed", "no token");
  put("o/a", "d2", "update-failed", "timed out", "2026-10-20T08:00:00.000Z");
  put("o/a", "d1", "op:update-refused", "no token");
  const rows = db.query(block(), "reader").split("\n").map((l) => l.split("|"));
  assert.deepEqual(rows, [
    ["o/a", "d1", "2026-10-19", "2"],
    ["o/a", "d2", "2026-10-20", "1"],
  ]);
});
