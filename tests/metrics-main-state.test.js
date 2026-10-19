// The saved queries of docs/metrics.md "Main after merge" (cbundy/dev-system#1033), run as the
// reader role on a real PostgreSQL database with seeded main_state and merged events.
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
  const start = doc.indexOf("\n## Main after merge");
  assert.ok(start >= 0, "docs/metrics.md has the section Main after merge");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 2, "the section holds two SQL blocks");
  return found;
}

const sha = (n) => String(n).padStart(40, "0");

test("Main after merge: newest state per repo, and first and settled green per merge", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (repo, type, data, ts) => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'dev', 'agent', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const state = (repo, at, head, pr, green, changed) =>
    put(repo, "main_state", { observed_at: at, branch: "main", head: sha(head), pr, green, changed }, at);
  const merged = (repo, pr, ts) => put(repo, "merged", { pr, branch: `issue-${pr}`, head: sha(900 + (pr ?? 0)), by: "factory", recovered: false }, ts);

  state("o/a", "2026-10-19T08:00:00.000Z", 1, 10, true, "first");
  state("o/a", "2026-10-19T09:00:00.000Z", 2, 11, false, "head");
  state("o/a", "2026-10-19T09:10:00.000Z", 2, 11, true, "workflow");
  state("o/a", "2026-10-19T10:00:00.000Z", 3, 12, true, "head");
  state("o/b", "2026-10-19T07:00:00.000Z", 4, 20, false, "first");
  state("o/b", "2026-10-19T07:30:00.000Z", 4, 20, false, "workflow");
  // squash merges: the merged head is not main's head
  merged("o/a", 11, "2026-10-19T08:59:00.000Z"); // first red, settled green
  merged("o/a", 12, "2026-10-19T09:59:00.000Z"); // stays green
  merged("o/a", 13, "2026-10-19T11:00:00.000Z"); // nothing observed
  merged("o/a", null, "2026-10-19T09:00:00.000Z"); // no pr: no row

  const [a, b] = blocks();
  const rowsA = db.query(a, "reader").split("\n").map((l) => l.split("|"));
  assert.deepEqual(rowsA, [
    ["o/a", "main", sha(3), "12", "2026-10-19 10:00:00+00", "t", "head"],
    ["o/b", "main", sha(4), "20", "2026-10-19 07:30:00+00", "f", "workflow"],
  ]);

  const rowsB = db.query(b, "reader").split("\n").map((l) => l.split("|"));
  assert.equal(rowsB.length, 3, "one row per merge with a pr");
  const by = Object.fromEntries(rowsB.map((r) => [r[1], r]));
  assert.deepEqual([by["11"][3], by["11"][4]], ["f", "t"]);
  assert.deepEqual([by["12"][3], by["12"][4]], ["t", "t"]);
  assert.deepEqual([by["13"][3], by["13"][4]], ["", ""]);
  assert.deepEqual(
    [by["11"][5], by["12"][5], by["13"][5]],
    ["2026-10-19 09:00:00+00", "2026-10-19 10:00:00+00", ""],
  );
});
