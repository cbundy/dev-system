// End-to-end tests for the callum-dev CLI: each test runs the real bin in a
// scratch directory, exactly as `npx callum-dev` would in a consumer repo.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "callum-dev.js");
const TEMPLATES = path.join(__dirname, "..", "templates");
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
).version;

function run(cwd, command, { input, templates } = {}) {
  return spawnSync("node", [BIN, command], {
    cwd,
    input: input ?? "",
    encoding: "utf-8",
    env: { ...process.env, ...(templates ? { CALLUM_DEV_TEMPLATES: templates } : {}) },
  });
}

function scratchRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callum-dev-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Copy the real templates so a test can simulate an upstream change.
function upstreamCopy(t, mutate) {
  const dir = path.join(scratchRepo(t), "templates");
  fs.cpSync(TEMPLATES, dir, { recursive: true });
  mutate(dir);
  return dir;
}

function read(dir, file) {
  return fs.readFileSync(path.join(dir, file), "utf-8");
}

function initRepo(t, input = "myrepo\nbun run lint\nbun run test\n") {
  const repo = scratchRepo(t);
  const result = run(repo, "init", { input });
  assert.equal(result.status, 0, result.stderr);
  return repo;
}

test("init scaffolds templates, substitutes answers, keeps baseline pristine", (t) => {
  const repo = initRepo(t);

  const nm = read(repo, ".no-mistakes.yaml");
  assert.match(nm, /^  lint: "bun run lint"$/m);
  assert.match(nm, /^  test: "bun run test"$/m);
  assert.match(read(repo, ".devcontainer/devcontainer.json"), /"name": "myrepo"/);
  assert.ok(fs.existsSync(path.join(repo, "CLAUDE.md")));
  assert.ok(fs.existsSync(path.join(repo, ".claude/settings.json")));
  assert.ok(fs.existsSync(path.join(repo, "treehouse.toml")));

  assert.ok(fs.existsSync(path.join(repo, ".gitignore")));

  const stamp = JSON.parse(read(repo, ".callum-dev.json"));
  assert.equal(stamp.version, PKG_VERSION);
  assert.equal(stamp.files.length, 6);

  // Baseline must be the pristine template: the substituted lint/test values
  // are repo-owned edits from the merge's point of view.
  assert.match(read(repo, ".callum-dev/baseline/.no-mistakes.yaml"), /<REPLACE/);
});

test("init refuses to clobber existing files and refuses to run twice", (t) => {
  const repo = scratchRepo(t);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "pre-existing\n");
  const first = run(repo, "init");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(read(repo, "CLAUDE.md"), "pre-existing\n");
  assert.match(first.stdout, /skipped\s+CLAUDE\.md/);

  const second = run(repo, "init");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
});

test("update merges an upstream synced change without clobbering repo-owned edits", (t) => {
  const repo = initRepo(t);
  const upstream = upstreamCopy(t, (dir) => {
    const file = path.join(dir, ".no-mistakes.yaml");
    fs.writeFileSync(file, read(dir, ".no-mistakes.yaml").replace("  lint: 5", "  lint: 4"));
  });

  const result = run(repo, "update", { templates: upstream });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const nm = read(repo, ".no-mistakes.yaml");
  assert.match(nm, /^  lint: "bun run lint"$/m, "repo-owned edit survived");
  assert.match(nm, /^  lint: 4$/m, "upstream synced change arrived");
  assert.doesNotMatch(nm, /<<<<<<</);
  // Baseline advanced to the new template so the next update merges from there.
  assert.match(read(repo, ".callum-dev/baseline/.no-mistakes.yaml"), /^  lint: 4$/m);
});

test("update surfaces a genuine conflict with markers and a non-zero exit", (t) => {
  const repo = initRepo(t);
  const file = path.join(repo, ".no-mistakes.yaml");
  fs.writeFileSync(file, read(repo, ".no-mistakes.yaml").replace("  lint: 5", "  lint: 9"));
  const upstream = upstreamCopy(t, (dir) => {
    const f = path.join(dir, ".no-mistakes.yaml");
    fs.writeFileSync(f, read(dir, ".no-mistakes.yaml").replace("  lint: 5", "  lint: 4"));
  });

  const result = run(repo, "update", { templates: upstream });
  assert.equal(result.status, 1);
  assert.match(read(repo, ".no-mistakes.yaml"), /<<<<<<</);
  assert.match(result.stderr, /conflict resolution/);
});

test("replace strategy overwrites settings.json wholesale; init-only leaves treehouse.toml alone", (t) => {
  const repo = initRepo(t);
  fs.writeFileSync(path.join(repo, ".claude/settings.json"), "{\n  \"hand\": \"edited\"\n}\n");
  fs.writeFileSync(path.join(repo, "treehouse.toml"), "max_trees = 99\n");
  const upstream = upstreamCopy(t, (dir) => {
    fs.writeFileSync(
      path.join(dir, "treehouse.toml"),
      read(dir, "treehouse.toml").replace("max_trees = 16", "max_trees = 8"),
    );
  });

  const result = run(repo, "update", { templates: upstream });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(read(repo, ".claude/settings.json"), read(TEMPLATES, ".claude/settings.json"));
  assert.equal(read(repo, "treehouse.toml"), "max_trees = 99\n");
});

// Ask git itself what the scaffolded .gitignore does. Reading the patterns is not
// good enough here: the rules that matter most are directory-vs-file distinctions
// (.no-mistakes/ ignored, .no-mistakes.yaml tracked), which is exactly what eyeballing
// a pattern list gets wrong. Exit 0 = ignored, 1 = not ignored.
function isIgnored(repo, target) {
  const result = spawnSync("git", ["check-ignore", "-q", "--no-index", target], {
    cwd: repo,
    encoding: "utf-8",
  });
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore: ${result.stderr}`);
  return result.status === 0;
}

test("the scaffolded .gitignore ignores this system's state but keeps its config tracked", (t) => {
  const repo = initRepo(t);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);

  // Generated state - must be ignored. .treehouse/ is the sharpest one: the shipped
  // treehouse.toml sets root = "./", so worktrees (full copies of the repo) land here.
  for (const target of [
    ".treehouse/1/myrepo/package.json",
    ".no-mistakes/worktrees/abc/run-1/server/index.ts",
    ".claude/worktrees/some-tree/file.ts",
    ".claude/settings.local.json",
    "node_modules/left-pad/index.js",
    "test-results/failed-1/trace.zip",
    "playwright-report/index.html",
    "server/__pycache__/app.cpython-311.pyc",
    ".env",
    "debug.log",
  ]) {
    assert.equal(isIgnored(repo, target), true, `expected ignored: ${target}`);
  }

  // Committed on purpose. Ignoring any of these looks tidy and breaks things quietly:
  // the two .callum-dev paths are what make `update` a 3-way merge, and .no-mistakes.yaml
  // sits right beside the ignored .no-mistakes/ directory.
  for (const target of [
    ".no-mistakes.yaml",
    ".callum-dev.json",
    ".callum-dev/baseline/.no-mistakes.yaml",
    ".callum-dev/baseline/gitignore",
    ".gitignore",
    "CLAUDE.md",
    ".claude/settings.json",
    ".devcontainer/devcontainer.json",
    "treehouse.toml",
    ".env.example",
  ]) {
    assert.equal(isIgnored(repo, target), false, `expected tracked: ${target}`);
  }
});

test("update carries a new synced ignore rule forward without dropping repo-owned entries", (t) => {
  const repo = initRepo(t);

  // A repo adds its own path in the repo-owned block at the bottom.
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    read(repo, ".gitignore").replace(
      "# --- end repo-owned ---",
      "/server/data/\n# --- end repo-owned ---",
    ),
  );

  // Upstream starts ignoring a newly-generated artefact. Anchor on the rule line, not
  // a bare substring - `.treehouse/` also appears in the comment above it.
  const upstream = upstreamCopy(t, (dir) => {
    const patched = read(dir, "gitignore").replace(
      /^\.treehouse\/$/m,
      ".treehouse/\n.brand-new-tool-cache/",
    );
    assert.match(patched, /^\.brand-new-tool-cache\/$/m, "test setup should patch the rule line");
    fs.writeFileSync(path.join(dir, "gitignore"), patched);
  });

  const result = run(repo, "update", { templates: upstream });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const merged = read(repo, ".gitignore");
  assert.match(merged, /^\.brand-new-tool-cache\/$/m, "upstream addition should come forward");
  assert.match(merged, /^\/server\/data\/$/m, "repo-owned entry should survive");
});

test("update with unchanged templates is a no-op; check reports drift via the stamp", (t) => {
  const repo = initRepo(t);

  const noop = run(repo, "update");
  assert.equal(noop.status, 0, noop.stderr);
  assert.match(noop.stdout, /Already in sync/);

  assert.equal(run(repo, "check").status, 0);

  const stampFile = path.join(repo, ".callum-dev.json");
  const stamp = JSON.parse(read(repo, ".callum-dev.json"));
  fs.writeFileSync(stampFile, JSON.stringify({ ...stamp, version: "0.0.1" }));
  const drifted = run(repo, "check");
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /Template drift/);

  const update = run(repo, "update");
  assert.equal(update.status, 0, update.stderr);
  assert.equal(run(repo, "check").status, 0);
});
