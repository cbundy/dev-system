#!/bin/sh
#
# The Coder template writes the worker's final heartbeat on a workspace stop
# (cbundy/dev-system#467). Runs the template's stop script (coder/dev-system/heartbeat-stop.sh)
# against stub heartbeat-loops: it passes --final, is cut off after 10s and always exits 0.
# With terraform on PATH, `terraform test` (template-stop.tftest.hcl, mock providers) checks the
# template wires it up: the script runs on the agent's stop and the container has a 30s stop
# grace. Without terraform that part is skipped - unless TEST_REQUIRE_TERRAFORM=1 (CI).
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
TF_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/../dev-system" && pwd)
HB=/usr/local/share/dev-system/heartbeat-loop

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# The stop script, pointed at $tmpdir/heartbeat-loop instead of the image's.
grep -q "^hb=$HB\$" "$TF_DIR/heartbeat-stop.sh" || fail "heartbeat-stop.sh does not run $HB"
sed "s|^hb=$HB\$|hb=$tmpdir/heartbeat-loop|" "$TF_DIR/heartbeat-stop.sh" > "$tmpdir/stop.sh"

# stub <body>: the heartbeat-loop stub, which records its arguments in $tmpdir/args.
stub() {
  rm -f "$tmpdir/args"
  printf '#!/bin/sh\necho "$*" > "%s/args"\n%s\n' "$tmpdir" "$1" > "$tmpdir/heartbeat-loop"
  chmod 755 "$tmpdir/heartbeat-loop"
}

# Run the stop script; leaves $rc and $took (seconds).
run() {
  start=$(date +%s)
  set +e
  sh "$tmpdir/stop.sh" > "$tmpdir/out" 2>&1
  rc=$?
  set -e
  took=$(($(date +%s) - start))
}

stub 'exit 0'
run
[ "$rc" = 0 ] || fail "a working heartbeat-loop: exit $rc"
[ "$(cat "$tmpdir/args" 2>/dev/null)" = --final ] || fail "heartbeat-loop was not run with exactly --final"

stub 'exit 3'
run
[ "$rc" = 0 ] || fail "a failing heartbeat-loop: exit $rc, want 0"
[ -f "$tmpdir/args" ] || fail "a failing heartbeat-loop was not run"

stub 'exec sleep 100'
run
[ "$rc" = 0 ] || fail "a hanging heartbeat-loop: exit $rc, want 0"
{ [ "$took" -ge 9 ] && [ "$took" -le 13 ]; } || fail "a hanging heartbeat-loop: the stop script took ${took}s, want about 10s"

stub 'exit 0'
chmod 644 "$tmpdir/heartbeat-loop"
run
[ "$rc" = 0 ] || fail "a non-executable heartbeat-loop: exit $rc, want 0"
[ ! -f "$tmpdir/args" ] || fail "a non-executable heartbeat-loop was run"

rm -f "$tmpdir/heartbeat-loop"
run
[ "$rc" = 0 ] || fail "a missing heartbeat-loop: exit $rc, want 0"

if ! command -v terraform >/dev/null 2>&1; then
  [ "${TEST_REQUIRE_TERRAFORM:-0}" != 1 ] || fail "terraform not on PATH, and TEST_REQUIRE_TERRAFORM=1"
  echo "ok: template-stop (terraform test skipped: not on PATH)"
  exit 0
fi

# In a scratch copy, as lint's terraform validate does; init needs the network once for the
# providers, which the plugin cache then keeps.
mkdir "$tmpdir/tf" "$tmpdir/tf/tests"
cp "$TF_DIR"/*.tf "$TF_DIR"/*.sh "$TF_DIR"/.terraform.lock.hcl "$tmpdir/tf"/
cp "$SCRIPT_DIR/template-stop.tftest.hcl" "$tmpdir/tf/tests"/
TF_PLUGIN_CACHE_DIR=${TF_PLUGIN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/terraform/plugin-cache}
export TF_PLUGIN_CACHE_DIR
mkdir -p "$TF_PLUGIN_CACHE_DIR"
terraform -chdir="$tmpdir/tf" init -backend=false -input=false -lockfile=readonly -no-color > "$tmpdir/out" 2>&1 ||
  { cat "$tmpdir/out" >&2; fail "terraform init"; }
terraform -chdir="$tmpdir/tf" test -no-color > "$tmpdir/out" 2>&1 ||
  { cat "$tmpdir/out" >&2; fail "terraform test (template-stop.tftest.hcl)"; }
echo "ok: template-stop"
