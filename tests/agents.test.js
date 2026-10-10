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
  const expected = { designer: "opus", explorer: "sonnet", implementer: "sonnet", fixer: "sonnet", adjudicator: "sonnet" };
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

test("designer brief shape has a Rollout field between Sequencing and Open decisions", () => {
  const body = fs.readFileSync(path.join(DIR, "designer.md"), "utf8");
  assert.match(body, /## Sequencing\n[^\n]*\n\n## Rollout\nmerge \| run-it \| keep-open - [^\n]*\n\n## Open decisions/);
  for (const v of ["merge", "run-it", "keep-open"]) assert.match(body, new RegExp(`\`${v}\``));
});

test("adjudicator is read-only, cannot spawn agents, and states the verdict contract", () => {
  const fm = frontmatter("adjudicator");
  assert.match(fm.disallowedTools, /Edit/);
  assert.match(fm.disallowedTools, /Write/);
  assert.doesNotMatch(fm.tools, /Agent/);
  const body = fs.readFileSync(path.join(DIR, "adjudicator.md"), "utf8");
  for (const v of ["CORRECT", "WRONG", "NIT", "ENV", "DUP"]) assert.match(body, new RegExp(`\\b${v}\\b`));
  assert.match(body, /never run\s+`?axi respond`?/i);
});

test("the TEST POLICY sentence is in implement-issue and the fixer, and the adjudicator judges test removals", () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "plugins", "callum-flow", ...p), "utf8");
  const impl = read("skills", "implement-issue", "SKILL.md");
  const m = /"(TEST POLICY: [^"]+)"/.exec(impl);
  assert.ok(m, "implement-issue section 6 must carry the TEST POLICY sentence");
  assert.ok(read("agents", "fixer.md").includes(m[1]), "fixer.md must carry the same TEST POLICY sentence");
  for (const word of ["--warn-only", "|| true", "skip/only", "commented-out", "absolutely not required", "ask-user"]) {
    assert.ok(m[1].includes(word), `the TEST POLICY sentence should mention ${word}`);
  }
  const adj = read("agents", "adjudicator.md");
  assert.match(adj, /GUARD test-weakening WARN/);
  assert.match(adj, /unless the stated\s+justification shows the test is absolutely not required/);
});
