"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// Execute the entrypoint with image-only paths mapped into a disposable fixture.
// Assertions cover process exit, command output and the final heartbeat invocation.
async function fixture(t, init) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-"));
  t.after(() => {
    for (const name of ["init-pid", "command-pid"]) {
      if (fs.existsSync(path.join(dir, name))) {
        try { process.kill(Number(fs.readFileSync(path.join(dir, name), "utf8")), "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function script(name, body) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  script("id", "echo 1000");
  script("workspace.sh", 'workspace() { printf "%s\\n" "$FIXTURE"; }');
  script("dev-init", `echo $$ > "$FIXTURE/init-pid"; ${init}`);
  script("heartbeat-loop", 'printf "%s\\n" "$*" >> "$FIXTURE/final"; echo heartbeat-output');
  const source = fs.readFileSync(path.join(__dirname, "../images/base/dev-entrypoint"), "utf8");
  fs.writeFileSync(path.join(dir, "entrypoint"), source.replaceAll("/usr/local/share/dev-system/", `${dir}/`));
  return {
    dir,
    run(command) {
      const child = spawn("bash", [path.join(dir, "entrypoint"), "bash", "-c", `echo $$ > "$FIXTURE/command-pid"; ${command}`], {
        cwd: dir,
        env: { ...process.env, FIXTURE: dir, PATH: `${dir}:${process.env.PATH}` },
      });
      let out = "", err = "";
      child.stdout.on("data", (data) => { out += data; });
      child.stderr.on("data", (data) => { err += data; });
      const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out, err })));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
      return { child, done };
    },
  };
}

async function ready(dir, name) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(path.join(dir, name))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${name} did not become ready`);
}

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
  for (const phase of ["init", "command"]) {
    test(`${signal} during ${phase} writes a final heartbeat and preserves status`, { timeout: 5000 }, async (t) => {
      const f = await fixture(t, phase === "init" ? 'touch "$FIXTURE/init-ready"; exec sleep infinity' : "exit 0");
      const { child, done } = f.run('touch "$FIXTURE/command-ready"; exec sleep infinity');
      await ready(f.dir, `${phase}-ready`);
      child.kill(signal);
      const result = await done;
      assert.equal(result.code, code, result.err);
      assert.equal(result.signal, null);
      assert.equal(result.out, "");
      assert.equal(fs.readFileSync(path.join(f.dir, "final"), "utf8"), "--final\n");
      if (phase === "init") assert.equal(fs.existsSync(path.join(f.dir, "command-ready")), false);
    });
  }
}

test("ordinary completion preserves stdout and status after best-effort init", async (t) => {
  const f = await fixture(t, "echo init-output; exit 3");
  const result = await f.run("echo command-output; exit 7").done;
  assert.equal(result.code, 7, result.err);
  assert.equal(result.out, "command-output\n");
  assert.equal(fs.readFileSync(path.join(f.dir, "final"), "utf8"), "--final\n");
});
