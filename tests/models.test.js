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
    assert.match(line, /^(#.*|[A-Z_]+=[A-Za-z0-9._:/-]+|)$/, `unexpected line: ${line}`);
  }
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
