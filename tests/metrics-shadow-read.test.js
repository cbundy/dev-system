// The saved query of docs/metrics.md "6b. Reader shadow compares", run as the reader role on a
// real PostgreSQL database with seeded shadow_read events.
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
  const start = doc.indexOf("\n## 6b. Reader shadow compares");
  assert.ok(start >= 0, "docs/metrics.md has section 6b");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 1, "section 6b holds one SQL block");
  assert.ok(!/@>|DISTINCT ON/.test(found[0]));
  return found[0];
}

test("section 6b: counts, sums, failed reads and the newest difference detail per day", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (repo, type, ts, data, device = "dev") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', '${device}', 'agent', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const read = (repo, ts, over = {}, device = "dev") => put(repo, "shadow_read", ts, {
    reader: "claim-events", tool: "callum-flow-sweep", compared: 10, differences: 0, live_differences: 0,
    diff_keys: [], old_ok: true, new_ok: true, settle_seconds: 120, detail: null, ...over,
  }, device);

  read("o/r", "2026-10-17T09:00:00.000Z");
  read("o/r", "2026-10-17T10:00:00.000Z", { differences: 1, live_differences: 2, diff_keys: ["a"], detail: "first" });
  read("o/r", "2026-10-17T11:00:00.000Z", { differences: 2, live_differences: 2, diff_keys: ["a", "b"], detail: "newest" });
  read("o/r", "2026-10-17T12:00:00.000Z"); // newer but clean: must not hide the detail
  read("o/r", "2026-10-17T12:00:00.000Z"); // a retried write of the same compare
  read("o/r", "2026-10-17T13:00:00.000Z", { scope_floor: "2026-10-17T13:26:02Z", out_of_scope: 7 });
  read("o/r", "2026-10-17T14:00:00.000Z", { scope_floor: "2026-10-17T13:26:02Z", out_of_scope: 5 });
  read("o/r", "2026-10-17T15:00:00.000Z", { scope_floor: null }); // a newer compare of a device with no floor: must not hide it
  read("o/r", "2026-10-18T09:00:00.000Z", { new_ok: false });
  read("o/r", "2026-10-18T09:30:00.000Z", { reader: "other-reader", old_ok: false, differences: 1, live_differences: 1, detail: "x" });
  read("o/other", "2026-10-17T10:30:00.000Z", { differences: 9, detail: "other repo" });
  read("o/r", "2026-10-01T10:00:00.000Z", { differences: 9, detail: "too old" });
  put("o/r", "claimed", "2026-10-17T10:00:00.000Z", {});

  const sql = block().replaceAll(":'repo'", "'o/r'").replaceAll(":'since'", "'2026-10-10T00:00:00Z'");
  const rows = db.query(sql, "reader").split("\n").map((l) => l.split("|"));
  // columns: reader, tool, device, day, compares, differences, live_differences, failed_reads, newest_detail,
  // scope_floor, out_of_scope
  assert.equal(rows.length, 3);
  const by = Object.fromEntries(rows.map((r) => [`${r[0]} ${r[3].slice(0, 10)}`, r]));
  assert.deepEqual([by["claim-events 2026-10-17"][4], by["claim-events 2026-10-17"][5], by["claim-events 2026-10-17"][6], by["claim-events 2026-10-17"][7], by["claim-events 2026-10-17"][8]], ["7", "3", "4", "0", "newest"]);
  assert.deepEqual(by["claim-events 2026-10-17"].slice(9), ["2026-10-17T13:26:02Z", "12"]);
  assert.deepEqual(by["claim-events 2026-10-18"].slice(4), ["1", "0", "0", "1", "", "", "0"]);
  assert.deepEqual(by["other-reader 2026-10-18"].slice(4), ["1", "1", "1", "1", "x", "", "0"]);
});
