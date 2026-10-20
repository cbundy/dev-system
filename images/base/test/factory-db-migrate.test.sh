#!/bin/bash
# shellcheck disable=SC2016,SC2015,SC2030,SC2031 # literal $ in stubs; A && B || fail is the test idiom; call runs in a subshell on purpose
#
# Plain-shell test for factory-db-migrate and its place in dev-init (cbundy/dev-system#888):
# which secret it uses, that the bootstrap runs exactly once with the right arguments, the status
# file for each outcome, the loop_entry record (written by the real callum-flow-event against the
# generated shapes), the no-file and no-database cases, and dev-init's step order.
# factory-db-bootstrap is a stub on PATH that records its argv. No database or network.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

for name in $(env | sed -n 's/^\(DEV_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset FACTORY_DB_WRITER_URL FACTORY_DB_READER_URL CALLUM_EVENTS_DIR CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"
share="$tmp/share"
migrations="$tmp/migrations"
mkdir "$bin" "$share" "$migrations"
cp "$BASE/agentsview.sh" "$BASE/factory-db.sh" "$share/"
for n in 0001_a 0002_b 0003_c; do : > "$migrations/$n.sql"; done
cp "$BASE/factory-db-migrate" "$bin/"
cp "$BASE/callum-flow-event" "$bin/"
cp "$BASE/factory-event-write.js" "$BASE/factory-event-shapes.json" "$share/"

# The stub bootstrap: records its argv, then acts as STUB_MODE says.
cat > "$bin/factory-db-bootstrap" <<'STUB'
#!/bin/sh
echo "$*" >> "$FIX/bootstrap.calls"
cp "$DEV_FACTORY_DB_MIGRATE_STATUS" "$FIX/during.json"
case "${STUB_MODE:-ok}" in
  ok) echo "factory-db-bootstrap: database $2 migrated as ${2}_migrator from schema version ${STUB_FROM:-1} to 3" ;;
  error) echo "factory-db-bootstrap: applying migrations failed: boom" >&2; exit 1 ;;
  timeout) exit 124 ;;
esac
STUB
chmod +x "$bin/factory-db-bootstrap"

# run_case: a fresh $FIX with a workspace folder, a migrator folder and an events folder; sets
# $out and $rc. The caller makes the files and sets STUB_*.
run_case() {
  FIX=$(mktemp -d "$tmp/case.XXXXXX")
  export FIX
  mkdir "$FIX/ws" "$FIX/mig" "$FIX/ev"
  : > "$FIX/bootstrap.calls"
  status="$FIX/status.json"
}
call() {
  rc=0
  out=$(
    export PATH="${EXTRA_PATH:+$EXTRA_PATH:}$bin:$PATH" DEV_SYSTEM_SHARE="$share" FACTORY_DB_MIGRATIONS_DIR="$migrations" \
      DEV_WORKSPACE_SECRETS_DIR="$FIX/ws" DEV_MIGRATOR_SECRETS_DIR="$FIX/mig" DEV_SECRETS_DIR="$FIX/shared" \
      DEV_FACTORY_DB_MIGRATE_STATUS="$status" CALLUM_EVENTS_DIR="$FIX/ev" \
      CALLUM_EVENT_SHAPES="$share/factory-event-shapes.json" DEV_REPO_URL=https://github.com/o/r.git
    factory-db-migrate "$@" 2>&1
  ) || rc=$?
}
writer_url() {
  mkdir -p "$FIX/shared"
  printf '%s\n' "$1" > "$FIX/shared/factory-db-writer-url"
}
jq_status() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=s[process.argv[2]]; console.log(v===null?"null":String(v))' "$status" "$1"; }
calls() { wc -l < "$FIX/bootstrap.calls" | tr -d ' '; }
event_file() { echo "$FIX/ev/factory/o__r.jsonl"; }
ev() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n"); if(l.length!==1){console.error("events: "+l.length);process.exit(1)} const d=JSON.parse(l[0]); const x=d.data[process.argv[2]]; console.log(x===null?"null":String(x))' "$(event_file)" "$1"; }

# 1. The template's file: the bootstrap runs once with the writer's database, the status says
# migrated, the line is printed.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main?sslmode=require'
echo 'postgres://fdb_migrator:pw@db:5432/postgres' > "$FIX/mig/factory-db-migrator-url"
STUB_FROM=1 call
[ "$rc" -eq 0 ] || fail "1: rc $rc: $out"
[ "$(calls)" -eq 1 ] || fail "1: bootstrap ran $(calls) times"
[ "$(cat "$FIX/bootstrap.calls")" = "--db fdb_main --migrate --migrator-url-file $FIX/mig/factory-db-migrator-url" ] || fail "1: argv: $(cat "$FIX/bootstrap.calls")"
case "$out" in factory-db-migrate:*fdb_main*) ;; *) fail "1: no log line: $out" ;; esac
[ "$(jq_status outcome)" = migrated ] || fail "1: status: $(cat "$status")"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.outcome!=="running"||!/^\d{4}-\d\d-\d\dT/.test(s.at))process.exit(1)' "$FIX/during.json" || fail "1: status during the run: $(cat "$FIX/during.json")"
[ "$(jq_status from_version)" = 1 ] && [ "$(jq_status to_version)" = 3 ] && [ "$(jq_status database)" = fdb_main ] || fail "1: versions: $(cat "$status")"
[ "$(jq_status error)" = null ] || fail "1: error: $(cat "$status")"
for k in at started_at ended_at duration_ms; do [ "$(jq_status $k)" != undefined ] || fail "1: no $k"; done
case "$out$(cat "$status")" in *pw*) fail "1: a password leaked" ;; esac

# 1b. The database from the path when the URL has no dbname parameter, and "current" when from equals to.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_path'
echo x > "$FIX/mig/factory-db-migrator-url"
STUB_FROM=3 call
[ "$(cat "$FIX/bootstrap.calls")" = "--db fdb_path --migrate --migrator-url-file $FIX/mig/factory-db-migrator-url" ] || fail "1b: argv: $(cat "$FIX/bootstrap.calls")"
[ "$(jq_status outcome)" = current ] || fail "1b: status: $(cat "$status")"
# The dbname parameter wins over the path.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/other?sslmode=require&dbname=fdb_param'
echo x > "$FIX/mig/factory-db-migrator-url"
call
grep -q '^--db fdb_param ' "$FIX/bootstrap.calls" || fail "1c: dbname parameter ignored: $(cat "$FIX/bootstrap.calls")"

# 2. No file: nothing runs, no event, no output, an old status file is removed.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo '{"outcome":"failed"}' > "$status"
call
[ "$rc" -eq 0 ] && [ -z "$out" ] || fail "2: rc $rc, output: $out"
[ "$(calls)" -eq 0 ] || fail "2: bootstrap ran"
[ ! -e "$status" ] || fail "2: old status file kept"
[ ! -e "$(event_file)" ] || fail "2: an event was written"

# 3. Both folders hold a file: the workspace's wins.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo a > "$FIX/mig/factory-db-migrator-url"
echo b > "$FIX/ws/factory-db-migrator-url"
call
[ "$(cat "$FIX/bootstrap.calls")" = "--db fdb_main --migrate --migrator-url-file $FIX/ws/factory-db-migrator-url" ] || fail "3: argv: $(cat "$FIX/bootstrap.calls")"
# Only the workspace folder holds one.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo b > "$FIX/ws/factory-db-migrator-url"
call
[ "$(calls)" -eq 1 ] || fail "3b: workspace-only file not used"

# 4. The bootstrap fails: status failed with its last error line, exit 0; with --strict, exit 1.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo x > "$FIX/mig/factory-db-migrator-url"
STUB_MODE=error call
[ "$rc" -eq 0 ] || fail "4: rc $rc"
[ "$(jq_status outcome)" = failed ] || fail "4: status: $(cat "$status")"
[ "$(jq_status error)" = "factory-db-bootstrap: applying migrations failed: boom" ] || fail "4: error: $(cat "$status")"
[ "$(jq_status from_version)" = null ] || fail "4: from: $(cat "$status")"
case "$out" in *"factory-db-migrate: failed:"*boom*) ;; *) fail "4: no error line: $out" ;; esac
STUB_MODE=error call --strict
[ "$rc" -eq 1 ] || fail "4: --strict rc $rc"
# Exit 124 is timed-out.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo x > "$FIX/mig/factory-db-migrator-url"
STUB_MODE=timeout call
[ "$rc" -eq 0 ] && [ "$(jq_status outcome)" = timed-out ] || fail "4b: rc $rc status: $(cat "$status")"
# A long error is cut to 300 characters.
long=$(printf 'x%.0s' $(seq 1 500))
sed -i "s|boom|$long|" "$bin/factory-db-bootstrap"
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo x > "$FIX/mig/factory-db-migrator-url"
STUB_MODE=error call
[ "$(jq_status error | wc -c | tr -d ' ')" -eq 301 ] || fail "4c: error length: $(jq_status error | wc -c)"

# 5. The record, written by the real callum-flow-event against the generated shapes.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo x > "$FIX/mig/factory-db-migrator-url"
STUB_FROM=1 call
[ -s "$(event_file)" ] || fail "5: no event: $out"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim());
if(d.type!=="loop_entry")process.exit(1);' "$(event_file)" || fail "5: wrong type"
[ "$(ev key)" = task:migrate:3 ] && [ "$(ev kind)" = task ] && [ "$(ev status)" = "done" ] && [ "$(ev wake)" = migrate ] \
  && [ "$(ev class)" = free ] && [ "$(ev rule)" = dev-init ] && [ "$(ev attempts)" = 1 ] || fail "5: fields: $(cat "$(event_file)")"
[ "$(ev from_version)" = 1 ] && [ "$(ev to_version)" = 3 ] && [ "$(ev database)" = fdb_main ] && [ "$(ev outcome)" = migrated ] && [ "$(ev error)" = null ] || fail "5: migrate fields: $(cat "$(event_file)")"
[ "$(ev agent_id)" = dev-init ] || fail "5: agent_id: $(ev agent_id)"
# agent_id from DEV_MACHINE_NAME, status failed / timed-out on those outcomes.
export DEV_MACHINE_NAME=m1
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo x > "$FIX/mig/factory-db-migrator-url"
STUB_MODE=timeout call
[ "$(ev agent_id)" = m1 ] && [ "$(ev status)" = timed-out ] && [ "$(ev outcome)" = timed-out ] || fail "5b: $(cat "$(event_file)")"
STUB_MODE=error call
[ "$(wc -l < "$(event_file)" | tr -d ' ')" -eq 2 ] && tail -n 1 "$(event_file)" | grep -q '"status":"failed"' || fail "5c: $(cat "$(event_file)")"
unset DEV_MACHINE_NAME
# An event write that fails is logged and the command still exits 0 with its status written.
run_case
writer_url 'postgres://fdb_writer:pw@db:5432/fdb_main'
echo x > "$FIX/mig/factory-db-migrator-url"
printf '#!/bin/sh\nexit 1\n' > "$FIX/callum-flow-event"
chmod +x "$FIX/callum-flow-event"
EXTRA_PATH="$FIX" call
[ "$rc" -eq 0 ] && [ "$(jq_status outcome)" = migrated ] || fail "5d: rc $rc: $out"
case "$out" in *"could not write the loop_entry event"*) ;; *) fail "5d: no log line: $out" ;; esac

# 6. A writer URL with no database, or none: the bootstrap is not called and the status says failed.
for url in 'postgres://fdb_writer:pw@db:5432' 'postgres://fdb_writer:pw@db:5432/' ''; do
  run_case
  [ -z "$url" ] || writer_url "$url"
  echo x > "$FIX/mig/factory-db-migrator-url"
  call
  [ "$rc" -eq 0 ] || fail "6: rc $rc"
  [ "$(calls)" -eq 0 ] || fail "6 '$url': bootstrap ran"
  [ "$(jq_status outcome)" = failed ] || fail "6 '$url': status: $(cat "$status")"
  case "$(jq_status error)" in *"no database"*) ;; *) fail "6 '$url': error: $(cat "$status")" ;; esac
done

# 7. dev-init's order: after sync_repo, before the event push, the plugins and dev-doctor.
order=$(sed -n '/^check_persist_dirs$/,$p' "$BASE/dev-init" | grep -E '^(sync_repo|run_factory_db_migrate|start_factory_event_push|install_plugins|dev-doctor )' | sed 's/ .*//' | tr '\n' ' ')
[ "$order" = "sync_repo run_factory_db_migrate start_factory_event_push install_plugins dev-doctor " ] || fail "7: step order: $order"

echo "factory-db-migrate.test.sh: all checks passed"
