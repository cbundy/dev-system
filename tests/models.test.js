// Tests for images/base/models.env, the single source of truth for the models the
// no-mistakes pipeline runs on (dev-system#161), and images/base/models.sh, the parser
// dev-init reads it with (never sourcing it). Also keeps the deprecated callum-tools
// feature's codexModel default from drifting away from models.env.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const MODELS_ENV = path.join(ROOT, "images", "base", "models.env");
const MODELS_SH = path.join(ROOT, "images", "base", "models.sh");
const FEATURE_JSON = path.join(ROOT, "features", "src", "callum-tools", "devcontainer-feature.json");

// models_value <file> <key> through a real sh, as dev-init calls it.
function modelsValue(file, key) {
  const r = spawnSync("sh", ["-c", '. "$1" && models_value "$2" "$3"', "sh", MODELS_SH, file, key], {
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout.replace(/\n$/, ""), stderr: r.stderr };
}

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "models.env");
  fs.writeFileSync(file, content);
  return file;
}

test("models.env sets both models to parseable values", () => {
  for (const key of ["CODEX_MODEL", "CLAUDE_MODEL"]) {
    const r = modelsValue(MODELS_ENV, key);
    assert.equal(r.status, 0, `${key}: ${r.stderr}`);
    assert.match(r.stdout, /^[A-Za-z0-9._:/-]+$/);
  }
});

test("models.env holds only KEY=value lines, comments and blank lines", () => {
  for (const line of fs.readFileSync(MODELS_ENV, "utf8").split("\n")) {
    assert.match(line, /^(#.*|[A-Z_]+=[A-Za-z0-9._:/,-]+|)$/, `unexpected line: ${line}`);
  }
});

test("models.env sets the pipeline's agent order to codex, then claude", () => {
  assert.deepEqual(modelsValue(MODELS_ENV, "AGENTS"), { status: 0, stdout: "codex,claude", stderr: "" });
});

test("models_value accepts AGENTS as a comma-separated list of agent names", (t) => {
  for (const good of ["codex", "codex,claude", "claude,codex,grok", "acp:my-agent,pi", "open_code,rovodev", "0x,9a"]) {
    const r = modelsValue(tempFile(t, `AGENTS=${good}\n`), "AGENTS");
    assert.deepEqual(r, { status: 0, stdout: good, stderr: "" }, `AGENTS=${good} should be accepted`);
  }
});

test("models_value rejects a malformed AGENTS list, with a note on stderr", (t) => {
  const bad = [
    "", // empty
    "codex,,claude", // empty entry
    ",codex",
    "codex,",
    ",",
    "codex, claude", // spaces
    "codex claude",
    "Codex", // uppercase
    "codex,CLAUDE",
    "-codex", // must start with a letter or digit
    "codex,:x",
    "codex;claude", // shell characters
    "$(touch pwned)",
    "`id`",
    "codex|claude",
    '"codex"',
    "codex/claude", // a model character, not an agent one
    "gpt-5.1",
  ];
  for (const value of bad) {
    const r = modelsValue(tempFile(t, `AGENTS=${value}\n`), "AGENTS");
    assert.equal(r.status, 2, `AGENTS=${JSON.stringify(value)} should be rejected`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /ignored AGENTS .* comma-separated list of agent names/);
  }
});

test("model keys keep their own charset: a comma is not a model character", (t) => {
  assert.equal(modelsValue(tempFile(t, "CODEX_MODEL=a,b\n"), "CODEX_MODEL").status, 2);
});

test("the callum-tools feature's codexModel default matches CODEX_MODEL in models.env", () => {
  const feature = JSON.parse(fs.readFileSync(FEATURE_JSON, "utf8"));
  assert.equal(feature.options.codexModel.default, modelsValue(MODELS_ENV, "CODEX_MODEL").stdout);
});

test("models_value reads known keys past comments, blank lines and surrounding space", (t) => {
  const file = tempFile(t, "# a comment\n\n  # indented comment\n  CODEX_MODEL=gpt-x.1  \r\nCLAUDE_MODEL=org/claude:v1-2_3\n");
  assert.deepEqual(modelsValue(file, "CODEX_MODEL"), { status: 0, stdout: "gpt-x.1", stderr: "" });
  assert.equal(modelsValue(file, "CLAUDE_MODEL").stdout, "org/claude:v1-2_3");
});

test("models_value: the last line that sets a key wins", (t) => {
  const file = tempFile(t, "CODEX_MODEL=first\nCODEX_MODEL=second\n");
  assert.equal(modelsValue(file, "CODEX_MODEL").stdout, "second");
});

test("models_value ignores unknown keys, commented-out keys and look-alike keys", (t) => {
  const file = tempFile(t, "PATH=/evil\n# CODEX_MODEL=commented\nXCODEX_MODEL=lookalike\nCODEX_MODEL_X=suffix\n");
  assert.equal(modelsValue(file, "PATH").status, 1);
  const r = modelsValue(file, "CODEX_MODEL");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("models_value rejects values outside the safe charset, with a note on stderr", (t) => {
  for (const bad of ['"quoted"', "$(touch pwned)", "a b", "a;b", "`id`", ""]) {
    const file = tempFile(t, `CODEX_MODEL=${bad}\n`);
    const r = modelsValue(file, "CODEX_MODEL");
    assert.equal(r.status, 2, `value ${JSON.stringify(bad)} should be rejected`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /ignored CODEX_MODEL/);
  }
});

test("models_value never runs the file", (t) => {
  const marker = path.join(os.tmpdir(), `models-pwned-${process.pid}`);
  const file = tempFile(t, `touch ${marker}\nCODEX_MODEL=ok\n$(touch ${marker})\n`);
  assert.equal(modelsValue(file, "CODEX_MODEL").stdout, "ok");
  assert.equal(fs.existsSync(marker), false);
});

test("models_value: a missing file is just absent", () => {
  assert.equal(modelsValue("/nonexistent/models.env", "CODEX_MODEL").status, 1);
});

// The fetched layer (dev-system#162): dev-init fetches models.env from main on every
// start (models_url, models_fetch) and resolves each model env > fetched > baked
// (models_resolve). These drive the same functions with file:// URLs, so no network.

// pickModels runs dev-init's step 4 flow through a real sh: the URL, the fetch into a
// temp file, then each model resolved from env, the fetched file (when valid) and
// the baked file. env is the whole environment the flow sees.
function pickModels(t, { baked, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-fetch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bakedFile = path.join(dir, "baked.env");
  fs.writeFileSync(bakedFile, baked);
  const script = `
    . "$MODELS_SH"
    fetched=""
    if url=$(models_url); then
      echo "url=$url"
      if reason=$(models_fetch "$url" "$DIR/fetched.env"); then fetched="$DIR/fetched.env"; else echo "warning=$reason"; fi
    fi
    echo "agents=$(models_resolve DEV_NM_AGENTS AGENTS $fetched "$BAKED")"
    echo "codex=$(models_resolve DEV_CODEX_MODEL CODEX_MODEL $fetched "$BAKED")"
    echo "claude=$(models_resolve DEV_CLAUDE_MODEL CLAUDE_MODEL $fetched "$BAKED")"`;
  const r = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, MODELS_SH, DIR: dir, BAKED: bakedFile, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = {};
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const BAKED = "AGENTS=codex,claude\nCODEX_MODEL=baked-codex\nCLAUDE_MODEL=baked-claude\n";

function servedFile(t, content) {
  return `file://${tempFile(t, content)}`;
}

test("models_url defaults to models.env on main, and an empty DEV_MODELS_URL turns the fetch off", () => {
  const run = (env) =>
    spawnSync("sh", ["-c", '. "$1" && models_url', "sh", MODELS_SH], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  const def = run({});
  assert.equal(def.status, 0);
  assert.equal(def.stdout, "https://raw.githubusercontent.com/cbundy/dev-system/main/images/base/models.env\n");
  assert.equal(run({ DEV_MODELS_URL: "file:///x/models.env" }).stdout, "file:///x/models.env\n");
  const off = run({ DEV_MODELS_URL: "" });
  assert.equal(off.status, 1);
  assert.equal(off.stdout, "");
});

test("the default URL is this repo's models.env, so main's copy is what workspaces fetch", () => {
  const sh = fs.readFileSync(MODELS_SH, "utf8");
  assert.match(sh, /^MODELS_URL_DEFAULT=https:\/\/raw\.githubusercontent\.com\/cbundy\/dev-system\/main\/images\/base\/models\.env$/m);
});

test("a valid fetched file overrides the baked models", (t) => {
  const url = servedFile(t, "# from main\nCODEX_MODEL=main-codex\nCLAUDE_MODEL=main-claude\n");
  assert.deepEqual(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url } }), {
    url,
    agents: "codex,claude",
    codex: "main-codex",
    claude: "main-claude",
  });
});

test("a fetched AGENTS overrides the baked one, and a malformed one falls back to baked per key", (t) => {
  const url = servedFile(t, "AGENTS=claude\n");
  const r = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url } });
  assert.deepEqual(r, { url, agents: "claude", codex: "baked-codex", claude: "baked-claude" });
  for (const bad of ["claude,,codex", "claude, codex", "CLAUDE", "claude;id"]) {
    const partly = servedFile(t, `AGENTS=${bad}\nCODEX_MODEL=main-codex\n`);
    const p = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: partly } });
    assert.equal(p.agents, "codex,claude", `AGENTS=${bad} should fall back to baked`);
    assert.equal(p.codex, "main-codex");
    assert.equal(p.warning, undefined);
  }
  // A fetched file whose only key is a malformed AGENTS is not used at all.
  const only = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: servedFile(t, "AGENTS=a,,b\n") } });
  assert.equal(only.warning, "it sets no valid CODEX_MODEL, CLAUDE_MODEL or AGENTS");
  assert.equal(only.agents, "codex,claude");
});

test("a partly valid fetched file falls back to baked per key, with no warning", (t) => {
  const url = servedFile(t, "CODEX_MODEL=main-codex\nCLAUDE_MODEL=$(bad)\n");
  assert.deepEqual(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url } }), {
    url,
    agents: "codex,claude",
    codex: "main-codex",
    claude: "baked-claude",
  });
  const missing = servedFile(t, "CLAUDE_MODEL=main-claude\n");
  const r = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: missing } });
  assert.equal(r.codex, "baked-codex");
  assert.equal(r.claude, "main-claude");
  assert.equal(r.warning, undefined);
});

test("an invalid or empty fetched file falls back to baked, with the reason", (t) => {
  for (const content of ["", "<html>Not Found</html>\n", "CODEX_MODEL=a b\nCLAUDE_MODEL=\nPATH=/x\n"]) {
    const r = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: servedFile(t, content) } });
    assert.equal(r.warning, "it sets no valid CODEX_MODEL, CLAUDE_MODEL or AGENTS", JSON.stringify(content));
    assert.equal(r.codex, "baked-codex");
    assert.equal(r.claude, "baked-claude");
  }
});

test("a missing file or an unreachable URL falls back to baked, with curl's reason", (t) => {
  const missing = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: "file:///nonexistent/models.env" } });
  assert.match(missing.warning, /Couldn't (open|read) file/);
  assert.equal(missing.codex, "baked-codex");
  // Port 1 on loopback refuses at once, so this needs no network.
  const refused = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: "https://127.0.0.1:1/models.env" } });
  assert.match(refused.warning, /\(7\) Failed to connect/);
  assert.equal(refused.claude, "baked-claude");
});

test("only https (and file, for tests) are fetched: plain http is refused", (t) => {
  const r = pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: "http://127.0.0.1:1/models.env" } });
  assert.match(r.warning, /Protocol "http"/);
  assert.equal(r.codex, "baked-codex");
});

test("an empty DEV_MODELS_URL skips the fetch and uses baked", (t) => {
  assert.deepEqual(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: "" } }), {
    agents: "codex,claude",
    codex: "baked-codex",
    claude: "baked-claude",
  });
});

test("DEV_CODEX_MODEL / DEV_CLAUDE_MODEL beat the fetched file, and empty means no model", (t) => {
  const url = servedFile(t, "CODEX_MODEL=main-codex\nCLAUDE_MODEL=main-claude\n");
  assert.deepEqual(
    pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url, DEV_CODEX_MODEL: "env-codex", DEV_CLAUDE_MODEL: "" } }),
    { url, agents: "codex,claude", codex: "env-codex", claude: "" },
  );
});

test("DEV_NM_AGENTS beats the fetched and baked AGENTS, and empty means no agent order", (t) => {
  const url = servedFile(t, "AGENTS=codex\n");
  assert.equal(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url, DEV_NM_AGENTS: "claude" } }).agents, "claude");
  assert.equal(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url, DEV_NM_AGENTS: "" } }).agents, "");
  assert.equal(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url } }).agents, "codex");
});

test("models_fetch never runs the fetched file", (t) => {
  const marker = path.join(os.tmpdir(), `models-fetch-pwned-${process.pid}`);
  const url = servedFile(t, `$(touch ${marker})\ntouch ${marker}\nCODEX_MODEL=ok\n`);
  assert.equal(pickModels(t, { baked: BAKED, env: { DEV_MODELS_URL: url } }).codex, "ok");
  assert.equal(fs.existsSync(marker), false);
});
