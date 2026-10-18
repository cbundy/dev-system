// Helpers that pull ```sql blocks out of the repo's markdown:
//   blocksUnder(markdown, heading)  the sql blocks under one `## <heading>`
//   extractRunLink(markdown)        the canonical run_link CTE of docs/factory-state.md, which
//                                   callum-flow-factory-state still copies (tests/factory-state.test.js)
// Used by tests/metrics-queries.test.js and tests/factory-state.test.js.
"use strict";

const LINK_SECTION = "Linking pipeline runs to issues";

// The sql blocks under one `## <heading>` of the document, as [{ heading, sql }].
function blocksUnder(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^## /.test(l) && l.replace(/^## /, "").trim() === heading);
  if (start < 0) throw new Error(`the "${heading}" section is missing`);
  const blocks = [];
  let fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (fence === null && /^## /.test(l)) break;
    if (fence === null && /^```sql\s*$/.test(l)) fence = [];
    else if (fence !== null && /^```\s*$/.test(l)) { blocks.push({ heading, sql: fence.join("\n") }); fence = null; }
    else if (fence !== null) fence.push(l);
  }
  if (fence !== null) throw new Error(`unterminated sql block under "${heading}"`);
  return blocks;
}

// The canonical run_link CTE: the block of the link section up to the query that follows it.
function extractRunLink(markdown) {
  const b = blocksUnder(markdown, LINK_SECTION);
  if (b.length !== 1) throw new Error(`expected one sql block under "${LINK_SECTION}", found ${b.length}`);
  const m = /^WITH run_link AS \([\s\S]*?\n\)(?=\n|$)/.exec(b[0].sql);
  if (!m) throw new Error("the run_link CTE is missing from the link section");
  return m[0];
}

module.exports = { blocksUnder, extractRunLink };
