#!/bin/sh
#
# Plain-shell unit test for coder/push.sh: runs it against a fake `coder` (CODER_BIN) that
# records every call's argv. No Coder deployment is needed.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PUSH="$SCRIPT_DIR/../push.sh"
TEMPLATE_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/../dev-system" && pwd)

[ -x "$PUSH" ] || {
  echo "FAIL: $PUSH is missing or not executable" >&2
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# One line per call (its arguments joined by spaces) in $FAKE_CALLS, and each call's
# arguments one per line in $FAKE_CALLS.<n>, to compare them exactly.
cat > "$tmpdir/coder" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CALLS"
printf '%s\n' "$@" > "$FAKE_CALLS.$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
EOF
chmod +x "$tmpdir/coder"

# Run push.sh with the given arguments; leaves $calls and $rc.
run() {
  calls=$tmpdir/calls
  rm -f "$calls" "$calls".*
  : > "$calls"
  set +e
  CODER_BIN="$tmpdir/coder" FAKE_CALLS="$calls" "$PUSH" "$@" > "$tmpdir/out" 2>&1
  rc=$?
  set -e
}

# expect_calls <template> <display name> <icon> <variable>...: one push with exactly
# these variables (each a CSV-quoted name=value, as coder parses --variable), then one
# edit.
expect_calls() {
  t=$1 display=$2 icon=$3
  shift 3
  [ "$rc" -eq 0 ] || fail "$t: exit status $rc - output: $(cat "$tmpdir/out")"
  [ "$(wc -l < "$calls")" -eq 2 ] || fail "$t: wanted 2 coder calls: $(cat "$calls")"
  {
    printf '%s\n' templates push "$t" --directory "$TEMPLATE_DIR" --yes
    for v in "$@"; do printf -- '--variable\n"%s"\n' "$v"; done
  } > "$tmpdir/want"
  # The commit message is optional (no git outside a checkout).
  sed '/^--message$/,$d' "$calls.1" > "$tmpdir/got"
  diff "$tmpdir/want" "$tmpdir/got" >&2 || fail "$t: push arguments differ (- wanted, + got)"
  case "$(sed -n '/^--message$/,$p' "$calls.1" | tr '\n' ' ')" in
    "" | "--message push.sh from "[0-9a-f]*" ") ;;
    *) fail "$t: push --message wrong: $(cat "$calls.1")" ;;
  esac
  case "$(sed -n 2p "$calls")" in
    "templates edit $t --display-name $display --icon $icon --description "?*" --yes") ;;
    *) fail "$t: edit call wrong: $(cat "$calls")" ;;
  esac
}

# 1. dev-system: mode auto, the docker icon, and today's behaviour for the rest.
run dev-system
expect_calls dev-system dev-system /icon/docker.svg \
  remote_control_default_mode=auto \
  remote_control_default_resume=false \
  remote_control_default_skip_permissions=false \
  remote_control_prompt= \
  remote_control_resume_prompt= \
  remote_control_name_format=

# 2. orchestrator: session mode, resumed, the skill as the startup prompt, the resume
# nudge (its comma survives coder's CSV parsing because the field is quoted), and an
# emoji name format with spaces.
run orchestrator
expect_calls orchestrator Orchestrator /emojis/1f504.png \
  remote_control_default_mode=session \
  remote_control_default_resume=true \
  remote_control_default_skip_permissions=false \
  remote_control_prompt=/callum-flow:issue-orchestrator \
  'remote_control_resume_prompt=The workspace restarted and this conversation was resumed. Re-read .claude/orchestrator-memory.md, re-arm the watchers and the audit, and continue the issue-orchestrator loop.' \
  'remote_control_name_format=🔄 {name} orchestrator'

# 3. Anything else is refused before any call.
for args in '' dev-system-next 'dev-system orchestrator'; do
  # shellcheck disable=SC2086 # split on purpose: each case is a list of arguments
  run $args
  [ "$rc" -eq 2 ] || fail "'$args': exit status $rc, wanted 2"
  [ ! -s "$calls" ] || fail "'$args': called coder: $(cat "$calls")"
done

echo "push.test.sh: all checks passed"
