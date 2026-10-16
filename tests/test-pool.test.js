"use strict";

// scripts/test-pool.sh: the bounded job pool behind `npm test` (scripts/test.sh), driven with
// fixture jobs (tiny shell commands in a temp dir).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const POOL = path.resolve(__dirname, "..", "scripts", "test-pool.sh");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-pool-"));
  const results = path.join(dir, "results");
  fs.mkdirSync(results);
  return { dir, results, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(jobs, { env = {}, serial = [] } = {}) {
  const f = fixture();
  fs.writeFileSync(path.join(f.dir, "jobs"), jobs.join("\n") + "\n");
  fs.writeFileSync(path.join(f.dir, "serial"), serial.join("\n") + (serial.length ? "\n" : ""));
  const r = spawnSync("sh", [POOL, f.results, path.join(f.dir, "jobs"), path.join(f.dir, "serial")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const failed = fs.existsSync(path.join(f.results, "failed"))
    ? fs.readFileSync(path.join(f.results, "failed"), "utf8").trim()
    : null;
  return { ...f, r, failed };
}

test("all passing: no output, exit 0, failed count 0", () => {
  const x = run(["echo hi", "true"], { env: { TEST_JOBS: "2" } });
  try {
    assert.strictEqual(x.r.status, 0);
    assert.strictEqual(x.r.stdout, "");
    assert.strictEqual(x.r.stderr, "");
    assert.strictEqual(x.failed, "0");
  } finally {
    x.cleanup();
  }
});

test("mixed: only failing blocks, in job order, contiguous, exit 1", () => {
  // The first failing job finishes last, so completion order differs from job order.
  const jobs = [
    "sleep 1; echo A1; sleep 0.2; echo A2; exit 1",
    "echo passing-output",
    'echo B1; sleep 0.3; echo B2; echo 2 > "$TEST_JOB_FAILED"; exit 1',
    "exit 1",
  ];
  const x = run(jobs, { env: { TEST_JOBS: "4" } });
  try {
    assert.strictEqual(x.r.status, 1);
    assert.strictEqual(x.r.stdout, "");
    assert.strictEqual(x.r.stderr, "A1\nA2\nB1\nB2\n");
    assert.strictEqual(x.failed, "4"); // 1 + 2 + 1, the silent failure counts too
  } finally {
    x.cleanup();
  }
});

test("a failing job's own count is used in full, with no cap", () => {
  const x = run(['echo 250 > "$TEST_JOB_FAILED"; exit 1'], { env: { TEST_JOBS: "1" } });
  try {
    assert.strictEqual(x.r.status, 1);
    assert.strictEqual(x.failed, "250");
  } finally {
    x.cleanup();
  }
});

test("a crash status, or a count written by a passing job, counts as the status says", () => {
  const x = run(["exit 130", 'echo 5 > "$TEST_JOB_FAILED"; exit 0'], { env: { TEST_JOBS: "1" } });
  try {
    assert.strictEqual(x.r.status, 1);
    assert.strictEqual(x.failed, "1");
  } finally {
    x.cleanup();
  }
});

test("TEST_JOBS bounds how many jobs are live at once", () => {
  const f = fixture();
  try {
    const live = path.join(f.dir, "live");
    const peak = path.join(f.dir, "peak");
    fs.mkdirSync(live);
    // Each job registers with mkdir, records how many are live, lingers, then deregisters.
    const job = (i) =>
      `mkdir ${live}/${i}; ls ${live} | wc -l >> ${peak}; sleep 0.3; rmdir ${live}/${i}`;
    const jobs = Array.from({ length: 6 }, (_, i) => job(i));
    fs.writeFileSync(path.join(f.dir, "jobs"), jobs.join("\n") + "\n");
    const r = spawnSync("sh", [POOL, f.results, path.join(f.dir, "jobs")], {
      encoding: "utf8",
      env: { ...process.env, TEST_JOBS: "2" },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const seen = fs.readFileSync(peak, "utf8").trim().split("\n").map(Number);
    assert.strictEqual(seen.length, 6);
    assert.ok(Math.max(...seen) <= 2, `peak ${Math.max(...seen)} exceeds 2`);
    assert.ok(Math.max(...seen) === 2, "the pool never ran two jobs at once");
  } finally {
    f.cleanup();
  }
});

test("TEST_JOBS that is not a positive integer fails fast", () => {
  for (const bad of ["0", "abc", "", "-1", "2.5"]) {
    const x = run(["true"], { env: { TEST_JOBS: bad } });
    try {
      assert.strictEqual(x.r.status, 2, `TEST_JOBS='${bad}'`);
      assert.strictEqual(x.r.stderr.trim().split("\n").length, 1);
      assert.match(x.r.stderr, /TEST_JOBS must be a positive integer/);
    } finally {
      x.cleanup();
    }
  }
});

test("jobs start in list order, so slow-first entries start before the rest", () => {
  const f = fixture();
  try {
    const order = path.join(f.dir, "order");
    const jobs = ["slow-1", "slow-2", "rest-1", "rest-2"].map((n) => `echo ${n} >> ${order}`);
    fs.writeFileSync(path.join(f.dir, "jobs"), jobs.join("\n") + "\n");
    const r = spawnSync("sh", [POOL, f.results, path.join(f.dir, "jobs")], {
      encoding: "utf8",
      env: { ...process.env, TEST_JOBS: "1" },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(order, "utf8"), "slow-1\nslow-2\nrest-1\nrest-2\n");
  } finally {
    f.cleanup();
  }
});

test("serial jobs run alone, after the pool drains", () => {
  const f = fixture();
  try {
    const live = path.join(f.dir, "live");
    const log = path.join(f.dir, "log");
    fs.mkdirSync(live);
    const job = (name) =>
      `mkdir ${live}/${name}; echo "${name} live=$(ls ${live} | wc -l)" >> ${log}; sleep 0.3; rmdir ${live}/${name}`;
    fs.writeFileSync(path.join(f.dir, "jobs"), [job("p1"), job("p2"), job("p3")].join("\n") + "\n");
    fs.writeFileSync(path.join(f.dir, "serial"), job("s1") + "\n");
    const r = spawnSync("sh", [POOL, f.results, path.join(f.dir, "jobs"), path.join(f.dir, "serial")], {
      encoding: "utf8",
      env: { ...process.env, TEST_JOBS: "3" },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.strictEqual(lines[lines.length - 1], "s1 live=1");
    assert.strictEqual(lines.length, 4);
  } finally {
    f.cleanup();
  }
});

test("SIGTERM stops running jobs and leaves no stray processes", async () => {
  const f = fixture();
  try {
    const pidfile = path.join(f.dir, "pids");
    const job = `echo $$ >> ${pidfile}; sleep 30`;
    fs.writeFileSync(path.join(f.dir, "jobs"), [job, job].join("\n") + "\n");
    const child = spawn("sh", [POOL, f.results, path.join(f.dir, "jobs")], {
      env: { ...process.env, TEST_JOBS: "2" },
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
    for (let i = 0; i < 100 && !(fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").trim().split("\n").length === 2); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pids = fs.readFileSync(pidfile, "utf8").trim().split("\n").map(Number);
    assert.strictEqual(pids.length, 2);
    child.kill("SIGTERM");
    const { code } = await exited;
    assert.strictEqual(code, 143);
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The killed jobs are reparented and reaped asynchronously: give them a moment.
    for (let i = 0; i < 100 && pids.some(isAlive); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const pid of pids) assert.ok(!isAlive(pid), `job ${pid} still running`);
  } finally {
    f.cleanup();
  }
});

// scripts/test.sh itself, run from a throwaway copy of the repo layout with fixture tests, so
// the real entrypoint drives the real pool and jobs without running this repo's suite.
function fakeRepo({ nodeTests = {}, suites = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-sh-"));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  for (const name of ["test.sh", "test-pool.sh", "test-job.sh", "test-reporter.js", "test-sandbox.sh", "test-pg.sh"]) {
    fs.copyFileSync(path.join(__dirname, "..", "scripts", name), path.join(scripts, name));
  }
  fs.mkdirSync(path.join(root, "tests"));
  for (const [name, body] of Object.entries(nodeTests)) fs.writeFileSync(path.join(root, "tests", name), body);
  const suiteDir = path.join(root, "features", "test", "callum-tools");
  fs.mkdirSync(suiteDir, { recursive: true });
  for (const [name, body] of Object.entries(suites)) fs.writeFileSync(path.join(suiteDir, name), body);
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  // Without node:test's own marker, so the nested `node --test` runs as a top-level run.
  const env = { ...process.env, TEST_JOBS: "2", TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  // These fixtures drive the pool, not the database: no server, so scripts/test-pg.sh takes its
  // skip path instead of starting a PostgreSQL cluster for every fixture run.
  delete env.FACTORY_TEST_PG_ADMIN_URL;
  delete env.TEST_REQUIRE_POSTGRES;
  env.TEST_PG_BIN_ROOT = path.join(root, "no-postgres");
  return { root, tmp, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("test.sh reports the full node failure count, past 100", () => {
  const failing = Array.from({ length: 101 }, (_, i) => `test("t${i}", () => assert.fail("no"));`);
  const repo = fakeRepo({
    nodeTests: { "many.test.js": `const test = require("node:test"); const assert = require("node:assert");\n${failing.join("\n")}\n` },
  });
  try {
    const r = spawnSync("sh", [path.join(repo.root, "scripts", "test.sh")], {
      encoding: "utf8",
      env: repo.env,
    });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stderr.trim().split("\n").pop(), "test: 101 failed");
  } finally {
    repo.cleanup();
  }
});

test("Ctrl-C on test.sh stops the backgrounded pool and leaves no stray processes or temp files", async () => {
  const repo = fakeRepo({
    nodeTests: { "ok.test.js": 'require("node:test")("ok", () => {});\n' },
  });
  const pidfile = path.join(repo.root, "pids");
  const suite = `echo $$ >> ${pidfile}; sleep 30\n`;
  fs.writeFileSync(path.join(repo.root, "features", "test", "callum-tools", "a.test.sh"), suite);
  fs.writeFileSync(path.join(repo.root, "features", "test", "callum-tools", "b.test.sh"), suite);
  try {
    // Its own process group, as a terminal's foreground job is, so Ctrl-C hits every process.
    const child = spawn("sh", [path.join(repo.root, "scripts", "test.sh")], {
      env: { ...repo.env, TEST_JOBS: "4" },
      stdio: "ignore",
      detached: true,
    });
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 200 && !(fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").trim().split("\n").length === 2); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pids = fs.readFileSync(pidfile, "utf8").trim().split("\n").map(Number);
    assert.strictEqual(pids.length, 2);
    const start = Date.now();
    process.kill(-child.pid, "SIGINT");
    const code = await exited;
    assert.strictEqual(code, 130);
    assert.ok(Date.now() - start < 10000, "test.sh waited for the jobs instead of stopping them");
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && pids.some(isAlive); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const pid of pids) assert.ok(!isAlive(pid), `job ${pid} still running`);
    assert.deepStrictEqual(fs.readdirSync(repo.tmp), []);
  } finally {
    repo.cleanup();
  }
});

test("SIGTERM on test.sh cannot launch queued jobs during descendant collection", async () => {
  const repo = fakeRepo({
    nodeTests: { "ok.test.js": 'require("node:test")("ok", async () => { await new Promise(r => setTimeout(r, 100)); });\n' },
  });
  const pidfile = path.join(repo.root, "pids");
  const suiteDir = path.join(repo.root, "features", "test", "callum-tools");
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(suiteDir, `queued-${i}.test.sh`),
      `echo $$ >> ${pidfile}; sleep 30 &\necho $! >> ${pidfile}; wait\n`);
  }
  let child;
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const pids = () => fs.existsSync(pidfile)
    ? fs.readFileSync(pidfile, "utf8").trim().split("\n").map(Number) : [];
  try {
    child = spawn("sh", [path.join(repo.root, "scripts", "test.sh")], {
      env: repo.env, stdio: "ignore", detached: true,
    });
    const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
    for (let i = 0; i < 200 && pids().length < 2; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(pids().length >= 2, "fixture job did not start");
    child.kill("SIGTERM");
    let timeout;
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("test.sh did not stop within 10 seconds")), 10000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.strictEqual(code, 143);
    for (let i = 0; i < 100 && pids().some(alive); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    for (const pid of pids()) assert.ok(!alive(pid), `queued job or child ${pid} survived cancellation`);
    assert.deepStrictEqual(fs.readdirSync(repo.tmp), []);
  } finally {
    if (child) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    repo.cleanup();
  }
});

test("invalid TEST_JOBS emits one error before missing required mod tooling", () => {
  const repo = fakeRepo({ nodeTests: {} });
  try {
    const hooks = path.join(repo.root, "plugins", "fixture", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "hooks.json"), '{"modules":[]}');
    // Supply normal shell tools, but deliberately omit the optional Claude CLI.
    const bin = path.join(repo.root, "bin");
    fs.mkdirSync(bin);
    for (const name of ["sh", "dirname", "mktemp", "mkdir", "rm", "grep"]) {
      const tool = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      fs.symlinkSync(tool, path.join(bin, name));
    }
    const r = spawnSync("sh", [path.join(repo.root, "scripts", "test.sh")], {
      encoding: "utf8", env: { ...repo.env, PATH: bin, TEST_REQUIRE_CLAUDE: "1", TEST_JOBS: "0" },
    });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.stderr, "test-pool: TEST_JOBS must be a positive integer, got '0'\n");
    assert.deepStrictEqual(fs.readdirSync(repo.tmp), []);
  } finally { repo.cleanup(); }
});

test("test.sh fails, naming each file, when a suite writes into the sandboxed state dirs", () => {
  const dirs = ["CALLUM_EVENTS_DIR", "NO_MISTAKES_HOME", "NM_PUSH_STATE_DIR", "AGENTSVIEW_DATA_DIR"];
  const repo = fakeRepo({
    nodeTests: { "ok.test.js": 'require("node:test")("ok", () => {});\n' },
    suites: {
      "clean.test.sh": "true\n",
      "leak.test.sh": dirs.map((d) => `echo x > "$${d}/leak"; echo "$${d}" >> "$LEAK_LOG"\n`).join(""),
    },
  });
  const log = path.join(repo.root, "leaked");
  try {
    const r = spawnSync("sh", [path.join(repo.root, "scripts", "test.sh")], {
      encoding: "utf8",
      env: { ...repo.env, LEAK_LOG: log },
    });
    assert.strictEqual(r.status, 1, r.stderr);
    const leaked = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.strictEqual(leaked.length, 4);
    const lines = r.stderr.trim().split("\n");
    for (const dir of leaked) assert.ok(lines.includes(`FAIL test isolation: ${dir}/leak`), r.stderr);
    assert.strictEqual(lines.pop(), "test: 1 failed");
    assert.deepStrictEqual(fs.readdirSync(repo.tmp), []);
  } finally {
    repo.cleanup();
  }
});
