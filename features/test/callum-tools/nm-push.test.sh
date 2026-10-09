#!/bin/sh
#
# Plain-shell tests for images/base/nm-push-loop (cbundy/dev-system#273) with a
# stub psql and a fixture state.sqlite. Hermetic PATH, no network, no Docker.
# The real-Postgres cases live in images/base/test/sections/09-agentsview.sh.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
PUSH="$ROOT/images/base/nm-push-loop"
FIXTURE="$ROOT/images/base/test/nm-fixture.js"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
loop_pid=''
trap '[ -z "$loop_pid" ] || kill "$loop_pid" 2>/dev/null; rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
fakebin="$tmpdir/bin"
mkdir -p "$toolbin" "$fakebin"
for t in jq sed tr cat mkdir mv dirname basename date sort cut head tail wc awk grep sleep rm touch chmod mktemp node hostname; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
BASH=$(command -v bash)

cat > "$fakebin/psql" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
echo x >> "$d/psql-calls"
printf '%s\n' "$*" > "$d/psql-args"
{ echo "PGPASSWORD=${PGPASSWORD-}"; echo "PGUSER=${PGUSER-}"; echo "PGHOST=${PGHOST-}"; echo "PGDATABASE=${PGDATABASE-}"; } > "$d/psql-env"
cat > "$d/psql-sql-$(wc -l < "$d/psql-calls" | tr -d ' ')"
if [ -e "$d/psql-fail" ]; then
  echo "psql: error: connection to postgres://app:s3cret@db/x failed password=s3cret" >&2
  exit 2
fi
STUB
chmod +x "$fakebin/psql"
calls() { if [ -f "$fakebin/psql-calls" ]; then wc -l < "$fakebin/psql-calls" | tr -d ' '; else echo 0; fi; }

nmhome="$tmpdir/nm"
state="$tmpdir/state"
checkpoint="$state/device-6465762d626f78/state"
mkdir -p "$nmhome"
node "$FIXTURE" "$nmhome/state.sqlite" create
push() {
  PATH="$fakebin:$toolbin" NO_MISTAKES_HOME="$nmhome" NM_PUSH_STATE_DIR="$state" DEV_SYSTEM_SHARE="$ROOT/images/base" \
    DEV_SECRETS_DIR="$tmpdir/no-secrets" DEV_MACHINE_NAME="${PUSH_DEVICE-dev-box}" AGENTSVIEW_PG_URL="${PUSH_URL-postgres://app:s3cret@db/x}" HOME="$tmpdir" "$BASH" "$PUSH" --once
}

# no state.sqlite: no-op, exit 0, no psql
rm "$nmhome/state.sqlite"
push || fail "a missing state.sqlite should exit 0"
[ "$(calls)" = 0 ] || fail "a missing state.sqlite must not call psql"
PUSH_URL='' push > "$tmpdir/out" 2>&1 || fail "missing database and URL should exit 0"
grep -q 'stopping' "$tmpdir/out" || fail "missing database must not skip URL lookup"
mkdir -p "$tmpdir/secrets"
printf '%s\n' 'postgres://app:s3cret@db/x' > "$tmpdir/secrets/agentsview-pg-url"
cat > "$fakebin/sleep" <<'STUB'
#!/bin/sh
touch "$NM_TEST_SLEEP_MARKER"
exec "$NM_TEST_SLEEP" 0.05
STUB
chmod +x "$fakebin/sleep"
PATH="$fakebin:$toolbin" NO_MISTAKES_HOME="$nmhome" NM_PUSH_STATE_DIR="$state" DEV_SYSTEM_SHARE="$ROOT/images/base" \
  DEV_SECRETS_DIR="$tmpdir/secrets" DEV_MACHINE_NAME=dev-box AGENTSVIEW_PG_URL='' \
  NM_TEST_SLEEP_MARKER="$tmpdir/sleeping" NM_TEST_SLEEP="$toolbin/sleep" \
  "$BASH" "$PUSH" > "$tmpdir/loop-out" 2>&1 &
loop_pid=$!
i=0
while [ ! -e "$tmpdir/sleeping" ]; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "loop never reached its delay with missing database"
  sleep 0.05
done
rm "$tmpdir/secrets/agentsview-pg-url"
i=0
while kill -0 "$loop_pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "loop did not stop after URL removal with missing database"
  sleep 0.05
done
wait "$loop_pid" || fail "loop should exit 0 after URL removal"
loop_pid=''
rm "$fakebin/sleep"
grep -q 'stopping' "$tmpdir/loop-out" || fail "loop did not re-read the URL"
[ "$(calls)" = 0 ] || fail "missing database and URL must not call psql"
node "$FIXTURE" "$nmhome/state.sqlite" create

# no URL: exit 0, no psql
PUSH_URL='' push 2>/dev/null || fail "no URL should exit 0"
[ "$(calls)" = 0 ] || fail "no URL must not call psql"

# a failed psql leaves the mark unchanged and masks the secret
touch "$fakebin/psql-fail"
if push > "$tmpdir/out" 2>&1; then fail "a failed push should exit non-zero"; fi
grep -q 'retrying next pass' "$tmpdir/out" || fail "retry message missing: $(cat "$tmpdir/out")"
if grep -q 's3cret' "$tmpdir/out"; then fail "secret leaked: $(cat "$tmpdir/out")"; fi
[ ! -e "$checkpoint" ] || fail "the mark must not advance on failure"

# success: PG* environment, no secret in argv, rows and DDL, state written
rm "$fakebin/psql-fail"
push > "$tmpdir/out" 2>&1 || fail "push should succeed: $(cat "$tmpdir/out")"
if grep -q 's3cret\|postgres:' "$fakebin/psql-args"; then fail "the URL reached psql's argv"; fi
grep -qx 'PGPASSWORD=s3cret' "$fakebin/psql-env" || fail "psql should get the password in its environment"
grep -qx 'PGHOST=db' "$fakebin/psql-env" || fail "psql should get the host"
sql="$fakebin/psql-sql-$(calls)"
grep -q 'CREATE TABLE IF NOT EXISTS nomistakes.runs' "$sql" || fail "DDL missing"
[ "$(grep -c '^INSERT INTO nomistakes.runs ' "$sql")" = 2 ] || fail "both runs expected on the backfill"
grep -q "'dev-box'" "$sql" || fail "device missing"
if grep -q 'secret/' "$sql"; then fail "an excluded column was shipped"; fi
grep -qx 'mark=1700000200' "$checkpoint" || fail "mark should be written: $(cat "$checkpoint")"
grep -qx 'total_rows=8' "$checkpoint" || fail "row total should be written: $(cat "$checkpoint")"
[ ! -e "$checkpoint.tmp" ] || fail "temp state file left behind"

# the next pass sends only the running run (r2 is terminal and untouched), the whole of it
before=$(calls)
push > "$tmpdir/out" 2>&1 || fail "second push should succeed"
sql="$fakebin/psql-sql-$(calls)"
[ "$(calls)" = $((before + 1)) ] || fail "second pass should call psql once"
[ "$(grep -c '^INSERT INTO nomistakes.runs ' "$sql")" = 1 ] || fail "only the live run expected"
grep -q "INSERT INTO nomistakes.step_results .*'s1'" "$sql" || fail "children of the touched run expected"
if grep -q "'r2'" "$sql"; then fail "an untouched terminal run was re-sent"; fi

first_state=$(cat "$checkpoint")
nmhome="$tmpdir/nm-other"
mkdir -p "$nmhome"
node "$FIXTURE" "$nmhome/state.sqlite" create
node - "$nmhome/state.sqlite" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec(`UPDATE runs SET status = 'completed', updated_at = 100;
  UPDATE step_results SET started_at = 100, completed_at = 100, last_activity_at = 100;
  UPDATE step_rounds SET created_at = 100;
  UPDATE agent_invocations SET completed_at = 100;
  UPDATE run_agent_sessions SET updated_at = 100;`);
db.close();
JS
PUSH_DEVICE=dev-other push > "$tmpdir/out" 2>&1 || fail "second device push should succeed"
sql="$fakebin/psql-sql-$(calls)"
[ "$(grep -c '^INSERT INTO nomistakes.runs ' "$sql")" = 2 ] || fail "second device must backfill older terminal runs"
grep -q "'dev-other'" "$sql" || fail "second device attribution missing"
grep -qx 'mark=100' "$state/device-6465762d6f74686572/state" || fail "second device must keep its own mark"
[ "$(cat "$checkpoint")" = "$first_state" ] || fail "second device changed the first device checkpoint"

echo "nm-push tests passed"
