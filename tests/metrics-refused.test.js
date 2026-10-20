// The saved query of docs/metrics.md section 9, "Actions refusal spells", run as the reader role on a
// real PostgreSQL database with seeded loop_entry and intervention events.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };
const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "metrics.md"), "utf8");

function block() {
  const start = doc.indexOf("\n### Actions refusal spells");
  assert.ok(start >= 0, "docs/metrics.md has the refusal spells query");
  const rest = doc.slice(start + 1);
  const m = /```sql\n([\s\S]*?)```/.exec(rest);
  assert.ok(m, "the section holds a SQL block");
  return m[1];
}

const iso = (s) => new Date(s.replace(" ", "T").replace(/\+00$/, "Z")).toISOString();

test("section 9: one row per refusal spell, with its minutes, message, refused runs and PRs", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, issue, data, ts, repo = "o/r") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'dev', 'agent', ${issue ?? "NULL"}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const entry = (wake, key, decision, reason, ts) =>
    put("loop_entry", null, { kind: "tell", key, status: "done", attempts: 1, class: "owner", rule: "S2", started_at: ts, ended_at: ts, agent_id: null, wake, decision, decision_reason: reason }, ts);
  const refused = (issue, pr, fact, ts, cause = "ci-refused") =>
    put("intervention", issue, { who: "loop", cause, life: "aa1", fact, pr, detail: "x" }, ts);

  // spell 1: opened 10:00 (written twice, running then done), two runs on two PRs, a probe, resumed 11:30
  entry("actions-refused", "tell:actions-refused:111", "hold", "The job was not started because payments failed", "2026-10-20T10:00:00.000Z");
  entry("actions-refused", "tell:actions-refused:111", "hold", "The job was not started because payments failed", "2026-10-20T10:00:05.000Z");
  refused(11, 7, "i11/laa1/refused/900", "2026-10-20T09:58:00.000Z");
  refused(12, 8, "i12/laa1/refused/901", "2026-10-20T10:01:00.000Z");
  refused(11, 7, "i11/laa1/refused/900/p1", "2026-10-20T10:31:00.000Z", "ci-refused:probe");
  entry("actions-resumed", "tell:actions-resumed:tell:actions-refused:111", "resume", "job started", "2026-10-20T11:30:00.000Z");
  refused(11, 7, "i11/laa1/refused/900/go", "2026-10-20T11:31:00.000Z", "ci-refused:rerun");
  // spell 2: still open; its run was refused 5 minutes before it opened
  entry("actions-refused", "tell:actions-refused:222", "hold", "spending limit", "2026-10-21T08:00:00.000Z");
  refused(13, 9, "i13/laa1/refused/902", "2026-10-21T07:55:00.000Z");
  // before the window, and another repo's
  entry("actions-refused", "tell:actions-refused:000", "hold", "old", "2026-10-01T08:00:00.000Z");
  entry("actions-refused", "tell:actions-refused:333", "hold", "other", "2026-10-20T10:00:00.000Z");
  db.query(`UPDATE factory.event_store SET repo = 'o/other' WHERE data->>'key' = 'tell:actions-refused:333'`, "owner");

  const sql = block().replaceAll(":'repo'", "'o/r'").replaceAll(":'since'", "'2026-10-10T00:00:00Z'");
  const rows = db.query(sql, "reader").split("\n").filter(Boolean).map((l) => l.split("|"));
  // columns: started_at, resumed_at, minutes, reason, refused_runs, prs
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].map((v, i) => (i < 2 && v !== "" ? iso(v) : v)), ["2026-10-20T10:00:00.000Z", "2026-10-20T11:30:00.000Z", "90", "The job was not started because payments failed", "2", "2"]);
  assert.deepEqual(rows[0].map((v, i) => (i === 0 ? iso(v) : v)).filter((_, i) => i !== 2), ["2026-10-21T08:00:00.000Z", "", "spending limit", "1", "1"]);
});
