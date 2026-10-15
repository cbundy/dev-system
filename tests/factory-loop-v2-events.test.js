"use strict";

// Every event the factory loop v2 writes (docs/factory-loop/v2/SPEC.md 7.1) is built by
// plugins/factory-loop/hooks/v2/events.ts, and must be one the real images/base/callum-flow-event
// takes: a refused one is a usage error the loop only notes, and its fact is lost. This runs the
// real CLI into a scratch log with an event of every kind v2 writes, then reads each line back
// with events.ts's own parser, as record.ts and the factory tools do, so the format survives the
// trip through the log's JSON. Plugin tests cannot run a command, so this lives here.
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
const EVENTS = path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "events.ts");
const EVENT = path.join(ROOT, "images", "base", "callum-flow-event");
const NOW = Date.UTC(2026, 9, 15, 9, 30);

let ev;
let dir;

before(async () => {
  ev = await import(EVENTS);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-v2-events-"));
});

after(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

// log: the argv run by the real callum-flow-event, into the scratch log only; the line written.
function log(argv) {
  assert.equal(argv[0], "callum-flow-event");
  const file = path.join(dir, "cbundy__dev-system.jsonl");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  const r = spawnSync("sh", [EVENT, ...argv.slice(1)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: "cbundy/dev-system", DEV_MACHINE_NAME: "box", CLAUDE_SESSION_ID: "s", DEV_VERSIONS_FILE: path.join(dir, "none.json") },
  });
  assert.equal(r.status, 0, `${argv.slice(0, 2).join(" ")} was refused: ${r.stderr}`);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, before + 1, "one line per event");
  return JSON.parse(lines[lines.length - 1]);
}

const record = (over) => ({
  issue: 571,
  life: "ss1x2k",
  seq: 7,
  seqAt: NOW - 60_000,
  state: "parked",
  since: NOW - 60_000,
  resumeTo: "building",
  branch: "issue-571",
  pr: 621,
  head: "abc1234def5678abc1234def5678abc1234def56",
  approvedPatch: null,
  brief: "https://github.com/cbundy/dev-system/issues/571#issuecomment-1",
  step: null,
  attempt: 1,
  cut: false,
  triages: 2,
  fixes: 0,
  round: 1,
  question: "The builder says it cannot: the API it needs is gone. Drop it, or point it at the new one?",
  why: null,
  notes: ["the owner: keep it small", "a, b and none"],
  prClosedAt: null,
  lives: 1,
  ...over,
});

const events = () => [
  { state: "transition", record: record(), row: "T7", from: "building", via: "not-ok" },
  { state: "transition", record: record({ state: "queued", seq: 0, pr: null, head: null, resumeTo: null, step: "lease", question: null, notes: [] }), row: "S0", from: null, via: "claim" },
  { state: "transition", record: record({ state: "closed", why: "merged", step: null, question: null }), row: "T13", from: "merge-queue", via: "ok" },
  { state: "transition", record: record({ notes: Array.from({ length: 30 }, (_, i) => `note ${i} with 100% of it`) }), row: "U4", from: "building", via: "unknown" },
  { state: "reviewed", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", verdict: "changes", round: 2, patch: "3fa2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4", errors: 1, warnings: 2, infos: 0, reviewer: "adjudicator", answer: "/home/x/.claude/factory-loop/o__r/answers/i571_review.json" },
  ev.intervention("loop", "unknown:timeout", "i571/lss1x2k/s7/t", "the build ran past 90 minutes", { issue: 571, life: "ss1x2k", pr: null }),
  ev.intervention("person", "op:mode", "op/fleet/mode-act", "mode act", { issue: null, life: null, pr: null }),
  ev.intervention("person", "control-file", "control-file/fleet/lss2", "control.json changed with no op: paused #571", { issue: 571, life: null, pr: null }),
  { state: "reclaimed", issue: 533, branch: "issue-533", pr: null, stage: "queued", checked: "no live step: no slot, no run, no PR activity in 6 h", reason: "reconcile", outcome: "requeue", lives: 2 },
  { state: "abandoned", issue: 589, branch: "fix/issue-589-x", pr: 626, stage: "in pipeline", checked: "no run updated since 02:35", reason: "reconcile", outcome: "leave", lives: null },
  { state: "abandoned", issue: 590, branch: "issue-590", pr: null, stage: "implementing", checked: "a live claim with no record", reason: "reconcile", outcome: "reject", lives: 3 },
  { state: "abandoned", issue: 600, branch: "issue-600", pr: null, head: null, note: "split into 601,602" },
  { state: "delegated", issue: 571, branch: "issue-571", pr: null, head: null, note: "brief https://github.com/cbundy/dev-system/issues/571#issuecomment-1" },
  { state: "fix_requested", issue: 571, branch: "issue-571", pr: 621, head: null, note: "ci" },
  { state: "merge_ready", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "approved" },
  { state: "verdict", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "WRONG: r2-1 the test already covers it" },
  { state: "merged", issue: 571, branch: "issue-571", pr: 621, head: "abc1234", note: "merged by the loop; its log was lost" },
];

test("every event v2 builds is one callum-flow-event takes, and reads back from the log as it went in", () => {
  for (const e of events()) {
    const line = log(ev.eventArgv(e));
    assert.equal(line.state, e.state);
    const row = { state: line.state, issue: line.issue, branch: line.branch, pr: line.pr, head: line.head, note: line.note };
    const back = ev.parseEvent(row);
    if (e.state === "transition" && e.record.notes.length > 10) {
      // clipped to fit: the identifying fields come back, the notes are cut from the end
      assert.ok(line.note.length <= ev.NOTE_MAX);
      assert.equal(back.record.seq, e.record.seq);
      assert.equal(back.record.state, e.record.state);
      assert.ok(back.record.notes.length < e.record.notes.length);
      continue;
    }
    // the log keeps an empty note as null; the parser reads it as empty
    assert.deepEqual(back, e, `${e.state} did not read back`);
  }
});

test("a fixer's verdict is logged as the fixer; every other event as the CLI's default actor", () => {
  for (const e of events()) {
    const line = log(ev.eventArgv(e));
    assert.equal(line.actor, e.state === "verdict" ? "fixer" : "agent", e.state);
  }
});

test("the operator's hand-recorded rescue, as the playbook writes it, reads as a person intervention", () => {
  const line = log(["callum-flow-event", "intervention", "--issue", "571", "--note", "who=person cause=rescue reason=patched%20the%20trust%20file"]);
  assert.deepEqual(ev.parseIntervention({ ...line, run: undefined }), {
    state: "intervention",
    who: "person",
    cause: "rescue",
    reason: "patched the trust file",
    issue: 571,
    life: null,
    pr: null,
    fact: "",
  });
});
