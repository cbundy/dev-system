#!/bin/sh
# shellcheck disable=SC2016 # the stub scripts are written with literal $ on purpose
#
# Plain-shell test for images/base/dev-version (cbundy/dev-system#271).
#
# curl, gh, claude and the tools are stubs on PATH answering from a fixture, so no network,
# Docker or real install is involved.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CMD="$SCRIPT_DIR/../dev-version"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$CMD" ] || fail "$CMD is missing or not executable"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"
mkdir "$bin"

# curl: GHCR token and manifests, answered from $FIX/. A file $FIX/hang makes it sleep.
cat > "$bin/curl" <<'STUB'
#!/bin/sh
for a in "$@"; do url=$a; done
[ ! -f "$FIX/hang" ] || exec sleep 30
[ ! -f "$FIX/offline" ] || exit 6
case $url in
  */token*) cat "$FIX/token.json" ;;
  */manifests/2) cat "$FIX/index.json" ;;
  */manifests/sha256:m) cat "$FIX/manifest.json" ;;
  */blobs/sha256:c) cat "$FIX/config.json" ;;
  */@anthropic-ai%2fclaude-code/latest) echo "{\"version\":\"$(cat "$FIX/claude.latest")\"}" ;;
  */@openai%2fcodex/latest) echo "{\"version\":\"$(cat "$FIX/codex.latest")\"}" ;;
  *) exit 22 ;;
esac
STUB
cat > "$bin/gh" <<'STUB'
#!/bin/sh
[ ! -f "$FIX/hang" ] || exec sleep 30
[ ! -f "$FIX/offline" ] || exit 1
[ "$1" != --version ] || { echo "gh version 2.50.0 (2026-01-01)"; exit 0; }
# gh api repos/<owner>/<repo>/releases/latest --jq .tag_name
f="$FIX/gh.$(echo "$2" | cut -d/ -f3)"
[ -f "$f" ] && cat "$f"
STUB
cat > "$bin/claude" <<'STUB'
#!/bin/sh
case $1 in
  --version) echo "$(cat "$FIX/claude.run") (Claude Code)" ;;
  plugin) cat "$FIX/plugins.json" ;;
esac
STUB
printf '#!/bin/sh\necho "codex-cli $(cat "$FIX/codex.run")"\n' > "$bin/codex"
printf '#!/bin/sh\necho "no-mistakes version v$(cat "$FIX/nm.run") (abc) 2026-01-01"\n' > "$bin/no-mistakes"
printf '#!/bin/sh\necho "v$(cat "$FIX/treehouse.run")"\n' > "$bin/treehouse"
printf '#!/bin/sh\necho "agentsview v0.44.0 (commit abc)"\n' > "$bin/agentsview"
printf '#!/bin/sh\necho "Coder v2.36.6+abc Mon"\n' > "$bin/coder"
printf '#!/bin/sh\necho v20.11.1\n' > "$bin/node"
printf '#!/bin/sh\necho "psql (PostgreSQL) 16.3"\n' > "$bin/psql"
printf '#!/bin/sh\necho "tmux 3.4"\n' > "$bin/tmux"
chmod +x "$bin"/*

# A second bin dir whose curl and gh fail loudly (and leave a marker) when called.
nonet="$tmp/nonet"
mkdir "$nonet"
for t in curl gh; do
  printf '#!/bin/sh\necho "$0 $*" >> "%s/network-called"\nexit 99\n' "$tmp" > "$nonet/$t"
done
# gh --version is a local call: only gh api (the network) is loud.
printf '#!/bin/sh\n[ "$1" != --version ] || { echo "gh version 2.50.0"; exit 0; }\necho "$0 $*" >> "%s/network-called"\nexit 99\n' "$tmp" > "$nonet/gh"
chmod +x "$nonet"/*

FIX="$tmp/fix"
export FIX
reset() {
  rm -rf "$FIX"
  mkdir -p "$FIX" "$tmp/layers"
  rm -f "$tmp/layers"/*
  printf '{"token":"t"}' > "$FIX/token.json"
  printf '{"manifests":[{"digest":"sha256:m","platform":{"os":"linux"}}]}' > "$FIX/index.json"
  printf '{"config":{"digest":"sha256:c"}}' > "$FIX/manifest.json"
  printf '{"config":{"Labels":{"org.opencontainers.image.revision":"aaaaaaa1111"}}}' > "$FIX/config.json"
  echo 1.0.0 > "$FIX/claude.latest"; echo 1.0.0 > "$FIX/claude.run"
  echo 2.0.0 > "$FIX/codex.latest"; echo 2.0.0 > "$FIX/codex.run"
  echo 3.0.0 > "$FIX/nm.run"; echo v3.0.0 > "$FIX/gh.no-mistakes"
  echo 4.0.0 > "$FIX/treehouse.run"; echo v4.0.0 > "$FIX/gh.treehouse"
  echo v0.44.0 > "$FIX/gh.agentsview"; echo v2.36.6 > "$FIX/gh.coder"
  echo v0.2.0 > "$FIX/gh.dev-system"
  printf '[{"id":"callum-flow@callum","version":"0.2.0","scope":"user"}]' > "$FIX/plugins.json"
  cat > "$tmp/stamp" <<STAMP
IMAGE=ghcr.io/cbundy/dev-system/base
VERSION=2.13.0
REVISION=aaaaaaa1111
CREATED=2026-01-01T00:00:00Z
AGENTSVIEW_VERSION=0.44.0
CODER_VERSION=2.36.6
STAMP
}

# run_cmd [args]: runs the command with the stubs; sets $out and $rc.
run_cmd() {
  rc=0
  out=$(PATH="${EXTRA_PATH:+$EXTRA_PATH:}$bin:$PATH" DEV_VERSION_STAMP="${STAMP_FILE:-$tmp/stamp}" DEV_VERSION_STAMP_DIR="$tmp/layers" \
    DEV_SYSTEM_SHARE="$SCRIPT_DIR/.." DEV_VERSION_REGISTRY=https://reg.test DEV_VERSION_NPM=https://npm.test \
    DEV_DEFAULT_PLUGINS='callum-flow@callum=cbundy/dev-system#v0.2.0' "$CMD" "$@" 2>&1) || rc=$?
}

expect() { # expect <description> <rc> <grep pattern...>
  desc=$1 want=$2
  shift 2
  [ "$rc" -eq "$want" ] || fail "$desc: exit $rc, wanted $want. Output:
$out"
  for p in "$@"; do
    printf '%s\n' "$out" | grep -qE -- "$p" || fail "$desc: no line matching '$p'. Output:
$out"
  done
}

reset; run_cmd
expect "all current" 0 '^dev-version: OK base-image running=aaaaaaa latest=aaaaaaa' \
  '^dev-version: OK callum-flow@callum\(user\) running=0.2.0 pin=0.2.0' \
  '^dev-version: OK claude running=1.0.0 latest=1.0.0' '^dev-version: OK codex' \
  '^dev-version: OK no-mistakes' '^dev-version: OK treehouse' \
  '^dev-version: OK agentsview running=0.44.0 latest=0.44.0 pinned=0.44.0' \
  '^dev-version: OK coder' '^dev-version: INFO image-layers none'
printf '%s\n' "$out" | grep -q 'STALE' && fail "all current: a STALE line"

reset; printf '{"config":{"Labels":{"org.opencontainers.image.revision":"bbbbbbb2222"}}}' > "$FIX/config.json"; run_cmd
expect "newer image published" 1 '^dev-version: STALE base-image running=aaaaaaa latest=bbbbbbb'

reset; printf '[{"id":"callum-flow@callum","version":"0.1.0","scope":"user"}]' > "$FIX/plugins.json"; run_cmd
expect "plugin below the pin" 1 '^dev-version: STALE callum-flow@callum\(user\) running=0.1.0 pin=0.2.0'

reset; echo v0.3.0 > "$FIX/gh.dev-system"; run_cmd
expect "pin behind latest release notes the image line" 0 '^dev-version: OK base-image .*a newer image fixes that'

for t in claude codex; do
  reset; echo 9.9.9 > "$FIX/$t.latest"; run_cmd
  expect "$t behind upstream" 1 "^dev-version: STALE $t running="
done
reset; echo 9.9.9 > "$FIX/claude.run"; run_cmd
expect "tool ahead of upstream is current" 0 '^dev-version: OK claude'
for t in no-mistakes treehouse; do
  reset; echo v9.9.9 > "$FIX/gh.$t"; run_cmd
  expect "$t behind upstream" 1 "^dev-version: STALE $t running="
done
reset; echo v9.9.9 > "$FIX/gh.coder"; run_cmd
expect "a pinned tool is never STALE" 0 '^dev-version: OK coder running=2.36.6 latest=9.9.9 pinned=2.36.6'

reset; STAMP_FILE=$tmp/none run_cmd
expect "no stamp" 0 '^dev-version: UNKNOWN base-image running=none'

reset; touch "$FIX/offline"; run_cmd
expect "offline" 0 '^dev-version: UNKNOWN base-image .*registry unreachable' '^dev-version: UNKNOWN claude running=1.0.0 latest=\?' \
  '^dev-version: UNKNOWN no-mistakes'
printf '%s\n' "$out" | grep -q STALE && fail "offline: a STALE line"

reset; touch "$FIX/hang"
start=$(date +%s)
DEV_VERSION_LIMIT=2 run_cmd
elapsed=$(($(date +%s) - start))
expect "hanging lookups" 0 '^dev-version: UNKNOWN '
[ "$elapsed" -le 5 ] || fail "hanging lookups took ${elapsed}s, budget is 5s"

reset
cat > "$tmp/layers/dev" <<STAMP
IMAGE=ghcr.io/cbundy/dev-system/dev
VERSION=0.0.1
REVISION=aaaaaaa1111
TAG=2
STAMP
run_cmd
expect "layer stamp compared" 0 '^dev-version: OK image:dev running=aaaaaaa latest=aaaaaaa'
printf '%s\n' "$out" | grep -q 'image-layers none' && fail "layer stamp: still prints none"

# --json: every component, plus the running-only tools.
reset; run_cmd --json
expect "json" 0
printf '%s\n' "$out" | jq -e '.status == "OK" and .local == false' > /dev/null || fail "json: status/local. Output: $out"
for c in base-image 'callum-flow@callum(user)' claude codex no-mistakes treehouse agentsview coder gh node psql jq tmux; do
  printf '%s\n' "$out" | jq -e --arg c "$c" 'any(.components[]; .name == $c)' > /dev/null || fail "json: no component $c. Output: $out"
done
printf '%s\n' "$out" | jq -e '
  (.components[] | select(.name == "base-image")) as $b | $b.status == "OK" and $b.running == "aaaaaaa" and $b.latest == "aaaaaaa" and $b.pinned == null
  and ((.components[] | select(.name == "claude")) | .running == "1.0.0" and .latest == "1.0.0" and .pinned == null)
  and ((.components[] | select(.name == "agentsview")) | .running == "0.44.0" and .pinned == "0.44.0" and .latest == "0.44.0")
  and ((.components[] | select(.name == "callum-flow@callum(user)")) | .running == "0.2.0" and .pinned == "0.2.0" and .latest == "0.2.0")
  and ((.components[] | select(.name == "tmux")) | .running == "3.4" and .latest == null and .status == "OK")
  and ((.components[] | select(.name == "node")) | .running == "20.11.1")' > /dev/null || fail "json: wrong values. Output: $out"
reset; echo 9.9.9 > "$FIX/claude.latest"; run_cmd --json
expect "json stale keeps exit 1" 1
printf '%s\n' "$out" | jq -e '.status == "STALE" and ((.components[] | select(.name == "claude")) | .status == "STALE" and .latest == "9.9.9")' > /dev/null || fail "json stale: $out"
reset; touch "$FIX/offline"; run_cmd --json
expect "json offline" 0
printf '%s\n' "$out" | jq -e '(.components[] | select(.name == "claude")) | .running == "1.0.0" and .latest == null and .status == "UNKNOWN"' > /dev/null || fail "json offline: $out"
reset
cat > "$tmp/layers/dev" <<STAMP
IMAGE=ghcr.io/cbundy/dev-system/dev
VERSION=sha-abc1234
REVISION=aaaaaaa1111
TAG=2
STAMP
run_cmd --json
printf '%s\n' "$out" | jq -e 'any(.components[]; .name == "image:dev" and .status == "OK")' > /dev/null || fail "json layer: $out"
rm -f "$tmp/layers/dev"

# The plain text output lists no running-only tools.
reset; run_cmd
printf '%s\n' "$out" | grep -qE '^dev-version: [A-Z]+ (gh|node|psql|jq|tmux) ' && fail "text output grew running-only lines"

# --local: no network call at all, running and pinned only.
reset; rm -f "$tmp/network-called"
start=$(date +%s)
EXTRA_PATH=$nonet run_cmd --local --json
expect "local json" 0
[ ! -e "$tmp/network-called" ] || fail "local: touched the network: $(cat "$tmp/network-called")"
printf '%s\n' "$out" | jq -e '.local == true and all(.components[]; .latest == null)
  and ((.components[] | select(.name == "claude")) | .running == "1.0.0")
  and ((.components[] | select(.name == "agentsview")) | .pinned == "0.44.0")
  and ((.components[] | select(.name == "callum-flow@callum(user)")) | .running == "0.2.0" and .pinned == "0.2.0")' > /dev/null || fail "local json: $out"
[ $(($(date +%s) - start)) -le 2 ] || fail "local took too long"
EXTRA_PATH=$nonet run_cmd --local
expect "local text" 0 '^dev-version: UNKNOWN base-image running=aaaaaaa latest=\?' '^dev-version: UNKNOWN claude running=1.0.0 latest=\?'
[ ! -e "$tmp/network-called" ] || fail "local text: touched the network"
reset; printf '[{"id":"callum-flow@callum","version":"0.1.0","scope":"user"}]' > "$FIX/plugins.json"
EXTRA_PATH=$nonet run_cmd --local
expect "local still flags a plugin below the pin" 1 '^dev-version: STALE callum-flow@callum\(user\)'

# --snapshot: the local json plus identity fields, written atomically.
reset
cat > "$tmp/layers/dev" <<STAMP
IMAGE=ghcr.io/cbundy/dev-system/dev
VERSION=sha-abc1234
REVISION=aaaaaaa1111
TAG=2
STAMP
snap="$tmp/snap/versions.json"
mkdir "$tmp/snap"
rm -f "$tmp/network-called"
DEV_MACHINE_NAME=coder-x DEV_ROLE=worker DEV_RING=canary DEV_CODER_TEMPLATE_VERSION=v7 DEV_CODER_WORKSPACE=ws1 DEV_RUNTIME=coder \
  EXTRA_PATH=$nonet run_cmd --snapshot "$snap"
expect "snapshot" 0
[ -z "$out" ] || fail "snapshot printed: $out"
[ ! -e "$tmp/network-called" ] || fail "snapshot: touched the network"
jq -e '.device == "coder-x" and .base_image == "2.13.0" and .dev_image == "sha-abc1234" and .template_version == "v7"
  and .plugin_version == "0.2.0" and .role == "worker" and .ring == "canary" and .runtime == "coder"
  and .coder_workspace == "ws1" and .local == true and (.components | length) > 8' "$snap" > /dev/null || fail "snapshot content: $(cat "$snap")"
[ "$(ls -A "$tmp/snap")" = versions.json ] || fail "snapshot left temp files: $(ls -A "$tmp/snap")"
# Missing identity env gives nulls, not errors; the default path honours DEV_VERSIONS_FILE.
rm -f "$tmp/layers/dev" "$snap"
(unset DEV_MACHINE_NAME DEV_ROLE DEV_RING DEV_CODER_TEMPLATE_VERSION DEV_CODER_WORKSPACE DEV_RUNTIME CODER_AGENT_URL
  DEV_VERSIONS_FILE=$snap run_cmd --snapshot
  [ "$rc" -eq 0 ] || fail "snapshot without env: exit $rc: $out")
jq -e '.device == null and .dev_image == null and .template_version == null and .role == null and .ring == null
  and .runtime == null and .coder_workspace == null and .base_image == "2.13.0"' "$snap" > /dev/null || fail "snapshot nulls: $(cat "$snap")"

reset; run_cmd --bogus
expect "bad flag" 2 'usage: dev-version'

echo "dev-version tests passed"
