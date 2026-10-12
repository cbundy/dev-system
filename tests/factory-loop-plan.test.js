"use strict";

// The factory loop's plan must stay pure (docs/factory-loop/SPEC.md 5.9): plan.ts and the
// modules it relies on import types only, and reach for no clock, randomness, timer,
// network, process or engine call. The behaviour itself is tested by
// plugins/factory-loop/tests/plan.test.ts under `claude plugin test`, whose environment
// cannot read source files, so this check lives here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HOOKS = path.join(__dirname, "..", "plugins", "factory-loop", "hooks");
const PURE = ["plan.ts", "config.ts", "types.ts"];

// code: the source without comments and string literals, so prose cannot trip the checks.
function code(file) {
  return fs
    .readFileSync(path.join(HOOKS, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

test("plan.ts, config.ts and types.ts import types only", () => {
  for (const file of PURE) {
    const src = fs.readFileSync(path.join(HOOKS, file), "utf8");
    const imports = src.match(/^import\b[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? [];
    for (const statement of imports) {
      assert.match(statement, /^import type\b/, `${file}: a value import breaks purity: ${statement.split("\n")[0]}`);
    }
    assert.doesNotMatch(src, /\brequire\(|\bimport\(/, `${file}: no dynamic or CommonJS imports`);
  }
});

test("plan.ts reads no clock and calls nothing outside itself", () => {
  const src = code("plan.ts");
  const banned = {
    "a clock (the time is state.now)": /\bDate\b|\bperformance\b/,
    randomness: /Math\.random|crypto\./,
    timers: /\bset(Timeout|Interval|Immediate)\b/,
    network: /\bfetch\(|XMLHttpRequest|WebSocket/,
    "the engine": /\$\.|\bEngineInterface\b/,
    "the process": /\bprocess\.|\bglobalThis\b/,
  };
  for (const [what, pattern] of Object.entries(banned)) {
    assert.doesNotMatch(src, pattern, `plan.ts must not use ${what}`);
  }
});

test("plan.ts imports and runs under Node, for the replay harness", async () => {
  const mod = await import(path.join(HOOKS, "plan.ts"));
  assert.equal(typeof mod.plan, "function");
  assert.equal(typeof mod.tierOf, "function");
});
