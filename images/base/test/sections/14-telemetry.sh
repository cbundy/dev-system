# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 14 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 14. opt-in telemetry export (OTEL_EXPORTER_OTLP_ENDPOINT)"

# The flags telemetry.sh sets, as one line: name=value pairs, sorted.
TELEMETRY_FLAGS='CLAUDE_CODE_ENABLE_TELEMETRY|OTEL_METRICS_EXPORTER|OTEL_LOGS_EXPORTER|OTEL_EXPORTER_OTLP_PROTOCOL'
ON_FLAGS='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp'
# Claude started by hand: a stub claude (by absolute path, since a login
# shell resets PATH) writes its environment to /tmp/claude-env-<how>, from a
# login shell (coder ssh), an interactive bash (docker exec -it ... bash) and
# a tmux window. The tmux server is started first from this non-interactive
# shell, without the flags, as dev-login's would be. Prints one line per path
# with the flags that claude saw.
SHELL_PATHS='mkdir -p /tmp/envstub && printf "#!/bin/sh\nenv > /tmp/claude-env-\$1\n" > /tmp/envstub/claude && chmod +x /tmp/envstub/claude
  bash -lc "/tmp/envstub/claude login"
  bash -ic "/tmp/envstub/claude interactive" 2>/dev/null
  tmux new-session -d -s pre sleep infinity && tmux new-session -d -s user -x 200 -y 50
  tmux send-keys -t user "/tmp/envstub/claude tmux" Enter
  for _ in $(seq 20); do [ -s /tmp/claude-env-tmux ] && break; sleep 0.5; done
  tmux kill-server
  for p in login interactive tmux; do
    echo "$p: $(grep -E "^($TELEMETRY_FLAGS)=" /tmp/claude-env-$p | sort | xargs)"
  done'
# rc_telemetry <expected flags> <docker run args...>: the supervisor against the stub Claude
# (logged in), with a tmux server already running without the flags (started
# like dev-login's, from a process that never sourced telemetry.sh); prints
# the flags in the environment Claude was started with.
rc_telemetry() {
  local want="$1" c out
  shift
  c=$(run_bg -e STUB="$STUB" "$@" "$IMAGE" bash -c "
    touch /tmp/logged-in && tmux new-session -d -s pre sleep infinity && $WITH_STUB exec dev-remote-control")
  for _ in $(seq 20); do docker exec "$c" test -s /tmp/claude-env && break; sleep 1; done
  out=$(docker exec -e TELEMETRY_FLAGS="$TELEMETRY_FLAGS" "$c" bash -c 'grep -E "^($TELEMETRY_FLAGS)=" /tmp/claude-env | sort | xargs; test -s /tmp/claude-env')
  docker rm -f "$c" >/dev/null
  echo "claude saw: [$out]"
  [ "$out" = "$want" ]
}

check "no endpoint: no telemetry flag reaches Claude under dev-remote-control" rc_telemetry ""
check "endpoint set: Claude under dev-remote-control gets the flags (http/protobuf), even from an older tmux server" \
  rc_telemetry "$ON_FLAGS" -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4318
check "endpoint set: a protocol and an opt-out the runtime set are kept" rc_telemetry \
  "CLAUDE_CODE_ENABLE_TELEMETRY=0 OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp" \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4317 -e OTEL_EXPORTER_OTLP_PROTOCOL=grpc -e CLAUDE_CODE_ENABLE_TELEMETRY=0
check "no endpoint: no telemetry flag in a login shell, interactive bash or tmux window" bash -c "
  out=\$(docker run --rm --entrypoint '' -e TELEMETRY_FLAGS='$TELEMETRY_FLAGS' '$IMAGE' bash -c '$SHELL_PATHS'); echo \"\$out\"
  [ \"\$out\" = \"\$(printf 'login: \ninteractive: \ntmux: ')\" ]"
check "endpoint set: a login shell, interactive bash and tmux window get the flags, with the runtime's protocol" bash -c "
  out=\$(docker run --rm --entrypoint '' -e TELEMETRY_FLAGS='$TELEMETRY_FLAGS' -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4318 \
    '$IMAGE' bash -c '$SHELL_PATHS'); echo \"\$out\"
  [ \"\$out\" = \"\$(printf 'login: %s\ninteractive: %s\ntmux: %s' '$ON_FLAGS' '$ON_FLAGS' '$ON_FLAGS')\" ] &&
  out=\$(docker run --rm --entrypoint '' -e TELEMETRY_FLAGS='$TELEMETRY_FLAGS' -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4317 \
    -e OTEL_EXPORTER_OTLP_PROTOCOL=grpc '$IMAGE' bash -c '$SHELL_PATHS') && echo \"\$out\" &&
  [ \"\$(echo \"\$out\" | grep -c 'OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_LOGS_EXPORTER')\" = 3 ]"

check "codex, no endpoint: dev-init leaves config.toml byte for byte as it was" in_image '
  printf "sandbox_mode = \"workspace-write\"\n\n[profiles.x]\nmodel = \"m\"\n" > /persist/codex/config.toml
  cp /persist/codex/config.toml /tmp/before
  dev-init >/dev/null 2>&1
  cat /persist/codex/config.toml; cmp /tmp/before /persist/codex/config.toml' --entrypoint ""
check "codex, endpoint set: dev-init writes one [otel] (OTLP/HTTP logs and metrics, prompts redacted, the runtime's env) that codex loads" in_image '
  dev-init 2>&1 | grep "otel"; dev-init >/dev/null 2>&1
  f=/persist/codex/config.toml; cat $f
  [ "$(grep -c "^\[otel\]" $f)" = 1 ] && grep -q "^sandbox_mode" $f && grep -qx "log_user_prompt = false" $f &&
  grep -qxF "exporter = { otlp-http = { endpoint = \"http://collector.invalid:4318/v1/logs\", protocol = \"binary\" } }" $f &&
  grep -qxF "metrics_exporter = { otlp-http = { endpoint = \"http://collector.invalid:4318/v1/metrics\", protocol = \"binary\" } }" $f &&
  ! grep -q trace_exporter $f && grep -qx "environment = \"coder\"" $f &&
  out=$(codex login status 2>&1); echo "codex: $out"; ! echo "$out" | grep -q "Error loading configuration"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4318/ -e OTEL_RESOURCE_ATTRIBUTES=host=h,env=coder --entrypoint ""
check "codex, grpc: the [otel] exporters are otlp-grpc to the endpoint as is, and codex loads it" in_image '
  dev-init >/dev/null 2>&1; f=/persist/codex/config.toml; cat $f
  grep -qxF "exporter = { otlp-grpc = { endpoint = \"http://collector.invalid:4317\" } }" $f &&
  grep -qxF "metrics_exporter = { otlp-grpc = { endpoint = \"http://collector.invalid:4317\" } }" $f &&
  out=$(codex login status 2>&1); echo "codex: $out"; ! echo "$out" | grep -q "Error loading configuration"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4317 -e OTEL_EXPORTER_OTLP_PROTOCOL=grpc --entrypoint ""
check "codex: a new endpoint replaces dev-init's [otel], and unsetting it removes it, leaving the rest as it was" in_image '
  f=/persist/codex/config.toml
  printf "sandbox_mode = \"workspace-write\"\n\n[profiles.x]\nmodel = \"m\"\n" > $f && cp $f /tmp/before
  OTEL_EXPORTER_OTLP_ENDPOINT=http://a.invalid:4318 dev-init >/dev/null 2>&1
  out=$(OTEL_EXPORTER_OTLP_ENDPOINT=http://b.invalid:4318 dev-init 2>&1); echo "$out" | grep otel; cat $f
  [ "$(grep -c "^\[otel\]" $f)" = 1 ] && grep -q b.invalid $f && ! grep -q a.invalid $f || exit 1
  out=$(dev-init 2>&1); echo "$out" | grep otel
  echo "$out" | grep -qF "codex telemetry export off: removed dev-init'"'"'s [otel] from $f" && cmp /tmp/before $f' --entrypoint ""
check "codex: a user's own [otel] is left alone (logged), and wins over dev-init's" in_image '
  f=/persist/codex/config.toml
  printf "sandbox_mode = \"workspace-write\"\n\n[otel]\nenvironment = \"mine\"\n" > $f && cp $f /tmp/before
  out=$(dev-init 2>&1); echo "$out" | grep otel
  echo "$out" | grep -qF "left the otel settings already in $f alone" && cmp /tmp/before $f || exit 1
  # dev-init'"'"'s table first, then a user table added beside it: the user'"'"'s wins
  printf "sandbox_mode = \"workspace-write\"\n" > $f && dev-init >/dev/null 2>&1
  printf "\n[otel]\nenvironment = \"mine\"\n" >> $f
  dev-init >/dev/null 2>&1; cat $f
  [ "$(grep -c "^\[otel\]" $f)" = 1 ] && grep -qx "environment = \"mine\"" $f && ! grep -q "dev-system telemetry" $f &&
  ! codex login status 2>&1 | grep -q "Error loading configuration"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4318 --entrypoint ""

check "dev-doctor: telemetry off is an INFO line without an endpoint" in_image '
  out=$(dev-doctor --warn-only); echo "$out" | grep -i telemetry
  echo "$out" | grep -qxF "dev-doctor: INFO telemetry export is off (OTEL_EXPORTER_OTLP_ENDPOINT is not set)"' --entrypoint ""
check "dev-doctor: an endpoint nothing listens on is reported, as INFO, not a failure" in_image '
  out=$(dev-doctor --warn-only); echo "$out" | grep -i telemetry
  echo "$out" | grep -qxF "dev-doctor: INFO telemetry export is on: http://127.0.0.1:1 (http/protobuf), NOT reachable (no connection within 2s)" &&
  ! echo "$out" | grep -E "^dev-doctor: (FAIL|WARN)" | grep -qi telemetry' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1 --entrypoint ""
check "dev-doctor: a listening endpoint is reachable, with the runtime's protocol" in_image '
  (node -e "require(\"net\").createServer((s) => s.end()).listen(4317)" &) && sleep 1
  out=$(dev-doctor --warn-only); echo "$out" | grep -i telemetry
  echo "$out" | grep -qxF "dev-doctor: INFO telemetry export is on: http://127.0.0.1:4317 (grpc), reachable"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317 -e OTEL_EXPORTER_OTLP_PROTOCOL=grpc --entrypoint ""
