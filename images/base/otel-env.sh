# shellcheck shell=sh
#
# dev-system: opt-in OpenTelemetry export for Claude Code (cbundy/dev-system#68).
#
# Installed as /etc/profile.d/dev-system-otel.sh and sourced by every shell
# the image knows how to reach (see images/base/README.md, "Telemetry"):
# login shells (/etc/profile), interactive bash (/etc/bash.bashrc),
# non-interactive bash (BASH_ENV, so scripts and `bash -c` too) and zsh
# (/etc/zsh/zshenv). So a `claude` started from any of them - a terminal, tmux,
# `claude remote-control`, a Coder startup script or the no-mistakes daemon,
# which resolves its environment from a login shell - gets the same switch.
#
# Telemetry is on only when the runtime sets OTEL_EXPORTER_OTLP_ENDPOINT. With
# it unset this file does nothing. A value the runtime already set always wins:
# only unset variables get a default. Prompt text stays off (OTEL_LOG_USER_PROMPTS
# is never set here). POSIX sh, quiet and side-effect free apart from the exports,
# because BASH_ENV sources it into every bash script in the container.
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
  export CLAUDE_CODE_ENABLE_TELEMETRY="${CLAUDE_CODE_ENABLE_TELEMETRY:-1}"
  export OTEL_METRICS_EXPORTER="${OTEL_METRICS_EXPORTER:-otlp}"
  export OTEL_LOGS_EXPORTER="${OTEL_LOGS_EXPORTER:-otlp}"
  # Claude Code has no default protocol. http/protobuf is the OpenTelemetry
  # spec default, so other OTel SDKs in the container see no change; set
  # OTEL_EXPORTER_OTLP_PROTOCOL=grpc in the runtime for a :4317 endpoint.
  export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/protobuf}"
fi
