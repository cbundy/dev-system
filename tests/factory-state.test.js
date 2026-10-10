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
  assert.match(issue(r, A, 82).flags.join(), /carries 'In development'/);
  assert.match(issue(r, A, 84).flags.join(), /lacks 'In development'/);
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

test("the SQL carries the canonical run_link CTE from docs/metrics.md verbatim", () => {
  const canonical = extractRunLink(fs.readFileSync(path.join(ROOT, "docs", "metrics.md"), "utf8"));
  assert.ok(mod.RUN_LINK.includes(canonical), "RUN_LINK differs from docs/metrics.md");
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
fs.appendFileSync(process.env.FS_LOG, JSON.stringify({ marker: sql.split("\\n")[0], vars }) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.FS_FIXTURE, "utf8"));
const m = sql.split("\\n")[0];
if (m === "-- fs:meta") console.log(JSON.stringify({ now: "2026-10-10T12:00:00.000Z", events: true, runs: true, workers: process.env.FS_WORKERS === "1" }));
else if (m === "-- fs:events") console.log(JSON.stringify(fx.events));
else if (m === "-- fs:runs") console.log(JSON.stringify(fx.runs));
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
