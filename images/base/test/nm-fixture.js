// Builds / changes a small no-mistakes state.sqlite for sections/09-agentsview.sh
// (cbundy/dev-system#273). A subset of the real schema: columns it lacks must
// come out NULL, and the excluded ones must not be shipped.
// Usage: node nm-fixture.js <file> create | status <run id> <status> | unknown-column | metrics
"use strict";
const { DatabaseSync } = require("node:sqlite");
const [file, cmd, a, b] = process.argv.slice(2);
const db = new DatabaseSync(file);
if (cmd === "create") {
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT, upstream_url TEXT, default_branch TEXT, created_at INTEGER);
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT, branch TEXT, worktree_dir TEXT, no_mistakes_version TEXT,
      status TEXT, error TEXT, created_at INTEGER, updated_at INTEGER, intent TEXT);
    CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT, step_name TEXT, status TEXT, log_path TEXT, agent_pid INTEGER,
      findings_json TEXT, started_at INTEGER, completed_at INTEGER, last_activity_at INTEGER);
    CREATE TABLE step_rounds (id TEXT PRIMARY KEY, step_result_id TEXT, round INTEGER, global_config_yaml BLOB,
      repo_config_yaml BLOB, fix_summary TEXT, created_at INTEGER);
    CREATE TABLE agent_invocations (id TEXT PRIMARY KEY, run_id TEXT, step_name TEXT, model TEXT, input_tokens INTEGER, completed_at INTEGER);
    CREATE TABLE run_agent_sessions (run_id TEXT, role TEXT, agent TEXT, session_id TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (run_id, role));
    INSERT INTO repos VALUES ('rp1', '/secret/path', 'git@github.com:Acme/Widgets.git', 'main', 1700000000);
    INSERT INTO runs VALUES ('r1', 'rp1', 'feat/x', '/secret/wt', 'v1.84.0', 'running', NULL, 1700000100, 1700000200, 'it''s \\ the intent');
    INSERT INTO runs VALUES ('r2', 'rp1', 'feat/y', '/secret/wt2', 'v1.84.0', 'completed', NULL, 1700000100, 1700000150, 'two');
    INSERT INTO step_results VALUES ('s1', 'r1', 'review', 'running', '/secret/log', 4242, '{"findings":[]}', 1700000110, NULL, 1700000200);
    INSERT INTO step_results VALUES ('s2', 'r2', 'review', 'completed', '/secret/log', 4243, NULL, 1700000110, 1700000150, 1700000150);
    INSERT INTO step_rounds VALUES ('d1', 's1', 1, x'00ff', x'00ee', 'fixed', 1700000120);
    INSERT INTO agent_invocations VALUES ('i1', 'r1', 'review', 'claude-test', 100, 1700000130);
    INSERT INTO run_agent_sessions VALUES ('r1', 'driver', 'claude', 'sess-1', 1700000100, 1700000200);
  `);
} else if (cmd === "status") {
  db.prepare("UPDATE runs SET status = ?, updated_at = updated_at + 10 WHERE id = ?").run(b, a);
} else if (cmd === "unknown-column") {
  db.exec("ALTER TABLE runs ADD COLUMN brand_new TEXT; UPDATE runs SET brand_new = 'surprise', updated_at = updated_at + 10 WHERE id = 'r1'");
} else if (cmd === "metrics") {
  // Rows for the saved queries in docs/metrics.md (cbundy/dev-system#275): the columns the
  // queries read are added to the subset schema, then two runs are inserted next to r1/r2.
  // Run it after `create`; sections/09-agentsview.sh checks headline values of these rows.
  const add = {
    runs: "pr_url TEXT, pr_state TEXT, parked_ms INTEGER, awaiting_agent_since INTEGER",
    step_rounds: "trigger_type TEXT, findings_json TEXT, user_findings_json TEXT, selection_source TEXT",
    agent_invocations: "purpose TEXT, agent TEXT, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, duration_ms INTEGER, failure_category TEXT, fallback_reason TEXT",
  };
  for (const [t, cs] of Object.entries(add)) for (const c of cs.split(", ")) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
  const finds = (n, prefix) => JSON.stringify({ findings: Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, severity: "warning" })) });
  // r3: merged PR, 120 s parked, review needed one auto-fix round
  db.exec(`
    INSERT INTO runs (id, repo_id, branch, status, created_at, updated_at, pr_url, pr_state, parked_ms)
      VALUES ('r3', 'rp1', 'feat/z', 'completed', 1700001000, 1700001600, 'https://github.com/acme/widgets/pull/7', 'merged', 120000);
    INSERT INTO runs (id, repo_id, branch, status, created_at, updated_at, pr_state, parked_ms, awaiting_agent_since)
      VALUES ('r4', 'rp1', 'feat/w', 'running', 1700002000, 1700002100, 'open', 30000, 1700002050);
    INSERT INTO step_results (id, run_id, step_name, status) VALUES
      ('s3a', 'r3', 'review', 'completed'), ('s3b', 'r3', 'test', 'completed'), ('s3c', 'r3', 'lint', 'completed'),
      ('s4a', 'r4', 'review', 'completed'), ('s4b', 'r4', 'test', 'failed'), ('s4c', 'r4', 'ci', 'pending'),
      ('s4d', 'r4', 'pr', 'skipped');
  `);
  const round = db.prepare("INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json, user_findings_json, selection_source) VALUES (?, ?, ?, ?, ?, ?, ?)");
  round.run("d3a1", "s3a", 1, "initial", finds(3, "rv"), finds(1, "user"), "user");
  round.run("d3a2", "s3a", 2, "auto_fix", finds(1, "rv"), "", "auto_fix");
  round.run("d3b1", "s3b", 1, "initial", finds(0, "t"), null, null);
  round.run("d4a1", "s4a", 1, "initial", finds(2, "rv"), null, "user_declined");
  round.run("d4b1", "s4b", 1, "initial", finds(1, "t"), null, null);
  round.run("d4b2", "s4b", 2, "auto_fix", finds(1, "t"), null, "auto_fix");
  round.run("d4b3", "s4b", 3, "auto_fix", finds(1, "t"), null, "auto_fix");
  const inv = db.prepare("INSERT INTO agent_invocations (id, run_id, step_name, model, purpose, agent, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, failure_category, fallback_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  inv.run("i3a", "r3", "review", "claude-opus", "review", "claude", 1000, 200, 5000, 300, 60000, "", null);
  inv.run("i3b", "r3", "review", "claude-opus", "review-fix", "claude", 500, 100, 2000, 0, 30000, "", "exit");
  inv.run("i3c", "r3", "review", "gpt-test", "review-fix", "codex", 200, 40, 0, 0, 5000, "exit", null);
  inv.run("i3d", "r3", "test", "claude-opus", "test", "claude", 800, 150, 3000, 100, 45000, "", null);
  inv.run("i4a", "r4", "review", "claude-opus", "review", "claude", 400, 80, 1000, 50, 20000, "", null);
  inv.run("i4b", "r4", "test", "gpt-test", "test", "codex", 300, 60, 0, 0, 10000, "exit", null);
} else {
  process.exit(2);
}
db.close();
