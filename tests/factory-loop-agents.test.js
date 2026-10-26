"use strict";

// The agents the factory loop spawns (docs/factory-loop/v2/SPEC.md 5.2, 8.3, 8.7; v2/types.ts
// STEP_AGENT, and the intake reader) are the loop's own definitions in plugins/factory-loop/agents/:
// each answers with the answer script and carries v2's command rule. This reads the hooks and the
// definitions as text, since plugin tests cannot read files.
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

// STEP_AGENT (v2/types.ts): a v2 step -> its loop-owned agent type (docs/factory-loop/v2/SPEC.md
// 5.2, 8.3, 8.7). These are the loop's own definitions, never callum-flow copies.
const STEP_AGENT = Object.fromEntries([...block("v2/types.ts", "STEP_AGENT").matchAll(/(\w+):\s*'([\w-]+:[\w-]+)'/g)].map((m) => [m[1], m[2]]));
// INTAKE_AGENT (v2/intake.ts): the intake reader's type, the loop's own and no step's (issue #1151)
const INTAKE_AGENT = (() => {
  const m = read(`${HOOKS}/v2/intake.ts`).match(/export const INTAKE_AGENT = '([\w-]+:[\w-]+)'/);
  assert.ok(m, "v2/intake.ts: no INTAKE_AGENT");
  return m[1];
})();
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

// V2_COMMAND_RULE (v2/prompts-triage.ts): the rule every agent's prompt and definition carries (v2 SPEC 10.5)
const V2_COMMAND_RULE = (() => {
  const m = read(`${HOOKS}/v2/prompts-triage.ts`).match(/export const COMMAND_RULE =\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(m, "v2/prompts-triage.ts: no COMMAND_RULE");
  return m[1].replace(/\\(.)/g, "$1");
})();

test("every file in the loop's agents folder is a STEP_AGENT or the INTAKE_AGENT, and the v2 definitions are all there", () => {
  for (const file of ownFiles()) assert.ok(V2_TYPES.includes(typeOf(file)) || typeOf(file) === INTAKE_AGENT, `plugins/factory-loop/agents/${file} is neither a v2 step's agent nor the intake reader`);
  // the triage agent is built (U2), the designer, builder and fixer (U5); the reviewer comes with U6
  for (const file of ["triage.md", "designer-v2.md", "builder.md", "fixer.md"]) {
    assert.ok(ownFiles().includes(file), `plugins/factory-loop/agents/${file} is missing`);
  }
});

test("every loop agent definition carries v2's COMMAND_RULE word for word, and the rule does not name no-mistakes", () => {
  for (const file of ownFiles()) assert.ok(read(`plugins/factory-loop/agents/${file}`).includes(V2_COMMAND_RULE), `plugins/factory-loop/agents/${file} must carry v2/prompts-triage.ts COMMAND_RULE word for word`);
  assert.ok(!V2_COMMAND_RULE.includes("no-mistakes"));
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
  // v2's (STEP_AGENT) and the intake reader (INTAKE_AGENT), hidden in one loop
  assert.match(register, /for \(const agent of new Set\(\[\.\.\.Object\.values\(STEP_AGENT\), INTAKE_AGENT\]\)\) \{\n\s*on\('agent\.offer', \{ agent \}, \(\$, e, next\) => \(resuming\.has\(e\.agent\) \? next\(e\) : \{ isOffered: false \}\)\)/);
  assert.ok(V2_TYPES.includes("factory-loop:triage"));
  // no v1 type is hidden any more: its definition is gone
  assert.doesNotMatch(register, /factory-loop:(adjudicator|designer)'/);
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

test("the v2 designer's test plan never asks for a forbidden step and names the repo's capture by uiCapture", () => {
  const body = read("plugins/factory-loop/agents/designer-v2.md").replace(/\s+/g, " ");
  assert.match(body, /never asks a loop agent for a step its command rule forbids: a dev server, a watcher, a browser session or a manual e2e run by hand/);
  assert.match(body, /`uiCapture` in `\.claude\/factory-loop\.json`, or else the capture command its CLAUDE\.md documents\) and the scenario to capture/);
  assert.match(body, /`uiCapture` to `none`, or has no capture command, the plan names no capture and says so/);
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

test("the designer brief template is a plain summary plus a collapsed Details block, and its readers' sections stay visible (#1269)", () => {
  for (const file of ["plugins/factory-loop/agents/designer-v2.md"]) {
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

// What agents are told to run keeps the callum-flow names for now (#1359): consumer repos allow only
// `Bash(callum-flow-*)` until the template change (#1360) reaches them, so a prompt naming fabriek-issue-read
// would hit a permission prompt there. The move belongs with the alias removal (#1361). If this fails
// because the text moved early, put the names back; if #1361 moves them, update this test with it.
test("agent-facing text still names the callum-flow commands", () => {
  for (const file of ["agents/builder.md", "agents/fixer.md", "agents/reviewer.md", "agents/triage.md", "agents/designer-v2.md", "skills/judge/SKILL.md"]) {
    const text = read(`plugins/factory-loop/${file}`);
    assert.match(text, /callum-flow-issue-read/, file);
    assert.doesNotMatch(text, /fabriek-issue-read/, file);
  }
  for (const file of ["prompts-work.ts", "prompts-review.ts", "prompts-triage.ts"]) {
    const text = read(`${HOOKS}/v2/${file}`);
    assert.match(text, /callum-flow-issue-read/, file);
    assert.doesNotMatch(text, /fabriek-(issue-read|test-weakening|evidence-upload)/, file);
  }
});
