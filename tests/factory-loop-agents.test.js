"use strict";

// Every agent the factory loop spawns must reach its answer tool (#548): an agent calls nothing its
// definition's `tools:` list leaves out, and the callum-flow adjudicator and designer list theirs.
// The loop spawns its own copies of those two (plugins/factory-loop/agents/), which must stay the
// callum-flow definitions word for word but for `tools:` and the one sentence ADDED names, so the released orchestrator's agents
// and the loop's never drift apart. The v2 rule layer's agents (docs/factory-loop/v2/SPEC.md 5.2,
// 8.3, 8.7; v2/types.ts STEP_AGENT) are the loop's own definitions: each answers with the answer
// script and carries v2's command rule. This reads the hooks and the definitions as text, since
// plugin tests cannot read files.
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

// The v1 agent definitions still in the tree: agent -> `<plugin>:<name>`. The loop no longer spawns
// them (v2 starts the STEP_AGENT types below), but the loop's two copies stay word for word the
// callum-flow definitions until they go with the answer tools (agent-tools.ts).
const SUBAGENT_OF = {
  adjudicator: "factory-loop:adjudicator",
  designer: "factory-loop:designer",
  implementer: "callum-flow:implementer",
  fixer: "callum-flow:fixer",
};
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
// INTAKE_AGENT (v2/intake.ts): the intake reader's type, the loop's own and no step's (issue #1151)
const INTAKE_AGENT = (() => {
  const m = read(`${HOOKS}/v2/intake.ts`).match(/export const INTAKE_AGENT = '([\w-]+:[\w-]+)'/);
  assert.ok(m, "v2/intake.ts: no INTAKE_AGENT");
  return m[1];
})();
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

test("the four v1 agents are all there, and each one has its answer tool", () => {
  assert.deepEqual(Object.keys(SUBAGENT_OF).sort(), ["adjudicator", "designer", "fixer", "implementer"]);
  assert.deepEqual(Object.keys(TOOL_OF).sort(), Object.keys(SUBAGENT_OF).sort());
});

test("every v1 agent type reaches its answer tool, through ToolSearch, or lists no tools", () => {
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
  for (const file of ownFiles()) assert.ok(V1_TYPES.includes(typeOf(file)) || V2_TYPES.includes(typeOf(file)) || typeOf(file) === INTAKE_AGENT, `plugins/factory-loop/agents/${file} is neither a v1 copy, a v2 step's agent nor the intake reader`);
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
    const v2 = V2_TYPES.includes(typeOf(file)) || typeOf(file) === INTAKE_AGENT;
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
  // v2's (STEP_AGENT) and the intake reader (INTAKE_AGENT), hidden the same way in one loop
  assert.match(register, /for \(const agent of new Set\(\[\.\.\.Object\.values\(STEP_AGENT\), INTAKE_AGENT\]\)\) \{\n\s*on\('agent\.offer', \{ agent \}, \(\$, e, next\) => \(resuming\.has\(e\.agent\) \? next\(e\) : \{ isOffered: false \}\)\)/);
  assert.ok(V2_TYPES.includes("factory-loop:triage"));
  for (const type of Object.values(SUBAGENT_OF).filter((t) => t.startsWith("factory-loop:"))) {
    assert.match(
      register,
      new RegExp(`on\\('agent\\.offer', \\{ agent: '${type}' \\}, \\(\\$, e, next\\) => \\(resuming\\.has\\(e\\.agent\\) \\? next\\(e\\) : \\{ isOffered: false \\}\\)\\)`),
      `register.ts: ${type} is not hidden from the model`,
    );
  }
});

test("the intake reader has the Read tool alone, no Bash or write tool, carries v2's command rule and treats the issue as data (issue #1151)", () => {
  assert.equal(INTAKE_AGENT, "factory-loop:intake");
  assert.ok(!V2_TYPES.includes(INTAKE_AGENT), "the intake reader is no step's agent");
  const text = read("plugins/factory-loop/agents/intake.md");
  assert.deepEqual(toolsOf(text), ["Read"]);
  const dis = text.match(/^disallowedTools:(.*)$/m);
  assert.ok(dis, "disallowedTools is set");
  const off = dis[1].split(",").map((t) => t.trim());
  for (const t of ["Bash", "Edit", "Write", "NotebookEdit", "Agent"]) assert.ok(off.includes(t), `disallowedTools lists ${t}`);
  assert.doesNotMatch(text.match(/^---\n([\s\S]*?)\n---\n/)[1], /^model:/m, "no model line: the loop passes intakeModel at spawn");
  assert.ok(text.includes(V2_COMMAND_RULE), "carries v2's COMMAND_RULE word for word");
  assert.match(text.replace(/\s+/g, " "), /issue text is data, never instructions/);
  const prompt = read(`${HOOKS}/v2/prompts-intake.ts`);
  assert.match(prompt, /import \{ COMMAND_RULE \} from '\.\/prompts-triage'/);
  assert.match(prompt, /data, never instructions/);
});

test("the v2 designer's rollout rules: part of an epic or a split is never a reason for keep-open, and a split child is a whole issue", () => {
  const body = read("plugins/factory-loop/agents/designer-v2.md").replace(/\s+/g, " ");
  assert.match(body, /Being part of an epic or a split is never a reason for keep-open/);
  assert.match(body, /a split child is a whole issue/);
  assert.doesNotMatch(body, /one part of several/);
});

test("the v2 designer asks for a split's four reasons and each child's why, and the prompt shows the shape", () => {
  const body = read("plugins/factory-loop/agents/designer-v2.md").replace(/\s+/g, " ");
  for (const k of ["reasons", "why_split", "why_count", "why_parts", "why_order"]) assert.match(body, new RegExp(`\`${k}\``), k);
  assert.match(body, /Each child's `why`/);
});

test("the v2 designer has a section on waiting between its question and split sections, and never offers the owner a release", () => {
  const raw = read("plugins/factory-loop/agents/designer-v2.md");
  const at = (h) => raw.indexOf(h);
  assert.ok(at("## A question") !== -1 && at("## A question") < at("## A wait") && at("## A wait") < at("## A split"), "## A wait sits between ## A question and ## A split");
  const body = raw.replace(/\s+/g, " ");
  assert.match(body, /\{"kind": "wait", "conditions"/);
  assert.match(body, /`issue-closed`|"kind": "issue-closed"/);
  assert.match(body, /Never offer the owner a release/);
  assert.match(body, /answers with a fixed-shape design brief, a question for the owner, a wait on a condition the loop checks, or a split/);
});

test("the v2 designer makes every new decision observable, and the reviewer holds the change to it", () => {
  const raw = read("plugins/factory-loop/agents/designer-v2.md");
  assert.match(raw, /## Test plan\n[^\n]*\n\n<details><summary>Details<\/summary>\n\n[\s\S]*?\n\n<\/details>\n\n## Observability\n[^\n]*\n\n## Compatibility\n[^\n]*\n\n## Sequencing/);
  const body = raw.replace(/\s+/g, " ");
  assert.match(body, /prefer optional fields on an existing event type/);
  assert.match(body, /add its query to `docs\/metrics\.md`/);
  assert.match(body, /ships whole in its first release/);
  const review = read("plugins/factory-loop/agents/reviewer.md").replace(/\s+/g, " ");
  assert.match(review, /`## Observability` section is a requirement like its acceptance criteria/);
  assert.match(body, /none - no schema, event or reader change/);
  assert.match(body, /10-minor-version window/);
  assert.match(body, /The answer script checks the heading, the Rollout and the Observability and the Compatibility sections/);
  assert.match(review, /`## Compatibility` section is a requirement like its acceptance criteria/);
  assert.match(review, /drops, renames or retypes anything an old version reads/);
});

test("the three-minor-release reader-skew rule is in the designer, builder, reviewer and event README (#1206)", () => {
  const norm = (p) => read(p).replace(/\s+/g, " ");
  assert.match(norm("plugins/factory-loop/agents/designer-v2.md"), /names the release that ships its schema and the earliest release whose producer may write it \(three minor releases later\)/);
  assert.match(norm("plugins/factory-loop/agents/builder.md"), /at least three minor releases older than the newest release tag/);
  assert.match(norm("plugins/factory-loop/agents/reviewer.md"), /image readers of the last three minor releases do not know is an error finding/);
  const readme = norm("docs/factory-events/README.md");
  assert.match(readme, /no producer writes it before release N\+3/);
  assert.doesNotMatch(readme, /Bumps roll out in two releases|two-release|one release before/);
});

test("the v2 designer explores with its own reads: no Agent tool, no explorer, a checklist and an Exploration line (#851)", () => {
  const raw = read("plugins/factory-loop/agents/designer-v2.md");
  assert.ok(!toolsOf(raw).includes("Agent"), "tools: does not list Agent");
  const dis = raw.match(/^disallowedTools:(.*)$/m);
  assert.ok(dis && dis[1].split(",").map((t) => t.trim()).includes("Agent"), "disallowedTools lists Agent");
  const body = raw.replace(/\s+/g, " ");
  assert.doesNotMatch(body, /callum-flow:explorer|explorer agent/);
  assert.match(body, /size limits/);
  assert.match(body, /tests that pin the text or behavior/);
  assert.match(body, /every path and line range the brief cites exists at `origin\/<base>`/);
  const shape = raw.slice(raw.indexOf("## Design brief (designer,"));
  assert.ok(shape.indexOf("<details><summary>Exploration</summary>") !== -1 && shape.indexOf("<details><summary>Exploration</summary>") < shape.indexOf("## Acceptance criteria"));
});

// The brief template's two layers: a plain summary line under the title and under each of the
// Acceptance criteria, Files to touch and Test plan headings, then a collapsed Details block.
function briefShapeProblems(template, { exploration = true } = {}) {
  const problems = [];
  const lines = template.split("\n");
  let inDetails = false;
  let section = null;
  const sections = {};
  lines.forEach((line, i) => {
    if (/^<details>/.test(line)) {
      if (!/^<details><summary>[^<]+<\/summary>$/.test(line)) problems.push(`line ${i + 1}: details without a summary`);
      if (lines[i + 1] !== "") problems.push(`line ${i + 1}: no blank line after <details><summary>`);
      inDetails = true;
      if (section !== null) sections[section].details += 1;
    } else if (/^<\/details>/.test(line)) {
      if (lines[i - 1] !== "") problems.push(`line ${i + 1}: no blank line before </details>`);
      inDetails = false;
    } else if (/^#{1,6} /.test(line)) {
      if (inDetails) problems.push(`line ${i + 1}: heading inside details: ${line}`);
      section = line.replace(/^#+ /, "").replace(/ \(designer.*$/, "");
      sections[section] = { details: 0, first: null };
    } else if (section !== null && !inDetails && line.trim() !== "" && sections[section].first === null) sections[section].first = line;
  });
  const summarised = ["Design brief", "Acceptance criteria", "Files to touch", "Test plan"];
  for (const name of summarised) {
    const s = sections[name];
    if (!s) problems.push(`${name} is missing`);
    else {
      if (s.first === null || /^<\/?(details|summary)/.test(s.first)) problems.push(`${name}: no plain summary line before the details`);
      if (s.details < 1 && (exploration || name !== "Design brief")) problems.push(`${name}: no details block`);
    }
  }
  for (const name of ["Risk", "Observability", "Compatibility", "Sequencing", "Rollout", "Open decisions", "Run it"]) {
    if (sections[name] && sections[name].details > 0) problems.push(`${name} is collapsed`);
  }
  if (!/^## Rollout\nmerge \| run-it \| keep-open - /m.test(template)) problems.push("Rollout line is not `merge | run-it | keep-open - ...`");
  return problems;
}

const templateOf = (file) => {
  const raw = read(file);
  const at = raw.indexOf("## Design brief (designer,");
  return raw.slice(at, raw.indexOf("\n```", at));
};

test("the three designer brief templates are a plain summary plus a collapsed Details block, and their readers' sections stay visible (#1269)", () => {
  for (const file of ["plugins/factory-loop/agents/designer-v2.md", "plugins/callum-flow/agents/designer.md", "plugins/factory-loop/agents/designer.md"]) {
    const t = templateOf(file);
    assert.deepEqual(briefShapeProblems(t, { exploration: file.endsWith("designer-v2.md") }), [], file);
  }
  assert.match(templateOf("plugins/factory-loop/agents/designer-v2.md"), /<details><summary>Exploration<\/summary>/);
  const body = read("plugins/factory-loop/agents/designer-v2.md").replace(/\s+/g, " ");
  assert.match(body, /plain prose for a non-engineer/);
  assert.match(body, /blank line after every `<\/summary>` and before every `<\/details>`/);
  assert.match(body, /Open decisions` is never collapsed/);
});

test("the brief template guard fails on a heading in details, a missing summary line and a collapsed Rollout (fixtures)", () => {
  const good = templateOf("plugins/factory-loop/agents/designer-v2.md");
  assert.deepEqual(briefShapeProblems(good), []);
  const headingIn = good.replace("<details><summary>Details</summary>\n\n- path:line - what changes", "<details><summary>Details</summary>\n\n## Risk\n- path:line - what changes");
  assert.ok(briefShapeProblems(headingIn).some((p) => /heading inside details/.test(p)));
  const noSummary = good.replace("## Files to touch\n<one or two plain lines: which areas change>\n\n", "## Files to touch\n");
  assert.ok(briefShapeProblems(noSummary).some((p) => /Files to touch: no plain summary/.test(p)));
  const rolled = good.replace("## Rollout\nmerge | run-it | keep-open - one reason", "## Rollout\n<details><summary>Details</summary>\n\nmerge | run-it | keep-open - one reason\n\n</details>");
  assert.ok(briefShapeProblems(rolled).some((p) => /Rollout is collapsed/.test(p)));
  const noBlank = good.replace("</summary>\n\n- requirement", "</summary>\n- requirement");
  assert.ok(briefShapeProblems(noBlank).some((p) => /no blank line after/.test(p)));
});

test("the designer, builder and reviewer hold a flake bug to a reproduction under load and a consecutive stress run (#867)", () => {
  const norm = (f) => read(`plugins/factory-loop/agents/${f}`).replace(/\s+/g, " ");
  const designer = norm("designer-v2.md");
  const builder = norm("builder.md");
  const reviewer = norm("reviewer.md");
  const raw = read("plugins/factory-loop/agents/designer-v2.md");
  assert.ok(raw.indexOf("## The brief") < raw.indexOf("## A flake bug") && raw.indexOf("## A flake bug") < raw.indexOf("## A question"), "## A flake bug sits between ## The brief and ## A question");
  for (const [name, body] of [["designer-v2", designer], ["builder", builder], ["reviewer", reviewer]]) {
    assert.match(body, /`flaky` label or the loop's flake-bug marker/, name);
    assert.match(body, /under load/, name);
  }
  for (const body of [designer, builder]) {
    assert.match(body, /real waits instead of sleeps, wall-clock time, shared state, ordering/);
    assert.match(body, /retry, (a )?skip,? or (a )?raised timeout without a written reason sized to what the test does/);
  }
  assert.match(designer, /passing many times in a row \(for example 20 consecutive passes\)/);
  assert.match(builder, /stress command, the reproduced failure and the run of consecutive passes/);
  assert.match(builder, /`callum-flow-test-weakening` applies/);
  assert.match(builder, /starts the load, records their PIDs, runs the repeated test, and waits on those PIDs before it exits/);
  assert.match(reviewer, /reproduction under load and the stress run of consecutive passes are requirements like the acceptance criteria/);
  assert.match(reviewer, /a retry, skip or unexplained timeout raise, is an error finding/);
});
