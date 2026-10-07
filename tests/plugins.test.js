// Tests for images/base/plugins.sh: install_plugins, the step of dev-init that installs the
// image's default Claude plugins (DEV_DEFAULT_PLUGINS, dev-system#148) and the ones the
// workspace repo enables (#112), and the helpers dev-doctor checks them with. Runs the
// library under bash against a stub `claude plugin` on PATH. images/base/test/test.sh covers
// the same step through the real dev-init and dev-doctor inside the image.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const BASE = path.join(__dirname, "..", "images", "base");
const WORKSPACE_SH = path.join(BASE, "workspace.sh");
const PLUGINS_SH = path.join(BASE, "plugins.sh");
const DEFAULT = "callum-flow@callum=cbundy/dev-system";

// The stub claude: it records each `claude plugin` call (directory and arguments) in
// $STUB/calls and keeps its state as files in $STUB/state - mkt-<name> for a known
// marketplace, inst-<id> for an installed plugin. `marketplace add <source>` names the
// marketplace "callum" for cbundy/dev-system, else after the source's last path part (no
// #ref), and fails for a source containing "fail"; `install` fails for an unknown
// marketplace. $STUB/hang makes every call hang.
const STUB = `#!/bin/bash
[ "$1" = plugin ] || exit 0
shift
echo "$PWD $*" >> "$STUB/calls"
[ -e "$STUB/hang" ] && exec sleep 600
s="$STUB/state"
mkdir -p "$s"
ids() { for f in "$s/$1"-*; do [ -e "$f" ] && echo "\${f#"$s/$1"-}"; done; }
case "$1 \${2:-}" in
  "list --json") ids inst | jq -R . | jq -s "map({id: .})" ;;
  "marketplace list") ids mkt | jq -R . | jq -s "map({name: .})" ;;
  "marketplace add")
    case "$3" in *fail*) echo "Adding marketplace…✘ Failed to add marketplace: could not clone"; exit 1 ;; esac
    n="\${3%%#*}"; n="\${n##*/}"; [ "\${3%%#*}" = cbundy/dev-system ] && n=callum
    touch "$s/mkt-$n"; echo "$3" > "$s/src-$n"; echo "✔ Successfully added marketplace: $n" ;;
  "marketplace update") ;;
  install\\ *)
    [ -e "$s/mkt-\${2##*@}" ] || { echo "✘ Failed to install plugin \\"$2\\": not found in marketplace \\"\${2##*@}\\""; exit 1; }
    touch "$s/inst-$2"; echo "✔ Successfully installed plugin: $2 (scope: user)" ;;
esac
`;

// A temp dir with the stub on PATH and a workspace (a git repo when `settings` is given,
// with .claude/settings.json set to it unless it is null).
function setup(t, { repo = false, settings = null, installed = [], marketplaces = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const ws = path.join(dir, "ws");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(bin, "claude"), STUB, { mode: 0o755 });
  for (const id of installed) fs.writeFileSync(path.join(state, `inst-${id}`), "");
  for (const m of marketplaces) fs.writeFileSync(path.join(state, `mkt-${m}`), "");
  if (repo || settings !== null) {
    spawnSync("git", ["init", "-q", ws]);
    if (settings !== null) {
      fs.mkdirSync(path.join(ws, ".claude"));
      fs.writeFileSync(
        path.join(ws, ".claude", "settings.json"),
        typeof settings === "string" ? settings : JSON.stringify(settings),
      );
    }
  }
  return { dir, ws };
}

// Runs a bash snippet with workspace.sh and plugins.sh sourced, the way dev-init does.
function run(ctx, script, env = {}) {
  const r = spawnSync(
    "bash",
    ["-c", `. "$1"; . "$2"; log() { echo "dev-init: $*" >&2; }; ${script}`, "bash", WORKSPACE_SH, PLUGINS_SH],
    {
      encoding: "utf8",
      cwd: ctx.ws,
      env: {
        ...process.env,
        PATH: `${path.join(ctx.dir, "bin")}:${process.env.PATH}`,
        STUB: ctx.dir,
        DEV_WORKSPACE: ctx.ws,
        DEV_REPO_URL: "",
        DEV_DEFAULT_PLUGINS: DEFAULT,
        ...env,
      },
    },
  );
  const callsFile = path.join(ctx.dir, "calls");
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [];
  return { status: r.status, stdout: r.stdout, log: r.stderr, calls };
}

// The calls that change something (not the listings).
const changes = (calls) => calls.filter((c) => !/ list( |$)/.test(c));

test("no repo: the default plugin's marketplace is added and the plugin installed, outside the workspace", (t) => {
  const ctx = setup(t);
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), ["/ marketplace add cbundy/dev-system", "/ install callum-flow@callum"]);
  assert.match(r.log, /^dev-init: installed Claude plugin callum-flow@callum$/m);
  assert.doesNotMatch(r.log, /WARNING/);
});

test("a repo that is not onboarded still gets the default plugin", (t) => {
  const ctx = setup(t, { settings: { permissions: { allow: [] } } });
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), ["/ marketplace add cbundy/dev-system", "/ install callum-flow@callum"]);
  assert.match(r.log, /installed Claude plugin callum-flow@callum/);
});

test("already installed: one listing and nothing else", (t) => {
  const ctx = setup(t, { installed: ["callum-flow@callum"], marketplaces: ["callum"] });
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["/ list --json"]);
  assert.equal(r.log, "");
});

test("a known marketplace is not added again", (t) => {
  const ctx = setup(t, { marketplaces: ["callum"] });
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), ["/ install callum-flow@callum"]);
});

test("an id that only contains an installed one still counts as missing", (t) => {
  const ctx = setup(t, { installed: ["flow@callum"], marketplaces: ["callum"] });
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), ["/ install callum-flow@callum"]);
});

test("a repo that enables the default plugin itself: installed once, from the repo's marketplace source", (t) => {
  const ctx = setup(t, {
    settings: {
      extraKnownMarketplaces: { callum: { source: { source: "github", repo: "cbundy/dev-system", ref: "v0.9.0" } } },
      enabledPlugins: { "callum-flow@callum": true },
    },
  });
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), ["/ marketplace add cbundy/dev-system#v0.9.0", "/ install callum-flow@callum"]);
  assert.equal(r.log.match(/installed Claude plugin/g).length, 1);
});

test("repo plugins go first, so a marketplace both name is added from the repo's source", (t) => {
  const ctx = setup(t, {
    settings: {
      extraKnownMarketplaces: { callum: { source: { source: "github", repo: "me/callum", ref: "dev" } } },
      enabledPlugins: { "other@callum": true },
    },
  });
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), [
    "/ marketplace add me/callum#dev",
    "/ install other@callum",
    "/ install callum-flow@callum",
  ]);
});

test("a repo that turns the default plugin off opts out of it", (t) => {
  const ctx = setup(t, { settings: { enabledPlugins: { "callum-flow@callum": false } } });
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.equal(r.log, "");
});

test("DEV_DEFAULT_PLUGINS empty: no repo plugins means no claude call at all", (t) => {
  const ctx = setup(t);
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: "" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.equal(r.log, "");
});

test("an invalid settings file is a WARNING, and the default plugin is still installed", (t) => {
  const ctx = setup(t, { settings: '{"enabledPlugins":' });
  const r = run(ctx, "install_plugins");
  assert.match(r.log, /WARNING: .*settings\.json is not valid JSON/);
  assert.deepEqual(changes(r.calls), ["/ marketplace add cbundy/dev-system", "/ install callum-flow@callum"]);
});

test("an invalid DEV_DEFAULT_PLUGINS entry is a WARNING and skipped; the valid ones are installed", (t) => {
  const ctx = setup(t);
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: `nomarket=me/x  ${DEFAULT}  a@b` });
  assert.equal(r.status, 0);
  assert.match(r.log, /^dev-init: WARNING: DEV_DEFAULT_PLUGINS entry "nomarket=me\/x" is not/m);
  assert.match(r.log, /^dev-init: WARNING: DEV_DEFAULT_PLUGINS entry "a@b" is not/m);
  assert.deepEqual(changes(r.calls), ["/ marketplace add cbundy/dev-system", "/ install callum-flow@callum"]);
});

test("a marketplace that cannot be added (no network): a WARNING with the fix, and exit 0", (t) => {
  const ctx = setup(t);
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: "p@m=me/fail" });
  assert.equal(r.status, 0);
  assert.match(
    r.log,
    /^dev-init: WARNING: could not add Claude plugin marketplace m from me\/fail: Failed to add marketplace: could not clone - Claude plugin p@m not installed\.$/m,
  );
  assert.match(r.log, /^dev-init: {3}Fix: check that git here can read me\/fail, then run: dev-init --plugins$/m);
  assert.ok(!r.calls.some((c) => c.includes("install p@m")));
});

test("a claude that hangs: the step stops at DEV_PLUGIN_INSTALL_TIMEOUT with one WARNING", (t) => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.dir, "hang"), "");
  const start = Date.now();
  const r = run(ctx, "install_plugins", { DEV_PLUGIN_INSTALL_TIMEOUT: "2" });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - start < 15000, `took ${Date.now() - start}ms`);
  assert.equal(r.log.match(/WARNING/g).length, 1, r.log);
  assert.match(
    r.log,
    /^dev-init: WARNING: the Claude plugin install ran out of its 2s \(DEV_PLUGIN_INSTALL_TIMEOUT\) - not installed: callum-flow@callum$/m,
  );
  assert.match(r.log, /Fix: .* then run: dev-init --plugins$/m);
});

test("wanted_default_plugins and default_plugin_fix: what dev-doctor checks and the fix it names", (t) => {
  const ctx = setup(t, { settings: { enabledPlugins: { "x@y": false } } });
  const r = run(
    ctx,
    'w=$(wanted_default_plugins "$(repo_settings)"); printf "%s\\n" "$w"; echo "--"; default_plugin_fix "$w"; echo; echo "--"; not_installed "$w" "x@y" && echo missing; not_installed "$w" "callum-flow@callum" || echo none',
    { DEV_DEFAULT_PLUGINS: `${DEFAULT} x@y=me/y` },
  );
  assert.equal(r.status, 0, r.log);
  assert.equal(
    r.stdout,
    [
      "callum-flow@callum cbundy/dev-system",
      "--",
      "claude plugin marketplace add cbundy/dev-system; claude plugin install callum-flow@callum",
      "--",
      "callum-flow@callum cbundy/dev-system",
      "missing",
      "none",
      "",
    ].join("\n"),
  );
});

test("the Dockerfile's default is the callum-flow plugin from this repo's marketplace", () => {
  const dockerfile = fs.readFileSync(path.join(BASE, "Dockerfile"), "utf8");
  assert.match(dockerfile, new RegExp(`^ENV DEV_DEFAULT_PLUGINS=${DEFAULT}$`, "m"));
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.name, "callum");
  assert.ok(marketplace.plugins.some((p) => p.name === "callum-flow"));
});
