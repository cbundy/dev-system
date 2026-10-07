# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 5 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 5. dev-init"
vol=$(docker volume create --label "$RUN_ID")
check "dev-init runs twice cleanly on an empty volume at /persist" in_image '
  set -e
  dev-init; dev-init
  grep -q "^sandbox_mode = \"danger-full-access\"" /persist/codex/config.toml
  [ "$(grep -c "^sandbox_mode" /persist/codex/config.toml)" = 1 ]
  . /usr/local/share/dev-system/models.sh
  env=/usr/local/share/dev-system/models.env cfg=/persist/no-mistakes/config.yaml
  grep -qx "# BEGIN dev-system managed (rewritten on every start - edit outside this block)" $cfg
  [ "$(grep -c "^# END dev-system managed$" $cfg)" = 1 ]
  [ "$(grep -c "^agent_args_override:" $cfg)" = 1 ]
  grep -qx -- "    - $(models_value $env CODEX_MODEL)" $cfg
  grep -qx -- "    - $(models_value $env CLAUDE_MODEL)" $cfg
  [ "$(models_value $env AGENTS)" = codex,claude ]
  [ "$(grep -c "^agent:" $cfg)" = 1 ]
  sed -n "/^# BEGIN dev-system managed/,/^# END dev-system managed\$/p" $cfg | grep -qxF "agent: [codex, claude]"' \
  -v "$vol:/persist" --entrypoint ""
check "dev-init on an empty volume mounted at /persist leaves node-owned subdirs" in_image '
  for d in claude codex gh no-mistakes agentsview; do [ "$(stat -c %u "/persist/$d")" = 1000 ] || exit 1; done' \
  -v "$vol:/persist"
check "dev-init seeds installMethod into an existing .claude.json without touching other keys" in_image '
  set -e
  echo "{\"keep\":1}" > /persist/claude/.claude.json
  dev-init >/dev/null 2>&1; dev-init >/dev/null 2>&1
  # claude itself (via dev-doctor) adds keys too, so only these two are compared
  [ "$(jq -c "{keep, installMethod}" /persist/claude/.claude.json)" = "{\"keep\":1,\"installMethod\":\"native\"}" ]
  [ "$(stat -c %a /persist/claude/.claude.json)" = 600 ]'
check "dev-init keeps an existing top-level sandbox_mode and ignores one inside a table" in_image '
  set -e
  printf "sandbox_mode = \"workspace-write\"\n" > /persist/codex/config.toml
  dev-init >/dev/null 2>&1
  [ "$(cat /persist/codex/config.toml)" = "sandbox_mode = \"workspace-write\"" ]
  printf "[profiles.x]\nsandbox_mode = \"read-only\"\n" > /persist/codex/config.toml
  dev-init >/dev/null 2>&1
  head -n 2 /persist/codex/config.toml | grep -qx "sandbox_mode = \"danger-full-access\""
  grep -qx "\[profiles.x\]" /persist/codex/config.toml'
check "DEV_CODEX_MODEL / DEV_CLAUDE_MODEL rewrite the managed pin in place, and empty removes it" in_image '
  set -e
  cfg=/persist/no-mistakes/config.yaml
  printf "agent: codex\n" > $cfg
  DEV_CODEX_MODEL=my-model DEV_CLAUDE_MODEL=my-claude dev-init >/dev/null 2>&1
  grep -qx -- "    - my-model" $cfg && grep -qx -- "    - my-claude" $cfg
  printf "\nkeep: 1\n" >> $cfg
  DEV_CODEX_MODEL=other-model DEV_CLAUDE_MODEL= dev-init >/dev/null 2>&1
  grep -qx -- "    - other-model" $cfg && ! grep -q "my-model\|my-claude\|  claude:" $cfg
  [ "$(head -n 1 $cfg)" = "agent: codex" ] && [ "$(tail -n 1 $cfg)" = "keep: 1" ]
  DEV_CODEX_MODEL= dev-init >/dev/null 2>&1
  ! grep -q "agent_args_override\|dev-system managed" $cfg || exit 1
  [ "$(cat $cfg)" = "$(printf "agent: codex\n\nkeep: 1")" ]' \
  --entrypoint ""
# The claude fallback's effort (cbundy/job-search#206): CLAUDE_EFFORT from the
# baked models file, written as claude's --effort after its --model.
check "dev-init pins the claude fallback's effort from models.env, DEV_CLAUDE_EFFORT overrides it, and empty drops it" in_image '
  set -e
  . /usr/local/share/dev-system/models.sh
  env=/usr/local/share/dev-system/models.env cfg=/persist/no-mistakes/config.yaml
  claude() { sed -n "/^  claude:\$/,/^# END dev-system managed\$/p" $cfg | sed "\$d"; }
  rm -f $cfg
  out=$(DEV_MODELS_URL= dev-init 2>&1); echo "$out" | grep -i "managed"
  [ "$(claude)" = "$(printf "  claude:\n    - --model\n    - %s\n    - --effort\n    - %s" "$(models_value $env CLAUDE_MODEL)" "$(models_value $env CLAUDE_EFFORT)")" ]
  echo "$out" | grep -qF ", claude effort $(models_value $env CLAUDE_EFFORT)"
  DEV_MODELS_URL= DEV_CLAUDE_EFFORT=high dev-init >/dev/null 2>&1
  [ "$(grep -c -- "--effort" $cfg)" = 1 ] && claude | grep -qx -- "    - high"
  DEV_MODELS_URL= DEV_CLAUDE_EFFORT= dev-init >/dev/null 2>&1
  ! grep -q -- "--effort" $cfg || exit 1
  claude | grep -qx -- "    - --model"' \
  --entrypoint ""
# The pipeline's agent order (cbundy/dev-system#163): the AGENTS list, written
# as `agent: [...]` in the managed block, beside the model pin.
check "DEV_NM_AGENTS rewrites the managed agent order in place, empty drops it, and a hand-set agent wins" in_image '
  set -e
  cfg=/persist/no-mistakes/config.yaml
  printf "keep: 1\n" > $cfg
  DEV_MODELS_URL= DEV_NM_AGENTS=claude dev-init >/dev/null 2>&1
  managed() { sed -n "/^# BEGIN dev-system managed/,/^# END dev-system managed\$/p" $cfg; }
  managed | grep -qxF "agent: [claude]"
  [ "$(grep -c "^agent:" $cfg)" = 1 ] && [ "$(head -n 1 $cfg)" = "keep: 1" ]
  managed | grep -q "^agent_args_override:"
  out=$(DEV_MODELS_URL= DEV_NM_AGENTS=claude,codex dev-init 2>&1); echo "$out" | grep -i "managed"
  managed | grep -qxF "agent: [claude, codex]"
  echo "$out" | grep -qF "dev-init: no-mistakes managed block in $cfg: agents claude,codex;"
  DEV_MODELS_URL= DEV_NM_AGENTS= dev-init >/dev/null 2>&1
  ! grep -q "^agent:" $cfg || exit 1
  managed | grep -q "^agent_args_override:"
  printf "agent: [claude]\n" > $cfg
  out=$(DEV_MODELS_URL= dev-init 2>&1)
  [ "$(grep -c "^agent:" $cfg)" = 1 ] && [ "$(head -n 1 $cfg)" = "agent: [claude]" ]
  managed | grep -q "^agent_args_override:"
  echo "$out" | grep -q "pin-codex-model: left the hand-set agent in"
  printf "AGENTS=claude\n" > /tmp/m.env
  rm $cfg
  DEV_MODELS_URL=file:///tmp/m.env dev-init >/dev/null 2>&1
  managed | grep -qxF "agent: [claude]"' \
  --entrypoint ""
# The models file fetched on every start (cbundy/dev-system#162), served over
# file:// so no network is needed: per key over the baked file, env over both.
check "dev-init pins the models fetched from DEV_MODELS_URL, per key over the baked ones, env over both" in_image '
  set -e
  . /usr/local/share/dev-system/models.sh
  env=/usr/local/share/dev-system/models.env cfg=/persist/no-mistakes/config.yaml
  printf "CODEX_MODEL=fetched-codex\nCLAUDE_MODEL=not;valid\n" > /tmp/m.env
  out=$(DEV_MODELS_URL=file:///tmp/m.env dev-init 2>&1); echo "$out" | grep -i model
  grep -qx -- "    - fetched-codex" $cfg
  grep -qx -- "    - $(models_value $env CLAUDE_MODEL)" $cfg
  echo "$out" | grep -qF "dev-init: models read from file:///tmp/m.env, with the image"
  if echo "$out" | grep -q "WARNING: could not use the models file"; then exit 1; fi
  out=$(DEV_MODELS_URL=file:///tmp/m.env dev-init 2>&1)
  if echo "$out" | grep -q "models read from"; then echo "logged with the pin unchanged"; exit 1; fi
  DEV_MODELS_URL=file:///tmp/m.env DEV_CODEX_MODEL=env-codex dev-init >/dev/null 2>&1
  grep -qx -- "    - env-codex" $cfg
  [ -z "$(find /tmp -maxdepth 1 -name "dev-models.*")" ]' \
  --entrypoint ""
check "dev-init falls back to the baked models with one WARNING when the fetch fails, and an empty DEV_MODELS_URL skips it" in_image '
  set -e
  . /usr/local/share/dev-system/models.sh
  env=/usr/local/share/dev-system/models.env cfg=/persist/no-mistakes/config.yaml
  baked="    - $(models_value $env CODEX_MODEL)"
  for url in file:///tmp/missing.env https://127.0.0.1:1/models.env; do
    out=$(DEV_MODELS_URL=$url dev-init 2>&1; echo "rc=$?"); echo "$out" | grep -i "model\|rc="
    echo "$out" | grep -qx "rc=0"
    [ "$(echo "$out" | grep -c "WARNING: could not use the models file from $url (")" = 1 ]
    grep -qx -- "$baked" $cfg
    printf "agent: codex\n" > $cfg
  done
  printf "nothing here\n" > /tmp/m.env
  out=$(DEV_MODELS_URL=file:///tmp/m.env dev-init 2>&1)
  keys=$(echo "$MODELS_KEYS" | sed "s/ /, /g; s/, \([^,]*\)\$/ or \1/")
  echo "$out" | grep -qF "WARNING: could not use the models file from file:///tmp/m.env (it sets no valid $keys)"
  grep -qx -- "$baked" $cfg
  printf "CODEX_MODEL=fetched-codex\n" > /tmp/m.env
  out=$(DEV_MODELS_URL= dev-init 2>&1)
  if echo "$out" | grep -q "models file\|models read from"; then exit 1; fi
  grep -qx -- "$baked" $cfg
  [ -z "$(find /tmp -maxdepth 1 -name "dev-models.*")" ]' \
  --entrypoint ""
check "dev-init migrates the unmarked pin an older image wrote, and a hand-set one drops only the pin" in_image '
  set -e
  cfg=/persist/no-mistakes/config.yaml
  printf "\n# Codex model pin, written by the callum-tools devcontainer feature (global-only key).\nagent_args_override:\n  codex:\n    - -m\n    - gpt-old\n" > $cfg
  dev-init >/dev/null 2>&1
  ! grep -q "gpt-old\|callum-tools devcontainer feature" $cfg || exit 1
  grep -q "^# BEGIN dev-system managed" $cfg && [ "$(grep -c "^agent_args_override:" $cfg)" = 1 ]
  printf "agent_config:\n  codex: {}\n" > $cfg
  out=$(dev-init 2>&1)
  [ "$(head -n 2 $cfg)" = "$(printf "agent_config:\n  codex: {}")" ]
  [ "$(grep -c "^agent_config:\|^agent_args_override:" $cfg)" = 1 ]
  grep -qxF "agent: [codex, claude]" $cfg
  echo "$out" | grep -q "pin-codex-model: left the hand-set agent_args_override"' \
  --entrypoint ""
rootvol=$(docker volume create --label "$RUN_ID")
# The volume must not be empty, or Docker copies the image's node-owned
# directory into it again on the next mount.
docker run --rm --user root -v "$rootvol:/persist/claude" "$IMAGE" \
  bash -c 'touch /persist/claude/.root-owned && chown -R root:root /persist/claude'
check "dev-init warns but exits 0 (twice) with a root-owned /persist/claude" in_image '
  out=$( { dev-init; echo "rc=$?"; dev-init; echo "rc=$?"; } 2>&1 )
  echo "$out"
  [ "$(echo "$out" | grep -c "^rc=0$")" = 2 ] &&
  echo "$out" | grep -q "WARNING: /persist/claude is not writable" &&
  echo "$out" | grep -q "chown 1000:1000" &&
  echo "$out" | grep -q "FAIL claude state dir"' \
  -v "$rootvol:/persist/claude"
# The start-up warning for /persist dirs with no volume behind them (#78):
# loud, naming each one, but never failing the start.
check "dev-init warns (exit 0) naming every /persist dir with no volume, only those" bash -c "
  out=\$(docker run --rm --entrypoint '' '$IMAGE' bash -c 'dev-init; echo rc=\$?' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -qx 'rc=0' &&
  echo \"\$out\" | grep -qF 'dev-init: WARNING: no volume behind /persist/claude /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview - ' &&
  echo \"\$out\" | grep -qF 'npx callum-dev update --devcontainer base-image' &&
  out=\$(docker run --rm --entrypoint '' -v \"\$(docker volume create --label '$RUN_ID'):/persist/claude\" '$IMAGE' dev-init 2>&1) &&
  echo \"\$out\" | grep -qF 'dev-init: WARNING: no volume behind /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview - '"
check "dev-init: no volume warning with one volume for all of /persist (the k8s / Coder shape)" in_image '
  out=$(dev-init 2>&1); echo "$out"
  ! echo "$out" | grep -q "no volume behind"' \
  -v "$vol:/persist" --entrypoint ""
check "dev-init: no volume warning with a volume per /persist dir (the devcontainer shape)" bash -c "
  args=()
  for t in claude codex gh no-mistakes agentsview; do
    args+=(-v \"\$(docker volume create --label '$RUN_ID'):/persist/\$t\")
  done
  out=\$(docker run --rm --entrypoint '' \"\${args[@]}\" '$IMAGE' dev-init 2>&1)
  echo \"\$out\"
  ! echo \"\$out\" | grep -q 'no volume behind'"

# The no-mistakes daemon (cbundy/dev-system#101): with no systemd in the
# container, systemctl must fail, so `daemon start` falls back to running the
# daemon itself at once instead of waiting 135s on a unit that never starts.
check "systemctl fails without systemd, and no build-time systemd unit ships" in_image '
  out=$(systemctl --user daemon-reload 2>&1); rc=$?; echo "$out"
  [ $rc -ne 0 ] && echo "$out" | grep -q "systemd is not running" && [ ! -e ~/.config/systemd ]' \
  --entrypoint ""
check "dev-init starts the no-mistakes daemon and registers a gated repo within 30s" in_image '
  git init -q --bare /tmp/origin.git && git init -q /tmp/r && git -C /tmp/r remote add origin /tmp/origin.git
  touch /tmp/r/.no-mistakes.yaml && cd /tmp/r
  start=$(date +%s); out=$(dev-init 2>&1); took=$(($(date +%s) - start))
  echo "$out"; echo "dev-init took ${took}s"
  [ "$took" -lt 30 ] && ! echo "$out" | grep -q "WARNING: no-mistakes" &&
  echo "$out" | grep -qF "dev-doctor: OK   no-mistakes: /tmp/r is registered" && no-mistakes daemon status </dev/null' \
  --entrypoint ""
check "dev-init restarts a running no-mistakes daemon only when the managed block changed" in_image '
  set -e
  git init -q /tmp/r && touch /tmp/r/.no-mistakes.yaml && cd /tmp/r
  pid() { no-mistakes daemon status </dev/null 2>&1 | sed -n "s/.*daemon running (pid \([0-9]*\)).*/\1/p"; }
  dev-init >/dev/null 2>&1
  first=$(pid); [ -n "$first" ]
  out=$(dev-init 2>&1)
  ! echo "$out" | grep -q "restarted the no-mistakes daemon" || exit 1
  [ "$(pid)" = "$first" ]
  out=$(DEV_CODEX_MODEL=changed-model dev-init 2>&1); echo "$out"
  echo "$out" | grep -qF "dev-init: restarted the no-mistakes daemon so it runs on the new agent order and model pin"
  second=$(pid); [ -n "$second" ] && [ "$second" != "$first" ]
  out=$(DEV_CODEX_MODEL=changed-model DEV_NM_AGENTS=claude dev-init 2>&1); echo "$out"
  echo "$out" | grep -qF "dev-init: restarted the no-mistakes daemon so it runs on the new agent order and model pin"
  third=$(pid); [ -n "$third" ] && [ "$third" != "$second" ]' \
  --entrypoint ""
