// Tests for images/base/callum-flow-evaluate (cbundy/dev-system#258). The script runs as a
// subprocess against the synthetic fixtures in tests/fixtures/evaluate/ (the sqlite database
// is built here from state.sql, so no binary is committed). Every expected number below is
// worked out by hand from those fixtures; see docs/metrics.md for the definitions.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");

const SCRIPT = path.join(__dirname, "..", "images", "base", "callum-flow-evaluate");
const FIX = path.join(__dirname, "fixtures", "evaluate");
const mod = require(SCRIPT);

const WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-08T10:00:00Z", "--until", "2026-10-08T11:00:00Z"];
const NM_EXPORT = path.join(FIX, "nm-export.jsonl");
const TWO_DIR = path.join(FIX, "two-device");
let tmp;
let nmHome;

function buildDb(file, { dropAgentInvocations = false } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(FIX, "state.sql"), "utf8"));
  if (dropAgentInvocations) db.exec("DROP TABLE agent_invocations");
  db.close();
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-test-"));
  nmHome = path.join(tmp, "nm");
  fs.mkdirSync(nmHome);
  buildDb(path.join(nmHome, "state.sqlite"));
});

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: tmp, // not a git checkout: the checkout path comes from the no-mistakes repos row
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      CLAUDE_CONFIG_DIR: path.join(FIX, "claude"),
      CALLUM_EVENTS_DIR: path.join(FIX, "events"),
      NO_MISTAKES_HOME: nmHome,
      CALLUM_FLOW_EVALUATE_SOURCE: "old", // an explicit shadow would write into the fixture's events folder
      ...env,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const json = (args, env) => {
  const r = run([...args, "--format", "json"], env);
  assert.equal(r.status, 0, r.err);
  return JSON.parse(r.out);
};

test("window and source discovery: worktree dir included, lookalike and unrelated dirs excluded", () => {
  const r = json(WINDOW);
  assert.deepEqual(Object.keys(r), mod.TOP_KEYS);
  assert.equal(r.window.since, "2026-10-08T10:00:00.000Z");
  assert.equal(r.window.sessions, 2); // main1 and the --treehouse sibling
  assert.equal(r.window.sub_agents, 2);
  assert.equal(r.window.pipeline_runs, 2);
  const transcripts = r.sources.filter((s) => s.kind === "transcripts").map((s) => path.basename(s.path));
  assert.deepEqual(transcripts, ["-work-repo", "-work-repo--treehouse-pool-1-repo"]);
});

test("turns and tokens: a turn split over 3 lines counts once with its last usage; lines outside the window are dropped", () => {
  const rows = json(WINDOW).spend.rows;
  const orch = rows.find((x) => x.role === "orchestrator");
  // main1 has 7 distinct requestIds in the window (req_A spans 3 lines), the worktree session 1.
  assert.deepEqual(orch, {
    role: "orchestrator", model: "claude-opus-5-5", turns: 8, input: 15, output: 132, cache_read: 2960, cache_creation: 150,
  });
});

test("role attribution: typed sub-agent from meta, unknown without meta, pipeline steps from sqlite", () => {
  const rows = json(WINDOW).spend.rows;
  const by = (role, model) => rows.find((x) => x.role === role && x.model === model);
  assert.deepEqual(by("callum-flow:implementer", "claude-sonnet-5-5"), {
    role: "callum-flow:implementer", model: "claude-sonnet-5-5", turns: 2, input: 6, output: 50, cache_read: 600, cache_creation: 40,
  });
  assert.deepEqual(by("unknown", "claude-haiku-4"), {
    role: "unknown", model: "claude-haiku-4", turns: 1, input: 1, output: 2, cache_read: 3, cache_creation: 4,
  });
  assert.deepEqual(by("pipeline:review", "claude-sonnet-5-5"), {
    role: "pipeline:review", model: "claude-sonnet-5-5", turns: 3, input: 10, output: 20, cache_read: 300, cache_creation: 40,
  });
  assert.deepEqual(by("pipeline:lint", "claude-sonnet-5-5"), {
    role: "pipeline:lint", model: "claude-sonnet-5-5", turns: 1, input: 5, output: 5, cache_read: 50, cache_creation: 0,
  });
  // run3 (outside the window) and the other repo's runX contribute nothing.
  assert.equal(rows.filter((x) => x.role === "pipeline:lint").length, 1);
});

test("spend lists sub-agents that ran on a model other than the one requested", () => {
  assert.deepEqual(json(WINDOW).spend.sub_agent_model_mismatches, [
    { session: "main1", role: "callum-flow:implementer", requested: "opus", actual: ["claude-sonnet-5-5"] },
  ]);
});

test("throughput and lead time follow metrics.md query 1", () => {
  const t = json(WINDOW).throughput;
  assert.equal(t.merged_issues, 2);
  assert.deepEqual(t.issues, [
    { issue: 7, merged_at: "2026-10-08T10:32:00.000Z", ready_source: "event", run_source: "mirror", waiting_for_claim: 600, design: 1800, implementation: 1200, pipeline: 1800, waiting_for_merge: 3720, total: 9120 },
    { issue: 8, merged_at: "2026-10-08T10:50:00.000Z", ready_source: "event", run_source: "mirror", waiting_for_claim: 300, design: 900, implementation: 600, pipeline: 1200, waiting_for_merge: 10800, total: 13800 },
  ]);
  assert.deepEqual(t.lead_time_total_seconds, { median: 11460, max: 13800, issues_with_total: 2 });
});

test("first pass follows query 2, restricted to a first merge_ready in the window", () => {
  // issue 9 green clean, 10 failed before green, 11 fix_requested after green; 7 and 8 went green before the window.
  assert.deepEqual(json(WINDOW).first_pass, { reached_green: 3, first_pass: 2, first_pass_pct: 66.7, setback_issues: [10] });
});

test("review verdict counts by prefix and actor, and the false-positive rate (query 3)", () => {
  const v = json(WINDOW).review;
  assert.equal(v.verdicts, 7); // the 09:00 verdict is outside the window
  assert.deepEqual(v.by_prefix, { CORRECT: 1, WRONG: 2, NIT: 2, ENV: 0, DUP: 2 });
  assert.deepEqual(v.by_actor.adjudicator, { CORRECT: 1, WRONG: 1, NIT: 1, ENV: 0, DUP: 1 });
  assert.deepEqual(v.by_actor.orchestrator, { CORRECT: 0, WRONG: 1, NIT: 1, ENV: 0, DUP: 1 });
  assert.equal(v.false_positive_pct, 66.7); // 2 / (1 + 2)
});

test("adjudicator agreement pairs verdicts by run and finding id", () => {
  // review-1 disagrees (CORRECT vs WRONG), review-2 agrees (NIT, NIT); review-3 and review-4 have no partner.
  assert.deepEqual(json(WINDOW).adjudicator_agreement, {
    pairs: 2, agreed: 1, agreement_pct: 50, unpaired_adjudicator_verdicts: 2,
  });
  const lines = (rows) => rows.map((r) => JSON.stringify({ repo: "acme/widgets", state: "verdict", ts: "2026-10-08T10:00:00Z", run_id: "R", ...r })).join("\n");
  const one = path.join(tmp, "one-pair.jsonl");
  fs.writeFileSync(one, lines([
    { actor: "adjudicator", note: "CORRECT: review-1 x" }, { actor: "agent", note: "WRONG: review-1 y" },
  ]));
  assert.deepEqual(json([...WINDOW, "--events", one]).adjudicator_agreement, {
    pairs: 1, agreed: 0, agreement_pct: 0, unpaired_adjudicator_verdicts: 0,
  });
  const none = path.join(tmp, "no-pairs.jsonl");
  fs.writeFileSync(none, lines([{ actor: "adjudicator", note: "NIT: review-1 x" }]));
  assert.deepEqual(json([...WINDOW, "--events", none]).adjudicator_agreement, {
    pairs: 0, agreed: 0, agreement_pct: "n/a (0 pairs)", unpaired_adjudicator_verdicts: 1,
  });
});

test("test_weakened counts commits per step and splits restored from unrestored", () => {
  const ev = (ts, note) => JSON.stringify({ repo: "acme/widgets", state: "test_weakened", ts, issue: 1, note });
  const file = path.join(tmp, "weakened.jsonl");
  fs.writeFileSync(file, [
    ev("2026-10-08T10:10:00Z", "step=ci commit=abcdef0 restored=no kinds=removed-assertion files=tests/a.test.js"),
    ev("2026-10-08T10:20:00Z", "step=ci commit=abcdef1 restored=yes kinds=skip files=tests/b.test.js"),
    ev("2026-10-08T10:30:00Z", "step=none commit=abcdef2 restored=no kinds=warn-only files=t/c.sh"),
    ev("2026-10-08T10:40:00Z", "step=review commit=abcdef3 restored=no kinds=removed-assertion files=t/d.sh"),
    ev("2026-10-08T09:00:00Z", "step=lint commit=abcdef4 restored=no kinds=only files=t/e.js"), // before the window
  ].join("\n"));
  const r = json([...WINDOW, "--events", file]);
  assert.deepEqual(r.test_weakened, {
    total: 4, restored: 1, unrestored: 3,
    by_step: [
      { step: "ci", restored: 1, unrestored: 1 },
      { step: "none", restored: 0, unrestored: 1 },
      { step: "review", restored: 0, unrestored: 1 },
    ],
  });
  const md = run([...WINDOW, "--events", file, "--format", "markdown"]).out;
  assert.match(md, /## test_weakened\n\n[^]*\| ci \| 1 \| 1 \|/);
  assert.deepEqual(json(WINDOW).test_weakened, { total: 0, restored: 0, unrestored: 0, by_step: [] });
});

test("waste: each fixture wake gets its kind and category", () => {
  const w = json(WINDOW).waste;
  assert.deepEqual(w.wakes, { "monitor-event": 1, "monitor-timeout": 1, "agent-done": 2, "bash-done": 1, cron: 1, owner: 1 });
  assert.equal(w.wake_turns, 7);
  assert.equal(w.wake_tokens, 3237); // 1155 + 522 + 311 + 881 + 106 + 206 + 56
  // idle: event (522), timeout (311), duplicate done (106), cron (206), bash-done (56); the merge wake acted.
  assert.deepEqual(w.idle_wakes, { count: 5, tokens: 1201 });
  assert.deepEqual(w.re_arms, { count: 1, tokens: 311 }); // only the Monitor relaunch; pgrep is idle but not a re-arm
  // stale: the duplicate completion (task id) and the bash-done naming #7 after its merge.
  assert.deepEqual(w.stale_wakes, { count: 2, tokens: 162 });
  assert.deepEqual(w.repeated_checks, { count: 1, tokens: 522 }); // gh pr checks 5, whitespace-normalised
  assert.deepEqual(w.top_wakes.map((t) => [t.kind, t.tokens]), [
    ["owner", 1155], ["agent-done", 881], ["monitor-event", 522], ["monitor-timeout", 311], ["cron", 206], ["agent-done", 106], ["bash-done", 56],
  ]);
  assert.deepEqual(w.top_wakes[0], {
    session: "main1", ts: "2026-10-08T10:00:00Z", kind: "owner", turns: 1, tokens: 1155, idle: false, re_arm: false, stale: false,
  });
});

test("classifyWake and buildTurns, called directly", () => {
  assert.equal(mod.classifyWake({ type: "user", message: { content: [{ type: "tool_result" }] } }), null);
  assert.equal(mod.classifyWake({ type: "assistant" }), null);
  assert.equal(mod.classifyWake({ type: "user", origin: { kind: "human" }, message: { content: "hi" } }).kind, "owner");
  const n = (summary, status = "") => ({
    type: "user", origin: { kind: "task-notification" },
    message: { content: `<task-notification><task-id>t</task-id>${status}<summary>${summary}</summary></task-notification>` },
  });
  assert.equal(mod.classifyWake(n("Monitor event: x")).kind, "monitor-event");
  assert.equal(mod.classifyWake(n('Monitor "x" timed out')).kind, "monitor-timeout");
  assert.equal(mod.classifyWake(n("3 background shell command tasks didn't finish")).kind, "monitor-timeout");
  assert.equal(mod.classifyWake(n('Agent "x" finished', "<status>completed</status>")).kind, "agent-done");
  assert.equal(mod.classifyWake(n('Background command "x" completed')).kind, "bash-done");
  assert.equal(mod.classifyWake({ type: "system", subtype: "scheduled_task_fire", prompt: "p" }).kind, "cron");
  const win = { since: 0, until: Date.parse("2030-01-01") };
  const line = (n, out) => ({ type: "assistant", timestamp: "2026-01-01T00:00:0" + n + "Z", requestId: "r", message: { usage: { output_tokens: out } } });
  const { turns } = mod.buildTurns([line(1, 5), line(2, 5), line(3, 9)], win);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].usage.output, 9);
});

const DEVICE = { DEV_MACHINE_NAME: "laptop-test" };
// Hand-computed from state.sql for the window 10:00-11:00 on acme/widgets (run1, run2; run3 is
// before the window and runX is another repo):
//  gates: ci sr2+sr4 both completed with no auto_fix round = 2/2; review sr1 has an auto_fix
//  round and sr3 failed = 0/2; sr7 (test) is skipped and left out.
//  fix_rounds: round b is the only auto_fix round in the window (run1, review); max_per_run 1.
//  tokens: i1 sonnet/review, i2 has no model (unknown) / review, i3 sonnet/fix; i4 is run3.
//  parked: run1 90 s + run2 30 s; run2 is still awaiting an agent.
const WIDGETS_GATES = [
  { step: "ci", steps: 2, first_pass: 2, first_pass_rate: 100 },
  { step: "review", steps: 2, first_pass: 0, first_pass_rate: 0 },
];
const WIDGETS_FIX = { total: 1, max_per_run: 1, by_step: { ci: 0, review: 1, test: 0 } };
const WIDGETS_TOKENS = [
  { model: "claude-sonnet-5-5", purpose: "fix", invocations: 1, input: 5, output: 5, cache_read: 50, cache_creation: 0 },
  { model: "claude-sonnet-5-5", purpose: "review", invocations: 1, input: 10, output: 20, cache_read: 300, cache_creation: 40 },
  { model: "unknown", purpose: "review", invocations: 1, input: 0, output: 0, cache_read: 0, cache_creation: 0 },
];
const WIDGETS_PARKED = { runs_parked: 2, total_seconds: 120, median_seconds: 60, max_seconds: 90, awaiting_agent: 1 };

test("pipeline: runs by status, review rounds, fallback invocations, ci duration and the gate numbers", () => {
  const p = json(WINDOW, DEVICE).pipeline;
  assert.deepEqual(p, {
    runs: 2,
    unlinked_runs: 0, // run1 and run2 are on issue-<N> branches
    by_status: { completed: 1, failed: 1 },
    review_rounds: { total: 3, max: 2, per_run: [{ run: "run1", review_rounds: 2 }, { run: "run2", review_rounds: 1 }] },
    fallback_invocations: { count: 1, of: 3 },
    ci_duration_seconds: { median: 210, max: 300, steps: 2 },
    gates: WIDGETS_GATES,
    fix_rounds: WIDGETS_FIX,
    tokens_by_model_purpose: WIDGETS_TOKENS,
    parked: WIDGETS_PARKED,
    by_device: [{ device: "laptop-test", runs: 2, gates: WIDGETS_GATES, fix_rounds: WIDGETS_FIX, tokens_by_model_purpose: WIDGETS_TOKENS, parked: WIDGETS_PARKED }],
    by_repo: {
      scope: "every repo in the source, not limited to --repo",
      rows: [
        // runX (acme/other) is in the window: lint sr8 completed with no round; i5 opus/review; 5 s parked
        {
          repo: "acme/other", runs: 1,
          gates: [{ step: "lint", steps: 1, first_pass: 1, first_pass_rate: 100 }],
          fix_rounds: { total: 0, max_per_run: 0, by_step: { lint: 0 } },
          tokens_by_model_purpose: [{ model: "claude-opus-5-5", purpose: "review", invocations: 1, input: 7, output: 7, cache_read: 7, cache_creation: 7 }],
          parked: { runs_parked: 1, total_seconds: 5, median_seconds: 5, max_seconds: 5, awaiting_agent: 0 },
        },
        { repo: "acme/widgets", runs: 2, gates: WIDGETS_GATES, fix_rounds: WIDGETS_FIX, tokens_by_model_purpose: WIDGETS_TOKENS, parked: WIDGETS_PARKED },
      ],
    },
  });
});

test("window.scope: workspace by default, fleet when the sources are exports; one line in markdown", () => {
  assert.deepEqual(json(WINDOW).window.scope, { pipeline: "workspace", events: "workspace", transcripts: "workspace" });
  assert.deepEqual(json([...WINDOW, "--events", path.join(TWO_DIR, "events.jsonl")]).window.scope, { pipeline: "workspace", events: "fleet", transcripts: "workspace" });
  assert.deepEqual(json([...WINDOW, "--nm-export", NM_EXPORT]).window.scope, { pipeline: "fleet", events: "workspace", transcripts: "workspace" });
  assert.match(run([...WINDOW, "--format", "markdown"]).out, /^Scope: pipeline=workspace events=workspace transcripts=workspace$/m);
  assert.match(run([...WINDOW, "--nm-export", NM_EXPORT, "--format", "markdown"]).out, /^Scope: pipeline=fleet /m);
});

test("missing sources give n/a with a reason and exit 0", () => {
  const missing = json(WINDOW, {
    CALLUM_EVENTS_DIR: path.join(tmp, "no-events"), NO_MISTAKES_HOME: path.join(tmp, "no-nm"), CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude"),
  });
  for (const k of mod.TOP_KEYS.filter((x) => x !== "window" && x !== "sources")) assert.ok(missing[k]["n/a"], `${k} should be n/a`);
  assert.equal(missing.window.pipeline_runs, "n/a");
  assert.equal(missing.sources.length, 3);
  for (const s of missing.sources) {
    assert.equal(s.found, false);
    assert.ok(s["n/a"]);
  }
  // only the events file missing: the other keys still compute
  const noEvents = json(WINDOW, { CALLUM_EVENTS_DIR: path.join(tmp, "no-events") });
  assert.match(noEvents.throughput["n/a"], /file not found/);
  assert.equal(noEvents.pipeline.runs, 2);
  assert.equal(noEvents.waste.wake_turns, 7);
  // no sqlite: there are no repos rows, so no checkout path and no transcripts either, unless named
  const noNm = json([...WINDOW, "--projects-dir", path.join(FIX, "claude", "projects", "-work-repo")], { NO_MISTAKES_HOME: path.join(tmp, "no-nm") });
  assert.match(noNm.pipeline["n/a"], /file not found/);
  assert.equal(noNm.window.sessions, 1);
  assert.equal(noNm.spend.rows.some((x) => x.role.startsWith("pipeline:")), false);
});

test("a sqlite schema without agent_invocations degrades that metric only", () => {
  const home = path.join(tmp, "nm-partial");
  fs.mkdirSync(home);
  buildDb(path.join(home, "state.sqlite"), { dropAgentInvocations: true });
  const r = json(WINDOW, { NO_MISTAKES_HOME: home });
  assert.match(r.pipeline.fallback_invocations["n/a"], /agent_invocations is missing/);
  assert.equal(r.pipeline.runs, 2);
  assert.equal(r.pipeline.review_rounds.total, 3);
  assert.equal(r.spend.rows.some((x) => x.role.startsWith("pipeline:")), false);
  assert.ok(r.sources.some((s) => s.path.endsWith("#agent_invocations") && s["n/a"]));
  // a database without the runs table is n/a for the whole pipeline key
  const bare = path.join(tmp, "nm-bare");
  fs.mkdirSync(bare);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(bare, "state.sqlite"));
  db.exec("CREATE TABLE repos (id TEXT, working_path TEXT, upstream_url TEXT)");
  db.close();
  assert.match(json(WINDOW, { NO_MISTAKES_HOME: bare }).pipeline["n/a"], /runs is missing/);
});

test("an old no-mistakes schema degrades only the metrics that need the missing columns", () => {
  const home = path.join(tmp, "nm-old");
  fs.mkdirSync(home);
  buildDb(path.join(home, "state.sqlite"));
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(home, "state.sqlite"));
  db.exec("ALTER TABLE step_rounds DROP COLUMN trigger_type; ALTER TABLE agent_invocations DROP COLUMN purpose");
  db.close();
  const p = json(WINDOW, { NO_MISTAKES_HOME: home }).pipeline;
  assert.match(p.fix_rounds["n/a"], /step_rounds lacks column\(s\) trigger_type/);
  assert.match(p.gates["n/a"], /step_rounds lacks column\(s\) trigger_type/);
  assert.match(p.tokens_by_model_purpose["n/a"], /agent_invocations lacks column\(s\) purpose/);
  assert.equal(p.runs, 2);
  assert.deepEqual(p.by_status, { completed: 1, failed: 1 });
  assert.equal(p.review_rounds.total, 3);
  assert.deepEqual(p.fallback_invocations, { count: 1, of: 3 });
  assert.deepEqual(p.parked, WIDGETS_PARKED);
  assert.match(p.by_device[0].gates["n/a"], /trigger_type/);
  assert.deepEqual(p.by_device[0].parked, WIDGETS_PARKED);
  // pipeline spend rows still come from the invocations, which only lost `purpose`
  assert.equal(json(WINDOW, { NO_MISTAKES_HOME: home }).spend.rows.some((x) => x.role === "pipeline:review"), true);
});

test("bad arguments exit 2, an unreadable source exits 1", () => {
  for (const args of [[], ["--repo", "x"], ["--repo", "a/b"], [...WINDOW, "--bogus"], [...WINDOW, "--format", "xml"],
    ["--repo", "a/b", "--since", "nope"], ["--repo", "a/b", "--since", "2026-01-02", "--until", "2026-01-01"], ["--repo", "a/b", "--since"]]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.err, /usage:/);
    assert.equal(r.out, "");
  }
  const dirAsEvents = run([...WINDOW, "--events", tmp]);
  assert.equal(dirAsEvents.status, 1);
  assert.match(dirAsEvents.err, /cannot read/);
  const corrupt = path.join(tmp, "corrupt.sqlite");
  fs.writeFileSync(corrupt, "this is not a database, just text padded out to look like one".repeat(10));
  assert.equal(run([...WINDOW, "--nm-state", corrupt]).status, 1);
});

test("output is deterministic, in json and markdown", () => {
  for (const format of ["json", "markdown"]) {
    for (const extra of [[], ["--nm-export", NM_EXPORT]]) {
      const a = run([...WINDOW, ...extra, "--format", format]);
      const b = run([...WINDOW, ...extra, "--format", format]);
      assert.equal(a.status, 0);
      assert.equal(a.out, b.out);
    }
  }
  const md = run([...WINDOW, "--format", "markdown"]).out;
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, mod.TOP_KEYS);
  assert.match(md, /\| orchestrator \| claude-opus-5-5 \| 8 \| 15 \| 132 \| 2960 \| 150 \|/);
});

test("explicit --projects-dir overrides discovery", () => {
  const r = json([...WINDOW, "--projects-dir", path.join(FIX, "claude", "projects", "-work-other")]);
  assert.equal(r.window.sessions, 1);
  assert.equal(r.spend.rows.find((x) => x.role === "orchestrator").input, 500);
});

// ---- two-device fixture (cbundy/dev-system#222): tests/fixtures/evaluate/two-device
// Window 2026-10-09 00:00-12:00Z. Device A merges #1 (ready label 08:00 from the GitHub timeline,
// claimed 08:30, parked 09:20-09:30, merge_ready 09:50, merged 10:10); device B merges #2 (ready
// 08:35, claimed 09:00, merge_ready 09:35, merged 09:40). B logs `usage` from 08:00 and holds
// nothing until 09:00, so it is alive and idle for #1's first wait (08:00-08:30) and again from
// its merge of #2 (09:40) until its last event ages out (10:10), which covers #1's merge wait
// (09:50-10:10). A holds #6 from 03:00, so it is never idle and #2's waits are not flagged. #3 is double-claimed, #4 loses a race, #6 is stuck, #7 was reclaimed.
const TWO = path.join(FIX, "two-device");
const TWO_WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-09T00:00:00Z", "--until", "2026-10-09T12:00:00Z",
  "--events", path.join(TWO, "events.jsonl"), "--ready-times", path.join(TWO, "ready-times.json")];

test("two devices: merges, claims and lost races per device", () => {
  const r = json(TWO_WINDOW);
  assert.deepEqual(r.per_device, [
    { device: "A", merges: 1, claims: 5, claim_lost: 0 },
    { device: "B", merges: 1, claims: 3, claim_lost: 1 },
  ]);
});

test("two devices: double-claim, claim_lost, reclaimed and stuck", () => {
  const c = json(TWO_WINDOW).claims;
  assert.deepEqual(c.double_claims, { count: 1, issues: [{ issue: 3, devices: ["A", "B"], at: "2026-10-09T11:01:00.000Z" }] });
  assert.deepEqual(c.claim_lost, { count: 1, issues: [4] });
  assert.equal(c.reclaimed, 1);
  // #6 silent since 03:30 (8.5h > 2 x 120 min); #3 (59 min) and #4 (35 min) are not; #7 was abandoned after its reclaim.
  assert.deepEqual(c.stuck, {
    count: 1, lease_minutes: 120,
    issues: [{ issue: 6, devices: ["A"], last_event_at: "2026-10-09T03:30:00.000Z", last_state: "delegated", silent_seconds: 30600 }],
  });
});

test("two devices: a claim ended by `closed` is released, so it is not stuck", () => {
  // #6 is stuck in the fixture (claimed 03:00 on A, last event 03:30). The sweep closing it releases the claim.
  const events = path.join(tmp, "two-device-closed.jsonl");
  const closed = { v: 1, ts: "2026-10-09T04:00:00Z", repo: "acme/widgets", device: "A", session_id: null, actor: "sweep", state: "closed", issue: 6, run_id: null, branch: null, pr: null, head: null, note: "not_planned" };
  fs.writeFileSync(events, fs.readFileSync(path.join(TWO, "events.jsonl"), "utf8") + JSON.stringify(closed) + "\n");
  const args = TWO_WINDOW.map((a) => (a === path.join(TWO, "events.jsonl") ? events : a));
  const c = json(args).claims;
  assert.deepEqual(c.stuck, { count: 0, lease_minutes: 120, issues: [] });
});

test("two devices: `superseded` does not release a claim", () => {
  // #6 is stuck in the fixture; a run-scoped `superseded` for it must leave the claim held, unlike `closed`.
  const events = path.join(tmp, "two-device-superseded.jsonl");
  const sup = { v: 1, ts: "2026-10-09T04:00:00Z", repo: "acme/widgets", device: "A", session_id: null, actor: "agent", state: "superseded", issue: 6, run_id: "r6a", branch: null, pr: null, head: null, note: "by feat/issue-6-x-v2" };
  fs.writeFileSync(events, fs.readFileSync(path.join(TWO, "events.jsonl"), "utf8") + JSON.stringify(sup) + "\n");
  const args = TWO_WINDOW.map((a) => (a === path.join(TWO, "events.jsonl") ? events : a));
  const c = json(args).claims;
  assert.equal(c.stuck.count, 1);
  assert.equal(c.stuck.issues[0].issue, 6);
});

test("two devices: a `loop` event is bookkeeping, not progress, so #6 stays stuck", () => {
  // #6 is stuck in the fixture (last event 03:30); the factory loop logging an agent end and a wake
  // for it later (D-09) must neither unstick it nor become its last state.
  const events = path.join(tmp, "two-device-loop.jsonl");
  const loop = (ts, note) => ({ v: 2, ts, repo: "acme/widgets", device: "A", session_id: null, actor: "agent", state: "loop", issue: 6, run_id: "r6a", branch: null, pr: null, head: null, note });
  fs.writeFileSync(events, fs.readFileSync(path.join(TWO, "events.jsonl"), "utf8") +
    [loop("2026-10-09T11:00:00Z", "kind=spawn key=fix:r6a status=done"), loop("2026-10-09T11:30:00Z", "kind=tell key=tell:escalate:6 status=running")].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const args = TWO_WINDOW.map((a) => (a === path.join(TWO, "events.jsonl") ? events : a));
  const c = json(args).claims;
  assert.deepEqual(c.stuck.issues, [{ issue: 6, devices: ["A"], last_event_at: "2026-10-09T03:30:00.000Z", last_state: "delegated", silent_seconds: 30600 }]);
});

test("two devices: the stuck threshold follows CALLUM_FLOW_LEASE_MINUTES", () => {
  // a 10 minute lease makes everything silent for over 20 minutes stuck: #3 (59m) and #4 (35m) join #6
  const c = json(TWO_WINDOW, { CALLUM_FLOW_LEASE_MINUTES: "10" }).claims;
  assert.deepEqual(c.stuck.issues.map((i) => i.issue), [3, 4, 6]);
});

test("two devices: ready times come from the GitHub timeline (last label at or before the claim)", () => {
  const t = json(TWO_WINDOW).throughput;
  assert.deepEqual(t.issues, [
    { issue: 2, merged_at: "2026-10-09T09:40:00.000Z", ready_source: "github", run_source: "mirror", waiting_for_claim: 1500, design: 900, implementation: 300, pipeline: 900, waiting_for_merge: 300, total: 3900 },
    { issue: 1, merged_at: "2026-10-09T10:10:00.000Z", ready_source: "github", run_source: "mirror", waiting_for_claim: 1800, design: 900, implementation: 900, pipeline: 3000, waiting_for_merge: 1200, total: 7800 },
  ]);
  assert.deepEqual(t.lead_time_total_seconds, { median: 5850, max: 7800, issues_with_total: 2 });
  assert.equal(t.issues_without_ready, 0);
  // without the file there is no `ready` event, so the lead-time stages that need it are null
  const bare = json(TWO_WINDOW.slice(0, -2)).throughput;
  assert.equal(bare.issues_without_ready, 2);
  assert.deepEqual(bare.issues.map((i) => [i.ready_source, i.total]), [[null, null], [null, null]]);
});

test("two devices: the waiting split equals the hand-computed seconds", () => {
  const w = json(TWO_WINDOW).waiting;
  // #1: dispatcher 08:00-08:30 + 09:20-09:30 + 09:50-10:10 = 3600s, of which B was idle for 08:00-08:30
  //     and 09:50-10:10 = 3000s; pipeline 09:00-09:50 minus the 600s parked = 2400s; total 7800s; agent 1800s.
  // #2: dispatcher 08:35-09:00 + 09:35-09:40 = 1800s (A holds #6, so never idle); pipeline 900s; total 3900s; agent 1200s.
  assert.deepEqual(w.issues, [
    { issue: 1, device: "A", ready_source: "github", pipeline_bound: 2400, dispatcher_bound: 3600, dispatcher_bound_other_idle: 3000, agent_work: 1800, total: 7800 },
    { issue: 2, device: "B", ready_source: "github", pipeline_bound: 900, dispatcher_bound: 1800, dispatcher_bound_other_idle: 0, agent_work: 1200, total: 3900 },
  ]);
  assert.deepEqual(w.totals, { pipeline_bound: 3300, dispatcher_bound: 5400, dispatcher_bound_other_idle: 3000, agent_work: 3000, total: 11700 });
  assert.equal(w.wait_seconds, 8700);
  assert.equal(w.other_idle_pct_of_wait, 34.5);
  assert.equal(w.decision, "gate");
});

test("waiting split: dispatcher wait with another device idle over 50% of wait means B", () => {
  const file = path.join(tmp, "b-case.jsonl");
  const ev = (t, device, state, issue) => JSON.stringify({ ts: `2026-10-09T${t}Z`, repo: "acme/widgets", device, state, issue, note: null });
  fs.writeFileSync(file, [
    ev("08:00:00", "A", "ready", 5), ev("08:00:00", "B", "usage", null), ev("08:25:00", "B", "usage", null),
    ev("08:30:00", "A", "claimed", 5), ev("08:50:00", "B", "usage", null), ev("09:00:00", "A", "merged", 5),
  ].join("\n") + "\n");
  const w = json(["--repo", "acme/widgets", "--since", "2026-10-09T00:00:00Z", "--until", "2026-10-09T12:00:00Z", "--events", file]).waiting;
  assert.deepEqual(w.issues, [
    { issue: 5, device: "A", ready_source: "event", pipeline_bound: 0, dispatcher_bound: 1800, dispatcher_bound_other_idle: 1800, agent_work: 1800, total: 3600 },
  ]);
  assert.equal(w.other_idle_pct_of_wait, 100);
  assert.equal(w.decision, "B");
});

test("ready-times: a missing file is n/a, a malformed one is an input error", () => {
  const args = TWO_WINDOW.slice(0, -1);
  const missing = json([...args, path.join(tmp, "nope.json")]);
  const src = missing.sources.find((s) => s.kind === "ready-times");
  assert.equal(src.found, false);
  assert.match(src["n/a"], /file not found/);
  assert.equal(missing.throughput.issues_without_ready, 2);
  const bad = path.join(tmp, "bad-ready.json");
  fs.writeFileSync(bad, '{"x": "nonsense"}');
  const r = run([...args, bad]);
  assert.equal(r.status, 1);
  assert.match(r.err, /--ready-times/);
});

// ---- fleet-wide no-mistakes export (cbundy/dev-system#274): tests/fixtures/evaluate/nm-export.jsonl
// Window 2026-10-08 10:00-11:00Z, acme/widgets. Device laptop ran L1 (10:10, review fixed once, 90 s
// parked) and L2 (10:20, review failed, 30 s parked, still awaiting an agent); device coder ran C1
// (10:30, lint fixed twice, ci skipped) and C0 (09:00, before the window). O1 is acme/other on coder.
// The file also holds an unknown table, a row with an unknown column, a table the tool ignores and
// a line that is not JSON; timestamps are ISO strings with both `Z` and `+00:00`.
const EXPORT_ARGS = [...WINDOW, "--nm-export", NM_EXPORT];

test("export: every pipeline number comes from the export, across devices", () => {
  const r = json(EXPORT_ARGS, DEVICE);
  const p = r.pipeline;
  assert.equal(r.window.pipeline_runs, 3);
  assert.equal(p.runs, 3);
  assert.deepEqual(p.by_status, { completed: 2, failed: 1 });
  // review rounds: s1 has 2 rounds, s3 1, s5 1
  assert.deepEqual(p.review_rounds, { total: 4, max: 2, per_run: [{ run: "C1", review_rounds: 1 }, { run: "L1", review_rounds: 2 }, { run: "L2", review_rounds: 1 }] });
  assert.deepEqual(p.fallback_invocations, { count: 1, of: 4 }); // i2's empty reason is not a fallback; i4's is
  // ci steps: s2 120 s, s4 300 s (s7 is skipped but has no duration, so it adds nothing)
  assert.deepEqual(p.ci_duration_seconds, { median: 210, max: 300, steps: 2 });
  // review: s1 fixed, s3 failed, s5 clean = 1/3; ci: s2, s4 = 2/2 (s7 skipped); lint: s6 fixed twice = 0/1
  assert.deepEqual(p.gates, [
    { step: "ci", steps: 2, first_pass: 2, first_pass_rate: 100 },
    { step: "lint", steps: 1, first_pass: 0, first_pass_rate: 0 },
    { step: "review", steps: 3, first_pass: 1, first_pass_rate: 33.3 },
  ]);
  // auto_fix rounds: d2 (s1) and d6, d7 (s6); per run L1 1, L2 0, C1 2
  assert.deepEqual(p.fix_rounds, { total: 3, max_per_run: 2, by_step: { ci: 0, lint: 2, review: 1 } });
  // i1 sonnet/review; i2 + i4 sonnet/fix (5+1, 5+2, 50+3, 0+4); i3 opus/review. i5 is C0, i6 is acme/other.
  assert.deepEqual(p.tokens_by_model_purpose, [
    { model: "claude-opus-5-5", purpose: "review", invocations: 1, input: 100, output: 200, cache_read: 3000, cache_creation: 400 },
    { model: "claude-sonnet-5-5", purpose: "fix", invocations: 2, input: 6, output: 7, cache_read: 53, cache_creation: 4 },
    { model: "claude-sonnet-5-5", purpose: "review", invocations: 1, input: 10, output: 20, cache_read: 300, cache_creation: 40 },
  ]);
  // L1 90 s, L2 30 s; C1 parked 0 ms is not a parked run; C0 is outside the window
  assert.deepEqual(p.parked, { runs_parked: 2, total_seconds: 120, median_seconds: 60, max_seconds: 90, awaiting_agent: 1 });
  assert.deepEqual(p.by_device.map((d) => [d.device, d.runs]), [["coder", 1], ["laptop", 2]]);
  const coder = p.by_device[0];
  assert.deepEqual(coder.gates, [
    { step: "lint", steps: 1, first_pass: 0, first_pass_rate: 0 },
    { step: "review", steps: 1, first_pass: 1, first_pass_rate: 100 },
  ]);
  assert.deepEqual(coder.fix_rounds, { total: 2, max_per_run: 2, by_step: { ci: 0, lint: 2, review: 0 } });
  assert.deepEqual(coder.parked, { runs_parked: 0, total_seconds: 0, median_seconds: null, max_seconds: null, awaiting_agent: 0 });
  assert.equal(sumField(coder.tokens_by_model_purpose, "invocations"), 2);
  const laptop = p.by_device[1];
  assert.deepEqual(laptop.fix_rounds, { total: 1, max_per_run: 1, by_step: { ci: 0, review: 1 } });
  assert.deepEqual(laptop.parked, { runs_parked: 2, total_seconds: 120, median_seconds: 60, max_seconds: 90, awaiting_agent: 1 });
  // by_repo covers every repo in the export, in the window
  assert.equal(p.by_repo.scope, "every repo in the source, not limited to --repo");
  assert.deepEqual(p.by_repo.rows.map((x) => [x.repo, x.runs]), [["acme/other", 1], ["acme/widgets", 3]]);
  assert.deepEqual(p.by_repo.rows[0].parked, { runs_parked: 1, total_seconds: 5, median_seconds: 5, max_seconds: 5, awaiting_agent: 0 });
  assert.deepEqual(p.by_repo.rows[0].gates, [{ step: "lint", steps: 1, first_pass: 1, first_pass_rate: 100 }]);
  // the pipeline:<step> spend rows come from the export too (model_roundtrips are the turns)
  assert.deepEqual(r.spend.rows.filter((x) => x.role === "pipeline:review").map((x) => [x.model, x.turns]), [["claude-opus-5-5", 2], ["claude-sonnet-5-5", 3]]);
  assert.deepEqual(r.window.scope, { pipeline: "fleet", events: "workspace", transcripts: "workspace" });
});

const sumField = (rows, k) => rows.reduce((a, x) => a + x[k], 0);

test("export: sources list the export and mark state.sqlite as transcript discovery only", () => {
  const r = json(EXPORT_ARGS);
  const ex = r.sources.find((s) => s.kind === "no-mistakes-export");
  // runs 7 + step_results 9 + step_rounds 8 + agent_invocations 6; the other table lines are ignored
  assert.deepEqual(ex, { kind: "no-mistakes-export", path: NM_EXPORT, found: true, rows: 30 });
  const sq = r.sources.find((s) => s.kind === "no-mistakes");
  assert.equal(sq.note, "used for transcript discovery only");
  assert.equal(sq.rows, null);
  // transcript discovery still works through the sqlite repos row
  assert.equal(r.window.sessions, 2);
  assert.match(run([...EXPORT_ARGS, "--format", "markdown"]).out, /\| note \|/);
});

test("export: the same runs as sqlite and as an export give identical pipeline numbers (ISO and epoch timestamps)", () => {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(tmp, "parity.sqlite");
  buildDb(file);
  const db = new DatabaseSync(file);
  const repoOf = new Map(db.prepare("SELECT id, upstream_url FROM repos").all().map((r) => [r.id, mod.repoOfUrl(r.upstream_url)]));
  const runs = db.prepare("SELECT * FROM runs").all();
  const runRepo = new Map(runs.map((r) => [r.id, repoOf.get(r.repo_id)]));
  const lines = [];
  const add = (table, row) => lines.push(JSON.stringify({ table, row }));
  const isoOf = (sec) => new Date(sec * 1000).toISOString().replace("Z", "+00:00");
  for (const r of runs) {
    add("runs", { ...r, created_at: isoOf(r.created_at), awaiting_agent_since: r.awaiting_agent_since ? isoOf(r.awaiting_agent_since) : null, repo: runRepo.get(r.id), device: "laptop-test" });
  }
  for (const t of ["step_results", "step_rounds", "agent_invocations"]) for (const r of db.prepare(`SELECT * FROM ${t}`).all()) add(t, r);
  db.close();
  const exp = path.join(tmp, "parity.jsonl");
  fs.writeFileSync(exp, lines.join("\n") + "\n");
  const a = json(WINDOW, DEVICE);
  const b = json([...WINDOW, "--nm-export", exp], DEVICE);
  assert.deepEqual(b.pipeline, a.pipeline);
  assert.deepEqual(b.spend.rows.filter((x) => x.role.startsWith("pipeline:")), a.spend.rows.filter((x) => x.role.startsWith("pipeline:")));
  assert.equal(b.window.pipeline_runs, a.window.pipeline_runs);
});

test("export: a missing file is n/a with a reason and exit 0; unknown tables and columns are ignored", () => {
  const missing = json([...WINDOW, "--nm-export", path.join(tmp, "nope.jsonl")]);
  assert.match(missing.pipeline["n/a"], /file not found/);
  assert.equal(missing.window.pipeline_runs, "n/a");
  const src = missing.sources.find((s) => s.kind === "no-mistakes-export");
  assert.equal(src.found, false);
  assert.match(src["n/a"], /file not found/);
  // an export of only unknown tables is an empty one, not an error
  const odd = path.join(tmp, "odd.jsonl");
  fs.writeFileSync(odd, '{"table":"nothing","row":{"a":1}}\nnot json\n{"table":"runs"}\n[1]\n');
  const r = json([...WINDOW, "--nm-export", odd]);
  assert.equal(r.pipeline.runs, 0);
  assert.deepEqual(r.pipeline.by_device, []);
  assert.deepEqual(r.pipeline.gates, []);
  // a column the tool does not know about changes nothing: L1 carries `future_column` in the fixture
  assert.equal(json(EXPORT_ARGS).pipeline.runs, 3);
});

test("export: an old export without trigger_type or purpose degrades only those metrics", () => {
  const old = path.join(tmp, "old-export.jsonl");
  const strip = { step_rounds: "trigger_type", agent_invocations: "purpose" };
  fs.writeFileSync(old, fs.readFileSync(NM_EXPORT, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      const o = JSON.parse(l);
      if (strip[o.table]) delete o.row[strip[o.table]];
      return JSON.stringify(o);
    } catch { return l; }
  }).join("\n") + "\n");
  const p = json([...WINDOW, "--nm-export", old]).pipeline;
  assert.match(p.gates["n/a"], /trigger_type/);
  assert.match(p.fix_rounds["n/a"], /trigger_type/);
  assert.match(p.tokens_by_model_purpose["n/a"], /purpose/);
  assert.equal(p.runs, 3);
  assert.equal(p.review_rounds.total, 4);
  assert.equal(p.parked.total_seconds, 120);
});

// ---- the pipeline facts come from the no-mistakes source, not run_started (cbundy/dev-system#343)
// The same six cases, with the same instants and expected numbers, as the PostgreSQL fixtures in
// images/base/test/nm-fixture.js and sections/09-agentsview.sh (which run in image CI):
//  51  one run on feat/issue-51-no-event, no run_started event
//  52  repo spelled Acme/Widgets in the events; first run cancelled, second on another branch name
//  53  a run_started event 20 s after the run was created: the mirror time wins
//  54  run on chore/bump-deps, linked only by a legacy run_started event with its run_id
//  55  merged with no run in the source at all: null stages, run_source none
//  r10 off-convention branch with no event, r11 an issue branch but no repo: unlinked
const LINK_BASE = 1700000000;
const at = (sec) => new Date((LINK_BASE + sec) * 1000).toISOString();
const LINK_WINDOW = ["--repo", "acme/widgets", "--since", at(0), "--until", at(70000)];

function linkFixture(dir, { withRuns = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ev = (repo, sec, state, issue, run = null) => JSON.stringify({ v: 1, ts: at(sec), repo, device: "nm-metrics", state, issue, run_id: run, note: null });
  const story = (repo, issue, t0, steps) => steps.map(([off, state, run]) => ev(repo, t0 + off, state, issue, run));
  const events = [
    ...story("acme/widgets", 51, 10000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [1260, "merge_ready"], [2460, "merged"]]),
    ...story("Acme/Widgets", 52, 20000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [1660, "merge_ready"], [1960, "merged"]]),
    ...story("acme/widgets", 53, 30000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [680, "run_started", "r8"], [1260, "merge_ready"], [1560, "merged"]]),
    ...story("acme/widgets", 54, 40000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [670, "run_started", "r9"], [1460, "merge_ready"], [1560, "merged"]]),
    ...story("acme/widgets", 55, 55000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [900, "merge_ready"], [1000, "merged"]]),
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.join("\n") + "\n");
  const R = [ // id, repo, branch, status, created (s after LINK_BASE)
    ["r5", "acme/widgets", "feat/issue-51-no-event", "completed", 10660],
    ["r6", "acme/widgets", "feat/issue-52-first", "cancelled", 20660],
    ["r7", "acme/widgets", "fix/issue-52-second", "completed", 21060],
    ["r8", "acme/widgets", "feat/issue-53-both", "completed", 30660],
    ["r9", "acme/widgets", "chore/bump-deps", "completed", 40660],
    ["r10", "acme/widgets", "chore/release-0.9.0", "completed", 50000],
    ["r11", null, "feat/issue-60-orphan", "completed", 60000],
  ].filter(() => withRuns);
  const exp = [];
  for (const [id, repo, branch, status, t] of R) {
    exp.push(JSON.stringify({ table: "runs", row: { id, repo_id: "x", branch, repo, device: "nm-host", status, created_at: at(t) } }));
  }
  fs.writeFileSync(path.join(dir, "nm-export.jsonl"), exp.join("\n") + "\n");
  // the same runs as a workspace state.sqlite (r11 has a repo_id with no repos row, so no repo)
  const { DatabaseSync } = require("node:sqlite");
  const home = path.join(dir, "nm");
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, "state.sqlite"));
  db.exec(fs.readFileSync(path.join(FIX, "state.sql"), "utf8"));
  db.exec("DELETE FROM runs");
  const ins = db.prepare("INSERT INTO runs (id, repo_id, branch, status, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const [id, repo, branch, status, t] of R) ins.run(id, repo ? "repo1" : "repo-none", branch, status, LINK_BASE + t);
  db.close();
  return { events: path.join(dir, "events.jsonl"), exportFile: path.join(dir, "nm-export.jsonl"), home };
}

test("pipeline facts come from the mirror: issues without a run_started event get their stage times", () => {
  const f = linkFixture(path.join(tmp, "link"));
  const bySource = {
    export: [...LINK_WINDOW, "--events", f.events, "--nm-export", f.exportFile],
    sqlite: [...LINK_WINDOW, "--events", f.events],
  };
  for (const [kind, args] of Object.entries(bySource)) {
    const r = json(args, { NO_MISTAKES_HOME: f.home, DEV_MACHINE_NAME: "nm-host" });
    const rows = Object.fromEntries(r.throughput.issues.map((i) => [i.issue, i]));
    const stages = (i) => [i.run_source, i.waiting_for_claim, i.design, i.implementation, i.pipeline, i.waiting_for_merge, i.total];
    // the same numbers as query 1 in 09-agentsview.sh
    assert.deepEqual(stages(rows[51]), ["mirror", 60, 300, 300, 600, 1200, 2460], `${kind} 51`);
    assert.deepEqual(stages(rows[52]), ["mirror", 60, 300, 300, 1000, 300, 1960], `${kind} 52: first run is the cancelled one`);
    assert.deepEqual(stages(rows[53]), ["mirror", 60, 300, 300, 600, 300, 1560], `${kind} 53: the mirror beats a run_started 20 s later`);
    assert.deepEqual(stages(rows[54]), ["run_started", 60, 300, 300, 800, 100, 1560], `${kind} 54: legacy link, mirror created_at`);
    // no run in the source: never a wrong number
    assert.deepEqual(stages(rows[55]), ["none", 60, 300, null, null, 100, 1000], `${kind} 55`);
    // the same numbers as query 7 in 09-agentsview.sh
    const w = Object.fromEntries(r.waiting.issues.map((i) => [i.issue, [i.pipeline_bound, i.dispatcher_bound, i.dispatcher_bound_other_idle, i.agent_work, i.total]]));
    assert.deepEqual(w[51], [600, 1260, 0, 600, 2460], `${kind} 51`);
    assert.deepEqual(w[52], [1000, 360, 0, 600, 1960], `${kind} 52`);
    assert.deepEqual(w[53], [600, 360, 0, 600, 1560], `${kind} 53`);
    assert.deepEqual(w[54], [800, 160, 0, 600, 1560], `${kind} 54`);
    assert.deepEqual(w[55], [0, 160, 0, 840, 1000], `${kind} 55: no linked run, so nothing is pipeline-bound`);
    // r10 is the only unlinked run of acme/widgets (r11 has no repo, so it is not this repo's)
    assert.equal(r.pipeline.unlinked_runs, 1, kind);
  }
});

test("a run_started event alone no longer sets pipeline times; without any pipeline source they are null", () => {
  const f = linkFixture(path.join(tmp, "link-none"), { withRuns: false });
  const r = json([...LINK_WINDOW, "--events", f.events, "--nm-export", f.exportFile], { NO_MISTAKES_HOME: f.home });
  // 53 and 54 have run_started events, but the run is not in the source (and 54's branch is off-convention)
  for (const i of r.throughput.issues) assert.deepEqual([i.run_source, i.implementation, i.pipeline], ["none", null, null], String(i.issue));
  assert.equal(r.pipeline.unlinked_runs, 0);
  // with no pipeline source at all, the same: null, not a number from the events
  const missing = json([...LINK_WINDOW, "--events", f.events], { NO_MISTAKES_HOME: path.join(tmp, "no-nm") });
  for (const i of missing.throughput.issues) assert.deepEqual([i.run_source, i.implementation, i.pipeline], ["none", null, null]);
  assert.match(run([...LINK_WINDOW, "--events", f.events, "--format", "markdown"], { NO_MISTAKES_HOME: path.join(tmp, "no-nm") }).out, /\| run_source \|/);
});

test("drift guard: every column the tool reads exists in nm-export's TABLES", () => {
  const { TABLES } = require(path.join(__dirname, "..", "images", "base", "nm-export"));
  // nm-export adds device and repo to every mirrored table; it never exports repos.working_path,
  // which only the workspace reader needs (for transcript discovery)
  const extra = new Set(["device", "repo", "working_path"]);
  const check = (schema) => {
    for (const [table, cols] of Object.entries(schema)) {
      for (const c of cols) assert.ok(c in TABLES[table].cols || extra.has(c), `${table}.${c} is not a column nm-export mirrors`);
    }
  };
  check(mod.NM_SCHEMA);
  check(mod.NM_OPTIONAL);
  check(mod.NM_EXPORT_SCHEMA);
});

// ---- the factory loop v2 (v2 SPEC 7.3, #632): tests/fixtures/evaluate/v2, built with the notes
// plugins/factory-loop/hooks/v2/events.ts writes. Window 2026-10-16 00:00-12:00Z, device L the
// loop, P another. #10 goes from claim (01:00) to merge (02:20) untouched; #11 (claimed 03:00) times
// out, its agent dies, triage parks it (04:20), the owner resumes it (04:59), one fix round, merged
// 06:20; #12 is dropped, #13 still open, #14 (P) reclaimed by the sweep; #15 (claimed 10:30) is
// merged by hand at 11:10, and the loop derives that intervention a pass later, after the merge. A
// ci-rerun on #10 the day before, a restart, a config-file edit and a breaker are fleet-level or
// outside the window, and one transition and one triage intervention are logged twice (a retry).
const V2_WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-16T00:00:00Z", "--until", "2026-10-16T12:00:00Z",
  "--events", path.join(FIX, "v2", "events.jsonl")];

test("v2 interventions (#632 metric 1): by who and cause, per day and per merged issue; untouched means none named its merged work", () => {
  const v = json(V2_WINDOW).interventions;
  assert.deepEqual([v.total, v.person, v.loop, v.fleet], [10, 5, 5, 3], "the retried triage counts once, the day-before ci-rerun not at all");
  assert.deepEqual(v.by_cause, [
    { who: "loop", cause: "breaker", count: 1 }, { who: "loop", cause: "park", count: 1 }, { who: "loop", cause: "triage", count: 1 },
    { who: "loop", cause: "unknown:agent-dead", count: 1 }, { who: "loop", cause: "unknown:timeout", count: 1 },
    { who: "person", cause: "config-file", count: 1 }, { who: "person", cause: "hand-merge", count: 1 }, { who: "person", cause: "op:drop", count: 1 },
    { who: "person", cause: "op:resume", count: 1 }, { who: "person", cause: "restart", count: 1 },
  ]);
  assert.deepEqual(v.per_day, [{ day: "2026-10-16", person: 5, loop: 5, fleet: 3 }]);
  assert.deepEqual([v.merged_issues, v.untouched, v.untouched_pct, v.person_per_merged_issue, v.loop_per_merged_issue], [3, 1, 33.3, 0.67, 1.33]);
  // #15's hand-merge is logged after its merged event: it names the merged life, so #15 is touched
  assert.deepEqual(v.issues, [
    { issue: 10, person: 0, loop: 0, untouched: true, causes: [] },
    { issue: 11, person: 1, loop: 4, untouched: false, causes: ["op:resume", "park", "triage", "unknown:agent-dead", "unknown:timeout"] },
    { issue: 15, person: 1, loop: 0, untouched: false, causes: ["hand-merge"] },
  ]);
});

test("v2 interventions belong to the merged work by life, else by time to the close plus a grace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-v2-"));
  try {
    const base = fs.readFileSync(path.join(FIX, "v2", "events.jsonl"), "utf8").trim().split("\n");
    const line = (ts, issue, note) => JSON.stringify({ v: 2, ts, repo: "acme/widgets", device: "L", session_id: null, actor: "agent", state: "intervention", issue, run_id: null, branch: null, pr: null, head: null, note });
    const extra = [
      // a later life of #10 (begun after its merge) is not its merged work, wherever it was logged
      line("2026-10-16T02:19:00Z", 10, "who=loop cause=park life=lz fact=i10/llz/s1/t reason=park"),
      // an op with no life on #10 well after its close is not either; one within the grace is
      line("2026-10-16T03:30:00Z", 10, "who=person cause=op:note life=none fact=op:note/i10/q9 reason=note"),
    ];
    const lz = JSON.stringify({ v: 2, ts: "2026-10-16T11:30:00Z", repo: "acme/widgets", device: "L", session_id: null, actor: "agent", state: "transition", issue: 10, run_id: null, branch: "issue-10", pr: null, head: null, note: "row=S0 life=lz seq=0 from=none to=queued seqAt=1 since=1 resumeTo=none step=lease attempt=1 cut=no triages=0 fixes=0 round=0 why=none approvedPatch=none prClosedAt=none via=S0 brief=none question=none notes=none" });
    const file = path.join(dir, "events.jsonl");
    fs.writeFileSync(file, [...base, ...extra, lz].join("\n") + "\n");
    const at = (events) => json([...V2_WINDOW.slice(0, -1), events]).interventions.issues.find((i) => i.issue === 10);
    assert.deepEqual(at(file), { issue: 10, person: 0, loop: 0, untouched: true, causes: [] });
    fs.writeFileSync(file, [...base, line("2026-10-16T02:45:00Z", 10, "who=person cause=op:note life=none fact=op:note/i10/q8 reason=note")].join("\n") + "\n");
    assert.deepEqual(at(file), { issue: 10, person: 1, loop: 0, untouched: false, causes: ["op:note"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 judgement calls (#632 metric 2): reviews, triage with the choice it made, a fixer's dispositions; overridden by a person within an hour", () => {
  const j = json(V2_WINDOW).judgement_calls;
  assert.deepEqual([j.total, j.overridden, j.per_merged_issue], [5, 1, 1.67]);
  assert.deepEqual(j.by_kind, [
    { kind: "fix", outcome: "fixed", count: 1, overridden: 0 },
    { kind: "review", outcome: "approve", count: 2, overridden: 0 },
    { kind: "review", outcome: "changes", count: 1, overridden: 0 },
    { kind: "triage", outcome: "park", count: 1, overridden: 1 },
  ]);
  assert.deepEqual(j.issues, [{ issue: 10, calls: 1, overridden: 0 }, { issue: 11, calls: 4, overridden: 1 }, { issue: 15, calls: 0, overridden: 0 }]);
});

test("v2 claim completion (#632 metric 3): per life, the first end; open claims are censored, not failures", () => {
  const c = json(V2_WINDOW).claim_completion;
  assert.deepEqual([c.claims, c.merged, c.open, c.merged_pct_of_resolved], [6, 2, 1, 40]);
  assert.deepEqual(c.outcomes, { "abandoned:dropped": 1, merged: 2, open: 1, parked: 1, released: 1 });
  assert.deepEqual(c.by_device, [{ device: "L", claims: 5, merged: 2, open: 1 }, { device: "P", claims: 1, merged: 0, open: 0 }]);
  assert.deepEqual(c.issues.map((i) => [i.issue, i.outcome, i.ended_at]), [
    [10, "merged", "2026-10-16T02:20:00.000Z"], [11, "parked", "2026-10-16T04:20:00.000Z"], [12, "abandoned:dropped", "2026-10-16T07:30:00.000Z"],
    [13, "open", null], [14, "released", "2026-10-16T09:30:00.000Z"], [15, "merged", "2026-10-16T11:10:00.000Z"],
  ]);
});

test("v2 rounds and time in flight per merged issue: review rounds from reviewed, fix rounds from fix_requested, parked time left out", () => {
  const r = json(V2_WINDOW).rounds;
  assert.deepEqual(r.issues, [
    { issue: 10, review_rounds: 1, fix_rounds: 0, in_flight_seconds: 4800, parked_seconds: 0 },
    { issue: 11, review_rounds: 2, fix_rounds: 1, in_flight_seconds: 9600, parked_seconds: 2400 },
    { issue: 15, review_rounds: 0, fix_rounds: 0, in_flight_seconds: 2400, parked_seconds: 0 },
  ]);
  assert.deepEqual([r.review_rounds, r.fix_rounds, r.in_flight_seconds], [
    { median: 1, max: 2, total: 3 }, { median: 0, max: 1, total: 1 }, { median: 4800, max: 9600, total: 16800 },
  ]);
});

test("v2 lead time: with no run, the pipeline stage starts at the first transition to reviewing", () => {
  // no no-mistakes source here: the workspace fixture's state.sqlite has runs on issue-10 branches
  const rows = Object.fromEntries(json(V2_WINDOW, { NO_MISTAKES_HOME: path.join(tmp, "no-nm") }).throughput.issues.map((i) => [i.issue, i]));
  const stages = (i) => [i.run_source, i.design, i.implementation, i.pipeline, i.waiting_for_merge];
  assert.deepEqual(stages(rows[10]), ["transition", 1200, 2400, 720, 480]);
  assert.deepEqual(stages(rows[11]), ["transition", 600, 8400, 2460, 540]);
  // reviewed and intervention events are no progress: #13 is silent since its last transition
  const s = json(V2_WINDOW, { CALLUM_FLOW_LEASE_MINUTES: "30" }).claims.stuck.issues.find((i) => i.issue === 13);
  assert.equal(s.last_state, "transition");
});

test("v2 sections read n/a with the reason when the events are missing, and show in markdown", () => {
  const r = json([...V2_WINDOW.slice(0, -2), "--events", path.join(tmp, "absent.jsonl")]);
  for (const k of ["interventions", "judgement_calls", "claim_completion", "rounds"]) assert.match(r[k]["n/a"], /file not found/, k);
  const md = run([...V2_WINDOW, "--format", "markdown"]).out;
  assert.match(md, /\| loop \| unknown:timeout \| 1 \|/);
  assert.match(md, /\| triage \| park \| 1 \| 1 \|/);
  assert.match(md, /\| abandoned:dropped \| 1 \|/);
  assert.match(md, /\| 11 \| 2 \| 1 \| 9600 \| 2400 \|/);
});

// ---------------------------------------------------------------- the source switch (#899)
// One issue's life in three shapes: the old log (hand-written notes), the new local log (`data`) and
// the same events as factory.event_log rows (the x-column fields only, no `data`). Window 2026-10-16
// 00:00 to 12:00. Issue 20 is merged at 03:10; its transition into fixing is logged twice with the same
// seq_at (a retry), and counts once. Issue 21 is claimed and requeued.
const NEW_WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-16T00:00:00Z", "--until", "2026-10-16T12:00:00Z"];
const SCHEMA_DIR = path.join(__dirname, "..", "docs", "factory-events", "schemas");
const VIEW_FIELDS = new Set();
for (const f of fs.readdirSync(SCHEMA_DIR).filter((x) => x.endsWith(".v1.json") && x !== "envelope.v1.json")) {
  for (const [k, def] of Object.entries(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8")).properties)) if (def["x-column"] === true) VIEW_FIELDS.add(k);
}

function lifeFixture() {
  const T = (hm) => `2026-10-16T${hm}:00.000Z`;
  const rows = []; // { ts, issue, actor, type, data, old: [{ state, note }] }
  const add = (hm, issue, actor, type, data, ...old) => rows.push({ ts: T(hm), issue, actor, type, data, old });
  let seq = 0;
  const tr = (hm, from, to, row, extra, ...old) => {
    seq += 1;
    return add(hm, 20, "agent", "transition", { life: "l1", seq, table_row: row, from_state: from, to_state: to, via: "x", seq_at: T(hm), state_since: T(hm), step: null, round: 0, ...extra },
      { state: "transition", note: `row=${row} life=l1 seq=${seq} from=${from || "none"} to=${to} seqAt=1 since=1 step=none round=0 via=x` }, ...old);
  };
  add("01:00", 20, "agent", "ready", {}, { state: "ready", note: null });
  add("01:10", 20, "agent", "claimed", { lease_minutes: 120 }, { state: "claimed", note: "lease: 120" });
  add("01:20", 20, "agent", "claim_renewed", { lease_minutes: 120 }, { state: "renewed", note: "lease: 120" });
  tr("01:30", null, "queued", "S0", {});
  tr("01:40", "queued", "designing", "T1", {});
  tr("01:50", "designing", "building", "T2", {}, { state: "delegated", note: "brief https://x/20" });
  tr("02:00", "building", "reviewing", "T5", { round: 1 });
  add("02:05", 20, "agent", "reviewed", { branch: "issue-20", pr: 9, head: "abc1234", verdict: "changes", round: 1, patch: "p1", errors: 1, warnings: 0, infos: 0, reviewer: "r", answer_path: "/a/1" },
    { state: "reviewed", note: "verdict=changes round=1 patch=p1 errors=1 warnings=0 infos=0 reviewer=r answer=/a/1" });
  add("02:10", 20, "fixer", "finding_handled", { branch: "issue-20", pr: 9, head: "abc1234", finding: "r1-1", outcome: "fixed", detail: "ok" }, { state: "verdict", note: "CORRECT: r1-1 ok" });
  add("02:10", 20, "fixer", "finding_handled", { branch: "issue-20", pr: 9, head: "abc1234", finding: "r1-2", outcome: "declined", detail: "no" }, { state: "verdict", note: "WRONG: r1-2 no" });
  tr("02:15", "reviewing", "fixing", "T7", {}, { state: "fix_requested", note: "fix:review" });
  rows.push({ ...rows[rows.length - 1], ts: T("02:16"), old: [rows[rows.length - 1].old[0]] }); // the same transition logged again, seq_at unchanged
  tr("02:40", "fixing", "reviewing", "T11", { round: 2 });
  add("02:45", 20, "agent", "reviewed", { branch: "issue-20", pr: 9, head: "def5678", verdict: "approve", round: 2, patch: "p2", errors: 0, warnings: 0, infos: 0, reviewer: "r", answer_path: "/a/2" },
    { state: "reviewed", note: "verdict=approve round=2 patch=p2 errors=0 warnings=0 infos=0 reviewer=r answer=/a/2" });
  add("02:50", 20, "agent", "test_weakened", { branch: "issue-20", pr: 9, head: "def5678", commit: "1234567", restored: true, kinds: ["skip"], files: ["t.js"] }, { state: "test_weakened", note: "commit=1234567 restored=yes step=none kinds=skip files=t.js" });
  add("02:51", 20, "agent", "test_weakened", { branch: "issue-20", pr: 9, head: "def5678", commit: "7654321", restored: false, kinds: ["skip"], files: ["t.js"] }, { state: "test_weakened", note: "commit=7654321 restored=no step=none kinds=skip files=t.js" });
  add("02:55", 20, "loop", "intervention", { who: "loop", cause: "triage", life: "l1", fact: "i20/l1/t1", pr: null, detail: "t" }, { state: "intervention", note: "who=loop cause=triage life=l1 fact=i20/l1/t1 reason=t" });
  add("02:56", 20, "person", "intervention", { who: "person", cause: "op:note", life: null, fact: "op:note/i20/q1", pr: null, detail: "n" }, { state: "intervention", note: "who=person cause=op:note life=none fact=op:note/i20/q1 reason=n" });
  tr("03:00", "reviewing", "merge-queue", "T13", {}, { state: "merge_ready", note: "round 2" });
  add("03:10", 20, "agent", "merged", { pr: 9, branch: "issue-20", head: "def5678", by: "factory", recovered: false }, { state: "merged", note: "merged by the factory loop" });
  add("01:55", null, "agent", "loop_passes", { from_at: T("01:54"), to_at: T("01:55"), passes: 1 }, { state: "loop", note: "kind=passes key=passes:1 status=done" });
  add("04:00", 21, "agent", "claimed", { lease_minutes: 120 }, { state: "claimed", note: "lease: 120" });
  add("04:30", 21, "agent", "requeued", { reason: "lease-expired", stage: null, lives: null, branch: null, pr: null, detail: null }, { state: "reclaimed", note: "lease expired" });
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return rows;
}

function writeLife(dir) {
  const rows = lifeFixture();
  const env = (r, i) => ({ envelope: 1, event_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, ts: r.ts, type: r.type, type_version: 1, repo: "acme/widgets", device: "L", actor: r.actor, session_id: null, issue: r.issue, base_image: null, dev_image: null, template_version: null, plugin_version: null });
  const pgTime = (x) => (typeof x === "string" && /Z$/.test(x) ? x.replace("Z", "+00:00") : x);
  const files = { old: path.join(dir, "old.jsonl"), local: path.join(dir, "new-local.jsonl"), view: path.join(dir, "new-view.jsonl") };
  const lines = { old: [], local: [], view: [] };
  rows.forEach((r, i) => {
    for (const o of r.old) lines.old.push(JSON.stringify({ v: 2, ts: r.ts.replace(".000Z", "Z"), repo: "acme/widgets", device: "L", session_id: null, actor: r.actor, state: o.state, issue: r.issue, run_id: null, branch: null, pr: null, head: null, note: o.note }));
    lines.local.push(JSON.stringify({ ...env(r, i), data: r.data }));
    const flat = Object.fromEntries(Object.entries(r.data).filter(([k]) => VIEW_FIELDS.has(k)).map(([k, v]) => [k, k === "seq_at" || k === "state_since" ? pgTime(v) : v]));
    lines.view.push(JSON.stringify({ ...env(r, i), ts: pgTime(r.ts), ...flat }));
  });
  for (const k of Object.keys(files)) fs.writeFileSync(files[k], lines[k].join("\n") + "\n");
  return files;
}

const NO_NM = () => path.join(tmp, "no-nm");
const sectionsFrom = (r) => {
  // the sources block names the input; the two n/a metrics have no new value; scope.events says which file
  const { sources, waiting, adjudicator_agreement, window, ...rest } = r;
  const { events, ...scope } = window.scope;
  return { ...rest, window: { ...window, scope } };
};

test("source switch: --source old and no flag (env old) print byte-identical json and markdown", () => {
  for (const fmt of ["json", "markdown"]) {
    const a = run([...WINDOW, "--format", fmt]);
    const b = run([...WINDOW, "--format", fmt, "--source", "old"], { CALLUM_FLOW_EVALUATE_SOURCE: "" });
    assert.equal(a.status, 0, a.err);
    assert.equal(b.out, a.out, fmt);
  }
});

test("source switch: a bad value exits 2 with the usage text; the flag wins over the env", () => {
  for (const args of [["--source", "bogus"], ["--source=bogus"]]) {
    const r = run([...WINDOW, ...args]);
    assert.equal(r.status, 2);
    assert.match(r.err, /invalid source 'bogus'/);
    assert.match(r.err, /--source old\|new\|shadow/);
  }
  const bad = run(WINDOW, { CALLUM_FLOW_EVALUATE_SOURCE: "nope" });
  assert.equal(bad.status, 2);
  assert.match(bad.err, /CALLUM_FLOW_EVALUATE_SOURCE/);
  const r = json([...WINDOW, "--source", "old"], { CALLUM_FLOW_EVALUATE_SOURCE: "new" });
  assert.ok(r.sources.some((s) => s.kind === "events"), "old won");
  assert.ok(!r.sources.some((s) => s.kind === "events-new"));
  assert.match(run(["--help"]).out, /--source old\|new\|shadow\] \[--new-events <file>\]/);
});

test("new source: the local log and a view export give the same report, and it matches old", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-new-"));
  try {
    const f = writeLife(dir);
    const env = { NO_MISTAKES_HOME: NO_NM() };
    const old = json([...NEW_WINDOW, "--events", f.old], env);
    const evDir = path.join(dir, "ev");
    fs.mkdirSync(path.join(evDir, "factory"), { recursive: true });
    fs.copyFileSync(f.local, path.join(evDir, "factory", "acme__widgets.jsonl"));
    const local = json([...NEW_WINDOW, "--source", "new"], { ...env, CALLUM_EVENTS_DIR: evDir });
    const view = json([...NEW_WINDOW, "--source", "new", "--new-events", f.view], env);
    assert.deepEqual(sectionsFrom(local), sectionsFrom(view), "both new shapes");
    assert.deepEqual(sectionsFrom(local), sectionsFrom(old), "new matches old on every section it can");
    // spot-check the numbers so a pair of empty reports cannot pass
    assert.equal(local.throughput.merged_issues, 1);
    assert.deepEqual([local.throughput.issues[0].total, local.throughput.issues[0].design, local.throughput.issues[0].waiting_for_merge], [7800, 2400, 600]);
    assert.deepEqual(local.first_pass, { reached_green: 1, first_pass: 0, first_pass_pct: 0, setback_issues: [20] });
    assert.deepEqual(local.review.by_prefix, { CORRECT: 1, WRONG: 1, NIT: 0, ENV: 0, DUP: 0 });
    assert.equal(local.rounds.issues[0].fix_rounds, 1, "the retried transition into fixing counts once");
    assert.equal(local.rounds.issues[0].review_rounds, 2);
    assert.deepEqual([local.test_weakened.total, local.test_weakened.restored, local.test_weakened.unrestored], [2, 1, 1]);
    assert.deepEqual([local.interventions.person, local.interventions.loop], [1, 1]);
    assert.equal(local.claims.reclaimed, 1);
    assert.deepEqual(local.judgement_calls.by_kind.map((k) => `${k.kind}:${k.outcome}:${k.count}`), ["fix:declined:1", "fix:fixed:1", "review:approve:1", "review:changes:1", "triage:pending:1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new source: metrics that need a v1-only event read n/a, named in sources, never 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-new-"));
  try {
    const f = writeLife(dir);
    const r = json([...NEW_WINDOW, "--source", "new", "--new-events", f.view], { NO_MISTAKES_HOME: NO_NM() });
    assert.match(r.waiting["n/a"], /run_started and parked/);
    assert.match(r.adjudicator_agreement["n/a"], /run_id/);
    const named = r.sources.filter((s) => s.kind === "new-events-n/a").map((s) => s.path);
    assert.deepEqual(named, ["adjudicator_agreement", "waiting"]);
    assert.ok(r.sources.some((s) => s.kind === "new-events-note" && s.path === "first_pass" && /failed/.test(s.note)));
    assert.ok(r.sources.some((s) => s.kind === "source" && s.path === "new"));
    const md = run([...NEW_WINDOW, "--source", "new", "--new-events", f.view, "--format", "markdown"], { NO_MISTAKES_HOME: NO_NM() }).out;
    assert.match(md, /n\/a: needs the v1-only run_started and parked events/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new source: the mapping drops what a guard needs to drop (a transition twice, a missing file, junk lines)", () => {
  const { mapEvent, loadNewEvents } = require("../images/base/evaluate-new-events.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-new-"));
  try {
    const tr = (id, seq, to) => ({ event_id: id, ts: "2026-10-16T01:00:00.000Z", type: "transition", repo: "o/r", device: "d", actor: "a", issue: 1, data: { life: "l", seq, table_row: "T2", from_state: "queued", to_state: to, via: "x", seq_at: "2026-10-16T01:00:05.000Z" } });
    const file = path.join(dir, "e.jsonl");
    fs.writeFileSync(file, [JSON.stringify(tr("a", 1, "building")), "not json", JSON.stringify(tr("b", 1, "building")), JSON.stringify({ type: "mystery", ts: "2026-10-16T01:00:00Z" }), JSON.stringify(tr("c", 2, "fixing"))].join("\n"));
    const got = loadNewEvents(file).events.map((e) => `${e.state}@${e.ts}`);
    assert.deepEqual(got, ["transition@2026-10-16T01:00:05.000Z", "delegated@2026-10-16T01:00:05.000Z", "transition@2026-10-16T01:00:05.000Z", "fix_requested@2026-10-16T01:00:05.000Z"]);
    assert.match(loadNewEvents(path.join(dir, "absent.jsonl")).reason, /file not found/);
    // a transition that stays in its state (a new attempt) is not a new delegation
    assert.deepEqual(mapEvent({ ...tr("d", 3, "building"), data: { ...tr("d", 3, "building").data, from_state: "building" } }).map((e) => e.state), ["transition"]);
    assert.deepEqual(mapEvent({ type: "finding_handled", ts: "2026-10-16T01:00:00Z", issue: 1, data: { outcome: "fixed", finding: "r1-1" } }).map((e) => e.note), ["CORRECT: r1-1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("default source is new: unset or empty reads the new log, writes no shadow record; --source old and the old variable switch back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-default-"));
  try {
    const f = writeLife(dir);
    const evDir = path.join(dir, "ev");
    fs.mkdirSync(path.join(evDir, "factory"), { recursive: true });
    fs.copyFileSync(f.local, path.join(evDir, "factory", "acme__widgets.jsonl"));
    fs.copyFileSync(f.old, path.join(evDir, "acme__widgets.jsonl"));
    const base = { NO_MISTAKES_HOME: NO_NM(), CALLUM_EVENTS_DIR: evDir, DEV_MACHINE_NAME: "m" };
    const kinds = (r) => r.sources.map((s) => s.kind);
    for (const v of [undefined, ""]) {
      const env = { ...base, ...(v === undefined ? { CALLUM_FLOW_EVALUATE_SOURCE: undefined } : { CALLUM_FLOW_EVALUATE_SOURCE: v }) };
      const r = json([...NEW_WINDOW], env);
      assert.ok(r.sources.some((s) => s.kind === "source" && s.path === "new"), `variable ${JSON.stringify(v)} reads new`);
      assert.ok(kinds(r).includes("new-events-n/a"));
    }
    assert.equal(fs.existsSync(path.join(evDir, "factory", ".shadow", "evaluate.jsonl")), false, "no shadow record");
    const viaFlag = json([...NEW_WINDOW, "--source", "old"], { ...base, CALLUM_FLOW_EVALUATE_SOURCE: "" });
    const viaVar = json([...NEW_WINDOW], { ...base, CALLUM_FLOW_EVALUATE_SOURCE: "old" });
    for (const r of [viaFlag, viaVar]) {
      assert.ok(!kinds(r).includes("new-events-n/a") && !r.sources.some((s) => s.kind === "source" && s.path === "new"), "old report");
    }
    assert.equal(fs.existsSync(path.join(evDir, "factory", ".shadow", "evaluate.jsonl")), false, "old writes no shadow record");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shadow: prints the old report, records one agreeing run; a broken or skipped new side never fails the tool", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-shadow-"));
  try {
    const f = writeLife(dir);
    const evDir = path.join(dir, "ev");
    fs.mkdirSync(path.join(evDir, "factory"), { recursive: true });
    fs.copyFileSync(f.local, path.join(evDir, "factory", "acme__widgets.jsonl"));
    fs.copyFileSync(f.old, path.join(evDir, "acme__widgets.jsonl"));
    const env = { NO_MISTAKES_HOME: NO_NM(), CALLUM_EVENTS_DIR: evDir, CALLUM_FLOW_EVALUATE_SOURCE: "shadow", DEV_MACHINE_NAME: "m" };
    const record = () => fs.readFileSync(path.join(evDir, "factory", ".shadow", "evaluate.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const oldOut = run([...NEW_WINDOW], { ...env, CALLUM_FLOW_EVALUATE_SOURCE: "old" });
    const shadow = run([...NEW_WINDOW], env); // shadow is opt-in
    assert.equal(shadow.status, 0, shadow.err);
    assert.equal(shadow.out, oldOut.out);
    assert.equal(shadow.err, "", "no difference, nothing on stderr");
    let rec = record();
    assert.equal(rec.length, 1);
    assert.deepEqual([rec[0].tool, rec[0].repo, rec[0].differences, rec[0].new_error], ["evaluate", "acme/widgets", 0, null]);
    // the new side broken (a directory, not a file): exit 0, same stdout, the error recorded
    const broken = run([...NEW_WINDOW, "--new-events", dir], env);
    assert.equal(broken.status, 0, broken.err);
    assert.equal(broken.out, oldOut.out);
    rec = record();
    assert.equal(rec.length, 2);
    assert.equal(rec[1].differences, null);
    assert.match(rec[1].new_error, /EISDIR/);
    // --events without --new-events: the new side is skipped, and the record says so
    const skipped = run([...NEW_WINDOW, "--events", f.old], env);
    assert.equal(skipped.status, 0, skipped.err);
    rec = record();
    assert.equal(rec.length, 3);
    assert.match(rec[2].new_error, /skipped: no new input/);
    // a new log that disagrees is recorded as differences, still exit 0
    fs.writeFileSync(path.join(evDir, "factory", "acme__widgets.jsonl"), "");
    const differs = run([...NEW_WINDOW], env);
    assert.equal(differs.status, 0, differs.err);
    assert.equal(differs.out, oldOut.out);
    assert.ok(record()[3].differences > 0);
    assert.match(differs.err, /shadow: \d+ difference/);
    // no new log at all: skipped, not a pile of differences
    fs.rmSync(path.join(evDir, "factory", "acme__widgets.jsonl"));
    const missing = run([...NEW_WINDOW], env);
    assert.equal(missing.status, 0, missing.err);
    rec = record();
    assert.equal(rec.length, 5);
    assert.equal(rec[4].differences, null);
    assert.match(rec[4].new_error, /skipped: no new log/);
    // --source new with a directory for --new-events: the tool's input error, exit 1
    const dirNew = run([...NEW_WINDOW, "--source", "new", "--new-events", dir], env);
    assert.equal(dirNew.status, 1);
    assert.match(dirNew.err, /callum-flow-evaluate: cannot read .*EISDIR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
