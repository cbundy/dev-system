"use strict";
// The compare reader for heartbeat-state (dev-system#900): the busy answer {state, in_flight} per device
// over the window's events, once from factory.events (old, parsed from raw) and once from
// factory.event_log (new), each through the tool's own deriveOld or deriveNew and normalize, imported,
// not copied. No runs and no chat: the answer then comes from the events alone, which is the part that
// moves stores. Known differences are in docs/factory-events/replay.md.

const path = require("node:path");
const tool = require(path.join(__dirname, "..", "..", "..", "images", "base", "heartbeat-state"));

const lit = (iso) => `'${new Date(iso).toISOString().replace(/'/g, "''")}'`;
const window = (ctx) => `ts >= ${lit(ctx.since)}${ctx.until ? ` AND ts < ${lit(ctx.until)}` : ""}`;
const lines = (out) => out.split("\n").filter((l) => l !== "");

// answers(events, fn): { device: fn(events of that device, device) }
function answers(events, fn) {
  const out = {};
  for (const device of [...new Set(events.map((e) => e.device))].sort()) out[device] = fn(events, device);
  return out;
}

exports.old = (ctx) => {
  // device and raw as one JSON object per row, so the separator never needs splitting
  const rows = lines(ctx.psql(ctx.oldUrl, `SELECT json_build_object('device', device, 'raw', raw) FROM factory.events WHERE ${window(ctx)} ORDER BY ts, device, seq`));
  const events = rows.map((l) => {
    const { device, raw } = JSON.parse(l);
    return { ...raw, device };
  });
  return answers(events, tool.answerOld);
};

exports.new = (ctx) => {
  const events = lines(ctx.psql(ctx.newUrl, `SELECT row_to_json(e) FROM factory.event_log e WHERE ${window(ctx)} ORDER BY ts, device, device_seq`)).map((l) => JSON.parse(l));
  return answers(events, tool.answerNew);
};

exports.normalize = (out) => Object.fromEntries(Object.entries(out).map(([device, a]) => [device, tool.normalize(a)]));
