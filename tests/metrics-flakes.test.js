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
