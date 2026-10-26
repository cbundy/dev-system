"use strict";
// The replay reader for fabriek-evaluate (dev-system#899, part of #534; docs/factory-events/replay.md,
// "What a reader issue passes"). Per repo in the window, old runs the tool's old source over the old
// rows of factory.events (the JSON-lines export the evaluate-sessions skill takes) and new runs its new
// source over the factory.event_log rows, so both go through the tool's own `evaluate()`. Only the
// event-derived sections can differ: no transcripts are read.
// normalize drops the differences that are known and documented (the sources block, and the metrics
// that read n/a under the new source); everything else must match.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalize: normalizeReport } = require("../../../images/base/evaluate-new-events.js");
const tool = require("../../../images/base/fabriek-evaluate");

const when = (ctx) => `ts >= '${new Date(ctx.since).toISOString()}'${ctx.until ? ` AND ts < '${new Date(ctx.until).toISOString()}'` : ""}`;
const lines = (s) => s.split("\n").filter((l) => l !== "");

// The window ends at the old store's newest row (one second later), or at ctx.until: the same for both sides.
function window(ctx) {
  const until = ctx.until ? Date.parse(ctx.until) : Date.parse(ctx.psql(ctx.oldUrl, `SELECT to_char(max(ts) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM factory.events WHERE ${when(ctx)}`).trim()) + 1000;
  return { since: Date.parse(ctx.since), until };
}

function reports(ctx, source, rowsSql, url) {
  const win = window(ctx);
  const repos = lines(ctx.psql(ctx.oldUrl, `SELECT DISTINCT repo FROM factory.events WHERE ${when(ctx)} ORDER BY 1`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-reader-"));
  // fixed names, so a "file not found" reason reads the same on both sides
  const env = { HOME: "/nonexistent/evaluate-reader", CLAUDE_CONFIG_DIR: "/nonexistent/evaluate-reader/claude", CALLUM_EVENTS_DIR: "/nonexistent/evaluate-reader/ev", DEV_MACHINE_NAME: "replay" };
  try {
    const file = path.join(dir, `${source}.jsonl`);
    fs.writeFileSync(file, lines(ctx.psql(url, rowsSql)).join("\n") + "\n");
    const out = {};
    for (const repo of repos) {
      const opts = { repo, win, projectsDirs: [], format: "json", source, ...(source === "new" ? { newEvents: file } : { events: file }) };
      out[repo] = tool.evaluate(opts, env);
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

exports.old = (ctx) =>
  reports(ctx, "old", `SELECT row_to_json(e) FROM (SELECT ts, repo, device, session_id, actor, state, issue, run_id, branch, pr, head, note FROM factory.events WHERE ${when(ctx)} ORDER BY ts, device, seq) e`, ctx.oldUrl);

exports.new = (ctx) =>
  reports(ctx, "new", `SELECT row_to_json(e) FROM factory.event_log e WHERE ${when(ctx)} ORDER BY ts, device, device_seq`, ctx.newUrl);

exports.normalize = (out) => Object.fromEntries(Object.entries(out).map(([repo, report]) => [repo, normalizeReport(report)]));
