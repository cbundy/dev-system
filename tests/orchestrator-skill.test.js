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

test("issue-orchestrator SKILL.md carries the release-planning rules", () => {
  const skill = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md");
  const text = fs.readFileSync(skill, "utf8").replace(/\s+/g, " ");
  assert.ok(text.includes("Next release"));
  assert.ok(text.includes("callum-flow-milestone plan <N> next"));
  assert.ok(text.includes("callum-flow-milestone plan <N> later"));
  assert.ok(text.includes("callum-flow-milestone expect"));
  assert.ok(text.includes("callum-flow-milestone show"));
  assert.ok(text.includes("Next release has no open items"));
  assert.ok(!text.includes("callum-flow-milestone tag"), "merge-time tagging belongs to callum-flow-merge");
});

test("split sub-issues inherit ready in the designer and the orchestrator skill", () => {
  const root = path.join(__dirname, "..", "plugins", "callum-flow");
  const norm = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/\s+/g, " ");
  const designer = norm("agents/designer.md");
  assert.ok(designer.includes("label them `ready` when the parent was `ready` or claimed"));
  assert.ok(!designer.includes("WITHOUT the `ready` label"));
  const skill = norm("skills/issue-orchestrator/SKILL.md");
  assert.ok(skill.includes("release your claim on the parent"));
  assert.ok(skill.includes("split sub-issues arrive `ready`"));
  assert.ok(!skill.includes("wait for the owner to tag each split sub-issue"));
  assert.ok(!skill.includes("into unlabelled sub-issues, stop"));
});

test("issue-orchestrator SKILL.md step 3 routes the implementer model", () => {
  const skill = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md");
  const text = fs.readFileSync(skill, "utf8").replace(/\s+/g, " ");
  const step3 = text.slice(text.indexOf("3. **Delegate**"), text.indexOf("4. **Verify and merge**"));
  assert.ok(step3.includes("callum-flow-implementer-route"));
});

test("issue-orchestrator SKILL.md tick report is compact and links every issue or PR", () => {
  const skill = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "issue-orchestrator", "SKILL.md");
  const text = fs.readFileSync(skill, "utf8").replace(/\s+/g, " ");
  const section = text.slice(text.indexOf("## Tick report"));
  assert.ok(section.includes("usage"));
  assert.ok(section.includes("[#N](https://github.com/<REPO>/"));
  assert.ok(section.includes("never a bare"));
  for (const m of section.matchAll(/#(\d+|N)\b/g)) {
    assert.equal(section[m.index - 1], "[", `bare reference near: ${section.slice(Math.max(0, m.index - 20), m.index + 10)}`);
  }
});
