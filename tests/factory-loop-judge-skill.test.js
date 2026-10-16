"use strict";

// The factory loop's judge skill (plugins/factory-loop/skills/judge/SKILL.md) is what the model
// answers wakes by, so it must cover every wake the loop sends and every answer the loop
// accepts (docs/factory-loop/SPEC.md 8, 9.2, 4.3). This reads the skill, the SPEC and the hooks
// as text, since plugin tests cannot read files; wake.ts's own tests
// (plugins/factory-loop/tests/wake.test.ts) check the code against the same SPEC table.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SKILL = read("plugins/factory-loop/skills/judge/SKILL.md");
const SPEC = read("docs/factory-loop/SPEC.md");
const HOOKS = path.join(ROOT, "plugins/factory-loop/hooks");
const SOURCES = Object.fromEntries(
  fs
    .readdirSync(HOOKS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, fs.readFileSync(path.join(HOOKS, f), "utf8")]),
);
const PLAN = SOURCES["plan.ts"];
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

// The SPEC 8.2 table: each wake and the decisions it allows (the first ticked word of each
// `;`-separated choice). A tell row allows none.
function specDecisions() {
  const rows = section(SPEC, "### 8.2 Answers")
    .split("\n")
    .filter((l) => l.startsWith("| `"));
  const out = [];
  for (const row of rows) {
    const [wakes, choices] = row.split("|").slice(1, 3);
    const decisions = choices
      .split(";")
      .map((c) => ticked(c)[0])
      .filter((d) => d !== undefined);
    for (const w of ticked(wakes)) {
      const [kind, name] = w.split(" ");
      if (kind !== "tell") out.push({ kind, name, decisions });
    }
  }
  return out;
}

const V2 = section(SKILL, "## Under planner v2");
const V2_TASK = section(SKILL, "### TASK under planner v2");
const V2_TELL = section(SKILL, "### TELL under planner v2");
const V2_OWNER = section(SKILL, "### Owner chat under planner v2");
const JUDGE = section(SKILL, "### JUDGE");
const TASK = section(SKILL, "### TASK");
const TELL = section(SKILL, "## TELL: one line to the owner");
const OWNER = section(SKILL, "## Owner chat");

test("the judge skill has no em dash", () => {
  assert.equal(SKILL.includes("\u2014"), false, "SKILL.md uses an em dash; use a plain dash");
});

test("every JUDGE and TASK wake of SPEC 8.2 has its bullet, naming each decision it allows (judge sequence included)", () => {
  const wakes = specDecisions();
  const names = wakes.map((w) => `${w.kind} ${w.name}`);
  for (const expected of ["judge sequence", "judge guard-fail", "judge cancelled", "judge handoff", "judge report"]) {
    assert.ok(names.includes(expected), `SPEC 8.2 table lost ${expected}`);
  }
  for (const expected of ["task redrive", "task run-it", "task release", "task respond-stuck"]) {
    assert.ok(names.includes(expected), `SPEC 8.2 table lost ${expected}`);
  }
  for (const { kind, name, decisions } of wakes) {
    assert.ok(decisions.length > 0, `SPEC 8.2: no decisions read for ${kind} ${name}`);
    const where = kind === "judge" ? JUDGE : TASK;
    const own = bullet(where, name);
    assert.notEqual(own, null, `SKILL.md ${kind.toUpperCase()} has no bullet for ${name}`);
    // a judge's decisions are in its own bullet; a task's are shared by the TASK section
    const scope = kind === "judge" ? own : where;
    for (const d of decisions) {
      assert.match(scope, new RegExp(`\`${escape(d)}\``), `SKILL.md: ${kind} ${name} does not name the decision ${d}`);
    }
  }
});

// wakesOf: every wake a hooks source builds: plan.ts's wake('<kind>', '<name>', ...), an action
// literal's `kind: '<kind>', wake: '<name>'` (act.ts's pass-error), and rails.ts's notice tells,
// tell('<name>', `tell:...`).
function wakesOf(src) {
  return [
    ...[...src.matchAll(/\bwake\('(judge|task|tell)', '([^']+)'/g)].map((m) => ({ kind: m[1], name: m[2] })),
    ...[...src.matchAll(/kind: '(judge|task|tell)',\s*wake: '([^']+)'/g)].map((m) => ({ kind: m[1], name: m[2] })),
    ...[...src.matchAll(/\btell\('([^']+)', `tell:/g)].map((m) => ({ kind: "tell", name: m[1] })),
  ];
}

test("every wake the hooks emit is in the skill under its kind", () => {
  const emitted = Object.values(SOURCES).flatMap(wakesOf);
  assert.ok(wakesOf(PLAN).length >= 30, `read only ${wakesOf(PLAN).length} wake( calls from plan.ts`);
  // the wakes built outside plan.ts: failing passes (act.ts) and the rails' notices (rails.ts)
  for (const name of ["pass-error", "heartbeat-other", "old-watcher", "breaker"]) {
    assert.ok(emitted.some((w) => w.kind === "tell" && w.name === name), `no tell ${name} read from the hooks outside plan.ts`);
  }
  for (const { kind, name } of emitted) {
    if (kind === "judge") assert.notEqual(bullet(JUDGE, name), null, `SKILL.md JUDGE has no bullet for ${name}`);
    else if (kind === "task") assert.notEqual(bullet(TASK, name), null, `SKILL.md TASK has no bullet for ${name}`);
    else assert.match(TELL, new RegExp(`^- \`${escape(name)}\``, "m"), `SKILL.md TELL has no item for ${name}`);
  }
});

test("every TELL kind of SPEC 9.2 has its item in the skill", () => {
  const text = section(SPEC, "### 9.2 `tell`");
  const kinds = ticked(text.slice(text.indexOf("Kinds:"), text.indexOf("Each is sent")));
  assert.ok(kinds.length >= 22, `read only ${kinds.length} TELL kinds from SPEC 9.2`);
  for (const kind of kinds) {
    assert.match(TELL, new RegExp(`^- \`${escape(kind)}\``, "m"), `SKILL.md TELL has no item for ${kind}`);
  }
});

test("every control op of SPEC 4.3 is in the skill's owner chat", () => {
  const text = section(SPEC, "### 4.3 Control state (owner directives)");
  const list = text.match(/from any client[^:]*:([\s\S]*?)\.\s+Each change/);
  assert.ok(list !== null, "SPEC 4.3: the list of ops was not found");
  const ops = [...new Set(ticked(list[1]).map((t) => t.split(/\s+/)[0]))];
  assert.ok(ops.length >= 16, `read only ${ops.length} ops from SPEC 4.3`);
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

test("under planner v2: every wake the v2 hooks emit, and every TELL kind of v2's vocabulary, is in the skill's v2 section", () => {
  const emitted = Object.values(V2_SOURCES).flatMap(wakesOf);
  for (const name of ["parked", "stalled", "waiting"]) assert.ok(emitted.some((w) => w.kind === "tell" && w.name === name), `no tell ${name} read from hooks/v2/`);
  assert.ok(emitted.some((w) => w.kind === "task" && w.name === "release"), "no task release read from hooks/v2/");
  for (const { kind, name } of emitted) {
    assert.notEqual(kind, "judge", `hooks/v2/ sends a JUDGE wake (${name}): v2 has none`);
    if (kind === "task") assert.notEqual(bullet(V2_TASK, name), null, `SKILL.md v2 TASK has no bullet for ${name}`);
    else assert.match(V2_TELL, new RegExp(`^- \`${escape(name)}\``, "m"), `SKILL.md v2 TELL has no item for ${name}`);
  }
  const tells = listOf(V2_TYPES, "V2_TELLS");
  assert.ok(tells.length >= 7, `read only ${tells.length} v2 TELL kinds`);
  for (const kind of tells) assert.match(V2_TELL, new RegExp(`^- \`${escape(kind)}\``, "m"), `SKILL.md v2 TELL has no item for ${kind}`);
  // the owner items of v2 are listed as owner items, before the notices
  const notices = V2_TELL.indexOf("Notices:");
  for (const kind of listOf(V2_TYPES, "V2_OWNER_TELLS")) assert.ok(V2_TELL.indexOf(`- \`${kind}\``) < notices, `${kind} is an owner item`);
});

test("under planner v2: the release task does the Run its and never waits on the owner inside its turn; the ops of v2's appendix E are named", () => {
  const release = bullet(V2_TASK, "release");
  assert.match(release, /Run it/);
  assert.match(release, /Never wait on the owner inside this turn/);
  for (const d of ["done", "failed"]) assert.match(release, new RegExp(`\`${d}\``));
  for (const op of ["resume", "drop", "retry", "planner"]) assert.match(V2_OWNER, new RegExp(`\`${op}[ \`]`), `the v2 owner chat does not name ${op}`);
  assert.match(V2, /factory:\*/);
});
