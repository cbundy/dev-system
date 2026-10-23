"use strict";
// scripts/claude-code-canary-issue.sh and the canary workflow (cbundy/dev-system#1227).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "claude-code-canary-issue.sh");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github", "workflows", "claude-code-canary.yml"), "utf8");
let tmp;
let n = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-canary-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  // gh stub: GH_FIXTURE holds {list: <json>|{fail}, createUrl}; every call is recorded as JSON lines.
  fs.writeFileSync(
    path.join(tmp, "bin", "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const fx = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_FIXTURE + ".calls", JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") {
  if (fx.listFail) { process.stderr.write("boom\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(fx.list));
} else if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write(fx.createUrl + "\\n");
} else { process.stderr.write("unexpected\\n"); process.exit(1); }
`,
    { mode: 0o755 },
  );
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(fx, output) {
  const dir = fs.mkdtempSync(path.join(tmp, `d${n++}-`));
  const fxFile = path.join(dir, "fx.json");
  const outFile = path.join(dir, "out.txt");
  fs.writeFileSync(fxFile, JSON.stringify({ createUrl: "https://github.com/o/r/issues/77", ...fx }));
  fs.writeFileSync(outFile, output);
  const r = spawnSync("sh", [SCRIPT, "2.2.0", "2.1.308", "https://run/1", outFile], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`, GH_FIXTURE: fxFile },
  });
  const callsFile = fxFile + ".calls";
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { ...r, calls, creates: calls.filter((c) => c[1] === "create") };
}

const FAIL_OUT = "noise\nFAIL plugins/factory-hud (claude plugin test)\n    expected 1\n    got 2\nmore noise\n";
const issue = (number, body, state = "OPEN") => ({ number, body, state });

for (const state of ["OPEN", "CLOSED"]) {
  test(`a ${state} issue with the marker is found, nothing is created`, () => {
    const r = run({ list: [issue(5, "x <!-- claude-code-canary:2.2.0 --> y", state)] }, FAIL_OUT);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "found #5");
    assert.equal(r.creates.length, 0);
    assert.ok(r.calls[0].includes("--state") && r.calls[0].includes("all"));
  });
}

test("another version's marker or none creates exactly one bug issue", () => {
  const r = run({ list: [issue(5, "<!-- claude-code-canary:2.1.0 -->"), issue(6, null), issue(7, "<!-- claude-code-canary:2.2.01 -->")] }, FAIL_OUT);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "raised #77");
  assert.equal(r.creates.length, 1);
  const args = r.creates[0];
  assert.equal(args[args.indexOf("--label") + 1], "bug");
  assert.equal(args[args.indexOf("--title") + 1], "Claude Code canary: mods fail on 2.2.0");
  const body = args[args.indexOf("--body") + 1];
  for (const s of ["<!-- claude-code-canary:2.2.0 -->", "2.2.0", "2.1.308", "https://run/1", "FAIL plugins/factory-hud (claude plugin test)", "    expected 1", "make the mods pass", "minus 2"]) {
    assert.ok(body.toLowerCase().includes(s.toLowerCase()), `body lacks ${s}`);
  }
  assert.ok(!body.includes("noise"));
});

test("a long output is clipped with a note", () => {
  const long = "FAIL plugins/x (claude plugin test)\n" + Array.from({ length: 200 }, (_, i) => `    line ${i}`).join("\n") + "\n";
  const r = run({ list: [] }, long);
  const body = r.creates[0][r.creates[0].indexOf("--body") + 1];
  assert.ok(body.includes("    line 10"));
  assert.ok(!body.includes("    line 100"));
  assert.match(body, /clipped/);
});

test("a failing gh issue list exits non-zero and creates nothing", () => {
  const r = run({ listFail: true }, FAIL_OUT);
  assert.notEqual(r.status, 0);
  assert.equal(r.creates.length, 0);
});

test("the workflow never runs on pull_request, can write issues and tests mods through npm test", () => {
  assert.doesNotMatch(WORKFLOW, /pull_request/);
  assert.match(WORKFLOW, /^permissions:\n  contents: read\n  issues: write\n/m);
  assert.match(WORKFLOW, /schedule:/);
  assert.match(WORKFLOW, /workflow_dispatch:/);
  assert.match(WORKFLOW, /id: mods\n\s+if: [^\n]+\n\s+continue-on-error: true/);
  assert.match(WORKFLOW, /npm test -- "\$mod"/);
  assert.doesNotMatch(WORKFLOW, /claude plugin (test|validate)/);
});
