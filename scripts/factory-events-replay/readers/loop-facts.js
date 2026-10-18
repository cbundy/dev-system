"use strict";
// The compare reader for the factory loop's facts and ledger rebuild (dev-system#977): what the loop
// reads of the event log every pass, per repo over the window's events, once from factory.events (old:
// the rows of EVENTS_SQL through eventsFromRows) and once from factory.event_store (new: the rows of
// NEW_EVENTS_SQL through eventsFromNewRows), each through the plugin's own derive.ts and
// v2/sources-facts.ts, imported, not copied. The compared things are the loop's: the newest `reclaimed`
// per issue (facts.reclaimed), the ledger deriveLedger rebuilds and the once keys v2's `logged` reads,
// per device (v2/sources-facts.ts viewOf). The loop's `eventsSource` switch reads the same functions. A
// new row the loop's reader refuses throws, so the compare fails on it, as the loop's `new` read does.

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
const derive = () => import(pathToFileURL(path.join(HOOKS, "derive.ts")).href);
const facts = () => import(pathToFileURL(path.join(HOOKS, "v2", "sources-facts.ts")).href);

// the row as dev-query --csv gives it: every value a string, null as empty, an object as its JSON
const strings = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)]));

const byRepo = (rows) => {
  const out = {};
  for (const r of rows) (out[r.repo] ??= []).push(r);
  return out;
};

// per repo: { reclaimed: { issue: ts }, devices: { device: { ledger, once } } }
function viewsOf(events, viewOf) {
  const devices = [...new Set(events.map((e) => e.device).filter((d) => d !== null))].sort();
  return {
    reclaimed: Object.fromEntries(viewOf(events, "").reclaimed),
    devices: Object.fromEntries(
      devices.map((d) => {
        const v = viewOf(events, d);
        return [d, { ledger: [...v.ledger.values()], once: [...v.once].sort() }];
      }),
    ),
  };
}

exports.old = async (ctx) => {
  const { EVENTS_SQL, eventsFromRows } = await derive();
  const { viewOf } = await facts();
  // the states the loop's own query reads, taken from it
  const states = EVENTS_SQL.match(/state in \(([^)]*)\)/s)[1];
  const rows = lines(
    ctx.psql(
      ctx.oldUrl,
      `SELECT json_build_object('repo', repo, 'ts', to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'state', state, 'issue', issue, 'run_id', run_id, 'branch', branch, 'pr', pr, 'head', head, 'note', note, 'actor', actor, 'device', device)
       FROM factory.events WHERE state IN (${states}) AND ${window(ctx)} ORDER BY ts, seq`,
    ),
  ).map((l) => JSON.parse(l));
  const out = {};
  for (const [repo, list] of Object.entries(byRepo(rows))) out[repo] = viewsOf(eventsFromRows(list.map(strings)), viewOf);
  return out;
};

exports.new = async (ctx) => {
  const { FACTS_TYPES, eventsFromNewRows, viewOf } = await facts();
  const types = FACTS_TYPES.map((t) => `'${t}'`).join(", ");
  const rows = lines(
    ctx.psql(
      ctx.newUrl,
      `SELECT json_build_object('envelope', envelope, 'event_id', event_id, 'ts', to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'type', type, 'type_version', type_version, 'repo', repo, 'device', device, 'actor', actor, 'issue', issue, 'device_seq', device_seq, 'data', data)
       FROM factory.event_store WHERE (type IN (${types}) OR (type = 'closed' AND actor = 'sweep')) AND ${window(ctx)} ORDER BY ts, device, device_seq`,
    ),
  ).map((l) => JSON.parse(l));
  const out = {};
  for (const [repo, list] of Object.entries(byRepo(rows))) out[repo] = viewsOf(eventsFromNewRows(list.map(strings)), viewOf);
  return out;
};
