// The saved queries of docs/metrics.md "2d. Flaky tests" (cbundy/dev-system#1025), run as the reader
// role on a real PostgreSQL database with seeded gate_run and intervention events, and section 9's
// first query on the same seed.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "metrics.md"), "utf8");

// The SQL blocks of a section, by its heading.
function blocks(heading, count) {
  const start = doc.indexOf(`\n${heading}`);
  assert.ok(start >= 0, `docs/metrics.md has ${heading}`);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const found = [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(found.length >= count, true, `${heading} holds ${count} SQL blocks`);
  return found;
}

const sub = (sql, repo, since) => sql.replaceAll(":'repo'", `'${repo}'`).replaceAll(":'since'", `'${since}'`);
const iso = (s) => new Date(s.replace(" ", "T").replace(/\+00$/, "Z")).toISOString();

const SHA = "0821e6a3c0f4b1d2e5a6978877665544332211ff";
const SHA2 = "1111111a3c0f4b1d2e5a6978877665544332211f";

test("section 2d: flakes per test, retries once, and section 9 still counts a ci-rerun fact once", opts, (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, issue, data, ts, repo = "o/r") => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, '${repo}', 'dev', 'agent', ${issue ?? "NULL"}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const gate = (issue, s, result, head, startedAt, extra = {}) =>
    put("gate_run", issue, { life: "aa1", seq: s, head, result, wait_ms: 0, run_ms: 1000, concurrency: 1, queued_behind: 0, started_at: startedAt, ...extra },
      new Date(Date.parse(startedAt) + 60000).toISOString());
  const iv = (issue, fact, data, ts) =>
    put("intervention", issue, { who: "loop", cause: "ci-rerun", life: "aa1", fact, pr: 7, detail: "ci", ...data }, ts);

  // issue 11: a gate fail, then a flaky pass on the same head, written twice (a retry); a second
  // pass with flaky false
  gate(11, 3, "fail", SHA, "2026-10-17T10:00:00.000Z", { failed_tests: ["a > one", "b > two"] });
  const flaky = { flaky: true, failed_tests: ["a > one", "b > two"], failed_at: "2026-10-17T10:00:00.000Z" };
  gate(11, 4, "pass", SHA, "2026-10-17T10:10:00.000Z", flaky);
  gate(11, 4, "pass", SHA, "2026-10-17T10:10:00.000Z", flaky);
  gate(11, 5, "pass", SHA2, "2026-10-17T10:20:00.000Z", { flaky: false });
  // issue 12: the test a > one flakes here too, in CI; the first row, then the flake row
  iv(12, "i12/pr7/ci/1", { head: SHA }, "2026-10-17T11:00:00.000Z");
  iv(12, "i12/pr7/ci/1", { head: SHA, flaky: true, failed_jobs: ["test", "lint"], failed_tests: ["a > one"] }, "2026-10-17T11:20:00.000Z");
  // issue 13: a ci-rerun pair whose second row says flaky false
  iv(13, "i13/pr8/ci/1", { head: SHA2 }, "2026-10-17T12:00:00.000Z");
  iv(13, "i13/pr8/ci/1", { head: SHA2, flaky: false, failed_jobs: ["test"], failed_tests: ["c > three"] }, "2026-10-17T12:20:00.000Z");
  // issue 14: a flaky pass with no test name recorded, another repo's flake, and one before the window
  gate(14, 2, "pass", SHA, "2026-10-17T13:00:00.000Z", { flaky: true });
  gate(15, 2, "pass", SHA, "2026-10-17T13:00:00.000Z", { flaky: true, failed_tests: ["x > y"], failed_at: "2026-10-17T12:50:00.000Z" });
  db.query(`UPDATE factory.event_store SET repo = 'o/other' WHERE issue = 15`, "owner");
  gate(16, 2, "pass", SHA, "2026-10-01T13:00:00.000Z", { flaky: true, failed_tests: ["old > one"], failed_at: "2026-10-01T12:50:00.000Z" });

  const [q1, q2] = blocks("## 2d. Flaky tests", 2);
  const run = (sql) => db.query(sub(sql, "o/r", "2026-10-10T00:00:00Z"), "reader").split("\n").filter(Boolean).map((l) => l.split("|"));

  // columns: source, repo, issue, life, head, job, test, failed_at, passed_at
  const rows = run(q1).map((r) => [r[0], r[2], r[5], r[6], r[7] === "" ? "" : iso(r[7]), iso(r[8])]);
  rows.sort((x, y) => x.join("|").localeCompare(y.join("|")));
  assert.deepEqual(rows, [
    ["ci", "12", "lint, test", "a > one", "2026-10-17T11:00:00.000Z", "2026-10-17T11:20:00.000Z"],
    ["gate", "11", "", "a > one", "2026-10-17T10:00:00.000Z", "2026-10-17T10:11:00.000Z"],
    ["gate", "11", "", "b > two", "2026-10-17T10:00:00.000Z", "2026-10-17T10:11:00.000Z"],
    ["gate", "14", "", "", "", "2026-10-17T13:01:00.000Z"],
  ]);

  // columns: repo, test, flakes, first_flake, last_flake, issues
  const tests = run(q2);
  assert.equal(tests.length, 2, "the unnamed flake and the other repo have no row");
  const one = tests.find((r) => r[1] === "a > one");
  assert.deepEqual([one[2], iso(one[3]), iso(one[4]), one[5]], ["2", "2026-10-17T10:11:00.000Z", "2026-10-17T11:20:00.000Z", "2"]);
  const two = tests.find((r) => r[1] === "b > two");
  assert.deepEqual([two[2], two[5]], ["1", "1"]);

  // section 9's first query: each ci-rerun fact is one intervention, flaky row or not
  const [nine] = blocks("## 9. Interventions", 1);
  const counts = run(nine).filter((r) => r[3] === "ci-rerun");
  assert.equal(counts.reduce((n, r) => n + Number(r[4]), 0), 2, "two ci-rerun facts, two interventions");
});

// The flake bug rule's read (v2 SPEC 8.5, F1) and the two queries over its tells (cbundy/dev-system#866).
const hookSource = fs.readFileSync(path.join(__dirname, "..", "plugins", "factory-loop", "hooks", "v2", "sources-flakes.ts"), "utf8");
const loopSql = /export const FLAKES_SQL = `([\s\S]*?)`\n/.exec(hookSource)[1];

test("the loop's flakes query is the one saved in section 2d", () => {
  const saved = blocks("## 2d. Flaky tests", 3)[2];
  assert.ok(saved.includes("the bug rule's read"), "the third block is the bug rule's read");
  assert.equal(saved.replace(/^--.*\n/, "").trim(), loopSql.trim());
});

test("section 2d: the bug rule's read gives one row per flake per test with the first row's event id, the window and repo hold", (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, issue, data, ts, repo = "o/r") => {
    seq += 1;
    const eventId = crypto.randomUUID();
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${eventId}', '${ts}', '${type}', 1, '${repo}', 'dev', 'agent', ${issue ?? "NULL"}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
    return eventId;
  };
  const gate = (issue, s, startedAt, extra, ts, repo = "o/r") =>
    put("gate_run", issue, { life: "aa1", seq: s, head: SHA, result: "pass", wait_ms: 0, run_ms: 1000, concurrency: 1, queued_behind: 0, started_at: startedAt, flaky: true, failed_tests: ["a > one"], failed_at: startedAt, ...extra }, ts, repo);
  // a retried write: two rows of one flake; the first row's id is the flake's
  const first = gate(11, 4, "2026-10-17T10:10:00.000Z", {}, "2026-10-17T10:11:00.000Z");
  gate(11, 4, "2026-10-17T10:10:00.000Z", {}, "2026-10-17T10:11:05.000Z");
  const ci = put("intervention", 12, { who: "loop", cause: "ci-rerun", life: "aa1", fact: "i12/pr7/ci/1", pr: 7, flaky: true, head: SHA2, failed_jobs: ["test", "lint"], failed_tests: ["a > one", "b > two"] }, "2026-10-17T11:20:00.000Z");
  // before the window, another repo, and a flake with no name
  gate(13, 2, "2026-10-01T10:00:00.000Z", {}, "2026-10-01T10:01:00.000Z");
  gate(14, 2, "2026-10-17T12:00:00.000Z", {}, "2026-10-17T12:01:00.000Z", "o/other");
  db.query(`UPDATE factory.event_store SET repo = 'o/other' WHERE issue = 14`, "owner");
  gate(15, 2, "2026-10-17T13:00:00.000Z", { failed_tests: undefined }, "2026-10-17T13:01:00.000Z");

  const rows = db.query(sub(loopSql, "o/r", "2026-10-10T00:00:00Z"), "reader").split("\n").filter(Boolean).map((l) => l.split("|"));
  // columns: event_id, source, issue, head, passed_at, test, job, hash
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]), [
    [first, "gate", "11", SHA, "2026-10-17T10:11:00.000Z", "a > one", ""],
    [ci, "ci", "12", SHA2, "2026-10-17T11:20:00.000Z", "a > one", "lint, test"],
    [ci, "ci", "12", SHA2, "2026-10-17T11:20:00.000Z", "b > two", "lint, test"],
  ]);
  const hash = (name) => crypto.createHash("sha256").update(name).digest("hex").slice(0, 16);
  assert.deepEqual(rows.map((r) => r[7]), [hash("a > one"), hash("a > one"), hash("b > two")], "the hash is the first 16 hex digits of the sha256 of the test name");
});

test("section 2d: first flake to fix, and the daily summary, over the flake bug tells", (t) => {
  const db = createDb(t);
  let seq = 0;
  const put = (type, issue, data, ts) => {
    seq += 1;
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${crypto.randomUUID()}', '${ts}', '${type}', 1, 'o/r', 'dev', 'agent', ${issue ?? "NULL"}, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  };
  const tell = (bug, decision, test, firstFlake, ts, status = "done") =>
    put("loop_entry", null, { kind: "tell", key: `tell:flake-bug:${bug}`, status, attempts: 1, class: "owner", rule: "F1", started_at: ts, ended_at: status === "done" ? ts : null, agent_id: null, wake: "flake-bug", decision, decision_reason: "cap", flake_test: test, flakes: 2, window_days: 7, first_flake_at: firstFlake, filed_issue: bug }, ts);
  // bug 900: readied, fixed by a merge; 901: held, closed by hand; 902: held, still open; a tell is written twice (running, done)
  tell(900, "ready", "a > one", "2026-10-15T08:00:00.000Z", "2026-10-15T12:00:00.000Z", "running");
  tell(900, "ready", "a > one", "2026-10-15T08:00:00.000Z", "2026-10-15T12:00:05.000Z");
  tell(901, "held", "b > two", "2026-10-16T08:00:00.000Z", "2026-10-16T12:00:00.000Z");
  tell(902, "held", "c > three", "2026-10-17T08:00:00.000Z", "2026-10-17T12:00:00.000Z");
  put("merged", 900, { pr: 1, branch: "issue-900", head: SHA.slice(0, 7), by: "factory", recovered: false }, "2026-10-15T20:00:00.000Z");
  put("closed", 901, { reason: "completed" }, "2026-10-16T20:00:00.000Z");
  put("loop_entry", null, { kind: "tell", key: "tell:other", status: "done", attempts: 1, class: "owner", rule: "S1", started_at: "2026-10-17T12:00:00.000Z", ended_at: "2026-10-17T12:00:00.000Z", agent_id: null, wake: "starved" }, "2026-10-17T12:00:00.000Z");

  const [fix, summary] = blocks("## 2d. Flaky tests", 5).slice(3);
  const run = (sql, since) => db.query(sub(sql, "o/r", since), "reader").split("\n").filter(Boolean).map((l) => l.split("|"));
  // columns: bug, flake_test, first_flake, filed_at, readied, merged_at, first_flake_to_merge
  const rows = run(fix, "2026-10-01T00:00:00Z");
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[4], r[5] === "" ? "" : iso(r[5]), r[6]]), [
    ["900", "a > one", "t", "2026-10-15T20:00:00.000Z", "12:00:00"],
    ["901", "b > two", "f", "", ""],
    ["902", "c > three", "f", "", ""],
  ]);
  // columns: filed, readied, held, fixed, still_open
  assert.deepEqual(run(summary, "2026-10-01T00:00:00Z"), [["3", "1", "2", "2", "1"]]);
  // a later window counts only what happened in it, and what is open now
  assert.deepEqual(run(summary, "2026-10-16T12:00:00Z"), [["2", "0", "2", "1", "1"]]);
});
