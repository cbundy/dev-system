"use strict";

// The size guard (scripts/size-guard.sh; docs/factory-loop/v2/SPEC.md 2.5, property 19): no file
// under a directory over its limit but those the allowlist names, each capped at its size when
// listed, and both only shrink: a listed file over its cap, at or under the limit, or gone, fails.
// Run on fixtures, then on the factory loop's hooks with lint.sh's own allowlist, which is empty now:
// no hooks file is over the limit. Were an entry ever listed, it could name only one of the files
// that were over it when the guard was built, at a cap no higher than U1 set.
const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(ROOT, "scripts", "size-guard.sh");
// the six v1 files over the limit when the guard was built, at the caps U1 set: an entry may only
// ever be removed, and a cap only lowered
const ORIGINAL = { "act-agents.ts": 646, "act-merge.ts": 722, "act.ts": 745, "control.ts": 660, "plan.ts": 2541, "register.ts": 1688 };

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

test("a listed file over the limit passes at or under its cap; listed at or under the limit, or gone, it fails: the list only shrinks", () => {
  const dir = fixture({ "big.ts": 20, "fixed.ts": 10, "small.ts": 3 });
  assert.deepEqual(guard(dir, 10, ["big.ts:20"]), { code: 0, out: "", err: "" });
  assert.equal(guard(dir, 10, ["big.ts:25"]).code, 0);
  const shrunk = guard(dir, 10, ["big.ts:20", "fixed.ts:12"]);
  assert.equal(shrunk.code, 1);
  assert.match(shrunk.err, /fixed\.ts is 10 lines, at or under 10: take it off the allowlist/);
  const gone = guard(dir, 10, ["big.ts:20", "deleted.ts:30"]);
  assert.equal(gone.code, 1);
  assert.match(gone.err, /deleted\.ts is on the allowlist and is gone/);
});

test("a listed file over its cap fails: it may only shrink", () => {
  const dir = fixture({ "big.ts": 21 });
  const grown = guard(dir, 10, ["big.ts:20"]);
  assert.equal(grown.code, 1);
  assert.match(grown.err, /big\.ts is 21 lines, over its cap of 20: a listed file may only shrink/);
});

test("bad usage is exit 2: a bad limit, or an entry with no whole-number cap", () => {
  assert.equal(guard("/no/such/dir", 10).code, 2);
  assert.equal(guard(fixture({ "a.ts": 1 }), "ten").code, 2);
  for (const entry of ["big.ts", "big.ts:", "big.ts:many", ":20"]) assert.equal(guard(fixture({ "big.ts": 20 }), 10, [entry]).code, 2, entry);
});

test("the factory loop's hooks pass with lint.sh's allowlist, which is empty and could name only files from the original six", () => {
  const lint = fs.readFileSync(path.join(ROOT, "scripts", "lint.sh"), "utf8");
  const m = /^HOOKS_OVERSIZED="([^"]*)"$/m.exec(lint);
  assert.ok(m, "lint.sh: HOOKS_OVERSIZED");
  const listed = m[1].split(/\s+/).filter((f) => f !== "");
  for (const entry of listed) {
    const [f, cap] = entry.split(":");
    assert.ok(f in ORIGINAL, `the allowlist only shrinks: ${f} was never on it`);
    assert.ok(Number(cap) <= ORIGINAL[f], `${f}: its cap ${cap} is over the ${ORIGINAL[f]} U1 set, and a cap is never raised`);
  }
  assert.match(lint, /^HOOKS_MAX_LINES=600$/m);
  const r = guard(path.join(ROOT, "plugins", "factory-loop", "hooks"), 600, listed);
  assert.deepEqual(r, { code: 0, out: "", err: "" });
});
