// Tests for the callum-flow PreToolUse(Bash) hook that refuses process kills by
// name or pattern on the shared host (dev-system#421). Feeds it the exact
// PreToolUse JSON shape Claude Code puts on stdin and asserts refuse/allow.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, "plugins", "callum-flow", "hooks");
const REAL_HOOK = path.join(HOOKS_DIR, "forbid-broad-kill.sh");
const HOOKS_JSON = path.join(HOOKS_DIR, "hooks.json");
const HOOK = process.env.HOOK_SCRIPT || REAL_HOOK;

const INCIDENT = "kill $(pgrep -f '^sleep 300')";

// A main checkout plus one linked worktree, built with real git.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "broad-kill-"));
const MAIN = path.join(tmp, "main");
const WT = path.join(tmp, "wt");
const OTHER_WT = path.join(tmp, "other-wt");
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}
fs.mkdirSync(MAIN);
git(["init", "-q"], MAIN);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"], MAIN);
git(["worktree", "add", "-q", "-b", "wt", WT], MAIN);
git(["worktree", "add", "-q", "-b", "other", OTHER_WT], MAIN);
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

function runHook(command, { toolName = "Bash", cwd = "/home/user/my-project", env } = {}) {
  const input = JSON.stringify({
    session_id: "abc123",
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { command, description: "test" },
    tool_use_id: "toolu_01ABC123",
  });
  const result = spawnSync(HOOK, [], { input, encoding: "utf-8", env: env || process.env });
  assert.equal(result.status, 0, `hook should always exit 0; stderr: ${result.stderr}`);
  return result;
}

function assertDenied(command, opts) {
  const result = runHook(command, opts);
  const stdout = result.stdout.trim();
  assert.notEqual(stdout, "", `expected a deny decision for: ${command}`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", `expected deny for: ${command}`);
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /shared|share this host/i, "reason should say the host is shared");
  assert.match(reason, /watchers/, "reason should name the orchestrator watchers");
  assert.match(reason, /pid=\$!/, "reason should name the safe alternative");
  assert.match(reason, /worktree or scratchpad/, "reason should offer path scoping");
  assert.doesNotMatch(reason, /—/, "reason must not contain an em dash");
}

function assertAllowed(command, opts) {
  const result = runHook(command, opts);
  assert.equal(result.stdout.trim(), "", `expected no decision (allow) for: ${command}`);
}

test("refuses the incident command and its variants", () => {
  assertDenied(INCIDENT);
  assertDenied("kill `pgrep -f '^sleep 300'`");
  assertDenied("kill -9 $(pidof node)");
  assertDenied("kill -TERM $(pgrep -f x)");
});

test("refuses pkill, killall and killall5", () => {
  assertDenied("pkill -f queue-watch");
  assertDenied("pkill sleep");
  assertDenied("killall node");
  assertDenied("killall5 -9");
});

test("reads pkill -SIGNAL as a signal, not as -P <parent>", () => {
  assertDenied("pkill -TSTP node");
  assertDenied("pkill -TRAP node");
  assertDenied("pkill -PIPE foo");
  assertDenied("pkill -SIGPWR foo");
  assertDenied("pkill -rtmin+2 foo");
  assertAllowed("pkill -TSTP -P 4242");
  assertAllowed("pkill -9 -P4242 node");
});

test("refuses pgrep/pidof piped into xargs kill", () => {
  assertDenied("pgrep -f x | xargs kill");
  assertDenied("pgrep x | xargs -r kill -9");
  assertDenied("pgrep x | xargs -I{} kill {}");
  assertDenied("pidof node | xargs -n 1 kill");
});

test("refuses kill of every process", () => {
  assertDenied("kill -1");
  assertDenied("kill -9 -1");
  assertDenied("kill -- -1");
});

test("sees through wrappers and compound commands", () => {
  assertDenied("sudo pkill x");
  assertDenied("env pkill x");
  assertDenied("sh -c 'pkill x'");
  assertDenied("eval 'pkill x'");
  assertDenied("cd /tmp && pkill x");
  assertDenied("true; killall x");
});

test("refuses pkill -P 0 and -P 1 but not other parents", () => {
  assertDenied("pkill -P 1 x");
  assertDenied("pkill -P 0 x");
  assertAllowed("pkill -P 4242");
  assertAllowed('kill $(pgrep -P "$w" -x sleep)');
});

test("allows kills of exact PIDs and variables", () => {
  assertAllowed("kill 1234");
  assertAllowed('kill "$pid"');
  assertAllowed("kill -TERM $!");
  assertAllowed("kill 0");
  assertAllowed("kill -1 1234");
});

test("allows bare pgrep/pidof and mere mentions", () => {
  assertAllowed("pgrep -f x");
  assertAllowed("pidof x");
  assertAllowed("echo pkill");
  assertAllowed("grep -n killall file");
  assertAllowed("git commit -m 'stop pkill use'");
  assertAllowed("cat <<'EOF'\npkill x\nEOF");
  assertAllowed("cat <<'EOF'\nrun `pkill x` now\nEOF");
});

test("ignores non-Bash tool calls", () => {
  assertAllowed("pkill x", { toolName: "Write" });
});

test("worktree and scratchpad path scoping", () => {
  assertAllowed(`pkill -f '${WT}/server.js'`, { cwd: WT });
  assertAllowed(`pkill -f '${WT.replaceAll("/", "\\/").replaceAll(".", "\\.")}\\/server\\.js'`, { cwd: WT });
  assertDenied(`pkill -f '${OTHER_WT}/server.js'`, { cwd: WT });
  assertDenied(`pkill -f '${MAIN}/server.js'`, { cwd: WT });
  assertDenied(`pkill -f '${MAIN}/server.js'`, { cwd: MAIN });
  assertDenied(`pkill -f '${WT}/server.js'`, { cwd: MAIN });
  assertDenied(`pkill -f '${WT}/../x/server.js'`, { cwd: WT });
  assertDenied(`pkill -f '${WT}/server.js' other`, { cwd: WT });
  assertAllowed(`kill $(pgrep -f '${WT}/server.js')`, { cwd: WT });
  assertDenied(`pkill -f 'sleep|${WT}/x'`, { cwd: WT });
  assertDenied(`pkill -f '(${WT}/x)?sleep'`, { cwd: WT });
  assertDenied(`kill $(pgrep -f 'vite|${WT}/server.js')`, { cwd: WT });
  assertDenied("pkill -f 'sleep|/tmp/claude-1000/-p/s1/scratchpad/run.sh'");
  assertAllowed("pkill -f '/tmp/claude-1000/-p/s1/scratchpad/run.sh'");
});

test("an inverted match is never scoped", () => {
  assertDenied("pkill -v -P 4242", { cwd: WT });
  assertDenied("pkill --inverse -P 4242", { cwd: WT });
  assertDenied(`pkill -vf '${WT}/server.js'`, { cwd: WT });
  assertDenied(`kill $(pgrep -v -f '${WT}/x')`, { cwd: WT });
  assertDenied("pgrep -v -P 4242 | xargs kill", { cwd: WT });
  assertAllowed("pkill -P4242v", { cwd: WT });
});

test("without git only the scratchpad exemption applies", () => {
  const env = { ...process.env, PATH: "/nonexistent-bin" };
  // sh and awk are needed by the hook itself; give it a PATH of just those.
  const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
  for (const tool of ["sh", "awk", "cat", "dirname", "printf"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  env.PATH = bin;
  assertDenied(`pkill -f '${WT}/server.js'`, { cwd: WT, env });
  assertAllowed("pkill -f '/tmp/claude-1000/-p/s1/scratchpad/run.sh'", { cwd: WT, env });
});

test("fail-open on unmatched openers", () => {
  assertAllowed("echo $(\nkill 1234");
  assertAllowed("echo $(\npkill x");
  assertDenied("pkill x\necho $(");
});

test("hooks.json wires a PreToolUse Bash matcher to the script", () => {
  const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf-8"));
  const entry = parsed.hooks.PreToolUse.find((e) => e.matcher === "Bash");
  assert.ok(entry, "expected a Bash-matcher PreToolUse entry");
  const commands = entry.hooks.map((h) => h.command).join(" ");
  assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/forbid-broad-kill\.sh/);
});

test("the hook script is committed executable (git mode 100755)", () => {
  const relPath = path.relative(REPO_ROOT, REAL_HOOK);
  const result = spawnSync("git", ["ls-files", "-s", "--", relPath], { cwd: REPO_ROOT, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim();
  assert.notEqual(line, "", `${relPath} is not tracked by git yet`);
  assert.match(line, /^100755\s/, `expected mode 100755 for ${relPath}, got: ${line}`);
});

const heredocCases = require("./fixtures/heredoc-hooks.json");
for (const fixture of heredocCases) {
  if (fixture.hooks && !fixture.hooks.includes("broad-kill")) continue;
  test(`heredoc regression: ${fixture.name}`, () => {
    const command = fixture.command.replaceAll("@COMMAND@", INCIDENT);
    if (fixture.denied) assertDenied(command);
    else assertAllowed(command);
  });
}
