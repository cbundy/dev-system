"use strict";
// The harness's self-test reader (dev-system#650): events per type and issue. The old side reads
// factory.events and counts what the translator makes of each line; the new side counts
// factory.event_log. It is not a real reader: it proves the harness and the replay agree.

const { translate } = require("../../images/base/factory-event-translate.js");

const key = (type, issue) => `${type}|${issue === null || issue === "" ? "none" : issue}`;
const when = (ctx) => `ts >= '${new Date(ctx.since).toISOString()}'${ctx.until ? ` AND ts < '${new Date(ctx.until).toISOString()}'` : ""}`;

function count(map, k) {
  map[k] = (map[k] || 0) + 1;
}

exports.old = (ctx) => {
  const out = {};
  const rows = ctx.psql(ctx.oldUrl, `SELECT raw::text FROM factory.events WHERE ${when(ctx)} ORDER BY ts, device, seq`);
  for (const l of rows.split("\n").filter((x) => x !== "")) {
    const t = translate(l);
    if (t.event) count(out, key(t.event.type, t.event.issue));
  }
  return out;
};

exports.new = (ctx) => {
  const out = {};
  const rows = ctx.psql(ctx.newUrl, `SELECT type, coalesce(issue::text, ''), count(*) FROM factory.event_log WHERE ${when(ctx)} GROUP BY 1, 2`);
  for (const l of rows.split("\n").filter((x) => x !== "")) {
    const [type, issue, n] = l.split("|");
    out[key(type, issue)] = Number(n);
  }
  return out;
};

exports.normalize = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
