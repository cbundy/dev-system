// Tests for the callum-flow PreToolUse(Bash) hook that refuses `git stash`
// (dev-system#52). Feeds it the exact PreToolUse JSON shape Claude Code puts
// on stdin (https://code.claude.com/docs/en/hooks#pretooluse) and asserts
// refuse/allow, exactly as the real hook would see it.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, "plugins", "callum-flow", "hooks");
const REAL_HOOK = path.join(HOOKS_DIR, "forbid-git-stash.sh");
const HOOKS_JSON = path.join(HOOKS_DIR, "hooks.json");

// Overridable so a manual run can point this at a stubbed allow-all script
// to prove these tests actually fail against a hook that does nothing -
// see the PR description for that run's output. Real CI always uses the
// shipped script.
const HOOK = process.env.HOOK_SCRIPT || REAL_HOOK;

function runHook(command, { toolName = "Bash", extraToolInput = {} } = {}) {
  const input = JSON.stringify({
    session_id: "abc123",
    prompt_id: "550e8400-e29b-41d4-a716-446655440000",
    transcript_path: "/home/user/.claude/projects/x/transcript.jsonl",
    cwd: "/home/user/my-project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { command, description: "test", ...extraToolInput },
    tool_use_id: "toolu_01ABC123",
  });
  const result = spawnSync(HOOK, [], { input, encoding: "utf-8" });
  assert.equal(result.status, 0, `hook should always exit 0; stderr: ${result.stderr}`);
  return result;
}

function assertDenied(command) {
  const result = runHook(command);
  const stdout = result.stdout.trim();
  assert.notEqual(stdout, "", `expected a deny decision for: ${command}`);
  const parsed = JSON.parse(stdout);
  assert.equal(
    parsed.hookSpecificOutput.hookEventName,
    "PreToolUse",
    `wrong hookEventName for: ${command}`,
  );
  assert.equal(
    parsed.hookSpecificOutput.permissionDecision,
    "deny",
    `expected deny for: ${command}`,
  );
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /stash/i, `reason should mention stash for: ${command}`);
  assert.match(reason, /worktree/i, `reason should explain the shared worktree for: ${command}`);
  assert.match(reason, /git diff/, `reason should suggest the git diff alternative for: ${command}`);
}

function assertAllowed(command, opts) {
  const result = runHook(command, opts);
  assert.equal(result.stdout.trim(), "", `expected no decision (allow) for: ${command}`);
}

test("refuses plain git stash and git stash pop", () => {
  assertDenied("git stash");
  assertDenied("git stash pop");
});

test("refuses stash list/show too (issue: simpler to refuse every subcommand)", () => {
  assertDenied("git stash list");
  assertDenied("git stash show");
});

test("refuses git stash behind global options", () => {
  assertDenied("git -C wt stash push");
  assertDenied("git -c user.name=x stash list");
  assertDenied('git --git-dir=/x --work-tree /y stash');
  assertDenied("git --no-pager stash show");
  assertDenied("git --work-tree=/y --git-dir=/x stash");
});

test("refuses git stash inside a compound command, whichever operator joins it", () => {
  assertDenied("cd wt && git stash");
  assertDenied("git status; git stash");
  assertDenied("git stash || true");
  assertDenied("git stash | cat");
  assertDenied("git status\ngit stash");
  assertDenied("(cd wt && git stash)");
  assertDenied("{ cd wt && git stash; }");
});

test("refuses git stash with a leading env-var assignment", () => {
  assertDenied("GIT_DIR=/x git stash");
});

test("refuses a path to the git binary, not just the bare word", () => {
  assertDenied("/usr/bin/git stash");
});

test("does not refuse commands that merely mention the word stash", () => {
  assertAllowed('git commit -m "stash cleanup"');
  assertAllowed("grep stash file");
  assertAllowed("git log --grep=stash");
});

test("does not refuse echo'ing the words git stash (never actually runs it)", () => {
  assertAllowed("echo git stash");
});

test("does not refuse ordinary git commands, including with global options", () => {
  assertAllowed("git status");
  assertAllowed("git -C wt status");
  assertAllowed("git --version");
  assertAllowed("git -c user.name=x commit -m stash");
});

test("ignores non-Bash tool calls even if their command field says git stash", () => {
  assertAllowed("git stash", { toolName: "Write" });
});

test("hooks.json is valid JSON and wires a PreToolUse Bash matcher to the script via CLAUDE_PLUGIN_ROOT", () => {
  const raw = fs.readFileSync(HOOKS_JSON, "utf-8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.PreToolUse), "hooks.json must declare PreToolUse");
  const entry = parsed.PreToolUse.find((e) => e.matcher === "Bash");
  assert.ok(entry, "expected a Bash-matcher PreToolUse entry");
  const commands = entry.hooks.map((h) => h.command).join(" ");
  assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}/, "hook command should reference CLAUDE_PLUGIN_ROOT");
  assert.match(commands, /forbid-git-stash\.sh/, "hook command should point at the script");
});

test("the hook script is committed executable (git mode 100755)", () => {
  const relPath = path.relative(REPO_ROOT, REAL_HOOK);
  const result = spawnSync("git", ["ls-files", "-s", "--", relPath], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim();
  assert.notEqual(line, "", `${relPath} is not tracked by git yet`);
  assert.match(line, /^100755\s/, `expected mode 100755 for ${relPath}, got: ${line}`);
});
