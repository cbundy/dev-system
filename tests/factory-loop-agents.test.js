"use strict";

// Every agent the factory loop spawns must reach its answer tool (#548): an agent calls nothing its
// definition's `tools:` list leaves out, and the callum-flow adjudicator and designer list theirs.
// The loop spawns its own copies of those two (plugins/factory-loop/agents/), which must stay the
// callum-flow definitions word for word but for `tools:` and the one sentence ADDED names, so the released orchestrator's agents
// and the loop's never drift apart. This reads the hooks and the definitions as text, since
// plugin tests cannot read files; act-agents.test.ts checks the same mapping in the code.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const HOOKS = "plugins/factory-loop/hooks";

// block: the object literal assigned to `name` in a hook's source.
function block(file, name) {
  const m = read(`${HOOKS}/${file}`).match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${file}: no ${name}`);
  return m[1];
}

// SUBAGENT_OF (act-agents.ts): agent -> `<plugin>:<name>`
const SUBAGENT_OF = Object.fromEntries([...block("act-agents.ts", "SUBAGENT_OF").matchAll(/(\w+):\s*'([\w-]+:[\w-]+)'/g)].map((m) => [m[1], m[2]]));
// TOOL_OF (agent-tools.ts): agent -> the answer tool's full name, through its constant
const TOOLS = read(`${HOOKS}/agent-tools.ts`);
const constant = (name) => {
  const m = TOOLS.match(new RegExp(`export const ${name} = '([^']+)'`));
  assert.ok(m, `agent-tools.ts: no ${name}`);
  return m[1];
};
const TOOL_OF = Object.fromEntries([...block("agent-tools.ts", "TOOL_OF").matchAll(/(\w+):\s*(\w+)/g)].map((m) => [m[1], constant(m[2])]));

const definition = (type) => {
  const [plugin, name] = type.split(":");
  return `plugins/${plugin}/agents/${name}.md`;
};

// toolsOf: a definition's `tools:` list, or null when it has none (every tool is inherited).
function toolsOf(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, "missing frontmatter");
  const line = fm[1].split("\n").find((l) => l.startsWith("tools:"));
  return line === undefined ? null : line.slice("tools:".length).split(",").map((t) => t.trim()).filter((t) => t !== "");
}

test("the loop spawns all four agents, and knows each one's answer tool", () => {
  assert.deepEqual(Object.keys(SUBAGENT_OF).sort(), ["adjudicator", "designer", "fixer", "implementer"]);
  assert.deepEqual(Object.keys(TOOL_OF).sort(), Object.keys(SUBAGENT_OF).sort());
});

test("every agent type the loop spawns reaches its answer tool, through ToolSearch, or lists no tools", () => {
  for (const [agent, type] of Object.entries(SUBAGENT_OF)) {
    const file = definition(type);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${agent}: ${type} has no definition at ${file}`);
    const tools = toolsOf(read(file));
    if (tools === null) continue;
    assert.ok(tools.includes(TOOL_OF[agent]), `${file}: tools must list ${TOOL_OF[agent]}`);
    assert.ok(tools.includes("ToolSearch"), `${file}: tools must list ToolSearch, since the answer tools are deferred`);
  }
});

// The one sentence a loop copy adds to its callum-flow definition (#561): the adjudicator is
// otherwise held to a closed list of read-only commands, and its prompt asks it to record its
// answer with the answer script. The designer's definition forbids nothing the script does.
const ADDED = {
  "adjudicator.md": "\nYou may also run the `factory-answer` command your prompt names, which only records your answer.",
};

test("the loop's own agents are the callum-flow definitions word for word but for their tools, which add only ToolSearch and the answer tool, and the one sentence that allows the answer script", () => {
  const own = fs.readdirSync(path.join(ROOT, "plugins/factory-loop/agents")).filter((f) => f.endsWith(".md"));
  assert.deepEqual(own.map((f) => `factory-loop:${f.slice(0, -3)}`).sort(), Object.values(SUBAGENT_OF).filter((t) => t.startsWith("factory-loop:")).sort());
  for (const file of own) {
    const agent = file.slice(0, -3);
    const loop = read(`plugins/factory-loop/agents/${file}`);
    const released = read(`plugins/callum-flow/agents/${file}`);
    const base = toolsOf(released);
    assert.ok(base !== null, `callum-flow ${file} lists no tools: spawn it instead of a copy`);
    assert.deepEqual(toolsOf(loop), [...base, "ToolSearch", TOOL_OF[agent]], `${file}: tools are callum-flow's plus ToolSearch and ${TOOL_OF[agent]}`);
    const untooled = (text) => text.replace(/^tools:.*$/m, "tools:");
    const added = ADDED[file];
    let copy = loop;
    if (added !== undefined) {
      assert.equal(loop.split(added).length, 2, `plugins/factory-loop/agents/${file} must add, once, the sentence: ${added.trim()}`);
      assert.ok(!released.includes(added), `plugins/callum-flow/agents/${file} already has the sentence the loop's copy adds`);
      copy = loop.replace(added, "");
    }
    assert.equal(untooled(copy), untooled(released), `plugins/factory-loop/agents/${file} drifted from plugins/callum-flow/agents/${file}: copy it again and keep the tools line${added === undefined ? "" : " and the added sentence"}`);
  }
});

test("every loop agent definition carries the command rule", () => {
  const own = fs.readdirSync(path.join(ROOT, "plugins/factory-loop/agents")).filter((f) => f.endsWith(".md"));
  for (const file of own) {
    const text = read(`plugins/factory-loop/agents/${file}`);
    for (const phrase of ["timeout 30", "claude remote-control", "pgrep -f", "no background shell"]) {
      assert.ok(text.toLowerCase().includes(phrase), `plugins/factory-loop/agents/${file} must carry the command rule: missing "${phrase}"`);
    }
  }
});

test("the model is never offered the loop's own agent types, but while the loop's own repair message resumes one (#559)", () => {
  const register = read(`${HOOKS}/register.ts`);
  for (const type of Object.values(SUBAGENT_OF).filter((t) => t.startsWith("factory-loop:"))) {
    assert.match(
      register,
      new RegExp(`on\\('agent\\.offer', \\{ agent: '${type}' \\}, \\(\\$, e, next\\) => \\(resuming\\.has\\(e\\.agent\\) \\? next\\(e\\) : \\{ isOffered: false \\}\\)\\)`),
      `register.ts: ${type} is not hidden from the model`,
    );
  }
});
