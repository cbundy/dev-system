// Tests for images/base/callum-flow-factory-state (cbundy/dev-system#345, #1293): the tool reads the
// factory.issue_state_at view through `dev-query --factory`, so every test here runs it against a
// throwaway PostgreSQL database (tests/lib/factory-db.js) loaded from event rows as the writer role.
// tests/fixtures/factory-state/*.input.json are those rows (with the GitHub answers and the reviewed
// output beside each as *.expected.json). The pure rendering, argument and docs checks need no
// database. images/base/test/sections/09-agentsview.sh runs the tool in the image.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const BASE = path.join(ROOT, "images", "base");
const SCRIPT = path.join(BASE, "callum-flow-factory-state");
const FIX = path.join(__dirname, "fixtures", "factory-state");
const MIGRATIONS = path.join(BASE, "factory-db", "migrations");
const mod = require(SCRIPT);
const { available, createDb } = require("./lib/factory-db.js");

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };
const names = fs.readdirSync(FIX).filter((f) => f.endsWith(".input.json")).map((f) => f.replace(".input.json", "")).sort();
const input = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.input.json`), "utf8"));
const expectedFile = (n) => path.join(FIX, `${n}.expected.json`);
const A = "acme/widgets";
const RPW = "reader-pw";
const AT = ["--at", "2026-10-10T12:00:00Z", "--github", "off", "--format", "json"];

// ---------------------------------------------------------------- harness

let tmp;
let issueRead;
let devQuery;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-state-test-"));
  // the GitHub side: answers from the fixture named by FS_FIXTURE
  issueRead = path.join(tmp, "issue-read");
  fs.writeFileSync(issueRead, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const gh = JSON.parse(fs.readFileSync(process.env.FS_FIXTURE, "utf8")).github[process.env.CALLUM_FLOW_REPO];
if (!gh) process.exit(1);
const lab = (ls) => ls.map((name) => ({ name }));
if (a.includes("--list")) {
  console.log(JSON.stringify({ issues: Object.entries(gh.open).map(([n, v]) => ({ number: Number(n), labels: lab(v.labels) })), stripped: 0 }));
  process.exit(0);
}
const n = a.find((x) => /^\\d+$/.test(x));
const s = gh.open[n] ? { state: "open", labels: gh.open[n].labels } : gh.states[n];
if (!s || s.state === "unknown") process.exit(3);
const comments = gh.claims[n] ? [{ id: 1, body: "claimed-by: " + gh.claims[n].device + " at " + gh.claims[n].at + " lease: " + gh.claims[n].lease_minutes }] : [];
console.log(JSON.stringify({ issue: { state: s.state, labels: lab(s.labels || []), state_reason: s.reason, closed_at: s.closed_at }, comments, stripped: 0 }));
`, { mode: 0o755 });
  // dev-query in front of the real one: logs every call, and can fail or hide a part of the database
  devQuery = path.join(tmp, "dev-query");
  fs.writeFileSync(devQuery, `#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const a = process.argv.slice(2);
const sql = a[a.indexOf("-c") + 1];
const marker = sql.split("\\n")[0];
fs.appendFileSync(process.env.FS_LOG, JSON.stringify({ marker, factory: a.includes("--factory"), sql }) + "\\n");
if (process.env.FS_FAIL) { console.error("psql: connection refused"); process.exit(Number(process.env.FS_FAIL)); }
if (marker === "-- fs:queue_meta" && process.env.FS_QUEUE_COLUMNS === "0") { console.log(JSON.stringify({ columns: false })); process.exit(0); }
if (marker === "-- fs:queue" && process.env.FS_QUEUE_FAIL) { console.error("psql: queue exploded"); process.exit(Number(process.env.FS_QUEUE_FAIL)); }
const r = spawnSync(process.env.REAL_DEV_QUERY, a, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`, { mode: 0o755 });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const lit = (s) => `$q$${s}$q$`;

// load(db, events): event rows { repo, device, ts, type, issue, data, version } into factory.event_store
// as the writer role.
function load(db, events) {
  db.n = db.n || 0;
  const rows = events.map((e) => {
    db.n += 1;
    return `(1, '${crypto.randomUUID()}', ${lit(e.ts)}, '${e.type}', ${e.version || 1}, ${lit(e.repo || A)}, ${lit(e.device || "dev-a")}, 'agent', ${e.issue === null || e.issue === undefined ? "NULL" : e.issue}, ${db.n}, ${lit(JSON.stringify(e.data || {}))}::jsonb)`;
  });
  if (rows.length) db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data) VALUES ${rows.join(",\n")}`, "writer");
}

// cli(db, args, env, fixture): the tool over the real dev-query as the database's reader role.
function cli(db, args, env = {}, fixture = "github") {
  const log = path.join(tmp, "calls.log");
  fs.writeFileSync(log, "");
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, CALLUM_FLOW_DEV_QUERY_BIN: devQuery, REAL_DEV_QUERY: path.join(BASE, "dev-query"), DEV_SYSTEM_SHARE: BASE,
      FACTORY_DB_READER_URL: db.readerUrl, CALLUM_FLOW_ISSUE_READ_BIN: issueRead, FS_FIXTURE: path.join(FIX, `${fixture}.input.json`), FS_LOG: log, ...env,
    },
  });
  return { ...r, calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

const json = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const newDb = (t) => createDb(t, { readerPassword: RPW });
const all = (report, repo = A) => {
  const r = report.repos.find((x) => x.repo === repo);
  return r.issues.concat(r.recent);
};
const issue = (report, n, repo = A) => all(report, repo).find((i) => i.issue === n);

// event builders for the inline cases
const ev = (type, ts, n, data = {}, o = {}) => ({ type, ts, issue: n, data, ...o });
const claim = (n, ts, lease = 120) => ev("claimed", ts, n, { lease_minutes: lease });
const tr = (n, ts, seq, from, to, extra = {}) => ev("transition", ts, n, {
  life: "t3xq00", seq, from_state: from, to_state: to, seq_at: ts, state_since: ts, step: null, attempt: 1, why: null, question: null, ...extra,
});
const D = "2026-10-10T";

// ---------------------------------------------------------------- fixtures against the database

function runFixture(db, n) {
  const fx = input(n);
  load(db, fx.events);
  const args = ["--at", fx.at, "--format", "json", "--github", fx.github ? "on" : "off", ...(fx.repos || []).flatMap((r) => ["--repo", r])];
  return { fx, report: json(cli(db, args, {}, n)) };
}

test("every fixture's report equals its reviewed expected JSON, and each issue equals the view's row", opts, (t) => {
  assert.deepEqual(names, ["github", "lapsed-claim", "parked", "queue", "v2", "v2-waiting"]);
  for (const n of names) {
    const db = newDb(t);
    const { fx, report } = runFixture(db, n);
    if (process.env.UPDATE_FIXTURES) fs.writeFileSync(expectedFile(n), `${JSON.stringify(report, null, 2)}\n`);
    assert.deepEqual(report, JSON.parse(fs.readFileSync(expectedFile(n), "utf8")), n);
    const rows = JSON.parse(db.query(`SET TimeZone = 'UTC'; SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.repo, v.issue), '[]') FROM factory.issue_state_at('${fx.at}') v`, "reader"));
    let checked = 0;
    for (const repo of report.repos) {
      for (const i of repo.issues.concat(repo.recent).filter((x) => x.source === "event")) {
        const row = rows.find((r) => r.repo === repo.repo && r.issue === i.issue);
        assert.ok(row, `${n} #${i.issue}: no row in the view`);
        assert.deepEqual([i.state, i.state_since, i.holder], [row.state, new Date(row.state_since).toISOString(), row.holder], `${n} #${i.issue}`);
        assert.equal(repo.recent.includes(i), row.ended, `${n} #${i.issue}: ended`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, n);
  }
});

test("every issue has what factory-loop's parse.ts and factory-reconcile read, and none of the old stage fields", opts, async (t) => {
  const { stateOfRow } = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "factory-state-map.ts"));
  for (const n of names) {
    const db = newDb(t);
    const { report } = runFixture(db, n);
    for (const repo of report.repos) {
      for (const i of repo.issues.concat(repo.recent)) {
        const at = `${n} #${i.issue}`;
        for (const gone of ["stage", "entered_at", "run", "v2", "minutes_in_stage"]) assert.ok(!(gone in i), `${at}: no ${gone}`);
        assert.ok("minutes_in_state" in i, `${at}: minutes_in_state`);
        assert.ok(stateOfRow({ ...i, ended: repo.recent.includes(i) }), `${at}: factory-loop reads a state`);
        assert.ok(i.stuck === null || typeof i.stuck.rule === "string", at);
      }
    }
    for (const s of report.stuck) assert.ok(!("stage" in s), `${n}: no stage in a stuck entry`);
    for (const s of report.skipped_events) assert.deepEqual(Object.keys(s).sort(), ["count", "derived", "type", "type_version"]);
  }
});

test("issues sort by the state order, then the issue number", opts, (t) => {
  for (const n of ["v2", "v2-waiting", "lapsed-claim"]) {
    const db = newDb(t);
    const { report } = runFixture(db, n);
    for (const repo of report.repos) {
      const shown = (i, ended) => (ended ? "closed" : i.life === null && i.state === "designing" && i.lease && i.lease.lapsed ? "queued" : i.state);
      for (const [list, ended] of [[repo.issues, false], [repo.recent, true]]) {
        const keys = list.map((i) => [mod.STATE_ORDER.indexOf(shown(i, ended)), i.issue]);
        assert.ok(keys.every((k) => k[0] >= 0), `${n}: every row has a known state`);
        assert.deepEqual(keys, [...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1]), `${n} ${repo.repo}`);
      }
    }
  }
});

test("no stage translation is left in the tool or its readers", () => {
  const files = ["plugins/factory-loop/hooks/factory-state-map.ts", "plugins/factory-loop/hooks/parse.ts", "plugins/factory-hud/hooks/format.ts",
    "plugins/factory-loop/bin/factory-reconcile", "images/base/callum-flow-factory-state"];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const gone of ["STAGE_STATE", "entered_at", "'in pipeline'", "i.v2", "?? i.v2", "ACTIVE_STAGES", "V2_STAGE", "minutes_in_stage"]) assert.ok(!src.includes(gone), `${rel}: ${gone}`);
  }
});

test("lapsed claim: a claim-only designing issue shows as queued in the text, with the lapse text and no life", opts, (t) => {
  const db = newDb(t);
  const { report } = runFixture(db, "lapsed-claim");
  const text = cli(db, ["--at", input("lapsed-claim").at, "--github", "off"]);
  assert.equal(text.status, 0, text.stderr);
  const lapsed = all(report).filter((i) => i.life === null && i.state === "designing" && i.lease && i.lease.lapsed);
  assert.ok(lapsed.length >= 2);
  for (const i of lapsed) {
    assert.equal(i.state, "designing", "the JSON state stays the view's");
    assert.match(i.detail, /^claim lapsed at \S+/);
    assert.equal(i.detail, `claim lapsed at ${i.lease.until}`);
    assert.equal(i.life, null, "factory-reconcile's orphanOf only sees an issue with no life");
    assert.match(text.stdout, new RegExp(`#${i.issue} +queued +`));
  }
  const live = all(report).find((i) => i.life === null && i.state === "designing" && i.lease && !i.lease.lapsed);
  assert.ok(live, "a claim inside its lease stays designing");
  assert.match(text.stdout, new RegExp(`#${live.issue} +designing +`));
  assert.match(live.detail, /^v2 designing/);
});

test("closed with why done, merged-by-hand or merged is closed, with its why kept", opts, (t) => {
  const db = newDb(t);
  const close = (n, why) => [claim(n, `${D}09:00:00.000Z`), tr(n, `${D}09:30:00.000Z`, 3, "building", "closed", { why })];
  load(db, [...close(1, "done"), ...close(2, "merged-by-hand"), ...close(3, "merged"), ...close(4, "dropped"), ...close(5, null)]);
  const r = json(cli(db, AT));
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => [issue(r, n).state, issue(r, n).why]), [["closed", "done"], ["closed", "merged-by-hand"], ["closed", "merged"], ["closed", "dropped"], ["closed", null]]);
  assert.equal(issue(r, 4).detail, "v2 closed (dropped)");
  assert.equal(issue(r, 5).detail, "v2 closed (no why)");
  assert.equal(r.repos[0].issues.length, 0);
});

test("--at: the report before and after a transition shows the state of then", opts, (t) => {
  const db = newDb(t);
  load(db, [claim(7, `${D}09:00:00.000Z`), tr(7, `${D}09:01:00.000Z`, 0, null, "queued"), tr(7, `${D}10:00:00.000Z`, 1, "queued", "designing", { step: "design" }),
    tr(7, `${D}11:00:00.000Z`, 2, "designing", "building", { step: "build" })]);
  const at = (iso) => json(cli(db, ["--at", iso, "--github", "off", "--format", "json"]));
  const before = at(`${D}10:30:00Z`);
  assert.equal(issue(before, 7).state, "designing");
  assert.equal(issue(before, 7).minutes_in_state, 30);
  assert.equal(before.at_source, "--at");
  const after = at(`${D}11:30:00Z`);
  assert.deepEqual([issue(after, 7).state, issue(after, 7).minutes_in_state], ["building", 30]);
  assert.deepEqual(at(`${D}08:00:00Z`).repos, [], "before any event nothing is placed");
});

test("a closed life followed by a claim starts a new life; the older life is not the state", opts, (t) => {
  const db = newDb(t);
  load(db, [claim(8, `${D}06:00:00.000Z`), tr(8, `${D}06:01:00.000Z`, 0, null, "queued"), tr(8, `${D}07:00:00.000Z`, 3, "building", "closed", { why: "dropped" }),
    claim(8, `${D}10:00:00.000Z`), claim(9, `${D}10:00:00.000Z`), tr(9, `${D}10:01:00.000Z`, 0, null, "queued", { life: "t3xq10" })]);
  const r = json(cli(db, AT));
  assert.equal(issue(r, 8).state, "designing", "reclaimed after the close");
  assert.equal(issue(r, 8).life, null);
  assert.equal(issue(r, 9).state, "queued");
});

test("counts and devices come from the event log, per repo and device", opts, (t) => {
  const db = newDb(t);
  load(db, [claim(1, `${D}09:00:00.000Z`), claim(2, `${D}09:30:00.000Z`, 120), { ...claim(3, `${D}11:00:00.000Z`), device: "dev-b" }, { ...claim(4, `${D}11:30:00.000Z`), repo: "Other/Repo" }]);
  const r = json(cli(db, AT));
  const c = r.repos.find((x) => x.repo === A).coverage;
  assert.equal(c.events, 3);
  assert.equal(c.last_event_at, `${D}11:00:00.000Z`);
  assert.deepEqual(c.devices, [{ device: "dev-a", events: 2, last_event_at: `${D}09:30:00.000Z` }, { device: "dev-b", events: 1, last_event_at: `${D}11:00:00.000Z` }]);
  assert.ok(r.repos.some((x) => x.repo === "other/repo"), "repo names are lower-cased");
  const one = json(cli(db, [...AT, "--repo", "Other/Repo"]));
  assert.deepEqual(one.repos.map((x) => x.repo), ["other/repo"]);
});

// ---------------------------------------------------------------- stuck

const stuckEvents = [
  claim(1, `${D}06:00:00.000Z`), tr(1, `${D}06:01:00.000Z`, 1, "queued", "designing", { step: "design" }), // designing 359 min: past 240
  claim(2, `${D}11:00:00.000Z`), tr(2, `${D}11:00:00.000Z`, 1, "designing", "building", { step: "build" }), // building 60 min: not past 60
  claim(3, `${D}10:30:00.000Z`), tr(3, `${D}10:30:00.000Z`, 1, "building", "building", { step: "build" }), // building 90 min: past 60
  claim(4, `${D}11:00:00.000Z`), tr(4, `${D}11:00:00.000Z`, 1, "building", "reviewing", { step: "review" }), // reviewing: no rule
  claim(5, `${D}11:00:00.000Z`), tr(5, `${D}11:00:00.000Z`, 1, "reviewing", "merge-queue", { step: "queue", pr: 55 }), // merge-queue 60: past 30
  claim(6, `${D}11:50:00.000Z`), tr(6, `${D}11:50:00.000Z`, 1, "building", "parked", { question: "Which one?" }), // parked 10: fine
];

test("stuck without --rule is the view's flag; the top-level list names state, rule and minutes", opts, (t) => {
  const db = newDb(t);
  load(db, stuckEvents);
  const r = json(cli(db, AT));
  assert.deepEqual(r.stuck.map((s) => [s.issue, s.state, s.rule, s.minutes_in_state]), [
    [1, "designing", "designing", 359], [3, "building", "building", 90], [5, "merge-queue", "merge-queue", 60],
  ]);
  assert.deepEqual(issue(r, 3).stuck, { rule: "building", minutes: 60 });
  assert.equal(issue(r, 2).stuck, null);
  assert.equal(issue(r, 6).question, "Which one?");
  assert.equal(issue(r, 4).stuck, null, "reviewing has no rule");
  assert.deepEqual(r.rules, { designing: 240, building: 60, fixing: null, "merge-queue": 30, parked: 30, queued: null, reviewing: null, waiting: null });
});

test("--rule moves a threshold by state name or by the S1..S4 alias, and echoes it", opts, (t) => {
  const db = newDb(t);
  load(db, stuckEvents);
  const byName = json(cli(db, [...AT, "--rule", "building=5"]));
  assert.ok(byName.stuck.some((s) => s.issue === 2), "#2 is 60 minutes in building");
  assert.equal(byName.rules.building, 5);
  assert.deepEqual(issue(byName, 2).stuck, { rule: "building", minutes: 5 });
  const alias = json(cli(db, [...AT, "--rule", "S2=5"]));
  assert.deepEqual(alias.stuck, byName.stuck);
  assert.deepEqual(alias.rules, byName.rules);
  const loose = json(cli(db, [...AT, "--rule", "S1=999", "--rule", "S2=999", "--rule", "S4=999"]));
  assert.deepEqual(loose.stuck, []);
  assert.deepEqual([loose.rules.designing, loose.rules.building, loose.rules["merge-queue"], loose.rules.parked], [999, 999, 999, 30]);
  const tight = json(cli(db, [...AT, "--rule", "reviewing=5", "--rule", "parked=5"]));
  assert.deepEqual(tight.stuck.filter((s) => [4, 6].includes(s.issue)).map((s) => [s.issue, s.rule]), [[4, "reviewing"], [6, "parked"]]);
  const s3 = json(cli(db, [...AT, "--rule", "S3=5"]));
  assert.equal(s3.rules.parked, 5);
});

test("--rule: S5, S6, an unknown name and a bad number exit 2", opts, (t) => {
  const db = newDb(t);
  for (const rule of ["S5=1", "S6=1", "bogus=5", "building=0", "building=x", "building", "S1"]) {
    const r = cli(db, [...AT, "--rule", rule]);
    assert.equal(r.status, 2, rule);
    assert.match(r.stderr, /usage: callum-flow-factory-state/);
  }
});

test("don't-merge: a merge-queue issue the owner holds shows the flag and is not stuck", opts, (t) => {
  const db = newDb(t);
  load(db, stuckEvents);
  const gh = (labels) => {
    const f = path.join(tmp, "dm.input.json");
    fs.writeFileSync(f, JSON.stringify({ github: { [A]: { ok: true, open: { 5: { labels } }, states: {}, claims: {} } } }));
    return f;
  };
  const run = (labels) => {
    const f = gh(labels);
    return json(cli(db, ["--at", "2026-10-10T12:00:00Z", "--format", "json"], { FS_FIXTURE: f }));
  };
  const plain = run(["factory:merge-queue"]);
  assert.ok(plain.stuck.some((s) => s.issue === 5));
  assert.deepEqual(issue(plain, 5).flags, []);
  const held = run(["factory:merge-queue", "Don't-Merge"]);
  assert.equal(held.stuck.some((s) => s.issue === 5), false);
  assert.ok(issue(held, 5).flags.includes("held: don't-merge (waits on the owner)"));
  assert.equal(issue(held, 5).stuck, null);
  assert.ok(held.stuck.some((s) => s.issue === 1), "other issues keep their rules");
});

// ---------------------------------------------------------------- skipped events, queue

test("skipped events: a type or version the shapes file does not list is counted, and derived marks the ones the view reads", opts, (t) => {
  const db = newDb(t);
  load(db, [claim(1, `${D}09:00:00.000Z`), ev("transition", `${D}09:05:00.000Z`, 1, { life: "t3xq00", to_state: "building" }, { version: 2 }),
    ev("transition", `${D}09:06:00.000Z`, 1, { life: "t3xq00", to_state: "parked" }, { version: 2 }), ev("some_future_type", `${D}09:07:00.000Z`, 1, {}, { version: 1 })]);
  const r = json(cli(db, AT));
  assert.deepEqual(r.skipped_events, [
    { type: "some_future_type", type_version: 1, count: 1, derived: false },
    { type: "transition", type_version: 2, count: 2, derived: true },
  ]);
  assert.equal(issue(r, 1).state, "designing", "a skipped transition changes no state");
  assert.match(cli(db, [...AT.slice(0, 2), "--github", "off"]).stdout, /skipped events: some_future_type v1 x1, transition v2 x2 \(derived\)/);
  assert.deepEqual(json(cli(db, [...AT, "--repo", "nobody/else"])).skipped_events, []);
});

test("the view types the tool lists equal the VALUES list of migration 0033", () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, "0033_issue_state.sql"), "utf8");
  const start = sql.indexOf("(l.type, l.type_version) IN (VALUES");
  assert.ok(start > 0, "the VALUES list");
  const block = sql.slice(start, sql.indexOf("\n),\ntv AS", start));
  const listed = [...block.matchAll(/\('([a-z_]+)', (\d+)\)/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(listed.map((x) => x[0]).sort(), [...mod.VIEW_TYPES].sort());
  const current = JSON.parse(fs.readFileSync(path.join(BASE, "factory-event-shapes.json"), "utf8")).current;
  for (const [type, version] of listed) assert.equal(current[type], version, `${type} is current at the version the view reads`);
});

test("queue fixture: the newest snapshot at --at wins, the top is 10 entries without factors, a repo without one is n/a", opts, (t) => {
  const db = newDb(t);
  const { fx, report } = runFixture(db, "queue");
  const q = report.repos.find((r) => r.repo === A).queue;
  assert.equal(q.reason, "heartbeat");
  assert.equal(q.age_minutes, 5);
  assert.equal(q.top.length, 10);
  assert.ok(q.top.every((c) => !("factors" in c)));
  assert.deepEqual(q.rest, [{ why: "blocked", count: 2 }]);
  assert.deepEqual(report.repos.find((r) => r.repo === "acme/gadgets").queue, { "n/a": "no queue_snapshot for this repo at or before --at" });
  // a snapshot after --at is not shown, and it never counts as an event of the repo
  const before = report.repos.find((r) => r.repo === A).coverage.events;
  const snap = fx.events.filter((e) => e.type === "queue_snapshot").pop();
  load(db, [{ ...snap, ts: `${D}12:30:01.000Z`, data: { ...snap.data, taken_at: `${D}12:30:00.000Z`, reason: "changed" } }]);
  const again = json(cli(db, ["--at", fx.at, "--format", "json", "--github", "off"]));
  assert.deepEqual(again.repos.find((r) => r.repo === A).queue, q);
  assert.equal(again.repos.find((r) => r.repo === A).coverage.events, before);
  const later = json(cli(db, ["--at", `${D}13:00:00Z`, "--format", "json", "--github", "off"]));
  assert.equal(later.repos.find((r) => r.repo === A).queue.reason, "changed");
});

test("queue: text output prints the snapshot line, the controls line and the n/a line", opts, (t) => {
  const db = newDb(t);
  load(db, input("queue").events);
  const r = cli(db, ["--at", "2026-10-10T12:00:00Z", "--github", "off"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("queue (snapshot 5m old, heartbeat): #200 score 100, #201 score 95, #202 score 90 (blocked), #203 score - (unknown), #204 score 80 (blocked), #205 score 75 (blocked), #206 score 70 (blocked), #207 score 65 (blocked), #208 score 60 (blocked), #209 score 55 (blocked), +4 more\n"), r.stdout);
  assert.ok(r.stdout.includes("queue controls: free slots 1, priority #300 #301, only none, one at a time off, no new work on\n"));
  assert.ok(r.stdout.includes("queue: n/a: no queue_snapshot for this repo at or before --at\n"));
});

test("queue: a database before migration 0023 is n/a with exit 0, and a failing queue read is n/a too", opts, (t) => {
  const db = newDb(t);
  load(db, input("queue").events);
  const old = cli(db, AT, { FS_QUEUE_COLUMNS: "0" });
  for (const r of json(old).repos) assert.deepEqual(r.queue, { "n/a": "factory.event_log has no queue_snapshot columns (the factory database predates migration 0023)" });
  assert.equal(old.calls.some((c) => c.marker === "-- fs:queue"), false);
  const bad = json(cli(db, AT, { FS_QUEUE_FAIL: "4" }));
  for (const r of bad.repos) assert.match(r.queue["n/a"], /^cannot read the queue snapshot: cannot read the factory database through dev-query --factory \(exit 4\): psql: queue exploded$/);
  assert.ok(bad.repos[0].coverage.events > 0, "the issues are still read");
});

// ---------------------------------------------------------------- GitHub

test("github: closure beats events, labels and claim holders are cross-checked, labelled issues unknown to the database appear", opts, (t) => {
  const db = newDb(t);
  const { report } = runFixture(db, "github");
  const st = (n) => issue(report, n);
  assert.equal(st(80).state, "designing", "GitHub's closure leaves the view's state");
  assert.equal(st(80).source, "github");
  assert.equal(st(80).stuck, null);
  const text = cli(db, ["--at", input("github").at, "--github", "on"], {}, "github");
  assert.equal(text.status, 0, text.stderr);
  for (const n of [80, 83]) assert.match(text.stdout, new RegExp(`#${n} +closed +`));
  assert.match(st(80).detail, /^closed on GitHub \(completed\)/);
  assert.match(st(82).flags.join(), /queued, but the issue has no 'ready' label/);
  assert.deepEqual(st(84).flags, [], "a claim needs no label (v2 SPEC 3.6)");
  assert.match(st(81).flags.join(), /dev-b/);
  assert.match(st(86).flags.join(), /could not be read/);
  assert.deepEqual([90, 91].map((n) => [st(n).state, st(n).source]), [["queued", "github"], ["building", "github"]]);
  assert.equal(st(92), undefined, "an unrelated open issue is not in the factory");
  assert.equal(st(83).state, "closed");
  assert.equal(st(83).why, "merged");
  assert.equal(st(83).source, "event");
});

test("github: factory labels are checked against the state, and factory:rejected on a closed issue is no flag", opts, (t) => {
  const db = newDb(t);
  const { report } = runFixture(db, "v2");
  assert.deepEqual(issue(report, 100).flags, [], "building with factory:building");
  const flagged = all(report).filter((i) => i.flags.length);
  assert.ok(flagged.length > 0, "the fixture carries label mismatches");
  assert.ok(flagged.every((i) => i.flags.every((f) => f.startsWith("label:") || f.startsWith("claim:") || f.startsWith("github:"))));
  assert.equal(all(report).some((i) => i.issue === 113), false, "an open issue with only factory:rejected is not in the factory");
});

test("github: an unreadable GitHub is n/a for that repo, not an error", opts, (t) => {
  const db = newDb(t);
  load(db, input("v2").events);
  const f = path.join(tmp, "empty-gh.input.json");
  fs.writeFileSync(f, JSON.stringify({ github: {} }));
  const out = json(cli(db, ["--at", "2026-10-10T12:00:00Z", "--format", "json"], { FS_FIXTURE: f }));
  assert.match(out.repos[0].coverage.notes.join(" "), /GitHub not read for this repo/);
  assert.ok(out.repos[0].issues.length > 3);
});

// ---------------------------------------------------------------- the CLI

test("source: new is the default and silent; old and shadow warn once and read the view; anything else exits 2", opts, (t) => {
  const db = newDb(t);
  load(db, [claim(1, `${D}09:00:00.000Z`)]);
  const base = json(cli(db, AT));
  for (const args of [[...AT, "--source", "new"], [...AT, "--source=new"]]) {
    const r = cli(db, args);
    assert.equal(r.stderr, "");
    assert.deepEqual(JSON.parse(r.stdout), base);
  }
  assert.equal(cli(db, AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "new" }).stderr, "");
  const eventsDir = path.join(tmp, "events");
  for (const [args, env] of [[[...AT, "--source", "old"], {}], [[...AT, "--source=shadow"], {}], [AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "shadow" }]]) {
    const r = cli(db, args, { CALLUM_EVENTS_DIR: eventsDir, ...env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, /retired/);
    assert.match(r.stderr, /factory\.issue_state/);
    assert.deepEqual(JSON.parse(r.stdout), base);
    assert.equal(r.calls.every((c) => c.factory), true);
  }
  assert.equal(fs.existsSync(eventsDir), false, "no shadow record is written");
  for (const [args, env] of [[[...AT, "--source", "bad"], {}], [AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "nope" }], [[...AT, "--source"], {}]]) {
    const r = cli(db, args, env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: callum-flow-factory-state/);
  }
});

test("the tool reads only the factory database: every call is dev-query --factory and no old table is named", opts, (t) => {
  const db = newDb(t);
  load(db, input("v2").events);
  const r = cli(db, AT);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.length >= 6);
  assert.ok(r.calls.every((c) => c.factory), "no plain dev-query");
  const text = r.calls.map((c) => c.sql).join("\n");
  assert.match(text, /factory\.issue_state_at\(:'at'::timestamptz\)/);
  assert.match(text, /factory\.stuck_rules/);
  assert.doesNotMatch(text, /nomistakes|factory\.events\b|workers_status|run_link/);
  assert.doesNotMatch(text, /\bdata\b/, "named view columns only, never the data jsonb");
  for (const sql of [mod.SQL_META, mod.SQL_STATE, mod.SQL_RULES, mod.SQL_COUNTS, mod.SQL_SKIPPED, mod.SQL_QUEUE_META, mod.SQL_QUEUE]) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i);
  }
  for (const sql of [mod.SQL_STATE, mod.SQL_COUNTS, mod.SQL_SKIPPED, mod.SQL_QUEUE]) assert.match(sql, /:'at'::timestamptz/);
});

test("a database migrated only to 0032 exits 1 naming migration 0033 and the migrate command", opts, (t) => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-at-0032-"));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  for (const f of fs.readdirSync(MIGRATIONS)) if (f < "0033") fs.copyFileSync(path.join(MIGRATIONS, f), path.join(old, f));
  const db = createDb(t, { migrationsDir: old, readerPassword: RPW });
  const r = cli(db, AT);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /0033/);
  assert.match(r.stderr, /factory-db-bootstrap --migrate/);
});

test("CLI: output is byte-identical twice, and without --at the database clock is used and named", opts, (t) => {
  const db = newDb(t);
  load(db, input("v2").events);
  const a = cli(db, AT);
  assert.equal(a.stdout, cli(db, AT).stdout);
  const now = json(cli(db, ["--github", "off", "--format", "json"]));
  assert.equal(now.at_source, "database now()");
  assert.ok(!Number.isNaN(Date.parse(now.at)));
});

test("CLI: text output lists state, holder and PR", opts, (t) => {
  const db = newDb(t);
  load(db, input("v2").events);
  const r = cli(db, ["--at", "2026-10-10T12:00:00Z", "--github", "off"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#102 +reviewing +20m +dev-a +#202 /);
  assert.match(r.stdout.split("\n").find((l) => l.startsWith("issue ")), /^issue +state +in state +holder +pr +stuck +source +detail$/);
  for (const gone of ["implementing", "in pipeline", "ready to merge", "closed without merge"]) assert.ok(!r.stdout.includes(gone), gone);
  assert.match(r.stdout, /Recently ended \(24h\)/);
});

test("CLI: bad arguments exit 2", () => {
  const db = { readerUrl: "postgres://unused" };
  for (const args of [["--bogus"], ["--repo", "nope"], ["--repo"], ["--at", "yesterday"], ["--at", "2026-10-10"], ["--format", "xml"],
    ["--rule", "S1"], ["--rule", "S9=5"], ["--rule", "S1=x"], ["--rule", "S5=5"], ["--rule", "S6=5"], ["--github", "maybe"], ["--source", "xml"]]) {
    const r = cli(db, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: callum-flow-factory-state/);
  }
});

test("CLI: a failing dev-query exits 1, and a missing one too", () => {
  const db = { readerUrl: "postgres://unused" };
  const r = cli(db, ["--at", "2026-10-10T12:00:00Z"], { FS_FAIL: "3" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the factory database through dev-query --factory \(exit 3\)/);
  assert.equal(r.stdout, "");
  assert.equal(cli(db, ["--at", "2026-10-10T12:00:00Z"], { CALLUM_FLOW_DEV_QUERY_BIN: path.join(tmp, "absent") }).status, 1);
});

test("CLI: --help prints usage and exits 0", () => {
  const r = cli({ readerUrl: "postgres://unused" }, ["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: callum-flow-factory-state/);
  assert.match(r.stdout, /--rule <state>=<minutes>/);
});

// ---------------------------------------------------------------- skill, docs, allow list

const SKILL = fs.readFileSync(path.join(ROOT, "plugins", "callum-flow", "skills", "factory-state", "SKILL.md"), "utf8");
const frontmatter = (md) => md.match(/^---\n([\s\S]*?)\n---\n/)[1];

test("factory-state skill: frontmatter, runs the tool, never queries tables or writes", () => {
  const fm = frontmatter(SKILL);
  assert.match(fm, /^name: factory-state$/m);
  assert.match(fm, /right now/);
  assert.match(SKILL, /callum-flow-factory-state/);
  assert.doesNotMatch(SKILL, /AGENTSVIEW_PG_URL|psql\s+["'$-]|dev-query/);
  assert.doesNotMatch(SKILL, /gh (issue|pr) (edit|comment|close|merge)/);
});

test("the historical-number and windowed-report skills route 'right now' to factory-state", () => {
  for (const s of ["query-factory-data", "evaluate-sessions"]) {
    const fm = frontmatter(fs.readFileSync(path.join(ROOT, "plugins", "callum-flow", "skills", s, "SKILL.md"), "utf8"));
    assert.match(fm, /factory-state/, s);
  }
});

test("docs/factory-state.md is written around the view: sections, states, one worked example per fixture", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "factory-state.md"), "utf8");
  for (const st of mod.STATE_ORDER) assert.ok(doc.includes(`\`${st}\``), `state ${st}`);
  for (const gone of ["entered_at", "minutes_in_stage", "| Stage |"]) assert.ok(!doc.includes(gone), `no ${gone}`);
  for (const st of ["queued", "designing", "building", "reviewing", "fixing", "merge-queue", "parked", "waiting", "closed"]) assert.ok(doc.includes(`\`${st}\``), `state ${st}`);
  for (const h of ["Usage", "States", "Lives", "Holder and lease", "`--at`", "Stuck rules", "Output", "Queue", "GitHub flags", "Skipped events", "Worked examples", "The issue_state view"]) {
    assert.ok(new RegExp(`^#{2,3} ${h.replace(/[`]/g, "\\`")}$`, "m").test(doc), `heading ${h}`);
  }
  for (const n of names) assert.ok(doc.includes(`\`${n}\``), `worked example for ${n}`);
  for (const gone of ["nomistakes", "run_link", "S5", "S6", "coverage class", "pipeline only", "old|new|shadow"]) assert.ok(!doc.includes(gone), `no ${gone}`);
});

for (const rel of ["templates/.claude/settings.json", ".claude/settings.json", ".callum-dev/baseline/.claude/settings.json"]) {
  test(`${rel} allows callum-flow-factory-state`, () => {
    const allow = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")).permissions.allow;
    assert.ok(allow.includes("Bash(callum-flow-factory-state)"));
    assert.ok(allow.includes("Bash(callum-flow-factory-state *)"));
  });
}
