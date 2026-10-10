# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 6 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 6. dev-doctor"
check "dev-doctor exits non-zero with no auth and prints a hint per failure" bash -c "
  out=\$(docker run --rm '$IMAGE' dev-doctor 2>&1); rc=\$?
  echo \"\$out\"
  [ \$rc -ne 0 ] || exit 1
  fails=\$(echo \"\$out\" | grep -c 'FAIL ' || true)
  warns=\$(echo \"\$out\" | grep -c 'WARN ' || true)
  hints=\$(echo \"\$out\" | grep -c 'fix: ' || true)
  [ \"\$fails\" -ge 3 ] && [ \"\$((fails + warns))\" = \"\$hints\" ] &&
  echo \"\$out\" | grep -q 'claude auth login' &&
  echo \"\$out\" | grep -q 'codex login' &&
  echo \"\$out\" | grep -q 'gh auth login'"
check "dev-doctor warns, without failing, for each /persist dir with no volume behind it" bash -c "
  vol=\$(docker volume create --label '$RUN_ID')
  out=\$(docker run --rm --entrypoint '' -v \"\$vol:/persist/claude\" '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  for t in codex gh no-mistakes agentsview; do
    echo \"\$out\" | grep -q \"WARN \$t state dir /persist/\$t is writable but not on a volume\" || { echo \"no WARN for \$t\"; exit 1; }
  done
  for t in events dev-restart-self; do
    echo \"\$out\" | grep -q \"OK   \$t state dir /persist/\$t is writable\" || { echo \"no OK for \$t\"; exit 1; }
  done
  echo \"\$out\" | grep -q 'OK   claude state dir /persist/claude is writable' &&
  [ \"\$(echo \"\$out\" | grep -c 'FAIL ')\" = \"\$(echo \"\$out\" | sed -n 's/^dev-doctor: \\([0-9]*\\) check(s) failed\$/\\1/p')\" ]"
check "dev-doctor FAILs, naming the fix, for a missing /persist/events and /persist/dev-restart-self" in_image '
  sudo -n rm -rf /persist/events /persist/dev-restart-self
  sudo -n chown root:root /persist
  out=$(dev-doctor 2>&1); echo "$out"
  for d in events dev-restart-self; do
    echo "$out" | grep -q "FAIL $d state dir /persist/$d is missing or not writable" &&
    echo "$out" | grep -qF "fix: sudo install -d -o 1000 -g 1000 -m 0700 /persist/$d" || exit 1
  done' --entrypoint ""
vol=$(docker volume create --label "$RUN_ID")
check "dev-doctor: no persistence WARN with one volume for all of /persist (the k8s / Coder shape)" in_image '
  out=$(dev-doctor --warn-only); echo "$out"
  ! echo "$out" | grep -q "WARN .*state dir"' \
  -v "$vol:/persist"
check "dev-doctor --warn-only exits 0 with the same failures" in_image '
  out=$(dev-doctor --warn-only); rc=$?
  echo "$out"; [ $rc -eq 0 ] && echo "$out" | grep -q "FAIL "'

check "dev-doctor fails (not 'registered') when no-mistakes is broken in a gated repo" bash -c "
  vol=\$(docker volume create --label '$RUN_ID')
  docker run --rm --user root -v \"\$vol:/persist/no-mistakes\" '$IMAGE' \
    bash -c 'touch /persist/no-mistakes/.root-owned && chown -R root:root /persist/no-mistakes'
  out=\$(docker run --rm -v \"\$vol:/persist/no-mistakes\" '$IMAGE' bash -c '
    git init -q /tmp/r && touch /tmp/r/.no-mistakes.yaml && cd /tmp/r && dev-doctor' 2>&1); rc=\$?
  echo \"\$out\"
  [ \$rc -ne 0 ] && echo \"\$out\" | grep -q 'FAIL no-mistakes: /tmp/r is not registered or no-mistakes is broken' &&
  ! echo \"\$out\" | grep -q 'is registered'"
check "dev-init and dev-doctor flag a repo git refuses (dubious ownership)" bash -c "
  out=\$(docker run --rm --user root '$IMAGE' bash -c '
    git init -q /ws && touch /ws/.no-mistakes.yaml
    su node -c \"cd /ws && dev-init; dev-doctor\"' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'dev-init: WARNING: git cannot read the repo at /ws' &&
  echo \"\$out\" | grep -q 'FAIL git cannot read the repo at /ws' &&
  echo \"\$out\" | grep -q 'safe.directory /ws'"

# dev-version (cbundy/dev-system#271): the image stamps its own release info from the build
# args, and the command and its dev-doctor summary degrade to UNKNOWN offline.
check "the image carries a release stamp with non-empty keys" in_image '
  f=/usr/local/share/dev-system/image-release; cat "$f"
  for k in IMAGE VERSION REVISION CREATED AGENTSVIEW_VERSION CODER_VERSION; do
    [ -n "$(sed -n "s/^$k=//p" "$f")" ] || { echo "empty $k"; exit 1; }
  done
  [ "$(sed -n "s/^IMAGE=//p" "$f")" = ghcr.io/cbundy/dev-system/base ]' --entrypoint ""
check "dev-version offline: every network line UNKNOWN, exit 0, within 5s" in_image '
  start=$(date +%s)
  out=$(dev-version); rc=$?
  echo "$out"
  [ $rc -eq 0 ] && [ $(($(date +%s) - start)) -le 5 ] &&
  ! echo "$out" | grep -q "^dev-version: STALE " &&
  echo "$out" | grep -q "^dev-version: UNKNOWN base-image" &&
  echo "$out" | grep -q "^dev-version: INFO image-layers none"' --network none --entrypoint ""
check "dev-doctor reports a STALE base image as WARN with the rebuild fix, and still exits 0" in_image '
  mkdir -p /tmp/stub
  printf "#!/bin/sh\necho \"dev-version: STALE base-image running=aaaaaaa latest=bbbbbbb (x)\"\necho \"dev-version: STALE claude running=1 latest=2\"\n" > /tmp/stub/dev-version
  chmod +x /tmp/stub/dev-version
  out=$(PATH=/tmp/stub:$PATH dev-doctor 2>&1); rc=$?
  echo "$out"
  [ $rc -eq 0 ] &&
  echo "$out" | grep -q "dev-doctor: WARN image is out of date: STALE base-image" &&
  echo "$out" | grep -A1 "WARN image is out of date" | grep -q "fix: rebuild the container" &&
  echo "$out" | grep -q "dev-doctor: INFO versions: 1 stale"' --entrypoint ""
check "dev-doctor prints the versions INFO line and still exits 0 offline" in_image '
  out=$(dev-doctor --warn-only); rc=$?
  echo "$out"; [ $rc -eq 0 ] && echo "$out" | grep -q "dev-doctor: INFO versions: "' --network none
