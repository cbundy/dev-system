#!/bin/sh
#
# Print the Claude plan's current usage as one line, for the factory loop's
# usage gate (cbundy/dev-system#170):
#
#   five_hour=<pct> resets_at=<iso> resets_in=<s> seven_day=<pct>
#     seven_day_resets_at=<iso> seven_day_resets_in=<s> source=<oauth|statusline>
#
# (one line on stdout). Percentages are whole numbers, rounded up so a gate
# never reads 89.5 as under 90. Times are UTC ISO 8601; *_resets_in is the
# seconds until that reset (0 if it has passed), ready for a one-shot wake.
# seven_day is the binding weekly window: the highest of the all-models weekly
# bucket and every per-model weekly bucket, with that bucket's reset time.
#
# It spends no model tokens and starts no background process: one HTTP GET or
# one file read per call. Sources, in order:
#
# 1. oauth - GET https://api.anthropic.com/api/oauth/usage, the endpoint
#    Claude Code's /usage calls, with the claude.ai OAuth token from
#    CLAUDE_CODE_OAUTH_TOKEN or .credentials.json in Claude Code's login
#    directory: CLAUDE_SECURESTORAGE_CONFIG_DIR when set (the base image's
#    /persist/claude-auth), else CLAUDE_CONFIG_DIR (default ~/.claude), as
#    Claude Code itself resolves it. Claude Code keeps that file's token
#    refreshed while a session runs.
# 2. statusline - a snapshot written by this script's --record mode (below),
#    used only while it is younger than CALLUM_USAGE_MAX_AGE seconds
#    (default 900): 5-hour utilization only rises until its reset, so an old
#    snapshot under-reports.
#
# With DEV_CLAUDE_AUTH=api-key in the environment (the Coder template's API-key login) neither source is
# tried: it prints `usage=unavailable reason=subscription:api-key-mode auth=api-key`. The manual path
# stays fail-open on it; the factory loop applies its own spend budget (docs/factory-loop/v2/SPEC.md 13.13).
#
# When no source answers it prints `usage=unavailable reason=<why>` and still
# exits 0: the caller fails open (dispatches as if under every threshold) and
# says so, rather than stalling on a missing number. Exit 2 is a usage error.
#
# --record is a Claude Code status line command ("statusLine": {"type":
# "command", "command": ".../usage-check.sh --record"}): it reads the status
# line JSON on stdin, saves its rate_limits to the snapshot file and prints a
# short status line ("5h 3% | 7d 53%"). Status line JSON only carries
# rate_limits in an interactive claude.ai-login session, which is why it is
# the fallback rather than the primary source.
#
# A check (not --record) also writes the reading to the factory event log as a native `usage`
# event: `callum-flow-event --type usage --actor watcher --data <json>`, best effort. --to-data reads
# a line like the one above (or the unavailable, auth and spend forms) on stdin and prints that
# data object, one line of JSON; the event write and the tests use it.
#
# Environment: CALLUM_USAGE_STATE (snapshot path, default
# ${XDG_STATE_HOME:-~/.local/state}/callum-tools/usage.json),
# CALLUM_USAGE_MAX_AGE, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_SECURESTORAGE_CONFIG_DIR,
# CLAUDE_CONFIG_DIR. On a subscription (DEV_CLAUDE_AUTH not api-key) a check's event also takes the loop's
# what-if dollar total: CALLUM_USAGE_SPEND_USD (a non-negative number) with CALLUM_USAGE_SPEND_RESETS_AT (ISO 8601
# UTC), or CALLUM_USAGE_SPEND_REASON (why the loop has none). The printed line never carries them.
set -eu

URL=https://api.anthropic.com/api/oauth/usage
state=${CALLUM_USAGE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/callum-tools/usage.json}
max_age=${CALLUM_USAGE_MAX_AGE:-900}

usage() {
  echo "usage: usage-check.sh [--record | --to-data]" >&2
  exit 2
}

case "$#:${1-}" in
  0:) mode=check ;;
  1:--record) mode=record ;;
  1:--to-data) mode=to-data ;;
  *) usage ;;
esac
case "$max_age" in '' | *[!0-9]*) echo "usage-check.sh: CALLUM_USAGE_MAX_AGE must be whole seconds" >&2; exit 2 ;; esac
command -v jq >/dev/null 2>&1 || { echo "usage=unavailable reason=jq-missing"; exit 0; }

# Shared jq helpers: epoch() turns an ISO 8601 string (fractional seconds and
# a +00:00 or Z offset allowed) or epoch seconds into epoch seconds; pct()
# rounds a percentage up.
# shellcheck disable=SC2016 # jq program text, not shell expansions
JQ_LIB='
def epoch: if type == "number" then floor
  else sub("\\.[0-9]+"; "") | sub("(\\+00:00|Z)$"; "Z") | fromdateiso8601 end;
def pct: ceil;
def line($src): . as $u
  | ($u.weekly | max_by(.pct)) as $w
  | "five_hour=\($u.five.pct) resets_at=\($u.five.at | todate) resets_in=\([($u.five.at - now | floor), 0] | max)"
    + " seven_day=\($w.pct) seven_day_resets_at=\($w.at | todate) seven_day_resets_in=\([($w.at - now | floor), 0] | max)"
    + " source=\($src)";
'

# The reading's line as the `usage` event's data object (callum-flow-event --type usage --data): the
# unavailable reading with its reasons, the plan reading (five_hour, seven_day) and, when the line
# carries them, the auth and spend fields. --to-data prints it for a line on stdin.
# shellcheck disable=SC2016 # jq program text, not shell expansions
TO_DATA_JQ='    (split(" ") | map(capture("^(?<k>[^=]+)=(?<v>.*)$") | {key: .k, value: .v}) | from_entries) as $t
    | (if $t.auth != null then {auth: $t.auth} else {} end) as $auth
    | if $t.usage == "unavailable" then
        {available: false, five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null,
         seven_day_resets_at: null, source: null, reasons: ($t.reason // "" | split(",") | map(select(. != "")))} + $auth
      elif $t.source == "spend" then
        {available: true, five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null,
         seven_day_resets_at: null, source: "spend", reasons: [], auth: $t.auth, spend_usd: ($t.spend_usd | tonumber)}
        + (if $t.budget_usd != null then {budget_usd: (if $t.budget_usd == "none" then null else ($t.budget_usd | tonumber) end)} else {} end)
        + (if $t.budget_resets_at != null then {budget_resets_at: (if $t.budget_resets_at == "none" then null else $t.budget_resets_at end)} else {} end)
      else
        {available: true, five_hour_pct: ($t.five_hour | tonumber), five_hour_resets_at: $t.resets_at,
         seven_day_pct: ($t.seven_day | tonumber), seven_day_resets_at: $t.seven_day_resets_at,
         source: $t.source, reasons: []} + $auth
      end'

# The subscription login's additions to the event data (check mode, DEV_CLAUDE_AUTH not api-key): auth, the
# loop's what-if spend for the month and when it restarts (CALLUM_USAGE_SPEND_USD / _RESETS_AT), a null budget,
# and the reason codes: why the total is missing (CALLUM_USAGE_SPEND_REASON, or spend:no-tally when nothing was
# passed, spend:bad-input when a value does not parse) and spend:subscription-no-budget.
# shellcheck disable=SC2016 # jq program text, not shell expansions
SUBSCRIPTION_JQ='    (if $usd == "" and $at == "" then null
       elif ($usd | test("^[0-9]+([.][0-9]+)?$")) and ($at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
         then {usd: ($usd | tonumber), at: $at}
       else "bad" end) as $s
    | (if $s == null then [(if $why != "" then $why else "spend:no-tally" end)]
       elif $s == "bad" then ["spend:bad-input"] else [] end) as $missing
    | . + {auth: "subscription", budget_usd: null,
           spend_usd: (if ($s | type) == "object" then $s.usd else null end),
           budget_resets_at: (if ($s | type) == "object" then $s.at else null end)}
    | .reasons += $missing + ["spend:subscription-no-budget"]'

if [ "$mode" = to-data ]; then
  jq -Rc "$TO_DATA_JQ"
  exit
fi

if [ "$mode" = record ]; then
  input=$(cat)
  # Status line JSON: rate_limits.{five_hour,seven_day}.{used_percentage,resets_at(epoch)}.
  if snap=$(printf '%s' "$input" | jq -ce '.rate_limits | select(.five_hour != null) | {recorded_at: now | floor, rate_limits: .}' 2>/dev/null); then
    mkdir -p "$(dirname "$state")"
    tmp="$state.$$"
    printf '%s\n' "$snap" > "$tmp" && mv "$tmp" "$state"
    printf '%s' "$snap" | jq -r '.rate_limits | "5h \(.five_hour.used_percentage | ceil)%"
      + (if .seven_day then " | 7d \(.seven_day.used_percentage | ceil)%" else "" end)'
  else
    echo "usage n/a"
  fi
  exit 0
fi

reasons=

# from_oauth: print the line from the OAuth usage endpoint, or add a reason.
from_oauth() {
  token=${CLAUDE_CODE_OAUTH_TOKEN-}
  # Set but empty means ~/.claude to Claude Code, so test for set, not empty.
  if [ "${CLAUDE_SECURESTORAGE_CONFIG_DIR+set}" = set ]; then
    creds=${CLAUDE_SECURESTORAGE_CONFIG_DIR:-$HOME/.claude}/.credentials.json
  else
    creds=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json
  fi
  if [ -z "$token" ] && [ -r "$creds" ]; then
    token=$(jq -r '.claudeAiOauth.accessToken // empty' "$creds" 2>/dev/null || true)
  fi
  if [ -z "$token" ]; then
    reasons="${reasons}oauth:no-token,"
    return 1
  fi
  command -v curl >/dev/null 2>&1 || { reasons="${reasons}oauth:curl-missing,"; return 1; }
  # The token goes in a header read from stdin, never on the command line,
  # where any process listing would show it.
  if ! body=$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS --connect-timeout 5 -m 15 -w '\n%{http_code}' -H @- \
      -H 'anthropic-beta: oauth-2025-04-20' "$URL" 2>/dev/null); then
    reasons="${reasons}oauth:network,"
    return 1
  fi
  code=$(printf '%s\n' "$body" | tail -n 1)
  if [ "$code" != 200 ]; then
    reasons="${reasons}oauth:http-${code:-none},"
    return 1
  fi
  if ! printf '%s\n' "$body" | sed '$d' | jq -er "$JQ_LIB"'
    def bucket: select(type == "object" and .utilization != null and .resets_at != null)
      | {pct: (.utilization | pct), at: (.resets_at | epoch)};
    select(.five_hour.utilization != null)
    | {five: (.five_hour | bucket),
       weekly: ([(.seven_day, .seven_day_opus, .seven_day_sonnet) | bucket]
         + [(.limits // [])[] | select(.group == "weekly" and .percent != null and .resets_at != null)
            | {pct: (.percent | pct), at: (.resets_at | epoch)}])}
    | select(.weekly | length > 0)
    | line("oauth")' 2>/dev/null; then
    reasons="${reasons}oauth:bad-response,"
    return 1
  fi
}

# from_statusline: print the line from a fresh --record snapshot, or add a reason.
from_statusline() {
  if [ ! -r "$state" ]; then
    reasons="${reasons}statusline:no-snapshot,"
    return 1
  fi
  if ! age=$(jq -er '(now | floor) - .recorded_at' "$state" 2>/dev/null); then
    reasons="${reasons}statusline:bad-snapshot,"
    return 1
  fi
  if [ "$age" -gt "$max_age" ]; then
    reasons="${reasons}statusline:stale-${age}s,"
    return 1
  fi
  if ! jq -er "$JQ_LIB"'
    def bucket: select(type == "object" and .used_percentage != null and .resets_at != null)
      | {pct: (.used_percentage | pct), at: (.resets_at | epoch)};
    .rate_limits
    | {five: (.five_hour | bucket), weekly: [.seven_day | bucket]}
    | select(.weekly | length > 0)
    | line("statusline")' "$state" 2>/dev/null; then
    reasons="${reasons}statusline:bad-snapshot,"
    return 1
  fi
}

# An API-key login (DEV_CLAUDE_AUTH=api-key) has no plan windows to read: neither source is tried, so
# no token is sent anywhere. The loop reads spend against a budget instead (factory-loop hooks/spend.ts).
if [ "${DEV_CLAUDE_AUTH-}" = api-key ]; then
  line="usage=unavailable reason=subscription:api-key-mode auth=api-key"
else
  line=$(from_oauth || from_statusline || echo "usage=unavailable reason=${reasons%,}")
fi
printf '%s\n' "$line"
# The factory event log (cbundy/dev-system#218), best effort: the reading as a native `usage` event
# (callum-flow-event --type usage --data). Only a check is recorded, not --record, which runs on every
# status line refresh.
if command -v callum-flow-event >/dev/null 2>&1; then
  data=$(printf '%s' "$line" | jq -Rc "$TO_DATA_JQ" 2>/dev/null) || data=
  # A subscription login's reading names it and carries the loop's what-if total (check mode only: --to-data
  # stays a pure translation of the printed line).
  if [ -n "$data" ] && [ "${DEV_CLAUDE_AUTH-}" != api-key ]; then
    data=$(printf '%s' "$data" | jq -c \
      --arg usd "${CALLUM_USAGE_SPEND_USD-}" --arg at "${CALLUM_USAGE_SPEND_RESETS_AT-}" \
      --arg why "${CALLUM_USAGE_SPEND_REASON-}" "$SUBSCRIPTION_JQ" 2>/dev/null) || data=
  fi
  [ -z "$data" ] || callum-flow-event --type usage --actor watcher --data "$data" >/dev/null 2>&1 || :
fi
