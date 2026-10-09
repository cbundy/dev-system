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
chmod +x "$bin"/*

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
  out=$(PATH="$bin:$PATH" DEV_VERSION_STAMP="${STAMP_FILE:-$tmp/stamp}" DEV_VERSION_STAMP_DIR="$tmp/layers" \
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

reset; run_cmd --bogus
expect "bad flag" 2 'usage: dev-version'

echo "dev-version tests passed"
