// The saved queries of docs/metrics.md "Spend on an API key" (cbundy/dev-system#1114), run as the
// reader role on a real PostgreSQL database with seeded usage events.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

const sub = (sql, repo, since) => sql.replaceAll(":'repo'", `'${repo}'`).replaceAll(":'since'", `'${since}'`);

function blocks() {
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "metrics.md"), "utf8");
  const start = doc.indexOf("\n## Spend on an API key");
  assert.ok(start >= 0, "docs/metrics.md has the section Spend on an API key");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 2, "the section holds two SQL blocks");
  return found;
}

test("Spend on an API key: per-day spend against the budget, and time in each tier", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (device, ts, data, repo = "o/a") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', 'usage', 1, '${repo}', '${device}', 'agent', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const spend = (spendUsd, budget, resets) => ({
    available: true, five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null,
    source: "spend", auth: "api-key", spend_usd: spendUsd, budget_usd: budget, budget_resets_at: resets, reasons: [],
  });
  const R1 = "2026-09-21T00:00:00.000Z";
  const R2 = "2026-10-21T00:00:00.000Z";
  // day 1 (10-19): 80 at 10:00 then 86 at 10:20 (86 holds 15 min, the cap)
  put("d1", "2026-09-19T09:00:00.000Z", spend(10, 100, R1));
  put("d1", "2026-09-19T10:00:00.000Z", spend(80, 100, R1));
  put("d1", "2026-09-19T10:20:00.000Z", spend(86, 100, R1));
  // day 2 (10-20): same period
  put("d1", "2026-09-20T10:00:00.000Z", spend(95, 100, R1));
  put("d1", "2026-09-20T10:05:00.000Z", spend(92, 100, R1));
  // day 3 (10-21): the period reset, a reading with no budget
  put("d1", "2026-09-21T10:00:00.000Z", spend(7, 100, R2));
  put("d1", "2026-09-21T10:02:00.000Z", spend(9, null, null));
  // ignored: a subscription reading, an unavailable one and another repo
  put("d1", "2026-09-20T11:00:00.000Z", { available: true, five_hour_pct: 99, five_hour_resets_at: R1, seven_day_pct: 99, seven_day_resets_at: R1, source: "oauth", reasons: [], auth: "subscription" });
  put("d1", "2026-09-20T11:30:00.000Z", { available: false, five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null, source: null, reasons: ["x"], auth: "api-key" });
  put("d2", "2026-09-20T11:00:00.000Z", spend(500, 100, R1), "o/b");

  const [a, b] = blocks();
  const rowsA = db.query(sub(a, "o/a", "2026-09-01T00:00:00Z"), "reader").split("\n").map((l) => l.split("|"));
  assert.deepEqual(rowsA, [
    ["2026-09-19", "o/a", "d1", "86", "100", "86", "86"],
    ["2026-09-20", "o/a", "d1", "92", "100", "92", "6"],
    ["2026-09-21", "o/a", "d1", "9", "", "", "9"],
  ]);

  const rowsB = db.query(sub(b, "o/a", "2026-09-01T00:00:00Z"), "reader").split("\n").map((l) => l.split("|"));
  // 09:00-10:00 at 10% (cap 15 min), 10:00-10:20 at 80% (cap 15), 10:20 at 86% to the next reading 10-20 (cap 15)
  // 10-20: 95% for 5 min, 92% for 15 min (the last reading of the day, the next is a day on, cap 15)
  // 10-21: 7% for 2 min, then the no-budget reading for 15 min
  assert.deepEqual(rowsB, [
    ["o/a", "d1", "normal", "00:32:00"],
    ["o/a", "d1", "slow", "00:15:00"],
    ["o/a", "d1", "stop-all", "00:05:00"],
    ["o/a", "d1", "stop-new", "00:15:00"],
    ["o/a", "d1", "unknown", "00:15:00"],
  ]);
});
