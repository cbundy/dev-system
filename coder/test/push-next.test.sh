#!/bin/sh
#
# Plain-shell unit test for coder/dev-system/push-next.sh (cbundy/dev-system#118).
#
# Runs the script against a fake `coder` (CODER_BIN) that records every call's argv and the
# session token it received in its environment, with a scratch template-tester directory. No Coder
# deployment is needed. Kept outside coder/dev-system so it is not pushed with the template.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PUSH_NEXT="$SCRIPT_DIR/../dev-system/push-next.sh"
TOKEN=tok-118-secret-value

[ -x "$PUSH_NEXT" ] || {
  echo "FAIL: $PUSH_NEXT is missing or not executable" >&2
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

cat > "$tmpdir/coder" <<'EOF'
#!/bin/sh
# Fake coder: one argv line per call in $FAKE_DIR/calls, the token it saw in $FAKE_DIR/env.
printf '%s\n' "$*" >> "$FAKE_DIR/calls"
printf '%s\n' "${CODER_SESSION_TOKEN:-<none>} ${CODER_URL:-<none>}" >> "$FAKE_DIR/env"
case "$1" in
  create) printf '%s\n' "$2" > "$FAKE_DIR/created" ;;
  list)
    case "$*" in *json*) ;; *) echo "WORKSPACE STATUS"; exit 0 ;; esac
    if [ -f "$FAKE_DIR/list.json" ]; then
      cat "$FAKE_DIR/list.json"
    else
      name=$(cat "$FAKE_DIR/created" 2>/dev/null || echo none)
      printf '[{"name":"%s","template_name":"dev-system-next","latest_build":{"status":"running","resources":[{"agents":[{"lifecycle_state":"%s"}]}]}}]\n' \
        "$name" "${FAKE_LIFECYCLE:-ready}"
    fi
    ;;
esac
exit 0
EOF
chmod +x "$tmpdir/coder"

# Run the script in a fresh case directory; leaves $case/out, $case/calls, $case/env.
run_case() {
  case=$tmpdir/case$1
  shift
  mkdir -p "$case/secrets"
  printf '%s\n' "$TOKEN" > "$case/secrets/coder-session-token"
  : > "$case/calls"
  : > "$case/env"
  [ -z "${PREP:-}" ] || eval "$PREP"
  set +e
  env -u CODER_AGENT_URL -u CODER_TEMPLATE_NAME \
    CODER_BIN="$tmpdir/coder" FAKE_DIR="$case" DEV_TEMPLATE_TESTER_DIR="$case/secrets" \
    CODER_URL=https://coder.example.test PUSH_NEXT_POLL=0 "$@" > "$case/out" 2>&1
  rc=$?
  set -e
}

expect_call() {
  grep -qx -- "$1" "$case/calls" || fail "expected call '$1' - calls were: $(cat "$case/calls")"
}

expect_rc() {
  case "$1" in
    -eq) [ "$rc" -eq 0 ] ;;
    -ne) [ "$rc" -ne 0 ] ;;
    *) false ;;
  esac || fail "exit status $rc, wanted $1 0 - output: $(cat "$case/out")"
}

# Invariants for every case: the token is in no argv, and every push is dev-system-next.
check_invariants() {
  if grep -q -- "$TOKEN" "$case/calls"; then
    fail "the token appeared in a coder argv: $(cat "$case/calls")"
  fi
  if grep -q -- "$TOKEN" "$case/out"; then
    fail "the token was printed: $(cat "$case/out")"
  fi
  if grep '^templates push' "$case/calls" | grep -qv '^templates push dev-system-next '; then
    fail "pushed a template other than dev-system-next: $(cat "$case/calls")"
  fi
  if grep -E '^(create|delete) ' "$case/calls" | grep -qvE '^(create|delete) next-smoke-'; then
    fail "touched a workspace not named next-smoke-*: $(cat "$case/calls")"
  fi
  if grep '^create ' "$case/calls" | grep -qv -- '--template dev-system-next '; then
    fail "created from a template other than dev-system-next: $(cat "$case/calls")"
  fi
}

TEMPLATE_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/../dev-system" && pwd)

# 1. push: fixed name, the token directory cleared (coder reads every other variable from
# terraform.tfvars), token only in the environment.
run_case 1 "$PUSH_NEXT"
expect_rc -eq
check_invariants
grep -q "^templates push dev-system-next --directory $TEMPLATE_DIR --yes --variable template_tester_secrets_dir= " "$case/calls" \
  || fail "push call wrong: $(cat "$case/calls")"
[ "$(grep -c -- '--variable' "$case/calls")" -eq 1 ] || fail "pushed variables other than the token directory: $(cat "$case/calls")"
[ "$(cat "$case/env")" = "$TOKEN https://coder.example.test" ] || fail "coder did not get the token and URL in its env: $(cat "$case/env")"

# 2. A template name (or anything else) as an argument is refused before any call.
run_case 2 "$PUSH_NEXT" push dev-system
expect_rc -ne
[ ! -s "$case/calls" ] || fail "called coder despite an extra argument: $(cat "$case/calls")"
run_case 2b "$PUSH_NEXT" dev-system
expect_rc -ne
[ ! -s "$case/calls" ] || fail "called coder for an unknown subcommand: $(cat "$case/calls")"

# 3. CODER_TEMPLATE_NAME (read by coder create) is refused.
run_case 3 env CODER_TEMPLATE_NAME=dev-system "$PUSH_NEXT" smoke
expect_rc -ne
[ ! -s "$case/calls" ] || fail "called coder with CODER_TEMPLATE_NAME set: $(cat "$case/calls")"

# 4. A missing token file fails with the setup pointer.
# shellcheck disable=SC2016 # PREP is single-quoted on purpose: run_case evals it once $case is set
PREP='rm "$case/secrets/coder-session-token"' run_case 4 "$PUSH_NEXT"
expect_rc -ne
grep -q 'Testing template changes from a workspace' "$case/out" || fail "no setup pointer: $(cat "$case/out")"
grep -q 'template_testing' "$case/out" || fail "no template_testing pointer: $(cat "$case/out")"
[ ! -s "$case/calls" ] || fail "called coder without a token: $(cat "$case/calls")"

# 4b. A missing directory (template_testing off) fails with the opt-in pointer, and the
# shared secrets mount is not used as a fallback.
# shellcheck disable=SC2016 # PREP is single-quoted on purpose: run_case evals it once $case is set
PREP='rm -r "$case/secrets"; mkdir "$case/shared"; printf "%s\\n" "$TOKEN" > "$case/shared/coder-session-token"' \
  run_case 4b env DEV_SECRETS_DIR="$tmpdir/case4b/shared" "$PUSH_NEXT"
expect_rc -ne
grep -q 'enable the template_testing parameter' "$case/out" || fail "no template_testing pointer: $(cat "$case/out")"
grep -q 'template_tester_secrets_dir' "$case/out" || fail "no template_tester_secrets_dir pointer: $(cat "$case/out")"
grep -q 'Testing template changes from a workspace' "$case/out" || fail "no README pointer: $(cat "$case/out")"
[ ! -s "$case/calls" ] || fail "called coder without the template-tester directory: $(cat "$case/calls")"

# 5. The template's variables are committed: terraform.tfvars is in the pushed directory
# and sets the telemetry endpoint.
grep -q '^otlp_endpoint = "http://' "$TEMPLATE_DIR/terraform.tfvars" \
  || fail "$TEMPLATE_DIR/terraform.tfvars does not set otlp_endpoint"
grep -q '^trusted_authors = "[A-Za-z0-9-]*:[0-9]*"' "$TEMPLATE_DIR/terraform.tfvars" \
  || fail "$TEMPLATE_DIR/terraform.tfvars does not set trusted_authors"

# 6. smoke, agent ready: push, create from dev-system-next, ssh for the log, delete.
run_case 6 "$PUSH_NEXT" smoke
expect_rc -eq
check_invariants
ws=$(cat "$case/created")
case "$ws" in next-smoke-??????) ;; *) fail "smoke workspace name '$ws'" ;; esac
expect_call "create $ws --template dev-system-next --use-parameter-defaults --yes"
expect_call "ssh $ws -- tail -n 40 /tmp/coder-startup-script.log"
expect_call "delete $ws --yes"
[ "$(tail -n 1 "$case/calls")" = "delete $ws --yes" ] || fail "delete was not the last call: $(cat "$case/calls")"

# 7. smoke, agent fails to start: non-zero, workspace still deleted.
run_case 7 env FAKE_LIFECYCLE=start_error PUSH_NEXT_TIMEOUT=3 "$PUSH_NEXT" smoke
expect_rc -ne
check_invariants
ws=$(cat "$case/created")
expect_call "delete $ws --yes"
grep -q 'failed to start' "$case/out" || fail "start_error not reported as such: $(cat "$case/out")"

# 8. smoke, agent never ready within the timeout: non-zero, workspace still deleted.
run_case 8 env FAKE_LIFECYCLE=starting PUSH_NEXT_TIMEOUT=0 "$PUSH_NEXT" smoke
expect_rc -ne
check_invariants
ws=$(cat "$case/created")
expect_call "delete $ws --yes"
grep -q 'not ready after' "$case/out" || fail "no timeout message: $(cat "$case/out")"

# 9. cleanup deletes only next-smoke-* from dev-system-next, never the current workspace.
# shellcheck disable=SC2016 # PREP is single-quoted on purpose: run_case evals it once $case is set
PREP='cat > "$case/list.json" <<JSON
[{"name":"next-smoke-aaaaaa","template_name":"dev-system-next"},
 {"name":"next-smoke-bbbbbb","template_name":"dev-system"},
 {"name":"my-ws","template_name":"dev-system-next"},
 {"name":"next-smoke-self01","template_name":"dev-system-next"}]
JSON' run_case 9 env CODER_WORKSPACE_NAME=next-smoke-self01 "$PUSH_NEXT" cleanup
expect_rc -eq
check_invariants
[ "$(grep -c '^delete ' "$case/calls")" -eq 1 ] || fail "cleanup deleted the wrong set: $(cat "$case/calls")"
expect_call "delete next-smoke-aaaaaa --yes"

echo "push-next.test.sh: all checks passed"
