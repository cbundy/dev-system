"use strict";

// fabriek-capture (cbundy/dev-system#1271): the supervisor is tested with a fake Playwright
// module in a temp cwd and a fake fabriek-evidence-upload first on PATH, so no browser is needed.
// Waits are on recorded pids, polled to a bound, never on sleeps.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const TOOL = path.join(__dirname, "..", "images", "base", "fabriek-capture");

const FAKE_PLAYWRIGHT = `
const fs = require("fs");
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
exports.chromium = {
  launch: async () => {
    if (process.env.FAKE_NO_BROWSER) throw new Error("browserType.launch: Executable doesn't exist at /x");
    return {
      newContext: async (opts) => {
        log({ viewport: opts.viewport, video: !!opts.recordVideo });
        return {
          newPage: async () => {
            const handlers = {};
            return {
              on: (ev, fn) => { handlers[ev] = fn; },
              goto: async (url) => {
                if (process.env.FAKE_PAGE_ERROR) handlers.pageerror(new Error("boom"));
                return { status: () => Number(process.env.FAKE_STATUS || 200) };
              },
              screenshot: async ({ path: p, fullPage }) => { log({ shot: p, fullPage }); fs.writeFileSync(p, PNG); },
              video: () => ({ saveAs: async (p) => fs.writeFileSync(p, "webm") }),
            };
          },
          close: async () => {},
        };
      },
      close: async () => { log({ closed: true }); },
    };
  },
};
`;

const SERVER = `require("http").createServer((q, r) => r.end("ok")).listen(process.env.PORT, "127.0.0.1", () => require("fs").writeFileSync(process.env.PIDFILE, String(process.pid)));`;

function setup({ playwright = true, upload = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfc-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "server.js"), SERVER);
  if (playwright) {
    fs.mkdirSync(path.join(dir, "node_modules", "playwright"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "playwright", "package.json"), '{"name":"playwright","main":"index.js"}');
    fs.writeFileSync(path.join(dir, "node_modules", "playwright", "index.js"), FAKE_PLAYWRIGHT);
  }
  if (upload) {
    fs.writeFileSync(path.join(bin, "fabriek-evidence-upload"), `#!/bin/sh\n${upload}\n`, { mode: 0o755 });
  }
  // an empty npm root so a global Playwright on the machine cannot be found
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho ${path.join(dir, "no-global")}\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: dir,
    FAKE_LOG: path.join(dir, "fake.log"),
    PIDFILE: path.join(dir, "server.pid"),
  };
  delete env.FAKE_NO_BROWSER;
  return { dir, env };
}

function run(ctx, args, extraEnv = {}) {
  return spawnSync("node", [TOOL, ...args], {
    cwd: ctx.dir,
    env: { ...ctx.env, ...extraEnv },
    encoding: "utf8",
    timeout: 60000,
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertGone(pid) {
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  assert.ok(!alive(pid), `pid ${pid} is gone`);
}

const pidOf = (ctx, f = "server.pid") => Number(fs.readFileSync(path.join(ctx.dir, f), "utf8"));
const START = "node server.js";

test("a capture takes both sizes, prints the paths, and stops the server", () => {
  const ctx = setup();
  const r = run(ctx, ["--start", START, "home"]);
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.trim().split("\n");
  assert.equal(files.length, 2);
  assert.match(files[0], /home-desktop\.png$/);
  assert.match(files[1], /home-narrow\.png$/);
  for (const f of files) assert.ok(fs.existsSync(f));
  const log = fs.readFileSync(ctx.env.FAKE_LOG, "utf8");
  assert.match(log, /"width":1440,"height":900/);
  assert.match(log, /"width":390,"height":844/);
  assert.match(log, /"fullPage":true/);
  assert.match(log, /"closed":true/);
  assertGone(pidOf(ctx));
});

test("--video adds a webm, {port} is substituted, --out and --path are honoured", () => {
  const ctx = setup();
  const out = path.join(ctx.dir, "o");
  const r = run(ctx, ["--start", "PORT={port} node server.js", "--video", "--out", out, "--path", "/x", "v1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["v1-desktop.png", "v1-narrow.png", "v1.webm"]);
  assert.match(r.stdout, /v1\.webm/);
  assertGone(pidOf(ctx));
});

test("a grandchild in the app's process group is stopped on success and on failure", () => {
  for (const status of [200, 404]) {
    const ctx = setup();
    const start = `sleep 300 & echo $! > ${ctx.dir}/gc.pid; exec node server.js`;
    const r = run(ctx, ["--start", start, "gc"], { FAKE_STATUS: String(status) });
    assert.equal(r.status, status === 200 ? 0 : 4, r.stderr);
    assertGone(pidOf(ctx, "gc.pid"));
    assertGone(pidOf(ctx));
  }
});

test("an app that never listens times out with exit 3 and is stopped", () => {
  const ctx = setup();
  const start = `echo $$ > ${ctx.dir}/p.pid; exec sleep 300`;
  const t0 = Date.now();
  const r = run(ctx, ["--start", start, "--timeout", "2", "slow"]);
  assert.equal(r.status, 3);
  assert.ok(Date.now() - t0 < 30000);
  assert.equal(r.stderr.trim().split("\n").filter((l) => l.startsWith("fabriek-capture:")).length, 1);
  assert.match(r.stderr, /did not answer/);
  assertGone(pidOf(ctx, "p.pid"));
});

test("an app that exits at once is exit 3 naming the exit", () => {
  const ctx = setup();
  const r = run(ctx, ["--start", "exit 7", "gone"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /exited \(code 7\)/);
});

test("a page error and a 404 are exit 4 and the server is gone", () => {
  for (const [env, re] of [[{ FAKE_PAGE_ERROR: "1" }, /page error/], [{ FAKE_STATUS: "404" }, /HTTP 404/]]) {
    const ctx = setup();
    const r = run(ctx, ["--start", START, "bad"], env);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, re);
    assertGone(pidOf(ctx));
  }
});

test("no Playwright is exit 69 naming the dev image fix; a missing Chromium is too", () => {
  const ctx = setup({ playwright: false });
  const r = run(ctx, ["--start", START, "nope"]);
  assert.equal(r.status, 69);
  assert.match(r.stderr, /per-repo dev image/);
  assert.ok(!fs.existsSync(path.join(ctx.dir, "server.pid")), "no server was started");

  const ctx2 = setup();
  const r2 = run(ctx2, ["--start", START, "nobrowser"], { FAKE_NO_BROWSER: "1" });
  assert.equal(r2.status, 69);
  assert.match(r2.stderr, /per-repo dev image/);
  assertGone(pidOf(ctx2));
});

test("SIGTERM mid-wait stops the app and exits", async () => {
  const ctx = setup();
  const start = `echo $$ > ${ctx.dir}/p.pid; exec sleep 300`;
  const child = spawn("node", [TOOL, "--start", start, "--timeout", "120", "term"], { cwd: ctx.dir, env: ctx.env, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  const pidFile = path.join(ctx.dir, "p.pid");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(pidFile), "app started");
  const pid = pidOf(ctx, "p.pid");
  child.kill("SIGTERM");
  const res = await exited;
  assert.equal(res.code, 143);
  assertGone(pid);
});

test("--dest prints the upload's URLs; exit 78 keeps the files and names the folder; exit 1 is 1", () => {
  const ctx = setup({ upload: 'for f in "$@"; do [ -f "$f" ] && echo "https://e/$(basename "$f")"; done; true' });
  const r = run(ctx, ["--start", START, "--dest", "pr-1/x", "up"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["https://e/up-desktop.png", "https://e/up-narrow.png"]);

  for (const [rc, want] of [[78, 78], [1, 1], [2, 1]]) {
    const c = setup({ upload: `exit ${rc}` });
    const o = run(c, ["--start", START, "--dest", "pr-1/x", "k"]);
    assert.equal(o.status, want, o.stderr);
    const m = o.stderr.match(/kept in (\S+)/);
    assert.ok(m, o.stderr);
    assert.ok(fs.existsSync(path.join(m[1], "k-desktop.png")));
    assert.equal(o.stdout, "");
  }
});

test("bad usage is exit 2 and --help is 0", () => {
  const ctx = setup();
  assert.equal(run(ctx, ["home"]).status, 2);
  assert.equal(run(ctx, ["--start", START]).status, 2);
  assert.equal(run(ctx, ["--start", START, "Bad_Name"]).status, 2);
  assert.equal(run(ctx, ["--start", START, "-x"]).status, 2);
  assert.equal(run(ctx, ["--start", START, "--bogus", "a"]).status, 2);
  assert.equal(run(ctx, ["--start", START, "--path", "x", "a"]).status, 2);
  assert.equal(run(ctx, ["--help"]).status, 0);
});
