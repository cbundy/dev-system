"use strict";

// The factory loop's second safety net (docs/factory-loop/SPEC.md 6.1, 11): no string literal in
// plugins/factory-loop/hooks/*.ts may carry what no executor may ever do: pass --yes, run
// `no-mistakes rerun` or `abort`, merge through anything but callum-flow-merge, edit a PR body,
// add a label, run a `coder` command or kill a process by name. The first net,
// plugins/factory-loop/tests/safety.test.ts, runs every action kind through the dispatcher and
// checks each argv; this one reads the source, since plugin tests cannot read files, so a
// template that no test reaches is still caught. The one signal the loop sends is rails.ts's
// liveness probe, `kill -0` by pid, which delivers nothing; `kill switch` alone is the skip reason
// act.ts logs (#557), never a command. The one rerun is rule P2a's env-retry (#537): its argv is
// declared once, on ENV_RETRY's line, and only that line may hold `rerun`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HOOKS = path.join(__dirname, "..", "plugins", "factory-loop", "hooks");
const PROBE = 'kill -0 "$1" 2>/dev/null';
const KILL_SWITCH = "kill switch";
const ENV_RETRY = { file: "act-merge.ts", line: "export const ENV_RETRY_ARGV: readonly string[] = ['no-mistakes', 'rerun']" };
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
  const envRetry = (lit) => file === ENV_RETRY.file && lit.text === "rerun" && lines[lit.line - 1] === ENV_RETRY.line;
  const flag = (lit, what) => found.push(`${file}:${lit.line}: ${what}: ${JSON.stringify(lit.text.slice(0, 80))}`);
  lits.forEach((lit, n) => {
    const t = lit.text;
    const next = lits[n + 1]?.text;
    if (/(^|[\s=])--yes\b/.test(t)) flag(lit, "--yes");
    if ((/\brerun\b/.test(t) && !envRetry(lit)) || t === "abort" || /\bno-mistakes\b[^\n]*\babort\b/.test(t)) flag(lit, "rerun or abort");
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

const files = fs.readdirSync(HOOKS).filter((f) => f.endsWith(".ts")).sort();

test("the literal scanner reads the hooks' commands and skips comments and regular expressions", () => {
  const cli = literals(fs.readFileSync(path.join(HOOKS, "act-cli.ts"), "utf8")).map((l) => l.text);
  assert.ok(cli.includes("callum-flow-claim") && cli.includes("--heartbeat") && cli.includes("--remove-label"));
  const merge = literals(fs.readFileSync(path.join(HOOKS, "act-merge.ts"), "utf8")).map((l) => l.text);
  assert.ok(merge.includes("callum-flow-merge"), "act-merge.ts: callum-flow-merge");
  assert.ok(merge.some((t) => t.startsWith("nohup sh -c")), "act-merge.ts: the respond launch's template");
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
  // the env-retry exception is that one line of act-merge.ts, exactly: elsewhere, or with any
  // change to the argv or its name, `rerun` is caught
  assert.deepEqual(problems(ENV_RETRY.file, `${ENV_RETRY.line}\n`), []);
  assert.notDeepEqual(problems("act-cli.ts", `${ENV_RETRY.line}\n`), []);
  for (const line of [
    "export const ENV_RETRY_ARGV: readonly string[] = ['no-mistakes', 'rerun', '--yes']",
    "export const ENV_RETRY_ARGV: readonly string[] = ['no-mistakes', 'rerun', '--intent', i]",
    "export const OTHER_ARGV: readonly string[] = ['no-mistakes', 'rerun']",
    "const argv = ['no-mistakes', 'rerun']",
    "export const ENV_RETRY_ARGV: readonly string[] = ['no-mistakes', 'axi', 'abort']",
  ]) {
    assert.notDeepEqual(problems(ENV_RETRY.file, `${line}\n`), [], line);
  }
});

test("the one rerun is env-retry's argv: declared once in act-merge.ts, used only by its executor and argv list", () => {
  const declared = files.flatMap((f) => fs.readFileSync(path.join(HOOKS, f), "utf8").split("\n").filter((l) => l.includes("'rerun'")).map((l) => `${f}: ${l}`));
  assert.deepEqual(declared, [`${ENV_RETRY.file}: ${ENV_RETRY.line}`]);
  for (const f of files.filter((x) => x !== ENV_RETRY.file)) {
    assert.ok(!fs.readFileSync(path.join(HOOKS, f), "utf8").includes("ENV_RETRY_ARGV"), `${f} names ENV_RETRY_ARGV`);
  }
  const src = fs.readFileSync(path.join(HOOKS, ENV_RETRY.file), "utf8");
  const uses = src.split("\n").filter((l) => l.includes("ENV_RETRY_ARGV") && l !== ENV_RETRY.line && !/^\s*\/\//.test(l));
  assert.equal(uses.length, 2, uses.join("\n"));
  // argvsOf's case and the executor's launch, each in env-retry's own code
  const envCase = src.slice(src.indexOf("case 'env-retry': {"), src.indexOf("default:", src.indexOf("case 'env-retry': {")));
  const executor = src.slice(src.indexOf("const envRetry: Executor"), src.indexOf("\n}\n", src.indexOf("const envRetry: Executor")));
  assert.ok(envCase.includes("ENV_RETRY_ARGV") && executor.includes("ENV_RETRY_ARGV"), "ENV_RETRY_ARGV outside env-retry's code");
  assert.ok(executor.includes("action.rule !== 'P2a'"), "the executor refuses any rule but P2a");
});

test("no hook literal passes --yes, reruns, aborts, merges or edits a PR, adds a label, runs coder or kills by name", () => {
  assert.ok(files.length >= 15, `hooks found: ${files.join(", ")}`);
  const found = files.flatMap((f) => problems(f));
  assert.deepEqual(found, []);
});

// The act step holds GitHub writes for the rest of a pass that met a rate limit, as plan holds
// them while the backoff lasts (SPEC 10.2): act.ts GITHUB_KINDS must name exactly plan.ts's.
test("the act step's GitHub kinds are plan's", () => {
  const list = (file, name) => {
    const src = fs.readFileSync(path.join(HOOKS, file), "utf8");
    const m = new RegExp(`const ${name}: readonly ActionKind\\[\\] = \\[([^\\]]*)\\]`).exec(src);
    assert.ok(m, `${file}: ${name}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  const plan = list("plan.ts", "GITHUB");
  assert.ok(plan.length > 10);
  assert.deepEqual(list("act.ts", "GITHUB_KINDS"), plan);
});
