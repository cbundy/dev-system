// The fabriek command names' fallback to the old callum-flow ones (#1359) lives in three copies: the
// loop's (plugins/factory-loop/hooks/tool-name.mjs), the companion's and the status display's (plugins
// import nothing across plugin folders). One table of cases runs against all three, so the copies
// cannot drift. The rule: the program is the first argv word, or the first after `env` and its
// NAME=value words; a fabriek- program that could not start (a throw naming ENOENT, or exit 127 with a
// not-found message) runs once more as its callum-flow- name; the tool is remembered as missing; any
// other exit is final.
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const PLUGINS = path.join(__dirname, "..", "plugins");
const load = (file) => import(pathToFileURL(path.join(PLUGINS, file)).href);

// an image with the programs it has: any other fabriek-/callum-flow- program exits 127 "not found" or throws ENOENT
function image(has, how) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    const at = argv[0] === "env" ? argv.findIndex((w, i) => i > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) : 0;
    const program = argv[at];
    if (!has.includes(program) && /^(fabriek|callum-flow)-/.test(program)) {
      if (how === "throw") throw new Error(`spawn ${program} ENOENT`);
      return { exitCode: 127, stdout: "", stderr: `sh: ${program}: not found\n` };
    }
    const exitCode = program.endsWith("-fails") ? 2 : 0;
    return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "usage" };
  };
  return { run, calls };
}

const CASES = [
  ["a plain argv on an image with the new names runs once", ["fabriek-event", "--type", "x"], ["fabriek-event"], "exit", [["fabriek-event", "--type", "x"]], 0],
  ["exit 127 not found runs the old name", ["fabriek-event", "--type", "x"], ["callum-flow-event"], "exit", [["fabriek-event", "--type", "x"], ["callum-flow-event", "--type", "x"]], 0],
  ["a throw naming ENOENT runs the old name", ["fabriek-event", "--type", "x"], ["callum-flow-event"], "throw", [["fabriek-event", "--type", "x"], ["callum-flow-event", "--type", "x"]], 0],
  ["the program after env and its settings is the one renamed", ["env", "A=1", "B=2", "fabriek-claim", "5"], ["callum-flow-claim"], "exit", [["env", "A=1", "B=2", "fabriek-claim", "5"], ["env", "A=1", "B=2", "callum-flow-claim", "5"]], 0],
  ["a program that is not fabriek is left alone", ["git", "status"], [], "exit", [["git", "status"]], 0],
  ["an argument that looks like a fabriek tool is not renamed", ["echo", "fabriek-claim"], [], "exit", [["echo", "fabriek-claim"]], 0],
  ["exit 2 from the tool is its own answer: no second run", ["fabriek-fails"], ["fabriek-fails"], "exit", [["fabriek-fails"]], 2],
  ["neither name on the image: the old name's failure is the answer", ["fabriek-event"], [], "exit", [["fabriek-event"], ["callum-flow-event"]], 127],
];

for (const [copy, file] of [
  ["the loop", "factory-loop/hooks/tool-name.mjs"],
  ["the companion", "factory-loop-workspace/hooks/tool-name.ts"],
  ["the status display", "factory-hud/hooks/tool-name.ts"],
]) {
  test(`${copy}: the table of cases`, async () => {
    const m = await load(file);
    for (const [name, argv, has, how, calls, exitCode] of CASES) {
      m.resetFallbacks();
      const img = image(has, how);
      const r = await m.withFallback((a) => img.run(a))(argv);
      assert.deepEqual(img.calls, calls, name);
      assert.equal(r.exitCode, exitCode, name);
    }
  });

  test(`${copy}: exit 1 or 127 without a not-found message, and a throw that is not a missing program, are final`, async () => {
    const m = await load(file);
    for (const result of [{ exitCode: 1, stdout: "", stderr: "boom" }, { exitCode: 127, stdout: "", stderr: "the tool said so" }]) {
      m.resetFallbacks();
      const calls = [];
      const r = await m.withFallback(async (a) => (calls.push(a), result))(["fabriek-event"]);
      assert.deepEqual(calls, [["fabriek-event"]]);
      assert.equal(r.exitCode, result.exitCode);
    }
    m.resetFallbacks();
    const calls = [];
    await assert.rejects(m.withFallback(async (a) => { calls.push(a); throw new Error("timed out"); })(["fabriek-event"]), /timed out/);
    assert.deepEqual(calls, [["fabriek-event"]]);
  });

  test(`${copy}: a missing tool is remembered per tool: later calls go straight to the old name`, async () => {
    const m = await load(file);
    m.resetFallbacks();
    const img = image(["callum-flow-event", "callum-flow-claim", "fabriek-claim"], "exit");
    const run = m.withFallback((a) => img.run(a));
    await run(["fabriek-event", "1"]);
    await run(["fabriek-event", "2"]);
    await run(["fabriek-claim", "3"]);
    assert.deepEqual(img.calls, [["fabriek-event", "1"], ["callum-flow-event", "1"], ["callum-flow-event", "2"], ["fabriek-claim", "3"]]);
  });
}
