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
const { validateNotes, previousTag, buildBody, MAX_LINES, MAX_VERIFY } = require(SCRIPT);

const PR = (n) => `([#${n}](https://github.com/cbundy/dev-system/pull/${n}))`;
const VERIFY = "\n## Verify\n- Run it and see it work.\n";
const BASE = `## New\n- **Thing** - Does a thing. ${PR(1)}\n\n## Fixed\n- **Bug** - No more bug. ${PR(2)}\n\n## Upgrade\n- Run \`npx callum-dev update\`.\n`;
const BASE_FIXED = `## Fixed\n- **Bug** - No more bug. ${PR(2)}\n\n## Upgrade\n- Run it.\n`;
const GOOD = BASE + VERIFY;
const ONLY_FIXED = BASE_FIXED + VERIFY;

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
      `## ${heading}\n- **Thing** - Does a thing. ${PR(1)}\n\n## Upgrade\n- Run it.\n${VERIFY}`;
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
      if (args[0] === "--body") assert.ok(r.stdout.startsWith(notes.replace(VERIFY, "").trimEnd() + "\n"));
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
  assert.equal(previousTag("1.1.0", root), "v0.9.0");
  git(root, "tag", "-d", "v1.0.0-rc.1");
  assert.equal(previousTag("1.1.0", root), "v0.9.0");
  fs.writeFileSync(path.join(root, "release-notes/v1.1.0.md"), GOOD);

  const args = ["--body", "1.1.0", "--to", "HEAD"];
  const a = run(root, args);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(run(root, args).stdout, a.stdout);
  const link = (n) => `([#${n}](https://github.com/cbundy/dev-system/pull/${n}))`;
  const expected =
    BASE.trimEnd() +
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

test("previousTag returns the highest final tag below the core version, never a release candidate", (t) => {
  const root = fakeRepo(t);
  commit(root, "chore: baseline (#9)");
  git(root, "tag", "v1.1.0");
  for (const tag of ["v1.2.0-rc.1", "v1.2.0-rc.2"]) git(root, "tag", tag);
  for (const v of ["1.2.0-rc.1", "1.2.0-rc.2", "1.2.0", "1.2.0+build.2"]) assert.equal(previousTag(v, root), "v1.1.0", v);
  git(root, "tag", "v1.2.0");
  assert.equal(previousTag("1.2.0", root), "v1.1.0");
  assert.equal(previousTag("1.3.0", root), "v1.2.0");
  assert.equal(previousTag("1.3.0-rc.1", root), "v1.2.0");
});

test("--body rc and final modes share the technical list; only the rc keeps Verify", (t) => {
  const root = fakeRepo(t);
  commit(root, "feat: already stable (#9)");
  git(root, "tag", "v1.1.0");
  commit(root, "feat: change 10 (#10)");
  git(root, "tag", "v1.2.0-rc.1");
  commit(root, "fix: change 11 (#11)");
  git(root, "tag", "v1.2.0-rc.2");
  git(root, "tag", "v1.2.0");
  fs.writeFileSync(path.join(root, "release-notes/v1.2.0.md"), GOOD);
  const rc = run(root, ["--body", "1.2.0-rc.2"]);
  const fin = run(root, ["--body", "1.2.0"]);
  assert.equal(rc.status, 0, rc.stderr);
  assert.equal(fin.status, 0, fin.stderr);
  const details = (out) => out.slice(out.indexOf("<details>"));
  assert.equal(details(rc.stdout), details(fin.stdout));
  assert.match(details(fin.stdout), /change 10[^]*change 11|change 11[^]*change 10/);
  assert.match(rc.stdout, /## Verify\n- Run it and see it work\./);
  assert.doesNotMatch(fin.stdout, /Verify/);
  assert.equal(fin.stdout.split("<details>")[0], BASE + "\n");
  // An rc whose tag does not exist yet ends at HEAD and uses the same notes file.
  assert.equal(run(root, ["--check", "1.2.0-rc.3"]).status, 0);
  assert.equal(run(root, ["--body", "1.2.0-rc.3"]).status, 0);
});

test("Verify validation", () => {
  const e = (text, v) => validateNotes(text, "n", v).join("\n");
  assert.deepEqual(validateNotes(GOOD, "n", "1.1.0"), []);
  assert.match(e(BASE, "1.1.0"), /needs a "Verify" section/);
  assert.equal(e(BASE, "0.27.0"), "");
  assert.match(e(BASE + "\n## Verify\n", "1.1.0"), /empty "Verify" group/);
  assert.match(e(BASE.replace("## Upgrade", "## Verify\n- x\n\n## Upgrade"), "1.1.0"), /out of order/);
  assert.match(e(GOOD + "\n## Verify\n- again\n", "1.1.0"), /duplicated or out of order/);
  const many = (n) => BASE + "\n## Verify\n" + Array.from({ length: n }, (_, i) => `- check ${i}`).join("\n") + "\n";
  assert.equal(e(many(MAX_VERIFY), "1.1.0"), "");
  assert.match(e(many(MAX_VERIFY + 1), "1.1.0"), /over the 10-item cap/);
  // The line cap counts only the lines before Verify.
  const filler = Array.from({ length: MAX_LINES - BASE.trimEnd().split("\n").length }, () => "").join("\n");
  const full = BASE.replace("## Fixed", filler + "\n## Fixed");
  assert.equal(full.trimEnd().split("\n").length, MAX_LINES);
  assert.equal(e(full + many(MAX_VERIFY).slice(BASE.length), "1.1.0"), "");
  assert.match(e(full.replace("## Fixed", "\n## Fixed") + VERIFY, "1.1.0"), /over the 40-line cap/);
});

test("--lint rejects a prerelease-named notes file", (t) => {
  const root = fakeRepo(t);
  fs.writeFileSync(path.join(root, "release-notes/v1.2.0-rc.1.md"), GOOD);
  const r = run(root, ["--lint"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /notes are keyed by the final version/);
});
