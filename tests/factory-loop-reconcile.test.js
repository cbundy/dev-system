"use strict";

// The factory loop v2's one-shot reconcile migration, plugins/factory-loop/bin/factory-reconcile
// (docs/factory-loop/v2/SPEC.md 6.3, 6.4), over a fixture factory: stub callum-flow-factory-state,
// dev-query, gh, callum-flow-issue-read and treehouse binaries answer from the fixtures below and
// record every call, and the pool's slots are real git repositories, whose HEAD and tree times the
// tool reads. Observe changes nothing; --act re-checks each named issue and does what its proposal
// now says, in the release's order (labels, the slot, the closing event, the intervention), and
// refuses to act until every event it writes is one the factory's readers count. Every release
// leaves the factory, whatever the issue's labels: the migration requeues nothing (v2 SPEC 6.3). It
// also lists the issues that show as active with no live claim and no ready label (no holder, or
// queued after a claim lapsed), and releases a live issue only when it is named. The tool runs
// through a runner, with the real hooks/v2/events.ts (the loop's events are native calls of
// callum-flow-event: a type and its data), and a stub callum-flow-event that writes its lines to
// the new log as the real one does. Plugin tests cannot run a command, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "plugins", "factory-loop", "bin", "factory-reconcile");
const EVENT = path.join(ROOT, "images", "base", "fabriek-event");
const REPO = "acme/widgets";
const DEVICE = "dev-loop";
const AT = Date.parse("2026-10-15T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

let tmp;
let pool;

// git: a command in a slot, its dates pinned so the slot's HEAD reads as moved then
function git(dir, at, ...args) {
  const date = iso(at);
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

// slot: a git repository on a branch (null: detached), last moved at `head`, whose changed files
// were last written at `tree` (none: a clean tree)
function slot(name, branch, head, tree = null) {
  const dir = path.join(pool, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, head, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, head, "add", "a.txt");
  git(dir, head, "commit", "-q", "-m", "first");
  if (branch === null) git(dir, head, "switch", "-q", "--detach");
  else git(dir, head, "switch", "-q", "-c", branch);
  if (tree !== null) {
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "left behind\n");
    for (const f of ["a.txt", "new.txt"]) fs.utimesSync(path.join(dir, f), tree / 1000, tree / 1000);
  }
  return dir;
}

// a row as the tool reports it: the loop's state with its time (and `why` for a closed one). A claim
// whose lease lapsed keeps the state it had.
const live = (issue, state, entered, extra = {}) => ({
  issue,
  state,
  state_since: iso(entered),
  why: state === "closed" ? "merged" : null,
  life: null,
  holder: DEVICE,
  pr: null,
  detail: null,
  stuck: null,
  source: "event",
  ...extra,
});
const ghIssue = (number, labels, state = "open") => ({ issue: { number, title: `issue ${number}`, state, labels: labels.map((name) => ({ name })) }, stripped: 0 });

// the fixture factory, each issue named by what it shows
function fixtures() {
  pool = path.join(tmp, "pool");
  const slots = [
    // #10's slot: stale and dirty, freed with its release
    { name: "1", path: slot("1", "feat/issue-10-x", AT - 10 * HOUR, AT - 9 * HOUR), status: "leased", branch: "feat/issue-10-x", lease_id: "L1", lease_holder: "", processes: [] },
    { name: "2", path: slot("2", null, AT - 10 * HOUR), status: "leased", branch: "", detached: true, lease_id: "L2", lease_holder: "", processes: [] },
    // #30 has no live claim and no record
    { name: "3", path: slot("3", "fix/issue-30-y", AT - 20 * HOUR), status: "leased", branch: "fix/issue-30-y", lease_id: "L3", lease_holder: "", processes: [] },
    // #14's slot changed ten minutes ago: #14 is live
    { name: "4", path: slot("4", "feat/issue-14-w", AT - 5 * HOUR, AT - 10 * MIN), status: "leased", branch: "feat/issue-14-w", lease_id: "L4", lease_holder: "", processes: [] },
    { name: "5", path: slot("5", "feat/other", AT - 5 * HOUR), status: "leased", branch: "feat/other", lease_id: "L5", lease_holder: "", processes: [] },
    // the loop's own slot: W2's, never this tool's
    { name: "6", path: path.join(pool, "6"), status: "leased", branch: "issue-99", lease_id: "L6", lease_holder: "factory-loop:99:tbq3k0", processes: [] },
    // #15 is another device's live claim
    { name: "7", path: slot("7", "fix/issue-15-q", AT - 5 * HOUR), status: "leased", branch: "fix/issue-15-q", lease_id: "L7", lease_holder: "", processes: [] },
    // #31's slot runs a process: `--act all` leaves it, naming #31 frees it
    { name: "8", path: slot("8", "issue-31", AT - 5 * HOUR), status: "leased", branch: "issue-31", lease_id: "L8", lease_holder: "", processes: [{ pid: 4242 }] },
    { name: "9", path: path.join(pool, "9"), status: "available", branch: "", lease_id: "", lease_holder: "", processes: [] },
  ];
  const factory = {
    at: iso(AT),
    repos: [
      {
        repo: REPO,
        issues: [
          live(10, "designing", AT - 3 * HOUR),
          live(11, "building", AT - 2 * HOUR),
          live(12, "reviewing", AT - HOUR),
          live(13, "parked", AT - 2 * HOUR, { pr: 113 }),
          live(14, "building", AT - 3 * HOUR),
          live(15, "designing", AT - HOUR, { holder: "other-dev" }),
          live(16, "designing", AT - 2 * HOUR),
          live(17, "building", AT - 4 * HOUR),
          live(18, "building", AT - 4 * HOUR),
          { ...live(20, "designing", AT - HOUR, { detail: "claim lapsed at 2026-10-15T11:00:00.000Z" }) },
          // no holder: #40 queued for days with no ready label (a ghost), #41 in the queue (ready),
          // #42 with a PR whose head was pushed five minutes ago, no claim holding it (live)
          live(40, "queued", AT - 72 * HOUR, { holder: null }),
          live(41, "queued", AT - 2 * HOUR, { holder: null }),
          live(42, "reviewing", AT - HOUR, { holder: null }),
          // a v2 record queued for a slot: live work, never a ghost
          live(43, "queued", AT - HOUR, { step: "lease", attempt: 1, life: "t3xq00" }),
        ],
        recent: [{ ...live(21, "closed", AT - 5 * HOUR), holder: DEVICE }],
      },
    ],
  };
  const claims = [
    { issue: 10, state: "claimed", ts: iso(AT - 3 * HOUR) },
    { issue: 11, state: "claimed", ts: iso(AT - 3 * HOUR) },
    { issue: 16, state: "claimed", ts: iso(AT - 2 * HOUR) },
    { issue: 16, state: "transition", ts: iso(AT - HOUR) },
  ];
  return {
    slots,
    answers: {
      "callum-flow-factory-state": [{ match: ".", stdout: factory }],
      "dev-query": [
        { match: "factory\\.events", stdout: claims },
      ],
      gh: [
        { match: "^pr list --repo acme/widgets --state open", stdout: [{ number: 111, headRefName: "feat/issue-11-y", headRefOid: "sha111" }, { number: 113, headRefName: "fix/issue-13-z", headRefOid: "sha113" }, { number: 112, headRefName: "feat/issue-11-zz", headRefOid: "sha112" }, { number: 150, headRefName: "feat/issue-99-zz", headRefOid: "sha150" }, { number: 120, headRefName: "feat/issue-12-v", headRefOid: "sha120" }, { number: 142, headRefName: "feat/issue-42-n", headRefOid: "sha142" }] },
        { match: "^api repos/acme/widgets/commits/sha111 ", stdout: `${iso(AT - 4 * HOUR)}\n` },
        { match: "^api repos/acme/widgets/commits/sha113 ", stdout: `${iso(AT - 6 * HOUR)}\n` },
        { match: "^api repos/acme/widgets/commits/sha120 ", stdout: `${iso(AT - 5 * MIN)}\n` },
        { match: "^api repos/acme/widgets/commits/sha142 ", stdout: `${iso(AT - 5 * MIN)}\n` },
        { match: "^pr checks 111 ", stdout: [{ name: "ci", state: "SUCCESS", startedAt: iso(AT - 4 * HOUR), completedAt: iso(AT - 4 * HOUR + 3 * MIN) }] },
        { match: "^pr checks 1[24]\\d ", stderr: "no checks reported\n", code: 1 },
        { match: "^pr checks 113 ", stderr: "no checks reported on the 'fix/issue-13-z' branch\n", code: 1 },
        { match: "^issue edit ", stdout: "" },
      ],
      "callum-flow-issue-read": [
        { match: "^--json --list --label In development --state all$", stdout: { issues: [ghIssue(10, ["In development"]).issue, ghIssue(12, ["In development"]).issue, ghIssue(20, ["bug", "In development"]).issue, ghIssue(21, ["In development"], "closed").issue], stripped: 0 } },
        { match: "^--json --pr 111 --comments$", stdout: { pr: { number: 111 }, comments: [], review_comments: [], reviews: [{ id: 1, submitted_at: iso(AT - 5 * HOUR) }], stripped: 0 } },
        // a PR on #11's branch by an untrusted author: not the loop's, never read
        { match: "^--json --pr 112 --comments$", code: 3 },
        { match: "^--json --pr 1[24]\\d --comments$", stdout: { pr: { number: 120 }, comments: [], review_comments: [], reviews: [], stripped: 0 } },
        { match: "^--json --pr 113 --comments$", stdout: { pr: { number: 113 }, comments: [], review_comments: [], reviews: [{ id: 2, submitted_at: iso(AT - 10 * MIN) }], stripped: 0 } },
        { match: "^--json 10$", stdout: ghIssue(10, ["bug", "In development", "factory:designing"]) },
        { match: "^--json 11$", stdout: ghIssue(11, ["ready", "In development"]) },
        { match: "^--json 12$", stdout: ghIssue(12, ["In development"]) },
        { match: "^--json 13$", stdout: ghIssue(13, ["In development"]) },
        { match: "^--json 14$", stdout: ghIssue(14, ["In development"]) },
        { match: "^--json 16$", stdout: ghIssue(16, ["factory:designing"]) },
        { match: "^--json 17$", stdout: ghIssue(17, ["In development"], "closed") },
        { match: "^--json 18$", code: 3 },
        { match: "^--json 20$", stdout: ghIssue(20, ["bug", "In development"]) },
        { match: "^--json 40$", stdout: ghIssue(40, ["enhancement"]) },
        { match: "^--json 41$", stdout: ghIssue(41, ["ready"]) },
        { match: "^--json 42$", stdout: ghIssue(42, ["bug"]) },
      ],
      treehouse: [
        { match: "^status --json$", stdout: slots },
        { match: "^return ", stdout: "" },
      ],
    },
  };
}

// The stub: records its call, then answers with the first rule whose pattern matches its arguments.
const FAKE = `"use strict";
const fs = require("node:fs");
const [, , name, ...argv] = process.argv;
const dir = process.env.FAKE_DIR;
const keep = ["CALLUM_FLOW_REPO", "CALLUM_FLOW_ACTOR", "CALLUM_EVENTS_DIR"];
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ name, argv, cwd: process.cwd(), env: Object.fromEntries(keep.map((k) => [k, process.env[k] ?? null])) }) + "\\n");
const rules = JSON.parse(fs.readFileSync(dir + "/answers.json", "utf8"))[name] || [];
const line = argv.join(" ");
const rule = rules.find((r) => new RegExp(r.match).test(line));
if (name === "callum-flow-event") {
  // as the real one: --new-only --new-path names the new log; a native write appends one line, and
  // exits 0 even when it fails (a rule's drop); a usage error exits 2 and writes nothing
  const flag = (f) => (argv.indexOf(f) === -1 ? null : argv[argv.indexOf(f) + 1]);
  const repo = flag("--repo") || process.env.CALLUM_FLOW_REPO;
  const log = process.env.CALLUM_EVENTS_DIR + "/factory/" + repo.replace("/", "__") + ".jsonl";
  if (argv.includes("--new-path")) { process.stdout.write(log + "\\n"); process.exit(0); }
  if (rule && rule.code) { process.stderr.write(rule.stderr || ""); process.exit(rule.code); }
  if (rule && rule.drop) { process.stderr.write("callum-flow-event: warning: cannot write " + log + " - event not recorded\\n"); process.exit(0); }
  const num = (v) => (v === null ? null : Number(v));
  const e = { type: flag("--type"), repo, actor: flag("--actor") || process.env.CALLUM_FLOW_ACTOR || "agent", issue: num(flag("--issue")), data: JSON.parse(flag("--data")) };
  fs.mkdirSync(process.env.CALLUM_EVENTS_DIR + "/factory", { recursive: true });
  fs.appendFileSync(log, JSON.stringify(e) + "\\n");
  process.exit(0);
}
if (!rule) { process.stderr.write("stub " + name + ": no answer for " + line + "\\n"); process.exit(1); }
if (rule.stdout !== undefined) process.stdout.write(typeof rule.stdout === "string" ? rule.stdout : JSON.stringify(rule.stdout));
if (rule.stderr) process.stderr.write(rule.stderr);
process.exit(rule.code ?? 0);
`;

// The runner: the tool with the real events.ts. FAKE_HOOKS=wrong has events.ts build a release with
// the wrong stage, as a build that does not carry the release's fields would.
const RUNNER = (script) => `"use strict";
const tool = require(${JSON.stringify(script)});
const mode = process.env.FAKE_HOOKS || "real";
const wrong = (events) => ({
  ...events,
  eventArgv: (e) => {
    const argv = events.eventArgv(e);
    const i = argv.indexOf("--data");
    const data = JSON.parse(argv[i + 1]);
    if (data.stage !== undefined) data.stage = "not-the-stage";
    argv[i + 1] = JSON.stringify(data);
    return argv;
  },
});
tool.cli(process.argv.slice(2), process.env, {
  withHooks: (h) => (mode === "wrong" ? { ...h, events: wrong(h.events) } : h),
});
`;

// world: a fresh stub directory with these answers; returns how to run the tool there
function world(answers, { machine = DEVICE } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "world-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  fs.writeFileSync(path.join(dir, "runner.js"), RUNNER(SCRIPT));
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(answers));
  fs.mkdirSync(path.join(dir, "bin"));
  for (const name of ["callum-flow-factory-state", "dev-query", "gh", "callum-flow-issue-read", "callum-flow-event", "treehouse"]) {
    const bin = path.join(dir, "bin", name);
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "fake.js")}" ${name} "$@"\n`);
    fs.chmodSync(bin, 0o755);
  }
  const checkout = path.join(dir, "checkout");
  const cfg = path.join(dir, "cfg");
  const events = path.join(dir, "events");
  for (const d of [checkout, cfg, events]) fs.mkdirSync(d);
  const env = {
    ...process.env,
    FAKE_DIR: dir,
    DEV_MACHINE_NAME: machine,
    CLAUDE_CONFIG_DIR: cfg,
    CALLUM_EVENTS_DIR: events,
    CALLUM_FLOW_FACTORY_STATE_BIN: path.join(dir, "bin", "callum-flow-factory-state"),
    CALLUM_FLOW_DEV_QUERY_BIN: path.join(dir, "bin", "dev-query"),
    CALLUM_FLOW_GH_BIN: path.join(dir, "bin", "gh"),
    CALLUM_FLOW_ISSUE_READ_BIN: path.join(dir, "bin", "callum-flow-issue-read"),
    CALLUM_FLOW_EVENT_BIN: path.join(dir, "bin", "callum-flow-event"),
    CALLUM_FLOW_TREEHOUSE_BIN: path.join(dir, "bin", "treehouse"),
  };
  const loopDir = path.join(cfg, "factory-loop", "acme__widgets");
  return {
    dir,
    env,
    loopDir,
    events,
    run: (args, over = {}) => spawnSync(process.execPath, [path.join(dir, "runner.js"), "--repo", REPO, "--device", DEVICE, "--checkout", checkout, ...args], { encoding: "utf8", env: { ...env, ...over }, timeout: 60_000 }),
    // the logged events, as the log holds them
    logged: () => (fs.existsSync(path.join(events, "factory", "acme__widgets.jsonl")) ? fs.readFileSync(path.join(events, "factory", "acme__widgets.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    calls: () =>
      fs.existsSync(path.join(dir, "calls.jsonl"))
        ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
  };
}

// probe: the readiness check's event to a scratch log, or a read of the log's path: no write
const probe = (c) => c.name === "callum-flow-event" && (c.argv.includes("--new-path") || /factory-reconcile-probe-/.test(c.env.CALLUM_EVENTS_DIR || ""));
const writes = (calls) => calls.filter((c) => (c.name === "gh" && c.argv[0] === "issue") || (c.name === "treehouse" && c.argv[0] === "return") || (c.name === "callum-flow-event" && !probe(c)));
// names: a write that names this issue: its label edit, or an event about it
const names = (c, n) => (c.name === "gh" && c.argv[0] === "issue" && c.argv[2] === String(n)) || (c.name === "callum-flow-event" && c.argv[c.argv.indexOf("--issue") + 1] === String(n));
const line = (out, issue) => out.split("\n").find((l) => l.startsWith(`- #${issue}:`) || l.startsWith(`- #${issue} (`)) || "";
const slotLine = (out, name) => out.split("\n").find((l) => l.startsWith(`- slot ${name} `)) || "";

let fx;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-reconcile-"));
  fx = fixtures();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a row with a life is a record: orphanOf reads `life`, so #43 queued is never looked at", () => {
  const out = world(fx.answers).run([]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(line(out.stdout, 43), "");
});

test("observe lists this device's live claims with no v2 record, the live issues with no holder, the pool's other slots and the leftover labels, each with its proposal, and changes nothing", () => {
  const w = world(fx.answers);
  const r = w.run([]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^# factory-reconcile: acme\/widgets for dev-loop, at 2026-10-15T12:00:00.000Z$/m);
  assert.match(out, /--act 10 11 17 20 21 30 31 40`/);
  assert.match(out, /^Live, released only when named: #12 #13 #14 #42\.$/m);
  assert.match(out, /^Nothing is requeued: every release leaves the factory\. Re-add `ready` to bring back an issue still wanted; the loop adopts its open PR\.$/m);
  // no live step within T: released out of the factory, whatever its labels
  assert.match(line(out, 10), /designing for 3h00m with no v2 record; checked within 45m: no open PR; slot 1 on feat\/issue-10-x: HEAD moved 10h00m ago, tree changed 9h00m ago\. Proposal: leave the factory \(abandoned: nothing is requeued\)\. Labels: bug, In development, factory:designing\. Open PR: none\. Slot: 1\.$/);
  assert.match(line(out, 11), /checked within 1h30m: PR #112 by an untrusted author: not counted; PR #111: head pushed 4h00m ago, a check 3h57m ago, a review 5h00m ago; no slot on its branch\. Proposal: leave the factory \(abandoned: nothing is requeued\)\. Labels: ready, In development\. Open PR: #111\./);
  // no-mistakes is retired: nothing reads its mirror, and the checked list has no run evidence
  assert.ok(!w.calls().some((c) => c.name === "dev-query" && /nomistakes|to_regclass/.test(c.argv.join(" "))), "the run mirror is not read");
  assert.doesNotMatch(out, /\brun R\d|no run of its branch|runs n\/a|no run mirror/);
  assert.ok(!w.calls().some((c) => c.name === "gh" && (c.argv.includes("112") || c.argv.some((a) => a.endsWith("/sha112")))), "nothing of an untrusted PR is read");
  // live evidence within T: a PR's head push, a review, a slot's tree
  assert.match(line(out, 12), /PR #120: head pushed 5m ago, a check never, a review never.*Proposal: live, no v2 record: check again later \(named in --act, it leaves the factory\)\./);
  assert.match(line(out, 13), /PR #113: head pushed 6h00m ago, a check never, a review 10m ago.*Proposal: live, no v2 record: check again later \(named in --act, it leaves the factory\)\./);
  assert.match(line(out, 14), /slot 4 on feat\/issue-14-w: HEAD moved 5h00m ago, tree changed 10m ago\. Proposal: live, no v2 record: check again later \(named in --act, it leaves the factory\)\. .*Slot: 4\./);
  // with no live claim: ghosts that leave (no holder; queued after its claim lapsed), one in the
  // queue left out, one live, and a v2 record's queued state never looked at
  assert.match(out, /^## Live in the factory with no live claim and no ready label$/m);
  assert.match(line(out, 20), /^- #20: queued for 1h00m with no live claim; checked within 2h00m: no open PR; no slot on its branch\. Proposal: leave the factory \(abandoned: no live claim and nothing is requeued\)\. Labels: bug, In development\. Open PR: none\. Slot: none\.$/);
  assert.equal(line(out, 43), "", "a v2 record queued for its slot is live work");
  assert.ok(!w.calls().some((c) => c.name === "callum-flow-issue-read" && c.argv.join(" ") === "--json 43"), "nothing of it is read");
  assert.match(line(out, 40), /^- #40: queued for 3d with no holder; checked within 2h00m: no open PR; no slot on its branch\. Proposal: leave the factory \(abandoned: no holder and nothing is requeued\)\. Labels: enhancement\. Open PR: none\. Slot: none\.$/);
  assert.equal(line(out, 41), "", "an issue in the queue (ready) is no ghost");
  assert.match(line(out, 42), /reviewing for 1h00m with no holder; .*PR #142: head pushed 5m ago.*Proposal: live, no holder: check again later \(named in --act, it leaves the factory\)\./);
  assert.match(out, /^- With a v2 record, left to the loop: #16\.$/m);
  assert.match(line(out, 17), /Proposal: closed on GitHub \(the sweep logs it\): remove the label\./);
  assert.match(line(out, 18), /Proposal: not read \(an untrusted author\): check again later\./);
  assert.equal(line(out, 15), "", "another device's claim is never looked at");
  // the pool's other slots
  assert.match(slotLine(out, 2), /on no branch: .*Proposal: on no branch: listed only/);
  assert.match(slotLine(out, 3), /on fix\/issue-30-y: .*Proposal: #30 has no live claim and no record: free the slot\.$/);
  assert.match(slotLine(out, 5), /Proposal: not an issue branch: listed only\.$/);
  assert.match(slotLine(out, 7), /Proposal: #15 has a live claim \(other-dev\): listed only\.$/);
  assert.match(slotLine(out, 8), /: HEAD moved 5h00m ago, tree clean, 1 process\(es\)\. Proposal: #31 has no live claim and no record: free the slot\.$/);
  assert.equal(slotLine(out, 1) + slotLine(out, 4) + slotLine(out, 6) + slotLine(out, 9), "", "a candidate's slot is on its own line; the loop's and an available one are not listed");
  // In development with no live claim, open or closed
  assert.equal(out.split("\n").filter((l) => l.startsWith("- #20")).length, 1, "#20's release takes its label off: it is not listed twice");
  assert.match(line(out, 21), /^- #21 \(closed\): closed\. Proposal: remove the label\.$/);
  // nothing written but the report
  assert.deepEqual(writes(w.calls()), []);
  const report = fs.readFileSync(path.join(w.loopDir, "reconcile-2026-10-15.md"), "utf8");
  assert.equal(report, `${out}\n`);
  // every GitHub read of text went through the trusted reader; every gh call names the repo
  for (const c of w.calls().filter((x) => x.name === "gh" && x.argv[0] !== "api")) assert.ok(c.argv.includes("--repo"), c.argv.join(" "));
  for (const c of w.calls().filter((x) => x.name === "callum-flow-issue-read")) assert.equal(c.env.CALLUM_FLOW_REPO, REPO);
});

test("--act re-checks each named issue and releases it in order: labels off, its slot freed (processes killed, leftovers saved, returned on its lease), its closing event, then the intervention; every release leaves, and a live issue named is released too", async () => {
  const w = world(fx.answers);
  const slot1 = fx.slots[0].path;
  const sleeper = spawn("sleep", ["60"], { cwd: slot1, stdio: "ignore" });
  const exited = once(sleeper, "exit");
  const r = w.run(["--act", "10", "11", "12", "30"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [, signal] = await Promise.race([exited, new Promise((_, no) => setTimeout(() => no(new Error("the slot's process was not killed")), 10_000))]);
  assert.equal(signal, "SIGTERM");

  const calls = writes(w.calls());
  // the readiness check ran first, against a scratch log, before any write
  const all = w.calls();
  const first = all.findIndex((c) => writes([c]).length > 0);
  assert.ok(all.slice(0, first).some((c) => probe(c) && c.argv[1] === "intervention"), "the event CLI is tried before anything is done");
  // #10: its factory label and In development off, slot 1 freed, abandoned, then the intervention
  const ten = calls.filter((c) => names(c, 10) || c.argv.includes(slot1));
  assert.deepEqual(
    ten.map((c) => [c.name, ...c.argv.slice(0, 2)]),
    [
      ["gh", "issue", "edit"],
      ["treehouse", "return", slot1],
      ["callum-flow-event", "--type", "abandoned"],
      ["callum-flow-event", "--type", "intervention"],
    ],
  );
  assert.deepEqual(ten[0].argv, ["issue", "edit", "10", "--repo", REPO, "--remove-label", "In development,factory:designing"]);
  assert.deepEqual(ten[1].argv, ["return", slot1, "--if-lease-id", "L1", "--force"]);
  for (const c of ten.slice(2)) assert.deepEqual(c.env, { CALLUM_FLOW_REPO: REPO, CALLUM_FLOW_ACTOR: "factory-reconcile", CALLUM_EVENTS_DIR: w.events });
  // the leftovers: the tracked change and the untracked file, as one patch
  const leftovers = fs.readdirSync(path.join(w.loopDir, "leftovers"));
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /^10-v1-slot1-\d+\.patch$/);
  const patch = fs.readFileSync(path.join(w.loopDir, "leftovers", leftovers[0]), "utf8");
  assert.match(patch, /\+two/);
  assert.match(patch, /new file mode 100644[\s\S]*\+left behind/);
  // #11: labelled ready, and it leaves all the same (nothing is requeued), with its branch and PR
  const eleven = calls.filter((c) => c.name === "callum-flow-event" && names(c, 11));
  assert.deepEqual(eleven.map((c) => c.argv[1]), ["abandoned", "intervention"]);
  assert.deepEqual([JSON.parse(eleven[0].argv[3]).branch, JSON.parse(eleven[0].argv[3]).pr], ["feat/issue-11-y", 111]);
  assert.ok(!w.calls().some((c) => c.name === "gh" && c.argv.includes("--add-label")), "no label is ever added");
  // #12 is live, but named: it leaves; #30: its slot alone, with no event
  assert.match(r.stdout, /^- #12: removed In development; logged abandoned; logged the intervention\.$/m);
  assert.deepEqual(calls.filter((c) => c.argv.includes(fx.slots[2].path)).map((c) => c.argv.slice(0, 4)), [["return", fx.slots[2].path, "--if-lease-id", "L3"]]);
  assert.match(r.stdout, /^- #30: slot 3 returned, its HEAD was [0-9a-f]{8}\.$/m);
  assert.match(r.stdout, /^- #10: removed In development, factory:designing; slot 1 returned, 1 process\(es\) killed, leftovers in .*\.patch, its HEAD was [0-9a-f]{8}; logged abandoned; logged the intervention\.$/m);
  // the events are in the new log, with the release's fields as events.ts builds them
  assert.deepEqual(
    w.logged().map((e) => [e.type, e.issue, e.actor, e.data.branch ?? null, e.data.pr]),
    [
      ["abandoned", 10, "factory-reconcile", "feat/issue-10-x", null],
      ["intervention", 10, "factory-reconcile", null, null],
      ["abandoned", 11, "factory-reconcile", "feat/issue-11-y", 111],
      ["intervention", 11, "factory-reconcile", null, 111],
      ["abandoned", 12, "factory-reconcile", "feat/issue-12-v", 120],
      ["intervention", 12, "factory-reconcile", null, 120],
    ],
  );
  assert.deepEqual([w.logged()[0].data.reason, w.logged()[0].data.stage, w.logged()[0].data.lives], ["reconcile", "designing", null]);
  assert.match(w.logged()[0].data.detail, /^nothing within 45m/);
  assert.match(w.logged()[4].data.detail, /^live within 30m, released by name/);
  assert.equal(w.logged()[1].data.cause, "reconcile");
  assert.match(w.logged()[1].data.fact, /^i10\/reconcile\/[0-9a-z]+\/event$/);
  assert.match(w.logged()[1].data.detail, /^abandoned/);
  assert.ok(!fs.existsSync(path.join(w.loopDir, "unlogged-events.jsonl")));
  // the open PRs are never touched
  assert.equal(w.calls().filter((c) => c.name === "gh" && c.argv[0] === "pr" && c.argv[1] !== "list" && c.argv[1] !== "checks").length, 0);
  // the act's lines join the day's report
  assert.match(fs.readFileSync(path.join(w.loopDir, "reconcile-2026-10-15.md"), "utf8"), /## Act on #10 #11 #12 #30/);
});

test("--act all acts on every proposal but a live claim, and leaves a busy slot alone unless its issue is named", () => {
  const w = world(fx.answers);
  const r = w.run(["--act", "all"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^## Act on all$/m);
  for (const n of [10, 11, 17, 20, 21, 30, 40]) assert.match(r.stdout, new RegExp(`^- #${n}: `, "m"));
  assert.match(r.stdout, /^- #20: removed In development; logged abandoned; logged the intervention\.$/m);
  assert.match(r.stdout, /^- #40: logged abandoned; logged the intervention\.$/m);
  assert.match(r.stdout, /^- #31: slot 8 left alone: it is busy or changed within 2h00m \(name #31 to free it\)\.$/m);
  const writes17 = writes(w.calls()).filter((c) => names(c, 17));
  assert.deepEqual(writes17.map((c) => c.argv.slice(0, 2)), [["issue", "edit"]], "a closed issue's labels go; the sweep logs its close");
  assert.ok(!w.calls().some((c) => c.argv.includes(fx.slots[7].path) && c.argv[0] === "return"));
  for (const n of [12, 13, 14, 18, 41, 42, 43]) assert.ok(!writes(w.calls()).some((c) => names(c, n)), `#${n} is left alone`);

  const named = world(fx.answers).run(["--act", "31"]);
  assert.match(named.stdout, /^- #31: slot 8 returned, its HEAD was [0-9a-f]{8}\.$/m);
});

test("--act fails closed: with an events.ts that does not build a release's fields, or an event CLI that does not log an intervention, it refuses before anything is done", () => {
  const cases = [
    [{ FAKE_HOOKS: "wrong" }, fx.answers, /--act refused, nothing done: hooks\/v2\/events\.ts does not build a release's fields \(reason, stage, what was checked, PR\)\. The act run comes after U4 lands on feat\/factory-loop-v2/],
    [{}, { ...fx.answers, "callum-flow-event": [{ match: "^--type intervention ", code: 2, stderr: "callum-flow-event: unknown type 'intervention'\n" }] }, /--act refused, nothing done: the callum-flow-event in use does not log an intervention: callum-flow-event: unknown type 'intervention'\..*CALLUM_FLOW_EVENT_BIN/],
    [{}, { ...fx.answers, "callum-flow-event": [{ match: "^--type intervention ", drop: true }] }, /--act refused, nothing done: the callum-flow-event in use does not log an intervention: not in the log/],
  ];
  for (const [env, answers, refusal] of cases) {
    const w = world(answers);
    const r = w.run(["--act", "all"], env);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, refusal);
    assert.equal(r.stdout, "");
    assert.deepEqual(writes(w.calls()), []);
    assert.ok(!w.calls().some((c) => c.name !== "callum-flow-event"), "nothing is read either");
    assert.deepEqual(w.logged(), []);
  }
  // observe still runs
  const w = world(fx.answers);
  assert.equal(w.run([], { FAKE_HOOKS: "wrong" }).status, 0);
});

test("a slot whose leftovers could not be saved is not returned while its tree has changes: its issue fails, with no event; a clean one is returned", () => {
  const w = world(fx.answers);
  const git = path.join(w.dir, "bin", "git");
  fs.writeFileSync(git, `#!/bin/sh\ncase " $* " in *" add -A "*) echo "fatal: unable to index file" >&2; exit 128 ;; esac\nexec git "$@"\n`);
  fs.chmodSync(git, 0o755);
  const r = w.run(["--act", "10", "30"], { CALLUM_FLOW_GIT_BIN: git });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /^- #10: FAILED: leftovers not saved: fatal: unable to index file; slot 1 not returned, left for the owner \(done before it: removed In development, factory:designing\)\.$/m);
  assert.ok(!w.calls().some((c) => c.name === "treehouse" && c.argv[0] === "return" && c.argv.includes(fx.slots[0].path)), "slot 1 is left");
  assert.ok(!writes(w.calls()).some((c) => c.name === "callum-flow-event" && names(c, 10)), "no event for a release that did not happen");
  assert.ok(fs.readFileSync(path.join(fx.slots[0].path, "new.txt"), "utf8").includes("left behind"), "the slot's work is still there");
  assert.match(r.stdout, /^- #30: slot 3 returned, its HEAD was [0-9a-f]{8}, nothing to save, the tree was clean \(fatal: unable to index file\)\.$/m);
});

test("an event the CLI did not write fails its issue with exit 1, and is kept to log again with the intervention it goes with", () => {
  const w = world({ ...fx.answers, "callum-flow-event": [{ match: "^--type abandoned .* --issue 10$", drop: true }, { match: "^--type intervention .* --issue 11$", drop: true }] });
  const r = w.run(["--act", "10", "11"]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const kept = path.join(w.loopDir, "unlogged-events.jsonl");
  assert.match(r.stdout, new RegExp(`^- #10: FAILED: abandoned not logged: not in the log \\(callum-flow-event: warning: cannot write [^)]*\\); kept in ${kept} to log again \\(done before it: .*slot 1 returned.*\\)\\.$`, "m"));
  assert.match(r.stdout, new RegExp(`^- #11: FAILED: the intervention not logged: not in the log .*; kept in ${kept} to log again \\(done before it: removed In development; logged abandoned\\)\\.$`, "m"));
  // #10's intervention is not logged before its event; both are kept, then #11's intervention
  assert.ok(!w.calls().some((c) => c.name === "callum-flow-event" && !probe(c) && c.argv[1] === "intervention" && names(c, 10)));
  const lines = fs.readFileSync(kept, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.repo, l.actor, l.argv[0], l.argv[2], l.argv[6]]), [
    [REPO, "factory-reconcile", "callum-flow-event", "abandoned", "10"],
    [REPO, "factory-reconcile", "callum-flow-event", "intervention", "10"],
    [REPO, "factory-reconcile", "callum-flow-event", "intervention", "11"],
  ]);
  assert.deepEqual(w.logged().map((e) => [e.type, e.issue]), [["abandoned", 11]]);
  // kept as the native argv, to log again as it is
  assert.deepEqual(JSON.parse(lines[2].argv[4]).cause, "reconcile");
});

test("a write that fails stops that issue's release before its event; the others go on, and the exit is 1", () => {
  const answers = { ...fx.answers, gh: [{ match: "^issue edit 10 ", stderr: "HTTP 502\n", code: 1 }, ...fx.answers.gh] };
  const w = world(answers);
  const r = w.run(["--act", "10", "11"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^- #10: FAILED: labels not removed: HTTP 502\.$/m);
  assert.match(r.stdout, /^- #11: removed In development; logged abandoned; logged the intervention\.$/m);
  assert.ok(!w.calls().some((c) => names(c, 10) && c.name === "callum-flow-event"), "no event for a release that did not happen");
  assert.ok(!w.calls().some((c) => c.name === "treehouse" && c.argv[0] === "return" && c.argv.includes(fx.slots[0].path)));
});

test("run on another machine, it reads and frees no slot: that pool is not this machine's", () => {
  const w = world(fx.answers, { machine: "laptop" });
  const r = w.run(["--act", "all"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Not read: this machine is laptop, not dev-loop: run it there to read and free that pool\.$/m);
  // a slot can be live evidence, so with the pool unread no claim is released; labels still go
  assert.match(r.stdout, /--act 17 20 21`/);
  for (const n of [10, 11, 14]) assert.match(line(r.stdout, n), /Proposal: not fully checked \(slots not read\): check again later\./);
  assert.ok(!w.calls().some((c) => c.name === "treehouse"));
  assert.ok(!w.calls().some((c) => c.name === "callum-flow-event" && !probe(c)));
  assert.match(r.stdout, /^- #17: removed In development\.$/m);
});

test("usage errors exit 2; a factory that cannot be read exits 1 and changes nothing", () => {
  const w = world(fx.answers);
  for (const args of [["--act"], ["--act", "10", "x"], ["--bogus"]]) {
    const r = w.run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^factory-reconcile: .*\nusage: factory-reconcile --repo/);
  }
  const bare = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: w.env });
  assert.equal(bare.status, 2);
  const down = world({ ...fx.answers, "callum-flow-factory-state": [{ match: ".", stderr: "cannot read the fleet database\n", code: 1 }] });
  const r = down.run(["--act", "all"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /callum-flow-factory-state: cannot read the fleet database/);
  assert.deepEqual(writes(down.calls()), []);
});

test("the pure helpers: issue branches by the repo's convention, spans as people read them, the arguments", () => {
  const mod = require(SCRIPT);
  assert.equal(mod.issueOfBranch("feat/issue-467-stopped-row"), 467);
  assert.equal(mod.issueOfBranch("issue-31"), 31);
  for (const b of ["feat/issue-467x", "myissue-4-x", "", null, "feat/other"]) assert.equal(mod.issueOfBranch(b), null, String(b));
  assert.deepEqual([45 * MIN, 90 * MIN, 3 * 24 * HOUR].map(mod.dur), ["45m", "1h30m", "3d"]);
  assert.deepEqual(mod.parseArgs(["--repo", "a/b", "--act", "3", "1", "3"]).act, [3, 1]);
  assert.equal(mod.parseArgs(["--repo", "a/b", "--act", "all"]).act, "all");
});

// The migration writes its events through hooks/v2/events.ts (v2 SPEC 6.4, 7.1). Here the tool runs as
// the owner will run it, with the real events.ts and the branch's images/base/fabriek-event: each
// release sees its own native write in the new log and logs it once, the old log is not written, and
// every line passes the strict schemas and reads back as the release's fields.
test("the migration's events pass the real callum-flow-event: one native line each in the new log, none in the old, read back as the release's fields", async () => {
  const { register } = require("node:module");
  register(
    "data:text/javascript," +
      encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
  );
  const reader = await import(path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "event-reader.ts"));
  const w = world(fx.answers);
  const r = w.run(["--act", "10", "11"], { CALLUM_FLOW_EVENT_BIN: EVENT, DEV_VERSIONS_FILE: path.join(w.dir, "none.json") });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^- #10: .*logged abandoned; logged the intervention\.$/m);
  assert.ok(!fs.existsSync(path.join(w.events, "acme__widgets.jsonl")), "the old log is not written");
  assert.ok(!fs.existsSync(path.join(w.loopDir, "unlogged-events.jsonl")));
  const lines = w.logged();
  assert.deepEqual(
    lines.map((e) => [e.type, e.issue, e.actor, e.repo]),
    [
      ["abandoned", 10, "factory-reconcile", REPO],
      ["intervention", 10, "factory-reconcile", REPO],
      ["abandoned", 11, "factory-reconcile", REPO],
      ["intervention", 11, "factory-reconcile", REPO],
    ],
  );
  for (const e of lines) {
    assert.deepEqual(reader.validateStrict("envelope", 1, e), []);
    assert.deepEqual(reader.validateStrict(e.type, 1, e.data), []);
  }
  const [ab10, iv10, ab11] = lines.map((e) => e.data);
  assert.deepEqual([ab10.reason, ab10.lives, ab10.stage, ab10.branch, ab10.pr], ["reconcile", null, "designing", "feat/issue-10-x", null]);
  assert.deepEqual([ab11.stage, ab11.branch, ab11.pr], ["building", "feat/issue-11-y", 111]);
  assert.deepEqual([iv10.who, iv10.cause], ["person", "reconcile"]);
  assert.match(iv10.fact, /^i10\/reconcile\/[0-9a-z]+\/event$/);
});
