// Tests for scripts/release-notes.js (dev-system#291): the notes validator, the --lint and
// --check gates, and the deterministic release body built from a throwaway git repo.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "release-notes.js");
const { validateNotes, previousTag, buildBody, MAX_LINES } = require(SCRIPT);

const PR = (n) => `([#${n}](https://github.com/cbundy/dev-system/pull/${n}))`;
const GOOD = `## New\n- **Thing** - Does a thing. ${PR(1)}\n\n## Fixed\n- **Bug** - No more bug. ${PR(2)}\n\n## Upgrade\n- Run \`npx callum-dev update\`.\n`;
const ONLY_FIXED = `## Fixed\n- **Bug** - No more bug. ${PR(2)}\n\n## Upgrade\n- Run it.\n`;

const errs = (text) => validateNotes(text, "f.md").join("\n");

test("valid notes pass", () => {
  assert.deepEqual(validateNotes(GOOD), []);
  assert.deepEqual(validateNotes(ONLY_FIXED), []);
});

test("invalid notes are reported with a message each", () => {
  assert.match(errs(GOOD.replace("## New", "## Added")), /unknown heading "Added"/);
  assert.match(errs("## Fixed" + GOOD.split("## Fixed")[1] + "\n## New\n- **X** - y " + PR(3) + "\n"), /out of order/);
  assert.match(errs(GOOD.replace("## Fixed", "## Fixed\n\n## Changed")), /empty "(Fixed|Changed)" group/);
  assert.match(errs("## Upgrade\n- Run it.\n"), /at least one of/);
  assert.match(errs(`## Fixed\n- **Bug** - x ${PR(2)}\n`), /needs an "Upgrade"/);
  assert.match(errs(GOOD.replace("**Thing** - ", "")), /item must look like/);
  assert.match(errs(GOOD.replace(PR(1), "")), /no PR link/);
  assert.match(errs(GOOD + "<details>x</details>\n"), /<details>/);
  assert.match(errs(GOOD + "\n## Upgrade\n- again\n"), /duplicated or out of order/);
  const long = GOOD.replace("## Fixed", Array.from({ length: MAX_LINES }, () => "").join("\n") + "\n## Fixed");
  assert.match(errs(long), /over the 40-line cap/);
});

function run(root, args) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd: root, encoding: "utf-8", env: { ...process.env, RELEASE_NOTES_ROOT: root } });
  return r;
}

function git(root, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
}

function fakeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release-notes"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "d", version: "1.1.0" }));
  git(root, "init", "-q", "-b", "main");
  return root;
}

const commit = (root, subject, body = "") => git(root, "commit", "-q", "--allow-empty", "-m", subject + (body ? `\n\n${body}` : ""));

test("--lint and --check require notes for the package.json version", (t) => {
  const root = fakeRepo(t);
  let r = run(root, ["--lint"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /release-notes\/v1\.1\.0\.md: missing/);
  assert.match(r.stderr, /release. skill/);
  r = run(root, ["--check", "1.1.0"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing; write it with the `release` skill/);
  fs.writeFileSync(path.join(root, "release-notes/v1.1.0.md"), GOOD);
  assert.equal(run(root, ["--lint"]).status, 0);
  assert.equal(run(root, ["--check", "1.1.0"]).status, 0);
  fs.writeFileSync(path.join(root, "release-notes/v1.0.0.md"), "## Fixed\n");
  r = run(root, ["--lint"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /v1\.0\.0\.md/);
});

test("all notes commands reject unsupported content in every section", (t) => {
  const root = fakeRepo(t);
  commit(root, "feat: a thing (#1)");
  const file = path.join(root, "release-notes/v1.1.0.md");
  const commands = [["--check", "1.1.0"], ["--lint"], ["--body", "1.1.0"]];
  for (const heading of ["Breaking", "New", "Changed", "Fixed", "Upgrade"]) {
    const notes = heading === "Upgrade" ? ONLY_FIXED :
      `## ${heading}\n- **Thing** - Does a thing. ${PR(1)}\n\n## Upgrade\n- Run it.\n`;
    const item = heading === "Upgrade" ? "- Run it." : `- **Thing** - Does a thing. ${PR(1)}`;
    for (const content of ["1. Unlinked change", "+ Unlinked change", "Unlinked change", "  Continued text"]) {
      const invalid = notes.replace(item, `${item}\n${content}`);
      fs.writeFileSync(file, invalid);
      for (const args of commands) {
        const r = run(root, args);
        assert.equal(r.status, 1, `${args[0]} accepted ${content} in ${heading}`);
        assert.match(r.stderr, /unsupported content; section items must be bullets/);
        assert.equal(r.stdout, "");
      }
    }
    fs.writeFileSync(file, notes);
    for (const args of commands) {
      const r = run(root, args);
      assert.equal(r.status, 0, r.stderr);
      if (args[0] === "--body") assert.ok(r.stdout.startsWith(notes.trimEnd() + "\n"));
    }
  }
});

test("--body groups the commits since the previous tag, deterministically", (t) => {
  const root = fakeRepo(t);
  commit(root, "chore: old (#9)");
  git(root, "tag", "v0.9.0");
  commit(root, "feat(x): a (#1)");
  commit(root, "fix!: b (#2)");
  commit(root, "chore(release): v1.1.0 (#3)");
  commit(root, "docs: c (#4)");
  commit(root, "refactor: d", "BREAKING CHANGE: gone");
  git(root, "tag", "v2.0.0");
  git(root, "tag", "v1.0.0-rc.1");
  assert.equal(previousTag("1.1.0", root), "v1.0.0-rc.1");
  git(root, "tag", "-d", "v1.0.0-rc.1");
  assert.equal(previousTag("1.1.0", root), "v0.9.0");
  fs.writeFileSync(path.join(root, "release-notes/v1.1.0.md"), GOOD);

  const args = ["--body", "1.1.0", "--to", "HEAD"];
  const a = run(root, args);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(run(root, args).stdout, a.stdout);
  const link = (n) => `([#${n}](https://github.com/cbundy/dev-system/pull/${n}))`;
  const expected =
    GOOD.trimEnd() +
    "\n\n<details>\n<summary>Technical changes</summary>\n\n" +
    "### Breaking\n\n- d\n- b " + link(2) + "\n\n" +
    "### Enhancements\n\n- x: a " + link(1) + "\n\n" +
    "### Maintenance\n\n- c " + link(4) + "\n- release: v1.1.0 " + link(3) + "\n\n" +
    "</details>\n";
  // Order within a group is newest first (git log order).
  assert.equal(a.stdout, expected);
  assert.doesNotMatch(a.stdout, /### Fixes/);
});

test("--body refuses invalid notes", (t) => {
  const root = fakeRepo(t);
  const r = run(root, ["--body", "1.1.0"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing/);
  assert.ok(typeof buildBody === "function");
});

test("previousTag follows full prerelease precedence and ignores build metadata", (t) => {
  const root = fakeRepo(t);
  commit(root, "chore: baseline (#9)");
  git(root, "tag", "v1.1.0");
  const versions = [
    "1.2.0-alpha", "1.2.0-alpha.1", "1.2.0-alpha.beta", "1.2.0-beta",
    "1.2.0-beta.2", "1.2.0-beta.11", "1.2.0-rc.1", "1.2.0-rc.2",
    "1.2.0-rc.9", "1.2.0-rc.10", "1.2.0",
  ];
  let previous = "v1.1.0";
  for (const version of versions) {
    assert.equal(previousTag(version, root), previous);
    git(root, "tag", `v${version}`);
    git(root, "tag", `v${version}+build.1`);
    assert.equal(previousTag(`${version}+build.2`, root), previous);
    previous = `v${version}`;
    git(root, "tag", "-d", `v${version}+build.1`);
  }
});

test("--body excludes earlier prerelease changes for prereleases and final releases", (t) => {
  const root = fakeRepo(t);
  commit(root, "feat: already stable (#9)");
  git(root, "tag", "v1.1.0");
  for (const [version, n] of [["1.2.0-rc.1", 10], ["1.2.0-rc.2", 11], ["1.2.0-rc.9", 12], ["1.2.0-rc.10", 13], ["1.2.0", 14]]) {
    commit(root, `feat: change ${n} (#${n})`);
    git(root, "tag", `v${version}`);
    fs.writeFileSync(path.join(root, `release-notes/v${version}.md`), ONLY_FIXED);
    const r = run(root, ["--body", version]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, ONLY_FIXED.trimEnd() +
      `\n\n<details>\n<summary>Technical changes</summary>\n\n### Enhancements\n\n- change ${n} ${PR(n)}\n\n</details>\n`);
  }
});
