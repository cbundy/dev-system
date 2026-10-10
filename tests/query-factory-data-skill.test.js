// Tests for the query-factory-data skill (#293): frontmatter, that every docs/metrics.md
// anchor it links to still resolves to a heading, and that it goes through dev-query.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const skill = fs.readFileSync(path.join(ROOT, "plugins", "callum-flow", "skills", "query-factory-data", "SKILL.md"), "utf8");
const metrics = fs.readFileSync(path.join(ROOT, "docs", "metrics.md"), "utf8");

// GitHub heading slug: lowercase, drop everything but letters, digits, underscores, spaces
// and hyphens, then spaces to hyphens.
function slug(heading) {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
}

test("frontmatter names the skill and describes latency and pipeline cost", () => {
  const fm = skill.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.match(fm, /^name: query-factory-data$/m);
  const desc = fm.slice(fm.indexOf("description:"));
  assert.match(desc, /latency/);
  assert.match(desc, /pipeline cost/);
});

test("every docs/metrics.md anchor in the skill resolves to a heading", () => {
  const slugs = new Set();
  let inFence = false;
  for (const line of metrics.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const m = !inFence && line.match(/^#{1,6} (.+)$/);
    if (m) slugs.add(slug(m[1].trim()));
  }
  const links = [...skill.matchAll(/docs\/metrics\.md#([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  assert.ok(links.length >= 5, "the skill links to the metrics reference sections");
  for (const a of links) assert.ok(slugs.has(a), `no heading in docs/metrics.md for #${a}`);
});

test("links to repo files are absolute GitHub URLs", () => {
  assert.doesNotMatch(skill, /\]\((?!https:\/\/)[^)]*\)/);
});

test("it goes through dev-query, never raw psql or the URL variable", () => {
  assert.match(skill, /dev-query/);
  assert.doesNotMatch(skill, /AGENTSVIEW_PG_URL/);
  assert.doesNotMatch(skill, /psql\s+["'$-]/);
});

test("no em dash", () => {
  assert.doesNotMatch(skill, /\u2014/);
});
