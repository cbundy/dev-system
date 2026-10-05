# shellcheck shell=sh
#
# telemetry.sh: the opt-in OpenTelemetry switch for Claude Code
# (cbundy/dev-system#68). Sourced, not run: by dev-remote-control right
# before each Claude start, by login shells (/etc/profile.d) and interactive
# bash (/etc/bash.bashrc), and by dev-init and dev-doctor. POSIX sh, since
# /etc/profile can be read by sh as well as bash.
#
# The runtime opts in by setting OTEL_EXPORTER_OTLP_ENDPOINT (and, if it
# likes, OTEL_RESOURCE_ATTRIBUTES); the image never carries an endpoint. With
# one set, Claude Code's metrics and events (logs) go to it over OTLP, by
# default http/protobuf (port 4318 on most collectors). Unset or empty,
# nothing here is set and nothing is exported. A value the runtime already
# set always wins, so CLAUDE_CODE_ENABLE_TELEMETRY=0 turns Claude's export
# off and OTEL_EXPORTER_OTLP_PROTOCOL=grpc picks gRPC. Prompt text and tool
# details stay redacted: OTEL_LOG_USER_PROMPTS and OTEL_LOG_TOOL_DETAILS are
# never set here. codex reads no environment for this; dev-init writes its
# [otel] table from the same variables.

if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
  : "${CLAUDE_CODE_ENABLE_TELEMETRY:=1}"
  : "${OTEL_METRICS_EXPORTER:=otlp}"
  : "${OTEL_LOGS_EXPORTER:=otlp}"
  : "${OTEL_EXPORTER_OTLP_PROTOCOL:=http/protobuf}"
  export CLAUDE_CODE_ENABLE_TELEMETRY OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER OTEL_EXPORTER_OTLP_PROTOCOL
fi
