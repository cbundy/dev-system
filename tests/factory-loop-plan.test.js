"use strict";

// The factory loop's plan must stay pure (docs/factory-loop/v2/SPEC.md 2.2): foundation.ts, which
// holds the helpers the rule layers share, and the modules it relies on import types only, and
// reach for no clock, randomness, timer, network, process or engine call. The behaviour itself is
// tested by plugins/factory-loop/tests/foundation.test.ts under `claude plugin test`, whose
// environment cannot read source files, so this check lives here.
//
// The v2 planner is held to the same: v2/plan.ts's imports, followed to the end, reach hooks/v2/
// and hooks/foundation.ts alone, every module they reach reads no clock and calls nothing outside
// itself, and no v2 module at all holds the engine (register.ts alone does).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { register } = require("node:module");
const path = require("node:path");

const HOOKS = path.join(__dirname, "..", "plugins", "factory-loop", "hooks");
const PURE = ["foundation.ts", "config.ts", "types.ts"];

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts", so relative imports that fail are retried with it (as
// scripts/factory-loop-replay.js does).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

// valueImports: the modules a source imports for values (an `import type` brings none): paths
// relative to the hooks directory, and a package's name as `package:<name>`.
function valueImports(file) {
  const src = fs.readFileSync(path.join(HOOKS, file), "utf8");
  const out = [];
  for (const m of src.matchAll(/^(import|export)\b([\s\S]*?)\bfrom\s+['"]([^'"]+)['"]/gm)) {
    if (/^\s*type\b/.test(m[2])) continue;
    const spec = m[3];
    if (!spec.startsWith(".")) {
      out.push(`package:${spec}`);
      continue;
    }
    const resolved = path.relative(HOOKS, path.join(HOOKS, path.dirname(file), spec));
    out.push(/\.[cm]?[jt]s$/.test(resolved) ? resolved : `${resolved}.ts`);
  }
  return out;
}

// closure: every module the file's value imports reach, itself included.
function closure(file) {
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const g of valueImports(f)) if (!g.startsWith("package:")) visit(g);
  };
  visit(file);
  return [...seen].sort();
}

const BANNED_PLAN = {
  "a clock (the time is state.now)": /\bDate\b|\bperformance\b/,
  randomness: /Math\.random|crypto\./,
  timers: /\bset(Timeout|Interval|Immediate)\b/,
  network: /\bfetch\(|XMLHttpRequest|WebSocket/,
  "the engine": /\$\.|\bEngineInterface\b/,
  "the process": /\bprocess\.|\bglobalThis\b/,
};

// code: the source without comments and string literals, so prose cannot trip the checks.
function code(file) {
  return fs
    .readFileSync(path.join(HOOKS, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

test("foundation.ts, config.ts and types.ts import types only, and v2's vocabulary, which is constants alone", () => {
  for (const file of [...PURE, "v2/types.ts"]) {
    const src = fs.readFileSync(path.join(HOOKS, file), "utf8");
    const imports = src.match(/^import\b[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? [];
    for (const statement of imports) {
      // the closed lists of v2/types.ts are the one value config.ts and foundation.ts take (kinds,
      // settings, the agent steps)
      if ((file === "config.ts" || file === "foundation.ts") && /from\s+'\.\/v2\/types'$/.test(statement)) continue;
      assert.match(statement, /^import type\b/, `${file}: a value import breaks purity: ${statement.split("\n")[0]}`);
    }
    assert.doesNotMatch(src, /\brequire\(|\bimport\(/, `${file}: no dynamic or CommonJS imports`);
  }
  const vocabulary = code("v2/types.ts");
  for (const [what, pattern] of Object.entries(BANNED_PLAN)) assert.doesNotMatch(vocabulary, pattern, `v2/types.ts must not use ${what}`);
});

test("foundation.ts reads no clock and calls nothing outside itself", () => {
  const src = code("foundation.ts");
  const banned = {
    "a clock (the time is state.now)": /\bDate\b|\bperformance\b/,
    randomness: /Math\.random|crypto\./,
    timers: /\bset(Timeout|Interval|Immediate)\b/,
    network: /\bfetch\(|XMLHttpRequest|WebSocket/,
    "the engine": /\$\.|\bEngineInterface\b/,
    "the process": /\bprocess\.|\bglobalThis\b/,
  };
  for (const [what, pattern] of Object.entries(banned)) {
    assert.doesNotMatch(src, pattern, `foundation.ts must not use ${what}`);
  }
});

test("the observe half's pure modules and the config loader read no clock and call nothing outside themselves", () => {
  for (const file of ["parse.ts", "derive.ts", "state.ts", "config.ts"]) {
    const src = code(file);
    for (const [what, pattern] of Object.entries({
      "the clock (dates are parsed, never read)": /Date\.now|new Date\(|\bperformance\b/,
      "the engine": /\$\.|\bEngineInterface\b/,
      "the process or the network": /\bprocess\.|\bfetch\(|\brequire\(|\bimport\(/,
    })) {
      assert.doesNotMatch(src, pattern, `${file} must not use ${what}`);
    }
  }
});

test("foundation.ts imports and runs under Node, for the replay harness", async () => {
  const mod = await import(path.join(HOOKS, "foundation.ts"));
  for (const name of ["tierOf", "listedLive", "releaseDue", "turnEnded", "issueFromBranch"]) assert.equal(typeof mod[name], "function", name);
  assert.ok(Array.isArray(mod.LIVE));
});

test("the v2 planner imports hooks/v2/ and foundation.ts alone, and every module it reaches reads no clock and calls nothing outside itself", () => {
  const reached = closure("v2/plan.ts");
  assert.ok(reached.includes("foundation.ts") && reached.includes("v2/rules-state.ts") && reached.includes("v2/reconcile.ts"), reached.join(", "));
  for (const f of reached) {
    const allowed = f.startsWith("v2/") || f === "foundation.ts";
    assert.ok(allowed, `v2/plan.ts reaches ${f}`);
    assert.ok(!f.endsWith(".mjs"), `v2/plan.ts reaches ${f}, an answer contract`);
    const src = code(f);
    for (const [what, pattern] of Object.entries(BANNED_PLAN)) assert.doesNotMatch(src, pattern, `${f} (reached from v2/plan.ts) must not use ${what}`);
    assert.doesNotMatch(src, /\brequire\(|\bimport\(/, `${f}: no dynamic or CommonJS imports`);
  }
  // the purity walk does see a value import
  assert.deepEqual(valueImports("v2/plan.ts").filter((f) => f === "foundation.ts"), ["foundation.ts"]);
});

test("no v2 module holds the engine or the process: register.ts alone does", () => {
  const v2 = fs.readdirSync(path.join(HOOKS, "v2")).filter((f) => /\.(ts|mjs)$/.test(f));
  assert.ok(v2.length >= 30, v2.join(", "));
  for (const f of v2) {
    const src = code(`v2/${f}`);
    assert.doesNotMatch(src, /\$\.|\bEngineInterface\b/, `v2/${f} must not use the engine`);
    assert.doesNotMatch(src, /\bprocess\.|\bglobalThis\b|\brequire\(|\bimport\(/, `v2/${f} must not use the process or dynamic imports`);
    for (const g of valueImports(`v2/${f}`)) assert.ok(!g.startsWith("package:"), `v2/${f} imports ${g}`);
  }
});

test("the v2 planner imports and runs under Node, for the replay harness: a quiet pass plans its title", async () => {
  const { planV2 } = await import(path.join(HOOKS, "v2", "plan.ts"));
  const { DEFAULT_CONFIG, EMPTY_CONTROL } = await import(path.join(HOOKS, "config.ts"));
  const { emptyV2State } = await import(path.join(HOOKS, "v2", "observe.ts"));
  const NOW = Date.UTC(2026, 9, 15, 12, 0);
  const ok = { ok: true, at: NOW };
  const sources = Object.fromEntries(["factory", "facts", "runs", "queue", "github", "usage", "pool", "milestone"].map((n) => [n, ok]));
  const sweep = { key: "sweep:1", kind: "sweep", class: "free", rule: "H2", issue: null, run: null, pr: null, head: null, status: "done", attempts: 1, startedAt: NOW - 60_000, endedAt: NOW - 60_000 };
  const state = {
    now: NOW,
    repo: "cbundy/dev-system",
    device: "d",
    loadedAt: NOW - 3_600_000,
    sources,
    usage: { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true },
    issues: [],
    queue: [],
    runs: [],
    pool: null,
    agents: [],
    milestone: null,
    ledger: [sweep],
    control: EMPTY_CONTROL,
    lastTitle: null,
    lastTitleAt: null,
    githubBackoffUntil: null,
    checkout: null,
    v2: emptyV2State(NOW),
  };
  const result = planV2(state, { ...DEFAULT_CONFIG, planner: "v2" });
  assert.deepEqual(result.actions.map((a) => a.kind), ["title"]);
  assert.equal(result.title, "🔄 dev-system (Q:0 - D:0 - M:0) · observe");
});
