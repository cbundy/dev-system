"use strict";

// The factory loop's second safety net (docs/factory-loop/v2/SPEC.md 13.6.1, 13.11): no string literal in
// plugins/factory-loop/hooks/*.ts, its shared answer contract (hooks/*.mjs) or its answer script
// (bin/factory-answer, #561) may carry what no executor may ever do: pass --yes, run
// `no-mistakes rerun` or `abort`, merge through anything but the queue's one merge, edit a PR body,
// add a label, run a `coder` command or kill a process by name. The first net,
// plugins/factory-loop/tests/safety.test.ts, runs every action kind through the dispatcher and
// checks each argv; this one reads the source, since plugin tests cannot read files, so a
// template that no test reaches is still caught. The one signal the loop sends is rails.ts's
// liveness probe, `kill -0` by pid, which delivers nothing; `kill switch` alone is the skip reason
// act.ts logs (#557), never a command. The only `rerun` is v2's CI re-run, below.
//
// The v2 rule layer (hooks/v2/, docs/factory-loop/v2/SPEC.md appendix B) is scanned too. Its
// writes are allowed deliberately, one argv each: every v2 command is built in hooks/v2/argv.ts,
// and a word the bans catch there (a label added, a PR body, a body file, a CI re-run, a slot's
// kill) is allowed only on the lines V2_ALLOWED names, exactly as written. Elsewhere it is caught
// as before. The v2 kind `ci-rerun` and the key family `/rerun/` are names, not commands, and so is
// `kill` on the vocabulary lines V2_NAMES names (a slot op, an entry action's key).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HOOKS = path.join(__dirname, "..", "plugins", "factory-loop", "hooks");
const PROBE = 'kill -0 "$1" 2>/dev/null';
const KILL_SWITCH = "kill switch";
const V2_ARGV = "v2/argv.ts";
// v2's widened argvs (appendix B), each the one line of argv.ts that builds it
const V2_ALLOWED = [
  "  const argv = ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', add]",
  "  return ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', add, '--remove-label', remove.join(',')]",
  "  return ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', add.join(',')]",
  "  return ['gh', 'issue', 'comment', String(issue), '--repo', repo, '--body-file', '-']",
  "  return ['gh', 'pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', title, '--body-file', '-']",
  "  return ['gh', 'pr', 'edit', String(pr), '--repo', repo, '--body-file', '-']",
  "  return ['gh', 'issue', 'create', '--repo', repo, '--title', title, '--body-file', '-']",
  "  return ['gh', 'issue', 'edit', String(child), '--repo', repo, '--add-label', readyLabel]",
  "  return ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', flaky, '--add-label', priority]",
  "  return ['gh', 'run', 'rerun', runId, '--failed', '--repo', repo]",
  "  return ['factory-slot', 'kill', path]",
];
const V2_RERUN = "  return ['gh', 'run', 'rerun', runId, '--failed', '--repo', repo]";
const V2_NAMES = [
  { file: "v2/types.ts", line: "export const SLOT_OPS = ['lease', 'prepare', 'kill', 'free'] as const" },
  { file: "v2/keys.ts", line: "export type EntryAction = 'label' | 'stop' | 'kill' | 'comment' | 'tell' | `event/${string}`" },
  { file: "v2/rules-entry.ts", line: "const KILL = 'kill' as const" },
];
// after these, a `/` starts a regular expression rather than a division
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

// literals: every string literal of a TypeScript source, in order, with its line: quoted strings
// whole, and a template's text parts joined around `${}` (its expressions are scanned as code).
// Comments and regular expressions are skipped.
function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = "";
  let word = "";
  const regexOk = () => prev === "" || REGEX_AFTER.has(prev) || (prev === "w" && REGEX_WORDS.has(word));

  function quoted(q) {
    const at = line;
    let text = "";
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        text += src[i + 1] === "n" ? "\n" : src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === "\n") line++;
      text += src[i++];
    }
    i++;
    out.push({ text, line: at });
  }

  function template() {
    const at = line;
    let text = "";
    i++;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") {
        text += src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        code("}");
        i++;
        text += "${}";
        continue;
      }
      if (src[i] === "\n") line++;
      text += src[i++];
    }
    i++;
    out.push({ text, line: at });
  }

  function regex() {
    let inClass = false;
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      i++;
    }
    i++;
    while (/[a-z]/.test(src[i] ?? "")) i++;
  }

  // code: scan until the closing character at depth 0 (or the end).
  function code(close) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "\n") {
        line++;
        i++;
      } else if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        for (const ch of src.slice(i, end < 0 ? src.length : end)) if (ch === "\n") line++;
        i = end < 0 ? src.length : end + 2;
      } else if (c === "'" || c === '"') {
        quoted(c);
        prev = "s";
      } else if (c === "`") {
        template();
        prev = "s";
      } else if (c === "/") {
        if (regexOk()) {
          regex();
          prev = "s";
        } else {
          prev = "/";
          i++;
        }
      } else if (/\s/.test(c)) {
        i++;
      } else if (/[A-Za-z0-9_$]/.test(c)) {
        word = "";
        while (/[A-Za-z0-9_$]/.test(src[i] ?? "")) word += src[i++];
        prev = "w";
      } else {
        if (c === "{") depth++;
        if (c === "}") {
          if (depth === 0 && close === "}") return;
          depth--;
        }
        prev = c === ")" || c === "]" ? "s" : c;
        i++;
      }
    }
  }

  code(null);
  return out;
}

// problems: what one source's literals carry that no executor may.
function problems(file, src = fs.readFileSync(path.join(HOOKS, file), "utf8")) {
  const found = [];
  const lits = literals(src);
  const lines = src.split("\n");
  const v2Allowed = (lit) =>
    (file === V2_ARGV && V2_ALLOWED.includes(lines[lit.line - 1])) || V2_NAMES.some((n) => n.file === file && n.line === lines[lit.line - 1] && lit.text === "kill");
  const flag = (lit, what) => {
    if (!v2Allowed(lit)) found.push(`${file}:${lit.line}: ${what}: ${JSON.stringify(lit.text.slice(0, 80))}`);
  };
  lits.forEach((lit, n) => {
    const t = lit.text;
    const next = lits[n + 1]?.text;
    // v2's kinds and key family name a re-run (and the companion's gate-rerun cause, the ci-refused:rerun cause); none is a command
    const named = t.replace(/\b(ci|gate)-rerun\b|\bci-refused:rerun\b/g, "").replace(/\/rerun\//g, "/");
    if (/(^|[\s=])--yes\b/.test(t)) flag(lit, "--yes");
    if (/\brerun\b/.test(named) || t === "abort" || /\bno-mistakes\b[^\n]*\babort\b/.test(t)) flag(lit, "rerun or abort");
    if (t === "coder" || /(^|[;&|(]\s*|^\s*)coder\s/.test(t)) flag(lit, "a coder command");
    if (/\b(pkill|killall)\b/.test(t)) flag(lit, "a kill by name");
    if (/(^|[;&|(\s])kill\b/.test(t) && t !== PROBE && t !== KILL_SWITCH) flag(lit, "a kill");
    if (t === "kill" && !/^-?\d/.test(next ?? "")) flag(lit, "a kill");
    if (/\bpr (edit|merge)\b/.test(t) || (t === "pr" && (next === "edit" || next === "merge"))) flag(lit, "gh pr edit or merge");
    if (/^--add-label\b/.test(t) || /\s--add-label\b/.test(t) || (t === "label" && next === "add")) flag(lit, "a label added");
    if (/^--body\b/.test(t)) {
      // only a PR comment takes a body: `gh pr comment <pr> --repo <R> --body-file -`
      const before = lits.slice(Math.max(0, n - 8), n).map((l) => l.text);
      const pr = before.lastIndexOf("pr");
      if (pr < 0 || before[pr + 1] !== "comment") flag(lit, "a body outside a PR comment");
    }
  });
  return found;
}

// the answer script, by its path from the hooks directory, which problems() reads from
const SCRIPT = path.join("..", "bin", "factory-answer");
const sources = (dir) => fs.readdirSync(path.join(HOOKS, dir)).filter((f) => f.endsWith(".ts") || f.endsWith(".mjs")).sort().map((f) => (dir === "" ? f : `${dir}/${f}`));
const files = [...sources(""), ...sources("v2"), SCRIPT];

test("the literal scanner reads the hooks' commands and skips comments and regular expressions", () => {
  const cli = literals(fs.readFileSync(path.join(HOOKS, "act-cli.ts"), "utf8")).map((l) => l.text);
  assert.ok(cli.includes("callum-flow-claim") && cli.includes("--heartbeat") && cli.includes("--remove-label"));
  const merge = literals(fs.readFileSync(path.join(HOOKS, "act-merge.ts"), "utf8")).map((l) => l.text);
  assert.ok(merge.includes("callum-flow-rollout"), "act-merge.ts: callum-flow-rollout");
  const rails = literals(fs.readFileSync(path.join(HOOKS, "rails.ts"), "utf8")).map((l) => l.text);
  assert.ok(rails.includes(PROBE), "rails.ts: the liveness probe");
  // a regular expression full of quotes and slashes is not read as strings
  const sample = literals("const a = /^'x\"[/]y'$/i.test(s) ? 'one' : `two ${f('three')} four`\n// 'comment'\n/* 'block' */ const b = 1 / 2 / 3; const c = 'five'");
  assert.deepEqual(
    sample.map((l) => l.text),
    ["one", "three", "two ${} four", "five"],
  );
});

test("the scanner catches each forbidden form, and passes the loop's own", () => {
  const bad = [
    "['no-mistakes', 'axi', 'respond', '--yes']",
    "`no-mistakes axi respond --action ${a} --yes`",
    "['no-mistakes', 'rerun']",
    "['no-mistakes', 'axi', 'abort']",
    "['coder', 'restart', 'x']",
    "'coder restart x'",
    "['pkill', '-f', 'watcher']",
    "['killall', 'node']",
    "['kill', name]",
    "['sh', '-c', 'kill \"$1\"']",
    "['gh', 'pr', 'edit', pr, '--body', b]",
    "['gh', 'pr', 'merge', pr]",
    "['gh', 'issue', 'edit', n, '--add-label', 'ready']",
  ];
  for (const body of bad) assert.notDeepEqual(problems("bad.ts", `export const argv = ${body}\n`), [], body);
  const good = [
    "['sh', '-c', 'kill -0 \"$1\" 2>/dev/null', 'sh', pid]",
    "['gh', 'pr', 'comment', pr, '--repo', repo, '--body-file', '-']",
    "['gh', 'issue', 'edit', n, '--repo', repo, '--remove-label', label]",
    "`agent ${seen}` + ' was killed' + ' (aborted)'",
  ];
  for (const body of good) assert.deepEqual(problems("good.ts", `export const argv = ${body}\n`), [], body);
  // no `rerun` of no-mistakes is allowed anywhere, in any hook
  for (const file of ["act-merge.ts", "act-cli.ts", "act.ts"]) assert.notDeepEqual(problems(file, "const argv = ['no-mistakes', 'rerun']\n"), [], file);
});

test("the only rerun is v2's CI re-run, argv.ts's one line", () => {
  const declared = files.flatMap((f) => fs.readFileSync(path.join(HOOKS, f), "utf8").split("\n").filter((l) => l.includes("'rerun'")).map((l) => `${f}: ${l}`));
  assert.deepEqual(declared, [`${V2_ARGV}: ${V2_RERUN}`]);
  for (const f of files) assert.ok(!fs.readFileSync(path.join(HOOKS, f), "utf8").includes("ENV_RETRY_ARGV"), `${f} names ENV_RETRY_ARGV`);
});

test("v2's widened argvs are exactly argv.ts's allowed lines: each is there, and each is caught anywhere else", () => {
  const lines = fs.readFileSync(path.join(HOOKS, V2_ARGV), "utf8").split("\n");
  for (const line of V2_ALLOWED) {
    assert.equal(lines.filter((l) => l === line).length, 1, `${V2_ARGV} must hold, once: ${line}`);
    assert.deepEqual(problems(V2_ARGV, `${line}\n`), [], line);
    assert.notDeepEqual(problems("v2/act-pr.ts", `${line}\n`), [], `outside ${V2_ARGV}: ${line}`);
    assert.notDeepEqual(problems(V2_ARGV, `${line.replace(/\]$/, ", extra]")}\n`), [], `changed: ${line}`);
  }
  // a v2 kind and its key family are names, not commands; a re-run anywhere else is caught
  assert.deepEqual(problems("v2/types.ts", "export const K = ['ci-rerun']\nconst k = `${a}/rerun/r${n}`\n"), []);
  assert.notDeepEqual(problems("v2/act-ci.ts", "const argv = ['gh', 'run', 'rerun', id]\n"), []);
  // the two vocabulary lines name a kill: there, and only there, and nothing else on them
  for (const n of V2_NAMES) {
    assert.equal(fs.readFileSync(path.join(HOOKS, n.file), "utf8").split("\n").filter((l) => l === n.line).length, 1, `${n.file} must hold, once: ${n.line}`);
    assert.deepEqual(problems(n.file, `${n.line}\n`), []);
    assert.notDeepEqual(problems("v2/act-slots.ts", `${n.line}\n`), []);
  }
});

test("no hook literal passes --yes, reruns, aborts, merges or edits a PR, adds a label, runs coder or kills by name", () => {
  assert.ok(files.length >= 15, `hooks found: ${files.join(", ")}`);
  assert.ok(files.includes(V2_ARGV) && files.includes("v2/plan.ts"), "the v2 rule layer is scanned");
  assert.ok(files.includes("contract.mjs") && files.includes(SCRIPT), "the answer contract and the answer script are scanned (#561)");
  const found = files.flatMap((f) => problems(f));
  assert.deepEqual(found, []);
});

// The answer script (#561) writes the one answer file it is given and nothing else: one temp file
// it creates itself (exclusively), renamed over the answer file, and removed again if anything
// fails. It runs no command. tests/factory-loop-answer.test.js runs it against every path it
// must refuse; this reads its source, so a new write call cannot slip in unseen.
test("the answer script's only writes are its own temp file and the rename over the answer file, and it runs no command", () => {
  const src = fs
    .readFileSync(path.join(HOOKS, SCRIPT), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const WRITES = /^(writeFile|appendFile|write|open|rename|unlink|rm|rmdir|mkdir|mkdtemp|copyFile|cp|symlink|link|chmod|chown|truncate|utimes|lchown|lutimes)$/;
  // each write call by its name and first argument: the temp file, then the body into it
  const writes = [...src.matchAll(/\b(?:fs|handle)\.(\w+)\(([^,)]*)/g)].filter((m) => WRITES.test(m[1])).map((m) => `${m[1]}(${m[2]}`);
  assert.deepEqual(writes, ["open(tmp", "writeFile(body", "rename(tmp", "unlink(tmp"]);
  assert.ok(src.includes("await fs.open(tmp, 'wx', 0o644)"), "the temp file is created exclusively, never opened over another");
  assert.ok(src.includes("await fs.rename(tmp, path.join(dir, name))"), "the rename lands on the answer file placeOf checked");
  // it runs no command, bar one: a design wait's read-only `gh` lookups (hooks/v2/wait-check.mjs, #980),
  // by execFile with an argv and no shell
  assert.doesNotMatch(src, /\bspawn\w*\(|\bexec(Sync)?\(|\bexecFileSync\(|\bfork\(|shell:/);
  // (the one runner takes its command from readOnGitHub's calls below: gh, or callum-flow-issue-read)
  assert.deepEqual([...src.matchAll(/\bexecFile\(([^,]*),/g)].map((m) => m[1]), ["command"]);
  assert.ok(src.includes("async function readOnGitHub(mods, self, file, command = 'gh', env = {})"));
  assert.deepEqual([...src.matchAll(/readOnGitHub\(mods, self, ('[^']+')(?:, ('[^']+'))?/g)].map((m) => [m[1], m[2] ?? "'gh'"]), [["'wait-check.mjs'", "'gh'"], ["'done-check.mjs'", "'gh'"], ["'rollout-check.mjs'", "'callum-flow-issue-read'"], ["'upstream-check.mjs'", "'callum-flow-issue-read'"]]);
  // the modules it loads: node's own, and the contract and the wait check beside the hooks
  const imports = [...src.matchAll(/\bimport\((['"][^'"]+['"])\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["'node:fs/promises'", "'node:path'", "'node:os'", "'node:crypto'", "'node:url'", "'node:child_process'", "'node:url'"].sort());
  assert.equal([...src.matchAll(/\bimport\(/g)].length, imports.length + 2);
  assert.ok(src.includes("await import(url.pathToFileURL(path.join(path.dirname(self), '..', 'hooks', 'contract.mjs')).href)"));
  // the one loader of the read-only checks takes its file from the calls above: a wait's, a done close's, a Rollout's and an upstream request's
  assert.ok(src.includes("await import(url.pathToFileURL(path.join(path.dirname(self), '..', 'hooks', 'v2', file)).href)"));
});

// The act step holds GitHub writes for the rest of a pass that met a rate limit (v2 SPEC 13.10 item 2): the
// kinds foundation.ts GITHUB_V2 names.
test("the act step's GitHub kinds are the shared kinds that write GitHub, and v2's", () => {
  const list = (file, name) => {
    const src = fs.readFileSync(path.join(HOOKS, file), "utf8");
    const m = new RegExp(`const ${name}: readonly ActionKind\\[\\] = \\[([^\\]]*)\\]`).exec(src);
    assert.ok(m, `${file}: ${name}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  const v2 = list("foundation.ts", "GITHUB_V2");
  for (const kind of ["claim", "heartbeat", "sweep", "label", "comment", "pr", "split", "ci-rerun", "queue-update", "queue-merge"]) assert.ok(v2.includes(kind), `GITHUB_V2 lacks ${kind}`);
  for (const kind of ["transition", "event", "agent-step", "slot"]) assert.ok(!v2.includes(kind), `GITHUB_V2 holds ${kind}, which writes no GitHub`);
});
