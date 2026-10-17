#!/bin/sh
# shellcheck disable=SC2016 # the stub scripts are written with literal $ on purpose
#
# Plain-shell test for images/base/dev-statusline.
#
# callum-flow-factory-state and usage-check.sh are stubs, so no database, network or
# Claude login is involved.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CMD="$SCRIPT_DIR/../dev-statusline"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$CMD" ] || fail "$CMD is missing or not executable"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The factory-state stub logs its arguments and prints the fixture: one repo, an issue per
# stage, two of them designing.
cat > "$tmp/factory-state" <<'STUB'
#!/bin/sh
echo "$*" >> "$FS_LOG"
[ ! -f "$FS_FAIL" ] || exit 1
cat <<'J'
{"repos":[{"repo":"cbundy/dev-system","issues":[
 {"issue":1,"stage":"queued"},{"issue":2,"stage":"queued"},{"issue":3,"stage":"queued"},
 {"issue":4,"stage":"designing"},{"issue":5,"stage":"designing"},
 {"issue":6,"stage":"implementing"},
 {"issue":7,"stage":"in pipeline"},{"issue":8,"stage":"parked"},
 {"issue":9,"stage":"ready to merge"},
 {"issue":10,"stage":"merged"},{"issue":11,"stage":"closed without merge"}]}]}
J
STUB
cat > "$tmp/usage-check" <<'STUB'
#!/bin/sh
[ "$1" = --record ] && cat > "$USAGE_LOG"
echo "5h 1% | 7d 2%"
STUB
chmod +x "$tmp/factory-state" "$tmp/usage-check"

cat > "$tmp/versions.json" <<'J'
{"base_image":"2.27.0","plugin_version":"0.27.0","components":[{"name":"no-mistakes","running":"1.84.0"},{"name":"claude","running":"2.1.296"}]}
J

FULL='{"version":"2.1.296","model":{"display_name":"Opus"},"workspace":{"current_dir":"/nowhere","repo":{"owner":"cbundy","name":"dev-system"}},"context_window":{"used_percentage":41.3},"rate_limits":{"five_hour":{"used_percentage":72.1,"resets_at":1999999999},"seven_day":{"used_percentage":93,"resets_at":1999999999}}}'

export CALLUM_FLOW_FACTORY_STATE_BIN="$tmp/factory-state" CALLUM_USAGE_CHECK_BIN="$tmp/usage-check"
export DEV_VERSIONS_FILE="$tmp/versions.json" DEV_STATUSLINE_STATE="$tmp/state"
export FS_LOG="$tmp/fs.log" FS_FAIL="$tmp/fs.fail" USAGE_LOG="$tmp/usage.log"
unset DEV_STATUSLINE_FACTORY DEV_STATUSLINE_TTL DEV_STATUSLINE_NOW
DEV_ROLE=dev
export DEV_ROLE

esc=$(printf '\033')
plain() { sed "s/$esc\[[0-9;]*m//g"; }
draw() { printf '%s' "$1" | "$CMD" > "$tmp/out" || fail "exited non-zero"; plain < "$tmp/out" > "$tmp/plain"; }
row() { sed -n "${1}p" "$tmp/plain"; }
cache="$tmp/state/factory-cbundy_dev-system.json"
wait_cache() { # wait_cache <min at>: until a refresh has written a cache at or after it
  i=0
  while [ "$i" -lt 50 ]; do
    [ "$(jq -r '.at // 0' "$cache" 2>/dev/null || echo 0)" -ge "$1" ] && [ ! -d "$cache.lock" ] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  fail "no factory refresh landed in $cache"
}

# Row 1: the time, context, both usage windows (rounded up) and the model, coloured by level.
draw "$FULL"
row 1 | grep -Eq '^[0-9]{2}:[0-9]{2}  ctx 42%  5h 73%  7d 93%  Opus$' || fail "row 1: $(row 1)"
grep -q "ctx ${esc}\[32m42%" "$tmp/out" || fail "42% is not green"
grep -q "5h ${esc}\[33m73%" "$tmp/out" || fail "73% is not yellow"
grep -q "7d ${esc}\[31m93%" "$tmp/out" || fail "93% is not red"
# Row 2 for a dev session: the versions only, no factory and no factory-state call.
[ "$(row 2)" = "cc 2.1.296  flow 0.27.0  img 2.27.0  nm 1.84.0" ] || fail "dev row 2: $(row 2)"
[ ! -e "$FS_LOG" ] || fail "a dev session called factory-state"
# The plan usage was handed to usage-check.sh --record.
jq -e '.rate_limits.seven_day.used_percentage == 93' "$USAGE_LOG" >/dev/null || fail "usage not recorded"

# Empty and malformed input still draw the time, and exit 0.
draw ''
row 1 | grep -Eq '^[0-9]{2}:[0-9]{2}$' || fail "empty input row 1: $(row 1)"
[ "$(row 2)" = "flow 0.27.0  img 2.27.0  nm 1.84.0" ] || fail "empty input row 2: $(row 2)"
draw 'not json'
row 1 | grep -Eq '^[0-9]{2}:[0-9]{2}$' || fail "bad input row 1: $(row 1)"

# No version snapshot: no versions row beyond Claude Code's own.
DEV_VERSIONS_FILE="$tmp/missing.json" draw "$FULL"
[ "$(row 2)" = "cc 2.1.296" ] || fail "no snapshot row 2: $(row 2)"

# An orchestrator: the first draw has no cache and says so, then a background refresh fills it.
start=$(date +%s)
DEV_ROLE=orchestrator draw "$FULL"
[ "$(row 2)" = "factory: loading   cc 2.1.296  flow 0.27.0  img 2.27.0  nm 1.84.0" ] || fail "loading row 2: $(row 2)"
wait_cache "$start"
grep -qx -- '--repo cbundy/dev-system --github off --format json' "$FS_LOG" || fail "factory-state args: $(cat "$FS_LOG")"
DEV_ROLE=orchestrator draw "$FULL"
[ "$(row 2)" = "factory 6 live: design 2  dev 1  pipe 2  merge 1 | queued 3   cc 2.1.296  flow 0.27.0  img 2.27.0  nm 1.84.0" ] ||
  fail "factory row 2: $(row 2)"
# Within the TTL the cache is used as is: no second call.
[ "$(wc -l < "$FS_LOG")" -eq 1 ] || fail "refreshed inside the TTL: $(cat "$FS_LOG")"

# A cache past the TTL triggers one refresh; one older than five minutes shows its age.
now=$(date +%s)
jq -c --argjson at $((now - 600)) '.at = $at' "$cache" > "$cache.tmp" && mv "$cache.tmp" "$cache"
DEV_ROLE=orchestrator DEV_STATUSLINE_NOW=$now draw "$FULL"
row 2 | grep -q '| queued 3  (10m old)   cc ' || fail "stale row 2: $(row 2)"
wait_cache "$now"
[ "$(wc -l < "$FS_LOG")" -eq 2 ] || fail "stale cache was not refreshed once: $(cat "$FS_LOG")"

# A failing factory-state keeps the old cache rather than blanking it.
: > "$FS_FAIL"
jq -c --argjson at $((now - 600)) '.at = $at' "$cache" > "$cache.tmp" && mv "$cache.tmp" "$cache"
DEV_ROLE=orchestrator DEV_STATUSLINE_NOW=$now draw "$FULL"
i=0
while [ "$(wc -l < "$FS_LOG")" -lt 3 ] || [ -d "$cache.lock" ]; do
  [ "$i" -lt 50 ] || fail "the failing refresh never ran"
  sleep 0.1
  i=$((i + 1))
done
jq -e '.queued == 3' "$cache" >/dev/null || fail "a failed refresh replaced the cache"
rm -f "$FS_FAIL"

# DEV_STATUSLINE_FACTORY overrides the role either way.
DEV_ROLE=orchestrator DEV_STATUSLINE_FACTORY=off draw "$FULL"
[ "$(row 2)" = "cc 2.1.296  flow 0.27.0  img 2.27.0  nm 1.84.0" ] || fail "factory=off row 2: $(row 2)"
DEV_STATUSLINE_FACTORY=on DEV_STATUSLINE_TTL=99999 draw "$FULL"
row 2 | grep -q '^factory 6 live: ' || fail "factory=on row 2: $(row 2)"

# Without workspace.repo in stdin the repo comes from the origin remote of the session's dir.
git init -q "$tmp/repo"
git -C "$tmp/repo" remote add origin git@github.com:acme/widgets.git
start=$(date +%s)
DEV_STATUSLINE_FACTORY=on draw "{\"workspace\":{\"current_dir\":\"$tmp/repo\"}}"
cache="$tmp/state/factory-acme_widgets.json"
wait_cache "$start"
grep -qx -- '--repo acme/widgets --github off --format json' "$FS_LOG" || fail "remote fallback args: $(cat "$FS_LOG")"

echo "dev-statusline: all checks passed"
