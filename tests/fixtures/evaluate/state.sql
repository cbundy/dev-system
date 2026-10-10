CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL, upstream_url TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, branch TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, parked_ms INTEGER, awaiting_agent_since INTEGER);
CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL, duration_ms INTEGER, status TEXT NOT NULL);
CREATE TABLE step_rounds (id TEXT PRIMARY KEY, step_result_id TEXT NOT NULL, round INTEGER NOT NULL, trigger_type TEXT NOT NULL);
CREATE TABLE agent_invocations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL, purpose TEXT, model TEXT, fallback_reason TEXT, model_roundtrips INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER);
INSERT INTO repos VALUES ('repo1','/work/repo','https://github.com/acme/widgets.git'),('repo2','/work/other','git@github.com:acme/other.git');
INSERT INTO runs (id, repo_id, branch, status, created_at, parked_ms, awaiting_agent_since) VALUES
 ('run1','repo1','feat/issue-9-a','completed',1791454200,90000,NULL),('run2','repo1','feat/issue-10-a','failed',1791454800,30000,1791455000),
 ('run3','repo1','feat/issue-7-a','completed',1791450000,999999,NULL),('runX','repo2','feat/issue-3-a','completed',1791454500,5000,NULL),
 ('run8a','repo1','feat/issue-8-a','cancelled',1791444600,NULL,NULL),('run8b','repo1','fix/issue-8-b','completed',1791445200,NULL,NULL),
 ('run1a','repo1','feat/issue-1-a','completed',1791536400,NULL,NULL),('run2a','repo1','feat/issue-2-a','completed',1791537600,NULL,NULL);
INSERT INTO step_results VALUES ('sr1','run1','review',60000,'completed'),('sr2','run1','ci',120000,'completed'),('sr3','run2','review',50000,'failed'),('sr4','run2','ci',300000,'completed'),('sr5','run3','ci',999000,'completed'),('sr6','run3','review',1,'completed'),('sr7','run1','test',NULL,'skipped'),('sr8','runX','lint',1000,'completed');
INSERT INTO step_rounds VALUES ('a','sr1',1,'initial'),('b','sr1',2,'auto_fix'),('c','sr3',1,'initial'),('d','sr6',1,'initial'),('e','sr6',2,'auto_fix'),('f','sr6',3,'auto_fix'),('g','sr6',4,'auto_fix'),('h','sr6',5,'auto_fix');
INSERT INTO agent_invocations VALUES ('i1','run1','review','review','claude-sonnet-5-5',NULL,3,10,20,300,40),('i2','run1','review','review','','codex login missing',NULL,NULL,NULL,NULL,NULL),('i3','run2','lint','fix','claude-sonnet-5-5','',1,5,5,50,0),('i4','run3','lint','fix','claude-sonnet-5-5',NULL,9,900,900,900,900),('i5','runX','lint','review','claude-opus-5-5',NULL,2,7,7,7,7);
