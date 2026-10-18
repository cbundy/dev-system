// Tests for images/base/callum-flow-factory-state (cbundy/dev-system#345): the pure stage rules against
// fixtures modelled on the real failure cases (tests/fixtures/factory-state/*.input.json, with the
// reviewed output beside each as *.expected.json), the CLI against stub dev-query and
// callum-flow-issue-read binaries, and the shipped skill, docs and allow list.
// images/base/test/sections/09-agentsview.sh runs the same tool's SQL against a real PostgreSQL.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "images", "base", "callum-flow-factory-state");
const FIX = path.join(__dirname, "fixtures", "factory-state");
const mod = require(SCRIPT);
const { extractRunLink } = require("./metrics-blocks.js");

const names = fs.readdirSync(FIX).filter((f) => f.endsWith(".input.json")).map((f) => f.replace(".input.json", "")).sort();
const input = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.input.json`), "utf8"));
const expected = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.expected.json`), "utf8"));
const derive = (i, over = {}) => mod.deriveState({
  ...i, at: Date.parse(i.at), rules: { ...mod.DEFAULT_RULES, ...i.rules }, atSource: "--at", github: i.github || null, ...over,
});
const issue = (report, repo, n) => report.repos.find((r) => r.repo === repo).issues.concat(report.repos.find((r) => r.repo === repo).recent).find((i) => i.issue === n);
const A = "acme/widgets";

test("every fixture's output matches its reviewed expected JSON", () => {
  assert.ok(names.length >= 10);
  for (const n of names) assert.deepEqual(JSON.parse(JSON.stringify(derive(input(n)))), expected(n), n);
});

test("closed outside the factory: closed ends the issue whatever came before it", () => {
  const r = derive(input("closed-outside"));
  assert.deepEqual(r.repos[0].issues, [], "no live issue, although #10 still has a running run");
  assert.deepEqual(r.repos[0].recent.map((i) => [i.issue, i.stage]), [[10, "closed without merge"], [11, "closed without merge"], [12, "closed without merge"], [14, "closed without merge"]]);
  assert.match(issue(r, A, 14).detail, /abandoned/, "abandoned is not merged even though a run's PR merged");
  assert.equal(issue(r, A, 13), undefined, "closed more than 24 h ago leaves the view");
});

test("missing run_started: the mirror run places the issue and follows the run row", () => {
  const r = derive(input("missing-run-started"));
  assert.deepEqual([20, 21, 22].map((n) => issue(r, A, n).stage), ["in pipeline", "ready to merge", "merged"]);
  assert.equal(issue(r, A, 21).pr, 121);
  assert.equal(issue(r, A, 20).source, "mirror");
});

test("replayed events: a failed after merged or closed neither reopens nor hints", () => {
  const r = derive(input("replayed-events"));
  assert.equal(issue(r, A, 30).stage, "merged");
  assert.equal(issue(r, A, 31).stage, "closed without merge");
  assert.equal(issue(r, A, 32).stage, "merged");
  assert.equal(issue(r, A, 32).hint, null);
  assert.deepEqual(r.repos[0].issues.map((i) => i.issue), [32], "merged stays visible until GitHub or the sweep closes it");
});

test("implementer_routed (#506) is a delegation decision: implementing, and a new life after abandoned", () => {
  const e = (issue, ts, state, note = null) => ({ repo: A, device: "dev-a", ts, state, issue, run_id: null, branch: null, pr: null, note, actor: "agent" });
  const r = derive({
    at: "2026-10-10T12:00:00.000Z", repos: [], runs: [], workers: { available: false, reason: "test" },
    events: [
      e(90, "2026-10-10T11:00:00.000Z", "claimed", "lease: 120"),
      e(90, "2026-10-10T11:10:00.000Z", "implementer_routed", "model=opus reason=hash bucket=12 pct=50"),
      e(91, "2026-10-10T09:00:00.000Z", "claimed"),
      e(91, "2026-10-10T09:30:00.000Z", "abandoned"),
      e(91, "2026-10-10T11:00:00.000Z", "implementer_routed", "model=sonnet reason=hash bucket=70 pct=50"),
    ],
  });
  assert.equal(issue(r, A, 90).stage, "implementing", "routed after a live claim");
  assert.equal(issue(r, A, 91).stage, "implementing", "routed after abandoned starts a new life");
});

test("loop events (the factory loop's bookkeeping, D-09) never derive anything about an issue", () => {
  const e = (issue, ts, state, extra = {}) => ({ repo: A, device: "dev-a", ts, state, issue, run_id: null, branch: null, pr: null, note: null, actor: "agent", ...extra });
  const loop = (issue, ts, note) => e(issue, ts, "loop", { run_id: "rL", pr: 900 + issue, note });
  const run = (id, issue, status, ts) => ({ id, repo: A, device: "dev-a", branch: `feat/issue-${issue}-x`, status, pr_url: null, pr_state: null, issue, awaiting_agent_since: null, created_at: ts, updated_at: ts });
  const r = derive({
    at: "2026-10-10T12:00:00.000Z", repos: [], workers: { available: false, reason: "test" },
    runs: [run("r97", 97, "failed", "2026-10-10T08:00:00.000Z")],
    events: [
      e(95, "2026-10-10T11:00:00.000Z", "claimed", { note: "lease: 120" }),
      loop(95, "2026-10-10T11:30:00.000Z", "kind=spawn key=design:95:1 status=running"),
      loop(96, "2026-10-10T11:00:00.000Z", "kind=judge key=judge:96 status=done"),
      loop(97, "2026-10-10T11:00:00.000Z", "kind=tell key=tell:97 status=done"),
      e(98, "2026-10-10T09:00:00.000Z", "claimed"),
      e(98, "2026-10-10T10:00:00.000Z", "abandoned"),
      loop(98, "2026-10-10T11:00:00.000Z", "kind=spawn key=fix:98 status=done"),
    ],
  });
  const d95 = issue(r, A, 95);
  assert.deepEqual([d95.stage, d95.entered_at, d95.run, d95.pr], ["designing", "2026-10-10T11:00:00.000Z", null, null], "a loop event sets no stage, run or PR");
  assert.equal(issue(r, A, 96), undefined, "an issue with only loop events is not placed");
  assert.equal(issue(r, A, 97), undefined, "a loop event does not bring a pipeline-only history into view");
  assert.equal(issue(r, A, 98).stage, "closed without merge", "a loop event after abandoned is no new life");
  assert.equal(r.repos[0].coverage.events, 7, "loop events still count as the factory at work");
});

test("superseded run: an abandon is final only until a new life starts; superseded is never a stage", () => {
  const r = derive(input("superseded-run"));
  const st = (n) => issue(r, A, n);
  assert.equal(st(80).stage, "merged");
  assert.equal(st(80).run, "r80b");
  assert.equal(st(80).pr, 180);
  assert.equal(st(81).stage, "closed without merge", "replays on the abandoned run do not reopen it");
  assert.equal(st(82).stage, "queued");
  assert.equal(st(83).stage, "closed without merge", "a run created before the abandon is not a new life");
  assert.equal(st(84).stage, "in pipeline");
  assert.equal(st(85).hint.startsWith("event-only: run_started"), true);
  assert.equal(st(86).stage, "parked");
  assert.equal(st(86).run, "r86b");
  assert.equal(st(87).stage, "implementing", "a superseded run is excluded from latest-run selection");
  for (const i of r.repos[0].issues.concat(r.repos[0].recent)) assert.doesNotMatch(`${i.stage} ${i.detail}`, /superseded(?! by)/);
});

test("pipeline only: a repo with runs and no events is labelled, and the running run is shown", () => {
  const r = derive(input("pipeline-only"));
  const repo = r.repos[0];
  assert.equal(repo.coverage.class, "pipeline only");
  assert.match(repo.coverage.notes[0], /not necessarily idle/);
  assert.deepEqual(repo.issues.map((i) => [i.issue, i.stage]), [[5, "in pipeline"], [6, "parked"]]);
  assert.deepEqual(repo.other_runs.map((o) => o.run), ["g4"]);
});

test("split parent and parked trip S1 and S3", () => {
  assert.deepEqual(derive(input("split-parent")).stuck.map((s) => [s.issue, s.rule]), [[40, "S1"]]);
  assert.deepEqual(derive(input("parked")).stuck.map((s) => [s.issue, s.rule]), [[50, "S3"]]);
});

test("S2, S4 and S5 trip, and --rule thresholds move them", () => {
  const i = input("stuck-rules");
  assert.deepEqual(derive(i).stuck.map((s) => [s.issue, s.rule]), [[70, "S2"], [71, "S4"], [72, "S5"], [73, "S2"]]);
  const loose = derive(i, { rules: { ...mod.DEFAULT_RULES, S2: 500, S4: 500, S5: 500 } });
  assert.deepEqual(loose.stuck, []);
  assert.equal(loose.rules.S2, 500);
});

test("point in time: before the run finished it is in pipeline and approximate", () => {
  const early = derive(input("point-in-time-early"));
  assert.equal(issue(early, A, 60).stage, "in pipeline");
  assert.equal(issue(early, A, 60).approximate, true);
  assert.ok(early.approximate);
  const late = derive(input("point-in-time-late"));
  assert.equal(issue(late, A, 60).stage, "ready to merge");
  assert.equal(issue(late, A, 60).approximate, false);
  assert.equal(late.approximate, null);
});

test("github: closure beats events, labels and claim holders are cross-checked, labelled issues unknown to the database appear", () => {
  const r = derive(input("github"));
  assert.equal(issue(r, A, 80).stage, "closed without merge");
  assert.equal(issue(r, A, 80).source, "github");
  assert.match(issue(r, A, 82).flags.join(), /queued, but the issue has no 'ready' label/);
  assert.deepEqual(issue(r, A, 84).flags, [], "a claim needs no label (In development is gone, v2 SPEC 3.6)");
  assert.match(issue(r, A, 81).flags.join(), /dev-b/);
  assert.match(issue(r, A, 86).flags.join(), /could not be read/);
  assert.deepEqual([90, 91].map((n) => issue(r, A, n).stage), ["queued", "implementing"]);
  assert.equal(issue(r, A, 92), undefined, "an unrelated open issue is not in the factory");
  assert.equal(issue(r, A, 83).stage, "merged", "merged but still open stays visible");
});

test("a requested repo with no data is listed as coverage none", () => {
  const r = derive({ ...input("split-parent"), repos: ["empty/repo"] });
  assert.equal(r.repos.find((x) => x.repo === "empty/repo").coverage.class, "none");
});

test("determinism: shuffled input rows give the identical report", () => {
  for (const n of names) {
    const i = input(n);
    const shuffled = { ...i, events: [...i.events].reverse(), runs: [...i.runs].reverse() };
    assert.equal(JSON.stringify(derive(shuffled)), JSON.stringify(derive(i)), n);
  }
});

test("the SQL carries the canonical run_link CTE from docs/factory-state.md verbatim", () => {
  const canonical = extractRunLink(fs.readFileSync(path.join(ROOT, "docs", "factory-state.md"), "utf8"));
  assert.ok(mod.RUN_LINK.includes(canonical), "RUN_LINK differs from docs/factory-state.md");
  assert.ok(mod.SQL_RUNS.includes(canonical));
});

test("every query is read-only SQL bounded by --at", () => {
  for (const sql of [mod.SQL_EVENTS, mod.SQL_RUNS]) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i);
    assert.match(sql, /<= :'at'::timestamptz/);
  }
});

// ---------------------------------------------------------------- CLI against stubs

let tmp;
let devQuery;
let issueRead;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-state-test-"));
  devQuery = path.join(tmp, "dev-query");
  // answers by the `-- fs:<name>` marker on the SQL's first line, from the fixture in FS_FIXTURE
  fs.writeFileSync(devQuery, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
if (process.env.FS_FAIL) { console.error("psql: connection refused"); process.exit(Number(process.env.FS_FAIL)); }
const sql = a[a.indexOf("-c") + 1];
const vars = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === "-v" ? [x.split(/=(.*)/s).slice(0, 2)] : [])));
fs.appendFileSync(process.env.FS_LOG, JSON.stringify({ marker: sql.split("\\n")[0], vars, factory: a.includes("--factory"), sql }) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.FS_FIXTURE, "utf8"));
const m = sql.split("\\n")[0];
if (m === "-- fs:meta") console.log(JSON.stringify({ now: "2026-10-10T12:00:00.000Z", events: true, runs: process.env.FS_NORUNS !== "1", workers: process.env.FS_WORKERS === "1" }));
else if (m === "-- fs:events") console.log(JSON.stringify(fx.events));
else if (m === "-- fs:event_log") {
  if (process.env.FS_NEW_FAIL) { console.error("psql: no factory database"); process.exit(Number(process.env.FS_NEW_FAIL)); }
  console.log(JSON.stringify(process.env.FS_EVENT_LOG ? JSON.parse(fs.readFileSync(process.env.FS_EVENT_LOG, "utf8")) : fx.event_log));
}
else if (m === "-- fs:runs" && process.env.FS_NORUNS !== "1") console.log(JSON.stringify(fx.runs));
else process.exit(9);
`, { mode: 0o755 });
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
});

function cli(args, env = {}, fixture = "missing-run-started") {
  const log = path.join(tmp, "calls.log");
  fs.rmSync(log, { force: true });
  fs.writeFileSync(log, "");
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, CALLUM_FLOW_DEV_QUERY_BIN: devQuery, CALLUM_FLOW_ISSUE_READ_BIN: issueRead,
      CALLUM_FLOW_FACTORY_STATE_SOURCE: "old", CALLUM_EVENTS_DIR: path.join(tmp, "events"),
      FS_FIXTURE: path.join(FIX, `${fixture}.input.json`), FS_LOG: log, ...env,
    },
  });
  return { ...r, calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("CLI: json output equals the pure derivation, passes --at and --repo to the queries, and is byte-identical twice", () => {
  const args = ["--at", "2026-10-10T12:00:00Z", "--repo", "Acme/Widgets", "--format", "json", "--github", "off"];
  const a = cli(args);
  const b = cli(args);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  const want = JSON.parse(JSON.stringify(derive({ ...input("missing-run-started"), repos: [A] })));
  assert.deepEqual(JSON.parse(a.stdout), want);
  assert.deepEqual(a.calls.filter((c) => c.marker !== "-- fs:meta").map((c) => c.vars), [
    { at: "2026-10-10T12:00:00.000Z", repos: A }, { at: "2026-10-10T12:00:00.000Z", repos: A },
  ]);
});

test("CLI: without --at the database clock is used and named", () => {
  const r = cli(["--format", "json", "--github", "off"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.at, "2026-10-10T12:00:00.000Z");
  assert.equal(out.at_source, "database now()");
});

test("CLI: github facts come from callum-flow-issue-read and match the pure derivation", () => {
  const r = cli(["--at", "2026-10-10T12:00:00Z", "--format", "json"], {}, "github");
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(JSON.stringify(derive(input("github"))));
  assert.deepEqual(JSON.parse(r.stdout), want);
});

test("CLI: an unreadable GitHub is n/a for that repo, not an error", () => {
  const r = cli(["--at", "2026-10-10T12:00:00Z", "--format", "json"], {}, "missing-run-started");
  assert.equal(r.status, 0, r.stderr);
  const repo = JSON.parse(r.stdout).repos[0];
  assert.match(repo.coverage.notes.join(" "), /GitHub not read for this repo/);
  assert.equal(repo.issues.length, 3);
});

test("CLI: a missing factory.workers_status is n/a with the reason and exit 0; an existing one is named", () => {
  const r = cli(["--at", "2026-10-10T12:00:00Z", "--github", "off"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Workers\nn\/a: factory\.workers_status does not exist/);
  const s = cli(["--at", "2026-10-10T12:00:00Z", "--github", "off", "--format", "json"], { FS_WORKERS: "1" });
  assert.match(JSON.parse(s.stdout).workers["n/a"], /does not read it yet/);
});

test("CLI: nomistakes.runs is optional: missing, it is n/a with the reason, no run places an issue, and the exit is 0", () => {
  const r = cli(["--at", "2026-10-10T12:00:00Z", "--github", "off", "--format", "json"], { FS_NORUNS: "1" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.runs, { "n/a": "nomistakes.runs does not exist in the database" });
  assert.equal(r.calls.some((c) => c.marker === "-- fs:runs"), false, "the runs are not queried");
  assert.deepEqual(out.repos[0].issues.map((i) => [i.issue, i.stage, i.run]), [[20, "implementing", null], [21, "implementing", null], [22, "implementing", null]]);
  assert.equal(JSON.parse(cli(["--at", "2026-10-10T12:00:00Z", "--github", "off", "--format", "json"]).stdout).runs, "read");
  const text = cli(["--at", "2026-10-10T12:00:00Z", "--github", "off"], { FS_NORUNS: "1" });
  assert.match(text.stdout, /\nPipeline runs: n\/a: nomistakes\.runs does not exist in the database\n/);
});

test("CLI: text output is stable and lists stage, holder, run and PR", () => {
  const r = cli(["--at", "2026-10-10T12:00:00Z", "--github", "off"]);
  assert.match(r.stdout, /#21 +ready to merge +10m +dev-a +r21 +#121 /);
});

test("CLI: bad arguments exit 2", () => {
  for (const args of [["--bogus"], ["--repo", "nope"], ["--repo"], ["--at", "yesterday"], ["--at", "2026-10-10"], ["--format", "xml"],
    ["--rule", "S1"], ["--rule", "S9=5"], ["--rule", "S1=x"], ["--rule", "S6=5"], ["--github", "maybe"]]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: callum-flow-factory-state/);
  }
});

test("CLI: a failing dev-query exits 1, and a missing one too", () => {
  const r = cli(["--at", "2026-10-10T12:00:00Z"], { FS_FAIL: "3" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the fleet database/);
  assert.equal(r.stdout, "");
  const none = cli(["--at", "2026-10-10T12:00:00Z"], { CALLUM_FLOW_DEV_QUERY_BIN: path.join(tmp, "absent") });
  assert.equal(none.status, 1);
});

test("CLI: --help prints usage and exits 0", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: callum-flow-factory-state/);
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

test("docs/factory-state.md defines the stages, rules and one worked example per fixture", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "factory-state.md"), "utf8");
  for (const st of mod.STAGES) assert.ok(doc.includes(`\`${st}\``), `stage ${st}`);
  for (const r of ["S1", "S2", "S3", "S4", "S5", "S6"]) assert.ok(doc.includes(r), r);
  for (const n of names) assert.ok(doc.includes(`\`${n}\``), `worked example for ${n}`);
});

for (const rel of ["templates/.claude/settings.json", ".claude/settings.json", ".callum-dev/baseline/.claude/settings.json"]) {
  test(`${rel} allows callum-flow-factory-state`, () => {
    const allow = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")).permissions.allow;
    assert.ok(allow.includes("Bash(callum-flow-factory-state)"));
    assert.ok(allow.includes("Bash(callum-flow-factory-state *)"));
  });
}

test("lapsed claim (#465): a claim only counts as designing while its lease is live", () => {
  const r = derive(input("lapsed-claim"));
  const stage = (n) => issue(r, A, n).stage;
  assert.deepEqual([1, 5].map(stage), ["queued", "queued"], "unrenewed claims lapse: legacy 120 min default, and a `lease: 30` note");
  assert.equal(issue(r, A, 1).detail, "claim lapsed at 2026-10-12T02:00:00.000Z");
  assert.equal(issue(r, A, 5).detail, "claim lapsed at 2026-10-12T06:50:00.000Z");
  assert.deepEqual([2, 3, 4].map(stage), ["designing", "designing", "designing"], "fresh, renewed, and briefed-then-renewed claims stay live");
  assert.equal(stage(6), "closed without merge", "renewed after closed does not reopen");
  assert.equal(stage(7), "implementing", "housekeeping noise after delegated changes nothing");
  assert.equal(stage(8), "in pipeline", "a running run is not a claim");
  const all = r.repos[0].issues.map((i) => i.stage);
  assert.equal(all.filter((s) => s === "designing").length, 3);
});

test("factory loop v2 (v2 SPEC 3.6, 7.3): the newest transition of the current life places the issue, above the mirror's runs", () => {
  const r = derive(input("v2"));
  const st = (n) => issue(r, A, n);
  assert.deepEqual([st(100).stage, st(100).source, st(100).run, st(100).detail], ["implementing", "event", null, "v2 building, step build, attempt 1"], "a running v1 run no longer sets the stage");
  assert.equal(st(100).entered_at, "2026-10-10T11:20:00.000Z", "time in stage from the record's since");
  assert.deepEqual(st(100).v2, { state: "building", step: "build", attempt: 1, life: "t3xq00", seq: 2, why: null });
  assert.deepEqual([st(101).stage, st(101).stuck.rule], ["parked", "S3"], "the stuck rules stay as they are");
  assert.equal(st(102).stage, "in pipeline");
  assert.deepEqual(st(102).flags, ["label: v2 reviewing, but the issue lacks 'factory:reviewing'"]);
  assert.deepEqual([100, 101, 107, 109].map((n) => st(n).flags), [[], [], [], []], "the factory label of its state is all a v2 issue needs");
  assert.equal(st(103).stage, "merged", "closed as merged by its why, with its merged event lost");
  assert.deepEqual([st(104).stage, r.repos[0].recent.map((i) => i.issue)], ["closed without merge", [104]], "a dropped record has ended");
  assert.deepEqual([st(105).stage, st(105).v2], ["queued", null], "ready after a closed record is a new life before any v2 state");
  assert.deepEqual([st(106).stage, st(106).holder, st(106).v2], ["designing", "dev-b", null], "a claim-lost close is another device's issue");
  assert.deepEqual([st(111).stage, st(111).v2, st(111).flags], ["queued", null, []], "a ghost a sweep released shows no v2 state, whatever its last transition's to");
  assert.deepEqual([st(112).stage, st(112).holder, st(112).v2.life, st(112).flags], ["implementing", "dev-b", "t3xq10", []],
    "an older life's claim-lost close, logged later on another device, never hides the live life's view");
  assert.deepEqual([st(107).stage, st(107).lease], ["queued", { until: "2026-10-10T10:00:00.000Z", lapsed: true }]);
  assert.deepEqual([st(109).stage, st(109).lease.lapsed], ["designing", true], "a v2 record keeps its state while its claim lapsed: the loop claims it again");
  assert.deepEqual([st(108).stage, st(108).source], ["in pipeline", "github"], "an open issue with a factory label and no events is listed from the label");
  assert.equal(st(110), undefined, "an open issue with neither a factory label nor ready is not in the factory");
  assert.equal(st(113), undefined, "factory:rejected names no stage: a rejected issue is out of the factory");
  assert.deepEqual(st(100).lease, { until: "2026-10-10T13:50:00.000Z", lapsed: false }, "the lease runs from the newest renewal");
});

test("waiting (the loop's hold on wait conditions): a v2 record or a factory:waiting label gives the waiting stage", () => {
  const r = derive(input("v2-waiting"));
  const st = (n) => issue(r, A, n);
  assert.deepEqual([st(200).stage, st(200).source, st(200).flags], ["waiting", "event", []], "a waiting record with factory:waiting has no label problem");
  assert.equal(st(200).stuck, null, "waiting has no stuck rule, even after more than 24 h");
  assert.deepEqual(r.repos[0].issues.map((i) => i.stage).filter((s) => ["queued", "parked", "waiting"].includes(s)),
    ["queued", "parked", "waiting", "waiting", "waiting", "waiting"], "waiting sorts right after parked");
  assert.match(st(201).flags.join(";"), /label: .*waiting/, "a waiting record that carries factory:parked is a label problem");
  assert.deepEqual([st(204).stage, st(204).source], ["waiting", "github"], "an issue with only a factory:waiting label is waiting from github");
  assert.ok(st(205).flags.some((f) => f.startsWith("claim:")), "another device's claim on a waiting issue trips the claim check");
});

// ---------------------------------------------------------------- the source switch (#898)

// The inverse of the old mapper, for the tests: a factory.events row as the factory.event_log row the
// new store holds for it (docs/factory-events/translator.md), or null when the line makes no new event.
const NEW_TYPE = { reclaimed: "requeued", renewed: "claim_renewed", verdict: "finding_handled" };
const NEW_TYPES = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "images", "base", "factory-event-shapes.json"), "utf8")).current));
const tokens = (note) => Object.fromEntries(String(note || "").split(" ").filter((w) => w.indexOf("=") > 0)
  .map((w) => [w.slice(0, w.indexOf("=")), decodeURIComponent(w.slice(w.indexOf("=") + 1))]).map(([k, v]) => [k, v === "none" ? null : v]));
function toEventLog(r) {
  const type = r.state === "loop" ? (/(^| )kind=passes( |$)/.test(r.note) ? "loop_passes" : "loop_entry") : NEW_TYPE[r.state] || r.state;
  if (!NEW_TYPES.has(type)) return null;
  const o = {
    type, type_version: 1, repo: r.repo, device: r.device, ts: r.ts, issue: r.issue, pr: r.pr === undefined ? null : r.pr, branch: r.branch || null,
    to_state: null, from_state: null, life: null, state_since: null, step: null, attempt: null, seq: null, why: null, reason: null, lease_minutes: null,
  };
  if (r.state === "transition") {
    const f = tokens(r.note);
    Object.assign(o, {
      to_state: f.to, from_state: f.from, life: f.life, step: f.step || null, why: f.why || null,
      attempt: f.attempt === undefined ? null : Number(f.attempt), seq: f.seq === undefined ? null : Number(f.seq),
      state_since: f.since ? new Date(Number(f.since)).toISOString() : null,
    });
  } else if (r.state === "claimed" || r.state === "renewed") {
    const m = /lease: *(\d+)/.exec(r.note || "");
    o.lease_minutes = m ? Number(m[1]) : 120;
  } else if (r.state === "closed" || r.state === "abandoned") o.reason = r.note || null;
  return o;
}
const withNew = (n) => {
  const fx = input(n);
  const f = path.join(tmp, `${n}-new.input.json`);
  fs.writeFileSync(f, JSON.stringify({ ...fx, event_log: fx.events.map(toEventLog).filter(Boolean) }));
  return f;
};
const withEventLog = (n, rows) => {
  const f = path.join(tmp, `${n}.event-log.json`);
  fs.writeFileSync(f, JSON.stringify(rows));
  return f;
};
const shadowRecords = () => {
  const f = path.join(tmp, "events", "factory", ".shadow", "factory-state.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const AT = ["--at", "2026-10-10T12:00:00Z", "--github", "off", "--format", "json"];

test("source: a bad --source or variable exits 2 with the usage; the flag beats the variable; new is the default, old the way back", () => {
  const bad = cli([...AT, "--source", "bad"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid source 'bad' from the --source flag: use one of old, new, shadow/);
  assert.match(bad.stderr, /usage: callum-flow-factory-state/);
  const env = cli(AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "nope" });
  assert.equal(env.status, 2);
  assert.match(env.stderr, /CALLUM_FLOW_FACTORY_STATE_SOURCE/);
  const flag = cli([...AT, "--source", "old"], { CALLUM_FLOW_FACTORY_STATE_SOURCE: "nope" });
  assert.equal(flag.status, 0, flag.stderr);
  assert.equal(flag.calls.some((c) => c.factory), false, "old never reads the factory database");
  const viaEnv = cli(AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "new", FS_FIXTURE: withNew("v2-waiting") });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(viaEnv.calls.some((c) => c.marker === "-- fs:events"), false, "the variable chose new");
  const dflt = cli(AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "", FS_FIXTURE: withNew("v2-waiting") });
  assert.equal(dflt.status, 0, dflt.stderr);
  assert.ok(dflt.calls.some((c) => c.marker === "-- fs:event_log"), "the default reads the new store");
  assert.equal(dflt.calls.some((c) => c.marker === "-- fs:events"), false, "the default does not read old");
  const before = shadowRecords().length;
  cli(AT, { FS_FIXTURE: withNew("v2-waiting") });
  assert.equal(shadowRecords().length, before, "the default writes no shadow record");
  const oldVar = cli(AT, { CALLUM_FLOW_FACTORY_STATE_SOURCE: "old", FS_FIXTURE: withNew("v2-waiting") });
  assert.equal(oldVar.status, 0, oldVar.stderr);
  assert.ok(oldVar.calls.some((c) => c.marker === "-- fs:events"), "the old variable reads old");
  assert.equal(oldVar.calls.some((c) => c.marker === "-- fs:event_log"), false, "the old variable does not read new");
});

test("SQL_EVENT_LOG: named view columns only, never the data jsonb, read-only and bounded by --at", () => {
  assert.doesNotMatch(mod.SQL_EVENT_LOG, /\bdata\b|\*/);
  assert.doesNotMatch(mod.SQL_EVENT_LOG, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i);
  assert.match(mod.SQL_EVENT_LOG, /FROM factory\.event_log/);
  assert.match(mod.SQL_EVENT_LOG, /<= :'at'::timestamptz/);
});

const L = (extra) => ({ repo: A, device: "dev-a", ts: "2026-10-10T11:00:00.000Z", issue: 7, run_id: null, branch: null, pr: null, note: null, actor: "agent", ...extra });
const TRANSITION = "row=T11 life=t3xq00 seq=2 from=queued to=building seqAt=1791631200000 since=1791631200000 step=build attempt=1 why=none";
const PAIRS = [
  ["ready", L({ state: "ready" })],
  ["claimed with a lease", L({ state: "claimed", note: "lease: 30" })],
  ["claimed without one", L({ state: "claimed" })],
  ["renewed", L({ state: "renewed", note: "lease: 45" })],
  ["reclaimed", L({ state: "reclaimed", note: "lease expired" })],
  ["verdict", L({ state: "verdict", note: "CORRECT: r1-2 fixed" })],
  ["loop entry", L({ state: "loop", note: "kind=agent-step key=i7/a status=done" })],
  ["loop passes", L({ state: "loop", note: "kind=passes key=passes:1 status=done" })],
  ["closed", L({ state: "closed", note: "completed" })],
  ["abandoned", L({ state: "abandoned", note: "reason=drop note=gone" })],
  ["merged", L({ state: "merged", pr: 12 })],
  ["transition", L({ state: "transition", pr: 12, branch: "issue-7", note: TRANSITION })],
  ["transition to closed", L({ state: "transition", note: "row=T20 life=t3xq00 seq=9 from=merge-queue to=closed since=none step=none attempt=0 why=merged" })],
];
const NEW_NAME = { reclaimed: "requeued", renewed: "claim_renewed", verdict: "finding_handled" };

test("mapping: the new store's row becomes the common event the old line becomes", () => {
  for (const [name, row] of PAIRS) {
    const log = toEventLog(row);
    const want = mod.mapOldRow(row);
    if (name.startsWith("loop")) assert.equal(want.type, "loop", name);
    assert.deepEqual(mod.mapEventLogRow(log), want, name);
    if (NEW_NAME[row.state]) assert.equal(log.type, NEW_NAME[row.state]);
  }
  assert.deepEqual(mod.mapOldRow(PAIRS[11][1]), {
    type: "transition", repo: A, device: "dev-a", issue: 7, t: Date.parse("2026-10-10T11:00:00.000Z"), pr: 12, branch: "issue-7", run: null,
    to_state: "building", from_state: "queued", life: "t3xq00", state_since: 1791631200000, step: "build", attempt: 1, seq: 2, why: null,
    reason: null, lease_minutes: null,
  });
  assert.equal(mod.mapOldRow(PAIRS[1][1]).lease_minutes, 30);
  assert.equal(mod.mapOldRow(PAIRS[2][1]).lease_minutes, 120, "a claim with no lease note holds the default");
});

test("mapping: new-only types are known and ignored by name, an unknown type or version is refused", () => {
  for (const type of ["gate_run", "wind_down", "reviewed", "intervention", "usage", "untrusted_stripped", "test_weakened", "claim_lost", "shadow_read"]) {
    const m = mod.mapEventLogRow({ ...toEventLog(L({ state: "ready" })), type });
    assert.equal(m.type, type);
  }
  assert.throws(() => mod.mapEventLogRow({ ...toEventLog(L({ state: "ready" })), type: "mystery" }), /unknown factory event: mystery v1/);
  assert.throws(() => mod.mapEventLogRow({ ...toEventLog(L({ state: "ready" })), type: "claimed", type_version: 2 }), /unknown factory event: claimed v2/);
});

test("CLI new: the lease and the stages equal the old path's for the same claims", () => {
  for (const n of ["v2-waiting", "closed-outside", "replayed-events"]) {
    const fx = input(n);
    const file = path.join(tmp, `${n}-new.input.json`);
    fs.writeFileSync(file, JSON.stringify({ ...fx, event_log: fx.events.map(toEventLog).filter(Boolean) }));
    const args = ["--at", fx.at, "--github", "off", "--format", "json"];
    const old = cli([...args, "--source", "old"], {}, n);
    const nu = cli([...args, "--source", "new"], { FS_FIXTURE: file });
    assert.equal(nu.status, 0, nu.stderr);
    assert.deepEqual(mod.normalizeForCompare(JSON.parse(nu.stdout)), mod.normalizeForCompare(JSON.parse(old.stdout)), n);
    assert.ok(nu.calls.filter((c) => c.marker === "-- fs:event_log").every((c) => c.factory), "event_log is read through dev-query --factory");
    assert.equal(nu.calls.some((c) => c.marker === "-- fs:events"), false);
  }
  const fx = input("lapsed-claim");
  const file = path.join(tmp, "lapsed-new.input.json");
  fs.writeFileSync(file, JSON.stringify({ ...fx, event_log: fx.events.map(toEventLog).filter(Boolean) }));
  const lease = (r) => Object.fromEntries(JSON.parse(r.stdout).repos[0].issues.map((i) => [i.issue, i.lease]));
  const args = ["--at", fx.at, "--github", "off", "--format", "json"];
  const a = lease(cli([...args, "--source", "old"], {}, "lapsed-claim"));
  const b = lease(cli([...args, "--source", "new"], { FS_FIXTURE: file }));
  assert.ok(Object.keys(a).length > 3);
  assert.deepEqual(b, a);
});

test("CLI new: an event_log row of an unknown type or version fails with exit 1; shadow prints the old answer and records new_error", () => {
  const fx = input("v2-waiting");
  for (const [bad, msg] of [[{ type: "mystery" }, "unknown factory event: mystery v1"], [{ type_version: 2 }, "unknown factory event: claimed v2"]]) {
    const rows = fx.events.map(toEventLog).filter(Boolean);
    rows.push({ ...rows.find((r) => r.type === "claimed"), ...bad });
    const file = withEventLog("bad", rows);
    const nu = cli([...AT, "--source", "new"], { FS_EVENT_LOG: file }, "v2-waiting");
    assert.equal(nu.status, 1);
    assert.equal(nu.stdout, "");
    assert.ok(nu.stderr.includes(msg), nu.stderr);
    fs.rmSync(path.join(tmp, "events"), { recursive: true, force: true });
    const sh = cli([...AT, "--source", "shadow"], { FS_EVENT_LOG: file }, "v2-waiting");
    const old = cli([...AT, "--source", "old"], {}, "v2-waiting");
    assert.equal(sh.status, 0, sh.stderr);
    assert.equal(sh.stdout, old.stdout, "shadow prints the old answer");
    const rec = shadowRecords();
    assert.equal(rec.length, 1);
    assert.equal(rec[0].tool, "factory-state");
    assert.equal(rec[0].differences, null);
    assert.ok(rec[0].new_error.includes(msg));
  }
});

test("CLI shadow: a matching run records zero differences, a seeded difference is recorded by path; the exit follows the old read", () => {
  const fx = input("v2-waiting");
  const rows = fx.events.map(toEventLog).filter(Boolean);
  fs.rmSync(path.join(tmp, "events"), { recursive: true, force: true });
  const ok = cli(AT, { FS_EVENT_LOG: withEventLog("match", rows), CALLUM_FLOW_FACTORY_STATE_SOURCE: "shadow" }, "v2-waiting");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(shadowRecords().map((r) => [r.differences, r.paths, r.new_error]), [[0, [], null]]);
  assert.equal(ok.stderr, "");
  const seeded = rows.map((r) => (r.type === "transition" && r.issue === 200 ? { ...r, to_state: "parked" } : r));
  assert.notDeepEqual(seeded, rows);
  const diff = cli(AT, { FS_EVENT_LOG: withEventLog("seeded", seeded), CALLUM_FLOW_FACTORY_STATE_SOURCE: "shadow" }, "v2-waiting");
  const old = cli([...AT, "--source", "old"], {}, "v2-waiting");
  assert.equal(diff.status, 0);
  assert.equal(diff.stdout, old.stdout);
  const rec = shadowRecords();
  assert.equal(rec.length, 2);
  assert.ok(rec[1].differences > 0, JSON.stringify(rec[1]));
  assert.match(rec[1].paths[0].path, /^\$\.(repos|stuck)/);
  assert.match(diff.stderr, /shadow: \d+ difference\(s\)/);
  // a new read that fails is a record, not a failure
  const down = cli(AT, { FS_NEW_FAIL: "78", CALLUM_FLOW_FACTORY_STATE_SOURCE: "shadow" }, "v2-waiting");
  assert.equal(down.status, 0);
  assert.equal(down.stdout, old.stdout);
  assert.match(shadowRecords()[2].new_error, /cannot read the factory database/);
  // and a failing old read fails the tool, as before
  const oldDown = cli(AT, { FS_FAIL: "3", CALLUM_FLOW_FACTORY_STATE_SOURCE: "shadow" });
  assert.equal(oldDown.status, 1);
});

test("normalizeForCompare drops only the counts, the v1 run id and an abandoned final's free text", () => {
  const r = derive(input("v2-waiting"));
  const n = mod.normalizeForCompare(r);
  const repo = n.repos[0];
  assert.equal(repo.coverage.events, undefined);
  assert.equal(repo.coverage.last_event_at, undefined);
  assert.ok(repo.coverage.devices.every((d) => d.events === undefined && d.last_event_at === undefined && d.device));
  assert.ok(repo.issues.every((i) => i.run === undefined && i.stage));
  const fake = { repos: [{ coverage: { class: "full", devices: [] }, issues: [{ detail: "abandoned (reason=drop note=x)", stage: "closed without merge", run: "r1" }], recent: [{ detail: "closed (done)" }] }] };
  const m = mod.normalizeForCompare(fake).repos[0];
  assert.equal(m.issues[0].detail, "abandoned");
  assert.equal(m.recent[0].detail, "closed (done)");
});
