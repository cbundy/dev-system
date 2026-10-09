// The issue-orchestrator skill carries only dispatch rules, judgment rules and
// pointers to scripts and agents (cbundy/dev-system#222). It was 560 lines
// before epic #223, 532 before the audit and 171 after it; this ceiling keeps it short. When
// you add to the skill, move something out first (a script's header or message,
// implement-issue, or an agent) - raise the ceiling only with a reason.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SKILL = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md");
const MAX_LINES = 171;

test("issue-orchestrator SKILL.md stays under its line ceiling", () => {
  const lines = fs.readFileSync(SKILL, "utf8").split("\n").length - 1;
  assert.ok(lines <= MAX_LINES, `SKILL.md is ${lines} lines, ceiling ${MAX_LINES}: move content to a script, agent or implement-issue instead`);
});

test("issue-orchestrator SKILL.md has no stale guidance", () => {
  const text = fs.readFileSync(SKILL, "utf8");
  assert.doesNotMatch(text, /pgrep -af/, "pgrep matches itself; audit via the task list");
  assert.doesNotMatch(text, /in the run's own worktree/, "axi respond targets the checked-out slot");
  assert.doesNotMatch(text, /--known[^\n]*ascending/, "queue-watch.sh sorts --known itself");
});
