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
let exec;
let scratch;
let cfg;
let answers;
let seq = 0;

before(async () => {
  contract = await import(pathToFileURL(path.join(PLUGIN, "hooks", "contract.mjs")).href);
  table = await import(pathToFileURL(path.join(PLUGIN, "tests", "answer-cases.mjs")).href);
  exec = await import(path.join(PLUGIN, "hooks", "exec.ts"));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "factory-loop-answer-"));
  cfg = path.join(scratch, "cfg");
  answers = path.join(cfg, "factory-loop", REPO_DIR, "answers");
  fs.mkdirSync(answers, { recursive: true });
});

after(() => {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true, force: true });
});

// issue: a fresh answer file the loop issued, with its job file written as the loop writes it
// (exec.ts scriptAnswerPath, contract.mjs jobText); the path, and the job file's.
function issue(job, dir = answers) {
  seq += 1;
  const file = exec.scriptAnswerPath(path.dirname(dir), { key: `adjudicate:R470:review:abc${seq}`, attempts: 1, startedAt: 1760430000000 + seq });
  const jobPath = contract.jobPathOf(file);
  fs.writeFileSync(jobPath, contract.jobText(job));
  return { file, jobPath };
}

// run: the script as an agent's Bash runs it, from a directory of its own, with the config dir
// in its environment.
function run(args, { input, env = {}, cwd = os.tmpdir(), bin = SCRIPT } = {}) {
  const r = spawnSync(bin, args, {
    cwd,
    input: input ?? "",
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: path.join(scratch, "home"), CLAUDE_CONFIG_DIR: cfg, ...env },
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
    const { file } = issue(table.JOBS[c.job]);
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

// The block a prompt shows (prompts.ts scriptAsk), cut out of a rendered prompt as an agent copies
// it and run by bash, records the answer: the command, its example JSON and the closing JSON line.
// The answer file is issued under contract.mjs loopDirOf, as the loop issues it.
test("the answer block a rendered prompt shows runs as copied: bash records the example answer", async () => {
  const prompts = await import(path.join(PLUGIN, "hooks", "prompts.ts"));
  const loopDir = contract.loopDirOf(cfg, "cbundy/dev-system");
  for (const purpose of ["gate", "weakening", "merge"]) {
    seq += 1;
    const key = `adjudicate:R470:review:blk${seq}`;
    const file = exec.scriptAnswerPath(loopDir, { key, attempts: 1, startedAt: 1760430000000 + seq });
    fs.writeFileSync(contract.jobPathOf(file), contract.jobText(table.JOBS[purpose]));
    const action = {
      reason: "test", kind: "spawn", agent: "adjudicator", purpose, key, class: "drive", rule: "P2", issue: 470,
      run: "R470", branch: "feat/issue-470-x", step: purpose === "gate" ? "review" : null, head: "3f2a9c1d4e", pr: 512,
      brief: "https://github.com/cbundy/dev-system/issues/470#issuecomment-9001", model: null,
      warns: purpose === "weakening" ? ["GUARD test-weakening WARN 3f2a9c1 removed 2 assertions"] : [],
      handoffHead: purpose === "merge" ? "2e1d0c9b8a" : null, verdicts: [], guard: [],
    };
    const prompt = prompts.promptOf(action, { repo: "cbundy/dev-system", modelOverride: null, inFlight: [], channel: "script", script: { bin: SCRIPT, file } });
    const lines = prompt.split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith(`${SCRIPT} --to ${file} `));
    const end = lines.findIndex((l, i) => i > at && l.trim() === "JSON");
    assert.ok(at !== -1 && end === at + 2, `${purpose}: no answer block in ${prompt}`);
    const r = spawnSync("bash", ["-c", lines.slice(at, end + 1).join("\n")], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: path.join(scratch, "home"), CLAUDE_CONFIG_DIR: cfg },
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `${purpose}: ${r.stderr}`);
    assert.match(r.stdout, /^factory-answer: recorded your verdict answer/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).answer, JSON.parse(lines[at + 1].trim()), purpose);
  }
});
