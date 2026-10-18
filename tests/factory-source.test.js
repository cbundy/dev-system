"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveSource, runShadow, diff } = require("../images/base/factory-source.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "factory-source-"));
}

// capture(fn): runs fn with process.stderr.write captured; returns { result, err }
async function capture(fn) {
  const orig = process.stderr.write;
  let err = "";
  process.stderr.write = (s) => ((err += s), true);
  try {
    return { result: await fn(), err };
  } finally {
    process.stderr.write = orig;
  }
}
const records = (dir, tool) => {
  const f = path.join(dir, "factory", ".shadow", `${tool}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const usage = (re) => (e) => e.code === "USAGE" && re.test(e.message);

test("resolveSource: flag beats env, env beats fallback", () => {
  const env = { CALLUM_FLOW_FACTORY_STATE_SOURCE: "new" };
  assert.deepEqual(resolveSource("factory-state", ["--source", "shadow", "x"], env, "old"), { source: "shadow", argv: ["x"] });
  assert.deepEqual(resolveSource("factory-state", ["a"], env, "old"), { source: "new", argv: ["a"] });
  assert.deepEqual(resolveSource("factory-state", ["a"], {}, "old"), { source: "old", argv: ["a"] });
});

test("resolveSource: --source=x and --source x are stripped", () => {
  assert.deepEqual(resolveSource("t", ["a", "--source=new", "b"], {}, "old"), { source: "new", argv: ["a", "b"] });
  assert.deepEqual(resolveSource("t", ["a", "--source", "new", "b"], {}, "old"), { source: "new", argv: ["a", "b"] });
});

test("resolveSource: bad flag, bad env and missing value throw USAGE with the allowed values", () => {
  assert.throws(() => resolveSource("t", ["--source", "x"], {}, "old"), usage(/--source flag.*old, new, shadow/));
  assert.throws(() => resolveSource("t", ["--source=x"], {}, "old"), usage(/old, new, shadow/));
  assert.throws(() => resolveSource("t", [], { CALLUM_FLOW_T_SOURCE: "bogus" }, "old"), usage(/CALLUM_FLOW_T_SOURCE.*old, new, shadow/));
  assert.throws(() => resolveSource("t", ["--source"], {}, "old"), usage(/needs a value.*old, new, shadow/));
});

test("runShadow: matching answers write one clean record, return old, stay quiet", async () => {
  const dir = tmp();
  const { result, err } = await capture(() =>
    runShadow({ tool: "t", old: () => ({ a: 1 }), new: async () => ({ a: 1 }), repo: "o/r", args: ["--x"], eventsDir: dir }),
  );
  assert.deepEqual(result, { a: 1 });
  assert.equal(err, "");
  const r = records(dir, "t");
  assert.equal(r.length, 1);
  assert.equal(r[0].differences, 0);
  assert.equal(r[0].new_error, null);
  assert.equal(r[0].tool, "t");
  assert.equal(r[0].repo, "o/r");
  assert.deepEqual(r[0].args, ["--x"]);
  assert.deepEqual(r[0].paths, []);
  assert.equal(typeof r[0].device, "string");
  assert.equal(typeof r[0].old_ms, "number");
  assert.equal(typeof r[0].new_ms, "number");
  assert.ok(!Number.isNaN(Date.parse(r[0].ts)));
  assert.equal(fs.statSync(path.join(dir, "factory", ".shadow")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "factory", ".shadow", "t.jsonl")).mode & 0o777, 0o600);
});

test("runShadow: differing answers record count, first 5 paths, clipped values, one stderr line", async () => {
  const dir = tmp();
  const o = { k: "x".repeat(500), a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 };
  const n = { k: "y", a: 2, b: 2, c: 2, d: 2, e: 2, f: 2 };
  const { result, err } = await capture(() => runShadow({ tool: "t", old: () => o, new: () => n, eventsDir: dir }));
  assert.equal(result, o);
  const [r] = records(dir, "t");
  assert.equal(r.differences, 7);
  assert.equal(r.paths.length, 5);
  assert.equal(r.paths[0].path, "$.a");
  assert.equal(err.trim().split("\n").length, 1);
  assert.match(err, /^t: shadow: 7 difference\(s\), first at \$\.a \(see .*t\.jsonl\)\n$/);
  const dir2 = tmp();
  await capture(() => runShadow({ tool: "t", old: () => ({ k: "x".repeat(500) }), new: () => ({ k: "y" }), eventsDir: dir2 }));
  const [r2] = records(dir2, "t");
  assert.equal(r2.paths[0].old.length, 200);
  assert.equal(r2.paths[0].new, '"y"');
});

test("runShadow: new throwing or rejecting records new_error and differences null", async () => {
  for (const nu of [
    () => {
      throw new Error("boom " + "z".repeat(300));
    },
    () => Promise.reject(new Error("nope")),
  ]) {
    const dir = tmp();
    const { result } = await capture(() => runShadow({ tool: "t", old: () => 5, new: nu, eventsDir: dir }));
    assert.equal(result, 5);
    const [r] = records(dir, "t");
    assert.equal(r.differences, null);
    assert.ok(r.new_error.length > 0 && r.new_error.length <= 200);
  }
});

test("runShadow: old throwing propagates and writes nothing", async () => {
  const dir = tmp();
  await assert.rejects(() => runShadow({ tool: "t", old: () => { throw new Error("old broke"); }, new: () => 1, eventsDir: dir }), /old broke/);
  assert.deepEqual(records(dir, "t"), []);
});

test("runShadow: an unwritable record warns and the tool still answers", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "factory"));
  fs.writeFileSync(path.join(dir, "factory", ".shadow"), "a file, not a directory");
  const { result, err } = await capture(() => runShadow({ tool: "t", old: () => 1, new: () => 1, eventsDir: dir }));
  assert.equal(result, 1);
  assert.match(err, /t: shadow: cannot write/);
});

test("runShadow: normalize applies before the diff, the raw old answer is returned", async () => {
  const dir = tmp();
  const { result } = await capture(() =>
    runShadow({ tool: "t", old: () => [3, 1, 2], new: () => [1, 2, 3], normalize: (x) => [...x].sort(), eventsDir: dir }),
  );
  assert.deepEqual(result, [3, 1, 2]);
  assert.equal(records(dir, "t")[0].differences, 0);
});

test("diff: equal, scalar change, one-sided key, array length, quoted key path", () => {
  assert.deepEqual(diff({ a: [1] }, { a: [1] }), []);
  assert.deepEqual(diff({ a: 1 }, { a: 2 }), [{ path: "$.a", old: 1, new: 2 }]);
  assert.deepEqual(diff({ a: 1 }, {}), [{ path: "$.a", old: 1, new: undefined }]);
  assert.deepEqual(diff([1], [1, 2]), [{ path: "$[1]", old: undefined, new: 2 }]);
  assert.deepEqual(diff({ "a b": 1 }, { "a b": 2 }), [{ path: '$["a b"]', old: 1, new: 2 }]);
});
