// Tests for the callum-flow PreToolUse(Bash|WebFetch) hook that refuses reading GitHub
// issue, PR and comment text any way except callum-flow-issue-read (dev-system#312).
// Feeds it the exact PreToolUse JSON shape Claude Code puts on stdin.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, "plugins", "callum-flow", "hooks");
const REAL_HOOK = path.join(HOOKS_DIR, "forbid-raw-gh-read.sh");
const HOOKS_JSON = path.join(HOOKS_DIR, "hooks.json");

// Overridable to prove these tests fail against an allow-all stub.
const HOOK = process.env.HOOK_SCRIPT || REAL_HOOK;

function runHook(command, { toolName = "Bash", extraToolInput = {}, env = {}, raw } = {}) {
  const input =
    raw ||
    JSON.stringify({
      session_id: "abc123",
      cwd: "/home/user/my-project",
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolName === "Bash" ? { command, description: "test", ...extraToolInput } : extraToolInput,
      tool_use_id: "toolu_01ABC123",
    });
  const result = spawnSync(HOOK, [], { input, encoding: "utf-8", env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `hook should always exit 0; stderr: ${result.stderr}`);
  return result;
}

function parseDeny(stdout, what) {
  assert.notEqual(stdout, "", `expected a deny decision for: ${what}`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", `expected deny for: ${what}`);
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /callum-flow-issue-read/, `reason should name the reader for: ${what}`);
  assert.match(reason, /untrusted author/);
  assert.doesNotMatch(reason, /—/, "reason must not contain an em dash");
  return reason;
}

function assertDenied(command, opts) {
  return parseDeny(runHook(command, opts).stdout.trim(), command);
}

function assertAllowed(command, opts) {
  const stdout = runHook(command, opts).stdout.trim();
  assert.equal(stdout, "", `expected no decision (allow) for: ${command}; got: ${stdout}`);
}

function assertWebFetch(url, denied) {
  const opts = { toolName: "WebFetch", extraToolInput: { url, prompt: "summarise" } };
  if (denied) assertDenied(url, opts);
  else assertAllowed(url, opts);
}

const RAW_READS = [
  "gh issue view 5",
  "gh -R o/r issue view 5",
  "gh --repo o/r issue view 5",
  "gh issue list --label ready",
  "gh issue status",
  "gh pr view 5",
  "gh pr view 5 --comments",
  "gh pr view 5 --web",
  "gh pr view 5 --json body,state",
  "gh pr view 5 --json=title",
  "gh pr view 5 --json latestReviews",
  "gh pr view 5 --json comments",
  "gh pr view 5 --json reviews --jq .reviews",
  "gh pr list",
  "gh pr list --json number,title",
  "gh pr list --json=body",
  "gh search issues foo",
  "gh search prs foo",
  "gh api repos/o/r/issues/5/comments",
  "gh api repos/o/r/pulls/5/reviews",
  "gh api repos/o/r/issues/5/timeline",
  "gh api search/issues?q=x",
  "gh api graphql -f query='{ viewer { login } }'",
  "gh api -X GET repos/o/r/issues",
  "curl -s https://api.github.com/repos/o/r/issues/5",
  "curl -sL https://patch-diff.githubusercontent.com/raw/o/r/pull/5.diff",
  "wget https://github.com/o/r/pull/5",
  "curl https://github.com/o/r/issues/5",
];

test("refuses every raw-read form", () => {
  for (const cmd of RAW_READS) assertDenied(cmd);
});

test("refuses each form in chains, pipes, substitutions, nested shells and prefixes", () => {
  const wrap = [
    (c) => `cd x && ${c}`,
    (c) => `true; ${c}`,
    (c) => `false || ${c}`,
    (c) => `echo hi | ${c}`,
    (c) => `echo first\n${c}`,
    (c) => `echo $(${c})`,
    (c) => `echo \`${c}\``,
    (c) => `echo "x $(${c}) y"`,
    (c) => `bash -c '${c.replace(/'/g, "")}'`,
    (c) => `sh -c "${c.replace(/"/g, "")}"`,
    (c) => `eval "${c.replace(/"/g, "")}"`,
    (c) => `GH_TOKEN=x ${c}`,
    (c) => `env A=1 ${c}`,
    (c) => `sudo ${c}`,
    (c) => `exec ${c}`,
    (c) => `nohup ${c}`,
    (c) => `time ${c}`,
  ];
  for (const cmd of RAW_READS) for (const w of wrap) assertDenied(w(cmd));
});

test("refuses gh invoked by path", () => {
  assertDenied("/usr/bin/gh issue view 5");
  assertDenied("/usr/local/bin/gh pr view 5 --comments");
});

test("refuses WebFetch of issue, PR and API URLs", () => {
  assertWebFetch("https://github.com/cbundy/dev-system/issues/312", true);
  assertWebFetch("https://github.com/o/r/pull/5/files", true);
  assertWebFetch("http://www.github.com/o/r/pulls", true);
  assertWebFetch("https://api.github.com/repos/o/r/issues/5", true);
  assertWebFetch("https://patch-diff.githubusercontent.com/raw/o/r/pull/5.diff", true);
});

test("allows the reader and metadata-only reads", () => {
  assertAllowed("callum-flow-issue-read 5 --comments");
  assertAllowed("callum-flow-issue-read --pr 5 --comments");
  assertAllowed("callum-flow-issue-read --list");
  assertAllowed("gh pr view 5 --json closingIssuesReferences");
  assertAllowed("gh pr view 5 --json state,headRefOid,mergeStateStatus");
  assertAllowed("gh pr view 5 --json=state");
  assertAllowed("gh pr list --state merged --json number,mergedAt,headRefName");
  assertAllowed("gh pr checks 5");
  assertAllowed("gh pr diff 5");
});

test("allows writes and other gh areas", () => {
  assertAllowed("gh issue comment 5 --body-file f");
  assertAllowed("gh issue edit 5 --add-label x");
  assertAllowed("gh issue close 5");
  assertAllowed("gh issue reopen 5");
  assertAllowed("gh issue create --body-file f");
  assertAllowed("gh pr create --body-file f");
  assertAllowed("gh pr edit 5 --body-file f");
  assertAllowed("gh pr close 5");
  assertAllowed("gh run watch 1 --interval 30");
  assertAllowed("gh workflow run x.yml");
  assertAllowed("gh release view v1");
  assertAllowed("gh repo view");
  assertAllowed("gh auth status");
  assertAllowed("gh api users/cbundy --jq .id");
  assertAllowed("gh api rate_limit");
  assertAllowed("gh api repos/{owner}/{repo}/contents/README.md");
  assertAllowed("callum-flow-merge-guard 5");
  assertAllowed("/usr/local/share/callum-tools/check-pr-linkage.sh 5");
});

test("allows text that only mentions a raw read", () => {
  assertAllowed("grep -n 'gh issue view' file");
  assertAllowed('echo "gh issue view"');
  assertAllowed("gh issue comment 5 --body 'do not run gh issue view'");
  assertAllowed("cat <<'EOF'\ngh issue view 5\nEOF");
  assertAllowed("git commit -m 'curl https://api.github.com/x'");
});

test("allows WebFetch of other URLs", () => {
  assertWebFetch("https://github.com/o/r/blob/main/README.md", false);
  assertWebFetch("https://github.com/o/r", false);
  assertWebFetch("https://code.claude.com/docs/en/hooks", false);
  assertWebFetch("https://raw.githubusercontent.com/o/r/main/x", false);
});

test("reads the WebFetch url only from tool_input, and ignores other tools", () => {
  // A decoy "url" key outside tool_input must not decide the outcome.
  const raw = JSON.stringify({
    tool_name: "WebFetch",
    decoy: { url: "https://github.com/o/r/issues/1" },
    tool_input: { url: "https://code.claude.com/docs", prompt: "x" },
  });
  assert.equal(runHook("", { raw }).stdout.trim(), "");
  assertAllowed("", {
    toolName: "Read",
    extraToolInput: { url: "https://github.com/o/r/issues/1", file_path: "gh issue view" },
  });
  assertAllowed("gh issue view 5", { toolName: "Write" });
});

test("fails open when the parser cannot make sense of the command", () => {
  assertAllowed("echo $(gh issue view 5");
  assertAllowed("echo `gh issue view 5");
  assertAllowed("echo 'unterminated; gh issue view 5");
});

test("reason: names the reader forms; adds the stale-image line without the reader", () => {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "no-reader-"));
  try {
    // The hook needs sh, awk, cat and dirname: link them into an otherwise empty PATH.
    for (const tool of ["sh", "awk", "cat", "dirname"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      fs.symlinkSync(found, path.join(emptyBin, tool));
    }
    const reason = assertDenied("gh issue view 5", { env: { PATH: emptyBin } });
    for (const form of ["<N> --comments", "--list", "--pr <N> --comments", "--timeline <N>", "--comment <id>"]) {
      assert.ok(reason.includes(form), `reason names ${form}`);
    }
    assert.match(reason, /dev-restart-self/);
    assert.match(reason, /Rebuild Container/);
    assert.match(reason, /out of date/);
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("reason: names the variable when the reader exists and it is unset", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "reader-"));
  try {
    const stub = path.join(bin, "callum-flow-issue-read");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, CALLUM_FLOW_TRUSTED_AUTHORS: "" };
    const unset = assertDenied("gh issue view 5", { env });
    assert.match(unset, /CALLUM_FLOW_TRUSTED_AUTHORS/);
    assert.match(unset, /dev-doctor/);
    assert.doesNotMatch(unset, /Rebuild Container/);
    const set = assertDenied("gh issue view 5", { env: { ...env, CALLUM_FLOW_TRUSTED_AUTHORS: "cbundy:1" } });
    assert.doesNotMatch(set, /CALLUM_FLOW_TRUSTED_AUTHORS/);
    assert.doesNotMatch(set, /Rebuild Container/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("hooks.json wires the script for the Bash and WebFetch matchers via CLAUDE_PLUGIN_ROOT", () => {
  const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf-8"));
  for (const matcher of ["Bash", "WebFetch"]) {
    const entry = parsed.hooks.PreToolUse.find((e) => e.matcher === matcher);
    assert.ok(entry, `expected a ${matcher}-matcher PreToolUse entry`);
    const commands = entry.hooks.map((h) => h.command).join(" ");
    assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/forbid-raw-gh-read\.sh/);
  }
});

test("the hook script is committed executable (git mode 100755)", () => {
  const relPath = path.relative(REPO_ROOT, REAL_HOOK);
  const result = spawnSync("git", ["ls-files", "-s", "--", relPath], { cwd: REPO_ROOT, encoding: "utf-8" });
  const line = result.stdout.trim();
  assert.notEqual(line, "", `${relPath} is not tracked by git yet`);
  assert.match(line, /^100755\s/, `expected mode 100755 for ${relPath}, got: ${line}`);
});
