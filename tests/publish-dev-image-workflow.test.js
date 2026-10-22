// Pins the dev image's workflow_run trigger on the base image publish (text checks: no YAML parser).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const WF = path.join(__dirname, "..", ".github", "workflows");
const dev = fs.readFileSync(path.join(WF, "publish-dev-image.yml"), "utf8");
const base = fs.readFileSync(path.join(WF, "publish-base-image.yml"), "utf8");

test("dev image triggers on the base workflow's exact name", () => {
  const baseName = base.match(/^name:\s*(.+?)\s*$/m)[1].replace(/^["']|["']$/g, "");
  const m = dev.match(/^ {2}workflow_run:\n((?: {4}.*\n)+)/m);
  assert.ok(m, "missing on.workflow_run");
  const block = m[1];
  assert.ok(block.includes(`workflows: ["${baseName}"]`), `workflow_run must name "${baseName}"`);
  assert.match(block, /types: \[completed\]/);
  assert.match(block, /branches: \[main\]/);
});

test("build job only runs for a successful, non-PR base run", () => {
  const m = dev.match(/^ {2}build:\n {4}if: >-\n((?: {6}.*\n)+)/m);
  assert.ok(m, "build job needs an if: guard");
  const guard = m[1].replace(/\s+/g, " ");
  assert.ok(guard.includes("github.event_name != 'workflow_run' ||"));
  assert.ok(guard.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(guard.includes("github.event.workflow_run.event != 'pull_request'"));
});

test("step summary names the triggering base run", () => {
  assert.match(dev, /BASE_RUN_URL: \$\{\{ github\.event\.workflow_run\.html_url \}\}/);
  assert.match(dev, /BASE_RUN_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
});
