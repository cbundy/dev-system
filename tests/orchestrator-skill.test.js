"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("issue-orchestrator SKILL.md stays within its 175-line ceiling", () => {
  const skill = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md");
  const text = fs.readFileSync(skill, "utf8");
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  assert.ok(lines <= 175, `SKILL.md is ${lines} lines: shorten the skill or move content into a script, agent or implement-issue rather than raise the 175-line ceiling`);
});

test("the orchestrator merge section sends every GUARD test-weakening WARN to the adjudicator", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md"), "utf8");
  const merge = text.slice(text.indexOf("## Merge"));
  assert.match(merge, /GUARD test-weakening WARN/);
  assert.match(merge, /adjudicator/);
});
