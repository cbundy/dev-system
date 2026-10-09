// Extracts the ```sql blocks of the "no-mistakes pipeline data" section of docs/metrics.md.
// Shared by tests/metrics-queries.test.js (static check under `npm test`) and
// images/base/test/sections/09-agentsview.sh (execution check against real PostgreSQL), so
// both see exactly the same blocks.
//
// CLI: node tests/metrics-blocks.js <docs/metrics.md> <outdir>
//   writes every block as <outdir>/NN.sql in document order (DDL, example join, saved queries).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

function main(argv) {
  const [doc, out] = argv;
  if (!doc || !out) { process.stderr.write("usage: metrics-blocks.js <metrics.md> <outdir>\n"); return 2; }
  fs.mkdirSync(out, { recursive: true });
  extractBlocks(fs.readFileSync(doc, "utf8")).forEach((b, i) =>
    fs.writeFileSync(path.join(out, `${String(i).padStart(2, "0")}.sql`), `${b.sql}\n`));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { extractBlocks };
