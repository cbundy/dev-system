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
    "echo B1; sleep 0.3; echo B2; exit 2",
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

test("a crash status (126 or more) counts 1", () => {
  const x = run(["exit 130"], { env: { TEST_JOBS: "1" } });
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
