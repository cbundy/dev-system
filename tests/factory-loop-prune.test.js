"use strict";

// The factory loop's daily prune of its loop dir (plugins/factory-loop/hooks/exec.ts pruneArgvs,
// docs/factory-loop/SPEC.md 11.6), run for real by find on a scratch loop dir: the files that only
// grow go once older than a week, the act lock, control.json and the event sink never do. Plugin
// tests cannot run a command, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (scripts/factory-loop-replay.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const EXEC = path.join(__dirname, "..", "plugins", "factory-loop", "hooks", "exec.ts");
const DAY = 86_400_000;

let exec;
let dir;

before(async () => {
  exec = await import(EXEC);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-prune-"));
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

test("files older than a week go, the rest stay, and empty state days are removed", () => {
  const loop = path.join(dir, "cbundy__dev-system");
  const old = Date.now() - 8 * DAY;
  const files = {
    "spawns/design_470_1.json": old,
    "answers/design_470_1.txt": old,
    "respond/respond_R_review_h_fix-1.log": old,
    "states/2026-10-01/12.json": old,
    "decisions-2026-10-01.jsonl": old,
    "answers/design_471_1.txt": Date.now() - DAY,
    "decisions-2026-10-12.jsonl": Date.now(),
    "states/2026-10-12/3.json": Date.now(),
    "act.lock": old,
    "control.json": old,
    "sink-events/cbundy__dev-system.jsonl": old,
  };
  for (const [rel, at] of Object.entries(files)) {
    const p = path.join(loop, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
    fs.utimesSync(p, new Date(at), new Date(at));
  }
  for (const [cmd, ...args] of exec.pruneArgvs(loop, exec.LOOP_FILES_KEEP_DAYS)) execFileSync(cmd, args);
  const left = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(loop, path.join(e.parentPath, e.name))).sort();
  assert.deepEqual(left(loop), [
    "act.lock",
    "answers/design_471_1.txt",
    "control.json",
    "decisions-2026-10-12.jsonl",
    "sink-events/cbundy__dev-system.jsonl",
    "states/2026-10-12/3.json",
  ]);
  assert.equal(fs.existsSync(path.join(loop, "states", "2026-10-01")), false);
});
