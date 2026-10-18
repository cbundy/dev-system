"use strict";
// The compare harness (dev-system#650): runs a reader's old and new functions over the same window
// and reports each difference between their normalised outputs by path.
//
// A reader module exports
//   old(ctx)        the reader as it is today, over the old store (factory.events)
//   new(ctx)        the reader over the new store (factory.event_store / factory.event_log)
//   normalize(out)  optional; applied to both outputs before comparing (sort, drop volatile fields)
// ctx is { oldUrl, newUrl, since, until, psql } where since/until are ISO times (until may be null)
// and psql(url, sql) is a read-only psql returning the rows unaligned. Both functions may be async.

const { psql } = require("./pg.js");
const { diff } = require("../../images/base/factory-source.js");

const show = (v) => (v === undefined ? "<missing>" : JSON.stringify(v));

// runCompare({ reader, oldUrl, newUrl, since, until }): { differences, old, new } and never throws
// for a difference. The reader is a module path or the module object.
async function runCompare({ reader, oldUrl, newUrl, since, until = null }) {
  const mod = typeof reader === "string" ? require(require("node:path").resolve(reader)) : reader;
  if (typeof mod.old !== "function" || typeof mod.new !== "function") throw new Error("a reader module exports old(ctx) and new(ctx)");
  const normalize = typeof mod.normalize === "function" ? mod.normalize : (x) => x;
  const ctx = { oldUrl, newUrl, since, until, psql: (url, sql) => psql(url, sql, { readOnly: true }) };
  const o = normalize(await mod.old(ctx));
  const n = normalize(await mod.new(ctx));
  return { differences: diff(o, n), old: o, new: n };
}

function report(result) {
  if (result.differences.length === 0) return "compare: old and new match\n";
  const lines = result.differences.map((d) => `  ${d.path}: old ${show(d.old)} new ${show(d.new)}`);
  return `compare: ${result.differences.length} difference(s)\n${lines.join("\n")}\n`;
}

module.exports = { diff, runCompare, report };
