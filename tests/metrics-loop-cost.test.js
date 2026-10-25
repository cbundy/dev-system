// The saved queries of docs/metrics.md "What-if cost of the loop's own work" (cbundy/dev-system#1336), run as
// the reader role on a real PostgreSQL database with seeded loop_passes and loop_entry events.
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
  const start = doc.indexOf("\n## What-if cost of the loop's own work");
  assert.ok(start >= 0, "docs/metrics.md has the section What-if cost of the loop's own work");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 2, "the section holds two SQL blocks");
  return found;
}

test("What-if cost of the loop's own work: per-day minute sums with gaps, and per-wake rows without running ones", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, ts, data, repo = "o/a") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'd1', 'agent', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const minute = (from, cost, repo = "o/a") => put("loop_passes", from, { from_at: from, to_at: from, passes: 1, acting: 0, errors: 0, mode: "act", planner: "v2", pass_every_ms: 10000, cost_usd: cost }, repo);
  const wake = (kind, key, wakeName, status, ts, cost, repo = "o/a") =>
    put("loop_entry", ts, { kind, key, status, attempts: 1, class: "owner", rule: null, started_at: "2026-10-18T09:00:00.000Z", ended_at: status === "running" ? null : ts, agent_id: null, wake: wakeName, cost_usd: cost }, repo);

  minute("2026-10-18T09:00:00.000Z", 0.5);
  minute("2026-10-18T09:01:00.000Z", 0.25);
  minute("2026-10-18T09:02:00.000Z", null);
  minute("2026-10-19T09:00:00.000Z", 1);
  minute("2026-10-18T09:00:00.000Z", 99, "o/b");
  minute("2026-09-01T09:00:00.000Z", 70);

  wake("task", "task:redrive:1", "redrive", "running", "2026-10-18T09:00:00.000Z", null);
  wake("task", "task:redrive:1", "redrive", "done", "2026-10-18T09:05:00.000Z", 1.5);
  wake("task", "task:redrive:2", "redrive", "done", "2026-10-18T09:10:00.000Z", null);
  wake("tell", "tell:runaway:1", "runaway", "done", "2026-10-18T09:20:00.000Z", 0.25);
  wake("task", "task:redrive:3", "redrive", "running", "2026-10-18T09:30:00.000Z", 99);
  wake("task", "task:redrive:1", "redrive", "done", "2026-10-18T09:00:00.000Z", 80, "o/b");

  const [perDay, perWake] = blocks();
  const rows = (sql) => db.query(sub(sql, "o/a", "2026-10-01T00:00:00Z"), "reader").split("\n").filter(Boolean).map((l) => l.split("|"));
  assert.deepEqual(rows(perDay), [
    ["o/a", "2026-10-18 00:00:00", "0.75", "1"],
    ["o/a", "2026-10-19 00:00:00", "1", "0"],
  ]);
  assert.deepEqual(rows(perWake), [
    ["o/a", "task", "redrive", "2", "1.5", "1"],
    ["o/a", "tell", "runaway", "1", "0.25", "0"],
  ]);
});
