// Tests for images/base/fabriek-evaluate (cbundy/dev-system#258). The script runs as a
// subprocess against the synthetic fixtures in tests/fixtures/evaluate/. Every expected number below is
// worked out by hand from those fixtures; see docs/metrics.md for the definitions.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");

const SCRIPT = path.join(__dirname, "..", "images", "base", "fabriek-evaluate");
const FIX = path.join(__dirname, "fixtures", "evaluate");
const mod = require(SCRIPT);

const WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-08T10:00:00Z", "--until", "2026-10-08T11:00:00Z"];
const TWO_DIR = path.join(FIX, "two-device");
let tmp;
let checkout; // a git checkout whose toplevel the transcript folders of CLAUDE_CONFIG_DIR are named after
let claudeDir;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-test-")));
  checkout = path.join(tmp, "checkout");
  fs.mkdirSync(checkout);
  const git = spawnSync("git", ["init", "-q", checkout], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  // the fixture's transcript folders are named for /work/repo; rename them for this checkout so the
  // tool finds them the way it does for a real one (the git toplevel and its --<worktree> siblings)
  claudeDir = path.join(tmp, "claude");
  const m = mod.mungePath(checkout);
  const rename = { "-work-repo": m, "-work-repo--treehouse-pool-1-repo": `${m}--treehouse-pool-1-repo`, "-work-repo-extra": `${m}-extra`, "-work-other": "-work-other" };
  for (const [from, to] of Object.entries(rename)) {
    fs.cpSync(path.join(FIX, "claude", "projects", from), path.join(claudeDir, "projects", to), { recursive: true });
  }
});

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      CLAUDE_CONFIG_DIR: claudeDir,
      CALLUM_EVENTS_DIR: path.join(FIX, "events"),
      FABRIEK_EVALUATE_SOURCE: "old", // an explicit shadow would write into the fixture's events folder
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
  assert.equal(r.pipeline, undefined);
  assert.equal(r.window.pipeline_runs, undefined);
  const transcripts = r.sources.filter((s) => s.kind === "transcripts").map((s) => path.basename(s.path));
  const m = mod.mungePath(checkout);
  assert.deepEqual(transcripts, [m, `${m}--treehouse-pool-1-repo`]); // not `${m}-extra` and not -work-other
});

test("turns and tokens: a turn split over 3 lines counts once with its last usage; lines outside the window are dropped", () => {
  const rows = json(WINDOW).spend.rows;
  const orch = rows.find((x) => x.role === "orchestrator");
  // main1 has 7 distinct requestIds in the window (req_A spans 3 lines), the worktree session 1.
  assert.deepEqual(orch, {
    role: "orchestrator", model: "claude-opus-5-5", turns: 8, input: 15, output: 132, cache_read: 2960, cache_creation: 150,
  });
});

test("role attribution: typed sub-agent from meta, unknown without meta, no pipeline rows", () => {
  const rows = json(WINDOW).spend.rows;
  const by = (role, model) => rows.find((x) => x.role === role && x.model === model);
  assert.deepEqual(by("callum-flow:implementer", "claude-sonnet-5-5"), {
    role: "callum-flow:implementer", model: "claude-sonnet-5-5", turns: 2, input: 6, output: 50, cache_read: 600, cache_creation: 40,
  });
  assert.deepEqual(by("unknown", "claude-haiku-4"), {
    role: "unknown", model: "claude-haiku-4", turns: 1, input: 1, output: 2, cache_read: 3, cache_creation: 4,
  });
  assert.equal(rows.some((x) => x.role.startsWith("pipeline:")), false);
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
    { issue: 7, merged_at: "2026-10-08T10:32:00.000Z", ready_source: "event", run_source: "none", waiting_for_claim: 600, design: 1800, implementation: null, pipeline: null, waiting_for_merge: 3720, total: 9120 },
    { issue: 8, merged_at: "2026-10-08T10:50:00.000Z", ready_source: "event", run_source: "none", waiting_for_claim: 300, design: 900, implementation: null, pipeline: null, waiting_for_merge: 10800, total: 13800 },
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

test("window.scope: workspace by default, fleet when the events are an export; one line in markdown", () => {
  assert.deepEqual(json(WINDOW).window.scope, { events: "workspace", transcripts: "workspace" });
  assert.deepEqual(json([...WINDOW, "--events", path.join(TWO_DIR, "events.jsonl")]).window.scope, { events: "fleet", transcripts: "workspace" });
  assert.match(run([...WINDOW, "--format", "markdown"]).out, /^Scope: events=workspace transcripts=workspace$/m);
});

test("missing sources give n/a with a reason and exit 0", () => {
  const missing = json(WINDOW, { CALLUM_EVENTS_DIR: path.join(tmp, "no-events"), CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") });
  for (const k of mod.TOP_KEYS.filter((x) => x !== "window" && x !== "sources")) assert.ok(missing[k]["n/a"], `${k} should be n/a`);
  assert.equal(missing.spend["n/a"], "no transcripts");
  assert.equal(missing.sources.length, 2);
  for (const s of missing.sources) {
    assert.equal(s.found, false);
    assert.ok(s["n/a"]);
  }
  // only the events file missing: the other keys still compute
  const noEvents = json(WINDOW, { CALLUM_EVENTS_DIR: path.join(tmp, "no-events") });
  assert.match(noEvents.throughput["n/a"], /file not found/);
  assert.equal(noEvents.waste.wake_turns, 7);
  // no git checkout and no --projects-dir: no transcripts, unless named
  const outside = spawnSync(process.execPath, [SCRIPT, ...WINDOW, "--format", "json"], {
    cwd: tmp, encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, CLAUDE_CONFIG_DIR: claudeDir, CALLUM_EVENTS_DIR: path.join(FIX, "events"), FABRIEK_EVALUATE_SOURCE: "old", GIT_CEILING_DIRECTORIES: tmp },
  });
  assert.equal(JSON.parse(outside.stdout).window.sessions, 0);
  const named = json([...WINDOW, "--projects-dir", path.join(claudeDir, "projects", mod.mungePath(checkout))]);
  assert.equal(named.window.sessions, 1);
});

test("the retired --nm-state and --nm-export are accepted and ignored, with one note in sources", () => {
  const base = json(WINDOW);
  assert.equal(base.sources.some((s) => s.kind.startsWith("no-mistakes")), false);
  for (const flag of ["--nm-state", "--nm-export"]) {
    // the value is consumed and never read: not even a file that does not exist is an error
    const r = json([...WINDOW, flag, path.join(tmp, "does-not-exist")]);
    assert.equal("pipeline" in r, false, flag);
    assert.equal("pipeline_runs" in r.window, false, flag);
    assert.deepEqual(Object.keys(r), mod.TOP_KEYS, flag);
    const notes = r.sources.filter((s) => s.kind === "no-mistakes");
    assert.equal(notes.length, 1, flag);
    assert.match(notes[0].note, /retired/);
    assert.deepEqual({ ...r, sources: null }, { ...base, sources: null }, `${flag} changes nothing else`);
  }
  const both = json([...WINDOW, "--nm-state", "a", "--nm-export", "b"]);
  assert.equal(both.sources.filter((s) => s.kind === "no-mistakes").length, 1);
  assert.equal(run([...WINDOW, "--nm-export"]).status, 2, "a missing value is still a usage error");
  assert.match(run([...WINDOW, "--nm-export", "x", "--format", "markdown"]).out, /no-mistakes.*retired/);
  assert.doesNotMatch(run(["--help"]).out, /nm-/);
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

test("two devices: the stuck threshold follows FABRIEK_LEASE_MINUTES", () => {
  // a 10 minute lease makes everything silent for over 20 minutes stuck: #3 (59m) and #4 (35m) join #6
  const c = json(TWO_WINDOW, { FABRIEK_LEASE_MINUTES: "10" }).claims;
  assert.deepEqual(c.stuck.issues.map((i) => i.issue), [3, 4, 6]);
});

test("two devices: ready times come from the GitHub timeline (last label at or before the claim)", () => {
  const t = json(TWO_WINDOW).throughput;
  assert.deepEqual(t.issues, [
    { issue: 2, merged_at: "2026-10-09T09:40:00.000Z", ready_source: "github", run_source: "none", waiting_for_claim: 1500, design: 900, implementation: null, pipeline: null, waiting_for_merge: 300, total: 3900 },
    { issue: 1, merged_at: "2026-10-09T10:10:00.000Z", ready_source: "github", run_source: "none", waiting_for_claim: 1800, design: 900, implementation: null, pipeline: null, waiting_for_merge: 1200, total: 7800 },
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
  // No pipeline source, so nothing is pipeline-bound (it was the linked runs' time).
  // #1: dispatcher 08:00-08:30 + 09:20-09:30 + 09:50-10:10 = 3600s, of which B was idle for 08:00-08:30
  //     and 09:50-10:10 = 3000s; total 7800s; agent work is the other 4200s.
  // #2: dispatcher 08:35-09:00 + 09:35-09:40 = 1800s (A holds #6, so never idle); total 3900s; agent 2100s.
  assert.deepEqual(w.issues, [
    { issue: 1, device: "A", ready_source: "github", pipeline_bound: 0, dispatcher_bound: 3600, dispatcher_bound_other_idle: 3000, agent_work: 4200, total: 7800 },
    { issue: 2, device: "B", ready_source: "github", pipeline_bound: 0, dispatcher_bound: 1800, dispatcher_bound_other_idle: 0, agent_work: 2100, total: 3900 },
  ]);
  assert.deepEqual(w.totals, { pipeline_bound: 0, dispatcher_bound: 5400, dispatcher_bound_other_idle: 3000, agent_work: 6300, total: 11700 });
  assert.equal(w.wait_seconds, 5400);
  assert.equal(w.other_idle_pct_of_wait, 55.6);
  assert.equal(w.decision, "B");
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

// ---- a run_started event sets no pipeline time (cbundy/dev-system#343)
// Issues 53 and 54 carry an agent-logged run_started event; 51 and 55 none. Only a transition to
// reviewing (the factory loop v2) starts the pipeline stage; without one the stage times are null.
const LINK_BASE = 1700000000;
const at = (sec) => new Date((LINK_BASE + sec) * 1000).toISOString();
const LINK_WINDOW = ["--repo", "acme/widgets", "--since", at(0), "--until", at(70000)];

test("a run_started event alone sets no pipeline times: they are null, not a number from the events", () => {
  const ev = (sec, state, issue, run = null) => JSON.stringify({ v: 1, ts: at(sec), repo: "acme/widgets", device: "d", state, issue, run_id: run, note: null });
  const story = (issue, t0, steps) => steps.map(([off, state, run]) => ev(t0 + off, state, issue, run));
  const file = path.join(tmp, "link-events.jsonl");
  fs.writeFileSync(file, [
    ...story(51, 10000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [1260, "merge_ready"], [2460, "merged"]]),
    ...story(53, 30000, [[0, "ready"], [60, "claimed"], [360, "delegated"], [680, "run_started", "r8"], [1260, "merge_ready"], [1560, "merged"]]),
  ].join("\n") + "\n");
  const r = json([...LINK_WINDOW, "--events", file]);
  assert.equal(r.throughput.issues.length, 2);
  for (const i of r.throughput.issues) assert.deepEqual([i.run_source, i.implementation, i.pipeline], ["none", null, null], String(i.issue));
  // the run_started event does not make the issue pipeline-bound either
  for (const i of r.waiting.issues) assert.equal(i.pipeline_bound, 0, String(i.issue));
  assert.match(run([...LINK_WINDOW, "--events", file, "--format", "markdown"]).out, /\| run_source \|/);
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
  const rows = Object.fromEntries(json(V2_WINDOW).throughput.issues.map((i) => [i.issue, i]));
  const stages = (i) => [i.run_source, i.design, i.implementation, i.pipeline, i.waiting_for_merge];
  assert.deepEqual(stages(rows[10]), ["transition", 1200, 2400, 720, 480]);
  assert.deepEqual(stages(rows[11]), ["transition", 600, 8400, 2460, 540]);
  // reviewed and intervention events are no progress: #13 is silent since its last transition
  const s = json(V2_WINDOW, { FABRIEK_LEASE_MINUTES: "30" }).claims.stuck.issues.find((i) => i.issue === 13);
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

const sectionsFrom = (r) => {
  // the sources block names the input; the two n/a metrics have no new value; merges, prs, gaps, size and overlap read
  // the new events' pr, by and recovered, so they are n/a under old; scope.events says which file
  const { sources, waiting, adjudicator_agreement, merges, prs, gaps, size, overlap, window, ...rest } = r;
  const { events, ...scope } = window.scope;
  return { ...rest, window: { ...window, scope } };
};

test("source switch: --source old and no flag (env old) print byte-identical json and markdown", () => {
  for (const fmt of ["json", "markdown"]) {
    const a = run([...WINDOW, "--format", fmt]);
    const b = run([...WINDOW, "--format", fmt, "--source", "old"], { FABRIEK_EVALUATE_SOURCE: "" });
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
  const bad = run(WINDOW, { FABRIEK_EVALUATE_SOURCE: "nope" });
  assert.equal(bad.status, 2);
  assert.match(bad.err, /FABRIEK_EVALUATE_SOURCE/);
  const r = json([...WINDOW, "--source", "old"], { FABRIEK_EVALUATE_SOURCE: "new" });
  assert.ok(r.sources.some((s) => s.kind === "events"), "old won");
  assert.ok(!r.sources.some((s) => s.kind === "events-new"));
  assert.match(run(["--help"]).out, /--source old\|new\|shadow\] \[--new-events <file>\]/);
});

test("new source: the local log and a view export give the same report, and it matches old", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-new-"));
  try {
    const f = writeLife(dir);
    const env = {};
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

// ---- merges, PRs and gaps (#749, docs/metrics.md 9c): tests/fixtures/evaluate/v2/new-events.jsonl,
// the new-format events (payload under `data`) of one repo, window 2026-10-16 00:00-12:00Z. #30 is a
// factory merge (01:50) whose reviewing transition and review are logged twice and whose queue:patch
// is logged twice; #31 swaps PR 91 for 92 (a push and a queue:patch) and merges at 03:10; #32 is a
// hand merge seen by a transition (04:59, no pr), an intervention (05:00, no pr) and a recovered
// merged event (05:10); #34 is a hand merge that never names a pr; #35 merges at 10:30; #39 merged the
// day before. #36 parks on a question for an hour, #37 builds throughout, #38 holds two states for
// the same time, #40 is dropped. Judge tasks: k1 (two rows, the later logged first) is overridden by a
// person within the hour, k2 has no issue and failed, k3 is done.
const MERGE_ARGS = [...NEW_WINDOW, "--source", "new", "--new-events", path.join(FIX, "v2", "new-events.jsonl")];

test("merges: one per (issue, pr) across the three signals, counted by who merged and whether it was recovered", () => {
  const m = json(MERGE_ARGS).merges;
  assert.equal(m.total, 5, "#32's three signals are one merge; #39 merged before the window");
  assert.deepEqual(m.by, [
    { by: "factory", recovered: false, count: 3 }, { by: "hand", recovered: true, count: 1 }, { by: "hand", recovered: null, count: 1 },
  ]);
  assert.deepEqual(m.per_day, [
    { day: "2026-10-16", by: "factory", recovered: false, merges: 3 }, { day: "2026-10-16", by: "hand", recovered: true, merges: 1 },
    { day: "2026-10-16", by: "hand", recovered: null, merges: 1 },
  ]);
  assert.deepEqual(m.issues.map((i) => [i.issue, i.pr, i.merged_at, i.by, i.recovered]), [
    [30, 90, "2026-10-16T01:50:00.000Z", "factory", false], [31, 92, "2026-10-16T03:10:00.000Z", "factory", false],
    [32, 93, "2026-10-16T04:59:00.000Z", "hand", true], [34, null, "2026-10-16T08:00:00.000Z", "hand", null],
    [35, 95, "2026-10-16T10:30:00.000Z", "factory", false],
  ]);
});

test("prs: PR open to merge from the first row naming it, PRs per issue, supersedes and head moves, once each", () => {
  const p = json(MERGE_ARGS).prs;
  assert.deepEqual(p.issues, [
    { issue: 30, pr: 90, pr_open_to_merge_seconds: 1800, prs: 1, supersedes: 0, head_moves: 1 },
    { issue: 31, pr: 92, pr_open_to_merge_seconds: 1200, prs: 2, supersedes: 1, head_moves: 2 },
    { issue: 32, pr: 93, pr_open_to_merge_seconds: 2640, prs: 1, supersedes: 0, head_moves: 0 },
    { issue: 34, pr: null, pr_open_to_merge_seconds: null, prs: 0, supersedes: 0, head_moves: 0 },
    { issue: 35, pr: 95, pr_open_to_merge_seconds: 1800, prs: 1, supersedes: 0, head_moves: 0 },
  ]);
  assert.deepEqual(p.pr_open_to_merge_seconds, { median: 1800, max: 2640, total: 7440 }, "the merge with no pr is left out");
  assert.deepEqual([p.prs.max, p.supersedes.max, p.head_moves.max, p.head_moves.median], [2, 1, 2, 0]);
});

test("gaps: the longest gaps between merges, with the issues in flight, their longest state and a parked question", () => {
  const g = json(MERGE_ARGS).gaps;
  assert.equal(g.merges, 5);
  assert.deepEqual(g.gaps.map((x) => [x.gap_seconds, x.before.issue, x.after.issue]), [[10860, 32, 34], [9000, 34, 35], [6540, 31, 32], [4800, 30, 31]]);
  const flight = (n) => g.gaps[n].in_flight.map((i) => `${i.issue}:${i.state}:${i.parked_with_question}`);
  // #32 closed at 04:59 and #30, #31, #40 earlier: none in flight; #36 holds building longest though parked an hour
  assert.deepEqual(flight(0), ["34:building:false", "36:building:true", "37:building:false", "38:building:false"]);
  assert.deepEqual(flight(1), ["34:building:false", "35:reviewing:false", "36:building:false", "37:building:false", "38:building:false"]);
  assert.deepEqual(flight(2), ["31:merge-queue:false", "32:reviewing:false", "36:building:false", "37:building:false", "38:queued:false", "40:building:false"]);
  assert.deepEqual(flight(3), ["30:merge-queue:false", "31:reviewing:false", "37:building:false"]);
});

test("v2 judgement calls count a judge task once per key: wake and latest status, overridden by a person within the hour", () => {
  const tasks = json(MERGE_ARGS).judgement_calls.by_kind.filter((k) => k.kind === "task");
  assert.deepEqual(tasks, [
    { kind: "task", outcome: "merge:done", count: 1, overridden: 0 },
    { kind: "task", outcome: "parked:done", count: 1, overridden: 1 },
    { kind: "task", outcome: "ready:failed", count: 1, overridden: 0 },
  ]);
});

test("merges, prs and gaps read n/a with a reason: no events, one merge, no merge in the window, and under --source old", () => {
  const env = {};
  const absent = json([...NEW_WINDOW, "--source", "new", "--new-events", path.join(tmp, "absent.jsonl")], env);
  for (const k of mod.MERGE_SECTIONS) assert.match(absent[k]["n/a"], /file not found/, k);
  const empty = json(["--repo", "acme/widgets", "--since", "2026-10-17T00:00:00Z", "--until", "2026-10-17T12:00:00Z", ...MERGE_ARGS.slice(NEW_WINDOW.length)], env);
  for (const k of ["merges", "prs", "size", "overlap"]) assert.equal(empty[k]["n/a"], "0 merges in the window", k);
  assert.match(empty.gaps["n/a"], /fewer than 2 merges/);
  const one = json(["--repo", "acme/widgets", "--since", "2026-10-16T00:00:00Z", "--until", "2026-10-16T02:00:00Z", ...MERGE_ARGS.slice(NEW_WINDOW.length)], env);
  assert.equal(one.merges.total, 1);
  assert.equal(one.prs.issues.length, 1);
  assert.match(one.gaps["n/a"], /fewer than 2 merges/);
  const old = json(V2_WINDOW);
  for (const k of mod.MERGE_SECTIONS) assert.equal(old[k]["n/a"], "needs the new events' pr, by and recovered fields", k);
  const md = run([...MERGE_ARGS, "--format", "markdown"], env).out;
  assert.match(md, /\| 31 \| 92 \| 1200 \| 2 \| 1 \| 2 \|/);
  assert.match(md, /\| 2026-10-16T04:59:00.000Z \| 2026-10-16T08:00:00.000Z \| 10860 \| #32 \| #34 \| #34:building #36:building\? #37:building #38:building \|/);
  assert.match(md, /## gaps/);
});

test("normalize leaves out the merge sections, so a shadow run records no difference for them", () => {
  const { normalize } = require("../images/base/evaluate-new-events.js");
  const out = normalize({ window: {}, merges: { total: 1 }, prs: { merges: 1 }, gaps: { merges: 2 }, size: { merges: 1 }, overlap: { merges: 1 }, rounds: { merged_issues: 0 } });
  assert.deepEqual(Object.keys(out).sort(), ["rounds", "window"]);
});

test("new source: metrics that need a v1-only event read n/a, named in sources, never 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-new-"));
  try {
    const f = writeLife(dir);
    const r = json([...NEW_WINDOW, "--source", "new", "--new-events", f.view]);
    assert.match(r.waiting["n/a"], /run_started and parked/);
    assert.match(r.adjudicator_agreement["n/a"], /run_id/);
    const named = r.sources.filter((s) => s.kind === "new-events-n/a").map((s) => s.path);
    assert.deepEqual(named, ["adjudicator_agreement", "waiting"]);
    assert.ok(r.sources.some((s) => s.kind === "new-events-note" && s.path === "first_pass" && /failed/.test(s.note)));
    assert.ok(r.sources.some((s) => s.kind === "source" && s.path === "new"));
    const md = run([...NEW_WINDOW, "--source", "new", "--new-events", f.view, "--format", "markdown"]).out;
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

test("new source: a line of a type or version the shapes file does not list as current is left out and named in sources", () => {
  const { normalize, loadNewEvents } = require("../images/base/evaluate-new-events.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-skipped-"));
  try {
    const src = path.join(FIX, "v2", "new-events.jsonl");
    const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines.find((l) => JSON.parse(l).type === "transition"));
    const extra = [{ ...first, type_version: 2, event_id: "x-1" }, { ...first, type: "mystery", type_version: 1, event_id: "x-2" }];
    const file = path.join(dir, "e.jsonl");
    fs.writeFileSync(file, [...lines, ...extra.map((e) => JSON.stringify(e))].join("\n") + "\n");
    assert.deepEqual(loadNewEvents(file).skipped, [{ type: "mystery", type_version: 1, count: 1 }, { type: "transition", type_version: 2, count: 1 }]);
    assert.deepEqual(loadNewEvents(src).skipped, []);
    assert.deepEqual(loadNewEvents(path.join(dir, "absent.jsonl")).skipped, []);
    const env = {};
    const base = json([...MERGE_ARGS], env);
    const got = json([...NEW_WINDOW, "--source", "new", "--new-events", file], env);
    assert.deepEqual(normalize(got), normalize(base), "neither line counts in any metric");
    assert.deepEqual(got.sources.filter((s) => s.kind === "new-events-skipped"), [
      { kind: "new-events-skipped", path: "mystery v1", found: false, rows: 1 },
      { kind: "new-events-skipped", path: "transition v2", found: false, rows: 1 },
    ]);
    assert.deepEqual(base.sources.filter((s) => s.kind === "new-events-skipped"), []);
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
    const base = { CALLUM_EVENTS_DIR: evDir, DEV_MACHINE_NAME: "m" };
    const kinds = (r) => r.sources.map((s) => s.kind);
    for (const v of [undefined, ""]) {
      const env = { ...base, ...(v === undefined ? { FABRIEK_EVALUATE_SOURCE: undefined } : { FABRIEK_EVALUATE_SOURCE: v }) };
      const r = json([...NEW_WINDOW], env);
      assert.ok(r.sources.some((s) => s.kind === "source" && s.path === "new"), `variable ${JSON.stringify(v)} reads new`);
      assert.ok(kinds(r).includes("new-events-n/a"));
    }
    assert.equal(fs.existsSync(path.join(evDir, "factory", ".shadow", "evaluate.jsonl")), false, "no shadow record");
    const viaFlag = json([...NEW_WINDOW, "--source", "old"], { ...base, FABRIEK_EVALUATE_SOURCE: "" });
    const viaVar = json([...NEW_WINDOW], { ...base, FABRIEK_EVALUATE_SOURCE: "old" });
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
    const env = { CALLUM_EVENTS_DIR: evDir, FABRIEK_EVALUATE_SOURCE: "shadow", DEV_MACHINE_NAME: "m" };
    const record = () => fs.readFileSync(path.join(evDir, "factory", ".shadow", "evaluate.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const oldOut = run([...NEW_WINDOW], { ...env, FABRIEK_EVALUATE_SOURCE: "old" });
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
    assert.match(dirNew.err, /fabriek-evaluate: cannot read .*EISDIR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- --regime and the by_regime breakdowns (docs/metrics.md, "Offline computation"). The events and
// transcripts are built here from one table, so the local log and the view export are the same events.
const RG_WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-20T00:00:00Z", "--until", "2026-10-21T00:00:00Z"];

function writeRegime(dir) {
  const ev = (n, ts, type, issue, session, regime, data = {}) => ({
    envelope: 1, event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, ts: `2026-10-20T${ts}:00.000Z`, type, type_version: 1,
    repo: "acme/widgets", device: "L", actor: "agent", ...(session === undefined ? {} : { session_id: session }),
    ...(regime === undefined ? {} : { regime }), issue, data,
  });
  const events = [
    ev(1, "10:00", "claimed", 1, "S-tb", "testbed", { lease_minutes: 120 }),
    ev(2, "10:30", "merged", 1, "S-tb", "testbed", { pr: 11, by: "factory", recovered: false }),
    ev(3, "11:00", "claimed", 2, "S-sw", "manual", { lease_minutes: 120 }),
    ev(4, "11:10", "closed", 2, "S-sw", "manual"),
    ev(5, "12:00", "claimed", 3, "S-sw", "factory_loop_v2", { lease_minutes: 120 }),
    ev(6, "12:10", "claimed", 4, "S-sw", "factory_loop_v2", { lease_minutes: 120 }),
    ev(7, "12:30", "merged", 3, "S-sw", "factory_loop_v2", { pr: 13, by: "factory", recovered: false }),
    ev(8, "13:00", "claimed", 5, undefined, undefined, { lease_minutes: 120 }), // written before regime existed
    ev(9, "13:30", "merged", 5, null, "", { pr: 15, by: "factory", recovered: false }), // empty regime reads as unknown
  ];
  const local = path.join(dir, "ev", "factory", "acme__widgets.jsonl");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  // a factory.event_log row_to_json export: flat columns, regime and session_id null when unset
  const view = path.join(dir, "view.jsonl");
  fs.writeFileSync(view, `${events.map((e, i) => JSON.stringify({ id: i + 1, session_id: null, regime: null, ...e })).join("\n")}\n`);
  const proj = path.join(dir, "projects", "-rg");
  const turn = (id, ts) => JSON.stringify({ type: "assistant", timestamp: `2026-10-20T${ts}:00Z`, requestId: id,
    message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } });
  const put = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${lines.join("\n")}\n`); };
  put(path.join(proj, "S-tb.jsonl"), [turn("a1", "10:05"), turn("a2", "10:20")]);
  put(path.join(proj, "S-tb", "subagents", "agent-x.jsonl"), [turn("b1", "10:10")]);
  fs.writeFileSync(path.join(proj, "S-tb", "subagents", "agent-x.meta.json"), JSON.stringify({ agentType: "callum-flow:implementer" }));
  put(path.join(proj, "S-sw.jsonl"), [turn("c1", "10:50"), turn("c2", "11:30"), turn("c3", "12:20")]);
  put(path.join(proj, "S-none.jsonl"), [turn("d1", "13:00")]);
  return { local, view, evDir: path.join(dir, "ev"), projects: path.join(dir, "projects", "-rg") };
}

const rgOf = (r, k) => Object.fromEntries(r[k].by_regime.map((x) => [x.regime, x]));
const spendTurns = (rows) => Object.fromEntries(rows.map((x) => [`${x.role}|${x.model}`, x.turns]));

test("regime: by_regime breakdowns, attribution through the session, and the filter, on the local log and the view export alike", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-regime-"));
  try {
    const f = writeRegime(dir);
    const env = { CALLUM_EVENTS_DIR: f.evDir };
    const base = [...RG_WINDOW, "--projects-dir", f.projects];
    const local = json([...base, "--source", "new"], env);
    const view = json([...base, "--source", "new", "--new-events", f.view], env);
    assert.equal(local.window.regime, "all");
    assert.equal(local.throughput.merged_issues, 3);
    assert.deepEqual(local.throughput.by_regime, [
      { regime: "factory_loop_v2", merged_issues: 1, closed_issues: 0, claims: 2 },
      { regime: "manual", merged_issues: 0, closed_issues: 1, claims: 1 },
      { regime: "testbed", merged_issues: 1, closed_issues: 0, claims: 1 },
      { regime: "unknown", merged_issues: 1, closed_issues: 0, claims: 1 },
    ]);
    // the view export's null session_id and regime read as unknown; its session-less rows give the same unknown numbers
    assert.equal(view.throughput.merged_issues, 3);
    assert.deepEqual(view.throughput.by_regime, local.throughput.by_regime);
    assert.deepEqual(view.spend.by_regime, local.spend.by_regime);
    // turns: S-tb and its sub-agent are testbed; S-sw is manual until 12:00 (its first turn, before every event, takes the first regime), then factory_loop_v2; S-none is unknown
    const spend = Object.fromEntries(local.spend.by_regime.map((g) => [g.regime, spendTurns(g.rows)]));
    assert.deepEqual(spend, {
      factory_loop_v2: { "orchestrator|claude-opus-5-5": 1 },
      manual: { "orchestrator|claude-opus-5-5": 2 },
      testbed: { "callum-flow:implementer|claude-opus-5-5": 1, "orchestrator|claude-opus-5-5": 2 },
      unknown: { "orchestrator|claude-opus-5-5": 1 },
    });
    assert.deepEqual(local.spend.by_regime.map((g) => g.regime), ["factory_loop_v2", "manual", "testbed", "unknown"]);
    // the rows across regimes add up to spend.rows
    const total = {};
    for (const g of local.spend.by_regime) for (const [k, n] of Object.entries(spendTurns(g.rows))) total[k] = (total[k] || 0) + n;
    assert.deepEqual(total, spendTurns(local.spend.rows));
    for (const [regime, want] of Object.entries({
      factory_loop_v2: [1, 2, 1], manual: [0, 1, 2], testbed: [1, 1, 3], unknown: [1, 1, 1],
    })) {
      const r = json([...base, "--source", "new", "--regime", regime], env);
      assert.equal(r.window.regime, regime);
      assert.equal(r.throughput.merged_issues, want[0], regime);
      assert.equal(r.claims.reclaimed, 0);
      assert.equal(r.per_device[0] ? r.per_device[0].claims : 0, want[1], regime);
      assert.equal(sum(r.spend.rows.map((x) => x.turns)), want[2], regime);
      assert.ok(!("by_regime" in r.throughput) && !("by_regime" in r.spend), regime);
    }
    // markdown shows the tables; two runs are byte-identical
    const md = run([...base, "--source", "new", "--format", "markdown"], env);
    assert.match(md.out, /\| regime \| merged_issues \| closed_issues \| claims \|/);
    assert.match(md.out, /Spend for regime testbed:/);
    assert.equal(run([...base, "--source", "new", "--format", "markdown"], env).out, md.out);
    assert.equal(run([...base, "--source", "new"], env).out, run([...base, "--source", "new"], env).out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sum(xs) { return xs.reduce((a, b) => a + b, 0); }

test("regime: an unknown or missing value exits 2 with the usage line; old-source records read as unknown", () => {
  for (const args of [["--regime", "bogus"], ["--regime"]]) {
    const r = run([...WINDOW, ...args]);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.err, /--regime/);
    assert.match(r.err, /\[--regime <value>\]/);
  }
  const r = json(WINDOW);
  assert.equal(r.window.regime, "all");
  assert.deepEqual(r.throughput.by_regime.map((x) => [x.regime, x.merged_issues]), [["unknown", r.throughput.merged_issues]]);
  assert.deepEqual(r.spend.by_regime.map((g) => g.regime), ["unknown"]);
  assert.deepEqual(r.spend.by_regime[0].rows, r.spend.rows);
});

test("regime: spend counts only the turns of the regime; normalize drops both by_regime keys", () => {
  const files = [{ role: "orchestrator", turns: [{ model: "m", regime: "testbed", usage: { input: 1, output: 1, cache_read: 0, cache_creation: 0 } }] }];
  assert.deepEqual(mod.computeSpend(files, "testbed").map((x) => x.role), ["orchestrator"]);
  assert.deepEqual(mod.computeSpend(files, "unknown"), []);
  assert.deepEqual(mod.computeSpend(files).map((x) => x.role), ["orchestrator"]);
  const { normalize } = require("../images/base/evaluate-new-events.js");
  const out = normalize({ throughput: { merged_issues: 1, by_regime: [] }, spend: { rows: [], by_regime: [] } });
  assert.deepEqual(out, { throughput: { merged_issues: 1 }, spend: { rows: [] } });
});

// ---- issue size, overlap and merges by kind (#1219, docs/metrics.md 9c): tests/fixtures/evaluate/v2/size-overlap-events.jsonl.
// The story, all on 2026-10-20 (acme/widgets): 101 (A) and 102 (B) have windows that overlap and share
// src/shared.js and docs/guide.md; A also changes package-lock.json. 103 (C) is later and touches shared.js too.
// 106 (D) shares shared.js with A but its window only ends where A's begins; it overlaps 107 (Z, merged the
// day before, so outside the window) on lib/old.js. 104 (E) has no files, 105 (F) no file_lines, 108 (G) was never
// claimed, 109 (H) is a hand merge whose window meets C's without a shared file. Two merged events name no issue
// (the sweep's, one logged twice).
const SIZE_FIXTURE = path.join(FIX, "v2", "size-overlap-events.jsonl");
const SIZE_WINDOW = ["--repo", "acme/widgets", "--since", "2026-10-20T00:00:00Z", "--until", "2026-10-21T00:00:00Z", "--source", "new"];
const sizeRun = (file, extra = []) => json([...SIZE_WINDOW, "--new-events", file, ...extra]);
const rewrite = (name, f) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, fs.readFileSync(SIZE_FIXTURE, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.stringify(f(JSON.parse(l)))).join("\n") + "\n");
  return file;
};

test("size: counts, medians and p90 over the merges with files; the lockfile and documents are left out of the code lines", () => {
  const { size } = sizeRun(SIZE_FIXTURE);
  assert.deepEqual([size.merges, size.known, size.code_lines_known], [8, 7, 6], "E has no files, F no file_lines");
  assert.deepEqual(size.files, { median: 2, p90: 4 });
  assert.deepEqual(size.lines, { median: 10, p90: 192 });
  assert.deepEqual(size.code_files, { median: 2, p90: 3 });
  assert.deepEqual(size.code_lines, { median: 16, p90: 37 });
  const a = size.issues.find((i) => i.issue === 101);
  assert.deepEqual(a, { issue: 101, pr: 201, files: 4, lines: 192, code_files: 2, code_lines: 37 }, "package-lock.json (150 lines) and guide.md are not code");
  assert.deepEqual(size.issues.find((i) => i.issue === 104), { issue: 104, pr: 204, files: null, lines: null, code_files: null, code_lines: null });
  assert.deepEqual(size.issues.find((i) => i.issue === 105), { issue: 105, pr: 205, files: 2, lines: 10, code_files: 1, code_lines: null });
});

test("overlap: windows that meet and share a code file; the hottest files hold code only", () => {
  const { overlap } = sizeRun(SIZE_FIXTURE);
  assert.deepEqual([overlap.merges, overlap.overlapping, overlap.share], [7, 3, 0.429]);
  const flags = Object.fromEntries(overlap.issues.map((i) => [i.issue, i.overlaps]));
  assert.deepEqual(flags, { 101: [102], 102: [101], 103: [], 105: [], 106: [107], 108: [], 109: [] },
    "A and B; D with Z (merged before the window); not D with A (windows only touch), nor C with H (no shared file)");
  assert.deepEqual(overlap.issues.filter((i) => i.overlapping).map((i) => i.issue), [106, 101, 102]);
  assert.deepEqual(overlap.hottest_files, [{ path: "src/shared.js", issues: 2 }, { path: "lib/old.js", issues: 1 }], "docs/guide.md is shared but not code");
});

test("merges.per_day_by_kind counts unlinked merges, a retried one once; per_day is unchanged", () => {
  const { merges } = sizeRun(SIZE_FIXTURE);
  assert.deepEqual(merges.per_day_by_kind, [
    { day: "2026-10-20", kind: "factory", merges: 6 },
    { day: "2026-10-20", kind: "hand", merges: 1 },
    { day: "2026-10-20", kind: "unlinked", merges: 3 },
  ], "G was never claimed; the sweep's two prs, 300 logged twice");
  assert.deepEqual(merges.per_day, [{ day: "2026-10-20", by: "factory", recovered: false, merges: 7 }, { day: "2026-10-20", by: "hand", recovered: false, merges: 1 }]);
  assert.equal(merges.total, 8);
});

test("size, overlap and the kind table render as markdown", () => {
  const md = run([...SIZE_WINDOW, "--new-events", SIZE_FIXTURE, "--format", "markdown"]).out;
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings.slice(headings.indexOf("gaps"), headings.indexOf("gaps") + 3), ["gaps", "size", "overlap"]);
  assert.match(md, /\| code_lines \| 16 \| 37 \|/);
  assert.match(md, /\| 101 \| 201 \| 4 \| 192 \| 2 \| 37 \|/);
  assert.match(md, /\| 106 \| 206 \| true \| #107 \|/);
  assert.match(md, /\| src\/shared\.js \| 2 \|/);
  assert.match(md, /\| 2026-10-20 \| unlinked \| 3 \|/);
});

test("size and overlap: no files anywhere reads n/a with a reason; no file_lines reads n/a for the code-only line stats only", () => {
  const bare = sizeRun(rewrite("no-files.jsonl", (e) => {
    if (e.type === "merged") for (const k of ["files", "file_lines", "additions", "deletions"]) delete e.data[k];
    return e;
  }));
  for (const k of ["size", "overlap"]) assert.equal(bare[k]["n/a"], "no merge in the window has files (recorded from #752's release on)", k);
  assert.equal(bare.merges.total, 8, "the other sections are unaffected");
  const noLines = sizeRun(rewrite("no-file-lines.jsonl", (e) => {
    if (e.type === "merged" && e.data.file_lines) e.data.file_lines = null;
    return e;
  }));
  assert.equal(noLines.size.code_lines["n/a"], "no known merge has file_lines");
  assert.equal(noLines.size.code_lines_known, 0);
  assert.deepEqual(noLines.size.files, { median: 2, p90: 4 }, "every other stat is still reported");
  assert.equal(noLines.size.issues.find((i) => i.issue === 101).code_files, 2);
  assert.equal(noLines.overlap.overlapping, 3);
  const md = run([...SIZE_WINDOW, "--new-events", path.join(tmp, "no-file-lines.jsonl"), "--format", "markdown"]).out;
  assert.match(md, /\| code_lines \| n\/a \| no known merge has file_lines \|/);
});

test("a merged event's size fields are record fields, null when absent or of the wrong type, and other states do not get them", () => {
  const { mapEvent } = require("../images/base/evaluate-new-events.js");
  const merged = (data) => mapEvent({ type: "merged", ts: "2026-10-20T01:00:00Z", issue: 1, repo: "acme/widgets", data: { pr: 1, by: "factory", recovered: false, ...data } })[0];
  const full = merged({ files: ["a.js"], file_lines: [{ path: "a.js", additions: 1, deletions: 2 }, { path: "bad", additions: "x", deletions: 0 }], additions: 1, deletions: 2 });
  assert.deepEqual([full.files, full.file_lines, full.additions, full.deletions], [["a.js"], [{ path: "a.js", additions: 1, deletions: 2 }], 1, 2], "an entry with bad counts is left out");
  assert.doesNotMatch(full.note, /files|additions/, "not note tokens");
  const wrong = merged({ files: "a.js", file_lines: { a: 1 }, additions: "3", deletions: -1 });
  assert.deepEqual([wrong.files, wrong.file_lines, wrong.additions, wrong.deletions], [null, null, null, null]);
  const bare = merged({});
  assert.deepEqual([bare.files, bare.file_lines, bare.additions, bare.deletions], [null, null, null, null]);
  const other = mapEvent({ type: "claimed", ts: "2026-10-20T01:00:00Z", issue: 1, repo: "acme/widgets", data: { files: ["a.js"] } })[0];
  assert.ok(!("files" in other) && !("additions" in other));
});

test("the two MERGE_SECTIONS lists are equal and TOP_KEYS places size and overlap after gaps", () => {
  assert.deepEqual(require("../images/base/evaluate-new-events.js").MERGE_SECTIONS, mod.MERGE_SECTIONS);
  assert.deepEqual(mod.TOP_KEYS.slice(mod.TOP_KEYS.indexOf("merges"), mod.TOP_KEYS.indexOf("merges") + 5), ["merges", "prs", "gaps", "size", "overlap"]);
});

test("size and overlap read n/a under --source old, with the merge sections' reason", () => {
  const old = json(V2_WINDOW);
  for (const k of ["size", "overlap"]) assert.equal(old[k]["n/a"], "needs the new events' pr, by and recovered fields", k);
});
