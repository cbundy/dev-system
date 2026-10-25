// The saved queries of docs/metrics.md "What-if cost per merged issue" (cbundy/dev-system#1334), run as
// the reader role on a real PostgreSQL database with seeded merged, loop_entry and intake_stamp events.
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
  const start = doc.indexOf("\n## What-if cost per merged issue");
  assert.ok(start >= 0, "docs/metrics.md has the section What-if cost per merged issue");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 4, "the section holds four SQL blocks");
  return found;
}

test("What-if cost per merged issue: each agent once, intake stamps added, gaps and unpriced models visible", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, ts, issue, data, repo = "o/a") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'd1', 'agent', ${issue}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  // tokens are [input, output, read, create]; cost null is an unpriced or unread step
  const entry = (key, agent, status, ts, issue, cost, model, tokens = [1, 1, 1, 1], repo = "o/a") =>
    put("loop_entry", ts, issue, {
      kind: "agent-step", key, status, attempts: 1, class: "drive", rule: "S2", started_at: "2026-10-18T09:00:00.000Z", ended_at: status === "running" ? null : ts, agent_id: agent, wake: null,
      input_tokens: status === "running" || model === null ? null : tokens[0], output_tokens: status === "running" || model === null ? null : tokens[1],
      cache_read_tokens: status === "running" || model === null ? null : tokens[2], cache_creation_tokens: status === "running" || model === null ? null : tokens[3],
      model, cost_usd: cost,
    }, repo);
  const stamp = (ts, issue, cost, repo = "o/a") =>
    put("intake_stamp", ts, issue, { version: "abc12345", mode: "run", outcome: "ok", model: "haiku", input_tokens: cost === null ? null : 10, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, cost_usd: cost }, repo);
  const merged = (ts, issue, repo = "o/a") => put("merged", ts, issue, { pr: 10 + issue, branch: `issue-${issue}`, head: "abcdef1", by: "factory", recovered: false }, repo);

  // issue 1: merged; a build, its retry, a review, a fix with no transcript, an unpriced step, an intake stamp
  entry("i1/lA/s1/build/a1", "ag1", "running", "2026-10-18T09:00:00.000Z", 1, null, null);
  entry("i1/lA/s1/build/a1", "ag1", "done", "2026-10-18T09:10:00.000Z", 1, 1.5, "claude-opus-5-5");
  entry("i1/lA/s1/build/a1", "ag1", "done", "2026-10-18T09:11:00.000Z", 1, 1.5, "claude-opus-5-5"); // the same end logged again: once
  entry("i1/lA/s1/build/a2", "ag2", "failed", "2026-10-18T09:20:00.000Z", 1, 0.25, "claude-sonnet-5-5"); // a retry: its own agent
  entry("i1/lB/review/abc1234/r1/a1", "ag3", "done", "2026-10-18T10:00:00.000Z", 1, 0.75, "claude-opus-5-5");
  entry("i1/lB/s2/fix/a1", "ag4", "done", "2026-10-18T10:30:00.000Z", 1, null, null); // no transcript
  entry("i1/lB/s2/fix/a2", "ag5", "done", "2026-10-18T10:40:00.000Z", 1, null, "claude-future-9"); // tokens, unpriced model
  entry("i1/lB/s2/fix/a3", "ag9", "running", "2026-10-18T10:50:00.000Z", 1, 99, "claude-opus-5-5"); // not ended: never counted
  stamp("2026-10-18T08:00:00.000Z", 1, 0.0125);
  merged("2026-10-18T11:00:00.000Z", 1);
  // issue 2: merged, one haiku review and a stamp that could not be read
  entry("i2/lA/review/def5678/r1/a1", "ag6", "done", "2026-10-19T09:10:00.000Z", 2, 0.5, "claude-haiku-5-5");
  stamp("2026-10-19T08:00:00.000Z", 2, null);
  merged("2026-10-19T11:00:00.000Z", 2);
  // issue 3: not merged
  entry("i3/lA/s1/build/a1", "ag7", "done", "2026-10-18T09:10:00.000Z", 3, 50, "claude-opus-5-5");
  // issue 4: merged before the window
  entry("i4/lA/s1/build/a1", "ag8", "done", "2026-09-01T09:10:00.000Z", 4, 70, "claude-opus-5-5");
  merged("2026-09-01T11:00:00.000Z", 4);
  // another repo, same issue number
  entry("i1/lA/s1/build/a1", "ag1", "done", "2026-10-18T09:10:00.000Z", 1, 80, "claude-opus-5-5", [1, 1, 1, 1], "o/b");
  merged("2026-10-18T11:00:00.000Z", 1, "o/b");

  const [perIssue, perModel, gaps, unpriced] = blocks();
  const rows = (sql) => db.query(sub(sql, "o/a", "2026-10-01T00:00:00Z"), "reader").split("\n").filter(Boolean).map((l) => l.split("|"));
  assert.deepEqual(rows(perIssue), [
    ["o/a", "1", "2026-10-18 11:00:00+00", "2.5125", '{"build": 1.75, "intake": 0.0125, "review": 0.75}'],
    ["o/a", "2", "2026-10-19 11:00:00+00", "0.5", '{"review": 0.5}'],
  ]);
  assert.deepEqual(rows(perModel), [
    ["o/a", "claude-opus-5-5", "2", "2.25"],
    ["o/a", "claude-haiku-5-5", "1", "0.5"],
    ["o/a", "claude-sonnet-5-5", "1", "0.25"],
    ["o/a", "haiku", "1", "0.0125"],
  ]);
  assert.deepEqual(rows(gaps), [
    ["o/a", "1", "2026-10-18 11:00:00+00", "2"],
    ["o/a", "2", "2026-10-19 11:00:00+00", "0"],
  ]);
  assert.deepEqual(rows(unpriced), [["o/a", "claude-future-9", "1", "2026-10-18 10:40:00+00"]]);
});
