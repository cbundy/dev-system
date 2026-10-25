"use strict";

// Every native event the factory loop builds for its own record (docs/factory-loop/v2/SPEC.md 13.7.4,
// DECISIONS D-09) must be one callum-flow-event takes: a loop_entry for an entry of every logged kind
// (ledger.ts loopEvent, derive.ts loopEntryArgv) and a loop_passes for the minute's pass summary
// (passes.ts passesEventArgv). One refused is a usage error the loop only notes. This runs the real
// images/base/callum-flow-event into a scratch CALLUM_EVENTS_DIR, and holds each line's data to what
// the translator makes of the old `loop` line (the note from derive.ts loopNote, passes.ts
// passesNote). Plugin tests cannot run a command or load the image's translator, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts" (scripts/factory-loop-replay.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const ROOT = path.join(__dirname, "..");
const HOOKS = path.join(ROOT, "plugins", "factory-loop", "hooks");
const EVENT = path.join(ROOT, "images", "base", "callum-flow-event");
const NOW = Date.UTC(2026, 9, 13, 3, 0);
const BRIEF = "https://github.com/cbundy/dev-system/issues/470#issuecomment-9001";
const RUN = "01K7S1AAAAAAAAAAAAAAAAAAAA";

let ledger;
let derive;
const { translate } = require(path.join(__dirname, "..", "images", "base", "factory-event-translate.js"));
let passes;
let dir;

before(async () => {
  ledger = await import(path.join(HOOKS, "ledger.ts"));
  passes = await import(path.join(HOOKS, "passes.ts"));
  derive = await import(path.join(HOOKS, "derive.ts"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-events-"));
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

// log: the argv run by the real callum-flow-event, into the scratch log only.
function log(argv) {
  assert.equal(argv[0], "callum-flow-event");
  return spawnSync("sh", [EVENT, ...argv.slice(1)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
  });
}

const base = { class: "free", rule: "test", issue: 470, run: null, pr: null, head: null, attempts: 1, startedAt: NOW - 600_000, endedAt: NOW };
const entries = [
  { ...base, key: `i470/l1/s3/review/a1`, kind: "agent-step", class: "drive", rule: "S2", step: "review", run: RUN, head: "abc1234", status: "running", endedAt: null, agentId: "agent-2" },
  { ...base, key: `i470/l1/s4/fix/a1`, kind: "agent-step", class: "drive", rule: "S2", step: "fix", pr: 512, head: "abc1234", status: "failed", summary: "agent failed: it said\nno" },
  { ...base, key: "judge:sequence:512:abc1234", kind: "judge", class: "drive", rule: "M5", pr: 512, head: "abc1234", wake: "sequence", status: "done", wakeId: "w9", outcome: { kind: "wake", decision: "merge", reason: "nothing waits", instructions: null, bump: "minor", bumpReason: null, fields: {} } },
  { ...base, key: `judge:report:brief:470:${BRIEF}`, kind: "judge", class: "drive", rule: "D3", wake: "report", status: "done", outcome: { kind: "wake", decision: "parsed", reason: null, instructions: null, bump: null, bumpReason: null, fields: { brief: BRIEF, created: [], pendingDecision: false } } },
  { ...base, key: "task:respond-stuck:01K7S1AAAAAAAAAAAAAAAAAAAA:park@1791860000000:abc1234", kind: "task", class: "drive", rule: "P3a", wake: "respond-stuck", status: "timed-out" },
  { ...base, key: "task:redrive:issue-470-x:abc", kind: "task", class: "drive", rule: "P3a", wake: "redrive", status: "done", wakeId: "w3", outcome: { kind: "wake", decision: "hold", reason: "r ".repeat(150), instructions: null, bump: null, bumpReason: null, fields: {} } },
  { ...base, key: "task:redrive:issue-470-y:abc", kind: "task", class: "drive", rule: "P3a", wake: "redrive", status: "done", wakeId: "w4", outcome: { kind: "wake", decision: "hold", reason: "50% of a long é reason", instructions: null, bump: null, bumpReason: null, fields: {} } },
  { ...base, key: "tell:flake-bug:x", kind: "tell", class: "owner", rule: "F1", wake: "flake-bug", status: "running", endedAt: null, loopData: { decision: "held", filed_issue: 901 } },
  { ...base, key: "tell:heartbeat-other:1791860405000", kind: "tell", class: "owner", rule: "O2", issue: null, wake: "heartbeat-other", status: "running", endedAt: null, session: "session-1" },
];

const TOKEN_NULLS = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, model: null, cost_usd: null };
const LINE = { event_id: "0d7b2f3a-1c4e-4a5b-8c9d-0e1f2a3b4c5d", repo: "cbundy/dev-system", device: "box", actor: "agent" };
const TS = "2026-10-13T03:00:00.000Z";
const oldTranslated = (e) => {
  const line = { ...LINE, state: "loop", issue: e.issue, run: e.run, pr: e.pr, head: e.head, note: derive.loopNote(e) };
  const r = translate(line, { ts: TS, sessionId: "s", data: e.loopData });
  assert.ok(r.event, `the old line of ${e.key} translates: ${JSON.stringify(r)}`);
  return r.event;
};
const newLines = () => {
  const file = path.join(dir, "factory", "cbundy__dev-system.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const oldLogPath = () => path.join(dir, "cbundy__dev-system.jsonl");

test("every logged entry kind is one native loop_entry the real writer takes, with the data the translator makes of its old line", () => {
  for (const e of entries) {
    const argv = ledger.loopEvent(e);
    if (e.kind === "judge") {
      assert.equal(argv, null, "a judge has no event type");
      continue;
    }
    assert.ok(Array.isArray(argv), `${e.key} logs an event`);
    assert.deepEqual(argv.slice(0, 4).filter((_, i) => i !== 3), ["callum-flow-event", "--type", "loop_entry"]);
    for (const flag of ["--note", "--run", "--pr", "--head"]) assert.ok(!argv.includes(flag), `${e.key} carries ${flag}`);
    const before = newLines().length;
    const r = log(argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stderr, "", `${e.key} warned: ${r.stderr}`);
    const lines = newLines();
    assert.equal(lines.length, before + 1, "one line");
    const got = lines[lines.length - 1];
    assert.equal(got.type, "loop_entry");
    assert.equal(got.issue, e.issue);
    // the token fields have no old equivalent: an agent step's event has them, null without a reading
    const { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, cost_usd, ...rest } = got.data;
    assert.deepEqual(rest, oldTranslated(e).data);
    const tokens = { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, cost_usd };
    if (e.kind === "agent-step") assert.deepEqual(tokens, TOKEN_NULLS, `${e.key} has the six fields, null`);
    else assert.deepEqual(Object.values(tokens), Array(6).fill(undefined), `${e.key} has none`);
  }
  assert.ok(!fs.existsSync(oldLogPath()), "nothing goes to the old log");
});

test("an ended agent step with a reading writes its token totals and model through the real writer; a running one writes nulls", () => {
  const ended = { ...entries[1], key: "i470/l1/s5/review/a2", status: "done", agentId: "agent-9" };
  const reading = { input_tokens: 12, output_tokens: 3456, cache_read_tokens: 789012, cache_creation_tokens: 0, model: "claude-opus-5-5", cost_usd: 0.012345 };
  const lines = [];
  for (const argv of [ledger.loopEvent(ended, reading), ledger.loopEvent({ ...ended, status: "running", endedAt: null }, reading)]) {
    const before = newLines().length;
    const r = log(argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stderr, "", "strict validation passes");
    lines.push(newLines()[before]);
  }
  assert.deepEqual(Object.fromEntries(Object.keys(reading).map((k) => [k, lines[0].data[k]])), reading);
  assert.equal(lines[0].data.agent_id, "agent-9");
  // a running event never carries a reading, even when handed one
  assert.deepEqual(Object.fromEntries(Object.keys(reading).map((k) => [k, lines[1].data[k]])), TOKEN_NULLS);
});

test("the wake entries' decision and reason come through as the translator reads them", () => {
  const long = newLines().find((l) => l.data.key === "task:redrive:issue-470-x:abc");
  assert.equal(long.data.decision, "hold");
  assert.ok(long.data.decision_reason.endsWith("..."));
  assert.ok(long.data.decision_reason.length <= 200);
  const enc = newLines().find((l) => l.data.key === "task:redrive:issue-470-y:abc");
  assert.equal(enc.data.decision_reason, "50% of a long é reason");
  const tell = newLines().find((l) => l.data.key === "tell:flake-bug:x");
  assert.equal(tell.data.filed_issue, 901);
});

test("the minute's pass summary is a native loop_passes the real writer takes, with the data the translator makes of the note", () => {
  const settings = { mode: "act", passEveryMs: 60_000 };
  const book = new Map();
  passes.notePass(book, NOW + 1_000, 120, true, false);
  passes.notePass(book, NOW + 2_000, 80, false, true);
  passes.notePass(book, NOW + 3_000, 90, false, false, { ms: 12.6, commandsMs: 7.1, inProcessMs: 5.5 }, "slow", false);
  passes.notePass(book, NOW + 4_000, 70, false, false, null, "stop-new", false);
  passes.notePass(book, NOW + 5_000, 60, false, true);
  for (const summary of [passes.closeMinute(book, NOW, settings), passes.closeMinute(book, NOW + 60_000, settings)]) {
    const argv = passes.passesEventArgv(summary);
    assert.deepEqual(argv.slice(0, 3), ["callum-flow-event", "--type", "loop_passes"]);
    assert.equal(argv.length, 5);
    const before = newLines().length;
    const r = log(argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stderr, "");
    const lines = newLines();
    assert.equal(lines.length, before + 1);
    const got = lines[lines.length - 1];
    assert.equal(got.type, "loop_passes");
    const old = translate({ ...LINE, state: "loop", note: passes.passesNote(summary) }, { ts: TS, sessionId: "s" }).event;
    // the four orchestrator token fields (#1302) are native only: the note has none, and they are null here
    // the usage tier fields are native only too: the last pass with a plan, null for an empty minute
    const { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, usage_tier, usage_tier_overridden, ...rest } = got.data;
    assert.deepEqual([input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens], [null, null, null, null]);
    const tiered = summary.passes > 0;
    assert.deepEqual([usage_tier, usage_tier_overridden], tiered ? ["stop-new", false] : [null, null]);
    assert.deepEqual(rest, old.data);
  }
  assert.ok(!fs.existsSync(oldLogPath()), "nothing goes to the old log");
});

test("no hooks file builds a `callum-flow-event loop` argv", () => {
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name));
      else if (f.name.endsWith(".ts") && /'callum-flow-event',\s*'loop'|\['loop'/.test(fs.readFileSync(path.join(d, f.name), "utf8"))) hits.push(path.join(d, f.name));
    }
  };
  walk(HOOKS);
  assert.deepEqual(hits, []);
});
