// An old-format `factory.events` store for tests of the switch to the factory database
// (dev-system#650, #652): the table the old push path (images/base/event-push-loop) writes, in a
// throwaway database made by tests/lib/factory-db.js, filled from old-row fixtures. Deleted with the
// old event path (#656).
"use strict";

const { createDb } = require("./factory-db.js");
const { psql } = require("../../scripts/factory-events-replay/pg.js");

// The old push path's table (images/base/event-push-loop), with its rows.
const OLD_DDL = `CREATE TABLE factory.events (
  device text NOT NULL, repo text NOT NULL, seq bigint NOT NULL, ts timestamptz NOT NULL, state text NOT NULL,
  issue integer, run_id text, branch text, pr integer, head text, note text, session_id text, actor text,
  v integer, raw jsonb NOT NULL, event_id uuid, base_image text, dev_image text, template_version text,
  plugin_version text);`;

// oldStore(t, rows): a new database holding the rows ({ device, repo, seq, ts, raw }, the shape of
// tests/fixtures/factory-events-replay/old-rows.jsonl) in factory.events; dropped with t.
function oldStore(t, rows) {
  const db = createDb(t);
  const stmts = rows.map((r) => {
    const j = JSON.stringify(r.raw).replace(/'/g, "''");
    return `INSERT INTO factory.events (device, repo, seq, ts, state, issue, run_id, branch, pr, head, note, session_id, actor, v, raw, event_id, base_image, dev_image, template_version, plugin_version)
      SELECT '${r.device}', '${r.repo}', ${r.seq}, '${r.ts}', j->>'state', (j->>'issue')::int, j->>'run_id', j->>'branch', (j->>'pr')::int, j->>'head', j->>'note', j->>'session_id', j->>'actor', (j->>'v')::int, j, (j->>'event_id')::uuid, j->>'base_image', j->>'dev_image', j->>'template_version', j->>'plugin_version' FROM (SELECT '${j}'::jsonb AS j) s;`;
  });
  psql(db.url, `${OLD_DDL}\n${stmts.join("\n")}\n`);
  return db;
}

module.exports = { OLD_DDL, oldStore };
