#!/bin/sh
#
# Print the Claude plan's current usage as one line, for the issue-orchestrator
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
#    CLAUDE_CODE_OAUTH_TOKEN or $CLAUDE_CONFIG_DIR/.credentials.json
#    (default ~/.claude). Claude Code keeps that file's token refreshed while
#    a session runs.
# 2. statusline - a snapshot written by this script's --record mode (below),
#    used only while it is younger than CALLUM_USAGE_MAX_AGE seconds
#    (default 900): 5-hour utilization only rises until its reset, so an old
#    snapshot under-reports.
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
# Environment: CALLUM_USAGE_STATE (snapshot path, default
# ${XDG_STATE_HOME:-~/.local/state}/callum-tools/usage.json),
# CALLUM_USAGE_MAX_AGE, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR.
set -eu

URL=https://api.anthropic.com/api/oauth/usage
state=${CALLUM_USAGE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/callum-tools/usage.json}
max_age=${CALLUM_USAGE_MAX_AGE:-900}

usage() {
  echo "usage: usage-check.sh [--record]" >&2
  exit 2
}

case "$#:${1-}" in
  0:) mode=check ;;
  1:--record) mode=record ;;
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
  creds=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json
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

line=$(from_oauth || from_statusline || echo "usage=unavailable reason=${reasons%,}")
printf '%s\n' "$line"
# record_event: the factory event log (cbundy/dev-system#218), best effort.
# Only a check is recorded, not --record, which runs on every status line refresh.
if command -v callum-flow-event >/dev/null 2>&1; then
  callum-flow-event usage --actor watcher --note "$line" >/dev/null 2>&1 || :
fi
