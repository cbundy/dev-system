#!/bin/sh
#
# Plain-shell test for images/base/dev-restart-self (cbundy/dev-system#263).
#
# Stubs `curl` on PATH: every call is recorded (argv, stdin, "METHOD PATH BODY") and answered
# from fixture files, so no Coder server, Docker or network is needed and nothing is ever
# really stopped or started.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
HELPER="$SCRIPT_DIR/../dev-restart-self"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$HELPER" ] || fail "$HELPER is missing or not executable"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat > "$tmp/bin/curl" <<'STUB'
#!/bin/sh
# Fake curl. Records to $FAKE/{argv,stdin,calls}; answers from $FAKE/resp/<METHOD>_<path>.{code,json}.
method=GET body="" out=""
printf '%s\n' "$*" >> "$FAKE/argv"
cat >> "$FAKE/stdin"
while [ $# -gt 0 ]; do
  case $1 in
    -X) method=$2; shift ;;
    -d) body=$2; shift ;;
    -o) out=$2; shift ;;
    -w | -H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
path=${url#"$CODER_URL"}
printf '%s %s %s\n' "$method" "$path" "$body" >> "$FAKE/calls"
key=$(printf '%s_%s' "$method" "$path" | tr '/' '_')
code=200
[ ! -f "$FAKE/resp/$key.code" ] || code=$(cat "$FAKE/resp/$key.code")
# reject-first: answer the first POST .../builds with 403 and a message, then behave normally.
if [ "$method" = POST ] && [ -f "$FAKE/reject-first" ] && [ "${path##*/}" = builds ]; then
  rm -f "$FAKE/reject-first"
  echo '{"message":"Start transition not allowed here"}' > "$out"
  printf 403
  exit 0
fi
if [ -f "$FAKE/resp/$key.json" ]; then cat "$FAKE/resp/$key.json" > "$out"; else echo '{}' > "$out"; fi
printf '%s' "$code"
STUB
chmod +x "$tmp/bin/curl"

WS=11111111-2222-3333-4444-555555555555
TPL=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
VER=99999999-8888-7777-6666-555555555555
SECRET=tok-SECRET-123

# new_case NAME: fresh state; sets C (dir) and fixtures for a running workspace.
new_case() {
  C=$tmp/$1
  mkdir -p "$C/resp" "$C/state" "$C/cfg" "$C/secrets"
  : > "$C/argv"; : > "$C/stdin"; : > "$C/calls"
  put GET "/api/v2/workspaces/$WS" "{\"template_id\":\"$TPL\",\"template_active_version_id\":\"$VER\",\"autostart_schedule\":\"CRON_TZ=UTC 0 6 * * *\",\"automatic_updates\":\"never\",\"latest_build\":{\"transition\":\"start\",\"status\":\"running\"}}"
  put GET "/api/v2/templates/$TPL" '{"allow_user_autostart":true}'
  put POST "/api/v2/workspaces/$WS/builds" '{"build_number":12}'
}
put() { # method path json [code]
  key=$(printf '%s_%s' "$1" "$2" | tr '/' '_')
  printf '%s\n' "$3" > "$C/resp/$key.json"
  [ -z "${4:-}" ] || printf '%s' "$4" > "$C/resp/$key.code"
}

# run [ARGS...]: runs the helper in $C; leaves $C/out and $C/status.
run() {
  set +e
  base="CODER_WORKSPACE_ID=$WS CODER_URL=http://coder.test CODER_SESSION_TOKEN=$SECRET"
  for u in ${UNSET:-}; do base=$(printf '%s' "$base" | tr ' ' '\n' | grep -v "^$u=" | tr '\n' ' '); done
  # shellcheck disable=SC2086
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$C/home" FAKE="$C" \
    DEV_RESTART_SELF_DIR="$C/state" DEV_SECRETS_DIR="$C/secrets" CODER_CONFIG_DIR="$C/cfg" \
    $base ${ENVX:-} "$HELPER" "$@" > "$C/out" 2>&1
  echo $? > "$C/status"
  set -e
}
status() { cat "$C/status"; }
calls() { cut -d' ' -f1,2 "$C/calls" | sed "s|/api/v2/workspaces/$WS|WS|; s|/api/v2/templates/$TPL|TPL|"; }
want_calls() { # expected lines on stdin
  calls > "$C/got"
  cat > "$C/want"
  diff "$C/want" "$C/got" > /dev/null || { cat "$C/out"; diff "$C/want" "$C/got" >&2 || true; fail "$1: wrong request sequence"; }
}
assert_status() { [ "$(status)" = "$1" ] || { cat "$C/out" >&2; fail "$2: exit $(status), want $1"; }; }
no_calls() { [ ! -s "$C/calls" ] || { cat "$C/calls" >&2; fail "$1: unexpected requests"; }; }

# --- default mode: exactly one start POST, active version, no stop -------------------------
new_case start
run
assert_status 0 start
want_calls start <<'X'
GET WS
POST WS/builds
X
grep -qF "POST /api/v2/workspaces/$WS/builds {\"transition\":\"start\",\"template_version_id\":\"$VER\"}" "$C/calls" || fail "start: wrong body"
grep -q stop "$C/calls" && fail "start: sent a stop"
grep -q "will end now" "$C/out" || fail "start: no goodbye notice"
grep -q "mode=start .*build=12" "$C/state/last-request" || fail "start: last-request not recorded"
[ ! -e "$C/state/pending.json" ] || fail "start: wrote a marker"

# --upgrade is an alias of the default mode
new_case start-upgrade
run --upgrade
assert_status 0 start-upgrade
want_calls start-upgrade <<'X'
GET WS
POST WS/builds
X

# --- the token never appears on a command line ----------------------------------------------
grep -q "$SECRET" "$C/argv" && fail "token leaked into curl argv"
grep -q "Coder-Session-Token: $SECRET" "$C/stdin" || fail "token not passed via stdin config"
grep -q "$SECRET" "$C/out" && fail "token printed"

# --- refusals ---------------------------------------------------------------------------------
new_case stopped
put GET "/api/v2/workspaces/$WS" '{"template_active_version_id":"v","latest_build":{"transition":"stop","status":"stopped"}}'
run
assert_status 1 stopped
want_calls stopped <<'X'
GET WS
X
grep -q "not start/running" "$C/out" || fail "stopped: no refusal message"

new_case not-in-coder
UNSET="CODER_WORKSPACE_ID" run
assert_status 1 not-in-coder
no_calls not-in-coder
grep -q "not running in a Coder workspace" "$C/out" || fail "not-in-coder: no message"

new_case no-token
UNSET="CODER_SESSION_TOKEN" run
assert_status 1 no-token
no_calls no-token
grep -q "Coder CLI" "$C/out" || fail "no-token: no README pointer"

# --- fallback on 4xx --------------------------------------------------------------------------
# Every builds POST rejected: the fallback runs, its stop fails too, and the helper undoes its changes.
new_case fallback-all-403
put POST "/api/v2/workspaces/$WS/builds" '{"message":"Start transition not allowed here"}' 403
run
assert_status 1 fallback-all-403
grep -q "falling back to a scheduled restart" "$C/out" || fail "fallback: no fallback notice"
grep -q "HTTP 403: Start transition not allowed here" "$C/out" || fail "fallback: no status and message"
[ ! -e "$C/state/pending.json" ] || fail "fallback-all-403: marker should be consumed by the undo"
tail -n 2 "$C/calls" | grep -q "^PUT .*/autoupdates" || fail "fallback-all-403: undo should restore automatic_updates"

# Only the start POST rejected: the full fallback sequence, in order.
new_case fallback
: > "$C/reject-first"
run
assert_status 0 fallback
want_calls fallback <<'X'
GET WS
POST WS/builds
GET WS
GET TPL
PUT WS/autostart
PUT WS/autoupdates
POST WS/builds
X
sed -n 5p "$C/calls" | grep -q '"schedule":"CRON_TZ=UTC ' || fail "fallback: autostart body"
sed -n 6p "$C/calls" | grep -qF '{"automatic_updates":"always"}' || fail "fallback: autoupdates body"
sed -n 7p "$C/calls" | grep -qF '{"transition":"stop"}' || fail "fallback: stop body"
grep -q "HTTP 403: Start transition not allowed here" "$C/out" || fail "fallback: no reason"
jq -e '.autostart_schedule == "CRON_TZ=UTC 0 6 * * *" and .automatic_updates == "never"' "$C/state/pending.json" > /dev/null || fail "fallback: marker should hold the prior values"

# A 5xx is not a rejection: no fallback, nothing stopped.
new_case server-error
put POST "/api/v2/workspaces/$WS/builds" '{"message":"oops"}' 500
run
assert_status 1 server-error
want_calls server-error <<'X'
GET WS
POST WS/builds
X

# --- --restart: without --upgrade no autoupdates PUT; cron = now + delay in UTC --------------
new_case restart
ENVX="DEV_RESTART_SELF_NOW=1767225600" run --restart
assert_status 0 restart
want_calls restart <<'X'
GET WS
GET TPL
PUT WS/autostart
POST WS/builds
X
# 1767225600 = 2026-01-01 00:00:00 UTC; +3 min -> minute 3 hour 0
grep -qF '{"schedule":"CRON_TZ=UTC 3 0 * * *"}' "$C/calls" || { cat "$C/calls" >&2; fail "restart: wrong cron"; }

new_case restart-delay
ENVX="DEV_RESTART_SELF_NOW=1767225600 DEV_RESTART_SELF_DELAY_MIN=90" run --restart
grep -qF 'CRON_TZ=UTC 30 1 * * *' "$C/calls" || fail "restart-delay: wrong cron for 90 min"
new_case restart-min
ENVX="DEV_RESTART_SELF_NOW=1767225600 DEV_RESTART_SELF_DELAY_MIN=0" run --restart
grep -qF 'CRON_TZ=UTC 2 0 * * *' "$C/calls" || fail "restart-min: delay below 2 must clamp to 2"

new_case restart-noautostart
put GET "/api/v2/templates/$TPL" '{"allow_user_autostart":false}'
run --restart
assert_status 1 restart-noautostart
want_calls restart-noautostart <<'X'
GET WS
GET TPL
X
[ ! -e "$C/state/pending.json" ] || fail "restart-noautostart: wrote a marker"

# --- --dry-run sends nothing ------------------------------------------------------------------
new_case dry
run --dry-run
assert_status 0 dry
[ ! -s "$C/argv" ] || fail "dry: curl was called"
grep -q "dry-run: POST /api/v2/workspaces/$WS/builds" "$C/out" || fail "dry: request not printed"
new_case dry-restart
run --restart --upgrade --dry-run
assert_status 0 dry-restart
[ ! -s "$C/argv" ] || fail "dry-restart: curl was called"
grep -q "dry-run: PUT /api/v2/workspaces/$WS/autoupdates" "$C/out" || fail "dry-restart: autoupdates not printed"
grep -q "$SECRET" "$C/out" && fail "dry-restart: token printed"
[ ! -e "$C/state/pending.json" ] || fail "dry-restart: wrote a marker"

# --- credential resolution order --------------------------------------------------------------
new_case creds
printf 'file-secret-tok\n' > "$C/secrets/coder-session-token"
printf 'cfg-secret-tok\n' > "$C/cfg/session"
printf 'http://cfg.test\n' > "$C/cfg/url"
UNSET="CODER_SESSION_TOKEN CODER_URL" ENVX="CODER_AGENT_URL=http://agent.test" run --dry-run
assert_status 0 creds1
# secrets file beats the config dir
UNSET="CODER_SESSION_TOKEN" run
grep -q "Coder-Session-Token: file-secret-tok" "$C/stdin" || fail "creds: secrets file token not used"
: > "$C/stdin"
rm "$C/secrets/coder-session-token"
UNSET="CODER_SESSION_TOKEN CODER_URL" run
grep -q "Coder-Session-Token: cfg-secret-tok" "$C/stdin" || fail "creds: config dir token not used"
# url: config dir beats the agent URL (the stub strips CODER_URL; compare the recorded argv)
grep -q "http://cfg.test/api/v2/workspaces/$WS" "$C/argv" || fail "creds: config dir url not used"
: > "$C/argv"; rm "$C/cfg/url"
UNSET="CODER_SESSION_TOKEN CODER_URL" ENVX="CODER_AGENT_URL=http://agent.test/" run
grep -q "http://agent.test/api/v2/workspaces/$WS" "$C/argv" || fail "creds: agent url fallback not used"
: > "$C/stdin"
run
grep -q "Coder-Session-Token: $SECRET" "$C/stdin" || fail "creds: env token should win"

# --- resume -----------------------------------------------------------------------------------
new_case resume
printf '{"autostart_schedule":"CRON_TZ=UTC 0 6 * * *","automatic_updates":"never"}\n' > "$C/state/pending.json"
printf 'mode=restart time=T build=13\n' > "$C/state/last-request"
run --resume
assert_status 0 resume
want_calls resume <<'X'
PUT WS/autostart
PUT WS/autoupdates
X
grep -qF '{"schedule":"CRON_TZ=UTC 0 6 * * *"}' "$C/calls" || fail "resume: schedule not restored"
grep -qF '{"automatic_updates":"never"}' "$C/calls" || fail "resume: automatic_updates not restored"
[ ! -e "$C/state/pending.json" ] || fail "resume: marker not deleted"
[ ! -e "$C/state/last-request" ] || fail "resume: last-request not removed"
grep -q "last request: mode=restart" "$C/out" || fail "resume: last request not reported"

new_case resume-null
printf '{"autostart_schedule":null,"automatic_updates":"always"}\n' > "$C/state/pending.json"
run --resume
grep -qF '{"schedule":null}' "$C/calls" || fail "resume-null: should PUT a null schedule"
grep -qF '{"automatic_updates":"always"}' "$C/calls" || fail "resume-null: automatic_updates"

new_case resume-fail
printf '{"autostart_schedule":null,"automatic_updates":"never"}\n' > "$C/state/pending.json"
put PUT "/api/v2/workspaces/$WS/autostart" '{"message":"boom"}' 500
run --resume
assert_status 1 resume-fail
[ -e "$C/state/pending.json" ] || fail "resume-fail: marker must be kept"
grep -q "WARNING" "$C/out" || fail "resume-fail: no warning"

new_case resume-none
UNSET="CODER_WORKSPACE_ID CODER_SESSION_TOKEN" run --resume
assert_status 0 resume-none
no_calls resume-none

# --- --parameter (cbundy/dev-system#268) --------------------------------------------------------
BID=bbbbbbbb-1111-2222-3333-444444444444
BP="/api/v2/workspacebuilds/$BID/parameters"
param_case() { # name: a start build that returns an id, and a read-back fixture
  new_case "$1"
  put POST "/api/v2/workspaces/$WS/builds" "{\"build_number\":12,\"id\":\"$BID\"}"
}

param_case param-one
put GET "$BP" '[{"name":"remote_control_resume","value":"false"},{"name":"image","value":"x"}]'
run --parameter remote_control_resume=false
assert_status 0 param-one
want_calls param-one <<'X'
GET WS
POST WS/builds
GET /api/v2/workspacebuilds/bbbbbbbb-1111-2222-3333-444444444444/parameters
X
grep -qF "POST /api/v2/workspaces/$WS/builds {\"transition\":\"start\",\"template_version_id\":\"$VER\",\"rich_parameter_values\":[{\"name\":\"remote_control_resume\",\"value\":\"false\"}]}" "$C/calls" || { cat "$C/calls" >&2; fail "param-one: wrong body"; }
grep -q "remote_control_resume=false took effect" "$C/out" || fail "param-one: no confirmation"

# two values, one in the --parameter=name=value form; a value may itself contain "="
param_case param-two
put GET "$BP" '[{"name":"remote_control_resume","value":"false"},{"name":"image","value":"ghcr.io/x/dev:latest"}]'
run --parameter remote_control_resume=false --parameter=image=ghcr.io/x/dev:latest
assert_status 0 param-two
grep -F 'POST ' "$C/calls" | sed 's/^POST [^ ]* //' | jq -e '.rich_parameter_values == [{"name":"remote_control_resume","value":"false"},{"name":"image","value":"ghcr.io/x/dev:latest"}]' > /dev/null || { cat "$C/calls" >&2; fail "param-two: wrong values"; }
param_case param-equals
put GET "$BP" '[{"name":"repo_url","value":"a=b"}]'
run --parameter repo_url=a=b
assert_status 0 param-equals

# a build that did not take the value is a failure, naming the parameter
param_case param-mismatch
put GET "$BP" '[{"name":"remote_control_resume","value":"true"}]'
run --parameter remote_control_resume=false
assert_status 1 param-mismatch
grep -q 'parameter remote_control_resume is "true" in build .*, not "false"' "$C/out" || fail "param-mismatch: no mismatch message"

# a parameter missing from the build is a failure too
param_case param-missing
put GET "$BP" '[]'
run --parameter remote_control_resume=false
assert_status 1 param-missing

# malformed: usage error, no request at all
for bad in "novalue" "=x"; do
  new_case "param-bad"
  run --parameter "$bad"
  assert_status 2 "param-bad $bad"
  no_calls "param-bad $bad"
done
new_case param-bare
run --parameter
assert_status 2 param-bare
no_calls param-bare

# --dry-run shows the values and sends nothing
new_case param-dry
run --dry-run --parameter remote_control_resume=false
assert_status 0 param-dry
[ ! -s "$C/argv" ] || fail "param-dry: curl was called"
grep -qF '"rich_parameter_values":[{"name":"remote_control_resume","value":"false"}]' "$C/out" || fail "param-dry: values not shown"

# a 4xx falls back to a restart that carries the parameters in the stop build
param_case param-403
: > "$C/reject-first"
put GET "$BP" '[{"name":"remote_control_resume","value":"false"}]'
put POST "/api/v2/workspaces/$WS/builds" "{\"build_number\":13,\"id\":\"$BID\"}"
run --parameter remote_control_resume=false
assert_status 0 param-403
want_calls param-403 <<'X'
GET WS
POST WS/builds
GET WS
GET TPL
PUT WS/autostart
PUT WS/autoupdates
POST WS/builds
GET /api/v2/workspacebuilds/bbbbbbbb-1111-2222-3333-444444444444/parameters
X
sed -n 7p "$C/calls" | grep -qF '{"transition":"stop","rich_parameter_values":[{"name":"remote_control_resume","value":"false"}]}' || { cat "$C/calls" >&2; fail "param-403: stop body must carry the parameter"; }

# --restart carries the parameters in the stop build; the read-back checks that build
param_case param-restart
put GET "$BP" '[{"name":"image","value":"z"}]'
run --restart --parameter image=z
assert_status 0 param-restart
want_calls param-restart <<'X'
GET WS
GET TPL
PUT WS/autostart
POST WS/builds
GET /api/v2/workspacebuilds/bbbbbbbb-1111-2222-3333-444444444444/parameters
X
sed -n 4p "$C/calls" | grep -qF '{"transition":"stop","rich_parameter_values":[{"name":"image","value":"z"}]}' || fail "param-restart: stop body must carry the parameter"
param_case param-restart-mismatch
put GET "$BP" '[{"name":"image","value":"old"}]'
run --restart --parameter image=z
assert_status 1 param-restart-mismatch

# --- --fresh (cbundy/dev-system#268) ---------------------------------------------------------
new_case fresh
run --fresh
assert_status 0 fresh
[ -e "$C/state/fresh-conversation" ] || fail "fresh: marker not written"
want_calls fresh <<'X'
GET WS
POST WS/builds
X
grep -qF "\"template_version_id\":\"$VER\"}" "$C/calls" || fail "fresh: body should be the plain start build"
grep -q rich_parameter_values "$C/calls" && fail "fresh: must not change any parameter"

# combined with --upgrade and --parameter
param_case fresh-param
put GET "$BP" '[{"name":"image","value":"y"}]'
run --upgrade --fresh --parameter image=y
assert_status 0 fresh-param
[ -e "$C/state/fresh-conversation" ] || fail "fresh-param: marker not written"

# with --restart the marker is written too, and kept
new_case fresh-restart
run --restart --fresh
assert_status 0 fresh-restart
[ -e "$C/state/fresh-conversation" ] || fail "fresh-restart: marker not written"
[ -e "$C/state/pending.json" ] || fail "fresh-restart: pending.json missing"

# a refusal leaves no marker
new_case fresh-refused
put GET "/api/v2/workspaces/$WS" '{"template_active_version_id":"v","latest_build":{"transition":"stop","status":"stopped"}}'
run --fresh
assert_status 1 fresh-refused
[ ! -e "$C/state/fresh-conversation" ] || fail "fresh-refused: left a marker"

# a failed start leaves no marker (5xx, and the 4xx fallback whose restart also fails)
new_case fresh-500
put POST "/api/v2/workspaces/$WS/builds" '{"message":"oops"}' 500
run --fresh
assert_status 1 fresh-500
[ ! -e "$C/state/fresh-conversation" ] || fail "fresh-500: left a marker"
new_case fresh-403
put POST "/api/v2/workspaces/$WS/builds" '{"message":"no"}' 403
run --fresh
assert_status 1 fresh-403
[ ! -e "$C/state/fresh-conversation" ] || fail "fresh-403: left a marker"

# --dry-run writes nothing; --resume leaves the marker for dev-remote-control
new_case fresh-dry
run --fresh --dry-run
assert_status 0 fresh-dry
[ ! -e "$C/state/fresh-conversation" ] || fail "fresh-dry: wrote a marker"
new_case fresh-resume
: > "$C/state/fresh-conversation"
UNSET="CODER_WORKSPACE_ID CODER_SESSION_TOKEN" run --resume
assert_status 0 fresh-resume
[ -e "$C/state/fresh-conversation" ] || fail "fresh-resume: --resume must not consume the marker"

echo "dev-restart-self: ok"
