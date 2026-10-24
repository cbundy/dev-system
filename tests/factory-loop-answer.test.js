"use strict";

// The factory loop's answer script (plugins/factory-loop/bin/factory-answer, #561), run for real
// by node against a scratch config directory: its usage and its exit codes, every problem it
// names, the atomic write, and every path it must refuse. It is a temporary workaround for the
// registered answer tools, which an agent the loop spawns from its timer cannot reach (#560).
// The script and the loop share one contract (hooks/contract.mjs): every case of the shared table
// (tests/answer-cases.mjs) must come out here exactly as tests/answer-contract.test.ts reads it
// through the loop. Plugin tests cannot run a command, so this lives here.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { register } = require("node:module");
const { pathToFileURL } = require("node:url");
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

const PLUGIN = path.join(__dirname, "..", "plugins", "factory-loop");
const SCRIPT = path.join(PLUGIN, "bin", "factory-answer");
const REPO_DIR = "cbundy__dev-system";

let contract;
let table;
let steps;
let scratch;
let cfg;
let answers;
let seq = 0;
let stubDir;
let ghLog;

// A stub `gh` first on every run's PATH, so no case reaches GitHub. By default it answers "exists"
// for each read; STUB_COMMIT, STUB_RELEASE, STUB_ISSUE and STUB_PR change one answer, and each
// call's argv is appended to STUB_LOG.
const GH_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "api repos/"*)
    case "$2" in
      */compare/*)
        case "\${STUB_COMPARE:-behind}" in
          behind|identical|ahead|diverged) echo "\${STUB_COMPARE:-behind}"; exit 0 ;;
          404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
          neterr) echo "error connecting to api.github.com" >&2; exit 1 ;;
        esac ;;
      repos/*/*/*) ;;
      repos/*/*) echo main; exit 0 ;;
    esac
    case "$2" in
      */commits/*) mode="\${STUB_COMMIT:-ok}" ;;
      *) mode="\${STUB_ISSUE:-ok}" ;;
    esac
    case "$mode" in
      ok) echo 123; exit 0 ;;
      404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      422) echo "gh: No commit found for SHA: abc (HTTP 422)" >&2; exit 1 ;;
      ratelimit) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;
      neterr) echo "error connecting to api.github.com" >&2; exit 1 ;;
      hang) exec sleep 5 ;;
    esac ;;
  "release view")
    case "\${STUB_RELEASE:-ok}" in
      ok) echo '{"tagName":"v1.0.0"}'; exit 0 ;;
      none) echo "release not found" >&2; exit 1 ;;
      neterr) echo "error connecting to api.github.com" >&2; exit 1 ;;
    esac ;;
  "pr view")
    # PR 913 is the shared table's merged PR
    if [ "$3" = "913" ]; then echo '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}'; exit 0; fi
    case "\${STUB_PR:-ok}" in
      ok) echo '{"state":"OPEN","mergedAt":null}'; exit 0 ;;
      merged) echo '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}'; exit 0 ;;
      closed) echo '{"state":"CLOSED","mergedAt":null}'; exit 0 ;;
      none) echo "GraphQL: Could not resolve to a PullRequest with the number of 812. (repository.pullRequest)" >&2; exit 1 ;;
    esac ;;
esac
echo "unexpected: $*" >&2
exit 1
`;

// A stub `callum-flow-issue-read` beside it: the issue's body is STUB_BODY (default: no Run it heading),
// STUB_READ=fail exits 1, STUB_READ=junk prints no JSON, STUB_READ=untrusted exits 3 and STUB_READ=hang never answers; --comment serves STUB_COMMENT on issue STUB_COMMENT_ISSUE; each call's argv and CALLUM_FLOW_REPO go to
// STUB_READ_LOG. With --comments it also serves STUB_BRIEF as a design brief comment (the parity test).
const READ_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.STUB_READ_LOG, process.argv.slice(2).join(" ") + " repo=" + process.env.CALLUM_FLOW_REPO + "\\n");
if (process.env.STUB_READ === "fail") { console.error("callum-flow-issue-read: cannot read"); process.exit(1); }
if (process.env.STUB_READ === "junk") { console.log("not json"); process.exit(0); }
if (process.env.STUB_READ === "untrusted") process.exit(3);
if (process.env.STUB_READ === "hang") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
if (process.argv.includes("--comment")) {
  console.log(JSON.stringify({ comment: { body: process.env.STUB_COMMENT ?? "", issue_url: "https://api.github.com/repos/cbundy/consumer/issues/" + (process.env.STUB_COMMENT_ISSUE ?? "470") }, stripped: 0 }));
  process.exit(0);
}
const out = { issue: { body: process.env.STUB_BODY ?? "Do the thing.\\n" } };
if (process.argv.includes("--comments")) out.comments = process.env.STUB_BRIEF ? [{ body: process.env.STUB_BRIEF }] : [];
console.log(JSON.stringify(out));
`;
let readLog;

before(async () => {
  contract = await import(pathToFileURL(path.join(PLUGIN, "hooks", "contract.mjs")).href);
  table = await import(pathToFileURL(path.join(PLUGIN, "tests", "answer-cases.mjs")).href);
  steps = await import(path.join(PLUGIN, "hooks", "v2", "steps.ts"));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-answer-"));
  cfg = path.join(scratch, "cfg");
  stubDir = path.join(scratch, "stub-bin");
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, "gh"), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, "callum-flow-issue-read"), READ_STUB, { mode: 0o755 });
  ghLog = path.join(scratch, "gh.log");
  readLog = path.join(scratch, "read.log");
  answers = path.join(cfg, "factory-loop", REPO_DIR, "answers");
  fs.mkdirSync(answers, { recursive: true });
});

after(() => {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true, force: true });
});

// issue: a fresh answer file the loop issued, with its job file written as the loop writes it
// (v2/steps.ts stepAnswerPath, contract.mjs jobText); the path, and the job file's.
function issue(job, dir = answers) {
  seq += 1;
  const file = steps.stepAnswerPath(path.dirname(dir), `i470/ltbq3k0/s${seq}/review/a1`);
  const jobPath = contract.jobPathOf(file);
  fs.writeFileSync(jobPath, contract.jobText(job));
  return { file, jobPath };
}

// answersOf: the answers directory of the loop for the job's repo (contract.mjs loopDirOf), made.
function answersOf(job) {
  const dir = path.join(cfg, "factory-loop", job.repo.replace("/", "__"), "answers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// run: the script as an agent's Bash runs it, from a directory of its own, with the config dir
// in its environment.
function run(args, { input, env = {}, cwd = os.tmpdir(), bin = SCRIPT } = {}) {
  const r = spawnSync(bin, args, {
    cwd,
    input: input ?? "",
    encoding: "utf8",
    env: { PATH: `${stubDir}:${process.env.PATH}`, STUB_LOG: ghLog, STUB_READ_LOG: readLog, HOME: path.join(scratch, "home"), CLAUDE_CONFIG_DIR: cfg, ...env },
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// problems: the problems the script named, one per `  - ` line.
function problemsOf(stderr) {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("  - "))
    .map((l) => l.slice(4));
}

// tree: every path under a directory, for "nothing else was written".
function tree(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...tree(p));
  }
  return out.sort();
}

const VALID = { findings: [{ id: "review-1", verdict: "WRONG", reason: "the timeout is handled in parse.ts" }], action: { type: "approve" } };
const gate = () => table.JOBS.gate;

test("the contract's declaration file names exactly the module's exports", () => {
  const dts = fs.readFileSync(path.join(PLUGIN, "hooks", "contract.d.mts"), "utf8");
  const declared = [...dts.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(contract).sort());
  const cases = fs.readFileSync(path.join(PLUGIN, "tests", "answer-cases.d.mts"), "utf8");
  assert.deepEqual([...cases.matchAll(/^export const (\w+)/gm)].map((m) => m[1]).sort(), Object.keys(table).sort());
});

test("every case of the shared table: the script records exactly the answers the contract takes, and names exactly its problems for the rest", () => {
  assert.ok(table.CASES.length >= 10);
  for (const c of table.CASES) {
    const { file } = issue(table.JOBS[c.job], answersOf(table.JOBS[c.job]));
    const r = run(["--to", file], { input: JSON.stringify(c.input) });
    if (c.problems.length === 0) {
      assert.equal(r.code, 0, `${c.name}: ${r.err}`);
      assert.match(r.out, new RegExp(`^factory-answer: recorded your ${table.JOBS[c.job].contract} answer \\(`));
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1, contract: table.JOBS[c.job].contract, answer: c.input }, c.name);
    } else {
      assert.equal(r.code, 1, `${c.name}: ${r.out}`);
      assert.deepEqual(problemsOf(r.err), c.problems, c.name);
      assert.equal(fs.existsSync(file), false, `${c.name}: nothing is written`);
    }
  }
});

test("the answer as one argument or on standard input, from any directory and through a link to the script", () => {
  const a = issue(gate());
  const arg = run(["--to", a.file, JSON.stringify(VALID)], { cwd: "/" });
  assert.equal(arg.code, 0, arg.err);
  assert.equal(arg.out, "factory-answer: recorded your verdict answer (action approve, 1 finding). End your turn now: the factory loop reads it when your turn ends.\n");
  const b = issue(gate());
  const piped = run([`--to=${b.file}`], { input: `${JSON.stringify(VALID, null, 2)}\n`, cwd: scratch });
  assert.equal(piped.code, 0, piped.err);
  // a heredoc's answer may hold any quote: the shell passes it as it stands
  const c = issue(gate());
  const quoted = { ...VALID, action: { type: "approve", reason: `it's "handled" in parse.ts` } };
  const linked = path.join(scratch, "bin-link");
  fs.symlinkSync(SCRIPT, linked);
  const viaLink = run(["--to", c.file], { input: JSON.stringify(quoted), bin: linked });
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.file, "utf8")).answer, quoted);
});

test("usage errors exit 2 and print the usage; --help exits 0", () => {
  const { file } = issue(gate());
  for (const [args, why] of [
    [[], "--to <answer file> is required"],
    [["--to"], "--to needs the answer file"],
    [["--to", file, "--to", file, "{}"], "--to is given twice"],
    [["--to", file, "--yes", "{}"], "unknown option --yes"],
    [["--to", file, "{}", "{}"], "give the JSON once"],
    [["--to", file], "no answer given"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    assert.ok(r.err.includes(why), `${args.join(" ")}: ${r.err}`);
    assert.ok(r.err.includes("usage: factory-answer --to <answer file> [<json>]"));
  }
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /^usage: factory-answer --to <answer file> \[<json>\]/);
  assert.equal(fs.existsSync(file), false);
});

test("an answer that is not JSON is refused with exit 1, and nothing is written", () => {
  const { file } = issue(gate());
  const r = run(["--to", file, "{findings: []"]);
  assert.equal(r.code, 1);
  assert.equal(problemsOf(r.err).length, 1);
  assert.match(problemsOf(r.err)[0], /^the answer is not JSON: /);
  assert.match(r.err, /Correct them and run factory-answer again\.\n$/);
  assert.equal(fs.existsSync(file), false);
});

test("the write is atomic: a new file renamed over the old one, never written in place, and no temp file left", () => {
  const { file } = issue(gate());
  assert.equal(run(["--to", file, JSON.stringify(VALID)]).code, 0);
  const first = fs.readFileSync(file, "utf8");
  // a second link to the first answer: a write in place would change it too, a rename does not
  const kept = path.join(scratch, "first-answer");
  fs.linkSync(file, kept);
  const corrected = { ...VALID, action: { type: "approve", reason: "a false positive" } };
  assert.equal(run(["--to", file, JSON.stringify(corrected)]).code, 0);
  assert.equal(fs.readFileSync(kept, "utf8"), first);
  assert.notEqual(fs.statSync(kept).ino, fs.statSync(file).ino);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).answer, corrected);
  assert.deepEqual(
    fs.readdirSync(answers).filter((n) => n.startsWith(".")),
    [],
  );
});

test("it writes the one file it is given and nothing else", () => {
  const { file, jobPath } = issue(gate());
  const before = tree(scratch);
  assert.equal(run(["--to", file, JSON.stringify(VALID)]).code, 0);
  assert.deepEqual(tree(scratch), [...before, file].sort());
  assert.equal(fs.readFileSync(jobPath, "utf8"), contract.jobText(gate()));
});

test("any other path is refused with exit 1 before anything is written: not absolute, not plain, not an answer file, outside the loop's answers, through a link, or with no job file", () => {
  const { file, jobPath } = issue(gate());
  const name = path.basename(file);
  // another tree of the same shape, outside this config's factory-loop directory
  const foreign = path.join(scratch, "elsewhere", "factory-loop", REPO_DIR, "answers");
  fs.mkdirSync(foreign, { recursive: true });
  const foreignJob = issue(gate(), foreign);
  // a loop dir whose answers directory is a link to the foreign one
  const linkedLoop = path.join(cfg, "factory-loop", "o__linked");
  fs.mkdirSync(linkedLoop);
  fs.symlinkSync(foreign, path.join(linkedLoop, "answers"));
  // a loop dir that is itself a link
  fs.symlinkSync(path.join(scratch, "elsewhere", "factory-loop", REPO_DIR), path.join(cfg, "factory-loop", "o__looplink"));
  // a target that is a link to a file outside, and one that is a directory
  const victim = path.join(scratch, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  const linkTarget = issue(gate());
  fs.symlinkSync(victim, linkTarget.file);
  const dirTarget = issue(gate());
  fs.mkdirSync(dirTarget.file);
  // a job file that is not the loop's
  const badJob = issue(gate());
  fs.writeFileSync(badJob.jobPath, '{"v": 1, "contract": "anything"}');
  // a job for another repo, in this repo's answers directory (contract.mjs loopDirOf)
  const otherRepo = issue({ ...gate(), repo: "other/repo" });
  const before = tree(scratch);
  const refusals = [
    [path.relative(os.tmpdir(), file), "is not an absolute path"],
    [`${answers}/../answers/${name}`, "is not a plain path"],
    [`${answers}/./${name}`, "is not a plain path"],
    [`${answers}//${name}`, "is not a plain path"],
    [jobPath, "is not an answer file"],
    [path.join(answers, "design.txt"), "is not an answer file"],
    [path.join(answers, `.${name}`), "is not an answer file"],
    ["/etc/passwd", "is not an answer file"],
    [path.join(cfg, "factory-loop", REPO_DIR, name), "is not in an answers directory of the factory loop"],
    [path.join(cfg, "factory-loop", "not-a-repo", "answers", name), "is not in an answers directory of the factory loop"],
    [foreignJob.file, "is not in an answers directory of the factory loop"],
    [path.join(linkedLoop, "answers", path.basename(foreignJob.file)), "is not in an answers directory of the factory loop"],
    [path.join(cfg, "factory-loop", "o__looplink", "answers", path.basename(foreignJob.file)), "is not in an answers directory of the factory loop"],
    [path.join(answers, "never-issued.a1.1.answer.json"), "issued no answer file"],
    [linkTarget.file, "is not a plain file"],
    [dirTarget.file, "is not a plain file"],
    [badJob.file, "the job file is not in the shape the factory loop writes"],
    [otherRepo.file, "is not in the answers directory of other/repo, the repo its job file names"],
  ];
  for (const [to, why] of refusals) {
    const r = run(["--to", to, JSON.stringify(VALID)]);
    assert.equal(r.code, 1, `${to}: ${r.out}${r.err}`);
    assert.ok(problemsOf(r.err).some((p) => p.includes(why)), `${to}: ${r.err}`);
  }
  assert.deepEqual(tree(scratch), before);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
});

test("without CLAUDE_CONFIG_DIR, the loop's answers are under ~/.claude, and only there", () => {
  const home = path.join(scratch, "home");
  const homeAnswers = path.join(home, ".claude", "factory-loop", REPO_DIR, "answers");
  fs.mkdirSync(homeAnswers, { recursive: true });
  const { file } = issue(gate(), homeAnswers);
  assert.equal(run(["--to", file, JSON.stringify(VALID)], { env: { CLAUDE_CONFIG_DIR: "" } }).code, 0);
  // the config dir's own answers are not this home's
  const other = issue(gate());
  assert.equal(run(["--to", other.file, JSON.stringify(VALID)], { env: { CLAUDE_CONFIG_DIR: "" } }).code, 1);
});

test("the loop and the script share one folder layout: contract.mjs loopDirOf, a trailing / on the config dir dropped", () => {
  const loopDir = contract.loopDirOf(cfg, "cbundy/dev-system");
  assert.equal(loopDir, path.join(cfg, "factory-loop", REPO_DIR));
  assert.equal(path.dirname(answers), loopDir);
  assert.equal(contract.loopDirOf(`${cfg}//`, "cbundy/dev-system"), loopDir);
  assert.equal(contract.loopBaseOf(`${cfg}/`), path.join(cfg, "factory-loop"));
  // a config dir given with a trailing / still finds the answers the loop issued
  const { file } = issue(gate());
  assert.equal(run(["--to", file, JSON.stringify(VALID)], { env: { CLAUDE_CONFIG_DIR: `${cfg}/` } }).code, 0);
});

// The block a prompt shows (v2/prompts-review.ts), cut out of a rendered prompt as an agent copies
// it and run by bash, records the answer: the command, its example JSON and the closing JSON line.
// The answer file is issued under contract.mjs loopDirOf, as the loop issues it.
test("the answer block a rendered prompt shows runs as copied: bash records the example answer", async () => {
  const prompts = await import(path.join(PLUGIN, "hooks", "v2", "prompts-review.ts"));
  const loopDir = contract.loopDirOf(cfg, "cbundy/dev-system");
  seq += 1;
  const file = steps.stepAnswerPath(loopDir, `i470/ltbq3k0/s${seq}/review/a1`);
  fs.writeFileSync(contract.jobPathOf(file), contract.jobText({ contract: "review", purpose: null, repo: "cbundy/dev-system", issue: 470, branch: "issue-470", data: { round: 1 } }));
  const input = { issue: 470, brief: "https://github.com/cbundy/dev-system/issues/470#issuecomment-9001", pr: 512, base: "main", head: "3f2a9c1d4e", patch: "f00dfeed", round: 1, prior: [], notes: [] };
  const prompt = prompts.adjudicatorPrompt(input, { repo: "cbundy/dev-system", branch: "issue-470", slot: null, scratch: "/tmp/scratch", place: { bin: SCRIPT, file } });
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => l.trim().startsWith(`${SCRIPT} --to ${file} `));
  const end = lines.findIndex((l, i) => i > at && l.trim() === "JSON");
  assert.ok(at !== -1 && end === at + 2, `no answer block in ${prompt}`);
  const r = spawnSync("bash", ["-c", lines.slice(at, end + 1).join("\n")], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: path.join(scratch, "home"), CLAUDE_CONFIG_DIR: cfg },
    timeout: 30_000,
  });
  // the script ran, read the example from standard input and checked it against the review contract
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^factory-answer: recorded your review answer/);
});

// A v2 split is held to the same contract the loop checks: four reasons and a why for each child.
test("a v2 split without reasons is refused and records nothing; a full split is recorded", () => {
  const job = { contract: "design-v2", purpose: null, repo: "cbundy/dev-system", issue: 470, branch: null };
  const body = "## Design brief (designer, 2026-10-17)\n\nDo it.\n\n## Rollout\n\nmerge - a self-contained change\n";
  const child = (key) => ({ key, title: `Part ${key}`, why: `Why ${key} stands alone`, body, blockedBy: [], ready: true });
  const reasons = { why_split: "It spans two areas", why_count: "Two: one per area", why_parts: "The areas ship apart", why_order: "The parts are independent" };
  const split = { kind: "split", brief: "the plan", children: [child("a"), child("b")] };
  const refused = issue(job);
  const bad = run(["--to", refused.file], { input: JSON.stringify(split) });
  assert.equal(bad.code, 1, bad.out);
  assert.deepEqual(problemsOf(bad.err), ["reasons is required for a split: { why_split, why_count, why_parts, why_order }"]);
  assert.equal(fs.existsSync(refused.file), false);
  const { why: _why, ...noWhy } = child("a");
  const bad2 = run(["--to", refused.file], { input: JSON.stringify({ ...split, reasons, children: [noWhy, child("b")] }) });
  assert.deepEqual(problemsOf(bad2.err), ["children[0] (a).why is required"]);
  assert.equal(fs.existsSync(refused.file), false);
  const ok = issue(job);
  const good = run(["--to", ok.file], { input: JSON.stringify({ ...split, reasons }) });
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, /^factory-answer: recorded your design-v2 answer \(a split into 2 children\)/);
});

// A v2 wait is held to the same contract the loop checks: 1 to 8 checkable conditions and a reason.
test("a v2 wait is recorded with its conditions; a tag-contains wait is accepted, a bad sha refused", () => {
  const job = { contract: "design-v2", purpose: null, repo: "cbundy/dev-system", issue: 837, branch: null };
  const conditions = [{ kind: "issue-closed", issue: 57 }, { kind: "pr-merged", pr: 812 }];
  const wait = { kind: "wait", conditions, reason: "Needs #57 closed and PR #812 merged first", brief: null };
  const ok = issue(job);
  const good = run(["--to", ok.file], { input: JSON.stringify(wait) });
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, /^factory-answer: recorded your design-v2 answer \(a wait on 2 conditions\)/);
  const tag = issue(job);
  const tagged = run(["--to", tag.file], { input: JSON.stringify({ ...wait, conditions: [{ kind: "tag-contains", sha: "35BB655" }] }) });
  assert.equal(tagged.code, 0, tagged.err);
  const refused = issue(job);
  const bad = run(["--to", refused.file], { input: JSON.stringify({ ...wait, conditions: [{ kind: "tag-contains", sha: "xyz" }] }) });
  assert.equal(bad.code, 1, bad.out);
  assert.match(problemsOf(bad.err).join("\n"), /conditions\[0\]\.sha "xyz" must be 7 to 40 hex/);
  assert.equal(fs.existsSync(refused.file), false);
});

// A design wait is read on GitHub for the job's repo before it is written (hooks/v2/wait-check.mjs, #980).
const WAIT_JOB = { contract: "design-v2", purpose: null, repo: "cbundy/dev-system", issue: 837, branch: null };
const waitOf = (...conditions) => ({ kind: "wait", conditions, reason: "Needs the others first", brief: null });
const TAG = { kind: "tag-contains", sha: "bd2fee14" };
const ISSUE = { kind: "issue-closed", issue: 57 };
const PR = { kind: "pr-merged", pr: 812 };
const readCalls = () => (fs.existsSync(readLog) ? fs.readFileSync(readLog, "utf8").split("\n").filter(Boolean) : []);
const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8").split("\n").filter(Boolean) : []);

// answerWait: the wait answered with the stub set by env; the result, the answer file and gh's calls.
function answerWait(answer, env = {}, opts = {}) {
  fs.rmSync(ghLog, { force: true });
  const { file } = issue(WAIT_JOB);
  const r = run(["--to", file], { input: JSON.stringify(answer), env, ...opts });
  return { ...r, file, calls: ghCalls() };
}

test("a wait on a sha that is no commit of the repo is refused, naming the repo; nothing is written", () => {
  for (const STUB_COMMIT of ["404", "422"]) {
    const r = answerWait(waitOf(TAG), { STUB_COMMIT });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(problemsOf(r.err), ["conditions[0]: bd2fee14 is not a commit of cbundy/dev-system; a wait on another repo's release names that repo"]);
    assert.equal(fs.existsSync(r.file), false);
    assert.ok(r.calls.includes("api repos/cbundy/dev-system/commits/bd2fee14 --jq .sha"), r.calls.join("|"));
  }
});

test("a wait on a release of a repo with no release is refused", () => {
  const r = answerWait(waitOf(TAG), { STUB_RELEASE: "none" });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(problemsOf(r.err), ["conditions[0]: cbundy/dev-system has no release yet, so no release tag can ever carry bd2fee14"]);
  assert.equal(fs.existsSync(r.file), false);
});

test("a wait on an unknown issue, an unknown PR or a PR closed unmerged is refused", () => {
  const issueRefused = answerWait(waitOf(ISSUE), { STUB_ISSUE: "404" });
  assert.equal(issueRefused.code, 1, issueRefused.out);
  assert.match(problemsOf(issueRefused.err)[0], /^conditions\[0\]: issue #57 does not exist in cbundy\/dev-system/);
  const none = answerWait(waitOf(PR), { STUB_PR: "none" });
  assert.equal(none.code, 1, none.out);
  assert.match(problemsOf(none.err)[0], /^conditions\[0\]: PR #812 does not exist in cbundy\/dev-system/);
  const closed = answerWait(waitOf(PR), { STUB_PR: "closed" });
  assert.equal(closed.code, 1, closed.out);
  assert.match(problemsOf(closed.err)[0], /^conditions\[0\]: PR #812 of cbundy\/dev-system is closed without being merged/);
  for (const r of [issueRefused, none, closed]) assert.equal(fs.existsSync(r.file), false);
});

test("two bad conditions give two problems, in order", () => {
  const r = answerWait(waitOf(ISSUE, PR), { STUB_ISSUE: "404", STUB_PR: "none" });
  assert.equal(r.code, 1, r.out);
  const problems = problemsOf(r.err);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^conditions\[0\]: issue #57/);
  assert.match(problems[1], /^conditions\[1\]: PR #812/);
});

test("a wait whose facts hold is recorded; the release is read once for several tag conditions", () => {
  const r = answerWait(waitOf(TAG, { kind: "tag-contains", sha: "35bb655" }, ISSUE, PR));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")).answer.conditions.length, 4);
  assert.equal(r.calls.filter((c) => c.startsWith("release view")).length, 1);
  assert.equal(r.calls.length, 5);
  const merged = answerWait(waitOf(PR), { STUB_PR: "merged" });
  assert.equal(merged.code, 0, merged.err);
});

test("a wait condition that names a repo is read in that repo, and is recorded with the repo (#981)", () => {
  const r = answerWait(waitOf({ kind: "tag-contains", sha: "bd2fee14", repo: "o/n" }, { kind: "issue-closed", issue: 57, repo: "o/n" }));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")).answer.conditions, [
    { kind: "tag-contains", sha: "bd2fee14", repo: "o/n" },
    { kind: "issue-closed", issue: 57, repo: "o/n" },
  ]);
  assert.ok(r.calls.includes("api repos/o/n/commits/bd2fee14 --jq .sha"), r.calls.join("|"));
  assert.ok(r.calls.includes("release view --repo o/n --json tagName"), r.calls.join("|"));
  assert.ok(r.calls.some((c) => c.startsWith("api repos/o/n/issues/57")), r.calls.join("|"));
  assert.ok(!r.calls.some((c) => c.includes("cbundy/dev-system")), r.calls.join("|"));
});

test("a gh that cannot decide records the wait and names the unchecked conditions on stderr", () => {
  for (const env of [{ STUB_ISSUE: "neterr" }, { STUB_ISSUE: "ratelimit" }, { STUB_ISSUE: "404x" }]) {
    const r = answerWait(waitOf(ISSUE), env);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(r.file), true);
    assert.equal(r.err.trim().split("\n").length, 1, r.err);
    assert.match(r.err, /^factory-answer: recorded without checking on GitHub: conditions\[0\] \(/);
  }
  const mixed = answerWait(waitOf(ISSUE, PR), { STUB_ISSUE: "neterr", STUB_PR: "none" });
  assert.equal(mixed.code, 1, "a definite negative still refuses beside an unchecked condition");
});

test("a gh that hangs past the timeout records the wait with the unchecked line", () => {
  const r = answerWait(waitOf(ISSUE), { STUB_ISSUE: "hang", FACTORY_ANSWER_GH_TIMEOUT_MS: "300" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^factory-answer: recorded without checking on GitHub: conditions\[0\] \(gh timed out/);
  assert.equal(fs.existsSync(r.file), true);
});

test("with no gh on PATH the wait is recorded with the unchecked line", () => {
  const bare = path.join(scratch, "node-only");
  fs.mkdirSync(bare, { recursive: true });
  const node = path.join(bare, "node");
  if (!fs.existsSync(node)) fs.symlinkSync(process.execPath, node);
  const { file } = issue(WAIT_JOB);
  const r = spawnSync(SCRIPT, ["--to", file], {
    input: JSON.stringify(waitOf(ISSUE)),
    encoding: "utf8",
    env: { PATH: bare, HOME: path.join(scratch, "home"), CLAUDE_CONFIG_DIR: cfg },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /recorded without checking on GitHub: conditions\[0\] \(gh is not installed\)/);
  assert.equal(fs.existsSync(file), true);
});

test("a brief, a question, a split and any other contract make no gh call", () => {
  fs.rmSync(readLog, { force: true });
  const brief = "## Design brief (designer, 2026-01-01)\n\n## Rollout\n\nmerge\n\n## Observability\n\nnone - no new decision\n\n## Compatibility\n\nnone - no schema, event or reader change\n";
  for (const answer of [{ kind: "brief", brief }, { kind: "question", question: "Which one?", brief: null }, { kind: "split", brief: "x" }]) {
    const r = answerWait(answer);
    assert.deepEqual(r.calls, [], JSON.stringify(answer));
    if (answer.kind === "brief") assert.equal(r.code, 0, "the brief fixture stays a valid brief");
  }
  // a merge brief makes exactly one issue read, and nothing else does
  assert.deepEqual(readCalls(), ["--json 837 repo=cbundy/dev-system"]);
  fs.rmSync(ghLog, { force: true });
  const g = issue(gate());
  assert.equal(run(["--to", g.file], { input: JSON.stringify(VALID) }).code, 0);
  // a wait the contract refuses is not read on GitHub either
  const bad = answerWait({ kind: "wait", conditions: [{ kind: "tag-contains", sha: "xyz" }], reason: "r", brief: null });
  assert.equal(bad.code, 1);
  assert.deepEqual(ghCalls(), []);
});

// A design done answer: the issue's work is merged. The shape is the contract's; the evidence is read
// on GitHub for the job's repo (hooks/v2/done-check.mjs).
const doneOf = (evidence, extra = {}) => ({ kind: "done", evidence, reason: "Already shipped in PR 812", brief: null, ...extra });
const DONE_PR = { pr: 812, commit: null, runIt: null };
const DONE_COMMIT = { pr: null, commit: "bd2fee14", runIt: null };

test("a done answer with a merged PR, or a commit on the default branch, is recorded", () => {
  const pr = answerWait(doneOf(DONE_PR), { STUB_PR: "merged" });
  assert.equal(pr.code, 0, pr.err);
  assert.match(pr.out, /^factory-answer: recorded your design-v2 answer \(a done close on PR #812\)/);
  assert.equal(pr.err, "");
  assert.equal(JSON.parse(fs.readFileSync(pr.file, "utf8")).answer.kind, "done");
  const commit = answerWait(doneOf(DONE_COMMIT));
  assert.equal(commit.code, 0, commit.err);
  assert.match(commit.out, /\(a done close on commit bd2fee1\)/);
  assert.ok(commit.calls.includes("api repos/cbundy/dev-system --jq .default_branch"), commit.calls.join("|"));
  assert.ok(commit.calls.includes("api repos/cbundy/dev-system/compare/main...bd2fee14 --jq .status"), commit.calls.join("|"));
  const same = answerWait(doneOf(DONE_COMMIT), { STUB_COMPARE: "identical" });
  assert.equal(same.code, 0, same.err);
});

test("a done answer on a PR that is open, closed unmerged or unknown is refused; nothing is written", () => {
  for (const [STUB_PR, text] of [["ok", /is open, not merged/], ["closed", /is closed, not merged/], ["none", /does not exist/]]) {
    const r = answerWait(doneOf(DONE_PR), { STUB_PR });
    assert.equal(r.code, 1, r.out);
    assert.match(problemsOf(r.err)[0], text);
    assert.equal(fs.existsSync(r.file), false);
  }
});

test("a done answer on a commit that is not on the default branch is refused", () => {
  for (const STUB_COMPARE of ["ahead", "diverged"]) {
    const r = answerWait(doneOf(DONE_COMMIT), { STUB_COMPARE });
    assert.equal(r.code, 1, r.out);
    assert.match(problemsOf(r.err)[0], new RegExp(`evidence.commit bd2fee14: bd2fee14 is not on main \\(compare says ${STUB_COMPARE}\\)`));
    assert.equal(fs.existsSync(r.file), false);
  }
  const unknown = answerWait(doneOf(DONE_COMMIT), { STUB_COMPARE: "404" });
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(problemsOf(unknown.err)[0], /is not a commit of cbundy\/dev-system/);
});

test("a done answer the contract refuses is not read on GitHub", () => {
  const cases = [
    [doneOf({ pr: null, commit: null, runIt: null }), /needs a merged pr or a commit/],
    [doneOf({ ...DONE_PR, runIt: "https://github.com/cbundy/dev-system/issues/1#issuecomment-5" }), /evidence.runIt .* must be a comment URL on this issue/],
    [doneOf(DONE_PR, { extra: 1 }), /extra is not a field/],
    [doneOf(DONE_PR, { reason: "two\nlines" }), /reason must be one line/],
    [doneOf(DONE_PR, { reason: null }), /reason is required/],
  ];
  for (const [answer, text] of cases) {
    const r = answerWait(answer, { STUB_PR: "merged" });
    assert.equal(r.code, 1, r.out);
    assert.match(problemsOf(r.err).join("\n"), text);
    assert.deepEqual(r.calls, []);
  }
  const own = answerWait(doneOf({ ...DONE_PR, runIt: "https://github.com/cbundy/dev-system/issues/837#issuecomment-123456" }), { STUB_PR: "merged" });
  assert.equal(own.code, 0, own.err);
});

test("a gh that cannot decide records the done answer and names the unchecked evidence on stderr", () => {
  const r = answerWait(doneOf(DONE_COMMIT), { STUB_COMPARE: "neterr" });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(r.file), true);
  assert.match(r.err, /^factory-answer: recorded without checking on GitHub: evidence.commit bd2fee14 \(/);
});

test("done-check's declaration file names exactly the module's exports", async () => {
  const mod = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", "done-check.mjs")).href);
  const dts = fs.readFileSync(path.join(PLUGIN, "hooks", "v2", "done-check.d.mts"), "utf8");
  const declared = [...dts.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(mod).sort());
  const answer = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", "done-answer.mjs")).href);
  const adts = fs.readFileSync(path.join(PLUGIN, "hooks", "v2", "done-answer.d.mts"), "utf8");
  assert.deepEqual([...adts.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort(), Object.keys(answer).sort());
});

test("wait-check's declaration file names exactly the module's exports", async () => {
  const mod = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", "wait-check.mjs")).href);
  const dts = fs.readFileSync(path.join(PLUGIN, "hooks", "v2", "wait-check.d.mts"), "utf8");
  const declared = [...dts.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(mod).sort());
});

test("wait-check maps a finished gh read to yes, no or unknown", async () => {
  const { statusOf, checkWait } = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", "wait-check.mjs")).href);
  const r = (code, stderr = "", stdout = "") => ({ code, stdout, stderr });
  assert.equal(statusOf(r(0, "", "1")), "yes");
  assert.equal(statusOf(r(1, "gh: Not Found (HTTP 404)")), "no");
  assert.equal(statusOf(r(1, "gh: No commit found for SHA: abc (HTTP 422)")), "no");
  assert.equal(statusOf(r(1, "release not found")), "no");
  assert.equal(statusOf(r(1, "GraphQL: Could not resolve to a PullRequest with the number of 9.")), "no");
  assert.equal(statusOf(r(1, "gh: API rate limit exceeded (HTTP 403)")), "unknown");
  assert.equal(statusOf(r(1, "gh: Too Many Requests (HTTP 429)")), "unknown");
  assert.equal(statusOf(r(1, "gh: Bad credentials (HTTP 401)")), "unknown");
  assert.equal(statusOf(r(1, "something odd")), "unknown");
  assert.equal(statusOf(null), "unknown");
  // a runner that throws leaves the condition unchecked, never a problem
  const out = await checkWait([{ kind: "issue-closed", issue: 5 }], "o/r", async () => {
    throw new Error("spawn gh ENOENT");
  });
  assert.deepEqual(out, { problems: [], unchecked: ["conditions[0] (spawn gh ENOENT)"] });
});

// A design brief's Rollout is read against the issue's body before it is written (hooks/v2/rollout-check.mjs, #987).
const briefOf = (rollout) => `## Design brief (designer, 2026-10-23)\n\n## Rollout\n\n${rollout}\n\n## Observability\n\nnone - no new decision\n\n## Compatibility\n\nnone - no schema, event or reader change\n`;
const STALE_BODY = "Build it.\n\n## Run it\nmoved to #832\n";
const ROLLOUT_JOB = { ...WAIT_JOB, issue: 467 };
function answerBrief(rollout, env = {}) {
  fs.rmSync(readLog, { force: true });
  const { file } = issue(ROLLOUT_JOB);
  const r = run(["--to", file], { input: JSON.stringify({ kind: "brief", brief: briefOf(rollout) }), env });
  return { ...r, file, reads: readCalls() };
}

test("a merge brief over a stale Run it heading is refused with callum-flow-rollout's reason; nothing is written (#467)", () => {
  const r = answerBrief("merge - the Run it moved to #832", { STUB_BODY: STALE_BODY });
  assert.equal(r.code, 1, r.out);
  const problems = problemsOf(r.err);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].startsWith("brief says merge but issue #467 has a '## Run it' heading"), problems[0]);
  assert.match(problems[0], /answer run-it .*ask the owner|question asking the owner to rename or remove it/);
  assert.equal(fs.existsSync(r.file), false);
  assert.deepEqual(r.reads, ["--json 467 repo=cbundy/dev-system"]);
});

test("run-it and keep-open briefs, and a merge over a body with no Run it heading, are recorded", () => {
  for (const [rollout, STUB_BODY] of [
    ["run-it - the Run it stands", STALE_BODY],
    ["keep-open - research only", STALE_BODY],
    ["merge - plain", "Do it.\n"],
    ["merge - plain", "Do it.\n\n```\n## Run it\n```\n"],
    ["merge - plain", "Do it, then run it after release.\n"],
  ]) {
    const r = answerBrief(rollout, { STUB_BODY });
    assert.equal(r.code, 0, `${rollout}: ${r.err}`);
    assert.equal(r.err, "");
    assert.equal(fs.existsSync(r.file), true);
    assert.equal(r.reads.length, rollout.startsWith("merge") ? 1 : 0, rollout);
  }
});

test("an issue read that decides nothing records the merge brief and names the unchecked Rollout", () => {
  for (const STUB_READ of ["fail", "junk"]) {
    const r = answerBrief("merge - plain", { STUB_BODY: STALE_BODY, STUB_READ });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^factory-answer: recorded without checking the Rollout against issue #467: /);
    assert.equal(fs.existsSync(r.file), true);
  }
  const bare = path.join(scratch, "node-only");
  fs.mkdirSync(bare, { recursive: true });
  const node = path.join(bare, "node");
  if (!fs.existsSync(node)) fs.symlinkSync(process.execPath, node);
  const { file } = issue(ROLLOUT_JOB);
  const r = spawnSync(SCRIPT, ["--to", file], {
    input: JSON.stringify({ kind: "brief", brief: briefOf("merge - plain") }),
    encoding: "utf8",
    env: { PATH: bare, HOME: path.join(scratch, "home"), CLAUDE_CONFIG_DIR: cfg },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /recorded without checking the Rollout against issue #467: callum-flow-issue-read is not installed/);
  assert.equal(fs.existsSync(file), true);
});

// An upstream request's owner authority, when it cites a comment or the issue itself, is read through
// callum-flow-issue-read (hooks/v2/upstream-check.mjs).
const UP_JOB = { contract: "design-v2", purpose: null, repo: "cbundy/consumer", issue: 470, branch: null, data: { ownerNotes: [] } };
const UP_COMMENT = "https://github.com/cbundy/consumer/issues/470#issuecomment-4242";
const UP_ISSUE = "https://github.com/cbundy/consumer/issues/470";
const upstreamAnswer = (source, quote = "raise it upstream in dev-system") => ({
  kind: "upstream",
  upstream: { repo: "cbundy/dev-system", request: "need", title: "A reader flag", body: "The reader needs a flag.", authority: { kind: "owner", source, quote } },
  reason: "Waits on the reader flag",
  brief: null,
});
function answerUpstream(answer, env = {}) {
  fs.rmSync(readLog, { force: true });
  const { file } = issue(UP_JOB, answersOf(UP_JOB));
  const r = run(["--to", file], { input: JSON.stringify(answer), env });
  return { ...r, file, reads: readCalls() };
}

test("an upstream request citing a comment is recorded when the comment holds the quote; the read is of that comment in the job's repo", () => {
  const r = answerUpstream(upstreamAnswer(UP_COMMENT), { STUB_COMMENT: "Yes, please  RAISE it upstream in dev-system, it's the way." });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.match(r.out, /recorded your design-v2 answer \(an upstream request to cbundy\/dev-system \(need\)\)/);
  assert.equal(fs.existsSync(r.file), true);
  assert.deepEqual(r.reads, [`--json --comment ${UP_COMMENT} repo=cbundy/consumer`]);
  const body = answerUpstream(upstreamAnswer(UP_ISSUE), { STUB_BODY: "We should raise it upstream in dev-system.\n" });
  assert.equal(body.code, 0, body.err);
  assert.deepEqual(body.reads, ["--json 470 repo=cbundy/consumer"]);
});

test("an upstream request is refused when the comment has no quote, is by an untrusted author or is on another issue; nothing is written", () => {
  const none = answerUpstream(upstreamAnswer(UP_COMMENT), { STUB_COMMENT: "Please do something else." });
  assert.equal(none.code, 1, none.out);
  assert.match(problemsOf(none.err)[0], /^authority\.quote is not in https:\/\/github\.com\/cbundy\/consumer\/issues\/470#issuecomment-4242/);
  const untrusted = answerUpstream(upstreamAnswer(UP_COMMENT), { STUB_READ: "untrusted" });
  assert.equal(untrusted.code, 1, untrusted.out);
  assert.match(problemsOf(untrusted.err)[0], /is by an author the factory does not trust/);
  const other = answerUpstream(upstreamAnswer(UP_COMMENT), { STUB_COMMENT: "raise it upstream in dev-system", STUB_COMMENT_ISSUE: "471" });
  assert.equal(other.code, 1, other.out);
  assert.match(problemsOf(other.err)[0], /is a comment on issue #471, not on this issue #470/);
  for (const r of [none, untrusted, other]) assert.equal(fs.existsSync(r.file), false);
});

test("an upstream request whose authority read decides nothing is recorded and names the unchecked authority", () => {
  for (const STUB_READ of ["fail", "junk", "hang"]) {
    const r = answerUpstream(upstreamAnswer(UP_COMMENT), { STUB_READ, FACTORY_ANSWER_GH_TIMEOUT_MS: "300" });
    assert.equal(r.code, 0, `${STUB_READ}: ${r.err}`);
    assert.match(r.err, new RegExp(`^factory-answer: recorded without checking the owner authority of the upstream request against ${UP_COMMENT}: `));
    assert.equal(fs.existsSync(r.file), true);
  }
});

test("a note or bug authority makes no issue read", () => {
  const job = { ...UP_JOB, data: { ownerNotes: ["Raise it upstream in dev-system."] } };
  fs.rmSync(readLog, { force: true });
  const { file } = issue(job, answersOf(job));
  const r = run(["--to", file], { input: JSON.stringify(upstreamAnswer("note")) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCalls(), []);
});

test("upstream-check's declaration file names exactly the module's exports", async () => {
  for (const name of ["upstream-check", "upstream-answer"]) {
    const mod = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", `${name}.mjs`)).href);
    const dts = fs.readFileSync(path.join(PLUGIN, "hooks", "v2", `${name}.d.mts`), "utf8");
    assert.deepEqual([...dts.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort(), Object.keys(mod).sort(), name);
  }
});

test("question, wait, done and split answers, and a gate job make no issue read", () => {
  for (const answer of [{ kind: "question", question: "Which one?", brief: null }, { kind: "split", brief: "x" }, waitOf(ISSUE), doneOf(DONE_PR)]) {
    fs.rmSync(readLog, { force: true });
    answerWait(answer, { STUB_PR: "merged" });
    assert.deepEqual(readCalls(), [], JSON.stringify(answer));
  }
  fs.rmSync(readLog, { force: true });
  const g = issue(gate());
  assert.equal(run(["--to", g.file], { input: JSON.stringify(VALID) }).code, 0);
  assert.deepEqual(readCalls(), []);
});

test("hasRunItHeading and callum-flow-rollout agree on the same bodies", async () => {
  const { hasRunItHeading, conflictReason } = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", "rollout-check.mjs")).href);
  const bodies = [
    STALE_BODY,
    "Do it.\n",
    "Do it.\n\n```\n## Run it\n```\n",
    "Do it.\n\n~~~\n## Run it\n~~~\n\nafter",
    "Do it, then run it after release.\n",
    "# run IT\nx\n",
    "###### Run it  \nx\n",
    "####### Run it\nx\n",
    "## Run it now\nx\n",
    "  ## Run it\nx\n",
    "## Run it\n",
  ];
  const rollout = path.join(__dirname, "..", "images", "base", "callum-flow-rollout");
  for (const body of bodies) {
    const r = spawnSync(rollout, ["5"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CALLUM_FLOW_ISSUE_READ_BIN: path.join(stubDir, "callum-flow-issue-read"), STUB_READ_LOG: readLog, STUB_BODY: body, STUB_BRIEF: briefOf("merge - plain") },
      timeout: 30_000,
    });
    const conflict = hasRunItHeading(body);
    assert.equal(r.status, conflict ? 1 : 0, `${JSON.stringify(body)}: ${r.stdout}${r.stderr}`);
    if (conflict) assert.equal(r.stdout.trim(), `ROLLOUT conflict ${conflictReason(5)}`, JSON.stringify(body));
    else assert.doesNotMatch(r.stdout, /conflict/);
  }
});

test("callum-flow-rollout reads a summary-plus-Details brief as it reads the same brief without the details lines", () => {
  const rollout = path.join(__dirname, "..", "images", "base", "callum-flow-rollout");
  const nested = (value) => `## Design brief (designer, 2026-10-24)\n\nPlain summary.\n\n<details><summary>Exploration</summary>\n\nRead things.\n\n</details>\n\n## Acceptance criteria\nOne line.\n\n<details><summary>Details</summary>\n\n- a\n\n</details>\n\n## Rollout\n${value}\n\n## Open decisions\nnone\n`;
  const strip = (b) => b.split("\n").filter((l) => !/^(<details>|<\/details>|<summary>)/.test(l)).join("\n");
  for (const value of ["merge - plain", "run-it - has a Run it", "keep-open - research"]) {
    const outs = [nested(value), strip(nested(value))].map((brief) => {
      const r = spawnSync(rollout, ["5"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, CALLUM_FLOW_ISSUE_READ_BIN: path.join(stubDir, "callum-flow-issue-read"), STUB_READ_LOG: readLog, STUB_BODY: "Do it.\n", STUB_BRIEF: brief },
        timeout: 30_000,
      });
      return { status: r.status, stdout: r.stdout };
    });
    assert.deepEqual(outs[0], outs[1], value);
    assert.match(outs[0].stdout, new RegExp(`ROLLOUT ${value.split(" ")[0]}`));
  }
});

test("rollout-check's declaration file names exactly the module's exports", async () => {
  const mod = await import(pathToFileURL(path.join(PLUGIN, "hooks", "v2", "rollout-check.mjs")).href);
  const dts = fs.readFileSync(path.join(PLUGIN, "hooks", "v2", "rollout-check.d.mts"), "utf8");
  const declared = [...dts.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(mod).sort());
});
