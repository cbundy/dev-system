"use strict";
// The compare reader for the factory loop's record rebuild (dev-system#976): the IssueRecords the loop
// rebuilds from a device's `transition` events, per repo and device over the window's events, once from
// factory.events (old: recordsFromEvents) and once from factory.event_store (new: recordsFromNewRows),
// each through the plugin's own record.ts, imported, not copied. The loop's `eventsSource` switch
// (plugins/factory-loop/hooks/v2/sources-records.ts) reads the same two functions. A new row the
// loop's reader refuses throws, so the compare fails on it, as the loop's `new` read does.

const { register } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts", so relative imports that fail are retried with it.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const HOOKS = path.join(__dirname, "..", "..", "..", "plugins", "factory-loop", "hooks");
const lit = (iso) => `'${new Date(iso).toISOString().replace(/'/g, "''")}'`;
const window = (ctx) => `ts >= ${lit(ctx.since)}${ctx.until ? ` AND ts < ${lit(ctx.until)}` : ""}`;
const lines = (out) => out.split("\n").filter((l) => l !== "");
const record = () => import(pathToFileURL(path.join(HOOKS, "v2", "record.ts")).href);
const derive = () => import(pathToFileURL(path.join(HOOKS, "derive.ts")).href);

// the row as dev-query --csv gives it: every value a string, null as empty, an object as its JSON
const strings = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)]));

// byPair: { "repo device": rows }
function byPair(rows) {
  const out = {};
  for (const r of rows) (out[`${r.repo} ${r.device}`] ??= []).push(r);
  return out;
}

exports.old = async (ctx) => {
  const { recordsFromEvents } = await record();
  const { eventsFromRows } = await derive();
  const rows = lines(
    ctx.psql(
      ctx.oldUrl,
      `SELECT json_build_object('repo', repo, 'ts', to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'state', state, 'issue', issue, 'run_id', run_id, 'branch', branch, 'pr', pr, 'head', head, 'note', note, 'actor', actor, 'device', device)
       FROM factory.events WHERE state = 'transition' AND ${window(ctx)} ORDER BY ts, seq`,
    ),
  ).map((l) => JSON.parse(l));
  const out = {};
  for (const [pair, list] of Object.entries(byPair(rows))) out[pair] = recordsFromEvents(eventsFromRows(list.map(strings)), list[0].device);
  return out;
};

exports.new = async (ctx) => {
  const { recordsFromNewRows } = await record();
  const rows = lines(
    ctx.psql(
      ctx.newUrl,
      `SELECT json_build_object('envelope', envelope, 'event_id', event_id, 'ts', to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'type', type, 'type_version', type_version, 'repo', repo, 'device', device, 'issue', issue, 'device_seq', device_seq, 'data', data)
       FROM factory.event_store WHERE type = 'transition' AND ${window(ctx)} ORDER BY ts, device, device_seq`,
    ),
  ).map((l) => JSON.parse(l));
  const out = {};
  for (const [pair, list] of Object.entries(byPair(rows))) out[pair] = recordsFromNewRows(list.map(strings));
  return out;
};
