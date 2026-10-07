# shellcheck shell=bash
#
# codex-otel.sh: codex's telemetry config (cbundy/dev-system#68, #171).
# Sourced by dev-init, which calls
#
#   codex_otel_configure <config.toml> <telemetry.sh>
#
# with a log function of its own defined (one line per call, on stderr).
#
# codex reads no OTEL_* environment, so with OTEL_EXPORTER_OTLP_ENDPOINT set,
# an [otel] table in config.toml points it there: logs, and metrics (which
# otherwise go to codex's default, statsig), over the protocol telemetry.sh
# settles on - gRPC to the endpoint as is, HTTP to its /v1/logs and
# /v1/metrics, since codex appends no signal path. Prompt text stays redacted
# (log_user_prompt = false); no traces.
#
# codex does read OTEL_RESOURCE_ATTRIBUTES, but then sets its own `env`
# resource attribute from [otel] environment (default "dev"), which beats the
# runtime's: without it every codex record is labelled env=dev, whatever the
# runtime set (#171). So the table carries the runtime's env, when
# OTEL_RESOURCE_ATTRIBUTES names one, as environment.
#
# The table sits between marker comments before the first table of the file
# (after its top-level keys), so codex's own appends - the [projects."..."]
# trust entries it adds at the end - land outside it. It is rewritten when the
# endpoint changes and removed when it is unset. A table found inside the
# markers that is not otel (codex appended one there while the block was
# still the last thing in the file) is kept, outside the markers. A user's own
# otel settings (any otel table or top-level otel key outside the markers)
# win: nothing is written then, and the log says so.

CODEX_OTEL_BEGIN='# BEGIN dev-system telemetry'
CODEX_OTEL_END='# END dev-system telemetry'

# codex_otel_env: print the value of the env key in OTEL_RESOURCE_ATTRIBUTES
# (comma-separated key=value pairs; the last env wins), or nothing.
codex_otel_env() {
  printf '%s' "${OTEL_RESOURCE_ATTRIBUTES:-}" | awk 'BEGIN { RS = "," } {
      i = index($0, "="); if (!i) next
      k = substr($0, 1, i - 1); v = substr($0, i + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      if (k == "env") env = v
    } END { printf "%s", env }'
}

# codex_otel_toml_string <value>: print value as a TOML basic string.
codex_otel_toml_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

codex_otel_configure() {
  local cfg=$1 telemetry=$2 ep="${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
  local had=false want=false rest proto codec exporter metrics env tmp
  [ -w "$(dirname "$cfg")" ] || return 0
  [ -f "$cfg" ] && grep -qxF -- "$CODEX_OTEL_BEGIN" "$cfg" && had=true
  # The file without the managed table and the blank lines before it. Inside
  # the markers, everything up to the first table that is not otel is ours;
  # from there to the end marker is codex's, and kept.
  rest=$(B="$CODEX_OTEL_BEGIN" E="$CODEX_OTEL_END" awk '
    $0 == ENVIRON["B"] { skip = 1; blanks = ""; next }
    skip && $0 == ENVIRON["E"] { skip = 0; next }
    skip == 1 {
      if ($0 ~ /^[[:space:]]*\[/ && $0 !~ /^[[:space:]]*\[\[?[[:space:]]*"?otel"?[[:space:]]*[].]/) skip = 2
      else next
    }
    /^[[:space:]]*$/ { blanks = blanks $0 "\n"; next }
    { printf "%s", blanks; blanks = ""; print }' "$cfg" 2>/dev/null)
  if [ -n "$ep" ]; then
    if printf '%s\n' "$rest" | awk '
      /^[[:space:]]*\[/ { in_table = 1 }
      /^[[:space:]]*\[\[?[[:space:]]*"?otel"?[[:space:]]*[].]/ { found = 1 }
      !in_table && /^[[:space:]]*"?otel"?[[:space:]]*[.=]/ { found = 1 }
      END { exit !found }'; then
      log "left the otel settings already in $cfg alone - codex telemetry follows them, not OTEL_EXPORTER_OTLP_ENDPOINT"
    else
      want=true
    fi
  fi
  [ "$had" = true ] || [ "$want" = true ] || return 0

  if [ "$want" = true ]; then
    # shellcheck source=telemetry.sh
    proto=$(. "$telemetry" && echo "$OTEL_EXPORTER_OTLP_PROTOCOL")
    ep=${ep%/}
    case "$proto" in
      grpc)
        exporter="{ otlp-grpc = { endpoint = $(codex_otel_toml_string "$ep") } }"
        metrics=$exporter
        ;;
      *)
        if [ "$proto" = http/json ]; then codec=json; else codec=binary; fi
        exporter="{ otlp-http = { endpoint = $(codex_otel_toml_string "$ep/v1/logs"), protocol = \"$codec\" } }"
        metrics="{ otlp-http = { endpoint = $(codex_otel_toml_string "$ep/v1/metrics"), protocol = \"$codec\" } }"
        ;;
    esac
    env=$(codex_otel_env)
  fi
  tmp=$(mktemp "$cfg.XXXXXX") || return 0
  {
    if [ "$want" = true ]; then
      # Top-level keys (and the comments right above the first table, which
      # belong to it) first, then the block, then the tables.
      printf '%s\n' "$rest" | awk '
        { line[NR] = $0 }
        END {
          n = (NR == 1 && line[1] == "") ? 0 : NR
          t = n + 1
          for (i = 1; i <= n; i++) if (line[i] ~ /^[[:space:]]*\[/) { t = i; break }
          s = t; while (s > 1 && line[s - 1] ~ /^[[:space:]]*#/) s--
          h = s - 1; while (h > 0 && line[h] ~ /^[[:space:]]*$/) h--
          for (i = 1; i <= h; i++) print line[i]
          if (h > 0) print ""
          print "@BLOCK@"
          if (s <= n) print ""
          for (i = s; i <= n; i++) print line[i]
        }' | while IFS= read -r line; do
        if [ "$line" != @BLOCK@ ]; then
          printf '%s\n' "$line"
          continue
        fi
        echo "$CODEX_OTEL_BEGIN"
        echo '# Written by dev-init from OTEL_EXPORTER_OTLP_ENDPOINT and removed when that is unset'
        echo '# (cbundy/dev-system#68). Edits here are lost: for settings of your own, replace this'
        echo '# whole block, markers included, with your own [otel] table.'
        echo '[otel]'
        echo 'log_user_prompt = false'
        [ -z "$env" ] || echo "environment = $(codex_otel_toml_string "$env")"
        echo "exporter = $exporter"
        echo "metrics_exporter = $metrics"
        echo "$CODEX_OTEL_END"
      done
    else
      [ -z "$rest" ] || printf '%s\n' "$rest"
    fi
  } > "$tmp"
  if [ -f "$cfg" ] && cmp -s "$tmp" "$cfg"; then
    rm -f "$tmp"
    return 0
  fi
  if mv "$tmp" "$cfg"; then
    if [ "$want" = true ]; then
      log "codex telemetry export on: [otel] in $cfg sends to $OTEL_EXPORTER_OTLP_ENDPOINT ($proto${env:+, env $env})"
    elif [ -n "$ep" ]; then
      log "removed dev-init's [otel] from $cfg: the otel settings of your own win"
    else
      log "codex telemetry export off: removed dev-init's [otel] from $cfg (OTEL_EXPORTER_OTLP_ENDPOINT is unset)"
    fi
  fi
  rm -f "$tmp"
}
