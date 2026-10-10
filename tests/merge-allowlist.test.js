"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// dev-system#219: the synced allow list must never let a worktree sub-agent merge.
// Permission rules match by prefix, so the check-only guard may be listed and the
// merging command (callum-flow-merge) and gh pr merge may not. dev-system#233 does the same
// for the PR-body edit: the read-only check-pr-linkage.sh is allowed, the repair
// (callum-flow-fix-linkage, and gh pr edit) is not.
for (const rel of [
  "templates/.claude/settings.json",
  ".claude/settings.json",
  ".callum-dev/baseline/.claude/settings.json",
]) {
  test(`${rel} allows the merge guard and linkage check but nothing that can merge or repair`, () => {
    const allow = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8")).permissions.allow;
    assert.ok(allow.includes("Bash(callum-flow-merge-guard *)"));
    assert.ok(allow.includes("Bash(/usr/local/share/callum-tools/check-pr-linkage.sh *)"));
    const merging = [
      "callum-flow-fix-linkage 7",
      "callum-flow-fix-linkage 7 --expect refs",
      "gh pr edit 7 --body x",
      "callum-flow-merge 7", "callum-flow-merge 7 --method rebase", "gh pr merge 7 --squash"];
    const allows = (entry, cmd) => {
      const rule = entry.replace(/^Bash\(/, "").replace(/\)$/, "");
      return rule.endsWith(" *") ? cmd.startsWith(rule.slice(0, -1)) : cmd === rule;
    };
    for (const entry of allow) {
      for (const cmd of merging) assert.ok(!allows(entry, cmd), `${entry} would allow '${cmd}'`);
    }
  });
}

// dev-system#312: raw reads of issue and PR text are denied everywhere. The three settings
// files carry the same lists, the allow list names only the issue writes and the filtered
// reader, and the deny list covers the issue reads (bare and `*` forms).
const settingsFiles = ["templates/.claude/settings.json", ".claude/settings.json", ".callum-dev/baseline/.claude/settings.json"];

test("the three synced settings files are byte-identical", () => {
  const [first, ...rest] = settingsFiles.map((rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8"));
  for (const other of rest) assert.equal(other, first);
});

for (const rel of settingsFiles) {
  test(`${rel} allows the filtered reader and issue writes, and denies raw issue reads`, () => {
    const { allow, deny } = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8")).permissions;
    assert.ok(!allow.includes("Bash(gh issue *)"), "the blanket gh issue allow is gone");
    for (const entry of [
      "Bash(gh issue comment *)",
      "Bash(gh issue edit *)",
      "Bash(gh issue close *)",
      "Bash(gh issue create *)",
      "Bash(callum-flow-issue-read *)",
    ]) {
      assert.ok(allow.includes(entry), `allow carries ${entry}`);
    }
    assert.deepEqual(deny, [
      "Bash(gh issue view *)",
      "Bash(gh issue list)",
      "Bash(gh issue list *)",
      "Bash(gh issue status)",
      "Bash(gh issue status *)",
    ]);
  });
}
