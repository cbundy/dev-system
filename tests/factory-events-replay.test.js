// The event replay and the compare harness (dev-system#650; scripts/factory-events-replay.js,
// docs/factory-events/replay.md). The corpus in tests/fixtures/factory-events-replay/ is real old
// rows; each test stands up an old-format factory.events table in one throwaway database and loads
// the corpus from it into another, as `load` does from the development database.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { available, createDb } = require("./lib/factory-db.js");
const { oldStore } = require("./lib/factory-events-old.js");
const { psql } = require("../scripts/factory-events-replay/pg.js");
const { diff } = require("../scripts/factory-events-replay/compare.js");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "scripts", "factory-events-replay.js");
const READER = path.join(ROOT, "scripts", "factory-events-replay", "self-test-reader.js");
const CLAIM_READER = path.join(ROOT, "scripts", "factory-events-replay", "readers", "claim-events.js");
const EVALUATE_READER = path.join(ROOT, "scripts", "factory-events-replay", "readers", "evaluate.js");
const HEARTBEAT_READER = path.join(ROOT, "scripts", "factory-events-replay", "readers", "heartbeat-state.js");
const LOOP_RECORDS_READER = path.join(ROOT, "scripts", "factory-events-replay", "readers", "loop-records.js");
const LOOP_FACTS_READER = path.join(ROOT, "scripts", "factory-events-replay", "readers", "loop-facts.js");
const ADMIN = process.env.FACTORY_TEST_PG_ADMIN_URL;
const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };

const corpus = fs
  .readFileSync(path.join(__dirname, "fixtures", "factory-events-replay", "old-rows.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l));

function cli(args, db, oldDb, extra = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_DB_ADMIN_URL: ADMIN, FACTORY_REPLAY_OLD_URL: oldDb.url, ...extra },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SINCE = "2026-10-16T02:00:00Z";

test("load: the corpus translates with no miss and the counts follow the rule", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const out = path.join(tmp(t), "check.json");
  const r = cli(["load", "--db", dest.name, "--since", SINCE, "--out", out], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /translation check since 2026-10-16T02:00:00.000Z: PASS/);
  const check = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(check.pass, true);
  assert.deepEqual(check.failures, []);
  assert.equal(check.total.lines, corpus.length);
  assert.equal(check.total.misses, 0);
  assert.equal(check.total.events + check.total.skips, corpus.length);
  // Every old line is a state tally; each state's events are its lines minus its named skips.
  for (const [state, s] of Object.entries(check.states)) {
    const skips = Object.values(s.skips).reduce((a, b) => a + b, 0);
    assert.equal(s.events, s.lines - skips, state);
    assert.deepEqual(s.misses, {}, state);
  }
  assert.deepEqual(check.states.merge_ready.skips, { merge_ready: 5 });
  assert.equal(check.states.transition.events, 30);
  // The database holds what was made, by type.
  assert.equal(Number(dest.query("SELECT count(*) FROM factory.event_store")), check.total.events);
  assert.equal(dest.query("SELECT count(*) FROM factory.event_store WHERE type = 'transition'"), String(check.new_events.transition));
  assert.equal(Number(dest.query("SELECT count(*) FROM factory.event_store s JOIN factory.event_log l USING (event_id)")), check.total.events);
});

test("load: a line with a token the mapping does not name is a named miss and exit 1", opts, (t) => {
  const base = corpus.find((r) => r.raw.state === "transition");
  const bad = {
    ...base,
    seq: 999999,
    raw: { ...base.raw, event_id: crypto.randomUUID(), note: `${base.raw.note} zzz=1` },
  };
  const old = oldStore(t, [...corpus, bad]);
  const dest = createDb(t);
  const out = path.join(tmp(t), "check.json");
  const r = cli(["load", "--db", dest.name, "--since", SINCE, "--out", out], dest, old);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /FAIL miss: transition: unexpected token zzz=/);
  assert.match(r.out, new RegExp(`event_id ${bad.raw.event_id}`));
  const check = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(check.pass, false);
  assert.equal(check.total.misses, 1);
  assert.equal(Object.values(check.states.transition.misses)[0], 1);
});

test("load: a database that already has rows is refused and left as it was", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "a.json")], dest, old).status, 0);
  const before = dest.query("SELECT count(*) FROM factory.event_store");
  const r = cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "b.json")], dest, old);
  assert.equal(r.status, 2);
  assert.match(r.err, /already has \d+ rows/);
  assert.equal(dest.query("SELECT count(*) FROM factory.event_store"), before);
  assert.equal(fs.existsSync(path.join(dir, "b.json")), false);
});

test("load: the old store is read in a read-only session, which refuses a write", opts, (t) => {
  const old = oldStore(t, corpus.slice(0, 3));
  assert.throws(() => psql(old.url, "DELETE FROM factory.events", { readOnly: true }), /read-only transaction/);
  assert.throws(() => psql(old.url, "CREATE TABLE factory.x (a int)", { readOnly: true }), /read-only transaction/);
  assert.equal(old.query("SELECT count(*) FROM factory.events"), "3");
  // and a read works
  assert.equal(psql(old.url, "SELECT count(*) FROM factory.events", { readOnly: true }).trim(), "3");
});

test("compare: the self-test reader matches on the corpus", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "c.json")], dest, old).status, 0);
  const r = cli(["compare", "--reader", READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
});

test("compare: the factory-state reader matches on the corpus", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "fs.json")], dest, old).status, 0);
  const reader = path.join(ROOT, "scripts", "factory-events-replay", "readers", "factory-state.js");
  const r = cli(["compare", "--reader", reader, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
  // the reader sees the corpus: a seeded change in the new store shows up
  const [id] = dest.query("SELECT event_id FROM factory.event_store WHERE type = 'transition' ORDER BY ts LIMIT 1").split("|");
  dest.query(`UPDATE factory.event_store SET issue = issue + 1000 WHERE event_id = '${id}'`);
  const seeded = cli(["compare", "--reader", reader, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(seeded.status, 1, seeded.out + seeded.err);
  assert.match(seeded.out, /difference\(s\)/);
});

test("compare: the evaluate reader matches on the corpus, apart from the documented n/a metrics", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "e.json")], dest, old).status, 0);
  const r = cli(["compare", "--reader", EVALUATE_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
  // the reader is not empty: the corpus holds four merged-and-claimed lifecycles
  const reader = require(EVALUATE_READER);
  const ctx = { oldUrl: old.url, newUrl: dest.url, since: SINCE, until: null, psql: (url, sql) => psql(url, sql, { readOnly: true }) };
  const report = reader.old(ctx)["cbundy/dev-system-scratch"];
  assert.ok(report.claim_completion.claims > 0);
  assert.ok(report.rounds.merged_issues > 0);
});

test("compare: a seeded difference is reported by path with old and new values, exit 1", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "d.json")], dest, old).status, 0);
  const [id, issue] = dest.query("SELECT event_id, issue FROM factory.event_store WHERE type = 'claimed' ORDER BY ts LIMIT 1").split("|");
  dest.query(`UPDATE factory.event_store SET issue = 999 WHERE event_id = '${id}'`);
  const r = cli(["compare", "--reader", READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /2 difference\(s\)/);
  const n = Number(dest.query(`SELECT count(*) FROM factory.event_store WHERE type = 'claimed' AND issue = ${issue}`));
  const oldN = n + 1;
  assert.ok(r.out.includes(`$["claimed|${issue}"]: old ${oldN} new ${n === 0 ? "<missing>" : n}`), r.out);
  assert.ok(r.out.includes('$["claimed|999"]: old <missing> new 1'), r.out);
  // the window bounds the read: past the corpus both sides are empty and match
  const later = cli(["compare", "--reader", READER, "--db", dest.name, "--since", "2026-10-17T00:00:00Z"], dest, old);
  assert.equal(later.status, 0, later.out + later.err);
});

test("compare: the claim-events reader matches on the corpus", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "e.json")], dest, old).status, 0);
  const r = cli(["compare", "--reader", CLAIM_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
  // the reader reads something: the decisions of the corpus's issues are not empty
  const reader = require(CLAIM_READER);
  const out = reader.old({ oldUrl: old.url, newUrl: dest.url, since: SINCE, until: null, psql: (url, sql) => psql(url, sql, { readOnly: true }) });
  assert.ok(Object.keys(out).length > 0);
  assert.ok(Object.values(out).some((v) => v.claim === "merged"));
  assert.ok(Object.values(out).some((v) => v.claim === "none"));
});

test("compare: the claim-events reader reports a claim row missing from the new side on its key", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "f.json")], dest, old).status, 0);
  // remove one claim row: the merged row of an issue that has an earlier claim row, so its decision changes
  const [id, repo, issue] = dest
    .query(`SELECT event_id, repo, issue FROM (
      SELECT event_id, repo, issue, type, ts, row_number() OVER (PARTITION BY repo, issue ORDER BY ts DESC, device DESC, device_seq DESC) rn,
        count(*) OVER (PARTITION BY repo, issue) c
      FROM factory.event_store WHERE type IN ('claimed', 'ready', 'requeued', 'merged', 'closed', 'abandoned')) x
      WHERE rn = 1 AND c >= 2 AND type = 'merged' ORDER BY ts LIMIT 1`)
    .split("|");
  assert.ok(id, "the corpus has an issue merged after an earlier claim row");
  dest.query(`DELETE FROM factory.event_store WHERE event_id = '${id}'`);
  const r = cli(["compare", "--reader", CLAIM_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 1, r.out + r.err);
  assert.ok(r.out.includes(`$["${repo}#${issue}"]`), r.out);
  // no other key is reported
  const keys = new Set([...r.out.matchAll(/\$\["([^"]+)"\]/g)].map((m) => m[1]));
  assert.deepEqual([...keys], [`${repo}#${issue}`]);
});

test("compare: the heartbeat-state reader matches on the corpus, and is not vacuous inside a lifecycle", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "h.json")], dest, old).status, 0);
  const r = cli(["compare", "--reader", HEARTBEAT_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
  // inside a lifecycle some device has an issue in flight, so the compare has something to compare
  const until = "2026-10-16T02:08:00Z";
  const reader = require(HEARTBEAT_READER);
  const ctx = { oldUrl: old.url, newUrl: dest.url, since: SINCE, until, psql: (url, sql) => psql(url, sql, { readOnly: true }) };
  assert.ok(Object.values(reader.old(ctx)).some((a) => a.state === "busy" && a.in_flight.length > 0));
  const mid = cli(["compare", "--reader", HEARTBEAT_READER, "--db", dest.name, "--since", SINCE, "--until", until], dest, old);
  assert.equal(mid.status, 0, mid.out + mid.err);
  // and at every window end just after an old delegated, fix_requested or merge_ready line, where new
  // sees only the transition into building, fixing or merge-queue. A window that ends between a
  // transition and its v1 line is the documented gap (replay.md), so those ends are left out.
  const V1 = ["delegated", "fix_requested", "merge_ready"];
  const entries = corpus.filter((r) => r.raw && r.raw.state === "transition" && /to=(building|fixing|merge-queue)\b/.test(r.raw.note || ""));
  const lines = corpus.filter((r) => r.raw && V1.includes(r.raw.state));
  // an end is in the gap only between a transition and the first v1 line it produces (the first of the
  // issue at or after the transition); a later line from a later stage does not widen it
  const inGap = (end) =>
    entries.some((tr) => {
      const t = Date.parse(tr.ts);
      const first = Math.min(...lines.filter((l) => l.raw.issue === tr.raw.issue && Date.parse(l.ts) >= t).map((l) => Date.parse(l.ts)));
      return t < end && end <= first;
    });
  const ends = new Set();
  for (const row of lines) {
    for (const plus of [1000, 5000]) {
      const ms = Date.parse(row.ts) + plus;
      if (!inGap(ms)) ends.add(new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"));
    }
  }
  assert.ok(ends.size >= 2);
  for (const e of ends) {
    const w = cli(["compare", "--reader", HEARTBEAT_READER, "--db", dest.name, "--since", SINCE, "--until", e], dest, old);
    assert.equal(w.status, 0, `until ${e}: ${w.out}${w.err}`);
  }
});

test("compare: the heartbeat-state reader reports a missing merged row under its device", opts, (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "i.json")], dest, old).status, 0);
  const [id, device] = dest
    .query(`SELECT event_id, device FROM factory.event_store e WHERE type = 'merged' AND issue IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM factory.event_store o WHERE o.repo = e.repo AND o.issue = e.issue AND o.device = e.device AND o.ts > e.ts AND o.type IN ('claimed', 'ready', 'requeued', 'implementer_routed', 'merged', 'closed', 'abandoned'))
      AND EXISTS (SELECT 1 FROM factory.event_store c WHERE c.repo = e.repo AND c.issue = e.issue AND c.device = e.device AND c.ts < e.ts AND c.type = 'claimed')
      ORDER BY ts DESC LIMIT 1`)
    .split("|");
  assert.ok(id, "the corpus has a claimed issue whose last row is merged");
  dest.query(`DELETE FROM factory.event_store WHERE event_id = '${id}'`);
  const r = cli(["compare", "--reader", HEARTBEAT_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 1, r.out + r.err);
  assert.ok(r.out.includes(`$["${device}"]`), r.out);
});

test("compare: the loop-records reader matches on the corpus, is not vacuous, and catches a change seeded in the new store", opts, async (t) => {
  const old = oldStore(t, corpus);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "l.json")], dest, old).status, 0);
  const r = cli(["compare", "--reader", LOOP_RECORDS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
  // the corpus holds rebuilt records on both sides, one set per repo and device
  const reader = require(LOOP_RECORDS_READER);
  const ctx = { oldUrl: old.url, newUrl: dest.url, since: SINCE, until: null, psql: (url, sql) => psql(url, sql, { readOnly: true }) };
  const records = await reader.old(ctx);
  const total = Object.values(records).reduce((n, list) => n + list.length, 0);
  assert.ok(total >= 4, `the corpus rebuilds ${total} records`);
  assert.deepEqual(await reader.new(ctx), records);
  // a change in the new store alone: the newest transition of an issue gets another round
  const [id, repo, device, issue] = dest
    .query(`SELECT event_id, repo, device, issue FROM factory.event_store WHERE type = 'transition' AND issue IS NOT NULL ORDER BY ts DESC, device_seq DESC LIMIT 1`)
    .split("|");
  assert.ok(id, "the corpus has a transition");
  dest.query(`UPDATE factory.event_store SET data = jsonb_set(data, '{round}', '99') WHERE event_id = '${id}'`);
  const changed = cli(["compare", "--reader", LOOP_RECORDS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(changed.status, 1, changed.out + changed.err);
  assert.ok(changed.out.includes(`$["${repo} ${device}"]`), changed.out);
  assert.match(changed.out, /round/);
  const keys = new Set([...changed.out.matchAll(/\$\["([^"]+)"\]\[(\d+)\]/g)].map((m) => `${m[1]}#${m[2]}`));
  assert.equal(keys.size, 1, changed.out);
  // a row the loop's reader refuses fails the read rather than being skipped
  dest.query(`UPDATE factory.event_store SET data = data - 'round' WHERE event_id = '${id}'`);
  const refused = cli(["compare", "--reader", LOOP_RECORDS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.notEqual(refused.status, 0);
  assert.ok((refused.out + refused.err).includes(id), refused.out + refused.err);
  assert.ok(issue);
});

test("compare: the loop-facts reader matches on the corpus, is not vacuous, and catches a change seeded in the new store", opts, async (t) => {
  // the corpus holds no reclaimed row and no loop tell, so the old store gets one of each beside it: a
  // sweep's requeue, and a tell the loop logged with the old outcome tokens the new event drops
  const device = "coder-dev-system-testbed-loop";
  const repo = "cbundy/dev-system-scratch";
  const extra = (seq, ts, raw) => ({ ts, device, repo, seq, raw: { v: 2, ts, repo, device, pr: null, head: null, branch: null, run_id: null, base_image: "2.32.2", dev_image: null, session_id: null, plugin_version: "0.37.0", template_version: "x", ...raw } });
  const rows = [
    ...corpus,
    extra(1001, "2026-10-16T02:31:00Z", { state: "reclaimed", actor: "sweep", issue: 48, note: "lease expired", event_id: crypto.randomUUID() }),
    extra(1002, "2026-10-16T02:32:00Z", { state: "loop", actor: "agent", issue: 8, note: "kind=tell key=tell:parked:8 status=done attempts=1 class=owner rule=H1 started=1792117900000 ended=1792117901000 wake=parked out=wake decision=ok", event_id: crypto.randomUUID() }),
  ];
  const old = oldStore(t, rows);
  const dest = createDb(t);
  const dir = tmp(t);
  assert.equal(cli(["load", "--db", dest.name, "--since", SINCE, "--out", path.join(dir, "f.json")], dest, old).status, 0);
  const r = cli(["compare", "--reader", LOOP_FACTS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /old and new match/);
  // both sides hold reclaimed, ledger and once keys, so the match is not empty
  const reader = require(LOOP_FACTS_READER);
  const ctx = { oldUrl: old.url, newUrl: dest.url, since: SINCE, until: null, psql: (url, sql) => psql(url, sql, { readOnly: true }) };
  const seen = await reader.old(ctx);
  const view = seen[repo];
  assert.deepEqual(Object.keys(view.reclaimed), ["48"]);
  const mine = view.devices[device];
  assert.ok(mine.ledger.some((e) => e.kind === "claim"), "a derived claim");
  assert.ok(mine.ledger.some((e) => e.key === "heartbeat:derived" || e.key === "sweep:derived"), "a derived heartbeat or sweep");
  assert.ok(mine.ledger.some((e) => e.key === "tell:parked:8" && e.status === "done"), "the loop's tell");
  assert.ok(mine.once.some((k) => k.startsWith("reviewed ")) && mine.once.some((k) => k.startsWith("intervention ")), mine.once.join("|"));
  assert.deepEqual(await reader.new(ctx), seen);
  // a change in the new store alone: the requeue happened an hour later
  dest.query(`UPDATE factory.event_store SET ts = ts + interval '1 hour' WHERE type = 'requeued'`);
  const moved = cli(["compare", "--reader", LOOP_FACTS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(moved.status, 1, moved.out + moved.err);
  assert.match(moved.out, /reclaimed/);
  dest.query(`UPDATE factory.event_store SET ts = ts - interval '1 hour' WHERE type = 'requeued'`);
  // another answer file for a review: the once key differs
  dest.query(`UPDATE factory.event_store SET data = jsonb_set(data, '{answer_path}', '"/other.answer.json"') WHERE event_id = (SELECT event_id FROM factory.event_store WHERE type = 'reviewed' LIMIT 1)`);
  const rekeyed = cli(["compare", "--reader", LOOP_FACTS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.equal(rekeyed.status, 1, rekeyed.out + rekeyed.err);
  assert.match(rekeyed.out, /reviewed/);
  // a row the loop's reader refuses fails the read rather than being skipped
  const id = dest.query(`SELECT event_id FROM factory.event_store WHERE type = 'requeued'`);
  dest.query(`UPDATE factory.event_store SET data = data - 'reason' WHERE type = 'requeued'`);
  const refused = cli(["compare", "--reader", LOOP_FACTS_READER, "--db", dest.name, "--since", SINCE], dest, old);
  assert.notEqual(refused.status, 0);
  assert.ok(id && (refused.out + refused.err).includes(id), refused.out + refused.err);
});

test("diff: paths, missing keys, array lengths and type changes", () => {
  assert.deepEqual(diff({ a: 1, b: [1, 2], c: { d: "x" } }, { a: 1, b: [1, 2], c: { d: "x" } }), []);
  assert.deepEqual(diff({ a: 1, b: [1, 2], c: { d: "x" } }, { a: 2, b: [1, 3, 4], c: [], e: 1 }), [
    { path: "$.a", old: 1, new: 2 },
    { path: "$.b[1]", old: 2, new: 3 },
    { path: "$.b[2]", old: undefined, new: 4 },
    { path: "$.c", old: { d: "x" }, new: [] },
    { path: "$.e", old: undefined, new: 1 },
  ]);
  assert.deepEqual(diff(null, 0), [{ path: "$", old: null, new: 0 }]);
});

test("load: bad arguments and a missing URL exit 2 without touching a database", () => {
  const r = spawnSync("node", [CLI, "load"], { encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: "", FACTORY_REPLAY_OLD_URL: "" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--db is required/);
  const r2 = spawnSync("node", [CLI, "load", "--db", "Bad-Name"], { encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: "x://y", FACTORY_REPLAY_OLD_URL: "x://y" } });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /--db must match/);
});
