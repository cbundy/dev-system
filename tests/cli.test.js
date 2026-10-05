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

function run(cwd, command, { input, templates, args = [] } = {}) {
  return spawnSync("node", [BIN, command, ...args], {
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

function initRepo(t, input = "myrepo\nbun run lint\nbun run test\n", args = []) {
  const repo = scratchRepo(t);
  const result = run(repo, "init", { input, args });
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

test("settings.json replaces synced content wholesale outside permissions.allow; init-only leaves treehouse.toml alone", (t) => {
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
  // No permissions.allow anywhere in play here, so this is a plain wholesale replace.
  assert.equal(read(repo, ".claude/settings.json"), read(TEMPLATES, ".claude/settings.json"));
  assert.equal(read(repo, "treehouse.toml"), "max_trees = 99\n");
});

// permissions.allow is the one repo-owned surface inside the otherwise fully-synced
// .claude/settings.json (issue dev-system#44): a worktree sub-agent only ever sees the
// committed file (never the gitignored, main-checkout-only settings.local.json), so a
// repo-specific allow entry (e.g. a local script) has to live here to reach sub-agents,
// and it must survive `callum-dev update` alongside the synced generic allow list.
test("update unions a repo-added permissions.allow entry with the synced list, and folds in a new upstream entry", (t) => {
  const repo = initRepo(t);

  const settingsPath = path.join(repo, ".claude/settings.json");
  const settings = JSON.parse(read(repo, ".claude/settings.json"));
  const repoEntry = "Bash(scripts/evidence-upload.sh *)";
  settings.permissions.allow.push(repoEntry);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  const upstreamEntry = "Bash(no-mistakes axi watch *)";
  const upstream = upstreamCopy(t, (dir) => {
    const file = path.join(dir, ".claude/settings.json");
    const template = JSON.parse(read(dir, ".claude/settings.json"));
    template.permissions.allow.push(upstreamEntry);
    fs.writeFileSync(file, JSON.stringify(template, null, 2) + "\n");
  });

  const result = run(repo, "update", { templates: upstream });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const merged = JSON.parse(read(repo, ".claude/settings.json"));
  const allow = merged.permissions.allow;
  assert.ok(allow.includes(repoEntry), "repo-owned entry survived the update");
  assert.ok(allow.includes(upstreamEntry), "new upstream entry landed");
  // Every original synced entry is still present too.
  for (const entry of JSON.parse(read(TEMPLATES, ".claude/settings.json")).permissions.allow) {
    assert.ok(allow.includes(entry), `original synced entry survived: ${entry}`);
  }
  assert.equal(allow.length, new Set(allow).size, "no duplicate entries");
});

test("a repo-added permissions.allow entry survives even when the synced list itself is unchanged", (t) => {
  const repo = initRepo(t);

  const settingsPath = path.join(repo, ".claude/settings.json");
  const settings = JSON.parse(read(repo, ".claude/settings.json"));
  const repoEntry = "Bash(scripts/dev-server.sh *)";
  settings.permissions.allow.push(repoEntry);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Upstream templates are untouched - this is a no-op update from the synced side.
  const result = run(repo, "update");
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const merged = JSON.parse(read(repo, ".claude/settings.json"));
  assert.ok(merged.permissions.allow.includes(repoEntry), "repo-owned entry survived");
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

// devcontainer.json is JSONC; every comment in the templates is a whole line.
function parseJsonc(content) {
  return JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
}

const DEVCONTAINER = ".devcontainer/devcontainer.json";
const BASE_IMAGE_TEMPLATE = ".devcontainer/devcontainer.base-image.json";
const PER_REPO_MOUNTS = ["claude", "codex", "no-mistakes", "agentsview"].map((tool) => ({
  type: "volume",
  source: `dev-system-\${devcontainerId}-${tool}`,
  target: `/persist/${tool}`,
}));

test("init defaults to the base-image devcontainer, with the per-repo /persist mounts", (t) => {
  const repo = initRepo(t);

  const config = parseJsonc(read(repo, DEVCONTAINER));
  assert.equal(config.name, "myrepo");
  assert.equal(config.image, "ghcr.io/cbundy/dev-system/base:2");
  assert.deepEqual(config.mounts, PER_REPO_MOUNTS);
  assert.equal(config.features, undefined, "the base image needs no callum-tools feature");

  assert.equal(JSON.parse(read(repo, ".callum-dev.json")).devcontainer, "base-image");
  // The baseline keeps the destination name, whichever template it came from.
  assert.equal(read(repo, `.callum-dev/baseline/${DEVCONTAINER}`), read(TEMPLATES, BASE_IMAGE_TEMPLATE));
});

// The agentsview URL is a secret set once per Docker host (images/base/README.md,
// "Central session history", cbundy/dev-system#103): the image's metadata mounts the
// shared dev-system-secrets volume, so no template may wire the URL or that mount.
test("the base-image devcontainer wires no secret: the image mounts dev-system-secrets", (t) => {
  const repo = initRepo(t);
  const content = read(repo, DEVCONTAINER);
  const config = parseJsonc(content);
  assert.doesNotMatch(content, /AGENTSVIEW_PG_URL|postgres(ql)?:\/\//);
  assert.equal(config.containerEnv, undefined);
  assert.deepEqual(config.remoteEnv, {});
  assert.ok(config.mounts.every((m) => !m.target.startsWith("/run/secrets")));
  assert.match(content, /dev-system-secrets/, "the header points at where the secret lives");
});

test("init picks the feature devcontainer from the prompt or --devcontainer", (t) => {
  for (const how of [
    { input: "myrepo\n\n\nfeature\n" },
    { input: "myrepo\n\n\n", args: ["--devcontainer", "feature"] },
    { input: "myrepo\n\n\n", args: ["--devcontainer=feature"] },
  ]) {
    const repo = scratchRepo(t);
    const result = run(repo, "init", how);
    assert.equal(result.status, 0, result.stderr);
    const config = parseJsonc(read(repo, DEVCONTAINER));
    assert.ok(config.features["ghcr.io/cbundy/dev-system/callum-tools:1"], JSON.stringify(how));
    assert.equal(JSON.parse(read(repo, ".callum-dev.json")).devcontainer, "feature");
    assert.match(result.stderr, /warning: devcontainer 'feature' is deprecated/, JSON.stringify(how));
  }
});

test("base-image init and update print no deprecation warning", (t) => {
  const repo = scratchRepo(t);
  const init = run(repo, "init", { input: "myrepo\n\n\n\n" });
  assert.equal(init.status, 0, init.stderr);
  assert.doesNotMatch(init.stderr, /warning:/);
  const update = run(repo, "update");
  assert.equal(update.status, 0, update.stderr);
  assert.doesNotMatch(update.stderr, /warning:/);
});

test("init re-asks on an unknown devcontainer kind, and --devcontainer rejects one", (t) => {
  const repo = initRepo(t, "myrepo\n\n\nbase\nfeature\n");
  assert.equal(JSON.parse(read(repo, ".callum-dev.json")).devcontainer, "feature");

  const bad = run(scratchRepo(t), "init", { args: ["--devcontainer", "base"] });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--devcontainer must be one of: base-image, feature/);
});

test("base-image devcontainer: repo-owned edits survive an update that changes the synced mounts", (t) => {
  const repo = initRepo(t);
  const file = path.join(repo, DEVCONTAINER);
  const repoMount =
    '    { "type": "volume", "source": "nas-myrepo", "target": "/shared" },\n';
  fs.writeFileSync(
    file,
    read(repo, DEVCONTAINER)
      .replace('"image": "ghcr.io/cbundy/dev-system/base:2"', '"build": { "dockerfile": "Dockerfile" }')
      .replace(
        '    // "<REPLACE: repo-specific env vars, e.g. DEV_LOGIN_TOOLS>": "<REPLACE>"',
        '    "DEV_LOGIN_TOOLS": "claude,gh"',
      )
      .replace(/( *\/\/ --- end repo-owned ---\n)(\n *\/\/ Per-repo)/, `${repoMount}$1$2`),
  );
  assert.equal(parseJsonc(read(repo, DEVCONTAINER)).mounts.length, 5, "test setup should add a mount");

  const upstream = upstreamCopy(t, (dir) => {
    const f = path.join(dir, BASE_IMAGE_TEMPLATE);
    fs.writeFileSync(f, read(dir, BASE_IMAGE_TEMPLATE).replaceAll("dev-system-${devcontainerId}", "ds-${devcontainerId}"));
  });

  const result = run(repo, "update", { templates: upstream });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const config = parseJsonc(read(repo, DEVCONTAINER));
  assert.deepEqual(config.build, { dockerfile: "Dockerfile" }, "repo-owned build block survived");
  assert.equal(config.image, undefined);
  assert.deepEqual(config.remoteEnv, { DEV_LOGIN_TOOLS: "claude,gh" }, "repo-owned env survived");
  assert.deepEqual(config.mounts, [
    { type: "volume", source: "nas-myrepo", target: "/shared" },
    ...PER_REPO_MOUNTS.map((m) => ({ ...m, source: m.source.replace("dev-system-", "ds-") })),
  ]);
});

test("update --devcontainer switches a feature repo to the base image; a stamp without the key is a feature repo", (t) => {
  const repo = initRepo(t, "myrepo\n\n\n", ["--devcontainer", "feature"]);
  // A repo scaffolded before the choice existed.
  const stampFile = path.join(repo, ".callum-dev.json");
  const { devcontainer, ...legacy } = JSON.parse(read(repo, ".callum-dev.json"));
  assert.equal(devcontainer, "feature");
  fs.writeFileSync(stampFile, JSON.stringify(legacy, null, 2) + "\n");

  const noop = run(repo, "update");
  assert.equal(noop.status, 0, noop.stderr);
  assert.match(noop.stdout, /Already in sync/, "a legacy stamp stays on the feature template");
  assert.match(noop.stderr, /warning: devcontainer 'feature' is deprecated/);

  const result = run(repo, "update", { args: ["--devcontainer", "base-image"] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /switched {2}devcontainer: feature -> base-image/);
  assert.doesNotMatch(result.stderr, /warning:/, "no warning once the repo has moved");

  const config = parseJsonc(read(repo, DEVCONTAINER));
  assert.equal(config.name, "myrepo", "the repo's name came across");
  assert.equal(config.image, "ghcr.io/cbundy/dev-system/base:2");
  assert.deepEqual(config.mounts, PER_REPO_MOUNTS);
  assert.equal(JSON.parse(read(repo, ".callum-dev.json")).devcontainer, "base-image");
  assert.equal(read(repo, `.callum-dev/baseline/${DEVCONTAINER}`), read(TEMPLATES, BASE_IMAGE_TEMPLATE));

  // The choice sticks: the next plain update stays on the base image.
  assert.match(run(repo, "update").stdout, /Already in sync/);
});
