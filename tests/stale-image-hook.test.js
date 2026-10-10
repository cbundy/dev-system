// Tests for the callum-flow stale-image hook (dev-system#294): SessionStart and
// PostToolUseFailure(Bash) context when the dev container's image is older than the
// base image the plugin expects. Hermetic: a fake DEV_SYSTEM_SHARE root and a stub PATH.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const HOOKS_DIR = path.join(__dirname, "..", "plugins", "callum-flow", "hooks");
const HOOK = process.env.HOOK_SCRIPT || path.join(HOOKS_DIR, "stale-image.sh");

function which(name) {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf-8" });
  return r.stdout.trim();
}

// A fixture: share root (optional) plus a bin dir holding only the tools the hook needs
// and whichever stubs the case asks for.
function fixture({ share = true, files = [], tools = [], devVersion = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-image-"));
  const bin = path.join(dir, "bin");
  const root = path.join(dir, "share");
  fs.mkdirSync(bin);
  if (share) fs.mkdirSync(root);
  for (const t of ["jq", "timeout", "grep", "sleep", "cat", "bash", "sh", "env", "printf"]) {
    const p = which(t);
    if (p && path.isAbsolute(p)) fs.symlinkSync(p, path.join(bin, t));
  }
  for (const f of files) fs.writeFileSync(path.join(root, f), "x");
  for (const t of tools) fs.writeFileSync(path.join(bin, t), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (devVersion !== null) {
    fs.writeFileSync(path.join(bin, "dev-version"), `#!/bin/sh\n${devVersion}\n`, { mode: 0o755 });
  }
  return { env: { PATH: bin, DEV_SYSTEM_SHARE: root }, dir };
}

const ALL_FILES = ["image-release", "event-push-loop", "nm-push-loop"];
const ALL_TOOLS = ["psql", "dev-query"];

function run(mode, fx, input = "{}") {
  const start = Date.now();
  const r = spawnSync(HOOK, [mode], { input, encoding: "utf-8", env: fx.env });
  assert.equal(r.status, 0, `hook must always exit 0; stderr: ${r.stderr}`);
  return { out: r.stdout, ms: Date.now() - start };
}

const ctx = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;

test("session-start: an old image missing tools and files names each and the rebuild fix", () => {
  const fx = fixture({});
  const { out } = run("session-start", fx);
  const c = ctx(out);
  for (const m of ["psql", "dev-version", "dev-query", "image-release", "event-push-loop", "nm-push-loop"]) {
    assert.match(c, new RegExp(m));
  }
  assert.match(c, /rebuild the container/);
  assert.match(c, /dev-restart-self/);
});

test("session-start: only the missing item is named", () => {
  const fx = fixture({ files: ALL_FILES, tools: ["psql"], devVersion: "echo 'dev-version: OK base-image'" });
  const c = ctx(run("session-start", fx).out);
  assert.match(c, /dev-query/);
  assert.doesNotMatch(c, /nm-push-loop/);
});

test("session-start: a STALE base-image or layer line is quoted; tool drift is not", () => {
  const fx = fixture({
    files: ALL_FILES,
    tools: ALL_TOOLS,
    devVersion: [
      "echo 'dev-version: STALE base-image running=aaaaaaa latest=bbbbbbb (a newer image is published)'",
      "echo 'dev-version: STALE image:repo running=ccccccc latest=ddddddd'",
      "echo 'dev-version: STALE claude running=1 latest=2 (newer upstream release)'",
    ].join("\n"),
  });
  const c = ctx(run("session-start", fx).out);
  assert.match(c, /STALE base-image running=aaaaaaa/);
  assert.match(c, /STALE image:repo/);
  assert.doesNotMatch(c, /claude/);
  assert.match(c, /rebuild the container/);
});

test("session-start: silent when only tool drift is stale, or OK/UNKNOWN only", () => {
  for (const body of [
    "echo 'dev-version: STALE claude running=1 latest=2'",
    "echo 'dev-version: OK base-image'; echo 'dev-version: UNKNOWN base-image-x'",
  ]) {
    const fx = fixture({ files: ALL_FILES, tools: ALL_TOOLS, devVersion: body });
    assert.equal(run("session-start", fx).out, "");
  }
});

test("session-start: a hung dev-version is cut off within 7s and stays silent", () => {
  const fx = fixture({ files: ALL_FILES, tools: ALL_TOOLS, devVersion: "sleep 30" });
  const { out, ms } = run("session-start", fx);
  assert.equal(out, "");
  assert.ok(ms < 7000, `took ${ms}ms`);
});

test("session-start: silent outside a base-image container", () => {
  const fx = fixture({ share: false });
  assert.equal(run("session-start", fx).out, "");
});

test("tool-failure: exit 127 for a manifest tool adds context", () => {
  const fx = fixture({});
  const err = "Exit code 127\n/bin/bash: line 1: psql: command not found";
  const c = ctx(run("tool-failure", fx, JSON.stringify({ tool_name: "Bash", error: err })).out);
  assert.match(c, /psql/);
  assert.match(c, /rebuild the container/);
});

test("tool-failure: internal loops are explained when present, flagged missing when absent", () => {
  const err = "Exit code 127\nbash: nm-push-loop: command not found";
  const present = fixture({ files: ["nm-push-loop"] });
  assert.match(ctx(run("tool-failure", present, JSON.stringify({ error: err })).out), /deliberately not on PATH/);
  const absent = fixture({});
  assert.match(ctx(run("tool-failure", absent, JSON.stringify({ error: err })).out), /rebuild the container/);
});

test("tool-failure: silent for other tools, other exit codes and non-container hosts", () => {
  const fx = fixture({});
  const cases = [
    "Exit code 127\nbash: foo: command not found",
    "Exit code 1\npsql: command not found",
    "Exit code 127\nbash: xpsql: command not found",
  ];
  for (const error of cases) {
    assert.equal(run("tool-failure", fx, JSON.stringify({ error })).out, "");
  }
  const none = fixture({ share: false });
  const error = "Exit code 127\nbash: psql: command not found";
  assert.equal(run("tool-failure", none, JSON.stringify({ error })).out, "");
});

test("hooks.json registers both hooks with timeouts", () => {
  const h = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "hooks.json"), "utf-8")).hooks;
  const ss = h.SessionStart[0];
  assert.equal(ss.matcher, "startup|resume");
  assert.ok(ss.hooks[0].timeout <= 6);
  assert.match(ss.hooks[0].command, /stale-image\.sh" session-start/);
  const pf = h.PostToolUseFailure[0];
  assert.equal(pf.matcher, "Bash");
  assert.match(pf.hooks[0].command, /stale-image\.sh" tool-failure/);
});
