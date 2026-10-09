// Tests for the callum-flow PreToolUse(Bash) hook that refuses restarting, stopping
// or updating the Coder workspace the session runs in (dev-system#263). Feeds it the
// exact PreToolUse JSON shape Claude Code puts on stdin and asserts refuse/allow.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, "plugins", "callum-flow", "hooks");
const REAL_HOOK = path.join(HOOKS_DIR, "forbid-coder-self.sh");
const HOOKS_JSON = path.join(HOOKS_DIR, "hooks.json");

// Overridable to prove these tests fail against an allow-all stub.
const HOOK = process.env.HOOK_SCRIPT || REAL_HOOK;

const SELF = "dev-system-testbed";
const OWNER = "callum";

function runHook(command, { toolName = "Bash", env = {} } = {}) {
  const input = JSON.stringify({
    session_id: "abc123",
    cwd: "/home/user/my-project",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { command, description: "test" },
    tool_use_id: "toolu_01ABC123",
  });
  const baseEnv = { ...process.env };
  delete baseEnv.CODER_WORKSPACE_NAME;
  delete baseEnv.CODER_WORKSPACE_OWNER_NAME;
  const result = spawnSync(HOOK, [], {
    input,
    encoding: "utf-8",
    env: { ...baseEnv, CODER_WORKSPACE_NAME: SELF, CODER_WORKSPACE_OWNER_NAME: OWNER, ...env },
  });
  assert.equal(result.status, 0, `hook should always exit 0; stderr: ${result.stderr}`);
  return result;
}

function assertDenied(command) {
  const stdout = runHook(command).stdout.trim();
  assert.notEqual(stdout, "", `expected a deny decision for: ${command}`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", `expected deny for: ${command}`);
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /dev-restart-self/, `reason should name dev-restart-self for: ${command}`);
  assert.doesNotMatch(reason, /—/, "reason must not contain an em dash");
}

function assertAllowed(command, opts) {
  const stdout = runHook(command, opts).stdout.trim();
  assert.equal(stdout, "", `expected no decision (allow) for: ${command}; got: ${stdout}`);
}

test("refuses restart, stop and update aimed at its own workspace", () => {
  assertDenied(`coder restart ${SELF} -y`);
  assertDenied(`coder stop ${OWNER}/${SELF}`);
  assertDenied(`coder update ${SELF}`);
  assertDenied(`coder restart ${SELF}.main`);
  assertDenied(`coder restart ${OWNER}/${SELF}.main -y`);
  assertDenied(`coder restart me/${SELF} -y`);
  assertDenied(`coder --global-config /persist/coder restart ${SELF} -y`);
  assertDenied(`coder restart -y ${SELF}`);
});

test("refuses behind prefixes, wrappers, compounds and nested shells", () => {
  assertDenied(`CODER_CONFIG_DIR=/persist/coder coder restart ${SELF} -y`);
  assertDenied(`cd x && coder stop ${SELF}`);
  assertDenied(`true; coder stop ${SELF}`);
  assertDenied(`sudo coder stop ${SELF}`);
  assertDenied(`env FOO=1 coder stop ${SELF}`);
  assertDenied(`nohup coder restart ${SELF} -y`);
  assertDenied(`time coder update ${SELF}`);
  assertDenied(`bash -c 'coder restart ${SELF}'`);
  assertDenied(`eval "coder restart ${SELF}"`);
  assertDenied(`echo $(coder stop ${SELF})`);
  assertDenied(`/usr/local/bin/coder stop ${SELF}`);
});

test("allows other workspaces and other coder subcommands", () => {
  assertAllowed("coder restart next-smoke-1");
  assertAllowed(`coder restart ${SELF}-2`);
  assertAllowed("coder list");
  assertAllowed(`coder ssh ${SELF}`);
  assertAllowed(`coder show ${SELF}`);
  assertAllowed(`coder start ${SELF}`);
});

test("allows text that only mentions the command", () => {
  assertAllowed(`echo coder restart ${SELF}`);
  assertAllowed(`git commit -m "coder restart ${SELF}"`);
  assertAllowed(`gh issue comment 1 --body "do not coder stop ${SELF}"`);
  assertAllowed(`grep -r 'coder restart ${SELF}' .`);
  assertAllowed(`sh -c 'echo coder restart ${SELF}'`);
});

test("skips quoted heredoc bodies, including an unmatched backtick (the #209 shape)", () => {
  assertAllowed(`cat <<'EOF'\ncoder restart ${SELF} -y\nan unmatched \` backtick\nEOF`);
  assertAllowed(`cat <<"EOF"\ncoder restart ${SELF}\nEOF`);
  assertAllowed(`cat <<\\EOF\ncoder restart ${SELF}\nEOF`);
  assertAllowed(`cat <<-'EOF'\n\tcoder restart ${SELF}\n\tEOF`);
  // A command after the heredoc is still scanned.
  assertDenied(`cat <<'EOF'\nhello\nEOF\ncoder stop ${SELF}`);
  // A here-string or quoted text is not a heredoc opener.
  assertDenied(`cat <<< 'x'\ncoder stop ${SELF}`);
  assertDenied(`echo "<<'x'"\ncoder stop ${SELF}`);
  // Unquoted heredoc bodies expand $(...), so they are still scanned.
  assertDenied(`cat <<EOF\n$(coder stop ${SELF})\nEOF`);
});

test("fails open on input it cannot parse", () => {
  assertAllowed(`echo \`coder stop ${SELF}`);
  assertAllowed(`echo $(coder stop ${SELF}`);
});

test("allows everything when CODER_WORKSPACE_NAME is unset", () => {
  assertAllowed(`coder restart ${SELF} -y`, { env: { CODER_WORKSPACE_NAME: "" } });
});

test("owner prefix is only matched with the right owner", () => {
  assertAllowed(`coder stop someone-else/${SELF}`);
});

test("ignores non-Bash tool calls", () => {
  assertAllowed(`coder restart ${SELF}`, { toolName: "Write" });
});

test("hooks.json wires the script as a Bash PreToolUse hook via CLAUDE_PLUGIN_ROOT", () => {
  const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf-8"));
  const entry = parsed.hooks.PreToolUse.find((e) => e.matcher === "Bash");
  assert.ok(entry, "expected a Bash-matcher PreToolUse entry");
  const commands = entry.hooks.map((h) => h.command).join(" ");
  assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/forbid-coder-self\.sh/);
});

test("the hook script is committed executable (git mode 100755)", () => {
  const relPath = path.relative(REPO_ROOT, REAL_HOOK);
  const result = spawnSync("git", ["ls-files", "-s", "--", relPath], { cwd: REPO_ROOT, encoding: "utf-8" });
  const line = result.stdout.trim();
  assert.notEqual(line, "", `${relPath} is not tracked by git yet`);
  assert.match(line, /^100755\s/, `expected mode 100755 for ${relPath}, got: ${line}`);
});

test("refuses unexpanded workspace env var references as the target", () => {
  assertDenied("coder stop $CODER_WORKSPACE_NAME");
  assertDenied('coder restart "${CODER_WORKSPACE_NAME}" -y');
  assertDenied("coder update $CODER_WORKSPACE_OWNER_NAME/$CODER_WORKSPACE_NAME");
  assertDenied("coder stop me/$CODER_WORKSPACE_NAME.main");
});

test("allows other env vars and mere mentions of the workspace env var", () => {
  assertAllowed("coder stop $OTHER_WS");
  assertAllowed("echo coder stop $CODER_WORKSPACE_NAME");
});
