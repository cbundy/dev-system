// The saved queries of docs/metrics.md after the move to the factory database (dev-system#652).
//
// Static (no database): every ```sql block of the document reads only factory.event_log,
// factory.workers_status or factory.worker_samples, and none uses a construct the shared queries
// ban (docs/factory-events/README.md "View"). Every block is either compared or listed as run-only,
// so a new block cannot slip in unchecked.
//
// Against PostgreSQL (skipped without a server, like the other database tests): the replay corpus
// plus tests/fixtures/metrics-queries/extra-old-rows.jsonl are loaded into an old-format
// `factory.events` store (with empty `nomistakes` tables, so the old queries parse) and, with
// scripts/factory-events-replay.js, into a bootstrap-made factory database. For each rewritten
// query the frozen old query (tests/fixtures/metrics-queries/old/) runs on the old store and the
// document's query on the new one, and the answers must agree: same rows, the same counts, flags and
// outcomes, stage times within the 120 seconds the translator allows between an old line and the
// transition that replaces it. Each difference the rewrite makes is named below with its reason; a
// difference that is not named fails. Deleted with the old event path (#656).
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");
const { oldStore } = require("./lib/factory-events-old.js");
const { psql } = require("../scripts/factory-events-replay/pg.js");
const { extractRunLink } = require("./metrics-blocks.js");
const { ddl: nomistakesDdl } = require("../images/base/nm-export");

const ROOT = path.join(__dirname, "..");
const DOC = path.join(ROOT, "docs", "metrics.md");
const FIXTURES = path.join(__dirname, "fixtures", "metrics-queries");
const CLI = path.join(ROOT, "scripts", "factory-events-replay.js");
const ADMIN = process.env.FACTORY_TEST_PG_ADMIN_URL;
const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };
const SINCE = "2026-10-16T02:00:00Z";
// An old line and the transition that replaces it are at most this far apart (translator.md).
const BOUNDARY = 120;

const markdown = fs.readFileSync(DOC, "utf8");

// ---------------------------------------------------------------------------------- the blocks

// Every sql block of the document as { id, heading, sql }: the id is the nearest heading's text and
// the block's place under it ("8. Implementer model comparison #1").
function sqlBlocks(md) {
  const out = [];
  const count = {};
  let heading = "";
  let fence = null;
  for (const l of md.split("\n")) {
    if (fence === null && /^#{1,6} /.test(l)) heading = l.replace(/^#+ /, "").trim();
    if (fence === null && /^```sql\s*$/.test(l)) fence = [];
    else if (fence !== null && /^```\s*$/.test(l)) {
      const n = (count[heading] = (count[heading] ?? -1) + 1);
      out.push({ id: `${heading} #${n}`, heading, sql: fence.join("\n") });
      fence = null;
    } else if (fence !== null) fence.push(l);
  }
  assert.equal(fence, null, "unterminated sql block in docs/metrics.md");
  return out;
}

// Drops comments and string literals, so a word in either is never read as SQL.
const strip = (sql) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");

const READABLE = new Set(["event_log", "workers_status", "worker_samples"]);
const BANNED = [
  [/\bnomistakes\b/i, "reads the nomistakes mirror"],
  [/\bnote\b/i, "reads the old note column"],
  [/@>/, "uses @>"],
  [/\bDISTINCT\s+ON\b/i, "uses DISTINCT ON"],
  [/\bpercentile_cont\b/i, "uses percentile_cont"],
  [/\bpercentile_disc\b/i, "uses percentile_disc"],
  [/\bmedian\b/i, "uses median"],
];

// Problems of one block, as readable strings (empty when it is clean).
// 6b reads `detail`, and the split query `split_into`, fields no event_log column lifts, from factory.event_store; 6b has its own test
// (tests/metrics-shadow-read.test.js) runs it as the reader role.
// 7a reads the transition's `wait` list (its conditions' repos) from event_store the same way.
// The startup migrates read the loop_entry's migrate fields (database, versions, outcome) from event_store: no event_log column lifts them.
const READS_EVENT_STORE = new Set(["6b. Reader shadow compares #0", "Split trackers closed by the loop #0", "7a. How waits end #0", "Startup schema migrates #0"]);

function problems(sql, id) {
  const text = strip(sql);
  const out = [];
  for (const [re, why] of BANNED) if (re.test(text)) out.push(why);
  for (const m of text.matchAll(/\bfactory\.([a-z_][a-z0-9_]*)/gi)) {
    const name = m[1].toLowerCase();
    if (name === "event_store" && READS_EVENT_STORE.has(id)) continue;
    if (!READABLE.has(name)) out.push(`reads factory.${m[1]}`);
  }
  return out;
}

const blocks = sqlBlocks(markdown);

// Blocks that are compared against a frozen old query (SPECS below) and blocks that are only run.
const RUN_ONLY = [
  "Factory metrics #0", "Fix rounds with no new head #0",
  "2b. Gate waits #0", "2b. Gate waits #1", "2b. Gate waits #2",
  "6b. Reader shadow compares #0",
  "7a. How waits end #0", "7b. Done closes #0",
  "Split trackers closed by the loop #0", "Split children parked on their open decision #0",
  "2c. Wind-downs #0", "2c. Wind-downs #1", "2c. Wind-downs #2", "2c. Wind-downs #3",
  "2d. Flaky tests #0", "2d. Flaky tests #1",
  "9. Interventions, judgement calls and claim completion #5",
  "9. Interventions, judgement calls and claim completion #6", "9. Interventions, judgement calls and claim completion #7",
  "9b. Permission prompts #0",
  "10. Releases #0", "10. Releases #1", "10. Releases #2",
  "Main after merge #0", "Main after merge #1",
  "Workers #0", "Workers #1", "Workers #2", "Workers #3",
  "Startup schema migrates #0",
];

test("every sql block of docs/metrics.md reads only the factory database's views", () => {
  assert.ok(blocks.length > 0, "docs/metrics.md has sql blocks");
  for (const b of blocks) assert.deepEqual(problems(b.sql, b.id), [], b.id);
});

test("the static check catches what it bans", () => {
  assert.deepEqual(problems("SELECT 1 FROM factory.event_log"), []);
  assert.deepEqual(problems("SELECT * FROM factory.events"), ["reads factory.events"]);
  assert.deepEqual(problems("SELECT 1 FROM nomistakes.runs r"), ["reads the nomistakes mirror"]);
  assert.deepEqual(problems("SELECT note FROM factory.event_log"), ["reads the old note column"]);
  assert.deepEqual(problems("SELECT DISTINCT ON (a) a FROM factory.event_log"), ["uses DISTINCT ON"]);
  assert.deepEqual(problems("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM factory.event_log"), ["uses percentile_cont"]);
  assert.deepEqual(problems("SELECT 1 FROM factory.event_log WHERE data @> '{}'"), ["uses @>"]);
  assert.deepEqual(problems("SELECT 1 FROM factory.event_log -- the note and the median, 'note'"), []);
});

test("the moved run link is in docs/factory-state.md and the nomistakes section is gone from metrics.md", () => {
  assert.match(extractRunLink(fs.readFileSync(path.join(ROOT, "docs", "factory-state.md"), "utf8")), /^WITH run_link AS/);
  for (const gone of ["## 5. Adjudicator agreement", "## Linking pipeline runs to issues", "## no-mistakes pipeline data"]) {
    assert.ok(!markdown.includes(gone), `${gone} is still in docs/metrics.md`);
  }
});

// ---------------------------------------------------------------------- the compare, per query

// A spec compares the document's block `id` with a frozen old query. `key` names the columns that
// identify a row. Every other column is exact unless named:
//   within    { col: seconds }       times and intervals that may differ by that much
//   renamed   { oldCol: newCol }     the same value under a new name (compared as `within`/exact of the new name)
//   onlyOld   { col: reason }        a column only the old query has
//   onlyNew   { col: reason }        a column only the new query has
//   differs   { col: reason }        the same name with a new meaning: not compared (oldNull: the old value is null)
//   values    { col: [[old, new]] }  value pairs the rewrite changes; each must be seen at least once
//   prepOld   (rows) => rows         the old rows brought to the new grain (a dropped column)
//   tail      name                   both queries cut to a read of the CTE of that name (rows instead of the aggregate)
//   expect    (rows) => void         what the fixture must reach, so that the agreement is not of empty answers
const SPECS = [
  {
    id: "1. Lead time by stage #0", old: "01-lead-time.sql", key: ["repo", "issue"],
    expect: (rs) => assert.ok(rs.some((r) => r.waiting_for_merge !== null && r.review !== null), "merged issues with every stage"),
    within: { design: BOUNDARY, waiting_for_merge: BOUNDARY },
    differs: { implementation: "old: delegated to the first linked run, null without the mirror; new: building to reviewing" },
    onlyOld: { pipeline: "the first linked run to merge_ready, read from the mirror" },
    onlyNew: { review: "reviewing to merge-queue" },
    oldNull: ["implementation", "pipeline"],
  },
  {
    id: "2. First-pass gate pass rate #0", old: "02-first-pass.sql", key: ["repo"],
    expect: (rs) => assert.ok(rs.some((r) => r.first_pass > 0 && r.first_pass < r.reached_green), "a repo with issues that had a setback and some that had none"),
  },
  {
    id: "3. Reviewer false-positive rate #0", old: "03-false-positive.sql", key: ["repo"],
    expect: (rs) => assert.ok(rs.some((r) => r.fixed > 0 && r.declined > 0), "fixed and declined findings"),
    renamed: { correct: "fixed", wrong: "declined" },
  },
  {
    id: "4. Merges per device #0", old: "04-merges-per-device.sql", key: ["device", "week"],
    expect: (rs) => assert.ok(new Set(rs.map((r) => r.device)).size >= 2, "merges on two devices"),
  },
  {
    id: "5b. Tests deleted or weakened by auto-fixes #0", old: "05b-tests-weakened.sql", key: ["repo"],
    expect: (rs) => assert.ok(rs.some((r) => r.unrestored > 0) && rs.some((r) => r.commits > r.unrestored), "restored and unrestored commits"),
    onlyOld: { step: "the translator drops test_weakened.step, so the new query groups by repo only" },
    prepOld: (rows) => {
      const by = new Map();
      for (const r of rows) {
        const o = by.get(r.repo) ?? { repo: r.repo, commits: 0, unrestored: 0 };
        o.commits += r.commits;
        o.unrestored += r.unrestored;
        by.set(r.repo, o);
      }
      return [...by.values()];
    },
  },
  {
    id: "6. Double-claims, lost claim races and stuck issues #0", old: "06a-double-claims.sql", key: ["repo", "issue", "first_device", "second_device", "at"],
    expect: (rs) => assert.equal(rs.length, 1, "one double-claim: two devices, no release between"),
  },
  {
    id: "6. Double-claims, lost claim races and stuck issues #1", old: "06b-lost-races.sql", key: ["device"],
    expect: (rs) => assert.ok(rs.some((r) => r.claim_lost > 0) && rs.some((r) => r.requeued > 0), "lost races and requeues"),
    renamed: { reclaimed: "requeued" },
  },
  {
    id: "7. The waiting split #0", old: "07-waiting-split.sql", key: ["repo", "issue"],
    expect: (rs) => assert.ok(rs.some((r) => r.dispatcher_bound_other_idle > 0 && r.dispatcher_bound_other_idle < r.dispatcher_bound) && rs.some((r) => r.dispatcher_bound_other_idle === 0), "time with another device idle, partly and not at all"),
    // Four boundaries move at most 120 s each: a park or merge-queue entry starts and ends at a transition.
    within: { dispatcher_bound: 4 * BOUNDARY, dispatcher_bound_other_idle: 4 * BOUNDARY, agent_work: 4 * BOUNDARY },
    onlyOld: { pipeline_bound: "the linked runs of the mirror" },
    oldZero: ["pipeline_bound"],
  },
  {
    id: "8. Implementer model comparison #1", old: "08-implementer-model.sql", key: ["model"],
    expect: (rs) => assert.deepEqual(rs.map((r) => r.model), ["opus", "sonnet"]),
    onlyOld: {
      implementation_p50_s: "medians are taken in code from block (a)",
      pipeline_p50_s: "medians are taken in code from block (a)",
      total_p50_s: "medians are taken in code from block (a)",
      runs_per_merged: "pipeline runs of the mirror",
      auto_fix_rounds_per_merged: "pipeline rounds of the mirror",
      failed_steps_per_merged: "pipeline steps of the mirror",
      parked_s_per_merged: "pipeline parked time of the mirror",
      pipeline_tokens_per_merged: "pipeline tokens of the mirror",
    },
  },
  {
    id: "8. Implementer model comparison #0", old: "08-implementer-model.sql", key: ["repo", "issue"],
    expect: (rs) => assert.ok(rs.some((r) => r.fix_requests > 0) && rs.some((r) => r.abandoned) && rs.some((r) => r.setback_at === null) && rs.some((r) => r.merged_at !== null), "fixed, abandoned, clean and merged issues"),
    tail: "per_issue",
    within: { green_at: BOUNDARY, setback_at: BOUNDARY },
    renamed: { delegated_at: "building_at" },
    withinRenamed: { delegated_at: BOUNDARY },
    onlyOld: {
      first_run_at: "pipeline runs of the mirror", runs: "pipeline runs of the mirror",
      failed_steps: "pipeline steps of the mirror", auto_fix_rounds: "pipeline rounds of the mirror",
      parked_ms: "pipeline parked time of the mirror", tokens: "pipeline tokens of the mirror",
    },
    onlyNew: { reviewing_at: "the first transition to reviewing after the route" },
    // The v2 loop logs the route after the transition to building, so building_at is not clipped to the
    // route as delegated_at was: it is compared only where the old line came after the route.
    skipWhenOldNull: ["delegated_at"],
  },
  {
    id: "9. Interventions, judgement calls and claim completion #0", old: "09a-interventions-per-day.sql", key: ["repo", "day", "who", "cause"],
    expect: (rs) => assert.ok(rs.some((r) => r.fleet > 0) && rs.some((r) => r.who === "person") && rs.some((r) => r.who === "loop"), "fleet-level, person and loop interventions"),
  },
  {
    id: "9. Interventions, judgement calls and claim completion #1", old: "09b-interventions-per-issue.sql", key: ["repo", "issue"],
    expect: (rs) => assert.ok(rs.some((r) => r.untouched) && rs.some((r) => !r.untouched && r.person > 0) && rs.some((r) => r.loop > 0), "untouched and touched merges"),
    onlyNew: { judge: "interventions by the loop's judge (who=judge), which the old query does not count" },
  },
  {
    id: "9. Interventions, judgement calls and claim completion #2", old: "09c-judgement-calls.sql", key: ["repo", "kind", "outcome"],
    expect: (rs) => assert.ok(["review", "triage", "design", "fix"].every((k) => rs.some((r) => r.kind === k)) && rs.some((r) => r.overridden > 0), "every kind of call, one overridden"),
  },
  {
    id: "9. Interventions, judgement calls and claim completion #3", old: "09d-claim-completion.sql", key: ["repo"],
    expect: (rs) => assert.ok(rs.some((r) => r.merged > 0 && r.open > 0 && r.merged_pct_of_resolved < 100), "merged and open claims"),
  },
  {
    id: "9. Interventions, judgement calls and claim completion #3", label: "rows", old: "09d-claim-completion.sql", key: ["repo", "issue", "claimed_at"],
    tail: "completion",
    expect: (rs) => assert.ok(["merged", "open", "parked", "released"].every((o) => rs.some((r) => r.outcome === o)) && rs.some((r) => /^abandoned:/.test(r.outcome)), "every way a claim ends"),
    // The translator names two abandoned shapes the old note did not: a rejected issue (old: reason
    // reconcile) and a plain "split into" note (old: no reason token, so unknown).
    values: { outcome: [["abandoned:reconcile", "abandoned:rejected"], ["abandoned:unknown", "abandoned:split"]] },
  },
  {
    id: "9. Interventions, judgement calls and claim completion #4", old: "09e-rounds.sql", key: ["repo", "issue"],
    within: { in_flight_s: BOUNDARY },
    expect: (rs) => assert.ok(rs.some((r) => r.fix_rounds > 0) && rs.some((r) => r.review_rounds > 1), "fix and review rounds"),
  },
];

// The final SELECT of a query replaced by a read of one of its CTEs, so a CTE can be compared row by row.
const TAILS = {
  per_issue: [/\nSELECT model,[\s\S]*$/, "\nSELECT * FROM per_issue ORDER BY repo, issue"],
  completion: [/\nSELECT repo,\n {2}count\(\*\)[\s\S]*$/, "\nSELECT repo, issue, device, claimed_at, outcome FROM completion ORDER BY repo, issue, claimed_at"],
};
// The new block (a) of query 8 is already one row per issue, so only the old side is cut.
const cutTail = (sql, name, side) => {
  if (side === "new" && name === "per_issue") return sql;
  const [re, to] = TAILS[name];
  const out = sql.replace(re, to);
  assert.notEqual(out, sql, `the ${side} query has no final SELECT to cut for ${name}`);
  return out;
};

const stripSemicolon = (sql) => sql.trim().replace(/;\s*$/, "");

// Runs a query in a read-only way and gives its rows as objects. The query is wrapped as a subquery,
// so ORDER BY and WITH stay valid; the order is not relied on.
function rows(url, sql, role) {
  const wrapped = `SELECT coalesce(json_agg(t), '[]'::json) FROM (\n${stripSemicolon(sql)}\n) t;`;
  const out = psql(url, `\\set QUIET on\n\\set ON_ERROR_STOP on\n${role ? `SET ROLE "${role}";\n` : ""}${wrapped}\n`);
  return JSON.parse(out.trim());
}

// A value as seconds when it is an interval ("1 day 00:02:00", "00:04:00") or a timestamp.
function seconds(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const iv = /^(?:(-?\d+) days? )?(-?)(\d+):(\d\d):(\d\d(?:\.\d+)?)$/.exec(v);
  if (iv) return (Number(iv[1] ?? 0) * 86400 + (iv[2] ? -1 : 1) * (Number(iv[3]) * 3600 + Number(iv[4]) * 60 + Number(iv[5])));
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t / 1000;
}

const keyOf = (row, key) => JSON.stringify(key.map((k) => row[k]));

// The differences between an old and a new answer, as strings (empty when they agree).
function compare(spec, oldRows, newRows) {
  const found = [];
  const named = (o) => Object.keys(o ?? {});
  const oldCols = new Set(oldRows.flatMap((r) => Object.keys(r)));
  const newCols = new Set(newRows.flatMap((r) => Object.keys(r)));
  if (spec.prepOld) {
    for (const c of named(spec.onlyOld)) if (!oldCols.has(c)) found.push(`onlyOld column ${c} is not in the old answer`);
    oldRows = spec.prepOld(oldRows);
    for (const c of named(spec.onlyOld)) oldCols.delete(c);
  }
  const renamed = spec.renamed ?? {};
  for (const [from, to] of Object.entries(renamed)) {
    if (!oldCols.has(from)) found.push(`renamed column ${from} is not in the old answer`);
    if (!newCols.has(to)) found.push(`renamed column ${to} is not in the new answer`);
  }
  const listedOld = new Set([...named(spec.onlyOld), ...Object.keys(renamed)]);
  const listedNew = new Set([...named(spec.onlyNew), ...Object.values(renamed)]);
  for (const c of oldCols) if (!newCols.has(c) && !listedOld.has(c)) found.push(`column ${c} is only in the old answer and not named`);
  for (const c of newCols) if (!oldCols.has(c) && !listedNew.has(c)) found.push(`column ${c} is only in the new answer and not named`);
  for (const c of named(spec.onlyOld)) if (newCols.has(c) && !spec.prepOld) found.push(`onlyOld column ${c} is in the new answer`);
  for (const c of named(spec.onlyNew)) if (oldCols.has(c)) found.push(`onlyNew column ${c} is in the old answer`);

  const oldBy = new Map(oldRows.map((r) => [keyOf(r, spec.key), r]));
  const newBy = new Map(newRows.map((r) => [keyOf(r, spec.key), r]));
  assert.equal(oldBy.size, oldRows.length, `${spec.id}: the old key ${spec.key} is not unique`);
  assert.equal(newBy.size, newRows.length, `${spec.id}: the new key ${spec.key} is not unique`);
  for (const k of oldBy.keys()) if (!newBy.has(k)) found.push(`row ${k} is only in the old answer`);
  for (const k of newBy.keys()) if (!oldBy.has(k)) found.push(`row ${k} is only in the new answer`);

  const seenValues = new Set();
  const compared = {};
  for (const [k, o] of oldBy) {
    const n = newBy.get(k);
    if (!n) continue;
    for (const c of oldCols) {
      if (spec.key.includes(c) || listedOld.has(c) && !renamed[c]) continue;
      const to = renamed[c] ?? c;
      if (named(spec.differs).includes(c)) continue;
      const ov = o[c];
      const nv = n[to];
      if (spec.skipWhenOldNull?.includes(c)) {
        if (ov === null) continue;
        compared[c] = (compared[c] ?? 0) + 1;
      }
      const tol = spec.withinRenamed?.[c] ?? spec.within?.[to] ?? spec.within?.[c];
      if (tol !== undefined) {
        const a = seconds(ov);
        const b = seconds(nv);
        if (a === null || b === null) {
          if (a !== b) found.push(`${k} ${c}: old ${ov} new ${nv}`);
        } else if (Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) > tol) found.push(`${k} ${c}: old ${ov} new ${nv} (more than ${tol} s apart)`);
      } else if (JSON.stringify(ov) !== JSON.stringify(nv)) {
        const pair = (spec.values?.[to] ?? []).find(([a, b]) => a === ov && b === nv);
        if (pair) seenValues.add(`${to}:${pair.join(">")}`);
        else found.push(`${k} ${c}: old ${JSON.stringify(ov)} new ${JSON.stringify(nv)}`);
      }
    }
  }
  for (const c of spec.skipWhenOldNull ?? []) if (!compared[c]) found.push(`${c} was null in every old row, so it was never compared`);
  for (const [col, pairs] of Object.entries(spec.values ?? {})) {
    for (const p of pairs) if (!seenValues.has(`${col}:${p.join(">")}`)) found.push(`the named difference ${col} ${p.join(" -> ")} never happened in the fixture`);
  }
  return found;
}

// ------------------------------------------------------------------------ the database tests

const corpusRows = (file) => fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const corpus = corpusRows(path.join(__dirname, "fixtures", "factory-events-replay", "old-rows.jsonl"));
const extra = corpusRows(path.join(FIXTURES, "extra-old-rows.jsonl"));

function load(oldDb, dest, dir) {
  const out = path.join(dir, "check.json");
  const r = spawnSync("node", [CLI, "load", "--db", dest.name, "--since", SINCE, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_DB_ADMIN_URL: ADMIN, FACTORY_REPLAY_OLD_URL: oldDb.url },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

test("every sql block is compared with its frozen old query or run as is", () => {
  const ids = new Set(blocks.map((b) => b.id));
  const listed = [...SPECS.map((s) => s.id), ...RUN_ONLY];
  for (const id of listed) assert.ok(ids.has(id), `${id} is listed but docs/metrics.md has no such block`);
  for (const b of blocks) assert.ok(listed.includes(b.id), `${b.id} is neither compared nor listed as run-only: add it to SPECS or RUN_ONLY`);
  for (const s of SPECS) assert.ok(fs.existsSync(path.join(FIXTURES, "old", s.old)), s.old);
});

test("query 8 (b) starts from the CTEs of (a)", () => {
  const [a, b] = ["8. Implementer model comparison #0", "8. Implementer model comparison #1"].map((id) => blocks.find((x) => x.id === id).sql);
  const prefix = a.slice(0, a.indexOf("\nSELECT x.repo"));
  assert.ok(prefix.startsWith("WITH routed AS"), "block (a) starts with its CTEs");
  assert.ok(b.includes(prefix.replace(/\)\s*$/, "").trimEnd()), "block (b) repeats the routed, tr and ev CTEs of block (a)");
});

test("the document's queries answer as the old queries did on the same events", opts, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mq-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = oldStore(t, [...corpus, ...extra]);
  psql(old.url, nomistakesDdl());
  const dest = createDb(t);
  const check = load(old, dest, dir);
  assert.equal(check.pass, true);
  assert.deepEqual(check.failures, []);
  assert.equal(check.total.misses, 0);
  assert.equal(check.total.lines, corpus.length + extra.length);
  // the loop reads with the reader role, so the compare does too
  const reader = `${dest.name}_reader`;
  const runNew = (sql) => rows(dest.url, sql, reader);
  const runOld = (sql) => rows(old.url, sql);

  for (const spec of SPECS) {
    await t.test(`${spec.id}${spec.label ? ` (${spec.label})` : ""} answers as ${spec.old} does`, () => {
      const block = blocks.find((b) => b.id === spec.id);
      let oldSql = fs.readFileSync(path.join(FIXTURES, "old", spec.old), "utf8");
      let newSql = block.sql;
      if (spec.tail) {
        oldSql = cutTail(oldSql, spec.tail, "old");
        newSql = cutTail(newSql, spec.tail, "new");
      }
      const oldRows = runOld(oldSql);
      const newRows = runNew(newSql);
      assert.ok(oldRows.length > 0, "the old query returned no rows, so the compare would prove nothing");
      assert.ok(newRows.length > 0, "the new query returned no rows");
      spec.expect?.(newRows);
      for (const c of spec.oldNull ?? []) assert.ok(oldRows.every((r) => r[c] === null), `old ${c} should be null without the mirror`);
      for (const c of spec.oldZero ?? []) assert.ok(oldRows.every((r) => Number(r[c]) === 0), `old ${c} should be 0 without the mirror`);
      assert.deepEqual(compare(spec, oldRows, newRows), []);
    });
  }

  await t.test("every run-only block runs as the reader, with its variables set", () => {
    for (const id of RUN_ONLY) {
      const sql = blocks.find((b) => b.id === id).sql;
      const vars = "\\set repo cbundy/dev-system-scratch\n\\set since 2026-10-01T00:00:00Z\n";
      psql(dest.url, `\\set QUIET on\n\\set ON_ERROR_STOP on\n${vars}SET ROLE "${reader}";\n${stripSemicolon(sql)};\n`);
    }
  });

  await t.test("the compare bites: one changed event in the new store only is reported", () => {
    const quiet = (sql) => dest.query(sql);
    // a finding declined in the old store counted fixed in the new one
    const q3 = SPECS.find((s) => s.id.startsWith("3."));
    const oldRows = runOld(fs.readFileSync(path.join(FIXTURES, "old", q3.old), "utf8"));
    const sql = blocks.find((b) => b.id === q3.id).sql;
    assert.deepEqual(compare(q3, oldRows, runNew(sql)), []);
    quiet("UPDATE factory.event_store SET data = jsonb_set(data, '{outcome}', '\"fixed\"') WHERE type = 'finding_handled' AND data->>'outcome' = 'declined'");
    const diffs = compare(q3, oldRows, runNew(sql));
    assert.ok(diffs.some((d) => /declined|wrong/.test(d)), `the changed outcome was not reported: ${JSON.stringify(diffs)}`);
    // and a merge moved an hour later breaks the lead time's total
    const q1 = SPECS[0];
    const old1 = runOld(fs.readFileSync(path.join(FIXTURES, "old", q1.old), "utf8"));
    const sql1 = blocks.find((b) => b.id === q1.id).sql;
    assert.deepEqual(compare(q1, old1, runNew(sql1)), []);
    quiet("UPDATE factory.event_store SET ts = ts + interval '1 hour' WHERE type = 'merged' AND issue = 62");
    const d1 = compare(q1, old1, runNew(sql1));
    assert.ok(d1.some((d) => /total/.test(d) || /waiting_for_merge/.test(d)), `the moved merge was not reported: ${JSON.stringify(d1)}`);
  });
});
