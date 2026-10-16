"use strict";

// Every agent the factory loop spawns must reach its answer tool (#548): an agent calls nothing its
// definition's `tools:` list leaves out, and the callum-flow adjudicator and designer list theirs.
// The loop spawns its own copies of those two (plugins/factory-loop/agents/), which must stay the
// callum-flow definitions word for word but for `tools:` and the one sentence ADDED names, so the released orchestrator's agents
// and the loop's never drift apart. The v2 rule layer's agents (docs/factory-loop/v2/SPEC.md 5.2,
// 8.3, 8.7; v2/types.ts STEP_AGENT) are the loop's own definitions: each answers with the answer
// script and carries v2's command rule. This reads the hooks and the definitions as text, since
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

// STEP_AGENT (v2/types.ts): a v2 step -> its loop-owned agent type (docs/factory-loop/v2/SPEC.md
// 5.2, 8.3, 8.7). These are the loop's own definitions, never callum-flow copies.
const STEP_AGENT = Object.fromEntries([...block("v2/types.ts", "STEP_AGENT").matchAll(/(\w+):\s*'([\w-]+:[\w-]+)'/g)].map((m) => [m[1], m[2]]));
const V1_TYPES = Object.values(SUBAGENT_OF).filter((t) => t.startsWith("factory-loop:"));
const V2_TYPES = Object.values(STEP_AGENT);
const ownFiles = () => fs.readdirSync(path.join(ROOT, "plugins/factory-loop/agents")).filter((f) => f.endsWith(".md"));
const typeOf = (file) => `factory-loop:${file.slice(0, -3)}`;

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

test("every file in the loop's agents folder is a v1 copy the loop spawns or a v2 step's own definition, and the v1 copies are all there", () => {
  for (const file of ownFiles()) assert.ok(V1_TYPES.includes(typeOf(file)) || V2_TYPES.includes(typeOf(file)), `plugins/factory-loop/agents/${file} is neither a v1 copy nor a v2 step's agent`);
  assert.deepEqual(ownFiles().map(typeOf).filter((t) => V1_TYPES.includes(t)).sort(), [...V1_TYPES].sort());
  // the triage agent is built (U2), the designer, builder and fixer (U5); the reviewer comes with U6
  for (const file of ["triage.md", "designer-v2.md", "builder.md", "fixer.md"]) {
    assert.ok(ownFiles().includes(file), `plugins/factory-loop/agents/${file} is missing`);
  }
});

test("the loop's own v1 agents are the callum-flow definitions word for word but for their tools, which add only ToolSearch and the answer tool, and the one sentence that allows the answer script", () => {
  const own = ownFiles().filter((f) => V1_TYPES.includes(typeOf(f)));
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

// COMMAND_RULE (prompts.ts): the paragraph every role prompt carries, unescaped from its string literal
const COMMAND_RULE = (() => {
  const m = read(`${HOOKS}/prompts.ts`).match(/export const COMMAND_RULE =\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(m, "prompts.ts: no COMMAND_RULE");
  return m[1].replace(/\\(.)/g, "$1");
})();

// V2_COMMAND_RULE (v2/prompts-triage.ts): v1's rule without its no-mistakes exception, which every
// v2 agent's prompt and definition carry (v2 SPEC 10.5)
const V2_COMMAND_RULE = (() => {
  const m = read(`${HOOKS}/v2/prompts-triage.ts`).match(/export const COMMAND_RULE =\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(m, "v2/prompts-triage.ts: no COMMAND_RULE");
  return m[1].replace(/\\(.)/g, "$1");
})();

test("every loop agent definition carries the command rule its prompts carry, word for word: v1's for the v1 copies, v2's for the v2 definitions", () => {
  for (const file of ownFiles()) {
    const v2 = V2_TYPES.includes(typeOf(file));
    const rule = v2 ? V2_COMMAND_RULE : COMMAND_RULE;
    assert.ok(read(`plugins/factory-loop/agents/${file}`).includes(rule), `plugins/factory-loop/agents/${file} must carry ${v2 ? "v2/prompts-triage.ts" : "prompts.ts"} COMMAND_RULE word for word`);
  }
  assert.ok(!V2_COMMAND_RULE.includes("no-mistakes") && COMMAND_RULE.startsWith(V2_COMMAND_RULE.split(" Leave no ")[0]), "v2's rule is v1's without the no-mistakes exception");
});

test("a v2 definition names itself, answers with the answer script through Bash (no answer tool), and names nothing of no-mistakes or implement-issue", () => {
  for (const file of ownFiles().filter((f) => V2_TYPES.includes(typeOf(f)))) {
    const text = read(`plugins/factory-loop/agents/${file}`);
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `${file}: missing frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${file.slice(0, -3)}$`, "m"), `${file}: its name is not its file's`);
    const tools = toolsOf(text) ?? [];
    assert.ok(tools.includes("Bash"), `${file}: tools must list Bash, which runs the answer script`);
    assert.ok(!tools.some((t) => t.startsWith("mcp__factory-loop__")), `${file}: a v2 agent answers with the answer script, not a tool`);
    assert.doesNotMatch(text, /\baxi\b|no-mistakes|implement-issue/, `${file} names axi, no-mistakes or implement-issue`);
  }
});

// The v2 prompt templates (hooks/v2/prompts-*.ts), their code without its comments: what every
// agent the loop starts is told. no-mistakes is out of the loop's path (v2 SPEC 1), so no prompt
// names it, its `axi` driver, or the implement-issue skill that drives it.
test("no v2 prompt template names axi, no-mistakes or implement-issue", () => {
  const prompts = fs.readdirSync(path.join(ROOT, HOOKS, "v2")).filter((f) => /^prompts-.*\.ts$/.test(f));
  assert.ok(prompts.includes("prompts-work.ts") && prompts.includes("prompts-triage.ts"), prompts.join(", "));
  for (const file of prompts) {
    const code = read(`${HOOKS}/v2/${file}`)
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    assert.doesNotMatch(code, /\baxi\b|no-mistakes|implement-issue/, `${HOOKS}/v2/${file} names axi, no-mistakes or implement-issue`);
  }
});

test("the model is never offered the loop's own agent types, but while the loop's own repair message resumes one (#559)", () => {
  const register = read(`${HOOKS}/register.ts`);
  // v2's (STEP_AGENT), hidden the same way in one loop over its values
  assert.match(register, /for \(const agent of new Set\(Object\.values\(STEP_AGENT\)\)\) \{\n\s*on\('agent\.offer', \{ agent \}, \(\$, e, next\) => \(resuming\.has\(e\.agent\) \? next\(e\) : \{ isOffered: false \}\)\)/);
  assert.ok(V2_TYPES.includes("factory-loop:triage"));
  for (const type of Object.values(SUBAGENT_OF).filter((t) => t.startsWith("factory-loop:"))) {
    assert.match(
      register,
      new RegExp(`on\\('agent\\.offer', \\{ agent: '${type}' \\}, \\(\\$, e, next\\) => \\(resuming\\.has\\(e\\.agent\\) \\? next\\(e\\) : \\{ isOffered: false \\}\\)\\)`),
      `register.ts: ${type} is not hidden from the model`,
    );
  }
});
