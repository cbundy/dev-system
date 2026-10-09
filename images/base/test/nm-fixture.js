// Builds / changes a small no-mistakes state.sqlite for sections/09-agentsview.sh
// (cbundy/dev-system#273). A subset of the real schema: columns it lacks must
// come out NULL, and the excluded ones must not be shipped.
// Usage: node nm-fixture.js <file> create | status <run id> <status> | unknown-column
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
} else {
  process.exit(2);
}
db.close();
