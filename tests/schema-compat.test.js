"use strict";

// Schema compatibility (docs/factory-db.md "Schema compatibility", cbundy/dev-system#886): the factory
// database at head must work for the writers and readers of the last 10 minor releases. Each tag's own
// code writes the same events into a database built by the tag's own bootstrap (A) and into one built
// by head's (B); each of the tag's reads must answer the same on B as on A. The harness is
// tests/lib/schema-compat.js. Needs the release tags in the clone (CI checks out with fetch-depth: 0;
// TEST_REQUIRE_TAGS=1 turns a missing window into a failure) and a PostgreSQL server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");
const sc = require("./lib/schema-compat.js");

const FIXTURE = path.join(__dirname, "fixtures", "schema-compat", "0999_drop_event_log_column.sql");
const HEAD_MIGRATIONS = path.join(sc.ROOT, "images", "base", "factory-db", "migrations");

// ------------------------------------------------------------------------------------- units

test("selectTags keeps the highest patch of each minor and the newest ten minors, newest first", () => {
  const tags = ["v0.1.0", "v0.2.0", "v0.2.1", "v0.2.10", "v0.2.9", "v1.0.0", "v0.3.0"];
  assert.deepEqual(sc.selectTags(tags), ["v1.0.0", "v0.3.0", "v0.2.10", "v0.1.0"]);
  const many = Array.from({ length: 14 }, (_, i) => `v0.${i + 1}.0`);
  assert.deepEqual(sc.selectTags(many), many.slice(4).reverse());
  assert.equal(sc.selectTags(many).length, 10);
  assert.deepEqual(sc.selectTags(many, 3), ["v0.14.0", "v0.13.0", "v0.12.0"]);
});

test("selectTags ignores pre-releases and odd names, and takes fewer than ten when there are fewer", () => {
  assert.deepEqual(sc.selectTags(["v0.5.0", "v0.6.0-rc1", "v0.6.0+build", "0.7.0", "v0.8", "latest", "v0.4.0-beta.2", "v0.5.1"]), ["v0.5.1"]);
  assert.deepEqual(sc.selectTags([]), []);
  assert.deepEqual(sc.selectTags(["nightly"]), []);
});

test("dedupeTags reports a tag with a newer tag's inputs as covered by it and runs the rest", () => {
  const ids = { "v0.5.0": "c", "v0.4.0": "b", "v0.3.0": "b", "v0.2.0": "b", "v0.1.0": "a" };
  const { run, covered } = sc.dedupeTags(["v0.5.0", "v0.4.0", "v0.3.0", "v0.2.0", "v0.1.0"], (t) => ids[t]);
  assert.deepEqual(run, ["v0.5.0", "v0.4.0", "v0.1.0"]);
  assert.deepEqual([...covered], [["v0.3.0", "v0.4.0"], ["v0.2.0", "v0.4.0"]]);
});

test("TEST_REQUIRE_TAGS=1 fails a shallow clone or no tags, naming fetch-depth: 0; without it nothing fails", () => {
  const on = { TEST_REQUIRE_TAGS: "1" };
  assert.match(sc.requireTagsProblem({ shallow: true, tags: ["v0.1.0"], env: on }), /shallow.*fetch-depth: 0/);
  assert.match(sc.requireTagsProblem({ shallow: false, tags: [], env: on }), /no vX\.Y\.Z tag.*fetch-depth: 0/);
  assert.equal(sc.requireTagsProblem({ shallow: false, tags: ["v0.1.0"], env: on }), null);
  assert.equal(sc.requireTagsProblem({ shallow: true, tags: [], env: {} }), null);
});

test("a read with a variable the harness does not set fails naming it, before any database is used", async () => {
  const r = await sc.readOne({ id: "docs/metrics.md \"X #0\"", kind: "sql", sql: "select :'repo', :'x' -- :'comment'\n::text" }, { readerUrl: "unused" }, { at: "2026-01-01T00:00:00Z" });
  assert.match(r.fault, /:'x'/);
  assert.doesNotMatch(r.fault, /comment|:'repo'/);
  assert.deepEqual(sc.unknownVars("select :'repo', :'device', :'at'::timestamptz, :'days'::int, :'since', x::text", { repo: 1, device: 1, at: 1, days: 1, since: 1 }), []);
  const problems = sc.compare("v0.0.1", new Map([[r.id, r]]), new Map());
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /^v0\.0\.1 docs\/metrics\.md "X #0": .*:'x'/);
});

test("a read of the old store or the nomistakes mirror is skipped on A, any other failure on A is a harness fault", () => {
  assert.equal(sc.isOutsideRead('ERROR:  relation "factory.events" does not exist'), true);
  assert.equal(sc.isOutsideRead('ERROR:  relation "nomistakes.runs" does not exist'), true);
  assert.equal(sc.isOutsideRead('ERROR:  schema "nomistakes" does not exist'), true);
  assert.equal(sc.isOutsideRead('ERROR:  column "issue" does not exist'), false);
  const a = new Map([
    ["old", { id: "old", ok: false, outside: true, error: 'relation "factory.events" does not exist' }],
    ["bad", { id: "bad", ok: false, outside: false, error: 'column "zzz" does not exist' }],
  ]);
  const problems = sc.compare("v0.0.1", a, new Map());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^v0\.0\.1 bad: harness fault/);
  assert.equal(sc.skipped(a).length, 1);
});

test("compare: same columns in the same order, identical rows, only row counts for the worker tables", () => {
  const ok = (cols, rows, extra = {}) => ({ id: "x", ok: true, cols, rows, workers: false, ordered: false, ...extra });
  const cmp = (a, b) => sc.compare("v0.0.1", new Map([["x", a]]), new Map([["x", b]]));
  assert.deepEqual(cmp(ok(["a", "b"], [["1", "2"]]), ok(["a", "b"], [["1", "2"]])), []);
  assert.match(cmp(ok(["a", "b"], []), ok(["b", "a"], []))[0], /^v0\.0\.1 x: head schema: columns/);
  assert.match(cmp(ok(["a"], [["1"]]), ok(["a"], [["2"]]))[0], /rows differ/);
  assert.match(cmp(ok(["a"], [["1"]]), { id: "x", ok: false, error: 'ERROR:  column "issue" does not exist' })[0], /^v0\.0\.1 x: head schema: ERROR:  column "issue" does not exist$/);
  // unordered reads compare as sets, ordered reads in order
  assert.deepEqual(cmp(ok(["a"], [["1"], ["2"]]), ok(["a"], [["2"], ["1"]])), []);
  assert.equal(cmp(ok(["a"], [["1"], ["2"]], { ordered: true }), ok(["a"], [["2"], ["1"]], { ordered: true })).length, 1);
  // worker tables: the values depend on the clock
  assert.deepEqual(cmp(ok(["a"], [["1"]], { workers: true }), ok(["a"], [["2"]], { workers: true })), []);
  assert.equal(cmp(ok(["a"], [["1"]], { workers: true }), ok(["a"], [], { workers: true })).length, 1);
  assert.match(cmp({ id: "x", ok: true, state: true, raw: "{}" }, { id: "x", ok: true, state: true, raw: "[]" })[0], /JSON differs/);
});

test("parseCsv reads quoted fields with commas, quotes and newlines", () => {
  assert.deepEqual(sc.parseCsv('a,b\n1,"x,""y""\nz"\n'), [["a", "b"], ["1", 'x,"y"\nz']]);
  assert.deepEqual(sc.parseCsv("a\n"), [["a"]]);
});

test("sqlBlocks names a block by its heading and place, as metrics-queries.test.js does", () => {
  const md = "# T\n## H\n```sql\nselect 1\n```\ntext\n```sql\nselect 2\n```\n## G\n```sql\nselect 3\n```\n";
  assert.deepEqual(sc.sqlBlocks(md).map((b) => b.id), ["H #0", "H #1", "G #0"]);
});

test("the breaking fixture re-creates event_log without issue from information_schema", () => {
  const sql = fs.readFileSync(FIXTURE, "utf8");
  assert.match(sql, /RENAME TO event_log_full/);
  assert.match(sql, /information_schema\.columns/);
  assert.match(sql, /column_name <> 'issue'/);
});

test("cleanEnv({}) resolves no agentsview and no factory database URL (cbundy/dev-system#1056)", () => {
  const { spawnSync } = require("node:child_process");
  const run = (script) => spawnSync("bash", ["-c", `. "${path.join(sc.ROOT, "images", "base", "agentsview.sh")}"; . "${path.join(sc.ROOT, "images", "base", "factory-db.sh")}"; ${script}`], { env: sc.cleanEnv({}), encoding: "utf8" });
  for (const script of ["agentsview_pg_url", "factory_db_url writer"]) {
    const r = run(script);
    assert.equal(r.status, 1, `${script} must return 1, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "", `${script} must print no URL`);
  }
});

// -------------------------------------------------------------------------------- the window

const tags = sc.selectTags(sc.mergedTags());
const shallow = sc.isShallow();
const missing = sc.requireTagsProblem({ shallow, tags });
const skip = !available() ? "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" : missing === null && (shallow || tags.length === 0) ? `no release tags in this clone (shallow: ${shallow}); CI checks out with fetch-depth: 0` : false;

test("the release tags are there when TEST_REQUIRE_TAGS=1", () => {
  assert.equal(missing, null, missing ?? "");
});

// One fixed read time for A and B: after the events were written, so the reads see them.
const AT = new Date(Date.now() + 3600 * 1000).toISOString();

async function selfTest(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-compat-migrations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(HEAD_MIGRATIONS)) fs.copyFileSync(path.join(HEAD_MIGRATIONS, f), path.join(dir, f));
  fs.copyFileSync(FIXTURE, path.join(dir, path.basename(FIXTURE)));
  const newest = tags[0];
  const r = await sc.runTag(t, newest, { createDb, at: AT, migrationsDir: dir });
  assert.equal(r.empty, undefined);
  assert.ok(r.problems.length > 0, "the breaking migration must be reported");
  assert.ok(r.problems.every((p) => p.startsWith(`${newest} `)), r.problems.join("\n"));
  assert.ok(r.problems.some((p) => /callum-flow-factory-state|docs\/metrics\.md|plugins\/factory-loop/.test(p) && /issue/.test(p)), r.problems.join("\n"));
}

test("schema compatibility: head's factory schema and the last 10 minors", { skip, concurrency: true }, async (t) => {
  const { run, covered } = sc.dedupeTags(tags, sc.tagKey);
  for (const [tag, by] of covered) t.diagnostic(`${tag}: covered by ${by} (the same writers, readers and schema inputs)`);
  const pending = run.map((tag) => t.test(tag, async (st) => {
    const r = await sc.runTag(st, tag, { createDb, at: AT });
    if (r.empty !== undefined) {
      st.diagnostic(`skipped: ${r.empty}`);
      return;
    }
    for (const s of r.skipped) st.diagnostic(`non-factory read, skipped: ${s}`);
    st.diagnostic(`${r.readers} reads compared, ${r.withRows} with rows`);
    assert.deepEqual(r.problems, [], `\n${r.problems.join("\n")}`);
  }));
  // The self-test runs beside the tags, to keep the wall time down.
  pending.push(t.test("a migration that drops event_log's issue column fails the newest tag, naming a reader", selfTest));
  await Promise.all(pending);
});

