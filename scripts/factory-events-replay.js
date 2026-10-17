#!/usr/bin/env node
"use strict";

// The event replay (dev-system#650, part of #534): proves the new event store holds what the old one
// does. It is not the plan replay (scripts/factory-loop-replay.js), which replays the loop's decisions.
//
//   load     reads the old factory.events rows from --since through an old-store URL, read-only,
//            translates each raw line (images/base/factory-event-translate.js, replay mode) and
//            stores the events in factory.event_store of the throwaway database --db (made with
//            factory-db-bootstrap; refused when it already has rows). It prints the translation check
//            and saves it as JSON; exit 0 only when it passes.
//   compare  runs a reader module's old(ctx) and new(ctx) and reports each difference by path;
//            exit 0 only when there is none.
//
// usage: node scripts/factory-events-replay.js load --db NAME [--since ISO] [--out FILE]
//        node scripts/factory-events-replay.js compare --reader MODULE --db NAME [--since ISO] [--until ISO]
// URLs come from the environment, never argv: the old store from FACTORY_REPLAY_OLD_URL (else
// AGENTSVIEW_PG_URL or the agentsview-pg-url secret), the admin connection from FACTORY_DB_ADMIN_URL.
// docs/factory-events/replay.md has the details.

const { load, formatCheck, DEFAULT_SINCE } = require("./factory-events-replay/load.js");
const { runCompare, report } = require("./factory-events-replay/compare.js");
const { oldStoreUrl, adminUrl, urlFor, DB_NAME } = require("./factory-events-replay/pg.js");

const USAGE = "usage: factory-events-replay.js load --db NAME [--since ISO] [--out FILE]\n       factory-events-replay.js compare --reader MODULE --db NAME [--since ISO] [--until ISO]\n";

function parse(argv, allowed) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--") || !allowed.includes(k.slice(2)) || i + 1 >= argv.length) throw new Error(`bad argument ${k}\n${USAGE}`);
    o[k.slice(2)] = argv[++i];
  }
  return o;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "load") {
    const o = parse(rest, ["db", "since", "out"]);
    if (!o.db) throw new Error(`--db is required\n${USAGE}`);
    const check = load({ oldUrl: oldStoreUrl(), adminUrl: adminUrl(), db: o.db, since: o.since || DEFAULT_SINCE, out: o.out || "factory-events-replay-check.json" });
    process.stdout.write(formatCheck(check));
    return check.pass ? 0 : 1;
  }
  if (cmd === "compare") {
    const o = parse(rest, ["reader", "db", "since", "until"]);
    if (!o.reader || !o.db) throw new Error(`--reader and --db are required\n${USAGE}`);
    if (!DB_NAME.test(o.db)) throw new Error(`--db must match ${DB_NAME}`);
    const oldUrl = oldStoreUrl();
    const admin = adminUrl();
    if (!oldUrl || !admin) throw new Error("need the old-store URL and FACTORY_DB_ADMIN_URL");
    const since = new Date(o.since || DEFAULT_SINCE).toISOString();
    const until = o.until ? new Date(o.until).toISOString() : null;
    const result = await runCompare({ reader: o.reader, oldUrl, newUrl: urlFor(admin, o.db), since, until });
    process.stdout.write(report(result));
    return result.differences.length === 0 ? 0 : 1;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`factory-events-replay: ${e.message}\n`);
    process.exit(2);
  },
);
