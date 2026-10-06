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

cat > "$tmpdir/coder" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CALLS"
EOF
chmod +x "$tmpdir/coder"

# Run push.sh with the given arguments; leaves $calls and $rc.
run() {
  calls=$tmpdir/calls
  : > "$calls"
  set +e
  CODER_BIN="$tmpdir/coder" FAKE_CALLS="$calls" "$PUSH" "$@" > "$tmpdir/out" 2>&1
  rc=$?
  set -e
}

# expect_calls <template> <mode> <display name> <icon>: one push, then one edit.
expect_calls() {
  [ "$rc" -eq 0 ] || fail "$1: exit status $rc - output: $(cat "$tmpdir/out")"
  [ "$(wc -l < "$calls")" -eq 2 ] || fail "$1: wanted 2 coder calls: $(cat "$calls")"
  sed -n 1p "$calls" | grep -qE "^templates push $1 --directory $TEMPLATE_DIR --yes --variable remote_control_default_mode=$2( --message push.sh from [0-9a-f]+)?\$" \
    || fail "$1: push call wrong: $(cat "$calls")"
  case "$(sed -n 2p "$calls")" in
    "templates edit $1 --display-name $3 --icon $4 --description "?*" --yes") ;;
    *) fail "$1: edit call wrong: $(cat "$calls")" ;;
  esac
}

# 1. dev-system: mode auto, the docker icon.
run dev-system
expect_calls dev-system auto dev-system /icon/docker.svg

# 2. orchestrator: mode session, the clockwise arrows emoji.
run orchestrator
expect_calls orchestrator session Orchestrator /emojis/1f504.png

# 3. Anything else is refused before any call.
for args in '' dev-system-next 'dev-system orchestrator'; do
  # shellcheck disable=SC2086 # split on purpose: each case is a list of arguments
  run $args
  [ "$rc" -eq 2 ] || fail "'$args': exit status $rc, wanted 2"
  [ ! -s "$calls" ] || fail "'$args': called coder: $(cat "$calls")"
done

echo "push.test.sh: all checks passed"
