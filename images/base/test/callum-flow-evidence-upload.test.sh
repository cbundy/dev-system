#!/bin/sh
#
# Plain-shell tests for images/base/callum-flow-evidence-upload (cbundy/dev-system#914) with a
# stub curl on a hermetic PATH that records its argv and stdin config and answers with a status
# the test sets.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
TOOL="$SCRIPT_DIR/../callum-flow-evidence-upload"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
fakebin="$tmpdir/bin"
mkdir -p "$toolbin" "$fakebin"
for t in cat mktemp rm git dirname; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
BASH=$(command -v bash)

# The stub appends one block per call: argv, then the stdin config. STATUS_FILE holds the status
# to print (default 201); a second line "exit N" makes curl fail.
cat > "$fakebin/curl" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
n=$(cat "$d/calls" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$d/calls"
echo "$*" > "$d/argv.$n"
cat > "$d/config.$n"
st=201
[ -e "$d/status" ] && st=$(cat "$d/status")
printf '%s' "$st"
[ -e "$d/curl-exit" ] && { echo "curl: (6) Could not resolve host" >&2; exit "$(cat "$d/curl-exit")"; }
exit 0
STUB
chmod +x "$fakebin/curl"

CONT='https://acct.blob.core.windows.net/evi'
WSAS='sv=2024-11-04&sr=c&sp=cw&sig=WRITESECRET'
RSAS='sv=2024-11-04&sr=c&sp=r&sig=READSECRET'

wsd="$tmpdir/ws-secrets"
shd="$tmpdir/sh-secrets"
work="$tmpdir/work"
mkdir -p "$wsd" "$shd" "$work"
printf 'png-bytes' > "$work/shot.png"
printf 'x' > "$work/Clip.MP4"
printf 'x' > "$work/notes.txt"

mkfolder() { # mkfolder DIR [CONTAINER WSAS RSAS]
  mkdir -p "$1"
  printf '  %s\n' "${2:-$CONT}" > "$1/container-url"
  printf '?%s\n' "${3:-$WSAS}" > "$1/write-sas"
  printf '?%s\n' "${4:-$RSAS}" > "$1/read-sas"
}

reset() {
  rm -rf "${wsd:?}"/* "${shd:?}"/* "$fakebin"/calls "$fakebin"/argv.* "$fakebin"/config.* "$fakebin/status" "$fakebin/curl-exit"
}

# run ARGS...: a clean environment; EXTRA_ENV words (VAR=value) are added
run() {
  # shellcheck disable=SC2086
  (cd "$work" && env -i PATH="$toolbin:$fakebin" HOME="$tmpdir" HOSTNAME="${HOSTNAME_T:-Box_1}" \
    DEV_WORKSPACE_SECRETS_DIR="$wsd" DEV_SECRETS_DIR="$shd" ${EXTRA_ENV:-} \
    "$BASH" "$TOOL" "$@") > "$tmpdir/out" 2> "$tmpdir/err" && rc=0 || rc=$?
}
expect_rc() { [ "$rc" = "$1" ] || fail "$2: exit $rc, want $1 ($(cat "$tmpdir/err"))"; }
expect_err() { grep -q -- "$1" "$tmpdir/err" || fail "$2: stderr lacks '$1': $(cat "$tmpdir/err")"; }
expect_out() { grep -q -- "$1" "$tmpdir/out" || fail "$2: stdout lacks '$1': $(cat "$tmpdir/out")"; }
no_calls() { [ ! -e "$fakebin/calls" ] || fail "$1: curl was called"; }

# help
reset
run --help
expect_rc 0 help
expect_out "usage: callum-flow-evidence-upload" help

# blob path from --repo, with workspace sanitising
reset
mkfolder "$shd/evidence/acme/widget"
EXTRA_ENV="" run --repo Acme/Widget --dry-run pr-1 shot.png
expect_rc 0 "repo flag"
expect_out "^$CONT/acme/widget/box-1/pr-1/shot.png?$RSAS\$" "repo flag url"
expect_err "acme/widget/box-1/pr-1/shot.png" "repo flag blob path"

# workspace sources
EXTRA_ENV="CODER_WORKSPACE_NAME=Coder.WS" run --repo acme/widget --dry-run d shot.png
expect_out "/acme/widget/coder-ws/d/" "CODER_WORKSPACE_NAME"
EXTRA_ENV="CODER_WORKSPACE_NAME=Coder.WS DEV_CODER_WORKSPACE=Dev_WS" run --repo acme/widget --dry-run d shot.png
expect_out "/acme/widget/dev-ws/d/" "DEV_CODER_WORKSPACE wins"
EXTRA_ENV="GITHUB_ACTIONS=true GITHUB_RUN_ID=777" run --repo acme/widget --dry-run d shot.png
expect_out "/acme/widget/ci-777/d/" "actions run id"
EXTRA_ENV="GITHUB_ACTIONS=true GITHUB_RUN_ID=777 CODER_WORKSPACE_NAME=w" run --repo acme/widget --dry-run d shot.png
expect_out "/acme/widget/w/d/" "coder name beats actions"
HOSTNAME_T="!!!" run --repo acme/widget --dry-run d shot.png
expect_out "/acme/widget/---/d/" "hostname sanitised"

# GITHUB_REPOSITORY, then origin (https and ssh)
EXTRA_ENV="GITHUB_REPOSITORY=Acme/Widget" run --dry-run d shot.png
expect_rc 0 "GITHUB_REPOSITORY"
expect_out "/acme/widget/box-1/d/shot.png" "GITHUB_REPOSITORY"
git init -q "$work/co"
for remote in https://github.com/Acme/Widget.git git@github.com:Acme/Widget.git ssh://git@github.com/Acme/Widget.git https://github.com/Acme/Widget; do
  git -C "$work/co" remote remove origin 2>/dev/null || true
  git -C "$work/co" remote add origin "$remote"
  (cd "$work/co" && env -i PATH="$toolbin:$fakebin" HOSTNAME=box DEV_WORKSPACE_SECRETS_DIR="$wsd" DEV_SECRETS_DIR="$shd" \
    "$BASH" "$TOOL" --dry-run d "$work/shot.png") > "$tmpdir/out" 2> "$tmpdir/err" || fail "origin $remote: $(cat "$tmpdir/err")"
  expect_out "/acme/widget/box/d/shot.png" "origin $remote"
done
run --check
expect_rc 2 "no repo known"
no_calls "no repo"

# credential precedence: env > workspace folder > shared folder
reset
mkfolder "$shd/evidence/acme/widget" "https://shared.blob.core.windows.net/s"
run --repo acme/widget --dry-run d shot.png
expect_out "^https://shared.blob.core.windows.net/s/" "shared folder"
mkfolder "$wsd/evidence/acme/widget" "https://wsdir.blob.core.windows.net/w"
run --repo acme/widget --dry-run d shot.png
expect_out "^https://wsdir.blob.core.windows.net/w/" "workspace folder beats shared"
EXTRA_ENV="ARTIFACT_CONTAINER_URL=https://envc.blob.core.windows.net/e ARTIFACT_SAS=?$WSAS ARTIFACT_READ_SAS=?$RSAS" run --repo acme/widget --dry-run d shot.png
expect_out "^https://envc.blob.core.windows.net/e/" "env beats folders"
expect_out "?$RSAS\$" "env read sas, ? dropped"
# incomplete workspace folder wins whole: a refusal, not a fallback
rm "$wsd/evidence/acme/widget/read-sas"
run --repo acme/widget --check
expect_rc 1 "incomplete workspace folder"
expect_err "$wsd/evidence/acme/widget/read-sas" "incomplete workspace folder names file"
# values are trimmed and a leading ? dropped
reset
mkfolder "$shd/evidence/acme/widget"
run --repo acme/widget --dry-run d shot.png
expect_out "/shot.png?sv=" "leading ? dropped"
expect_out "^$CONT/" "value trimmed"

# no credentials
reset
run --repo acme/widget --check
expect_rc 78 "no credentials"
expect_err "ARTIFACT_SAS" "78 names env"
expect_err "$wsd/evidence/acme/widget" "78 names workspace folder"
expect_err "$shd/evidence/acme/widget" "78 names shared folder"
expect_err "committed capture" "78 fallback"
[ "$(grep -c "" "$tmpdir/err")" = 1 ] || fail "78 is one line"
run --repo acme/widget d shot.png
expect_rc 78 "upload without credentials"
no_calls "78"

# --check ok
mkfolder "$shd/evidence/acme/widget"
run --repo acme/widget --check
expect_rc 0 "check ok"
expect_err "OK" "check ok line"
expect_err "$shd/evidence/acme/widget" "check names source"
expect_err "$CONT" "check names container"
run --repo acme/widget --check d shot.png
expect_rc 2 "check with files"
no_calls "check"

# bad usage and input exit 2 with no curl call
for args in "" "d" "--bogus d shot.png" "'' shot.png" "/abs shot.png" "a/../b shot.png" ".. shot.png" "'a b' shot.png" "a//b shot.png" "d missing.png"; do
  eval "set -- $args"
  run --repo acme/widget "$@"
  expect_rc 2 "usage [$args]"
  no_calls "usage [$args]"
done
chmod 000 "$work/notes.txt"
if [ ! -r "$work/notes.txt" ]; then
  run --repo acme/widget d notes.txt
  expect_rc 2 "unreadable file"
  no_calls "unreadable"
fi
chmod 644 "$work/notes.txt"
run --repo acme/widget d shot.png missing.png
expect_rc 2 "one missing file among several"
no_calls "missing among several"

# refusals
reset
refuse() { # refuse NAME CONTAINER WSAS RSAS PATTERN
  reset
  mkfolder "$shd/evidence/acme/widget" "$2" "$3" "$4"
  run --repo acme/widget d shot.png
  expect_rc 1 "refuse $1"
  expect_err "$5" "refuse $1"
  no_calls "refuse $1"
  run --repo acme/widget --check
  expect_rc 1 "refuse $1 (check)"
}
refuse "account sas srt" "$CONT" "sv=1&srt=sco&ss=b&sp=cw&sig=X" "$RSAS" "write-sas"
refuse "account sas ss" "$CONT" "$WSAS" "sv=1&ss=b&sr=c&sp=r&sig=X" "read-sas"
refuse "blob sr" "$CONT" "sv=1&sr=b&sp=cw&sig=X" "$RSAS" "write-sas"
refuse "read sas with w" "$CONT" "$WSAS" "sv=1&sr=c&sp=rw&sig=X" "read-sas"
refuse "read sas with list" "$CONT" "$WSAS" "sv=1&sr=c&sp=rl&sig=X" "read-sas"
refuse "write without w" "$CONT" "sv=1&sr=c&sp=c&sig=X" "$RSAS" "write-sas"
refuse "write without c" "$CONT" "sv=1&sr=c&sp=w&sig=X" "$RSAS" "write-sas"
refuse "two segments" "$CONT/extra" "$WSAS" "$RSAS" "container-url"
refuse "query string" "$CONT?x=1" "$WSAS" "$RSAS" "container-url"
refuse "http" "http://acct.blob.core.windows.net/evi" "$WSAS" "$RSAS" "container-url"
refuse "no container" "https://acct.blob.core.windows.net" "$WSAS" "$RSAS" "container-url"
# env refusals name the variable
reset
EXTRA_ENV="ARTIFACT_CONTAINER_URL=$CONT ARTIFACT_SAS=sv=1&sr=b&sp=cw ARTIFACT_READ_SAS=$RSAS" run --repo acme/widget --check
expect_rc 1 "env refusal"
expect_err "ARTIFACT_SAS" "env refusal names variable"
EXTRA_ENV="ARTIFACT_SAS=$WSAS" run --repo acme/widget --check
expect_rc 1 "env missing url"
expect_err "ARTIFACT_CONTAINER_URL" "env missing url"

# upload: config, headers, order, content types, secrecy
reset
mkfolder "$shd/evidence/acme/widget"
run --repo acme/widget pr-9/shots shot.png Clip.MP4 notes.txt
expect_rc 0 "upload"
[ "$(cat "$fakebin/calls")" = 3 ] || fail "three curl calls"
n=$(grep -c '' "$tmpdir/out")
[ "$n" = 3 ] || fail "three urls on stdout, got $n"
sed -n 1p "$tmpdir/out" | grep -q "^$CONT/acme/widget/box-1/pr-9/shots/shot.png?$RSAS\$" || fail "first url"
sed -n 2p "$tmpdir/out" | grep -q "/Clip.MP4?" || fail "second url"
sed -n 3p "$tmpdir/out" | grep -q "/notes.txt?" || fail "third url"
grep -q 'Content-Type: image/png' "$fakebin/config.1" || fail "png type"
grep -q 'Content-Type: video/mp4' "$fakebin/config.2" || fail "MP4 type, case-insensitive"
grep -q 'Content-Type: application/octet-stream' "$fakebin/config.3" || fail "default type"
for i in 1 2 3; do
  grep -q 'request = "PUT"' "$fakebin/config.$i" || fail "PUT $i"
  grep -q 'x-ms-blob-type: BlockBlob' "$fakebin/config.$i" || fail "blob type header $i"
  grep -q "WRITESECRET" "$fakebin/config.$i" || fail "write sas goes in the stdin config $i"
  if grep -q "WRITESECRET\|READSECRET" "$fakebin/argv.$i"; then fail "SAS in curl argv $i"; fi
  if grep -q "WRITESECRET" "$tmpdir/out" "$tmpdir/err"; then fail "write sas printed"; fi
done
grep -q '^-K -$\|-K -' "$fakebin/argv.1" || fail "-K - used"

# content types
reset
mkfolder "$shd/evidence/acme/widget"
for pair in png:image/png jpg:image/jpeg JPEG:image/jpeg gif:image/gif webp:image/webp mp4:video/mp4 webm:video/webm zip:application/zip HTML:text/html bin:application/octet-stream; do
  ext=${pair%%:*}
  want=${pair#*:}
  rm -f "$fakebin/calls"
  printf x > "$work/f.$ext"
  run --repo acme/widget d "f.$ext"
  expect_rc 0 "type $ext"
  grep -q "Content-Type: $want\"" "$fakebin/config.1" || fail "content type for $ext: $(cat "$fakebin/config.1")"
done

# dry-run never prints the write sas and never calls curl
reset
mkfolder "$shd/evidence/acme/widget"
run --repo acme/widget --dry-run d shot.png
expect_rc 0 "dry-run"
no_calls "dry-run"
if grep -q "WRITESECRET" "$tmpdir/out" "$tmpdir/err"; then fail "dry-run printed the write sas"; fi

# failed upload: non-201 names file and status, nothing on stdout
echo 403 > "$fakebin/status"
run --repo acme/widget d shot.png
expect_rc 1 "403"
expect_err "shot.png" "403 names file"
expect_err "403" "403 names status"
[ ! -s "$tmpdir/out" ] || fail "403 printed urls"
rm -f "$fakebin/status" "$fakebin/calls"
echo 7 > "$fakebin/curl-exit"
run --repo acme/widget d shot.png
expect_rc 1 "curl failure"
[ ! -s "$tmpdir/out" ] || fail "curl failure printed urls"
rm -f "$fakebin/curl-exit"

# a later file failing reports no URL for the earlier ones
rm -f "$fakebin/calls"
cat > "$fakebin/curl" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
n=$(cat "$d/calls" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$d/calls"
cat > "$d/config.$n"
[ "$n" = 2 ] && printf 500 || printf 201
STUB
run --repo acme/widget d shot.png Clip.MP4
expect_rc 1 "second upload fails"
expect_err "Clip.MP4" "names the failing file"
[ ! -s "$tmpdir/out" ] || fail "partial failure printed urls"

echo "callum-flow-evidence-upload tests passed"
