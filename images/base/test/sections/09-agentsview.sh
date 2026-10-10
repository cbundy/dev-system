# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 9 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 9. agentsview session push"
check "agentsview telemetry and update check are off" in_image '
  [ "$AGENTSVIEW_TELEMETRY_ENABLED" = 0 ] && [ "$AGENTSVIEW_DISABLE_UPDATE_CHECK" = 1 ]'
check "with no URL (no secret file, no AGENTSVIEW_PG_URL), dev-init starts no push and dev-doctor warns how to turn it on" in_image '
  out=$(dev-init 2>&1; dev-doctor --warn-only); echo "$out"
  ! pgrep -x agentsview-push >/dev/null &&
  [ ! -e /persist/agentsview/config.toml ] &&
  echo "$out" | grep -q "WARN agentsview session push is off: no /run/secrets/dev-system/agentsview-pg-url and no AGENTSVIEW_PG_URL" &&
  echo "$out" | grep -q "fix: put the PostgreSQL URL in /run/secrets/dev-system/agentsview-pg-url once per Docker host or cluster" &&
  ! echo "$out" | grep -q "FAIL agentsview"'
unreadable=$(docker volume create --label "$RUN_ID")
put_secret "$unreadable" "postgres://av:$SECRET@nowhere.invalid/agentsview"
docker run --rm --user root --entrypoint "" -v "$unreadable:/run/secrets/dev-system" "$IMAGE" \
  chown 0:0 /run/secrets/dev-system/agentsview-pg-url
check "an unreadable secret file: dev-init warns, starts no push, and dev-doctor fails with the fix" bash -c "
  out=\$(docker run --rm --entrypoint '' -v '$unreadable:/run/secrets/dev-system:ro' '$IMAGE' bash -c 'dev-init; pgrep -x agentsview-push && echo PUSHING; dev-doctor --warn-only' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'dev-init: WARNING: /run/secrets/dev-system/agentsview-pg-url is empty or not readable by node' &&
  echo \"\$out\" | grep -q 'FAIL agentsview session push is off: /run/secrets/dev-system/agentsview-pg-url is empty or not readable by node' &&
  ! echo \"\$out\" | grep -q PUSHING"

# A TLS PostgreSQL (agentsview refuses plaintext to a non-local host) on a
# private network, plus one shared data volume and one shared Claude volume:
# the shape of several containers on one Docker host.
net=$(docker network create --label "$RUN_ID" "$RUN_ID-net")
docker run -d --label "$RUN_ID" --name "$RUN_ID-pg" --network "$net" \
  -e POSTGRES_USER=av -e POSTGRES_PASSWORD="$SECRET" -e POSTGRES_DB=agentsview \
  --entrypoint bash postgres:17 -c '
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pg \
      -keyout /tmp/k.pem -out /tmp/c.pem 2>/dev/null
    chown postgres /tmp/k.pem /tmp/c.pem && chmod 600 /tmp/k.pem
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/c.pem -c ssl_key_file=/tmp/k.pem' >/dev/null
psql_av() {
  docker exec "$RUN_ID-pg" psql -U av -d agentsview -tAc "$1" 2>/dev/null
}
for _ in $(seq 1 60); do
  docker exec "$RUN_ID-pg" pg_isready -U av -d agentsview -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
avdata=$(docker volume create --label "$RUN_ID")
avclaude=$(docker volume create --label "$RUN_ID")
# write_session <volume> <session id>: a minimal Claude Code transcript
write_session() {
  docker run --rm -v "$1:/persist/claude" -e SID="$2" --entrypoint "" "$IMAGE" bash -c '
    mkdir -p /persist/claude/projects/-ws && f=/persist/claude/projects/-ws/$SID.jsonl
    printf "%s\n" \
      "{\"type\":\"user\",\"sessionId\":\"$SID\",\"uuid\":\"$SID-u\",\"parentUuid\":null,\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/ws\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}" \
      "{\"type\":\"assistant\",\"sessionId\":\"$SID\",\"uuid\":\"$SID-a\",\"parentUuid\":\"$SID-u\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"cwd\":\"/ws\",\"message\":{\"role\":\"assistant\",\"model\":\"claude-test\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}" \
      > "$f.tmp" && mv "$f.tmp" "$f"'
}
# wait_for_session <session id>: up to 90s for it to reach PostgreSQL
wait_for_session() {
  for _ in $(seq 1 90); do
    [ "$(psql_av "select count(*) from agentsview.sessions where id like '%$1%'")" -ge 1 ] 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
write_session "$avclaude" 11111111-1111-4111-8111-111111111111
# pusher <name>: a headless container (image ENTRYPOINT, so dev-init runs at
# start) with the push configured
pusher() {
  docker run -d --label "$RUN_ID" --name "$RUN_ID-$1" --network "$net" \
    -e "AGENTSVIEW_PG_URL=postgres://av:$SECRET@$RUN_ID-pg:5432/agentsview?sslmode=require" \
    -e DEV_MACHINE_NAME='test "host"' -e DEV_AGENTSVIEW_RETRY_SECONDS=2 \
    -v "$avdata:/persist/agentsview" -v "$avclaude:/persist/claude" \
    "$IMAGE" sleep infinity >/dev/null
}
pusher a
check "dev-init starts the push and a session reaches PostgreSQL" wait_for_session 11111111-1111-4111-8111-111111111111
check "the machine label comes from DEV_MACHINE_NAME (quotes escaped)" bash -c "
  [ \"\$(docker exec '$RUN_ID-pg' psql -U av -d agentsview -tAc \"select value from agentsview.sync_metadata where key like 'machine_label:%'\")\" = 'test \"host\"' ]"
check "dev-init seeds a non-8080 daemon port and keeps config.toml at 0600" docker exec "$RUN_ID-a" bash -c '
  grep -qx "port = 47180" /persist/agentsview/config.toml &&
  [ "$(stat -c %a /persist/agentsview/config.toml)" = 600 ] &&
  ! grep -q "127.0.0.1:8080" /persist/agentsview/daemon.*.json'
check "dev-doctor reports the database reachable and the push running" docker exec "$RUN_ID-a" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -q "OK   agentsview: central PostgreSQL is reachable" &&
  echo "$out" | grep -q "OK   agentsview session push is running"'
check "a second dev-init in the same container starts no second push loop" docker exec "$RUN_ID-a" bash -c '
  dev-init >/dev/null 2>&1; [ "$(pgrep -xc agentsview-push)" = 1 ]'
pusher b
sleep 6
check "a second container on the same data volume waits on the lock and reports the push running" docker exec "$RUN_ID-b" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"; cat /tmp/dev-agentsview-push.log
  grep -q "already locked" /tmp/dev-agentsview-push.log &&
  echo "$out" | grep -q "OK   agentsview session push is running"'
docker stop -t 10 "$RUN_ID-a" >/dev/null
write_session "$avclaude" 22222222-2222-4222-8222-222222222222
check "the second container takes over when the first stops" wait_for_session 22222222-2222-4222-8222-222222222222
check "both containers pushed as one machine" bash -c "
  [ \"\$(docker exec '$RUN_ID-pg' psql -U av -d agentsview -tAc 'select count(distinct machine) from agentsview.sessions')\" = 1 ]"
# The no-mistakes mirror (#273): a fixture state.sqlite pushed by nm-push-loop
# into the same PostgreSQL (container b is the one still running).
docker cp "$TEST_DIR/nm-fixture.js" "$RUN_ID-b:/tmp/nm-fixture.js" >/dev/null
nm_push() {
  docker exec -e NO_MISTAKES_HOME=/tmp/nmfix -e NM_PUSH_STATE_DIR=/tmp/nmfix/state -e DEV_MACHINE_NAME=nm-host \
    "$RUN_ID-b" /usr/local/share/dev-system/nm-push-loop --once
}
nm_fixture() { docker exec "$RUN_ID-b" node /tmp/nm-fixture.js /tmp/nmfix/state.sqlite "$@"; }
# nm_is <sql> <expected>: the query's single value equals the expected text
nm_is() { [ "$(psql_av "$1")" = "$2" ]; }
nm_mirror_first_pass() {
  docker exec "$RUN_ID-b" mkdir -p /tmp/nmfix && nm_fixture create && nm_push &&
    nm_is "select count(*) from nomistakes.runs where device='nm-host' and repo='acme/widgets'" 2 &&
    nm_is "select count(*) from nomistakes.step_results" 2 &&
    nm_is "select count(*) from nomistakes.step_rounds" 1 &&
    nm_is "select count(*) from nomistakes.agent_invocations" 1 &&
    nm_is "select count(*) from nomistakes.run_agent_sessions" 1 &&
    nm_is "select count(*) from nomistakes.repos" 1 &&
    nm_is "select intent from nomistakes.runs where id='r1'" 'it'"'"'s \ the intent' &&
    nm_is "select count(*) from information_schema.columns where table_schema='nomistakes' and column_name in ('worktree_dir','log_path','agent_pid','working_path','global_config_yaml','repo_config_yaml')" 0 &&
    nm_is "select count(*) from nomistakes.runs where raw is not null" 0
}
nm_mirror_second_pass() {
  nm_fixture status r1 completed && nm_push && nm_push &&
    nm_is "select count(*) from nomistakes.runs" 2 &&
    nm_is "select count(*) from nomistakes.step_results" 2 &&
    nm_is "select status from nomistakes.runs where id='r1'" completed
}
nm_mirror_unknown_column() {
  nm_fixture unknown-column && nm_push &&
    nm_is "select raw->>'brand_new' from nomistakes.runs where id='r1'" surprise
}
check "nm-push-loop mirrors every table with device and repo, and ships no excluded column" nm_mirror_first_pass
check "a second pass leaves counts unchanged and picks up a status change" nm_mirror_second_pass
check "an unknown column lands in raw and the pass still succeeds" nm_mirror_unknown_column
check "dev-doctor reports the no-mistakes push" docker exec -e NM_PUSH_STATE_DIR=/tmp/nmfix/state -e NO_MISTAKES_HOME=/tmp/nmfix -e DEV_MACHINE_NAME=nm-host "$RUN_ID-b" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -q "INFO no-mistakes push: [1-9][0-9]* rows pushed (last pushed 20" &&
  echo "$out" | grep -q "waiting: no"'
# The saved queries in docs/metrics.md (#275): every sql block of the nomistakes section runs
# against this PostgreSQL, filled through the real nm-push-loop path plus a factory.events
# table seeded for run r3. Each query must return a row, and headline values are exact.
psql_file() { docker exec -i "$RUN_ID-pg" psql -U av -d agentsview -v ON_ERROR_STOP=1 -qtA; }
nm_metrics_queries() {
  local root out ddl f
  root=$(cd "$TEST_DIR/../../.." && pwd)
  out=$(mktemp -d)
  node "$root/tests/metrics-blocks.js" "$root/docs/metrics.md" "$out" || return 1
  nm_fixture metrics && nm_push || return 1
  # factory.events as event-push-loop creates it (its DDL is read from the script), then the
  # orchestrator events for issue 42: claimed 300 s before run r3 was created, merged 120 s after it ended.
  ddl=$(awk "/<<'SQL'\$/ { f = 1; next } f && /^SQL\$/ { exit } f" "$root/images/base/event-push-loop")
  printf '%s\n' "$ddl" | psql_file >/dev/null || return 1
  psql_file >/dev/null <<'SQL' || return 1
INSERT INTO factory.events (device, repo, seq, ts, state, issue, run_id, raw) VALUES
  ('nm-metrics', 'acme/widgets', 1, to_timestamp(1700000700), 'claimed', 42, NULL, '{}'),
  ('nm-metrics', 'acme/widgets', 2, to_timestamp(1700001010), 'run_started', 42, 'r3', '{}'),
  ('nm-metrics', 'acme/widgets', 3, to_timestamp(1700001720), 'merged', 42, NULL, '{}')
ON CONFLICT DO NOTHING;
-- Issues for the run-to-issue link (#343), modelled on merged issues with no run_started event.
-- The runs are in nm-fixture.js (r5 to r11); times are epoch seconds.
--   51  one run on feat/issue-51-no-event, no run_started event
--   52  repo spelled 'Acme/Widgets' (factory.events is not lowercased); first run cancelled
--   53  a run_started event 20 s after the run was created: the mirror time wins
--   54  run on an off-convention branch, linked only by a legacy run_started event
INSERT INTO factory.events (device, repo, seq, ts, state, issue, run_id, raw)
SELECT 'nm-metrics', v.repo, v.seq, to_timestamp(v.t), v.state, v.issue, v.run_id, '{}'::jsonb
FROM (VALUES
  ('acme/widgets', 10, 1700010000, 'ready', 51, NULL), ('acme/widgets', 11, 1700010060, 'claimed', 51, NULL),
  ('acme/widgets', 12, 1700010360, 'delegated', 51, NULL), ('acme/widgets', 13, 1700011260, 'merge_ready', 51, NULL),
  ('acme/widgets', 14, 1700012460, 'merged', 51, NULL),
  ('Acme/Widgets', 1, 1700020000, 'ready', 52, NULL), ('Acme/Widgets', 2, 1700020060, 'claimed', 52, NULL),
  ('Acme/Widgets', 3, 1700020360, 'delegated', 52, NULL), ('Acme/Widgets', 4, 1700021660, 'merge_ready', 52, NULL),
  ('Acme/Widgets', 5, 1700021960, 'merged', 52, NULL),
  ('acme/widgets', 20, 1700030000, 'ready', 53, NULL), ('acme/widgets', 21, 1700030060, 'claimed', 53, NULL),
  ('acme/widgets', 22, 1700030360, 'delegated', 53, NULL), ('acme/widgets', 23, 1700030680, 'run_started', 53, 'r8'),
  ('acme/widgets', 24, 1700031260, 'merge_ready', 53, NULL), ('acme/widgets', 25, 1700031560, 'merged', 53, NULL),
  ('acme/widgets', 30, 1700040000, 'ready', 54, NULL), ('acme/widgets', 31, 1700040060, 'claimed', 54, NULL),
  ('acme/widgets', 32, 1700040360, 'delegated', 54, NULL), ('acme/widgets', 33, 1700040670, 'run_started', 54, 'r9'),
  ('acme/widgets', 34, 1700041460, 'merge_ready', 54, NULL), ('acme/widgets', 35, 1700041560, 'merged', 54, NULL)
) AS v(repo, seq, t, state, issue, run_id)
ON CONFLICT DO NOTHING;
SQL
  # 00 is the DDL block, 01 the example join, 02..08 the seven queries, 09 "Unlinked runs", then
  # 10 and 11: lead time by stage and the waiting split, which live outside the nomistakes section.
  [ "$(find "$out" -name '*.sql' | wc -l)" -eq 12 ] || { echo "expected 12 sql blocks"; return 1; }
  for f in "$out"/*.sql; do
    psql_file < "$f" > "${f%.sql}.out" || { echo "$(basename "$f") failed"; cat "$f"; return 1; }
    if [ "$(basename "$f")" != 00.sql ] && [ ! -s "${f%.sql}.out" ]; then echo "$(basename "$f") returned no rows"; return 1; fi
  done
  grep -Fx 'review|acme/widgets|nm-host|3|2|0.667' "$out/02.out" &&
    grep -Fx 'test|2|3|2' "$out/03.out" &&
    grep -Fx 'review|acme/widgets|nm-host|4|6|1.50|6|2|0.333|1' "$out/04.out" &&
    grep -Fx 'merged_pr|acme/widgets||https://github.com/acme/widgets/pull/7||||4|2500|490|10000|400|140000' "$out/05.out" &&
    grep -Fx 'totals|acme/widgets|nm-host||2|150000|75000|111000|120000|' "$out/06.out" &&
    grep -E '^parked_now\|acme/widgets\|nm-host\|r4\|\|30000\|' "$out/06.out" &&
    grep -Fx 'review-fix|gpt-test|exit|none|1' "$out/07.out" &&
    grep -Fx 'acme/widgets|42|1020|600|120|420|1' "$out/08.out" &&
    nm_link_values "$out"
}
# The run-to-issue link (#343): issues with no run_started event still get their pipeline numbers
# from the mirror. psql prints numeric seconds with six decimals; drop trailing zeros to compare.
nm_link_values() {
  local out=$1
  norm() { sed -E 's/\.0+(\||$)/\1/g' "$1"; }
  # the saved query 7 gains the new issues; issue 52 keeps its mixed-case repo and both its runs
  grep -Fx 'acme/widgets|51|2400|600|0|1800|1' "$out/08.out" &&
    grep -Fx 'Acme/Widgets|52|1900|700|0|1200|2' "$out/08.out" &&
    grep -Fx 'acme/widgets|53|1500|600|0|900|1' "$out/08.out" &&
    grep -Fx 'acme/widgets|54|1500|800|0|700|1' "$out/08.out" &&
    # the example join places a run by branch alone
    grep -E '^acme/widgets\|51\|r5\|completed\|' "$out/01.out" &&
    ! grep -q '|r10|' "$out/01.out" &&
    # unlinked runs: off-convention branches with no event, and a run with no repo; nothing else
    grep -E '^acme/widgets\|nm-host\|r10\|chore/release-0\.9\.0\|completed\|' "$out/09.out" &&
    grep -E '^\|nm-host\|r11\|feat/issue-60-orphan\|completed\|' "$out/09.out" &&
    [ "$(wc -l < "$out/09.out")" -eq 5 ] &&
    ! grep -Eq '\|(r3|r5|r6|r7|r8|r9)\|' "$out/09.out" &&
    # query 1: implementation and pipeline from the mirror; issue 42 has none of the other events
    norm "$out/10.out" | grep -Fx 'acme/widgets|51|00:01:00|00:05:00|00:05:00|00:10:00|00:20:00|00:41:00' &&
    norm "$out/10.out" | grep -Fx 'Acme/Widgets|52|00:01:00|00:05:00|00:05:00|00:16:40|00:05:00|00:32:40' &&
    norm "$out/10.out" | grep -Fx 'acme/widgets|53|00:01:00|00:05:00|00:05:00|00:10:00|00:05:00|00:26:00' &&
    norm "$out/10.out" | grep -Fx 'acme/widgets|54|00:01:00|00:05:00|00:05:00|00:13:20|00:01:40|00:26:00' &&
    norm "$out/10.out" | grep -Fx 'acme/widgets|42||||||' &&
    # query 7: the waiting split on mirror run starts
    norm "$out/11.out" | grep -Fx 'acme/widgets|51|nm-metrics|600|1260|0|600|2460' &&
    norm "$out/11.out" | grep -Fx 'Acme/Widgets|52|nm-metrics|1000|360|0|600|1960' &&
    norm "$out/11.out" | grep -Fx 'acme/widgets|53|nm-metrics|600|360|0|600|1560' &&
    norm "$out/11.out" | grep -Fx 'acme/widgets|54|nm-metrics|800|160|0|600|1560'
}
check "the saved queries in docs/metrics.md run against the mirrored data and return the expected values" nm_metrics_queries
# The fleet-wide export query in docs/metrics.md (#274): run it against the same PostgreSQL, then
# feed the JSON lines to callum-flow-evaluate --nm-export inside the image.
nm_export_query() {
  local root out want
  root=$(cd "$TEST_DIR/../../.." && pwd)
  out=$(mktemp)
  # the heredoc body of the first <<'SQL' block in metrics.md
  awk "/<<'SQL'\$/ { f = 1; next } f && /^SQL\$/ { exit } f" "$root/docs/metrics.md" |
    docker exec -i "$RUN_ID-b" dev-query -At -v since=2000-01-01T00:00:00Z > "$out" || return 1
  [ -s "$out" ] && ! grep -q '"raw"' "$out" || return 1
  node -e '
    const { TABLES } = require(process.argv[1]);
    const seen = new Set(require("fs").readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).table));
    if (!seen.size || [...seen].some((t) => !TABLES[t])) process.exit(1);' "$root/images/base/nm-export" "$out" || return 1
  docker exec -i "$RUN_ID-b" sh -c 'cat > /tmp/nm-export.jsonl' < "$out" || return 1
  want=$(psql_av "select count(*) from nomistakes.runs where repo = 'acme/widgets'")
  docker exec -e NO_MISTAKES_HOME=/tmp/nmfix -e CALLUM_EVENTS_DIR=/tmp/nmfix "$RUN_ID-b" callum-flow-evaluate \
    --repo acme/widgets --since 2000-01-01T00:00:00Z --until 2100-01-01T00:00:00Z --nm-export /tmp/nm-export.jsonl |
    node -e '
      const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const want = Number(process.argv[1]);
      if (r.window.scope.pipeline !== "fleet" || r.pipeline.runs !== want || want < 1) process.exit(1);
      if (!Array.isArray(r.pipeline.gates) || !r.pipeline.by_device.length) process.exit(1);' "$want"
}
check "the export query in docs/metrics.md runs and callum-flow-evaluate reads its output" nm_export_query
# Event identity survives losing the file (#229). The table starts as the old one (primary
# key (device, repo, seq)) with three old-format rows; the real event-push-loop (container b)
# migrates it, then a wiped log (with and without its marker) must still land every event.
ev_run() { docker exec -e CALLUM_EVENTS_DIR=/tmp/evmig "$RUN_ID-b" event-push-loop --once; }
ev_write() { # <count> <tag> [noid]: count lines for device d1, repo o/r
  docker exec -e N="$1" -e TAG="$2" -e NOID="${3-}" -e CALLUM_EVENTS_DIR=/tmp/evmig "$RUN_ID-b" bash -c '
    mkdir -p "$CALLUM_EVENTS_DIR"
    for i in $(seq 1 "$N"); do
      id=""; [ -n "$NOID" ] || id=",\"event_id\":\"$(cat /proc/sys/kernel/random/uuid)\""
      printf "{\"v\":1,\"ts\":\"2026-10-10T10:00:00Z\",\"repo\":\"o/r\",\"device\":\"d1\",\"state\":\"ready\",\"issue\":1,\"note\":\"%s-%s\"%s}\n" "$TAG" "$i" "$id" >> "$CALLUM_EVENTS_DIR/o__r.jsonl"
    done'
}
event_identity() {
  local ddl root
  root=$(cd "$TEST_DIR/../../.." && pwd)
  ddl=$(awk "/<<'SQL'\$/ { f = 1; next } f && /^SQL\$/ { exit } f" "$root/images/base/event-push-loop")
  docker exec "$RUN_ID-b" rm -rf /tmp/evmig
  psql_file >/dev/null <<'SQL' || return 1
DROP TABLE IF EXISTS factory.events;
CREATE SCHEMA IF NOT EXISTS factory;
CREATE TABLE factory.events (
  device text NOT NULL, repo text NOT NULL, seq bigint NOT NULL, ts timestamptz NOT NULL,
  state text NOT NULL, issue integer, run_id text, branch text, pr integer, head text, note text,
  session_id text, actor text, v integer, raw jsonb NOT NULL,
  PRIMARY KEY (device, repo, seq)
);
SQL
  ev_write 3 old noid && ev_run || return 1
  [ "$(psql_av "select count(*) from factory.events where event_id is null")" = 3 ] || { echo "old rows lost"; return 1; }
  [ "$(psql_av "select count(*) from pg_constraint where conrelid = 'factory.events'::regclass and contype = 'p'")" = 0 ] || { echo "primary key still there"; return 1; }
  ev_write 3 new && ev_run || return 1
  [ "$(psql_av "select count(*) from factory.events")" = 6 ] || { echo "want 6 rows"; return 1; }
  # wipe the file and its marker, write 3 more: they reuse seq 1-3
  docker exec "$RUN_ID-b" rm -rf /tmp/evmig
  ev_write 3 wiped && ev_run || return 1
  [ "$(psql_av "select count(*) from factory.events")" = 9 ] || { echo "want 9 rows after the wipe"; return 1; }
  [ "$(psql_av "select count(*) from factory.events where note like 'wiped-%' and seq between 1 and 3")" = 3 ] || { echo "post-wipe rows missing"; return 1; }
  # replace the file but keep a marker larger than it
  docker exec "$RUN_ID-b" bash -c 'echo 5 > /tmp/evmig/.pushed/o__r.jsonl; rm /tmp/evmig/o__r.jsonl'
  ev_write 2 kept && ev_run || return 1
  [ "$(psql_av "select count(*) from factory.events where note like 'kept-%'")" = 2 ] || { echo "kept-marker rows missing"; return 1; }
  # a repeat adds nothing, and the DDL runs again cleanly
  ev_run || return 1
  [ "$(psql_av "select count(*) from factory.events")" = 11 ] || { echo "repeat pushed duplicates"; return 1; }
  printf '%s\n%s\n' "$ddl" "$ddl" | psql_file >/dev/null
}
check "factory.events migrates in place and keeps every event after the log file is wiped or replaced" event_identity
# dev-query (#292): container b has AGENTSVIEW_PG_URL.
dev_query_readonly() {
  local before after err
  before=$(psql_av "select count(*) from factory.events")
  [ -n "$before" ] || return 1
  case $(docker exec -i "$RUN_ID-b" dev-query -At -c 'select count(*) from factory.events') in
    '' | *[!0-9]*) return 1 ;;
  esac
  err=$(docker exec -i "$RUN_ID-b" dev-query -c "insert into factory.events (device, repo, seq, ts, state, raw) values ('x', 'x', 1, now(), 'ready', '{}')" 2>&1) && return 1
  case $err in *'read-only transaction'*) ;; *) return 1 ;; esac
  case $err in *"$SECRET"*) return 1 ;; esac
  after=$(psql_av "select count(*) from factory.events")
  [ "$before" = "$after" ]
}
check "dev-query returns a count and rejects a write as read-only without leaking the password" dev_query_readonly
check "dev-doctor fails with a hint when the database is unreachable" bash -c "
  out=\$(docker run --rm --entrypoint '' -e AGENTSVIEW_PG_URL='postgres://av:$SECRET@no-such-host.invalid:5432/agentsview?sslmode=require' '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'FAIL agentsview cannot reach the central PostgreSQL (URL from AGENTSVIEW_PG_URL' &&
  echo \"\$out\" | grep -q 'FAIL agentsview session push is not running' &&
  ! echo \"\$out\" | grep -qF '$SECRET'"
check "mask_secrets hides URL and keyword passwords" in_image '
  . /usr/local/share/dev-system/agentsview.sh
  [ "$(echo "dial postgres://av:p4ss@h:5432/db?sslmode=require failed" | mask_secrets)" = "dial postgres://***@h:5432/db?sslmode=require failed" ] &&
  [ "$(echo "host=h password=p4ss user=av" | mask_secrets)" = "host=h password=*** user=av" ]' --entrypoint ""

# The secret file, as every runtime delivers it (#103): a volume (Docker) or
# directory (Coder) mounted read-only at /run/secrets/dev-system, here a named
# volume written with the README's command. A container that starts before
# the secret is there is off; once it arrives, dev-init (or a restart) starts
# the push, with the URL in no env, log, argument list or docker inspect.
secrets=$(docker volume create --label "$RUN_ID")
fdata=$(docker volume create --label "$RUN_ID")
fclaude=$(docker volume create --label "$RUN_ID")
write_session "$fclaude" 33333333-3333-4333-8333-333333333333
docker run -d --label "$RUN_ID" --name "$RUN_ID-f" --network "$net" \
  -e DEV_MACHINE_NAME=file-host -e DEV_AGENTSVIEW_RETRY_SECONDS=2 \
  -v "$secrets:/run/secrets/dev-system:ro" -v "$fdata:/persist/agentsview" -v "$fclaude:/persist/claude" \
  "$IMAGE" sleep infinity >/dev/null
sleep 3
check "before the secret arrives: no push, and dev-doctor warns that it is off" docker exec "$RUN_ID-f" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  ! pgrep -x agentsview-push >/dev/null &&
  echo "$out" | grep -q "WARN agentsview session push is off"'
put_secret "$secrets" "postgres://av:$SECRET@$RUN_ID-pg:5432/agentsview?sslmode=require"
docker exec "$RUN_ID-f" dev-init >/dev/null 2>&1
check "once the secret file arrives, dev-init starts the push and a session reaches PostgreSQL" wait_for_session 33333333-3333-4333-8333-333333333333
check "dev-doctor reports the database reachable (URL from the file) and the push running" docker exec "$RUN_ID-f" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -q "OK   agentsview: central PostgreSQL is reachable (URL from /run/secrets/dev-system/agentsview-pg-url" &&
  echo "$out" | grep -q "OK   agentsview session push is running"'
check "the file's URL is not in the container's env, logs, process arguments, dev-doctor or docker inspect" bash -c "
  ! docker inspect '$RUN_ID-f' | grep -qF '$SECRET' &&
  ! docker logs '$RUN_ID-f' 2>&1 | grep -qF '$SECRET' &&
  ! docker exec '$RUN_ID-f' bash -c 'env; ps -eo args; dev-doctor --warn-only; cat /tmp/*.log /persist/agentsview/*.log 2>/dev/null' | grep -qF '$SECRET'"
check "AGENTSVIEW_PG_URL overrides the file" bash -c "
  out=\$(docker run --rm --entrypoint '' -e AGENTSVIEW_PG_URL='postgres://av:x@no-such-host.invalid/agentsview' -v '$secrets:/run/secrets/dev-system:ro' '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'cannot reach the central PostgreSQL (URL from AGENTSVIEW_PG_URL'"
