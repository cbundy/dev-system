"use strict";

// The settings tables stay true to the loader (docs/factory-loop/v2/SPEC.md appendix A and 13.4.2,
// docs/onboarding.md "Settings"). Appendix A holds one row per key the loader accepts, each with the
// default `/factory help config` prints (hooks/config-help.ts defaultText); the onboarding table is
// curated, but every row names a key the loader resolves and states its default the same way. The
// plugin tests hold the help to the loader (plugins/factory-loop/tests/config-help.test.ts).
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (tests/factory-loop-prune.test.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const ROOT = path.join(__dirname, "..");
const HOOKS = path.join(ROOT, "plugins", "factory-loop", "hooks");
const SPEC = "docs/factory-loop/v2/SPEC.md";
const ONBOARDING = "docs/onboarding.md";

let help;
let keys;
let config;

before(async () => {
  help = await import(path.join(HOOKS, "config-help.ts"));
  keys = await import(path.join(HOOKS, "config-keys.ts"));
  config = await import(path.join(HOOKS, "config.ts"));
});

// the lines of a section: from its heading to the next heading of the same or a higher level
function section(text, heading) {
  const lines = text.split("\n");
  const level = /^#+/.exec(heading)[0].length;
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading} `) || l.startsWith(`${heading}.`));
  assert.notEqual(start, -1, `heading "${heading}" not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]);
    if (m !== null && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

// the rows of the markdown tables in some lines: [key, default cell], the key being the first
// backticked word of the first cell. A pipe inside a cell is written \|.
function rows(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.startsWith("| `")) continue;
    const cells = line.slice(1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    out.push({ key: /`([^`]+)`/.exec(cells[0])[1], defaults: cells[1] });
  }
  return out;
}

const plain = (text) => text.replace(/[`"\s]/g, "");

test("SPEC appendix A has exactly one row per key the loader accepts, with the default the help prints", () => {
  const found = rows(section(fs.readFileSync(path.join(ROOT, SPEC), "utf8"), "## Appendix A. Settings"));
  const expected = [...Object.keys(config.DEFAULT_CONFIG), "poolSize"];
  const seen = new Set();
  for (const { key, defaults } of found) {
    assert.ok(expected.includes(key), `${SPEC} appendix A has a row for "${key}", which the loader does not accept`);
    assert.ok(!seen.has(key), `${SPEC} appendix A has two rows for "${key}"`);
    seen.add(key);
    assert.equal(plain(defaults), plain(help.defaultText(key)), `${SPEC} appendix A: the Default of "${key}" is not "${help.defaultText(key)}"`);
  }
  for (const key of expected) assert.ok(seen.has(key), `${SPEC} appendix A has no row for "${key}", which the loader accepts`);
});

test("every onboarding Settings row names a key the loader resolves, with the default the help prints", () => {
  const found = rows(section(fs.readFileSync(path.join(ROOT, ONBOARDING), "utf8"), "### Settings"));
  assert.ok(found.length > 0, `${ONBOARDING} Settings table has no rows`);
  for (const { key, defaults } of found) {
    const k = keys.keyOf(key);
    assert.ok(k !== null, `${ONBOARDING} Settings has a row for "${key}", which the loader does not resolve`);
    assert.equal(plain(defaults), plain(help.defaultText(k.key)), `${ONBOARDING} Settings: the Default of "${key}" is not "${help.defaultText(k.key)}"`);
  }
});
