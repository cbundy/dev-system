// Extracts the ```sql blocks of docs/metrics.md that read the `nomistakes` mirror: the whole
// "no-mistakes pipeline data" section, plus the two queries outside it that use the run link
// (TOP_QUERIES, cbundy/dev-system#343).
// Shared by tests/metrics-queries.test.js (static check under `npm test`) and
// images/base/test/sections/09-agentsview.sh (execution check against real PostgreSQL), so
// both see exactly the same blocks.
//
// CLI: node tests/metrics-blocks.js <docs/metrics.md> <outdir>
//   writes every block as <outdir>/NN.sql: the nomistakes section in document order (DDL, example
//   join, saved queries), then the TOP_QUERIES blocks (lead time by stage, the waiting split).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Queries outside the nomistakes section that join to it. Listed by heading, not matched by a wider
// pattern, because queries 2 to 6 would each need their own fixtures.
const TOP_QUERIES = ["1. Lead time by stage", "7. The waiting split"];
const LINK_SECTION = "Linking pipeline runs to issues";
const SECTION = /^## no-mistakes pipeline data \(`nomistakes` schema\)\s*$/;

// [{ heading, sql }] in document order; `heading` is the nearest `###` or deeper heading above the
// block ("" for the example join before the first one).
function extractBlocks(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start < 0) throw new Error("metrics.md: the no-mistakes pipeline data section is missing");
  const blocks = [];
  let heading = "";
  let fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (fence === null && /^## /.test(l)) break;
    if (fence === null && /^###+ /.test(l)) heading = l.replace(/^###+ /, "").trim();
    if (fence === null && /^```sql\s*$/.test(l)) fence = [];
    else if (fence !== null && /^```\s*$/.test(l)) { blocks.push({ heading, sql: fence.join("\n") }); fence = null; }
    else if (fence !== null) fence.push(l);
  }
  if (fence !== null) throw new Error("metrics.md: unterminated sql block in the nomistakes section");
  return blocks;
}

// The sql blocks under one `## <heading>` of the document, as [{ heading, sql }].
function blocksUnder(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.replace(/^## /, "").trim() === heading && /^## /.test(l));
  if (start < 0) throw new Error(`metrics.md: the "${heading}" section is missing`);
  const blocks = [];
  let fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (fence === null && /^## /.test(l)) break;
    if (fence === null && /^```sql\s*$/.test(l)) fence = [];
    else if (fence !== null && /^```\s*$/.test(l)) { blocks.push({ heading, sql: fence.join("\n") }); fence = null; }
    else if (fence !== null) fence.push(l);
  }
  if (fence !== null) throw new Error(`metrics.md: unterminated sql block under "${heading}"`);
  return blocks;
}

// The queries of TOP_QUERIES, one block each.
function extractTopQueries(markdown) {
  return TOP_QUERIES.map((h) => {
    const b = blocksUnder(markdown, h);
    if (b.length !== 1) throw new Error(`metrics.md: expected one sql block under "${h}", found ${b.length}`);
    return b[0];
  });
}

// The canonical run_link CTE: the block of the link section up to the query that follows it.
function extractRunLink(markdown) {
  const b = blocksUnder(markdown, LINK_SECTION);
  if (b.length !== 1) throw new Error(`metrics.md: expected one sql block under "${LINK_SECTION}", found ${b.length}`);
  const m = /^WITH run_link AS \([\s\S]*?\n\)(?=\n|$)/.exec(b[0].sql);
  if (!m) throw new Error("metrics.md: the run_link CTE is missing from the link section");
  return m[0];
}

function main(argv) {
  const [doc, out] = argv;
  if (!doc || !out) { process.stderr.write("usage: metrics-blocks.js <metrics.md> <outdir>\n"); return 2; }
  fs.mkdirSync(out, { recursive: true });
  const md = fs.readFileSync(doc, "utf8");
  [...extractBlocks(md), ...extractTopQueries(md)].forEach((b, i) =>
    fs.writeFileSync(path.join(out, `${String(i).padStart(2, "0")}.sql`), `${b.sql}\n`));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { extractBlocks, extractTopQueries, extractRunLink, TOP_QUERIES };
