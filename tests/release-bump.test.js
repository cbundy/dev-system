// Tests for scripts/release-bump.js (dev-system#147): the release version bump runs in a
// PR, and --check is what the Release workflow uses to refuse an un-bumped tree. Each test
// builds a throwaway repo in a temp dir, so nothing depends on the real versions.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "release-bump.js");
const { bump, check } = require(SCRIPT);

const MANIFEST = "plugins/alpha/.claude-plugin/plugin.json";
const SKILL_WITH = "plugins/alpha/skills/one/SKILL.md";
const SKILL_WITHOUT = "plugins/alpha/skills/two/SKILL.md";

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf-8");

function fakeRepo(t, { version = "1.0.0", stamp = version } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-bump-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "package.json", JSON.stringify({ name: "demo", version }, null, 2) + "\n");
  write(root, MANIFEST, JSON.stringify({ name: "alpha", version }, null, 2) + "\n");
  write(root, SKILL_WITH, `---\nname: one\nversion: ${version}\n---\n\n# One\n`);
  write(root, SKILL_WITHOUT, "---\nname: two\ndescription: Two.\n---\n\n# Two\n");
  write(root, "plugins/alpha/skills/empty/README.md", "no SKILL.md here\n");
  write(root, ".callum-dev.json", JSON.stringify({ version: stamp }, null, 2) + "\n");
  // A stand-in for bin/callum-dev.js: `update` stamps the bumped package.json version, and
  // FAKE_UPDATE_EXIT makes it fail like an update that left conflicts.
  write(
    root,
    "bin/callum-dev.js",
    'const fs = require("node:fs");\n' +
      'const v = JSON.parse(fs.readFileSync("package.json", "utf-8")).version;\n' +
      'if (process.argv[2] !== "update") process.exit(2);\n' +
      'fs.writeFileSync(".callum-dev.json", JSON.stringify({ version: v }) + "\\n");\n' +
      "process.exit(Number(process.env.FAKE_UPDATE_EXIT || 0));\n",
  );
  return root;
}

const quiet = () => {};

test("bump sets every plugin.json, SKILL.md (replaced or appended) and package.json", (t) => {
  const root = fakeRepo(t);
  const updated = [];
  bump("2.3.4-rc.1", { root, update: (r) => (updated.push(r), 0), log: quiet });

  assert.equal(JSON.parse(read(root, MANIFEST)).version, "2.3.4-rc.1");
  assert.equal(JSON.parse(read(root, MANIFEST)).name, "alpha");
  assert.equal(read(root, SKILL_WITH), "---\nname: one\nversion: 2.3.4-rc.1\n---\n\n# One\n");
  assert.equal(read(root, SKILL_WITHOUT), "---\nname: two\ndescription: Two.\nversion: 2.3.4-rc.1\n---\n\n# Two\n");
  assert.equal(read(root, "package.json"), JSON.stringify({ name: "demo", version: "2.3.4-rc.1" }, null, 2) + "\n");
  assert.deepEqual(updated, [root]);
});

test("bump rejects an invalid version without touching any file", (t) => {
  const root = fakeRepo(t);
  for (const bad of ["v1.2.3", "1.2", "1.2.3.4", "", undefined]) {
    assert.throws(
      () => bump(bad, { root, update: () => assert.fail("update must not run"), log: quiet }),
      /not a valid semantic version/,
    );
  }
  assert.equal(JSON.parse(read(root, "package.json")).version, "1.0.0");
});

test("bump fails when the stamp refresh fails", (t) => {
  const root = fakeRepo(t);
  assert.throws(() => bump("2.0.0", { root, update: () => 1, log: quiet }), /callum-dev\.js update' exited 1/);
});

test("check is empty when every file and the stamp are at the version", (t) => {
  const root = fakeRepo(t, { version: "3.1.0" });
  write(root, SKILL_WITHOUT, "---\nname: two\nversion: 3.1.0\n---\n");
  assert.deepEqual(check("3.1.0", { root }), []);
});

test("check lists each mismatch, including a missing SKILL.md version and a stale stamp", (t) => {
  const root = fakeRepo(t, { version: "3.1.0", stamp: "3.0.0" });
  write(root, MANIFEST, JSON.stringify({ name: "alpha", version: "3.0.9" }));
  assert.deepEqual(check("3.1.0", { root }).sort(), [
    ".callum-dev.json: has 3.0.0, expected 3.1.0",
    `${MANIFEST}: has 3.0.9, expected 3.1.0`,
    `${SKILL_WITHOUT}: has no version, expected 3.1.0`,
  ]);
});

function cli(root, args, env = {}) {
  // The script resolves the repo from its own location, so run a copy inside the fake repo.
  write(root, "scripts/release-bump.js", fs.readFileSync(SCRIPT, "utf-8"));
  return spawnSync(process.execPath, [path.join(root, "scripts", "release-bump.js"), ...args], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

test("CLI: bump then --check passes, quietly", (t) => {
  const root = fakeRepo(t);
  const bumped = cli(root, ["4.0.0"]);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(JSON.parse(read(root, ".callum-dev.json")).version, "4.0.0");

  const checked = cli(root, ["--check", "4.0.0"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout + checked.stderr, "");
});

test("CLI: --check exits 1 and prints every mismatch", (t) => {
  const root = fakeRepo(t);
  const r = cli(root, ["--check", "1.1.0"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^release-bump: package\.json: has 1\.0\.0, expected 1\.1\.0$/m);
  assert.match(r.stderr, /^release-bump: \.callum-dev\.json: has 1\.0\.0, expected 1\.1\.0$/m);
  assert.equal(r.stderr.trim().split("\n").length, 5);
});

test("CLI: a failing stamp refresh exits non-zero", (t) => {
  const root = fakeRepo(t);
  const r = cli(root, ["4.0.0"], { FAKE_UPDATE_EXIT: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /release-bump: 'node bin\/callum-dev\.js update' exited 1: resolve the conflicts/);
});

test("CLI: bad semver and bad usage exit 1", (t) => {
  const root = fakeRepo(t);
  assert.match(cli(root, ["1.2"]).stderr, /release-bump: '1\.2' is not a valid semantic version/);
  assert.equal(cli(root, ["1.2"]).status, 1);
  assert.match(cli(root, []).stderr, /release-bump: usage:/);
  assert.equal(cli(root, ["--check"]).status, 1);
});
