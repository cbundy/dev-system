"use strict";
// The claim-events reader (dev-system#905): what the claim tools' held rule decides per repo#issue
// (images/base/claim-events.sh), read from the old store (factory.events) and from the new one
// (factory.event_log). It runs the shipped shell functions, so the replay checks the code the tools
// run, against a dev-query stand-in that reads ctx.oldUrl, or with --factory ctx.newUrl, read-only.
// The local logs are empty here: only the central rows are compared. The output is
// { "repo#issue": { class, claim, device } }: the lifecycle class (closed, abandoned or other), the
// latest claim type in the new names and its device.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BASE = path.join(__dirname, "..", "..", "..", "images", "base");
const CLAIM_EVENTS = path.join(BASE, "claim-events.sh");
const STANDIN = path.join(__dirname, "..", "devq-standin.js");

const second = (iso) => new Date(iso).toISOString().slice(0, 19) + "Z";
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SCRIPT = `
. "$CE_SH"
DEVQ=$STANDIN
EVENT=$NOEVENT
CE_TOOL=claim-events-reader
repo=$1
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
ce_read_central "$SIDE" "$d/central" "$SINCE" "$UNTIL"
[ "$CE_RC" -eq 0 ] || exit 3
: > "$d/local"
ce_build_latest "$d" "$SIDE"
ce_tuples "$d/latest"
`;

function read(ctx, side) {
  const url = side === "new" ? ctx.newUrl : ctx.oldUrl;
  const when = `ts >= ${lit(new Date(ctx.since).toISOString())}${ctx.until ? ` AND ts < ${lit(new Date(ctx.until).toISOString())}` : ""}`;
  const table = side === "new" ? "factory.event_log" : "factory.events";
  const repos = ctx
    .psql(url, `SELECT DISTINCT repo FROM ${table} WHERE repo IS NOT NULL AND ${when} ORDER BY 1`)
    .split("\n")
    .filter((l) => l !== "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-events-reader-"));
  try {
    const noEvent = path.join(dir, "event");
    fs.writeFileSync(noEvent, `#!/bin/sh\nprintf '%s\\n' "${dir}/no-log"\n`, { mode: 0o755 });
    const out = {};
    for (const repo of repos) {
      const r = spawnSync("sh", ["-c", SCRIPT, "sh", repo], {
        encoding: "utf8",
        env: {
          ...process.env,
          CE_SH: CLAIM_EVENTS,
          STANDIN,
          NOEVENT: noEvent,
          SIDE: side,
          SINCE: second(ctx.since),
          UNTIL: ctx.until ? second(ctx.until) : "",
          FER_OLD_URL: ctx.oldUrl,
          FER_NEW_URL: ctx.newUrl,
        },
      });
      if (r.status !== 0) throw new Error(`claim-events.sh failed on the ${side} store for ${repo} (exit ${r.status}): ${r.stderr.trim()}`);
      for (const line of r.stdout.split("\n").filter((l) => l !== "")) {
        const [issue, cls, claim, device] = line.split(" ");
        out[`${repo}#${issue}`] = { class: cls, claim, device };
      }
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

exports.old = (ctx) => read(ctx, "old");
exports.new = (ctx) => read(ctx, "new");
exports.normalize = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
