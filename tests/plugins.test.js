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
// marketplace, inst-<id> for a user-scope installed plugin, proj-<n> ("<id>|<projectPath>") for a
// project-scope one. `uninstall` succeeds only when run from a project install's path. `marketplace add <source>` names the
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
  "list --json")
    { ids inst | jq -R '{id: ., scope: "user", version: "1.0.0"}'
      for f in "$s"/proj-*; do
        [ -e "$f" ] && jq -R 'split("|") | {id: .[0], scope: "project", version: "1.0.0", projectPath: .[1]}' "$f"
      done; } | jq -s . ;;
  "marketplace list")
    ids mkt | while read -r n; do
      src=""; [ -e "$s/src-$n" ] && src=$(cat "$s/src-$n")
      jq -n --arg n "$n" --arg l "\${src%%#*}" --arg r "\${src#*#}" --arg src "$src" \
        '{name: $n} + (if $l != "" then {repo: $l} else {} end) + (if ($src | contains("#")) then {ref: $r} else {} end)'
    done | jq -s . ;;
  "marketplace remove")
    rm -f "$s/mkt-$3" "$s/src-$3" "$s/inst-"*"@$3"
    for f in "$s"/proj-*; do [ -e "$f" ] && grep -q "@$3|" "$f" && rm -f "$f"; done
    echo "✔ Removed marketplace" ;;
  "uninstall "*)
    for f in "$s"/proj-*; do
      [ -e "$f" ] && [ "$(cat "$f")" = "$2|$PWD" ] && { rm -f "$f"; echo "✔ Uninstalled $2"; exit 0; }
    done
    echo "✘ Failed to uninstall plugin \"$2\": installed in user scope, not project"; exit 1 ;;
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

// The stub git: `ls-remote` answers from $STUB/git-<ref> (its content is the exit code; no
// file means the ref resolves), records the call in $STUB/gitcalls, and $STUB/githang makes it
// hang. Anything else runs the real git.
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const GIT_STUB = `#!/bin/bash
[ "$1" = ls-remote ] || exec ${REAL_GIT} "$@"
echo "$*" >> "$STUB/gitcalls"
[ -e "$STUB/githang" ] && exec sleep 600
ref="\${@: -2:1}"; ref="\${ref#refs/tags/}"
[ -e "$STUB/git-$ref" ] && exit "$(cat "$STUB/git-$ref")"
exit 0
`;

// A temp dir with the stub on PATH and a workspace (a git repo when `settings` is given,
// with .claude/settings.json set to it unless it is null).
function setup(t, { repo = false, settings = null, installed = [], marketplaces = [], projects = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const ws = path.join(dir, "ws");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(bin, "claude"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), GIT_STUB, { mode: 0o755 });
  for (const id of installed) fs.writeFileSync(path.join(state, `inst-${id}`), "");
  projects.forEach(([id, p], i) => fs.writeFileSync(path.join(state, `proj-${i}`), `${id}|${p}`));
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
  assert.deepEqual(r.calls, ["/ list --json", "/ marketplace list --json"]);
  assert.equal(r.log, "");
});

// Claude cannot move a marketplace's ref in place (observed with the real CLI, see PR #215):
// `marketplace add` at a new ref is refused while the old entry exists, and `update` and
// `install` keep the old ref and plugin version. So a changed ref is remove + add + install.
const PIN = (ref) => ({
  extraKnownMarketplaces: { callum: { source: { source: "github", repo: "cbundy/dev-system", ...(ref && { ref }) } } },
  enabledPlugins: { "callum-flow@callum": true },
});
function withMarketplaceAt(ctx, src) {
  fs.writeFileSync(path.join(ctx.dir, "state", "mkt-callum"), "");
  fs.writeFileSync(path.join(ctx.dir, "state", "src-callum"), src);
  fs.writeFileSync(path.join(ctx.dir, "state", "inst-callum-flow@callum"), "");
}

test("a repo moves the pinned ref: the marketplace is removed, re-added at the new ref, the plugin reinstalled", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0") });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system#v0.10.0",
    "/ install callum-flow@callum",
  ]);
  assert.match(r.log, /marketplace callum moved from v0\.9\.0 to v0\.10\.0/);
  assert.doesNotMatch(r.log, /WARNING/);
  const again = run(ctx, "install_plugins");
  assert.deepEqual(changes(again.calls.slice(r.calls.length)), []);
});

test("the marketplace already at the pinned ref is left alone", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0") });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.10.0");
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), []);
  assert.equal(r.log, "");
});

for (const source of [
  { source: "github", repo: "cbundy/dev-system" },
  { source: "git", url: "https://example.test/callum" },
]) {
  for (const ref of ["v0.10.0", null]) {
    for (const moved of [false, true]) {
      // A no-ref declaration at the image default's location (the github case) inherits the
      // image's pin (#373); one at another location (the git URL case) stays unpinned.
      const inherited = !ref && source.repo === "cbundy/dev-system" ? "v0.9.0" : ref;
      test(`shared ${source.source} marketplace uses the repo ${inherited || "unpinned"} source once, moved=${moved}`, (t) => {
        const settings = {
          extraKnownMarketplaces: { callum: { source: { ...source, ...(ref && { ref }) } } },
          enabledPlugins: { "other@callum": true, "extra@callum": true },
        };
        const ctx = setup(t, { settings, installed: ["other@callum", "extra@callum"] });
        const location = source.repo || source.url;
        const desired = `${location}${inherited ? `#${inherited}` : ""}`;
        withMarketplaceAt(ctx, moved ? `${location}#v0.8.0` : desired);
        const env = { DEV_DEFAULT_PLUGINS: "callum-flow@callum=cbundy/dev-system#v0.9.0" };
        const r = run(ctx, "install_plugins", env);
        assert.equal(r.status, 0, r.log);
        assert.deepEqual(changes(r.calls), moved ? [
          "/ marketplace remove callum",
          `/ marketplace add ${desired}`,
          "/ install other@callum",
          "/ install extra@callum",
          "/ install callum-flow@callum",
        ] : []);
        assert.doesNotMatch(r.log, /WARNING/);
        assert.equal(fs.readFileSync(path.join(ctx.dir, "state", "src-callum"), "utf8").trim(), desired);
        const again = run(ctx, "install_plugins", env);
        assert.equal(again.status, 0, again.log);
        assert.deepEqual(changes(again.calls.slice(r.calls.length)), []);
        assert.equal(again.log, "");
      });
    }
  }
}

test("a repo plugin without a declaration leaves migration to the image source", (t) => {
  const ctx = setup(t, { settings: { enabledPlugins: { "other@callum": true } }, installed: ["callum-flow@callum", "other@callum"] });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  const env = { DEV_DEFAULT_PLUGINS: "callum-flow@callum=cbundy/dev-system#v0.10.0" };
  const r = run(ctx, "install_plugins", env);
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system#v0.10.0",
    "/ install other@callum",
    "/ install callum-flow@callum",
  ]);
});

test("multiple image plugins sharing a marketplace migrate once using the first source", (t) => {
  const ctx = setup(t);
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.8.0");
  const env = {
    DEV_DEFAULT_PLUGINS: "callum-flow@callum=cbundy/dev-system#v0.10.0 other@callum=cbundy/dev-system#v0.9.0",
  };
  const r = run(ctx, "install_plugins", env);
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system#v0.10.0",
    "/ install callum-flow@callum",
    "/ install other@callum",
  ]);
  const again = run(ctx, "install_plugins", env);
  assert.equal(again.status, 0, again.log);
  assert.deepEqual(changes(again.calls.slice(r.calls.length)), []);
  assert.equal(again.log, "");
});

test("a repo that drops the pin moves the marketplace back to the unpinned source", (t) => {
  const ctx = setup(t, { settings: PIN(null) });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system",
    "/ install callum-flow@callum",
  ]);
});

test("the image's default pin moves the same way when the repo declares nothing", (t) => {
  const ctx = setup(t);
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: "callum-flow@callum=cbundy/dev-system#v0.10.0" });
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system#v0.10.0",
    "/ install callum-flow@callum",
  ]);
});

test("a marketplace from a different repo is never removed for a ref difference", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0") });
  withMarketplaceAt(ctx, "someone/else#v1");
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), []);
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

for (const extraKnownMarketplaces of [undefined, { other: {} }, { callum: null }]) {
  test(`an enabled default with no marketplace declaration keeps the image source: ${JSON.stringify(extraKnownMarketplaces)}`, (t) => {
    const ctx = setup(t, {
      settings: { enabledPlugins: { "callum-flow@callum": true }, extraKnownMarketplaces },
    });
    const check = run(
      ctx,
      'w=$(wanted_default_plugins "$(repo_settings)"); not_installed "$w" ""; default_plugin_fix "$w"',
    );
    assert.equal(check.status, 0, check.log);
    assert.equal(check.stdout, "callum-flow@callum cbundy/dev-system\nclaude plugin marketplace add cbundy/dev-system; claude plugin install callum-flow@callum");
    const r = run(ctx, "install_plugins");
    assert.equal(r.status, 0, r.log);
    assert.deepEqual(changes(r.calls), ["/ marketplace add cbundy/dev-system", "/ install callum-flow@callum"]);
    assert.doesNotMatch(r.log, /WARNING/);
    const again = run(ctx, "install_plugins");
    assert.equal(again.status, 0, again.log);
    assert.deepEqual(changes(again.calls), changes(r.calls));
    assert.equal(again.log, "");
  });
}

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
  assert.deepEqual(r.calls, ["/ list --json"]);
  assert.equal(r.log, "");
});

test("DEV_DEFAULT_PLUGINS empty: no repo plugins means no claude call but the installs listing", (t) => {
  const ctx = setup(t);
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: "" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["/ list --json"]);
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

test("this repo's marketplace declares the callum-flow plugin under callum", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.name, "callum");
  assert.ok(marketplace.plugins.some((p) => p.name === "callum-flow"));
});

// A pin to a ref that is not on the remote (a release pinned before its tag exists) must not
// remove the installed marketplace: removing it uninstalls the plugin and the re-add fails.
const gitCalls = (ctx) => {
  const f = path.join(ctx.dir, "gitcalls");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : [];
};
const warnings = (r) => r.log.split("\n").filter((l) => /WARNING/.test(l));

for (const code of ["2", "128"]) {
  test(`a pin to a ref git cannot find (exit ${code}) keeps the marketplace and plugin, with one WARNING`, (t) => {
    const ctx = setup(t, { settings: PIN("v9.9.9") });
    withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
    fs.writeFileSync(path.join(ctx.dir, "git-v9.9.9"), code);
    const r = run(ctx, "install_plugins");
    assert.equal(r.status, 0, r.log);
    assert.deepEqual(changes(r.calls), []);
    assert.equal(warnings(r).length, 1, r.log);
    assert.match(r.log, /marketplace callum is wanted at ref v9\.9\.9.*keeping it at v0\.9\.0/);
    assert.match(r.log, /Fix: if a release is in progress/);
    assert.ok(fs.existsSync(path.join(ctx.dir, "state", "inst-callum-flow@callum")));
    assert.match(gitCalls(ctx)[0], /ls-remote --exit-code https:\/\/github\.com\/cbundy\/dev-system\.git refs\/tags\/v9\.9\.9 refs\/heads\/v9\.9\.9/);
  });
}

test("a git check that hangs is cut off by the step's deadline and removes nothing", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0") });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  fs.writeFileSync(path.join(ctx.dir, "githang"), "");
  const started = Date.now();
  const r = run(ctx, "install_plugins", { DEV_PLUGIN_INSTALL_TIMEOUT: "2" });
  assert.equal(r.status, 0, r.log);
  assert.ok(Date.now() - started < 20000, "returned within the deadline plus grace");
  assert.deepEqual(changes(r.calls), []);
  assert.ok(fs.existsSync(path.join(ctx.dir, "state", "inst-callum-flow@callum")));
});

test("a move to no ref, or to a full commit SHA, never asks git", (t) => {
  const ctx = setup(t, { settings: PIN(null) });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.equal(changes(r.calls)[0], "/ marketplace remove callum");
  assert.deepEqual(gitCalls(ctx), []);
  const sha = "a".repeat(40);
  const ctx2 = setup(t, { settings: PIN(sha) });
  withMarketplaceAt(ctx2, "cbundy/dev-system#v0.9.0");
  const r2 = run(ctx2, "install_plugins");
  assert.equal(changes(r2.calls)[0], "/ marketplace remove callum");
  assert.deepEqual(gitCalls(ctx2), []);
});

test("a git URL marketplace is checked at its URL as is", (t) => {
  const settings = { extraKnownMarketplaces: { callum: { source: { source: "git", url: "https://example.test/callum", ref: "v1" } } }, enabledPlugins: { "callum-flow@callum": true } };
  const ctx = setup(t, { settings });
  fs.writeFileSync(path.join(ctx.dir, "state", "mkt-callum"), "");
  fs.writeFileSync(path.join(ctx.dir, "state", "src-callum"), "https://example.test/callum#v0");
  fs.writeFileSync(path.join(ctx.dir, "state", "inst-callum-flow@callum"), "");
  fs.writeFileSync(path.join(ctx.dir, "git-v1"), "2");
  const r = run(ctx, "install_plugins");
  assert.match(gitCalls(ctx)[0], /ls-remote --exit-code https:\/\/example\.test\/callum refs\/tags\/v1/);
  assert.deepEqual(changes(r.calls), []);
});

// DEV_CANDIDATE_PLUGIN_REF repoints the cbundy/dev-system marketplace at a candidate ref.
const RC = "v0.28.0-rc.1";
test("the candidate ref overrides the repo's declared ref", (t) => {
  const ctx = setup(t, { settings: PIN("v0.27.0") });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.27.0");
  const r = run(ctx, "install_plugins", { DEV_CANDIDATE_PLUGIN_REF: RC });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    `/ marketplace add cbundy/dev-system#${RC}`,
    "/ install callum-flow@callum",
  ]);
  assert.doesNotMatch(r.log, /WARNING/);
});

test("the candidate ref overrides the image default when the repo declares nothing", (t) => {
  const ctx = setup(t);
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.27.0");
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: `${DEFAULT}#v0.27.0`, DEV_CANDIDATE_PLUGIN_REF: RC });
  assert.deepEqual(changes(r.calls).slice(0, 2), ["/ marketplace remove callum", `/ marketplace add cbundy/dev-system#${RC}`]);
});

test("an untagged candidate ref keeps the installed marketplace", (t) => {
  const ctx = setup(t, { settings: PIN("v0.27.0") });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.27.0");
  fs.writeFileSync(path.join(ctx.dir, `git-${RC}`), "2");
  const r = run(ctx, "install_plugins", { DEV_CANDIDATE_PLUGIN_REF: RC });
  assert.deepEqual(changes(r.calls), []);
  assert.equal(warnings(r).length, 1, r.log);
});

test("the candidate ref leaves a marketplace at another location alone", (t) => {
  const settings = { extraKnownMarketplaces: { callum: { source: { source: "git", url: "https://example.test/callum", ref: "v1" } } }, enabledPlugins: { "callum-flow@callum": true } };
  const ctx = setup(t, { settings });
  fs.writeFileSync(path.join(ctx.dir, "state", "mkt-callum"), "");
  fs.writeFileSync(path.join(ctx.dir, "state", "src-callum"), "https://example.test/callum#v1");
  fs.writeFileSync(path.join(ctx.dir, "state", "inst-callum-flow@callum"), "");
  const r = run(ctx, "install_plugins", { DEV_CANDIDATE_PLUGIN_REF: RC });
  assert.deepEqual(changes(r.calls), []);
  assert.deepEqual(gitCalls(ctx), []);
});

test("the candidate ref also applies to the https git URL of this repo", (t) => {
  const r = run(setup(t), 'wanted_marketplaces "" "" "callum-flow@callum https://github.com/cbundy/dev-system.git#v0.1.0"', { DEV_CANDIDATE_PLUGIN_REF: RC });
  assert.equal(r.stdout.trim(), `callum https://github.com/cbundy/dev-system.git#${RC}`);
});

test("an invalid candidate ref logs one WARNING and is ignored", (t) => {
  const ctx = setup(t, { settings: PIN("v0.27.0") });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.27.0");
  const r = run(ctx, "install_plugins", { DEV_CANDIDATE_PLUGIN_REF: "bad ref;" });
  assert.deepEqual(changes(r.calls), []);
  assert.equal(warnings(r).length, 1, r.log);
  assert.match(r.log, /DEV_CANDIDATE_PLUGIN_REF "bad ref;" is not a valid ref/);
});

// A repo declaration with no ref at the image default's location takes the default's ref (the
// image's pin), so a stale plugin moves up instead of staying at the release it was first
// installed at (#373).
const PINNED_DEFAULT = "callum-flow@callum=cbundy/dev-system#v0.26.0";
const wanted = (ctx, env = {}) =>
  run(ctx, `wanted_marketplaces "$(repo_settings)" "" "$(default_plugins)"`, { DEV_DEFAULT_PLUGINS: PINNED_DEFAULT, ...env }).stdout.trim();

test("a declaration with no ref inherits the image default's ref", (t) => {
  assert.equal(wanted(setup(t, { settings: PIN(null) })), "callum cbundy/dev-system#v0.26.0");
});

test("a declared ref wins over the image default's", (t) => {
  assert.equal(wanted(setup(t, { settings: PIN("v0.30.0") })), "callum cbundy/dev-system#v0.30.0");
});

test("a declaration at another location keeps no ref", (t) => {
  const settings = { extraKnownMarketplaces: { callum: { source: { source: "github", repo: "someone/else" } } } };
  assert.equal(wanted(setup(t, { settings })), "callum someone/else");
});

test("the candidate ref overrides an inherited ref", (t) => {
  assert.equal(wanted(setup(t, { settings: PIN(null) }), { DEV_CANDIDATE_PLUGIN_REF: "v0.40.0-rc.1" }), "callum cbundy/dev-system#v0.40.0-rc.1");
});

test("an image default with no ref leaves a no-ref declaration unchanged", (t) => {
  assert.equal(wanted(setup(t, { settings: PIN(null) }), { DEV_DEFAULT_PLUGINS: DEFAULT }), "callum cbundy/dev-system");
});

test("a no-ref declaration and an older no-ref install: the marketplace moves to the image's pin and callum-flow is reinstalled", (t) => {
  const ctx = setup(t, { settings: PIN(null) });
  withMarketplaceAt(ctx, "cbundy/dev-system");
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: PINNED_DEFAULT });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system#v0.26.0",
    "/ install callum-flow@callum",
  ]);
  assert.match(r.log, /marketplace callum moved from no ref to v0\.26\.0/);
  assert.doesNotMatch(r.log, /WARNING/);
  const again = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: PINNED_DEFAULT });
  assert.deepEqual(changes(again.calls.slice(r.calls.length)), []);
});

// #462: `marketplace remove` uninstalls every plugin of the marketplace, so the ones a user
// installed by hand come back after the move too.
test("a hand-installed plugin of a moved marketplace is installed again", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0"), installed: ["factory-hud@callum", "other@elsewhere"] });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    "/ marketplace remove callum",
    "/ marketplace add cbundy/dev-system#v0.10.0",
    "/ install callum-flow@callum",
    "/ install factory-hud@callum",
  ]);
  assert.ok(fs.existsSync(path.join(ctx.dir, "state", "inst-factory-hud@callum")));
  assert.doesNotMatch(r.log, /WARNING/);
});

test("a hand-installed plugin that fails to reinstall is one WARNING and does not stop the rest", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0"), installed: ["factory-hud@callum"] });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  // The stub refuses to install factory-hud.
  const stub = path.join(ctx.dir, "bin", "claude");
  fs.writeFileSync(stub, fs.readFileSync(stub, "utf8").replace("  install\\ *)", '  install\\ factory-hud*) echo "✘ Failed to install plugin: boom"; exit 1 ;;\n  install\\ *)'));
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.ok(fs.existsSync(path.join(ctx.dir, "state", "inst-callum-flow@callum")));
  assert.equal((r.log.match(/WARNING/g) || []).length, 1, r.log);
  assert.match(r.log, /could not install Claude plugin factory-hud@callum: Failed to install plugin: boom/);
  assert.match(r.log, /Fix: .* then run: dev-init --plugins; claude plugin install factory-hud@callum$/m);
});

test("out of time before a hand-installed plugin is reinstalled: the Fix names its install", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0"), installed: ["factory-hud@callum"] });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.9.0");
  // The stub hangs on installing callum-flow, which uses up the step's deadline.
  const stub = path.join(ctx.dir, "bin", "claude");
  fs.writeFileSync(stub, fs.readFileSync(stub, "utf8").replace("  install\\ *)", "  install\\ callum-flow*) exec sleep 600 ;;\n  install\\ *)"));
  const r = run(ctx, "install_plugins", { DEV_PLUGIN_INSTALL_TIMEOUT: "3" });
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /ran out of its 3s \(DEV_PLUGIN_INSTALL_TIMEOUT\) - not installed: factory-hud@callum$/m);
  assert.match(r.log, /Fix: .* then run: dev-init --plugins; claude plugin install factory-hud@callum$/m);
});

test("a marketplace that is not moved keeps its plugins untouched", (t) => {
  const ctx = setup(t, { settings: PIN("v0.10.0"), installed: ["factory-hud@callum"] });
  withMarketplaceAt(ctx, "cbundy/dev-system#v0.10.0");
  const r = run(ctx, "install_plugins");
  assert.deepEqual(changes(r.calls), []);
});

test("orphaned project installs are pruned from inside their recreated path, which is removed again", (t) => {
  const ghost = path.join(os.tmpdir(), `plugins-ghost-${process.pid}`, "worktrees", "abc", "repo");
  const live = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-live-"));
  t.after(() => {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `plugins-ghost-${process.pid}`), { recursive: true, force: true });
  });
  const ctx = setup(t, { installed: ["callum-flow@callum"], projects: [["callum-flow@callum", ghost], ["callum-flow@callum", live], ["callum-flow@callum", "relative/path"]] });
  fs.writeFileSync(path.join(live, "keep"), "x");
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [`${ghost} uninstall callum-flow@callum --scope project`]);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), `plugins-ghost-${process.pid}`)), "created directories are removed");
  assert.ok(fs.existsSync(path.join(live, "keep")), "an existing path is untouched");
  assert.match(r.log, /pruned 1 Claude plugin install\(s\)/);
  const left = fs.readdirSync(path.join(ctx.dir, "state")).filter((f) => f.startsWith("proj-"));
  assert.equal(left.length, 2);
});

test("orphaned project installs are pruned even when no plugin is wanted", (t) => {
  const ghost = path.join(os.tmpdir(), `plugins-ghost3-${process.pid}`);
  t.after(() => fs.rmSync(ghost, { recursive: true, force: true }));
  const ctx = setup(t, { projects: [["callum-flow@callum", ghost]] });
  const r = run(ctx, "install_plugins", { DEV_DEFAULT_PLUGINS: "" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [`${ghost} uninstall callum-flow@callum --scope project`]);
  assert.match(r.log, /pruned 1 Claude plugin install\(s\)/);
});

test("a plugin only installed for a pruned project path is installed in the same run", (t) => {
  const ghost = path.join(os.tmpdir(), `plugins-ghost4-${process.pid}`);
  t.after(() => fs.rmSync(ghost, { recursive: true, force: true }));
  const ctx = setup(t, { projects: [["callum-flow@callum", ghost]] });
  const r = run(ctx, "install_plugins");
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(changes(r.calls), [
    `${ghost} uninstall callum-flow@callum --scope project`,
    "/ marketplace add cbundy/dev-system",
    "/ install callum-flow@callum",
  ]);
});

test("nothing to prune: no log line", (t) => {
  const ctx = setup(t, { installed: ["callum-flow@callum"] });
  const r = run(ctx, "install_plugins");
  assert.equal(r.log, "");
});

test("an orphaned project install does not touch the repo's settings", (t) => {
  const ghost = path.join(os.tmpdir(), `plugins-ghost2-${process.pid}`);
  t.after(() => fs.rmSync(ghost, { recursive: true, force: true }));
  const ctx = setup(t, { settings: PIN("v0.10.0"), installed: ["callum-flow@callum"], marketplaces: ["callum"], projects: [["callum-flow@callum", ghost]] });
  fs.writeFileSync(path.join(ctx.dir, "state", "src-callum"), "cbundy/dev-system#v0.10.0");
  const file = path.join(ctx.ws, ".claude", "settings.json");
  const before = fs.readFileSync(file);
  run(ctx, "install_plugins");
  assert.deepEqual(fs.readFileSync(file), before);
});
