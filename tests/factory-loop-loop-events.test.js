"use strict";

// Every `loop` event the factory loop builds (docs/factory-loop/SPEC.md 7.4, DECISIONS D-09) must
// pass callum-flow-event's own check of a loop note (kind=, key= and status=, no field split by a
// space): one refused is a usage error the loop only notes. This runs the real
// images/base/callum-flow-event, into a scratch log, with the notes the plugin builds for an entry
// of every loop kind (ledger.ts loopEvent), a rate-cap hold (act.ts capEventArgv) the ping
// breaker (act.ts breakerEventArgv) and the minute's pass summary (passes.ts). Plugin tests cannot run a command, so this lives here.
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
let act;
let passes;
let dir;

before(async () => {
  ledger = await import(path.join(HOOKS, "ledger.ts"));
  passes = await import(path.join(HOOKS, "passes.ts"));
  act = await import(path.join(HOOKS, "act.ts"));
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
  { ...base, key: "design:470:1791860400000", kind: "spawn", class: "develop", rule: "D2", agent: "designer", status: "done", agentId: "agent-1", outcome: { kind: "designer", brief: BRIEF, created: [471, 472], pendingDecision: true } },
  { ...base, key: `adjudicate:${RUN}:review:abc1234:r1`, kind: "spawn", class: "drive", rule: "P2", agent: "adjudicator", run: RUN, head: "abc1234", status: "running", endedAt: null, agentId: "agent-2" },
  { ...base, key: `fixer:review:512:abc1234`, kind: "spawn", class: "drive", rule: "M5b", agent: "fixer", pr: 512, head: "abc1234", status: "failed", summary: "agent failed: it said\nno", outcome: { kind: "handoff", notGated: true, run: RUN, head: "abc1234", newBranch: "issue-470-fix" } },
  { ...base, key: `delegate:470:${BRIEF}`, kind: "delegate", class: "develop", rule: "D4", agent: "implementer", status: "lost", agentId: "agent-3" },
  { ...base, key: "judge:sequence:512:abc1234", kind: "judge", class: "drive", rule: "M5", pr: 512, head: "abc1234", wake: "sequence", status: "done", wakeId: "w9", outcome: { kind: "wake", decision: "merge", reason: "nothing waits", instructions: null, bump: "minor", bumpReason: null, fields: {} } },
  { ...base, key: `judge:report:brief:470:${BRIEF}`, kind: "judge", class: "drive", rule: "D3", wake: "report", status: "done", outcome: { kind: "wake", decision: "parsed", reason: null, instructions: null, bump: null, bumpReason: null, fields: { brief: BRIEF, created: [], pendingDecision: false } } },
  { ...base, key: "task:respond-stuck:01K7S1AAAAAAAAAAAAAAAAAAAA:park@1791860000000:abc1234", kind: "task", class: "drive", rule: "P3a", wake: "respond-stuck", status: "timed-out" },
  { ...base, key: "tell:heartbeat-other:1791860405000", kind: "tell", class: "owner", rule: "O2", issue: null, wake: "heartbeat-other", status: "running", endedAt: null, session: "session-1" },
];

test("every loop note the plugin builds is one callum-flow-event takes", () => {
  const argvs = [
    ...entries.map((e) => ledger.loopEvent(e)),
    act.capEventArgv("spawn", NOW),
    act.capEventArgv("claim:470", NOW),
    act.breakerEventArgv({ kind: "breaker", since: NOW, until: NOW + 600_000, passes: 31 }),
    // the minute's pass summary (passes.ts), one with passes and one with none
    ...(() => {
      const settings = { mode: "act", planner: "v2", passEveryMs: 60_000 };
      const book = new Map();
      passes.notePass(book, NOW + 1_000, 120, true, false);
      passes.notePass(book, NOW + 2_000, 80, false, true);
      return [passes.passesEventArgv(passes.closeMinute(book, NOW, settings)), passes.passesEventArgv(passes.closeMinute(book, NOW + 60_000, settings))];
    })(),
  ];
  for (const argv of argvs) {
    assert.ok(Array.isArray(argv), "every entry here logs a loop event");
    const r = log(argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: exit ${r.status}: ${r.stderr}`);
  }
  const lines = fs.readFileSync(path.join(dir, "cbundy__dev-system.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, argvs.length);
  assert.ok(lines.every((l) => l.state === "loop" && / key=\S+ status=\S+/.test(` ${l.note}`)));
});
