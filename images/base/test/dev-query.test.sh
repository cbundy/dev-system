#!/bin/sh
#
# Plain-shell tests for images/base/dev-query (cbundy/dev-system#292) with a stub
# psql and a hermetic PATH. The real-Postgres cases live in
# images/base/test/sections/09-agentsview.sh.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/.."
DQ="$BASE/dev-query"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
fakebin="$tmpdir/bin"
mkdir -p "$toolbin" "$fakebin"
for t in sed tr cat mkdir mv dirname basename rm mktemp env grep; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
BASH=$(command -v bash)

cat > "$fakebin/psql" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
printf '%s\n' "$*" > "$d/psql-args"
{ echo "PGPASSWORD=${PGPASSWORD-}"; echo "PGOPTIONS=${PGOPTIONS-}"; } > "$d/psql-env"
env > "$d/psql-fullenv"
cat > "$d/psql-sql"
if [ -e "$d/psql-fail" ]; then
  echo "psql: error: connection to postgres://app:s3cret@db/x failed password=s3cret" >&2
  exit 2
fi
echo 42
STUB
chmod +x "$fakebin/psql"

secrets="$tmpdir/secrets"
mkdir -p "$secrets"
URL='postgres://app:s3cret@db:5432/av?sslmode=disable&options=-c%20default_transaction_read_only%3Doff'

# run [-nopsql] ARGS...: stdin from /dev/null unless piped by the caller
run() {
  PATH="$toolbin:$fakebin" DEV_SYSTEM_SHARE="$BASE" DEV_SECRETS_DIR="$secrets" \
    "$BASH" "$DQ" "$@" > "$tmpdir/out" 2> "$tmpdir/err" < "${STDIN:-/dev/null}" && rc=0 || rc=$?
}
expect_rc() { [ "$rc" = "$1" ] || fail "$2: exit $rc, want $1 ($(cat "$tmpdir/err"))"; }
expect_err() { grep -q -- "$1" "$tmpdir/err" || fail "$2: stderr lacks '$1': $(cat "$tmpdir/err")"; }

# no URL: 78 naming the file
unset AGENTSVIEW_PG_URL || true
run -c 'select 1'
expect_rc 78 "no url"
expect_err "$secrets/agentsview-pg-url" "no url"

# empty file: 77
: > "$secrets/agentsview-pg-url"
run -c 'select 1'
expect_rc 77 "empty file"
expect_err "$secrets/agentsview-pg-url" "empty file"

# usage errors
printf '%s\n' "$URL" > "$secrets/agentsview-pg-url"
run --bogus; expect_rc 64 "unknown flag"
run -c 'select 1' -x; expect_rc 64 "unknown flag after -c"
run -v 'bad name=1' -c 'select 1'; expect_rc 64 "bad -v"
run -c; expect_rc 64 "-c without sql"
run; expect_rc 64 "no sql (empty stdin)"
printf 'select 2' > "$tmpdir/in"
STDIN="$tmpdir/in" run -c 'select 1'; expect_rc 64 "-c plus stdin"
expect_err 'not both' "-c plus stdin"
unset STDIN
run --help; expect_rc 0 "--help"
grep -q '^Usage: dev-query' "$tmpdir/out" || fail "--help prints usage"

# success via -c: flags before -f -, read-only option last, secrets only in psql's env
run -At -v since=2026-01-01 -c 'select 1'
expect_rc 0 "run -c"
[ "$(cat "$tmpdir/out")" = 42 ] || fail "stdout passthrough"
args=$(cat "$fakebin/psql-args")
case $args in *'-At -v since=2026-01-01 -f -') ;; *) fail "args: $args" ;; esac
case $args in *s3cret* | *postgres://*) fail "url in argv: $args" ;; esac
grep -qx 'PGPASSWORD=s3cret' "$fakebin/psql-env" || fail "password not in psql env"
grep -q '^PGOPTIONS=.*default_transaction_read_only=off.* -c default_transaction_read_only=on$' "$fakebin/psql-env" \
  || fail "read-only must come last: $(cat "$fakebin/psql-env")"
! grep -q 'postgres://' "$fakebin/psql-fullenv" || fail "url left in the environment"
[ "$(cat "$fakebin/psql-sql")" = 'select 1' ] || fail "sql not on stdin"
grep -q s3cret "$tmpdir/out" "$tmpdir/err" && fail "secret in output"

# stdin form, AGENTSVIEW_PG_URL wins, --csv
printf 'select 3\n' > "$tmpdir/in"
STDIN="$tmpdir/in" AGENTSVIEW_PG_URL='postgres://u:other@h/d' run --csv
expect_rc 0 "stdin form"
unset STDIN
[ "$(cat "$fakebin/psql-sql")" = 'select 3' ] || fail "stdin sql"
case $(cat "$fakebin/psql-args") in *--csv*) ;; *) fail "--csv not forwarded" ;; esac

# psql failure: its own status, secret masked on stderr only
: > "$fakebin/psql-fail"
run -c 'select 1'
expect_rc 2 "psql status passthrough"
expect_err 'password=\*\*\*' "masked"
grep -q s3cret "$tmpdir/err" "$tmpdir/out" && fail "secret leaked on failure"
[ ! -s "$tmpdir/out" ] || fail "error text on stdout"
rm "$fakebin/psql-fail"

# psql missing: 69
rm "$fakebin/psql"
run -c 'select 1'
expect_rc 69 "psql missing"
expect_err 'dev-version' "psql missing"

echo "PASS: dev-query"
