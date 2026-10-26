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
const HOOKS_DIR = path.join(REPO_ROOT, "plugins", "fabriek", "hooks");
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
  assertDenied("env -iu PATH tmux kill-server");
  assertDenied("env -ivu PATH tmux kill-server");
  assertDenied("env -u TMUX FOO=1 tmux kill-session -t a");
  assertDenied("env -a custom tmux kill-server");
  assertDenied("env --argv0 custom tmux kill-server");
  assertDenied("env --argv0=custom tmux kill-server");
  assertDenied("env -S 'tmux kill-server'");
  assertDenied("env -S'-i tmux kill-server'");
  assertDenied("env --split-string 'tmux kill-session -t a'");
  assertDenied("env --split-string='FOO=1 tmux kill-server'");
  assertDenied("env -S '-i' tmux kill-server");
  assertDenied("env -S 'sh -c' 'tmux kill-server'");
  assertDenied("env -iS'tmux kill-server'");
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
  assertDenied("pkill -i TMUX");
  assertDenied("killall -I TMUX");
  assertDenied("pkill -f 'tmux -L mytest'");
  assertDenied("true && killall tmux");
});

test("refuses tmux kills in nested shell execution", () => {
  assertDenied("sh -c 'tmux kill-server'");
  assertDenied("bash -lc 'tmux kill-session -t a'");
  assertDenied("zsh -c 'tmux kill-server'");
  assertDenied("eval tmux kill-server");
  assertDenied("eval -- tmux kill-server");
  assertDenied('echo "$(tmux kill-server)"');
  assertDenied("echo `tmux kill-session -t a`");
  assertDenied("if tmux kill-server; then true; fi");
  assertDenied("while tmux kill-session; do true; done");
  assertDenied("false || tmux kill-server");
});

test("allows kill-server and kill-session on a private socket (-L or -S)", () => {
  assertAllowed("tmux -L mytest kill-server");
  assertAllowed("tmux -Lmytest kill-server");
  assertAllowed("tmux -S /tmp/sock kill-server");
  assertAllowed("tmux -f x -L t kill-session -t a");
  assertAllowed("tmux -uL t kill-server");
  assertAllowed("/usr/bin/tmux -L t kill-server");
  assertAllowed("env -i sudo -n tmux -L t kill-server");
  assertAllowed("env -S 'tmux -L t kill-server'");
  assertAllowed("bash -c 'tmux -L t kill-server'");
  assertAllowed("eval tmux -L t kill-server");
  assertAllowed('echo "$(tmux -L t kill-server)"');
});

test("does not mistake wrapper option arguments for executables", () => {
  assertAllowed("env -u tmux kill-server");
  assertAllowed("env -a tmux kill-server");
  assertAllowed("env -S 'echo tmux kill-server'");
  assertAllowed("env -S 'echo safe' tmux kill-server");
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
  assertAllowed("pkill -F /tmp/tmux.pid node");
  assertAllowed("pkill -F/tmp/tmux.pid node");
  assertAllowed("pkill --pidfile /tmp/tmux.pid node");
  assertAllowed("pkill -u tmux node");
  assertAllowed("killall -u tmux node");
  assertAllowed("killall -utmux node");
  assertAllowed("killall --user tmux node");
  assertAllowed("echo '$(tmux kill-server)'");
  assertAllowed("sh -c 'echo tmux kill-server'");
});

test("allows quoted heredoc bodies, including a lone backtick or unclosed substitution (the #209 shape)", () => {
  const BT = "\x60";
  assertAllowed(`cat <<'EOF'\nan unmatched ${BT} backtick\nEOF`);
  assertAllowed(`cat <<"EOF"\nan unmatched ${BT} backtick\nEOF`);
  assertAllowed(`cat <<\\EOF\nan unmatched ${BT} backtick\nEOF`);
  assertAllowed(`cat <<-'EOF'\n\tan unmatched ${BT} backtick\n\tEOF`);
  assertAllowed(`cat <<'EOF'\nan unclosed $( here\nEOF`);
  assertAllowed(`node - <<'EOF'\nconsole.log(${BT}line one\nline two ${BT} ' ${BT});\nEOF`);
  assertAllowed(`gh issue comment 1 --body "$(cat <<'EOF'\nUse ${BT}foo${BT} - it's fine\nEOF\n)"`);
  // Bodies that only mention the words.
  assertAllowed(`cat <<'EOF'\ntmux kill-server\npkill tmux\nEOF`);
  assertAllowed(`cat <<"EOF"\ntmux kill-server\nEOF`);
});

test("still refuses around quoted heredocs and unmatched openers", () => {
  const BT = "\x60";
  // A real kill after the heredoc.
  assertDenied(`cat <<'EOF'\nhello\nEOF\ntmux kill-server`);
  // A real kill on a line before a stray backtick (bash runs the first line).
  assertDenied(`tmux kill-server\necho ${BT}`);
  // Unquoted heredoc bodies still expand $(...).
  assertDenied(`cat <<EOF\n$(tmux kill-server)\nEOF`);
  // A here-string is not a heredoc opener.
  assertDenied(`cat <<<'x'\ntmux kill-server`);
  // A quoted <<'x' is not a heredoc opener.
  assertDenied(`echo "<<'x'"\ntmux kill-server`);
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

const heredocCases = require("./fixtures/heredoc-hooks.json");
for (const fixture of heredocCases) {
  if (fixture.hooks && !fixture.hooks.includes("tmux-kill")) continue;
  test(`heredoc regression: ${fixture.name}`, () => {
    const command = fixture.command.replaceAll("@COMMAND@", "tmux kill-server");
    if (fixture.denied) assertDenied(command);
    else assertAllowed(command);
  });
}
