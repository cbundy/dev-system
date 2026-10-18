"use strict";

// scripts/lint-files.sh and scripts/lint-file.sh: the parallel per-file checks behind
// scripts/lint.sh, driven with fixture files in a temp dir.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LINT_FILES = path.resolve(__dirname, "..", "scripts", "lint-files.sh");
const HAVE_SHELLCHECK = spawnSync("shellcheck", ["--version"]).status === 0;
const SC = { skip: HAVE_SHELLCHECK ? false : "shellcheck not on PATH; CI runs it" };

const BAD_SH = "#!/bin/sh\nx=$(echo a)\necho $y\nunused=1\n";
const BAD_BASH = "#!/bin/bash\nfor f in $(ls); do echo $f; done\n";

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-files-"));
  const paths = [];
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    paths.push(p);
  }
  fs.writeFileSync(path.join(dir, "list"), paths.join("\n") + "\n");
  return { dir, paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(f, { env = {}, args = [], jobs = "2", path: pathEnv } = {}) {
  const results = path.join(f.dir, "results");
  const r = spawnSync("sh", [LINT_FILES, path.join(f.dir, "list"), results, ...args], {
    encoding: "utf8",
    env: { ...process.env, TEST_JOBS: jobs, ...(pathEnv ? { PATH: pathEnv } : {}), ...env },
  });
  return r;
}

const FILES = {
  "clean.sh": "#!/bin/sh\necho ok\n",
  "bad1.sh": BAD_SH,
  "bad2.bash": BAD_BASH,
  "dir/directive": "# shellcheck shell=bash\necho \"$BASH_VERSION\"\n",
  "node-tool": "#!/usr/bin/env node\nconsole.log(1);\n",
  "broken.js": "const = ;\n",
  "zsh-tool": "#!/bin/zsh\necho hi\n",
  "README.md": "# readme\n",
};

test("counts, failure order and unknown shebang", SC, () => {
  const f = fixture(FILES);
  try {
    const r = run(f);
    assert.strictEqual(r.status, 0);
    // Checked: clean, bad1, bad2, directive, node-tool = 5 (broken.js is not classified without --js,
    // the zsh shebang fails without being checked, README is skipped). Failed: bad1, bad2, zsh = 3.
    assert.strictEqual(r.stdout, "5 3\n");
    const order = [...r.stderr.matchAll(/^lint: FAIL (\S+)/gm)].map((m) => path.basename(m[1].replace(/:$/, "")));
    assert.deepStrictEqual(order, ["bad1.sh", "bad2.bash", "zsh-tool"]);
    assert.ok(r.stderr.includes(`lint: FAIL ${f.paths[1]} (shellcheck -s sh)\n`));
    assert.ok(r.stderr.includes(`lint: FAIL ${f.paths[2]} (shellcheck -s bash)\n`));
    assert.ok(r.stderr.includes("SC2086"), "tool output follows the FAIL line");
    assert.ok(r.stderr.includes(`lint: FAIL ${f.paths[6]}: unrecognised shebang '#!/bin/zsh'\n`));
    assert.ok(!r.stderr.includes("README"));
  } finally {
    f.cleanup();
  }
});

test("--js checks .js files by extension and reports node --check", () => {
  const f = fixture({ "broken.js": FILES["broken.js"], "ok.mjs": "export const a = 1;\n" });
  try {
    const r = run(f, { args: ["--js"] });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, "2 1\n");
    assert.ok(r.stderr.startsWith(`lint: FAIL ${f.paths[0]} (node --check)\n`));
  } finally {
    f.cleanup();
  }
});

test("output is identical at TEST_JOBS=1 and TEST_JOBS=4", SC, () => {
  const a = fixture(FILES);
  const b = fixture(FILES);
  try {
    const one = run(a, { jobs: "1" });
    const four = run(b, { jobs: "4" });
    const norm = (s, d) => s.split(d).join("DIR");
    assert.strictEqual(norm(one.stderr, a.dir), norm(four.stderr, b.dir));
    assert.strictEqual(one.stdout, four.stdout);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a path with a space and a quote is checked", SC, () => {
  const f = fixture({ "we ird/it's bad.sh": BAD_SH });
  try {
    const r = run(f);
    assert.strictEqual(r.stdout, "1 1\n");
    assert.ok(r.stderr.startsWith(`lint: FAIL ${f.paths[0]} (shellcheck -s sh)\n`), r.stderr);
  } finally {
    f.cleanup();
  }
});

test("without shellcheck on PATH the sh -n and bash -n checks run", () => {
  const f = fixture({ "ok.sh": "#!/bin/sh\necho ok\n", "bad.sh": "#!/bin/sh\nif true; then\n", "bad.bash": "#!/bin/bash\nfi\n" });
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["sh", "bash", "node", "head", "sed", "cat", "mkdir", "xargs", "ps", "awk", "kill", "sleep", "dirname", "uname", "getconf", "nproc"]) {
    const w = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (w) fs.symlinkSync(w, path.join(bin, tool));
  }
  try {
    const r = run(f, { pathEnv: bin, path: bin });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, "3 2\n");
    assert.ok(r.stderr.includes(`lint: FAIL ${f.paths[1]} (sh -n)\n`), r.stderr);
    assert.ok(r.stderr.includes(`lint: FAIL ${f.paths[2]} (bash -n)\n`), r.stderr);
  } finally {
    f.cleanup();
  }
});

test("a bad TEST_JOBS exits 2", () => {
  const f = fixture({ "ok.sh": "#!/bin/sh\necho ok\n" });
  try {
    const r = run(f, { jobs: "zero" });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /TEST_JOBS must be a positive integer/);
  } finally {
    f.cleanup();
  }
});
