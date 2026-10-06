// Tests for the callum-flow PreToolUse(Bash) hook that refuses killing the default
// tmux server (dev-system#177). Feeds it the exact PreToolUse JSON shape Claude Code puts
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
const REAL_HOOK = path.join(HOOKS_DIR, "forbid-tmux-kill.sh");
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
  assert.match(reason, /default tmux socket/i, `reason should explain the default socket for: ${command}`);
  assert.match(reason, /tmux -L/, `reason should point at a private socket for: ${command}`);
  assert.doesNotMatch(reason, /\u2014/, "reason must not contain an em dash");
}

function assertAllowed(command, opts) {
  const result = runHook(command, opts);
  assert.equal(result.stdout.trim(), "", `expected no decision (allow) for: ${command}`);
}

test("refuses tmux kill-server and kill-session on the default socket", () => {
  assertDenied("tmux kill-server");
  assertDenied("tmux kill-session");
  assertDenied("tmux kill-session -t claude");
  assertDenied("tmux kill-ser");
});

test("refuses behind global options that are not a socket selector", () => {
  assertDenied("tmux -f x kill-server");
  assertDenied("tmux -2 -u kill-server");
  assertDenied("tmux -f /tmp/conf.conf kill-session -t a");
});

test("refuses inside a compound command, whichever operator joins it", () => {
  assertDenied("cd wt && tmux kill-server");
  assertDenied("tmux ls; tmux kill-server");
  assertDenied("tmux kill-server || true");
  assertDenied("tmux ls\ntmux kill-session -t x");
  assertDenied("(tmux kill-server)");
  assertDenied("{ tmux kill-server; }");
});

test("refuses with env prefix, wrappers and a path to the binary", () => {
  assertDenied("TMUX_TMPDIR=/x tmux kill-server");
  assertDenied("/usr/bin/tmux kill-server");
  assertDenied("sudo tmux kill-server");
  assertDenied("env FOO=1 tmux kill-session -t a");
  assertDenied("env -i tmux kill-server");
  assertDenied("env -u TMUX FOO=1 tmux kill-session -t a");
  assertDenied("command -- tmux kill-server");
  assertDenied("nohup -- tmux kill-server");
  assertDenied("sudo -n tmux kill-server");
  assertDenied("sudo -u root tmux kill-server");
  assertDenied("time -p tmux kill-server");
  assertDenied("time -o /tmp/tmux-time.out tmux kill-server");
  assertDenied("exec -a tmux-client tmux kill-server");
  assertDenied("env -i sudo -n command -- /usr/bin/tmux kill-server");
});

test("refuses pkill and killall aimed at tmux", () => {
  assertDenied("pkill tmux");
  assertDenied("pkill -f tmux");
  assertDenied("pkill -9 -x tmux");
  assertDenied("killall tmux");
  assertDenied("killall -9 tmux");
  assertDenied("true && killall tmux");
});

test("allows kill-server and kill-session on a private socket (-L or -S)", () => {
  assertAllowed("tmux -L mytest kill-server");
  assertAllowed("tmux -Lmytest kill-server");
  assertAllowed("tmux -S /tmp/sock kill-server");
  assertAllowed("tmux -f x -L t kill-session -t a");
  assertAllowed("tmux -uL t kill-server");
  assertAllowed("/usr/bin/tmux -L t kill-server");
  assertAllowed("env -i sudo -n tmux -L t kill-server");
  assertAllowed("pkill -f 'tmux -L mytest'");
});

test("does not mistake wrapper option arguments for executables", () => {
  assertAllowed("env -u tmux kill-server");
  assertAllowed("sudo -u tmux kill-server");
  assertAllowed("time -o tmux kill-server");
  assertAllowed("exec -a tmux kill-server");
});

test("does not refuse other tmux subcommands", () => {
  assertAllowed("tmux new-session -d -s x");
  assertAllowed("tmux send-keys -t x ls Enter");
  assertAllowed("tmux ls");
  assertAllowed("tmux attach -t claude");
  assertAllowed("tmux kill-window -t x");
  assertAllowed("tmux kill-pane");
  assertAllowed("tmux");
});

test("does not refuse commands that merely mention the words", () => {
  assertAllowed("echo tmux kill-server");
  assertAllowed("grep 'tmux kill-server' README.md");
  assertAllowed('git commit -m "never run tmux kill-server"');
  assertAllowed("grep tmux file");
  assertAllowed("pgrep tmux");
  assertAllowed("pkill node");
});

test("ignores non-Bash tool calls even if their command field says tmux kill-server", () => {
  assertAllowed("tmux kill-server", { toolName: "Write" });
});

test("hooks.json is valid JSON and wires a PreToolUse Bash matcher to the script via CLAUDE_PLUGIN_ROOT", () => {
  const raw = fs.readFileSync(HOOKS_JSON, "utf-8");
  const parsed = JSON.parse(raw);
  // Plugin hook files wrap events in a top-level "hooks" object; a bare
  // top-level PreToolUse is rejected by `claude plugin validate` and never loads.
  assert.ok(parsed.hooks && typeof parsed.hooks === "object", "hooks.json must wrap events in a top-level \"hooks\" object");
  assert.ok(Array.isArray(parsed.hooks.PreToolUse), "hooks.json must declare PreToolUse");
  const entry = parsed.hooks.PreToolUse.find((e) => e.matcher === "Bash");
  assert.ok(entry, "expected a Bash-matcher PreToolUse entry");
  const commands = entry.hooks.map((h) => h.command).join(" ");
  assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}/, "hook command should reference CLAUDE_PLUGIN_ROOT");
  assert.match(commands, /forbid-tmux-kill\.sh/, "hook command should point at the script");
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
