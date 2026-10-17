"use strict";
// `load` (dev-system#650): replays the old factory.events rows through the translator into
// factory.event_store of a throwaway database, and checks the translation
// (docs/factory-events/translator.md, "The dual-write check"). The old store is only read, in a
// read-only transaction; the only database written is the one this makes.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { translate } = require("../../images/base/factory-event-translate.js");
const { psql, urlFor, DB_NAME, BOOTSTRAP } = require("./pg.js");

const DEFAULT_SINCE = "2026-10-16T02:00:00Z";
const BATCH = 500;

// The new types each old state may make. The check fails on a type outside its state's list.
const TYPES_BY_STATE = {
  ready: ["ready"],
  claimed: ["claimed"],
  renewed: ["claim_renewed"],
  claim_lost: ["claim_lost"],
  reclaimed: ["requeued"],
  closed: ["closed"],
  abandoned: ["abandoned"],
  merged: ["merged"],
  transition: ["transition"],
  reviewed: ["reviewed"],
  verdict: ["finding_handled"],
  intervention: ["intervention"],
  implementer_routed: ["implementer_routed"],
  test_weakened: ["test_weakened"],
  untrusted_stripped: ["untrusted_stripped"],
  usage: ["usage"],
  loop: ["loop_entry", "loop_passes"],
};

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// readOldRows(oldUrl, since): [{ ts, device, repo, seq, raw }] in time order, over a read-only session.
function readOldRows(oldUrl, since) {
  const t = new Date(since);
  if (Number.isNaN(t.getTime())) throw new Error(`--since is not a time: ${since}`);
  const sql = `SELECT json_build_object('ts', to_char(ts AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'device', device, 'repo', repo, 'seq', seq, 'raw', raw)::text FROM factory.events WHERE ts >= ${lit(t.toISOString())}::timestamptz ORDER BY ts, device, seq`;
  return psql(oldUrl, sql, { readOnly: true })
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

// The statement that stores one event: the push loop's columns (images/base/factory-event-push-loop),
// each read from the envelope field of the same name, device_seq being the old row's seq.
function insertSql(event, seq) {
  return `INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, session_id, issue, base_image, dev_image, template_version, plugin_version, device_seq, data) SELECT (j->>'envelope')::int, (j->>'event_id')::uuid, (j->>'ts')::timestamptz, j->>'type', (j->>'type_version')::int, j->>'repo', j->>'device', j->>'actor', j->>'session_id', (j->>'issue')::int, j->>'base_image', j->>'dev_image', j->>'template_version', j->>'plugin_version', ${Number(seq)}, j->'data' FROM (SELECT ${lit(JSON.stringify(event))}::jsonb AS j) s;`;
}

// translateRows(rows): the per-state tallies and the events made, with a name for each miss.
function translateRows(rows) {
  const states = {};
  const made = [];
  const missRows = [];
  for (const row of rows) {
    const t = translate(row.raw);
    const state = row.raw && typeof row.raw.state === "string" ? row.raw.state : "?";
    const s = (states[state] ||= { lines: 0, events: 0, events_by_type: {}, skips: {}, misses: {} });
    s.lines += 1;
    if (t.event) {
      s.events += 1;
      s.events_by_type[t.event.type] = (s.events_by_type[t.event.type] || 0) + 1;
      made.push({ event: t.event, seq: row.seq });
    } else if (t.skip !== undefined) {
      s.skips[t.skip] = (s.skips[t.skip] || 0) + 1;
    } else {
      const reason = t.miss.startsWith(`${state}: `) ? t.miss.slice(state.length + 2) : t.miss;
      s.misses[reason] = (s.misses[reason] || 0) + 1;
      missRows.push({ state, reason, device: row.device, repo: row.repo, seq: row.seq, event_id: row.raw && row.raw.event_id });
    }
  }
  return { states, made, missRows };
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// buildCheck(...): the translation check. `stored` is the per-type count read back from the database.
function buildCheck({ since, states, stored, missRows }) {
  const failures = [];
  for (const m of missRows) failures.push(`miss: ${m.state}: ${m.reason} (device ${m.device}, seq ${m.seq}, event_id ${m.event_id})`);
  const newEvents = {};
  for (const [state, s] of Object.entries(states)) {
    const skips = sum(s.skips);
    const misses = sum(s.misses);
    // Every row is translated, skipped by name or missed.
    if (s.events + skips + misses !== s.lines) failures.push(`${state}: ${s.lines} lines but ${s.events} events, ${skips} skips and ${misses} misses`);
    // The events of a state are of its types only; an unmapped state makes none.
    const allowed = TYPES_BY_STATE[state] || [];
    for (const type of Object.keys(s.events_by_type)) if (!allowed.includes(type)) failures.push(`${state}: made an event of type ${type}, not one of ${allowed.join(", ") || "none"}`);
    // The rule: new events of a state's types equal its lines minus the named skips (misses are failures above).
    if (misses === 0 && s.events !== s.lines - skips) failures.push(`${state}: ${s.events} events, expected ${s.lines - skips} (lines ${s.lines} minus ${skips} skips)`);
    for (const [type, n] of Object.entries(s.events_by_type)) newEvents[type] = (newEvents[type] || 0) + n;
  }
  // What the database holds is what was made.
  for (const type of new Set([...Object.keys(newEvents), ...Object.keys(stored)])) {
    if ((newEvents[type] || 0) !== (stored[type] || 0)) failures.push(`${type}: ${newEvents[type] || 0} events made but ${stored[type] || 0} stored`);
  }
  const statesOut = {};
  for (const state of Object.keys(states).sort()) {
    const { lines, events, skips, misses } = states[state];
    statesOut[state] = { lines, events, skips, misses };
  }
  const total = { lines: 0, events: 0, skips: 0, misses: 0 };
  for (const s of Object.values(states)) {
    total.lines += s.lines;
    total.events += s.events;
    total.skips += sum(s.skips);
    total.misses += sum(s.misses);
  }
  return {
    pass: failures.length === 0,
    since,
    states: statesOut,
    new_events: Object.fromEntries(Object.entries(stored).sort(([a], [b]) => (a < b ? -1 : 1))),
    total,
    misses: missRows,
    failures,
  };
}

function formatCheck(check) {
  const out = [`translation check since ${check.since}: ${check.pass ? "PASS" : "FAIL"}`, "old state: lines -> events, skips, misses"];
  for (const [state, s] of Object.entries(check.states)) {
    const skips = Object.entries(s.skips).map(([k, n]) => `${k} x${n}`).join(", ");
    const misses = Object.entries(s.misses).map(([k, n]) => `${k} x${n}`).join(", ");
    out.push(`  ${state}: ${s.lines} -> ${s.events} events${skips ? `, skips: ${skips}` : ""}${misses ? `, misses: ${misses}` : ""}`);
  }
  out.push("new events per type:");
  for (const [type, n] of Object.entries(check.new_events)) out.push(`  ${type}: ${n}`);
  const t = check.total;
  out.push(`total: ${t.lines} lines, ${t.events} events, ${t.skips} skips, ${t.misses} misses`);
  for (const f of check.failures) out.push(`FAIL ${f}`);
  return `${out.join("\n")}\n`;
}

// load({ oldUrl, adminUrl, db, since, out }): runs the replay and returns the check. Refuses a
// database that already has rows (or that is not a factory database it can inspect).
function load({ oldUrl, adminUrl, db, since = DEFAULT_SINCE, out = null }) {
  if (!oldUrl) throw new Error("no old-store URL (FACTORY_REPLAY_OLD_URL, AGENTSVIEW_PG_URL or the agentsview-pg-url secret)");
  if (!adminUrl) throw new Error("no admin URL (FACTORY_DB_ADMIN_URL) to create the database with");
  if (!DB_NAME.test(db || "")) throw new Error(`--db must match ${DB_NAME}`);
  const dbUrl = urlFor(adminUrl, db);
  if (psql(adminUrl, `SELECT 1 FROM pg_database WHERE datname = ${lit(db)}`).trim() === "1") {
    let rows;
    try {
      rows = Number(psql(dbUrl, "SELECT count(*) FROM factory.event_store").trim());
    } catch {
      throw new Error(`database ${db} exists and is not an empty factory database: refusing`);
    }
    if (rows > 0) throw new Error(`database ${db} already has ${rows} rows in factory.event_store: refusing`);
  }
  const oldRows = readOldRows(oldUrl, since);
  const { states, made, missRows } = translateRows(oldRows);
  const ids = new Set();
  for (const m of made) {
    if (ids.has(m.event.event_id)) throw new Error(`two old rows share event_id ${m.event.event_id}`);
    ids.add(m.event.event_id);
  }
  const b = spawnSync("bash", [BOOTSTRAP, "--db", db], { encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: adminUrl } });
  if (b.status !== 0) throw new Error(`factory-db-bootstrap failed: ${b.stdout}${b.stderr}`.trim());
  for (let i = 0; i < made.length; i += BATCH) {
    const stmts = made.slice(i, i + BATCH).map((m) => insertSql(m.event, m.seq));
    psql(dbUrl, `SET ROLE ${JSON.stringify(`${db}_writer`)};\n${stmts.join("\n")}\n`);
  }
  const stored = {};
  for (const l of psql(dbUrl, "SELECT type, count(*) FROM factory.event_store GROUP BY 1").split("\n").filter((x) => x !== "")) {
    const [type, n] = l.split("|");
    stored[type] = Number(n);
  }
  const check = buildCheck({ since: new Date(since).toISOString(), states, stored, missRows });
  if (out) fs.writeFileSync(out, `${JSON.stringify(check, null, 2)}\n`);
  return check;
}

module.exports = { load, formatCheck, buildCheck, translateRows, readOldRows, insertSql, DEFAULT_SINCE, TYPES_BY_STATE };
