#!/bin/sh
#
# Plain-shell unit test for install-treehouse.sh, with a fake curl.
# Runs directly with no Docker: `sh features/test/callum-tools/install-treehouse.test.sh`.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALL_SH="$SCRIPT_DIR/../../src/callum-tools/install-treehouse.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$INSTALL_SH" ] || fail "$INSTALL_SH is missing or not executable"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Payload: a tarball holding an executable named treehouse.
mkdir "$tmpdir/payload"
printf '#!/bin/sh\necho treehouse fake\n' > "$tmpdir/payload/treehouse"
chmod 755 "$tmpdir/payload/treehouse"
tar -czf "$tmpdir/payload.tar.gz" -C "$tmpdir/payload" treehouse

# Fake curl: logs every URL; FAKE_LATEST is what the releases/latest redirect
# lands on ("fail" makes it exit 22); FAKE_DOWNLOAD=fail breaks the download.
cat > "$tmpdir/fakecurl" <<'FAKE'
#!/bin/sh
out=''
url=''
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -w) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$url" >> "$FAKE_LOG"
case $url in
  */releases/latest)
    [ "$FAKE_LATEST" = fail ] && exit 22
    printf '%s' "$FAKE_LATEST"
    ;;
  */releases/download/*)
    [ "${FAKE_DOWNLOAD:-}" = fail ] && exit 22
    cp "$FAKE_PAYLOAD" "$out"
    ;;
  *) exit 1 ;;
esac
FAKE
chmod 755 "$tmpdir/fakecurl"

FAKE_PAYLOAD="$tmpdir/payload.tar.gz"
export FAKE_PAYLOAD
TREEHOUSE_CURL="$tmpdir/fakecurl"
export TREEHOUSE_CURL

# run <dest>: sets rc, with stderr in $tmpdir/err and requested URLs in $tmpdir/log.
run() {
  FAKE_LOG="$tmpdir/log"
  export FAKE_LOG
  : > "$FAKE_LOG"
  rc=0
  "$INSTALL_SH" "$1" > /dev/null 2> "$tmpdir/err" || rc=$?
}

# (a) happy path, and (b) never the REST API.
FAKE_LATEST=https://github.com/kunchenguid/treehouse/releases/tag/v3.1.3
export FAKE_LATEST
run "$tmpdir/ok"
[ "$rc" -eq 0 ] || fail "happy path exited $rc: $(cat "$tmpdir/err")"
[ -x "$tmpdir/ok/treehouse" ] || fail "treehouse not installed executable"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in x86_64 | amd64) arch=amd64 ;; *) arch=arm64 ;; esac
grep -qF "releases/download/v3.1.3/treehouse-v3.1.3-$os-$arch.tar.gz" "$tmpdir/log" \
  || fail "wrong asset requested: $(cat "$tmpdir/log")"
if grep -q 'api.github.com' "$tmpdir/log"; then
  fail "requested api.github.com: $(cat "$tmpdir/log")"
fi

# (c) redirect does not land on a tag.
for latest in https://github.com/login fail; do
  FAKE_LATEST=$latest
  run "$tmpdir/bad$$"
  [ "$rc" -ne 0 ] || fail "unresolved tag ($latest) should fail"
  grep -q '^treehouse:' "$tmpdir/err" || fail "no treehouse: message for $latest"
  [ ! -e "$tmpdir/bad$$/treehouse" ] || fail "binary installed for $latest"
done

# (d) download fails; an existing binary is left untouched.
FAKE_LATEST=https://github.com/kunchenguid/treehouse/releases/tag/v3.1.3
FAKE_DOWNLOAD=fail
export FAKE_DOWNLOAD
mkdir "$tmpdir/dl"
echo existing > "$tmpdir/dl/treehouse"
run "$tmpdir/dl"
[ "$rc" -ne 0 ] || fail "failed download should exit non-zero"
grep -q '^treehouse:' "$tmpdir/err" || fail "no treehouse: message for failed download"
[ "$(cat "$tmpdir/dl/treehouse")" = existing ] || fail "existing binary was changed"
[ ! -e "$tmpdir/dl/treehouse.new" ] || fail "partial binary left behind"
unset FAKE_DOWNLOAD

# (d2) install dir cannot be created.
: > "$tmpdir/notadir"
run "$tmpdir/notadir/bin"
[ "$rc" -ne 0 ] || fail "uncreatable install dir should fail"
grep -q '^treehouse:.*could not create' "$tmpdir/err" || fail "no treehouse: message for install dir"

# (e) unsupported arch.
mkdir "$tmpdir/bin"
cat > "$tmpdir/bin/uname" <<'FAKE'
#!/bin/sh
if [ "$1" = -m ]; then echo mips; else /usr/bin/uname "$@"; fi
FAKE
chmod 755 "$tmpdir/bin/uname"
PATH="$tmpdir/bin:$PATH" run "$tmpdir/arch"
[ "$rc" -ne 0 ] || fail "unsupported arch should fail"
grep -q '^treehouse:.*unsupported' "$tmpdir/err" || fail "no unsupported message"

echo "PASS: install-treehouse.test.sh"
