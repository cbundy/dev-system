// Tests for images/base/gh.sh: gh_workflow_scope, which dev-login and dev-doctor use to
// tell whether gh's token can push .github/workflows/ (dev-system#181). Runs it against a
// stub gh on PATH that prints a given `gh auth status --json hosts` reply.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const GH_SH = path.join(__dirname, "..", "images", "base", "gh.sh");

// Runs gh_workflow_scope with a stub gh that records its arguments, prints `reply` and
// exits with `status`. Returns the function's output and the arguments gh got.
function workflowScope(t, reply, status = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-scope-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "reply"), typeof reply === "string" ? reply : JSON.stringify(reply));
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh\necho "$*" > "${dir}/args"\ncat "${dir}/reply"\nexit ${status}\n`,
    { mode: 0o755 },
  );
  const r = spawnSync("bash", ["-c", '. "$1" && gh_workflow_scope', "bash", GH_SH], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const argsFile = path.join(dir, "args");
  return {
    scope: r.stdout.trim(),
    args: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim() : null,
  };
}

const host = (fields) => ({
  hosts: {
    "github.com": [{ state: "success", active: true, host: "github.com", login: "me", ...fields }],
  },
});

test("asks gh for github.com's login as JSON", (t) => {
  assert.equal(workflowScope(t, host({ scopes: "repo" })).args, "auth status --json hosts --hostname github.com");
});

test("yes when the active token has the workflow scope", (t) => {
  assert.equal(workflowScope(t, host({ scopes: "gist, read:org, repo, workflow" })).scope, "yes");
  assert.equal(workflowScope(t, host({ scopes: "workflow" })).scope, "yes");
});

test("no when the scopes are read and workflow is not one of them", (t) => {
  // What `gh auth login --web` grants by default.
  assert.equal(workflowScope(t, host({ scopes: "gist, read:org, repo" })).scope, "no");
  // A scope that only contains the word does not count.
  assert.equal(workflowScope(t, host({ scopes: "repo, workflows, read:workflow" })).scope, "no");
});

test("only the active account counts", (t) => {
  const reply = {
    hosts: {
      "github.com": [
        { state: "success", active: false, login: "other", scopes: "repo, workflow" },
        { state: "success", active: true, login: "me", scopes: "repo" },
      ],
    },
  };
  assert.equal(workflowScope(t, reply).scope, "no");
});

test("unknown, never no, when the scopes cannot be read", (t) => {
  const cases = {
    "not logged in": { hosts: {} },
    "a failed check (offline, a revoked token)": host({ state: "error", scopes: "" }),
    "a token without OAuth scopes (fine-grained, GitHub App)": host({ scopes: "" }),
    "no scopes field": host({}),
    "a gh too old for --json": "",
    "output that is not JSON": "unknown flag: --json\n",
  };
  for (const [name, reply] of Object.entries(cases)) {
    assert.equal(workflowScope(t, reply).scope, "unknown", name);
  }
  assert.equal(workflowScope(t, "", 1).scope, "unknown", "gh exits non-zero");
});
