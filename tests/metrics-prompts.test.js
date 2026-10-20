// The saved query of docs/metrics.md "9b. Permission prompts", run as the reader role on a real
// PostgreSQL database with seeded prompt_denied and prompt_waiting events.
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
  const start = doc.indexOf("\n## 9b. Permission prompts");
  assert.ok(start >= 0, "docs/metrics.md has section 9b");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length, 1, "section 9b holds one SQL block");
  assert.ok(!/@>|DISTINCT ON|event_store/.test(found[0]));
  return found[0];
}

test("section 9b: prompts per repo, day, tool and agent type, and the issues waiting in the last 24 hours", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (repo, type, ts, issue, data) => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', ${ts}, '${type}', 1, '${repo}', 'dev', 'agent', ${issue}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const abs = (iso) => `'${iso}'::timestamptz`;
  const ago = (hours) => `now() - interval '${hours} hours'`;
  const denied = (repo, ts, tool_name, agent_type) => put(repo, "prompt_denied", ts, 5, { tool_name, agent_type, tool_input: "x", ask_reason: "r" });
  const waiting = (repo, ts, issue, agent_type, tool_input) => put(repo, "prompt_waiting", ts, issue, { tool_name: null, agent_type, tool_input });

  denied("o/r", abs("2026-10-17T09:00:00.000Z"), "Bash", "general-purpose");
  denied("o/r", abs("2026-10-17T10:00:00.000Z"), "Bash", "general-purpose");
  denied("o/r", abs("2026-10-17T11:00:00.000Z"), "Edit", "Explore");
  denied("o/r", abs("2026-10-18T09:00:00.000Z"), "Bash", "Explore");
  denied("o/other", abs("2026-10-17T09:00:00.000Z"), "Bash", "general-purpose");
  denied("o/r", abs("2026-10-01T09:00:00.000Z"), "Bash", "general-purpose"); // before since
  waiting("o/r", abs("2026-10-17T12:00:00.000Z"), 7, "Explore", "old wait");
  waiting("o/r", ago(30), 8, "general-purpose", "wait over a day ago");
  waiting("o/r", ago(2), 9, "Explore", "recent wait");
  waiting("o/other", ago(1), 10, "Explore", "other repo");
  put("o/r", "claimed", ago(1), 9, {});

  const sql = block().replaceAll(":'repo'", "'o/r'").replaceAll(":'since'", "'2026-10-10T00:00:00Z'");
  const rows = db.query(sql, "reader").split("\n").map((l) => l.split("|"));
  // columns: part, repo, day, issue, tool_name, agent_type, tool_input, ts, denied, waiting
  const daily = rows.filter((r) => r[0] === "daily").map((r) => [r[2], r[4], r[5], r[8], r[9]].join(" "));
  const day = (hours) => new Date(Date.now() - hours * 3600000).toISOString().slice(0, 10);
  const relative = {};
  for (const [h, a] of [[30, "general-purpose"], [2, "Explore"]]) relative[`${day(h)}  ${a} 0`] = (relative[`${day(h)}  ${a} 0`] ?? 0) + 1;
  assert.deepEqual(daily.sort(), [
    ...Object.entries(relative).map(([k, n]) => `${k} ${n}`),
    "2026-10-17  Explore 0 1",
    "2026-10-17 Bash general-purpose 2 0",
    "2026-10-17 Edit Explore 1 0",
    "2026-10-18 Bash Explore 1 0",
  ].sort());
  const recent = rows.filter((r) => r[0] === "blocked");
  assert.equal(recent.length, 1, "only the wait of the last 24 hours in this repo");
  assert.deepEqual([recent[0][3], recent[0][5], recent[0][6]], ["9", "Explore", "recent wait"]);
  assert.ok(recent[0][7], "the blocked row carries its ts");
  assert.equal(rows.length, daily.length + recent.length);
});
