#!/bin/sh
#
# Plain-shell unit test for recover-no-mistakes.sh (issue #18).
#
# test.sh's checks require dev-container-features-test-lib and a container
# built with the feature applied (see test-features.yml) - there is no Docker
# in this repo's own dev container, so that harness cannot be exercised here.
# This test is independent of that harness: it runs the recovery script from
# its source location with a fake `no-mistakes` on PATH that records every
# call, and a scratch git repo standing in for the workspace. That makes it
# runnable directly, with no Docker and no container build - both locally
# (`sh features/test/callum-tools/recover-no-mistakes.test.sh`) and in
# test-features.yml, which runs it as a plain step before the containerized
# suite (see that workflow for the wiring).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RECOVER_SH="$SCRIPT_DIR/../../src/callum-tools/recover-no-mistakes.sh"

[ -x "$RECOVER_SH" ] || {
  echo "FAIL: $RECOVER_SH is missing or not executable" >&2
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_line() {
  # $1 = log file, $2 = exact line that must be present
  if ! grep -qx -- "$2" "$1" 2>/dev/null; then
    fail "expected a '$2' call - log was: $(cat "$1" 2>/dev/null || echo '<missing>')"
  fi
}

expect_no_line() {
  # $1 = log file, $2 = exact line that must be absent
  if grep -qx -- "$2" "$1" 2>/dev/null; then
    fail "did not expect a '$2' call - log was: $(cat "$1")"
  fi
}

expect_empty_log() {
  if [ -s "$1" ]; then
    fail "expected no no-mistakes calls at all - log was: $(cat "$1")"
  fi
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

fakebin="$tmpdir/fakebin"
mkdir -p "$fakebin"
cat > "$fakebin/no-mistakes" <<'EOF'
#!/bin/sh
echo "$*" >> "$FAKE_NM_LOG"
if [ "${1:-}" = "status" ]; then
  if [ "${FAKE_NM_REGISTERED:-false}" = "true" ]; then
    echo "    repo:  /fake/repo"
  else
    echo "repo not initialized (run 'no-mistakes init' first)"
  fi
fi
exit 0
EOF
chmod +x "$fakebin/no-mistakes"

g() { git -c user.name=t -c user.email=t@t "$@"; }

new_repo() {
  # $1 = dir, $2 = yaml present (yes/no)
  g init -q "$1"
  if [ "$2" = "yes" ]; then
    echo "commands: {}" > "$1/.no-mistakes.yaml"
  fi
}

run_recover() {
  # $1 = dir to run from, $2 = FAKE_NM_REGISTERED, $3 = log file, $4 = extra PATH prefix (optional)
  : > "$3"
  (
    cd "$1"
    PATH="${4:-$fakebin}:$PATH"
    export PATH
    FAKE_NM_LOG="$3"
    export FAKE_NM_LOG
    FAKE_NM_REGISTERED="$2"
    export FAKE_NM_REGISTERED
    "$RECOVER_SH"
  )
}

# Scenario 1: .no-mistakes.yaml present, repo unregistered -> recovers:
# daemon start then init, in that order (init fails with connection-refused
# if the daemon is not up first).
new_repo "$tmpdir/unreg" yes
run_recover "$tmpdir/unreg" false "$tmpdir/log1"
expect_line "$tmpdir/log1" "status"
expect_line "$tmpdir/log1" "daemon start"
expect_line "$tmpdir/log1" "init"
daemon_line=$(grep -nx "daemon start" "$tmpdir/log1" | cut -d: -f1)
init_line=$(grep -nx "init" "$tmpdir/log1" | cut -d: -f1)
if [ "$daemon_line" -ge "$init_line" ]; then
  fail "expected 'daemon start' (line $daemon_line) before 'init' (line $init_line) - log was: $(cat "$tmpdir/log1")"
fi

# Scenario 2: .no-mistakes.yaml present, repo already registered -> no-op,
# idempotent: no daemon/init calls.
new_repo "$tmpdir/reg" yes
run_recover "$tmpdir/reg" true "$tmpdir/log2"
expect_no_line "$tmpdir/log2" "daemon start"
expect_no_line "$tmpdir/log2" "init"

# Scenario 3: no .no-mistakes.yaml at all -> no-op, no-mistakes never invoked.
new_repo "$tmpdir/noyaml" no
run_recover "$tmpdir/noyaml" false "$tmpdir/log3"
expect_empty_log "$tmpdir/log3"

# Scenario 4: no-mistakes not on PATH (INSTALL_NO_MISTAKES=false, or not yet
# installed) -> safe no-op, exits 0, never breaks setup.sh.
if ! ( cd "$tmpdir/unreg" && PATH="/usr/bin:/bin" "$RECOVER_SH" ); then
  fail "must exit 0 when no-mistakes is not on PATH"
fi

# Scenario 5: cwd is a subdirectory of the repo (e.g. a devcontainer.json
# workspaceFolder pointed below the repo root) -> still resolves the
# enclosing repo and finds its .no-mistakes.yaml.
mkdir -p "$tmpdir/unreg/sub/deeper"
run_recover "$tmpdir/unreg/sub/deeper" false "$tmpdir/log5"
expect_line "$tmpdir/log5" "init"

# Scenario 6: cwd is not inside a git repo at all -> falls back to plain PWD,
# which then naturally has no .no-mistakes.yaml -> no-op, no crash.
mkdir -p "$tmpdir/plainfolder"
run_recover "$tmpdir/plainfolder" false "$tmpdir/log6"
expect_empty_log "$tmpdir/log6"

echo "ok - all no-mistakes auto-recovery scenarios passed"
