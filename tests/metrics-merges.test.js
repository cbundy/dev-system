// The saved queries of docs/metrics.md "9c. Merges, pull requests and gaps" (cbundy/dev-system#749) and
// the judge-task rows of section 9's judgement-calls query, run as the reader role on a real PostgreSQL
// database seeded with tests/fixtures/evaluate/v2/new-events.jsonl, and compared with the numbers
// callum-flow-evaluate reports from the same file. The fixture's story is in tests/evaluate.test.js.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "evaluate", "v2", "new-events.jsonl");
const doc = fs.readFileSync(path.join(ROOT, "docs", "metrics.md"), "utf8");

// The SQL blocks of a section, by its heading.
function blocks(heading) {
  const start = doc.indexOf(`\n${heading}`);
  assert.ok(start >= 0, `docs/metrics.md has ${heading}`);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return [...rest.slice(0, end < 0 ? undefined : end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
}

const REPO = "acme/widgets";
const SINCE = "2026-10-16T00:00:00Z";
const UNTIL = "2026-10-16T12:00:00Z";

function seed(db, fixture = FIXTURE) {
  const lines = fs.readFileSync(fixture, "utf8").split("\n").filter((l) => l !== "");
  lines.forEach((l, i) => {
    const e = JSON.parse(l);
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${e.event_id}', '${e.ts}', '${e.type}', 1, '${e.repo}', '${e.device}', '${e.actor}', ${e.issue ?? "NULL"}, ${i + 1}, $j$${JSON.stringify(e.data)}$j$::jsonb)`, "writer");
  });
  return lines.length;
}

// rows of a query as JSON, run as the reader with its variables set
const rows = (db, sql) => {
  const text = sql.replaceAll(":'repo'", `'${REPO}'`).replaceAll(":'since'", `'${SINCE}'`).trim().replace(/;$/, "");
  return JSON.parse(db.query(`SELECT coalesce(json_agg(q), '[]'::json) FROM (${text}) q`, "reader"));
};

const evaluate = () => {
  const r = spawnSync("node", [path.join(ROOT, "images", "base", "callum-flow-evaluate"), "--repo", REPO, "--since", SINCE, "--until", UNTIL,
    "--source", "new", "--new-events", FIXTURE], { encoding: "utf8", env: { ...process.env, NO_MISTAKES_HOME: path.join(ROOT, "no-such-dir") } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const ms = (t) => new Date(t).getTime();

test("section 9c's queries give the numbers callum-flow-evaluate reports from the same events", opts, (t) => {
  const db = createDb(t);
  assert.ok(seed(db) > 60);
  const ev = evaluate();
  const q = blocks("## 9c. Merges, pull requests and gaps");
  assert.equal(q.length, 13, "the five merge queries, the two run-only ones (unrecorded merges, missing size), merges per day by regime, issue size, overlap, hottest files and merges by kind, and how late the sweep recorded merges");

  // merges per day: the same counts by merged_by and recovered
  const days = rows(db, q[0]);
  assert.deepEqual(days.map((r) => [r.day, r.merged_by, r.recovered, r.merges]), ev.merges.per_day.map((d) => [d.day, d.by, d.recovered, d.merges]));
  assert.equal(days.reduce((a, r) => a + r.merges, 0), 5, "the three signals of #32 are one merge, and the day before the window is left out");
  assert.deepEqual(days.map((r) => [r.merged_by, r.recovered, r.merges]), [["factory", false, 3], ["hand", true, 1], ["hand", null, 1]]);

  // merges per day by regime: the regime of a merge is that of its earliest signal; null reads unknown
  assert.deepEqual(rows(db, q[7]).map((r) => [r.day, r.regime, r.merged_by, r.recovered, r.merges]), days.map((r) => [r.day, "unknown", r.merged_by, r.recovered, r.merges]),
    "with no regime set, every merge is unknown and the rows are #0's");
  db.query("UPDATE factory.event_store SET regime = CASE WHEN issue IN (30, 31) THEN 'factory_loop_v2' WHEN issue = 32 THEN 'manual' END", "owner");
  const byRegime = rows(db, q[7]);
  assert.deepEqual([...new Set(byRegime.map((r) => r.regime))].sort(), ["factory_loop_v2", "manual", "unknown"].filter((g) => byRegime.some((r) => r.regime === g)));
  assert.ok(byRegime.some((r) => r.regime === "unknown") && byRegime.some((r) => r.regime !== "unknown"), "some merges are tagged and some are left unknown");
  const perDay = new Map();
  for (const r of byRegime) perDay.set(`${r.day}|${r.merged_by}|${r.recovered}`, (perDay.get(`${r.day}|${r.merged_by}|${r.recovered}`) ?? 0) + r.merges);
  assert.deepEqual([...perDay].sort(), days.map((r) => [`${r.day}|${r.merged_by}|${r.recovered}`, r.merges]).sort(), "summed over regime, the days are #0's");
  db.query("UPDATE factory.event_store SET regime = NULL", "owner");

  // PR open to merge, pull requests, supersedes and head moves, per merge
  const open = rows(db, q[1]);
  const prs = rows(db, q[2]);
  const heads = rows(db, q[3]);
  assert.equal(open.length, ev.prs.issues.length);
  ev.prs.issues.forEach((e, i) => {
    assert.deepEqual([open[i].issue, open[i].pr, open[i].pr_open_to_merge_seconds], [e.issue, e.pr, e.pr_open_to_merge_seconds], `open ${e.issue}`);
    assert.deepEqual([prs[i].issue, prs[i].pr, prs[i].prs, prs[i].supersedes], [e.issue, e.pr, e.prs, e.supersedes], `prs ${e.issue}`);
    assert.deepEqual([heads[i].issue, heads[i].pr, heads[i].head_moves], [e.issue, e.pr, e.head_moves], `heads ${e.issue}`);
  });
  assert.deepEqual(open.map((r) => r.pr_open_to_merge_seconds), [1800, 1200, 2640, null, 1800]);
  assert.deepEqual(prs.map((r) => [r.prs, r.supersedes]), [[1, 0], [2, 1], [1, 0], [0, 0], [1, 0]]);
  assert.deepEqual(heads.map((r) => r.head_moves), [1, 2, 0, 0, 0], "the queue:patch logged twice counts once");

  // the longest gaps, with the issues in flight
  const gaps = rows(db, q[4]);
  assert.deepEqual(gaps.map((g) => [ms(g.gap_from), ms(g.gap_to), g.gap_seconds, g.before_issue, g.before_pr, g.after_issue, g.after_pr, g.in_flight]),
    ev.gaps.gaps.map((g) => [ms(g.from), ms(g.to), g.gap_seconds, g.before.issue, g.before.pr, g.after.issue, g.after.pr,
      g.in_flight.map((i) => ({ issue: i.issue, state: i.state, parked_with_question: i.parked_with_question }))]));
  assert.deepEqual(gaps.map((g) => g.gap_seconds), [10860, 9000, 6540, 4800]);
  const longest = gaps[0].in_flight;
  assert.deepEqual(longest.find((i) => i.issue === 36), { issue: 36, state: "building", parked_with_question: true }, "building holds more of the gap than the parked hour");
  assert.deepEqual(longest.find((i) => i.issue === 38), { issue: 38, state: "building", parked_with_question: false }, "a tie goes to the name that sorts first");
  assert.ok(!longest.some((i) => [30, 31, 32, 40].includes(i.issue)), "a closed issue is not in flight");
  assert.equal(gaps[1].in_flight.find((i) => i.issue === 36).parked_with_question, false, "its parked hour is outside this gap");
});

test("section 9's judgement-calls query counts judge tasks as callum-flow-evaluate does", opts, (t) => {
  const db = createDb(t);
  seed(db);
  const ev = evaluate();
  const judgement = blocks("## 9. Interventions, judgement calls and claim completion").find((b) => b.includes("WITH calls AS"));
  assert.ok(judgement, "the judgement-calls block");
  const tasks = rows(db, judgement).filter((r) => r.kind === "task");
  assert.deepEqual(tasks.map((r) => [r.kind, r.outcome, r.calls, r.overridden]),
    ev.judgement_calls.by_kind.filter((k) => k.kind === "task").map((k) => [k.kind, k.outcome, k.count, k.overridden]));
  assert.deepEqual(tasks.map((r) => [r.outcome, r.calls, r.overridden]), [["merge:done", 1, 0], ["parked:done", 1, 1], ["ready:failed", 1, 0]],
    "a key with two rows counts once with its latest status; a person within the hour overrides; a task with no issue never is");
});

test("the 9c comparison bites: a merge changed in the store only is reported", opts, (t) => {
  const db = createDb(t);
  seed(db);
  const q = blocks("## 9c. Merges, pull requests and gaps");
  const before = rows(db, q[0]).map((r) => [r.merged_by, r.recovered, r.merges]);
  db.query("UPDATE factory.event_store SET data = jsonb_set(data, '{by}', '\"hand\"') WHERE type = 'merged' AND issue = 35", "owner");
  const after = rows(db, q[0]).map((r) => [r.merged_by, r.recovered, r.merges]);
  assert.notDeepEqual(after, before);
  assert.deepEqual(after, [["factory", false, 2], ["hand", false, 1], ["hand", true, 1], ["hand", null, 1]]);
  // the retried head move is a guard too: a second copy under a new fact is a second move
  db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    SELECT envelope, gen_random_uuid(), ts, type, type_version, repo, device, actor, issue, 9999, jsonb_set(data, '{fact}', '"i30/l30/other"')
    FROM factory.event_store WHERE type = 'intervention' AND data->>'cause' = 'queue:patch' AND issue = 30 LIMIT 1`, "writer");
  assert.deepEqual(rows(db, q[3]).map((r) => r.head_moves), [2, 2, 0, 0, 0]);
});

// ---- issue size, overlap, hottest files and merges by kind (#1219): the fixture's story is in tests/evaluate.test.js
const SIZE_FIXTURE = path.join(__dirname, "fixtures", "evaluate", "v2", "size-overlap-events.jsonl");
const SIZE_SINCE = "2026-10-20T00:00:00Z";
const SIZE_UNTIL = "2026-10-21T00:00:00Z";
const { NON_CODE_RE } = require(path.join(ROOT, "images", "base", "callum-flow-evaluate"));
const sizeRows = (db, sql) => {
  const text = sql.replaceAll(":'repo'", `'${REPO}'`).replaceAll(":'since'", `'${SIZE_SINCE}'`).trim().replace(/;$/, "");
  return JSON.parse(db.query(`SELECT coalesce(json_agg(q), '[]'::json) FROM (${text}) q`, "reader"));
};
const sizeEvaluate = () => {
  const r = spawnSync("node", [path.join(ROOT, "images", "base", "callum-flow-evaluate"), "--repo", REPO, "--since", SIZE_SINCE, "--until", SIZE_UNTIL,
    "--source", "new", "--new-events", SIZE_FIXTURE], { encoding: "utf8", env: { ...process.env, NO_MISTAKES_HOME: path.join(ROOT, "no-such-dir") } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("section 9c's size, overlap, hottest files and merges-by-kind blocks give the rows behind callum-flow-evaluate's numbers", opts, (t) => {
  const db = createDb(t);
  seed(db, SIZE_FIXTURE);
  const ev = sizeEvaluate();
  const q = blocks("## 9c. Merges, pull requests and gaps");

  const size = sizeRows(db, q[8]);
  assert.deepEqual(size.map((r) => [r.issue, r.pr, r.files, r.lines, r.code_files, r.code_lines]),
    ev.size.issues.map((i) => [i.issue, i.pr, i.files, i.lines, i.code_files, i.code_lines]));
  assert.deepEqual(size.find((r) => r.issue === 101), { repo: REPO, issue: 101, pr: 201, at: "2026-10-20T04:00:00+00:00", files: 4, lines: 192, code_files: 2, code_lines: 37 });
  assert.deepEqual(size.find((r) => r.issue === 104).files, null, "a merge without files is unknown");
  assert.equal(size.find((r) => r.issue === 105).code_lines, null, "no file_lines");
  assert.equal(size.length, 8, "Z, merged before since, is left out");

  const overlap = sizeRows(db, q[9]);
  assert.deepEqual(overlap.map((r) => [r.issue, r.pr, r.overlaps]), ev.overlap.issues.map((i) => [i.issue, i.pr, i.overlaps]));
  assert.deepEqual(overlap.filter((r) => r.overlapping).map((r) => [r.issue, r.overlaps]), [[106, [107]], [101, [102]], [102, [101]]]);

  const hot = sizeRows(db, q[10]);
  assert.deepEqual(hot, ev.overlap.hottest_files);
  assert.deepEqual(hot, [{ path: "src/shared.js", issues: 2 }, { path: "lib/old.js", issues: 1 }]);

  const kinds = sizeRows(db, q[11]);
  assert.deepEqual(kinds.map((r) => [r.day, r.kind, r.merges]), ev.merges.per_day_by_kind.map((r) => [r.day, r.kind, r.merges]));
  const days = sizeRows(db, q[0]);
  assert.equal(days.reduce((a, r) => a + r.merges, 0), kinds.filter((r) => r.kind !== "unlinked").reduce((a, r) => a + r.merges, 0) + 1,
    "summed over kind, the merges with an issue are #0's (G was never claimed, so it moves to unlinked)");
});

test("the size blocks bite: moving a claim, or a changed file, changes the rows", opts, (t) => {
  const db = createDb(t);
  seed(db, SIZE_FIXTURE);
  const q = blocks("## 9c. Merges, pull requests and gaps");
  // A and B stop overlapping when B's claim moves after A's merge
  db.query("UPDATE factory.event_store SET ts = '2026-10-20T04:30:00Z' WHERE type = 'claimed' AND issue = 102", "owner");
  assert.deepEqual(sizeRows(db, q[9]).filter((r) => r.overlapping).map((r) => r.issue), [106]);
  // G becomes linked once claimed
  db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    VALUES (1, gen_random_uuid(), '2026-10-20T08:30:00Z', 'claimed', 1, '${REPO}', 'L', 'agent', 108, 9999, '{"lease_minutes":120}'::jsonb)`, "writer");
  assert.deepEqual(sizeRows(db, q[11]).map((r) => [r.kind, r.merges]), [["factory", 7], ["hand", 1], ["unlinked", 2]]);
  // a code file turned into a document drops out of the counts
  db.query("UPDATE factory.event_store SET data = replace(data::text, 'src/g.js', 'src/g.md')::jsonb WHERE type = 'merged' AND issue = 108", "owner");
  assert.equal(sizeRows(db, q[8]).find((r) => r.issue === 108).code_files, 0);
});

test("section 9c's sweep-delay block gives ts - merged_at for a recovered merge that carries merged_at", opts, (t) => {
  const db = createDb(t);
  const ins = (id, actor, data, seq) => db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    VALUES (1, '${id}', '2026-10-23T16:16:00Z', 'merged', 1, '${REPO}', 'L', '${actor}', NULL, ${seq}, $j$${JSON.stringify(data)}$j$::jsonb)`, "writer");
  const base = { branch: null, head: null, by: "hand", recovered: true };
  ins("00000000-0000-4000-8000-0000000000a1", "sweep", { ...base, pr: 1230, merged_at: "2026-10-22T21:22:01Z" }, 1);
  ins("00000000-0000-4000-8000-0000000000a2", "sweep", { ...base, pr: 1231, merged_at: null }, 2);
  ins("00000000-0000-4000-8000-0000000000a3", "loop", { ...base, pr: 1232, merged_at: "2026-10-23T16:00:00Z" }, 3);
  const q = blocks("## 9c. Merges, pull requests and gaps");
  const r = rows(db, q[12]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].repo, r[0].merges, r[0].min_delay, r[0].max_delay], [REPO, 1, "18:53:59", "18:53:59"], "only the sweep row that carries merged_at counts");
});

// The one code-file rule: held once in callum-flow-evaluate, written once in the doc, embedded in each new block.
const RULE_PATHS = {
  "docs/x.md": false, README: true, CHANGELOG: false, "CHANGELOG.txt": false, "a/CHANGELOG.md": false, "a/VERSION": false, VERSION: false,
  "release-notes/v1.md": false, "x/release-notes/v1.txt": false, "sub/package.json": false, "package-lock.json": false, "yarn.lock": false,
  "pnpm-lock.yaml": false, "Cargo.toml": false, "go.sum": false, Gemfile: false, "Gemfile.lock": false, "poetry.lock": false,
  "requirements.txt": false, "requirements-dev.txt": false, "composer.lock": false,
  "src/app.js": true, "src/VERSIONS.js": true, "src/CHANGELOGS.js": true, "my-package.json": true, "src/release-notes.js": true,
  "src/package.json.ts": true, "requirements.py": true, "Cargo.toml.rs": true, "docs/x.md.js": true, "lib/go.mod.js": true,
};

test("the code-file rule is one expression in evaluate, the doc and every new 9c block, and JS and PostgreSQL agree on it", opts, (t) => {
  const literal = NON_CODE_RE.source;
  const rule = doc.slice(doc.indexOf("**What is a code file**"), doc.indexOf("**Issue size**"));
  assert.equal([...rule.matchAll(/```text\n(.*)\n```/g)].map((m) => m[1]).join("|"), literal, "the doc's expression is evaluate's");
  const q = blocks("## 9c. Merges, pull requests and gaps");
  const sql = [8, 9, 10];
  for (const i of sql) {
    const found = [...q[i].matchAll(/!~ '([^']*)'/g)].map((m) => m[1]);
    assert.ok(found.length >= 1, `block #${i} uses the rule`);
    for (const f of found) assert.equal(f, literal, `block #${i} embeds the same literal`);
  }
  assert.ok(!q[11].includes("!~"), "the kind block does not use it");
  const db = createDb(t);
  const paths = Object.keys(RULE_PATHS);
  const out = JSON.parse(db.query(`SELECT json_agg(json_build_object('p', p, 'non', p ~ '${literal}')) FROM unnest(ARRAY[${paths.map((p) => `'${p}'`).join(",")}]) p`, "reader"));
  for (const { p, non } of out) {
    assert.equal(non, !RULE_PATHS[p], `PostgreSQL: ${p}`);
    assert.equal(NON_CODE_RE.test(p), !RULE_PATHS[p], `JS: ${p}`);
  }
  assert.equal(out.length, paths.length);
});
