// Tests for images/base/dev-login-page.js (cbundy/dev-system#375): its repeated checks read dev-login's
// cached state, the page start passes --optional, and an optional tool counts as done. A stub
// `dev-login` on PATH records its arguments and answers from a fixture.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawn } = require("node:child_process");

const PAGE = path.join(__dirname, "..", "images", "base", "dev-login-page.js");

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });

// Starts the page against a stub dev-login whose --json answer is `tools`.
async function startPage(t, tools, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-page-"));
  fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify(tools));
  fs.writeFileSync(path.join(dir, "dev-login"), `#!/bin/sh\necho "$*" >> "${dir}/args"\nenv | sed -n 's/^\\(DEV_[A-Za-z0-9_]*\\)=.*/\\1/p' > "${dir}/env-names"\ncat "${dir}/tools.json"\n`, { mode: 0o755 });
  const port = await freePort();
  const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DEV_")));
  const child = spawn("node", [PAGE], {
    env: { ...hostEnv, PATH: `${dir}:${process.env.PATH}`, DEV_LOGIN_PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  t.after(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await get(port, "/healthz")).status === 200) break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const calls = () => (fs.existsSync(path.join(dir, "args")) ? fs.readFileSync(path.join(dir, "args"), "utf8").trim().split("\n") : []);
  const envNames = () => fs.readFileSync(path.join(dir, "env-names"), "utf8").trim().split("\n").sort();
  return { port, calls, envNames, stderr: () => stderr, child, exited };
}

const tools = {
  claude: { state: "in", url: null, code: null },
  codex: { state: "out", url: "https://auth.openai.com/codex/device", code: "CDX1-ABCDE", optional: true },
  gh: { state: "in", url: null, code: null },
};

test("/status reads the cached state", async (t) => {
  const page = await startPage(t, tools, { DEV_LOGIN_PAGE_EXIT: "0" });
  const r = await get(page.port, "/status");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { claude: "in", codex: "out", gh: "in" });
  assert.ok(page.calls().includes("status --json --cached"), page.calls().join("\n"));
  assert.ok(!page.calls().some((c) => c.startsWith("status") && !c.includes("--cached")), page.calls().join("\n"));
});

test("GET / starts the logins with --optional and labels the optional card", async (t) => {
  const page = await startPage(t, tools, { DEV_LOGIN_PAGE_EXIT: "0" });
  const r = await get(page.port, "/");
  assert.equal(r.status, 200);
  assert.ok(page.calls().includes("start --json --optional"), page.calls().join("\n"));
  assert.match(r.body, /codex[^]*\(optional\)/);
});

test("an optional tool that is out counts as done: the page exits", async (t) => {
  const page = await startPage(t, tools, { DEV_LOGIN_PAGE_EXIT: "1" });
  const code = await page.exited;
  assert.equal(code, 0, page.stderr());
  assert.ok(page.calls().includes("status --json --cached"), page.calls().join("\n"));
});

test("a required tool that is out keeps the page up", async (t) => {
  const page = await startPage(t, { ...tools, claude: { state: "out", url: null, code: null } }, { DEV_LOGIN_PAGE_EXIT: "1" });
  assert.equal((await get(page.port, "/healthz")).status, 200);
  assert.equal(page.child.exitCode, null);
});

test("page commands receive only explicit DEV settings", async (t) => {
  const inherited = {
    DEV_REPO_URL: "https://host.invalid/workspace.git",
    DEV_NOTIFY_URL: "https://notify.invalid/host",
    DEV_LOGIN_PAGE_URL: "https://page.invalid/host",
    DEV_LOGIN_TOOLS: "host-tool",
  };
  const previous = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, inherited);
    const page = await startPage(t, tools, { DEV_LOGIN_PAGE_EXIT: "0" });
    assert.equal((await get(page.port, "/")).status, 200);
    assert.deepEqual(page.envNames(), ["DEV_LOGIN_PAGE_EXIT", "DEV_LOGIN_PORT"]);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
