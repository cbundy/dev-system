"use strict";

// The factory loop's judge skill (plugins/factory-loop/skills/judge/SKILL.md) is what the model
// answers wakes by, so it must cover every wake the loop sends and every answer the loop
// accepts (docs/factory-loop/v2/SPEC.md 11, 13.4.3, appendices D and E). This
// reads the skill, the SPEC and the hooks as text, since plugin tests cannot read files; wake.ts's
// own tests (plugins/factory-loop/tests/wake.test.ts) check the code.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SKILL = read("plugins/factory-loop/skills/judge/SKILL.md");
const SPEC = read("docs/factory-loop/v2/SPEC.md");
const HOOKS = path.join(ROOT, "plugins/factory-loop/hooks");
const SOURCES = Object.fromEntries(
  fs
    .readdirSync(HOOKS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, fs.readFileSync(path.join(HOOKS, f), "utf8")]),
);
const EXEC = SOURCES["exec.ts"];
// the v2 rule layer (docs/factory-loop/v2/SPEC.md): its sources and its vocabulary
const V2_SOURCES = Object.fromEntries(
  fs
    .readdirSync(path.join(HOOKS, "v2"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, fs.readFileSync(path.join(HOOKS, "v2", f), "utf8")]),
);
const V2_TYPES = V2_SOURCES["types.ts"];

// section: the text from a heading line to the next heading of the same or a higher level.
function section(doc, heading) {
  const start = doc.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `missing heading: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = doc.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

// ticked: every `backticked` token of a text.
const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// bullet: a skill bullet `- **`name`**` up to the next bullet of the same depth or the end.
function bullet(text, name) {
  const start = text.indexOf(`- **\`${name}\`**`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/\n- \*\*`/);
  return next < 0 ? rest : rest.slice(0, next);
}

const TASK = section(SKILL, "## TASK");
const TELL = section(SKILL, "## TELL: one line to the owner");
const OWNER = section(SKILL, "## Owner chat");

test("the judge skill has no em dash", () => {
  assert.equal(SKILL.includes("\u2014"), false, "SKILL.md uses an em dash; use a plain dash");
});

test("the skill has no JUDGE wake and no planner switch: v2 is the only rule set", () => {
  assert.doesNotMatch(SKILL, /\bJUDGE\b/, "SKILL.md names a JUDGE wake");
  assert.doesNotMatch(SKILL, /planner/i, "SKILL.md names a planner");
  assert.doesNotMatch(SKILL, /\bv1\b/, "SKILL.md names v1");
});

test("the release task names each decision it allows, and TASK is the only answered wake", () => {
  for (const d of ["done", "hold", "failed"]) assert.match(TASK, new RegExp(`\`${d}\``), `SKILL.md TASK does not name the decision ${d}`);
  assert.notEqual(bullet(TASK, "release"), null);
});

// wakesOf: every wake a hooks source builds: wake('<kind>', '<name>', ...), an action literal's
// `kind: '<kind>', wake: '<name>'` (act.ts's pass-error), and rails.ts's notice tells,
// tell('<name>', `tell:...`).
function wakesOf(src) {
  return [
    ...[...src.matchAll(/\bwake\('(judge|task|tell)', '([^']+)'/g)].map((m) => ({ kind: m[1], name: m[2] })),
    ...[...src.matchAll(/kind: '(judge|task|tell)',\s*wake: '([^']+)'/g)].map((m) => ({ kind: m[1], name: m[2] })),
    ...[...src.matchAll(/\btell\('([^']+)', `tell:/g)].map((m) => ({ kind: "tell", name: m[1] })),
  ];
}

test("every wake the hooks emit is in the skill under its kind", () => {
  const emitted = [...Object.values(SOURCES), ...Object.values(V2_SOURCES)].flatMap(wakesOf);
  for (const name of ["parked", "stalled", "waiting", "workspace", "pass-error", "heartbeat-other", "old-watcher", "schema-behind", "breaker", "blind", "runaway"]) {
    assert.ok(emitted.some((w) => w.kind === "tell" && w.name === name), `no tell ${name} read from the hooks`);
  }
  assert.ok(emitted.some((w) => w.kind === "task" && w.name === "release"), "no task release read from the hooks");
  for (const { kind, name } of emitted) {
    assert.notEqual(kind, "judge", `the hooks send a JUDGE wake (${name}): the loop has none`);
    if (kind === "task") assert.notEqual(bullet(TASK, name), null, `SKILL.md TASK has no bullet for ${name}`);
    else assert.match(TELL, new RegExp(`^- \`${escape(name)}\``, "m"), `SKILL.md TELL has no item for ${name}`);
  }
});

test("every control op of v2 SPEC 13.4.3 is in the skill's owner chat", () => {
  const text = section(SPEC, "#### 13.4.3 Control state (owner directives)");
  const list = text.match(/from any client[^:]*:([\s\S]*?)\.\s+Each change/);
  assert.ok(list !== null, "v2 SPEC 13.4.3: the list of ops was not found");
  const ops = [...new Set(ticked(list[1]).map((t) => t.split(/\s+/)[0]))];
  assert.ok(ops.length >= 16, `read only ${ops.length} ops from v2 SPEC 13.4.3`);
  for (const op of ops) {
    assert.match(OWNER, new RegExp(`\`${escape(op)}[ \`]`), `SKILL.md Owner chat does not name the op ${op}`);
  }
});

test("the skill quotes the pointer that ends every wake (exec.ts WAKE_POINTER)", () => {
  const m = EXEC.match(/export const WAKE_POINTER = '([^']+)'/);
  assert.ok(m !== null, "exec.ts: WAKE_POINTER not found");
  const pointer = m[1];
  assert.ok(SKILL.includes(pointer), `SKILL.md does not quote the wake pointer line: ${pointer}`);
  // and the pointer names this skill
  const name = SKILL.match(/^name:\s*(\S+)/m)[1];
  assert.ok(pointer.includes(`factory-loop:${name}`), `the wake pointer does not name factory-loop:${name}`);
});

// listOf: the string items of a `const <name> = [...]` in a source, spreads of other lists named.
function listOf(src, name) {
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `no list ${name}`);
  const own = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const spread = [...m[1].matchAll(/\.\.\.(\w+)/g)].flatMap((x) => listOf(src, x[1]));
  return [...spread, ...own];
}

test("every TELL kind of v2's vocabulary is in the skill, the owner items before the notices", () => {
  const tells = listOf(V2_TYPES, "V2_TELLS");
  assert.ok(tells.length >= 7, `read only ${tells.length} v2 TELL kinds`);
  for (const kind of tells) assert.match(TELL, new RegExp(`^- \`${escape(kind)}\``, "m"), `SKILL.md TELL has no item for ${kind}`);
  const notices = TELL.indexOf("Notices:");
  for (const kind of listOf(V2_TYPES, "V2_OWNER_TELLS")) assert.ok(TELL.indexOf(`- \`${kind}\``) < notices, `${kind} is an owner item`);
});

test("the release task does the Run its and never waits on the owner inside its turn; the ops of v2's appendix E are named", () => {
  const release = bullet(TASK, "release");
  assert.match(release, /Run it/);
  assert.match(release, /Never wait on the owner inside this turn/);
  for (const d of ["done", "failed"]) assert.match(release, new RegExp(`\`${d}\``));
  for (const op of ["resume", "drop", "retry"]) assert.match(OWNER, new RegExp(`\`${op}[ \`]`), `the owner chat does not name ${op}`);
  assert.match(SKILL, /factory:\*/);
});

test("the judge decides releases by the wake's cadence and starts the release agent, and asks the owner only for the listed cases", () => {
  const decisions = section(SKILL, "### Release decisions");
  assert.match(decisions, /within the wake's `cadence` of its merge/);
  assert.match(decisions, /\(`oldest`\) is\s+`cadence`\s+old/);
  for (const [name, text] of [["decisions section", decisions], ["release bullet", bullet(TASK, "release")]]) {
    assert.doesNotMatch(text, /\b\d+ hours?\b/, `the ${name} fixes a number of hours`);
  }
  assert.match(decisions, /`priority`/);
  assert.match(decisions, /\.claude\/skills\/release\/SKILL\.md/);
  assert.match(decisions, /`hold` with `reason: wait:/);
  assert.match(decisions, /The loop only logs it/);
  assert.match(decisions, /major version/);
  assert.match(decisions, /None of these is a reason to ask/);
  assert.match(bullet(TASK, "release"), /You do not do the release steps yourself/);
});

test("the release review's `waiting` field is documented, a release wait is a strong reason and the judge's to answer, never the owner's", () => {
  const release = bullet(TASK, "release");
  assert.match(release, /`waiting`/);
  assert.match(release, /even with open items/);
  assert.match(release, /A release wait is the judge's to answer, never the owner's/);
  const decisions = section(SKILL, "### Release decisions");
  assert.match(decisions, /strong: an issue waits on a release \(`waiting`\)/);
});
