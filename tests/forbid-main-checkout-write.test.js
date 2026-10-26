// Tests for the callum-flow PreToolUse hook that refuses a sub-agent's writes into the
// repo's main checkout (dev-system#624). Builds a real main checkout with a treehouse
// slot under .treehouse/, feeds the hook the exact PreToolUse JSON Claude Code puts on
// stdin, and asserts refuse/allow.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, "plugins", "fabriek", "hooks");
const HOOK = path.join(HOOKS_DIR, "forbid-main-checkout-write.sh");
const HOOKS_JSON = path.join(HOOKS_DIR, "hooks.json");

// A main checkout that uses treehouse, one slot in its pool, and a symlink to it.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "main-write-")));
const MAIN = path.join(tmp, "repo");
const SLOT = path.join(MAIN, ".treehouse", "repo-abc123", "1", "repo");
const LINK = path.join(tmp, "link-to-main");
const OUTSIDE = path.join(tmp, "elsewhere");
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}
fs.mkdirSync(path.join(MAIN, "plugins", "x"), { recursive: true });
fs.writeFileSync(path.join(MAIN, "treehouse.toml"), 'root = "./"\n');
fs.writeFileSync(path.join(MAIN, "plugins", "x", "a.ts"), "a\n");
git(["init", "-q"], MAIN);
git(["add", "."], MAIN);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i"], MAIN);
fs.mkdirSync(path.dirname(SLOT), { recursive: true });
git(["worktree", "add", "-q", "-b", "slot", SLOT], MAIN);
fs.symlinkSync(MAIN, LINK);
fs.mkdirSync(OUTSIDE);
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

function runHook(toolName, toolInput, { cwd = MAIN, agent = true, projectDir = MAIN, extraEnv = {} } = {}) {
  const input = {
    session_id: "abc123",
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_01ABC123",
  };
  if (agent) Object.assign(input, { agent_id: "a7ff25c7f81eaaa44", agent_type: "callum-flow:implementer" });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv };
  if (projectDir === null) delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync(HOOK, [], { input: JSON.stringify(input), encoding: "utf-8", env });
  assert.equal(result.status, 0, `hook should always exit 0; stderr: ${result.stderr}`);
  return result;
}

const bash = (command, opts) => runHook("Bash", { command, description: "test" }, opts);

function assertDenied(result, label, rel) {
  const stdout = result.stdout.trim();
  assert.notEqual(stdout, "", `expected a deny decision for: ${label}`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", `expected deny for: ${label}`);
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /main checkout/, "reason should name the main checkout");
  assert.match(reason, /same relative path/, "reason should say where the file is in the worktree");
  assert.match(reason, /worktree-absolute paths/, "reason should say to use worktree paths");
  assert.match(reason, /Reading the main checkout .* stays allowed/, "reason should say reads are fine");
  assert.match(reason, /factory-loop agent's worktree is the slot/, "reason should send a loop agent to its slot");
  assert.match(reason, /Only on the manual path/, "reason should mark leasing as the manual path");
  assert.doesNotMatch(reason, /—/, "reason must not contain an em dash");
  if (rel) assert.ok(reason.includes(`<your worktree>/${rel}`), `reason should map ${rel} into the worktree: ${reason}`);
}
function assertAllowed(result, label) {
  assert.equal(result.stdout.trim(), "", `expected no decision (allow) for: ${label}`);
}
const denyBash = (command, opts, rel) => assertDenied(bash(command, opts), command, rel);
const allowBash = (command, opts) => assertAllowed(bash(command, opts), command);

test("refuses the incident: cd into the main checkout, then a python heredoc or sed -i", () => {
  denyBash(
    `cd ${MAIN}/plugins/x && python3 - <<'EOF'\np = 'a.ts'\ns = open(p).read()\nopen(p, 'w').write(s.replace('a', 'b'))\nEOF`,
    {},
    "plugins/x"
  );
  denyBash(`cd ${MAIN}/plugins/x && sed -i 's/a/b/' a.ts`, { cwd: SLOT }, "plugins/x/a.ts");
  denyBash(`cd ${MAIN}/plugins/x; python3 -c "import pathlib; pathlib.Path('a.ts').write_text('b')"`, { cwd: SLOT });
  denyBash(`cd ${MAIN} && node -e "require('fs').writeFileSync('plugins/x/a.ts', 'b')"`, { cwd: SLOT });
});

test("refuses Edit, Write, MultiEdit and NotebookEdit into the main checkout", () => {
  const file = path.join(MAIN, "plugins", "x", "a.ts");
  assertDenied(runHook("Edit", { file_path: file, old_string: "a", new_string: "b" }), "Edit", "plugins/x/a.ts");
  assertDenied(runHook("Write", { file_path: file, content: "b" }), "Write");
  assertDenied(runHook("MultiEdit", { file_path: file, edits: [] }), "MultiEdit");
  assertDenied(runHook("NotebookEdit", { notebook_path: path.join(MAIN, "n.ipynb"), new_source: "" }), "NotebookEdit");
  assertDenied(runHook("Write", { file_path: path.join(LINK, "plugins", "x", "a.ts"), content: "b" }), "Write via a symlink");
  assertDenied(runHook("Write", { file_path: path.join(SLOT, "..", "..", "..", "..", "x.ts"), content: "b" }), "Write via ..");
});

test("refuses writes from the start directory (the main checkout) with relative paths", () => {
  denyBash("sed -i 's/a/b/' plugins/x/a.ts", {}, "plugins/x/a.ts");
  denyBash("sed -i.bak -e 's/a/b/' plugins/x/a.ts");
  denyBash("perl -pi -e 's/a/b/' plugins/x/a.ts");
  denyBash("echo hi > plugins/x/a.ts");
  denyBash("echo hi >> notes.txt");
  denyBash("git diff origin/main 2>&1 >out.patch");
  denyBash("printf x | tee -a plugins/x/a.ts");
  denyBash("rm -f plugins/x/a.ts");
  denyBash("mkdir -p plugins/y && touch plugins/y/z");
  denyBash("mv plugins/x/a.ts plugins/x/b.ts");
  denyBash(`cp ${SLOT}/plugins/x/a.ts plugins/x/a.ts`);
  denyBash("git checkout -- plugins");
  denyBash("git restore plugins/x/a.ts");
  denyBash("git apply /tmp/x.patch");
  denyBash("git add -A && git commit -m wip");
  denyBash("git switch -c feat/x");
  denyBash("git reset --hard origin/main");
  denyBash("git clean -fd");
  denyBash("git ls-files | xargs sed -i 's/a/b/'");
  denyBash("find plugins -name '*.ts' -exec sed -i 's/a/b/' {} +");
  denyBash("find . -name '*.orig' -delete");
  denyBash("cat > plugins/x/new.ts <<'EOF'\nhello\nEOF");
  denyBash("dd if=/dev/zero of=plugins/x/a.ts count=1");
});

test("follows cd .., relative cds, variables, sh -c, eval and symlinks", () => {
  denyBash("cd ../../../.. && sed -i 's/a/b/' plugins/x/a.ts", { cwd: SLOT });
  denyBash(`cd ${SLOT} && cd ../../../.. && echo x > plugins/x/a.ts`, { cwd: OUTSIDE });
  denyBash(`R=${MAIN}; sed -i 's/a/b/' "$R/plugins/x/a.ts"`, { cwd: SLOT });
  denyBash(`export R=${MAIN} && echo x > \${R}/plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`sed -i 's/a/b/' "$MAINREPO/plugins/x/a.ts"`, { cwd: SLOT, extraEnv: { MAINREPO: MAIN } });
  denyBash(`bash -c "cd ${MAIN} && sed -i s/a/b/ plugins/x/a.ts"`, { cwd: SLOT });
  denyBash(`sh -c 'echo x > ${MAIN}/plugins/x/a.ts'`, { cwd: SLOT });
  denyBash(`eval "echo x > ${MAIN}/plugins/x/a.ts"`, { cwd: SLOT });
  denyBash(`bash <<'EOF'\ncd ${MAIN}\nsed -i 's/a/b/' plugins/x/a.ts\nEOF`, { cwd: SLOT });
  denyBash(`cd ${LINK}/plugins && sed -i 's/a/b/' x/a.ts`, { cwd: SLOT });
  denyBash(`echo x > ${LINK}/plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`git -C ${MAIN} checkout -- .`, { cwd: SLOT });
  denyBash(`python3 - <<'EOF'\nopen('${MAIN}/plugins/x/a.ts', 'w').write('b')\nEOF`, { cwd: SLOT });
  denyBash(`(cd ${MAIN} && sed -i 's/a/b/' plugins/x/a.ts)`, { cwd: SLOT });
  denyBash(`timeout 30 sed -i 's/a/b/' ${MAIN}/plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`env FOO=1 sed -i 's/a/b/' ${MAIN}/plugins/x/a.ts`, { cwd: SLOT });
});

test("allows reads of the main checkout", () => {
  for (const command of [
    "cat plugins/x/a.ts",
    "sed -n '1,20p' plugins/x/a.ts",
    "grep -rn foo plugins",
    "git status --porcelain",
    "git log --oneline -5",
    "git show origin/feat:plugins/x/a.ts",
    "git diff origin/main...origin/feat",
    "git fetch origin",
    "ls -la && wc -l plugins/x/a.ts",
    "find plugins -name '*.ts'",
    "cat plugins/x/a.ts 2>/dev/null | head -5 >&2",
    "git diff > /dev/null",
    `python3 -c "print(open('plugins/x/a.ts').read())"`,
    "python3 - <<'EOF'\nimport json\nprint(json.load(open('package.json')))\nEOF",
    "node -e \"console.log(require('fs').readFileSync('plugins/x/a.ts', 'utf8'))\"",
    "awk '{print $1}' plugins/x/a.ts",
    "echo 'sed -i s/a/b/ plugins/x/a.ts'",
    "git commit --help >/dev/null 2>&1 || true",
    "git apply --check /tmp/x.patch",
    "git clean --dry-run -d",
  ]) {
    allowBash(command);
  }
  assertAllowed(runHook("Read", { file_path: path.join(MAIN, "plugins", "x", "a.ts") }), "Read");
});

test("allows copying out of the main checkout and writing outside it", () => {
  allowBash(`cp ${MAIN}/plugins/x/a.ts ${SLOT}/plugins/x/a.ts`);
  allowBash(`cp plugins/x/a.ts ${OUTSIDE}/a.ts`);
  allowBash(`git diff > ${OUTSIDE}/602.patch`);
  allowBash(`rsync -a ${MAIN}/plugins/ ${OUTSIDE}/plugins/`);
  allowBash(`echo x > /tmp/scratch-${process.pid}.txt && rm -f /tmp/scratch-${process.pid}.txt`);
  allowBash("cd /tmp && echo x > scratch.txt");
});

test("allows everything inside a .treehouse worktree", () => {
  allowBash(`cd ${SLOT} && sed -i 's/a/b/' plugins/x/a.ts`);
  allowBash(`cd ${SLOT}/plugins/x && python3 - <<'EOF'\nopen('a.ts', 'w').write('b')\nEOF`);
  allowBash(`sed -i 's/a/b/' ${SLOT}/plugins/x/a.ts`);
  allowBash("sed -i 's/a/b/' plugins/x/a.ts && git add -A && git commit -m wip", { cwd: SLOT });
  allowBash("echo x > plugins/x/a.ts; rm -f plugins/x/b.ts; git checkout -- .", { cwd: SLOT });
  allowBash(`git -C ${SLOT} commit -m wip`);
  allowBash(`cd ${SLOT} && cd .. && ls`);
  allowBash(`chmod +x ${SLOT}/run.sh`);
  allowBash(`touch -d yesterday ${SLOT}/plugins/x/a.ts`);
  const file = path.join(SLOT, "plugins", "x", "a.ts");
  assertAllowed(runHook("Edit", { file_path: file, old_string: "a", new_string: "b" }), "Edit in the slot");
  assertAllowed(runHook("Write", { file_path: file, content: "b" }, { cwd: SLOT, projectDir: SLOT }), "Write, session started in the slot");
});

test("allows the repo-local operator and loop state files", () => {
  for (const rel of [".claude/orchestrator-memory.md", ".claude/factory-loop.json", ".claude/agent-memory/implementer.md", ".claude/agent-memory/sub/x.md"]) {
    assertAllowed(runHook("Write", { file_path: path.join(MAIN, rel), content: "x" }), `Write ${rel}`);
    allowBash(`echo x >> ${rel}`);
  }
  assertDenied(runHook("Write", { file_path: path.join(MAIN, ".claude", "settings.json"), content: "x" }), "Write .claude/settings.json");
});

test("a session that started in a slot still protects the main checkout", () => {
  assertDenied(runHook("Write", { file_path: path.join(MAIN, "x.ts"), content: "b" }, { cwd: SLOT, projectDir: SLOT }), "Write main from a slot session");
  denyBash(`echo x > ${MAIN}/x.ts`, { cwd: SLOT, projectDir: SLOT });
  // without CLAUDE_PROJECT_DIR the input cwd is the start directory
  denyBash("echo x > x.ts", { projectDir: null });
});

test("leaves the main session alone, and repos without treehouse", () => {
  assertAllowed(bash("sed -i 's/a/b/' plugins/x/a.ts", { agent: false }), "main session sed -i");
  assertAllowed(
    runHook("Edit", { file_path: path.join(MAIN, "plugins", "x", "a.ts"), old_string: "a", new_string: "b" }, { agent: false }),
    "main session Edit"
  );
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(plain);
  git(["init", "-q"], plain);
  assertAllowed(bash("echo x > a.txt", { cwd: plain, projectDir: plain }), "repo without treehouse");
  assertAllowed(bash("echo x > a.txt", { cwd: OUTSIDE, projectDir: OUTSIDE }), "not a git repo");
});

test("refuses bulk edits fed through xargs or loops (review findings)", () => {
  denyBash(`find ${MAIN}/plugins -name '*.ts' | xargs sed -i 's/a/b/'`, { cwd: SLOT });
  denyBash(`grep -rl foo ${MAIN}/plugins | xargs -r sed -i 's/foo/bar/'`, { cwd: SLOT });
  denyBash("for f in plugins/x/*.ts; do sed -i 's/a/b/' \"$f\"; done");
  denyBash(`for f in ${MAIN}/plugins/x/*.ts; do sed -i 's/a/b/' "$f"; done`, { cwd: SLOT });
  denyBash(`cd ${MAIN} && while read -r f; do sed -i 's/a/b/' "$f"; done < list.txt`, { cwd: SLOT });
  denyBash(`cat <<'EOF' | python3\nopen('plugins/x/a.ts', 'w').write('b')\nEOF`);
  denyBash(`sed -i 's/a/b/' \\\n${MAIN}/plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`env -C ${MAIN} sed -i 's/a/b/' plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`sudo -u node sed -i 's/a/b/' ${MAIN}/plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`uv run python - <<'EOF'\nopen('${MAIN}/plugins/x/a.ts', 'w').write('b')\nEOF`, { cwd: SLOT });
  denyBash(`p = 1; python3 - <<'EOF'\nt = '${MAIN}/plugins/x/a.ts'\nwith open(t, 'w') as f: f.write('b')\nEOF`, { cwd: SLOT });
  denyBash(`tar -xzf /tmp/x.tgz -C ${MAIN}`, { cwd: SLOT });
  denyBash(`curl -sSo ${MAIN}/x.json https://example.com`, { cwd: SLOT });
  denyBash(`cd ${MAIN} && npx prettier --write plugins/x/a.ts`, { cwd: SLOT });
  denyBash(`npx eslint --fix ${MAIN}/plugins/x/a.ts`, { cwd: SLOT });
});

test("does not refuse reads that look like writes (review findings)", () => {
  allowBash("python3 - <<'EOF'\nimport sys\nsys.stdout.write(open('plugins/x/a.ts').read())\nEOF");
  allowBash("node -e \"process.stdout.write(require('fs').readFileSync('plugins/x/a.ts', 'utf8'))\"");
  allowBash(`python3 - <<'EOF'\nsrc = open('${MAIN}/plugins/x/a.ts').read()\nopen('${SLOT}/plugins/x/a.ts', 'w').write(src)\nEOF`, { cwd: SLOT });
  allowBash("git stash list");
  allowBash(`(cd ${MAIN} && git log -1); echo x > plugins/x/a.ts`, { cwd: SLOT });
  allowBash(`find ${MAIN}/plugins -name '*.ts' | xargs grep -l foo`, { cwd: SLOT });
  allowBash(`cd ${SLOT} && for f in plugins/x/*.ts; do sed -i 's/a/b/' "$f"; done`);
  allowBash(`curl -s https://example.com > ${OUTSIDE}/x.json && tar -tzf /tmp/x.tgz`);
  allowBash("npx prettier --check plugins/x/a.ts");
  allowBash(`npx prettier --write ${SLOT}/plugins/x/a.ts`);
  // a Claude Code worktree under the main checkout is a worktree, not the main checkout
  const cc = path.join(MAIN, ".claude", "worktrees", "agent-1");
  assertAllowed(runHook("Edit", { file_path: path.join(cc, "plugins", "x", "a.ts"), old_string: "a", new_string: "b" }), "Edit in .claude/worktrees");
  allowBash(`cd ${cc} && sed -i 's/a/b/' plugins/x/a.ts`);
});

test("allows any linked worktree under the main checkout, wherever it lives", () => {
  const other = path.join(MAIN, "wt-elsewhere");
  git(["worktree", "add", "-q", "-b", "other", other], MAIN);
  allowBash(`cd ${other} && sed -i 's/a/b/' plugins/x/a.ts`);
  denyBash(`cd ${other}/.. && sed -i 's/a/b/' plugins/x/a.ts`, { cwd: SLOT });
});

test("is registered for Bash and the file-editing tools", () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf-8")).hooks.PreToolUse;
  const cmd = '"${CLAUDE_PLUGIN_ROOT}/hooks/forbid-main-checkout-write.sh"';
  const matchers = hooks.filter((h) => h.hooks.some((x) => x.command === cmd)).map((h) => h.matcher);
  assert.deepEqual(matchers.sort(), ["Bash", "Edit|Write|MultiEdit|NotebookEdit"]);
});
