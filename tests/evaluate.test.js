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
    { issue: 7, merged_at: "2026-10-08T10:32:00.000Z", waiting_for_claim: 600, design: 1800, implementation: 1200, pipeline: 1800, waiting_for_merge: 3720, total: 9120 },
    { issue: 8, merged_at: "2026-10-08T10:50:00.000Z", waiting_for_claim: 300, design: 900, implementation: 600, pipeline: 1200, waiting_for_merge: 10800, total: 13800 },
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

test("pipeline: runs by status, review rounds, fallback invocations and ci duration", () => {
  assert.deepEqual(json(WINDOW).pipeline, {
    runs: 2,
    by_status: { completed: 1, failed: 1 },
    review_rounds: { total: 3, max: 2, per_run: [{ run: "run1", review_rounds: 2 }, { run: "run2", review_rounds: 1 }] },
    fallback_invocations: { count: 1, of: 3 },
    ci_duration_seconds: { median: 210, max: 300, steps: 2 },
  });
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
    const a = run([...WINDOW, "--format", format]);
    const b = run([...WINDOW, "--format", format]);
    assert.equal(a.status, 0);
    assert.equal(a.out, b.out);
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
