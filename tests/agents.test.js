// Tests for the named sub-agents shipped in plugins/callum-flow/agents/: each pins a model
// in its frontmatter (the orchestrator relies on it) and the designer is read-only on code.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const DIR = path.join(__dirname, "..", "plugins", "callum-flow", "agents");

function frontmatter(name) {
  const m = fs.readFileSync(path.join(DIR, `${name}.md`), "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${name}: missing frontmatter`);
  return Object.fromEntries(m[1].split("\n").map((l) => l.split(/:\s*/, 2)));
}

test("every agent pins its name and a model", () => {
  const expected = { designer: "opus", explorer: "sonnet", implementer: "sonnet", fixer: "sonnet" };
  for (const [name, model] of Object.entries(expected)) {
    const fm = frontmatter(name);
    assert.equal(fm.name, name);
    assert.equal(fm.model, model);
  }
});

test("designer cannot edit code and spawns the explorer", () => {
  const fm = frontmatter("designer");
  assert.match(fm.disallowedTools, /Edit/);
  assert.match(fm.disallowedTools, /Write/);
  assert.match(fm.tools, /Agent/);
});
