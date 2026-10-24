// Helpers that pull ```sql blocks out of the repo's markdown:
//   blocksUnder(markdown, heading)  the sql blocks under one `## <heading>`
// Used by tests/metrics-queries.test.js.
"use strict";

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

module.exports = { blocksUnder };
