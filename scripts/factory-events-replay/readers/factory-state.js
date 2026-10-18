"use strict";
// The compare reader for callum-flow-factory-state (dev-system#898): the tool's report over the
// window's events, once from factory.events (old) and once from factory.event_log (new), with the
// tool's own normalize (what differs by construction, docs/factory-state.md "Sources"). It uses the
// tool's SQL, mappers and derivation, imported, not copied. No runs and no GitHub: the report then
// answers from the events alone, which is the part that moves stores.

const path = require("node:path");
const tool = require(path.join(__dirname, "..", "..", "..", "images", "base", "callum-flow-factory-state"));

// One clock for both sides, so a minute boundary cannot fall between them.
const NOW = Date.now();

// The tool's queries take psql variables; compare's psql takes none, so they are put in the text.
// Both values are made here (an ISO time, no repo filter), never taken from outside.
const inline = (sql, at) => sql.replace(/:'at'/g, `'${new Date(at).toISOString()}'`).replace(/:'repos'/g, "''");

const when = (ctx) => (ctx.until ? Date.parse(ctx.until) : NOW);
const rows = (out) => (out.trim() === "" ? [] : JSON.parse(out));

// The report over the events that fall in the window [since, at].
function derive(ctx, events) {
  const since = Date.parse(ctx.since);
  return tool.deriveState({
    at: when(ctx), atSource: "--at", events: events.filter((e) => e.t >= since), eventShape: "common", runs: [], repos: [],
    rules: { ...tool.DEFAULT_RULES }, github: null, workers: { available: false, reason: "not read" },
    pipeline: { available: false, reason: "not read" },
  });
}

exports.old = (ctx) => {
  const events = rows(ctx.psql(ctx.oldUrl, inline(tool.SQL_EVENTS, when(ctx)))).map(tool.mapOldRow);
  return derive(ctx, events);
};

exports.new = (ctx) => {
  const events = rows(ctx.psql(ctx.newUrl, inline(tool.SQL_EVENT_LOG, when(ctx)))).map(tool.mapEventLogRow);
  return derive(ctx, events);
};

exports.normalize = tool.normalizeForCompare;
