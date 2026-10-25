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

// Runs 8 lingering jobs with TEST_JOBS unset and fake node/getconf first on PATH; returns the peak.
function peakWithFakes(fakes) {
  const f = fixture();
  try {
    const bin = path.join(f.dir, "bin");
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(fakes)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const live = path.join(f.dir, "live");
    const peak = path.join(f.dir, "peak");
    fs.mkdirSync(live);
    const jobs = Array.from(
      { length: 8 },
      (_, i) => `mkdir ${live}/${i}; ls ${live} | wc -l >> ${peak}; sleep 0.3; rmdir ${live}/${i}`,
    );
    fs.writeFileSync(path.join(f.dir, "jobs"), jobs.join("\n") + "\n");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.TEST_JOBS;
    const r = spawnSync("sh", [POOL, f.results, path.join(f.dir, "jobs")], { encoding: "utf8", env });
    assert.strictEqual(r.status, 0, r.stderr);
    return Math.max(...fs.readFileSync(peak, "utf8").trim().split("\n").map(Number));
  } finally {
    f.cleanup();
  }
}

test("default pool size comes from node availableParallelism", () => {
  assert.strictEqual(peakWithFakes({ node: "echo 2", getconf: "echo 5" }), 2);
});

test("default pool size falls back to getconf when node is missing or prints nonsense", () => {
  assert.strictEqual(peakWithFakes({ node: "exit 127", getconf: "echo 3" }), 3);
  assert.strictEqual(peakWithFakes({ node: "echo 0", getconf: "echo 3" }), 3);
  assert.strictEqual(peakWithFakes({ node: "echo many", getconf: "echo 3" }), 3);
  assert.strictEqual(peakWithFakes({ node: "exit 1", getconf: "exit 0", nproc: "echo 3" }), 3);
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
  for (const name of ["test.sh", "test-pool.sh", "test-job.sh", "test-reporter.js", "test-sandbox.sh", "test-pg.sh", "test-lock.sh", "test-db-guard"]) {
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
  // Its own lock dir, and no marker from the run this test sits in: each fixture is a top-level run.
  delete env.TEST_LOCK_HELD;
  // A fixture run that exits before its own sandbox setup (a signal while waiting for the lock, a
  // bad argument) would otherwise remove the sandbox of the run this test sits in.
  delete env.TEST_SANDBOX;
  delete env.TEST_NODE_CONCURRENCY;
  env.TEST_LOCK_DIR = path.join(root, "lock");
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
  const dirs = ["CALLUM_EVENTS_DIR", "AGENTSVIEW_DATA_DIR"];
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
    assert.strictEqual(leaked.length, 2);
    const lines = r.stderr.trim().split("\n");
    for (const dir of leaked) assert.ok(lines.includes(`FAIL test isolation: ${dir}/leak`), r.stderr);
    assert.strictEqual(lines.pop(), "test: 1 failed");
    assert.deepStrictEqual(fs.readdirSync(repo.tmp), []);
  } finally {
    repo.cleanup();
  }
});

test("test.sh fails when a suite connects psql to a real configured database host", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "denied-secrets-"));
  fs.writeFileSync(path.join(secrets, "agentsview-pg-url"), "postgres://u:secret@denied.example/x\n");
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-psql-"));
  fs.writeFileSync(path.join(fakeBin, "psql"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const repo = fakeRepo({
    nodeTests: { "ok.test.js": 'require("node:test")("ok", () => {});\n' },
    suites: { "leak.test.sh": 'env -i PATH="$PATH" psql "postgres://u@denied.example/x" -c "select 1" || true\n' },
  });
  try {
    const r = spawnSync("sh", [path.join(repo.root, "scripts", "test.sh")], {
      encoding: "utf8",
      env: { ...repo.env, PATH: `${fakeBin}:${process.env.PATH}`, TEST_SANDBOX_DENY_HOSTS_FROM: secrets },
    });
    assert.strictEqual(r.status, 1, r.stderr);
    const lines = r.stderr.trim().split("\n");
    assert.ok(lines.some((l) => /^FAIL test isolation: non-test database denied\.example \(.+\)$/.test(l)), r.stderr);
    assert.ok(!r.stderr.includes("secret"), "no credential is printed");
    assert.strictEqual(lines.pop(), "test: 1 failed");
  } finally {
    repo.cleanup();
    fs.rmSync(secrets, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

// scripts/test-lock.sh: one full run per machine, nested runs exempt, CPUs shared by live runs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A suite that records that it started, then blocks until `release` exists.
function blockingSuite(repo, name) {
  const started = path.join(repo.root, `${name}.started`);
  const release = path.join(repo.root, "release");
  fs.writeFileSync(
    path.join(repo.root, "features", "test", "callum-tools", `${name}.test.sh`),
    `echo $$ > ${started}\nwhile [ ! -e ${release} ]; do sleep 0.05; done\n`,
  );
  return { started, release };
}

function startRun(repo, args = [], env = {}) {
  const child = spawn("sh", [path.join(repo.root, "scripts", "test.sh"), ...args], {
    env: { ...repo.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const run = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (run.stdout += d));
  child.stderr.on("data", (d) => (run.stderr += d));
  run.exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return run;
}

test("a second full run waits for the first and names the holder once", async () => {
  const repo = fakeRepo({});
  const a = blockingSuite(repo, "a");
  const second = path.join(repo.root, "features", "test", "callum-tools", "b.test.sh");
  const bStarted = path.join(repo.root, "b.started");
  const runs = [];
  // b runs only in the second run: it checks the first one is gone by the time it starts.
  fs.writeFileSync(second, `[ -e ${a.release} ] || exit 1\ntouch ${bStarted}\n`);
  try {
    const first = startRun(repo, [], { TEST_JOBS: "1" });
    runs.push(first);
    await until(() => fs.existsSync(a.started), "the first run's suite");
    assert.match(fs.readFileSync(path.join(repo.root, "lock", "lock"), "utf8"), new RegExp(`^${first.child.pid} ${repo.root}\\n$`));
    const next = startRun(repo, [], { TEST_JOBS: "1" });
    runs.push(next);
    await until(() => next.stderr.includes("waiting"), "the waiting line");
    assert.strictEqual(
      next.stderr,
      `test: waiting for another full run (pid ${first.child.pid}, ${repo.root}) to finish\n`,
    );
    await sleep(300);
    assert.ok(!fs.existsSync(bStarted), "the second run started its suites while the first held the lock");
    fs.writeFileSync(a.release, "");
    assert.strictEqual(await first.exited, 0, first.stderr);
    assert.strictEqual(await next.exited, 0, next.stderr);
    assert.ok(fs.existsSync(bStarted));
    assert.strictEqual(next.stderr.split("\n").filter((l) => l.includes("waiting")).length, 1);
  } finally {
    fs.writeFileSync(path.join(repo.root, "release"), "");
    await Promise.all(runs.map((r) => r.exited));
    repo.cleanup();
  }
});

// Holds the lock the way a full run does (flock on <lock dir>/lock) from a separate process.
async function holdLock(repo) {
  fs.mkdirSync(repo.env.TEST_LOCK_DIR, { recursive: true });
  const lock = path.join(repo.env.TEST_LOCK_DIR, "lock");
  const held = path.join(repo.root, "held");
  const holder = spawn("flock", [lock, "sh", "-c", `touch ${held}; sleep 60`], { stdio: "ignore", detached: true });
  await until(() => fs.existsSync(held), "the test's own lock holder");
  return () => process.kill(-holder.pid, "SIGKILL");
}

test("a subset run, a nested run, --list and bad arguments never wait for the lock", async () => {
  const repo = fakeRepo({});
  fs.writeFileSync(path.join(repo.root, "features", "test", "callum-tools", "quick.test.sh"), "exit 0\n");
  const release = await holdLock(repo);
  const sh = path.join(repo.root, "scripts", "test.sh");
  const run = (args, env = {}) => spawnSync("sh", [sh, ...args], { encoding: "utf8", env: { ...repo.env, ...env }, timeout: 30000 });
  try {
    const subset = run(["features/test/callum-tools/quick.test.sh"]);
    assert.strictEqual(subset.status, 0, subset.stderr);
    const nested = run([], { TEST_LOCK_HELD: repo.env.TEST_LOCK_DIR });
    assert.strictEqual(nested.status, 0, nested.stderr);
    assert.strictEqual(nested.stderr, "");
    const list = run(["--list"]);
    assert.strictEqual(list.status, 0, list.stderr);
    assert.strictEqual(run(["no/such.test.sh"]).status, 2);
    assert.strictEqual(run([], { TEST_JOBS: "x" }).status, 2);
    assert.strictEqual(run([], { TEST_SHARD: "3/2" }).status, 2);
    for (const r of [subset, nested, list]) assert.doesNotMatch(r.stderr, /waiting/);
    // Nested and subset runs left no registration behind except dead ones are ignored.
    assert.deepStrictEqual(fs.readdirSync(repo.env.TEST_LOCK_DIR).filter((f) => /^\d+$/.test(f)), []);
  } finally {
    release();
    repo.cleanup();
  }
});

test("a full run and a shard run without flock on PATH run unlocked and say so", () => {
  const repo = fakeRepo({});
  // A PATH holding every tool the current one does, except flock.
  const bin = path.join(repo.root, "noflock-bin");
  fs.mkdirSync(bin);
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n === "flock") continue;
      try { fs.symlinkSync(path.join(dir, n), path.join(bin, n)); } catch { /* first one on PATH wins */ }
    }
  }
  const sh = path.join(repo.root, "scripts", "test.sh");
  try {
    for (const shard of [undefined, "1/2"]) {
      const env = { ...repo.env, PATH: bin };
      if (shard) env.TEST_SHARD = shard;
      const r = spawnSync("sh", [sh], { encoding: "utf8", env, timeout: 60000 });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /\(runs unlocked: flock not on PATH\)\s*$/, `shard ${shard}: ${r.stdout}`);
    }
  } finally {
    repo.cleanup();
  }
});

test("SIGTERM to a run waiting for the lock exits 143 at once and leaves no temp dir", async () => {
  const repo = fakeRepo({});
  fs.writeFileSync(path.join(repo.root, "features", "test", "callum-tools", "quick.test.sh"), "exit 0\n");
  const release = await holdLock(repo);
  try {
    const waiting = startRun(repo);
    await until(() => waiting.stderr.includes("waiting"), "the waiting line");
    const start = Date.now();
    process.kill(waiting.child.pid, "SIGTERM");
    assert.strictEqual(await waiting.exited, 143);
    assert.ok(Date.now() - start < 5000);
    assert.deepStrictEqual(fs.readdirSync(repo.tmp), []);
  } finally {
    release();
    repo.cleanup();
  }
});

test("the lock is free once its holder is SIGKILLed, though a job it started still runs", async () => {
  const repo = fakeRepo({});
  const pidfile = path.join(repo.root, "jobpid");
  fs.writeFileSync(path.join(repo.root, "features", "test", "callum-tools", "a.test.sh"), `echo $$ > ${pidfile}\nsleep 60\n`);
  let jobPid = 0;
  try {
    const holder = startRun(repo);
    await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").trim() !== "", "the holder's job");
    jobPid = Number(fs.readFileSync(pidfile, "utf8"));
    process.kill(holder.child.pid, "SIGKILL");
    await holder.exited;
    assert.ok(isAlive(jobPid), "the job should outlive its killed parent for this test to mean anything");
    const r = spawnSync("flock", ["-n", path.join(repo.env.TEST_LOCK_DIR, "lock"), "true"], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, "the lock is still held by a process the killed run left behind");
  } finally {
    if (jobPid) {
      try {
        process.kill(jobPid, "SIGKILL");
      } catch {}
    }
    repo.cleanup();
  }
});

// Peak concurrency of `n` suites in a fakeRepo run with the given env. Each suite logs "+", waits at a
// barrier until the log holds `target` "+" lines (the concurrency the case expects), then logs "-". With
// the pool allowing `target` workers the suites meet however slow the machine is, so the peak is exactly
// `target`; no sleep decides the overlap. The 30 s deadline is a hang guard for a broken pool that runs
// fewer than `target` jobs (the assertion then fails with the peak instead of waiting out spawnSync's
// 120 s timeout). It is never part of a passing run and sits well above the seconds a loaded machine
// takes to start `target` shell jobs.
async function peakSuites(repo, n, target, env, setup) {
  const log = path.join(repo.root, "conc");
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(
      path.join(repo.root, "features", "test", "callum-tools", `s${i}.test.sh`),
      `echo + >> ${log}\n` +
        `deadline=$(( $(date +%s) + 30 ))\n` +
        `while [ "$(grep -c '^+$' ${log})" -lt ${target} ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.05; done\n` +
        `echo - >> ${log}\n`,
    );
  }
  if (setup) setup();
  const e = { ...repo.env, ...env };
  if (!("TEST_JOBS" in env)) delete e.TEST_JOBS;
  const r = spawnSync("sh", [path.join(repo.root, "scripts", "test.sh")], { encoding: "utf8", env: e, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stderr);
  let cur = 0;
  let peak = 0;
  for (const l of fs.readFileSync(log, "utf8").trim().split("\n")) {
    cur += l === "+" ? 1 : -1;
    peak = Math.max(peak, cur);
  }
  return peak;
}

test("with another live run registered, the pool gets its share of the CPUs; dead entries and TEST_JOBS are respected", async () => {
  const cpus = os.availableParallelism();
  const n = cpus * 2 + 2;
  const register = (repo, pid) => {
    fs.mkdirSync(repo.env.TEST_LOCK_DIR, { recursive: true });
    fs.writeFileSync(path.join(repo.env.TEST_LOCK_DIR, String(pid)), "/elsewhere\n");
  };
  const sleeper = spawn("sleep", ["120"], { stdio: "ignore" });
  const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  try {
    // Alone: the whole CPU count (node itself adds no suite jobs here, only the shell suites count).
    let repo = fakeRepo({});
    try {
      const alone = await peakSuites(repo, n, cpus, {});
      assert.ok(alone <= cpus, `alone: peak ${alone} exceeds the bound ${cpus}`);
      assert.ok(alone >= cpus, `alone: peak ${alone} never reached the bound ${cpus}`);
    } finally {
      repo.cleanup();
    }
    repo = fakeRepo({});
    try {
      const share = Math.max(1, Math.floor(cpus / 2));
      const shared = await peakSuites(repo, n, share, {}, () => register(repo, sleeper.pid));
      assert.ok(shared <= share, `shared: peak ${shared} exceeds the bound ${share}`);
      assert.ok(shared >= share, `shared: peak ${shared} never reached the bound ${share}`);
    } finally {
      repo.cleanup();
    }
    repo = fakeRepo({});
    try {
      const ignoreDead = await peakSuites(repo, n, cpus, {}, () => register(repo, dead));
      assert.ok(ignoreDead <= cpus, `dead entry: peak ${ignoreDead} exceeds the bound ${cpus}`);
      assert.ok(ignoreDead >= cpus, `dead entry: peak ${ignoreDead} never reached the bound ${cpus}`);
      assert.ok(!fs.existsSync(path.join(repo.env.TEST_LOCK_DIR, dead)), "a dead run's entry is removed");
    } finally {
      repo.cleanup();
    }
    repo = fakeRepo({});
    try {
      const explicit = await peakSuites(repo, 4, 3, { TEST_JOBS: "3" }, () => register(repo, sleeper.pid));
      assert.strictEqual(explicit, 3, `explicit TEST_JOBS=3: peak ${explicit}, bound 3`);
    } finally {
      repo.cleanup();
    }
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("test-pool.sh --cpus prints the CPU count the default pool size uses", () => {
  const r = spawnSync("sh", [POOL, "--cpus"], { encoding: "utf8", env: { ...process.env, TEST_JOBS: "oops" } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(Number(r.stdout.trim()), os.availableParallelism());
});
