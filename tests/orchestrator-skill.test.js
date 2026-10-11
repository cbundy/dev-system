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

test("issue-orchestrator SKILL.md arms the single orchestrator watcher", () => {
  const skill = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md");
  const text = fs.readFileSync(skill, "utf8").replace(/\s+/g, " ");
  assert.ok(text.includes("orchestrator-watch.sh"));
  assert.ok(text.includes("--stream --deadline 1740"));
  assert.ok(text.includes("--deadline 7140"));
  assert.ok(!text.includes("harness cron"), "the audit is the watcher's timeout, not a harness cron");
  assert.ok(!/CronList[^.]*audit/.test(text), "CronList is for the usage reset wake only");
  assert.ok(!text.includes("20 minutes"));
});
