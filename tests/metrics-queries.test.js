// Static check of the saved queries in docs/metrics.md (cbundy/dev-system#275): every sql block
// in the "no-mistakes pipeline data" section, and the two top-level queries that join to it
// (lead time by stage, the waiting split; cbundy/dev-system#343), may only name `nomistakes` tables and
// `alias.column` references that exist in nm-export's schema, so a change to the mirror's
// columns fails here instead of silently breaking a documented query. The execution check
// (the same blocks against real PostgreSQL) is section 9 of images/base/test.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { extractBlocks, extractTopQueries, extractRunLink, TOP_QUERIES } = require("./metrics-blocks");
const { TABLES } = require("../images/base/nm-export");

const DOC = path.join(__dirname, "..", "docs", "metrics.md");
// Columns every mirrored table has besides the source ones (nm-export ddl()).
const EXTRA = ["device", "repo", "raw"];
const KEYWORDS = new Set(["where", "join", "left", "right", "inner", "outer", "full", "cross", "on", "using", "group",
  "order", "limit", "having", "union", "window", "lateral", "natural", "except", "intersect", "offset", "fetch", "set", "as"]);

const columnsOf = (table) => new Set([...Object.keys(TABLES[table].cols), ...EXTRA]);

// Drops comments and string literals so `'a.b'` or `-- r.x` is never read as a reference.
const strip = (sql) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");

// Problems found in one query, as readable strings (empty when it is clean).
function problems(sql) {
  const text = strip(sql);
  const out = [];
  const alias = new Map(); // alias -> table
  const re = /\bnomistakes\.([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  for (let m; (m = re.exec(text));) {
    const table = m[1].toLowerCase();
    if (!TABLES[table]) { out.push(`unknown table nomistakes.${table}`); continue; }
    const a = m[2] && !KEYWORDS.has(m[2].toLowerCase()) ? m[2].toLowerCase() : null;
    if (!a) { out.push(`nomistakes.${table} has no alias; qualify its columns with one`); continue; }
    if (alias.has(a) && alias.get(a) !== table) out.push(`alias ${a} is used for both ${alias.get(a)} and ${table}`);
    alias.set(a, table);
  }
  const ref = /(?<![\w.])([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
  for (let m; (m = ref.exec(text));) {
    const a = m[1].toLowerCase();
    const table = alias.get(a);
    if (table && !columnsOf(table).has(m[2].toLowerCase())) out.push(`${a}.${m[2]} is not a column of nomistakes.${table}`);
  }
  return out;
}

const markdown = fs.readFileSync(DOC, "utf8");
const blocks = extractBlocks(markdown);
// The DDL block creates the tables; the rest are queries.
const queries = blocks.filter((b) => !/^\s*CREATE\b/i.test(b.sql));
const top = extractTopQueries(markdown);
const RUN_LINK = extractRunLink(markdown);

test("the nomistakes section holds the example join, the seven saved queries and the unlinked-runs query", () => {
  assert.equal(queries.length, 9, `expected 9 query blocks, found ${queries.length}`);
  const saved = queries.filter((b) => /^\d+\./.test(b.heading));
  assert.equal(saved.length, 7);
  assert.deepEqual(saved.map((b) => b.heading.split(".")[0]), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(queries[queries.length - 1].heading, "Unlinked runs");
});

test("the top-level queries that join to the mirror are the two the link was added to", () => {
  assert.deepEqual(top.map((b) => b.heading), TOP_QUERIES);
});

// Every query that places a run on an issue starts from the one CTE in the link section.
for (const b of [...top, ...queries.filter((q) => /run_link/.test(q.sql) || q.heading === "" || /^(7\.|Unlinked)/.test(q.heading))]) {
  test(`metrics.md query "${b.heading || "example join"}" uses the canonical run_link CTE verbatim`, () => {
    assert.ok(b.sql.includes(RUN_LINK), "the run_link CTE differs from the one in 'Linking pipeline runs to issues'");
    // outside the legacy link, no query reads an agent-logged run_started timestamp
    if (b.heading !== "7. The waiting split") assert.ok(!/run_started/.test(b.sql.replace(RUN_LINK, "")), "reads run_started");
  });
}

for (const b of [...queries, ...top]) {
  test(`metrics.md query "${b.heading || "example join"}" only names columns that exist`, () => {
    assert.deepEqual(problems(b.sql), []);
  });
}

test("the check catches drift", () => {
  assert.deepEqual(problems("SELECT r.statuss FROM nomistakes.runs r"), ["r.statuss is not a column of nomistakes.runs"]);
  assert.deepEqual(problems("SELECT 1 FROM nomistakes.nope n"), ["unknown table nomistakes.nope"]);
  assert.match(problems("SELECT status FROM nomistakes.runs WHERE 1 = 1")[0], /no alias/);
  assert.deepEqual(problems("SELECT r.id, r.device FROM nomistakes.runs AS r -- r.bogus 'r.bogus'"), []);
});
