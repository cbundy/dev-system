"use strict";

// The size guard (scripts/size-guard.sh; docs/factory-loop/v2/SPEC.md 2.5, property 19): no file
// under a directory over its limit but those the allowlist names, and the allowlist only shrinks:
// a listed file at or under the limit, or gone, fails too. Run on fixtures, then on the factory
// loop's hooks with lint.sh's own allowlist, which names only today's oversized v1 files.
const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(ROOT, "scripts", "size-guard.sh");
// the six v1 files over the limit when the guard was built; an entry may only ever be removed
const ORIGINAL = ["act-agents.ts", "act-merge.ts", "act.ts", "control.ts", "plan.ts", "register.ts"];

function guard(dir, max, listed = []) {
  const r = spawnSync("sh", [GUARD, dir, String(max), ...listed], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// fixture: a directory with these files, each of n lines.
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "size-guard-"));
  made.push(dir);
  for (const [name, n] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), "x\n".repeat(n));
  }
  return dir;
}

test("files at or under the limit pass, quietly", () => {
  const dir = fixture({ "a.ts": 10, "v2/b.ts": 10, "c.mjs": 3 });
  assert.deepEqual(guard(dir, 10), { code: 0, out: "", err: "" });
});

test("a file over the limit fails, nested ones too, each named with its size", () => {
  const dir = fixture({ "a.ts": 11, "v2/b.ts": 12, "c.ts": 10 });
  const r = guard(dir, 10);
  assert.equal(r.code, 1);
  assert.match(r.err, /a\.ts is 11 lines, over 10/);
  assert.match(r.err, /v2\/b\.ts is 12 lines, over 10/);
  assert.doesNotMatch(r.err, /c\.ts/);
});

test("a listed file over the limit passes; listed at or under it, or gone, it fails: the list only shrinks", () => {
  const dir = fixture({ "big.ts": 20, "fixed.ts": 10, "small.ts": 3 });
  assert.equal(guard(dir, 10, ["big.ts"]).code, 0);
  const shrunk = guard(dir, 10, ["big.ts", "fixed.ts"]);
  assert.equal(shrunk.code, 1);
  assert.match(shrunk.err, /fixed\.ts is 10 lines, at or under 10: take it off the allowlist/);
  const gone = guard(dir, 10, ["big.ts", "deleted.ts"]);
  assert.equal(gone.code, 1);
  assert.match(gone.err, /deleted\.ts is on the allowlist and is gone/);
});

test("bad usage is exit 2", () => {
  assert.equal(guard("/no/such/dir", 10).code, 2);
  assert.equal(guard(fixture({ "a.ts": 1 }), "ten").code, 2);
});

test("the factory loop's hooks pass with lint.sh's allowlist, which names only files from the original six", () => {
  const lint = fs.readFileSync(path.join(ROOT, "scripts", "lint.sh"), "utf8");
  const m = /^HOOKS_OVERSIZED="([^"]*)"$/m.exec(lint);
  assert.ok(m, "lint.sh: HOOKS_OVERSIZED");
  const listed = m[1].split(/\s+/).filter((f) => f !== "");
  for (const f of listed) assert.ok(ORIGINAL.includes(f), `the allowlist only shrinks: ${f} was never on it`);
  assert.match(lint, /^HOOKS_MAX_LINES=600$/m);
  const r = guard(path.join(ROOT, "plugins", "factory-loop", "hooks"), 600, listed);
  assert.deepEqual(r, { code: 0, out: "", err: "" });
});
