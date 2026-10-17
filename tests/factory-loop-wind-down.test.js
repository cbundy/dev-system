"use strict";

// The factory loop's wind-down status write (plugins/factory-loop/hooks/v2/wind-down.ts
// WIND_DOWN_WRITE_SCRIPT, docs/factory-loop/v2/SPEC.md 10.10), run for real by sh: the status file
// lands whole by a rename of a temp file beside it, and a write that fails leaves the old file and
// no temp file. Plugin tests cannot run a shell, so this lives here.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension; plain Node needs the ".ts"
// (tests/factory-loop-fast-forward.test.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

let script;
before(async () => {
  const m = await import(path.join(__dirname, "..", "plugins", "factory-loop", "hooks", "v2", "wind-down-files.ts"));
  script = m.WIND_DOWN_WRITE_SCRIPT;
});

const scratch = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "wind-down-"));

test("the status lands whole over the old file, by rename, with no temp file left", () => {
  const dir = scratch();
  try {
    const target = path.join(dir, "wind-down.status.json");
    fs.writeFileSync(target, "old");
    execFileSync("sh", ["-c", script, "wind-down-status", target], { input: '{"idle":true}\n' });
    assert.equal(fs.readFileSync(target, "utf8"), '{"idle":true}\n');
    assert.deepEqual(fs.readdirSync(dir), ["wind-down.status.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a write that fails keeps the old file and leaves no temp file", () => {
  const dir = scratch();
  try {
    const target = path.join(dir, "wind-down.status.json");
    fs.writeFileSync(target, "old");
    // the content write fails (cat replaced by false) after the temp name was made
    const broken = script.replace('cat > "$tmp"', 'false');
    assert.throws(() => execFileSync("sh", ["-c", broken, "wind-down-status", target], { input: "x", stdio: "pipe" }));
    assert.equal(fs.readFileSync(target, "utf8"), "old");
    assert.deepEqual(fs.readdirSync(dir), ["wind-down.status.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
