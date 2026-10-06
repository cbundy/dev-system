#!/bin/sh
#
# Plain-shell tests for usage-check.sh, the issue-orchestrator usage gate's
# helper (cbundy/dev-system#170). It runs the script from its source location
# with a stub `curl` on a hermetic PATH, so no real network call and no real
# credentials are ever used, and `npm test` runs it anywhere.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
USAGE_CHECK="$SCRIPT_DIR/../../src/callum-tools/usage-check.sh"
SH=$(command -v sh)
[ -x "$USAGE_CHECK" ] || {
  echo "FAIL: $USAGE_CHECK is missing or not executable" >&2
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

fakebin="$tmpdir/bin"
toolbin="$tmpdir/tools"
nojq="$tmpdir/nojq"
mkdir -p "$fakebin" "$toolbin" "$nojq"
for t in jq sed tail cat mkdir mv dirname date; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
  [ "$t" = jq ] || ln -s "$p" "$nojq/$t"
done

# Stub curl: records its arguments and the header lines it was given on
# stdin (-H @-), then answers like `curl -w '\n%{http_code}'`: the body in
# $FAKE_CURL_BODY then the status in $FAKE_CURL_CODE. FAKE_CURL_FAIL makes it
# fail as on a network error.
cat > "$fakebin/curl" <<'EOF'
#!/bin/sh
echo "$*" > "$FAKE_CURL_LOG.args"
case " $* " in *" -H @- "*) cat > "$FAKE_CURL_LOG.stdin" ;; esac
[ -z "${FAKE_CURL_FAIL-}" ] || exit 7
cat "$FAKE_CURL_BODY"
printf '\n%s' "$FAKE_CURL_CODE"
EOF
chmod +x "$fakebin/curl"

home="$tmpdir/home"
config="$tmpdir/claude"
mkdir -p "$home" "$config"
state="$tmpdir/state/usage.json"
body="$tmpdir/body.json"
log="$tmpdir/curl"

now=$(date +%s)
soon=$((now + 3600))
later=$((now + 86400))
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
# The API's own form: fractional seconds and a +00:00 offset.
api_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.874510+00:00; }

# run [args...]: run the script with the stub PATH; output in $out, status in $rc.
run() {
  rc=0
  out=$(env -i HOME="$home" PATH="${RUN_PATH:-$fakebin:$toolbin}" \
    CLAUDE_CONFIG_DIR="$config" CALLUM_USAGE_STATE="$state" \
    ${TOKEN:+CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"} ${MAX_AGE:+CALLUM_USAGE_MAX_AGE="$MAX_AGE"} \
    FAKE_CURL_BODY="$body" FAKE_CURL_CODE="${CODE:-200}" FAKE_CURL_LOG="$log" \
    ${CURL_FAIL:+FAKE_CURL_FAIL=1} \
    "$SH" "$USAGE_CHECK" "$@" < "${STDIN:-/dev/null}" 2> "$tmpdir/stderr") || rc=$?
}

# expect_out <text>: the script exited 0 and printed exactly this.
expect_out() {
  [ "$rc" -eq 0 ] || fail "exit $rc (stderr: $(cat "$tmpdir/stderr")), expected 0"
  [ "$out" = "$1" ] || fail "expected:
$1
got:
$out"
}

# field <name>: a field of the last output line.
field() {
  printf '%s\n' "$out" | tr ' ' '\n' | sed -n "s/^$1=//p"
}

# write_creds <token>: a credentials file shaped like Claude Code's.
write_creds() {
  printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"r","expiresAt":1,"scopes":[],"subscriptionType":"max"}}\n' "$1" \
    > "$config/.credentials.json"
}

# A response shaped like the live endpoint's: fractional utilization, a
# per-model weekly bucket above the all-models one, null buckets, and the
# generic `limits` list.
cat > "$body" <<EOF
{"five_hour":{"utilization":89.2,"resets_at":"$(api_iso "$soon")","limit_dollars":null},
 "seven_day":{"utilization":53.0,"resets_at":"$(api_iso "$later")"},
 "seven_day_opus":{"utilization":71.4,"resets_at":"$(api_iso "$((later + 60))")"},
 "seven_day_sonnet":null,"seven_day_oauth_apps":null,
 "limits":[{"kind":"session","group":"session","percent":90,"resets_at":"$(api_iso "$soon")"},
           {"kind":"weekly_scoped","group":"weekly","percent":23,"resets_at":"$(api_iso "$later")"}]}
EOF

# 1. OAuth: rounds up, picks the binding weekly bucket, token via stdin only.
write_creds secret-from-file
run
[ "$(field five_hour)" = 90 ] || fail "five_hour should round 89.2 up to 90: $out"
[ "$(field resets_at)" = "$(iso "$soon")" ] || fail "resets_at: $out"
[ "$(field seven_day)" = 72 ] || fail "seven_day should be the opus bucket (71.4 -> 72): $out"
[ "$(field seven_day_resets_at)" = "$(iso "$((later + 60))")" ] || fail "seven_day_resets_at should be the opus bucket's: $out"
[ "$(field source)" = oauth ] || fail "source: $out"
in=$(field resets_in)
{ [ "$in" -gt 3500 ] && [ "$in" -le 3600 ]; } || fail "resets_in should be about an hour: $out"
grep -qx 'Authorization: Bearer secret-from-file' "$log.stdin" || fail "token not sent as a stdin header"
! grep -q secret "$log.args" || fail "the token leaked onto curl's command line: $(cat "$log.args")"
grep -q 'https://api.anthropic.com/api/oauth/usage' "$log.args" || fail "wrong endpoint: $(cat "$log.args")"

# 2. CLAUDE_CODE_OAUTH_TOKEN wins over the credentials file.
TOKEN=secret-from-env run
grep -qx 'Authorization: Bearer secret-from-env' "$log.stdin" || fail "env token not preferred"

# 3. A reset already passed reads as resets_in=0, never negative.
cat > "$tmpdir/past.json" <<EOF
{"five_hour":{"utilization":10,"resets_at":"$(api_iso "$((now - 60))")"},
 "seven_day":{"utilization":20,"resets_at":"$(api_iso "$later")"}}
EOF
cp "$body" "$tmpdir/body.orig"
cp "$tmpdir/past.json" "$body"
run
[ "$(field resets_in)" = 0 ] || fail "past reset should give resets_in=0: $out"
cp "$tmpdir/body.orig" "$body"

# 4. Nothing available: explicit unavailable line, exit 0 (fail open).
rm -f "$config/.credentials.json"
run
expect_out "usage=unavailable reason=oauth:no-token,statusline:no-snapshot"

# 5. --record (status line mode) saves a snapshot and prints a status line.
cat > "$tmpdir/statusline.json" <<EOF
{"model":{"id":"x"},"rate_limits":{"five_hour":{"used_percentage":41.2,"resets_at":$soon},
 "seven_day":{"used_percentage":60,"resets_at":$later}}}
EOF
STDIN="$tmpdir/statusline.json" run --record
expect_out "5h 42% | 7d 60%"
[ -f "$state" ] || fail "--record wrote no snapshot"

# 6. OAuth refused (expired token): falls back to the fresh snapshot.
write_creds expired
CODE=401 run
expect_out "five_hour=42 resets_at=$(iso "$soon") resets_in=$(field resets_in) seven_day=60 seven_day_resets_at=$(iso "$later") seven_day_resets_in=$(field seven_day_resets_in) source=statusline"

# 7. A stale snapshot is not trusted.
sed "s/\"recorded_at\":[0-9]*/\"recorded_at\":$((now - 1000))/" "$state" > "$state.tmp" && mv "$state.tmp" "$state"
CODE=401 run
case "$out" in
  "usage=unavailable reason=oauth:http-401,statusline:stale-"*s) ;;
  *) fail "a stale snapshot should be rejected: $out" ;;
esac
MAX_AGE=5000 CODE=401 run
[ "$(field source)" = statusline ] || fail "CALLUM_USAGE_MAX_AGE should widen the window: $out"

# 8. Network failure and a response with no plan limits (an API-key account).
rm -f "$state"
CURL_FAIL=1 run
expect_out "usage=unavailable reason=oauth:network,statusline:no-snapshot"
echo '{"five_hour":null,"seven_day":null}' > "$body"
run
expect_out "usage=unavailable reason=oauth:bad-response,statusline:no-snapshot"

# 9. --record on status line JSON without rate_limits writes nothing.
echo '{"model":{"id":"x"}}' > "$tmpdir/nolimits.json"
STDIN="$tmpdir/nolimits.json" run --record
expect_out "usage n/a"
[ ! -e "$state" ] || fail "--record without rate_limits should not write a snapshot"

# 10. No jq: still an explicit unavailable line, not a crash.
RUN_PATH="$fakebin:$nojq" run
expect_out "usage=unavailable reason=jq-missing"

# 11. Usage errors exit 2.
run --bogus
[ "$rc" -eq 2 ] || fail "unknown flag should exit 2, got $rc"

echo "usage-check.test.sh: ok"
