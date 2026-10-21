// The saved queries of docs/metrics.md "Tokens per merged issue" (cbundy/dev-system#657), run as the
// reader role on a real PostgreSQL database with seeded merged and loop_entry events.
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
  const start = doc.indexOf("\n## Tokens per merged issue");
  assert.ok(start >= 0, "docs/metrics.md has the section Tokens per merged issue");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 3, "the section holds three SQL blocks");
  return found;
}

test("Tokens per merged issue: each agent once, over every life, with the gaps counted; an unmerged issue is absent", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, ts, issue, data, repo = "o/a") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'd1', 'agent', ${issue}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const entry = (key, agent, status, ts, issue, tokens = null, model = null, repo = "o/a") =>
    put("loop_entry", ts, issue, {
      kind: "agent-step", key, status, attempts: 1, class: "drive", rule: "S2", started_at: "2026-10-18T09:00:00.000Z", ended_at: status === "running" ? null : ts, agent_id: agent, wake: null,
      input_tokens: tokens?.[0] ?? null, output_tokens: tokens?.[1] ?? null, cache_read_tokens: tokens?.[2] ?? null, cache_creation_tokens: tokens?.[3] ?? null, model,
    }, repo);
  const merged = (ts, issue, repo = "o/a") => put("merged", ts, issue, { pr: 10 + issue, branch: `issue-${issue}`, head: "abcdef1", by: "factory", recovered: false }, repo);

  // issue 1: merged, two lives
  entry("i1/lA/s1/build/a1", "ag1", "running", "2026-10-18T09:00:00.000Z", 1);
  entry("i1/lA/s1/build/a1", "ag1", "done", "2026-10-18T09:10:00.000Z", 1, [100, 10, 1000, 50], "claude-opus-5-5");
  entry("i1/lA/s1/build/a1", "ag1", "done", "2026-10-18T09:11:00.000Z", 1, [100, 10, 1000, 50], "claude-opus-5-5"); // the same end logged again
  entry("i1/lA/s1/build/a2", "ag2", "failed", "2026-10-18T09:20:00.000Z", 1, [20, 2, 200, 5], "claude-sonnet-5"); // a retry: its own agent
  entry("i1/lB/review/abc1234/r1/a1", "ag3", "done", "2026-10-18T10:00:00.000Z", 1, [300, 30, 3000, 70], "claude-opus-5-5"); // the second life
  entry("i1/lB/s2/fix/a1", "ag4", "done", "2026-10-18T10:30:00.000Z", 1); // no transcript: null tokens
  entry("i1/lB/s2/fix/a2", "ag5", "running", "2026-10-18T10:40:00.000Z", 1, [999, 999, 999, 999]); // not ended: never counted
  merged("2026-10-18T11:00:00.000Z", 1);
  // issue 2: not merged
  entry("i2/lA/s1/build/a1", "ag6", "done", "2026-10-18T09:10:00.000Z", 2, [5000, 5000, 5000, 5000], "claude-opus-5-5");
  // issue 3: merged before the window
  entry("i3/lA/s1/build/a1", "ag7", "done", "2026-09-01T09:10:00.000Z", 3, [7000, 7000, 7000, 7000], "claude-opus-5-5");
  merged("2026-09-01T11:00:00.000Z", 3);
  // another repo, same issue number and agent id
  entry("i1/lA/s1/build/a1", "ag1", "done", "2026-10-18T09:10:00.000Z", 1, [8000, 8000, 8000, 8000], "claude-opus-5-5", "o/b");
  merged("2026-10-18T11:00:00.000Z", 1, "o/b");

  const [perIssue, perModel, perRole] = blocks();
  const rows = (sql) => db.query(sub(sql, "o/a", "2026-10-01T00:00:00Z"), "reader").split("\n").filter(Boolean).map((l) => l.split("|"));
  assert.deepEqual(rows(perIssue), [["o/a", "1", "2026-10-18 11:00:00+00", "3", "420", "42", "4200", "125", "4787", "1"]]);
  assert.deepEqual(rows(perModel), [
    ["o/a", "claude-opus-5-5", "2", "400", "40", "4000", "120", "4560"],
    ["o/a", "claude-sonnet-5", "1", "20", "2", "200", "5", "227"],
  ]);
  assert.deepEqual(rows(perRole), [
    ["o/a", "build", "2", "120", "12", "1200", "55", "0"],
    ["o/a", "fix", "0", "0", "0", "0", "0", "1"],
    ["o/a", "review", "1", "300", "30", "3000", "70", "0"],
  ]);
});
