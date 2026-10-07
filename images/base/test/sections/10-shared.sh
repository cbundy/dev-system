# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 10 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 10. shared files (/shared)"
check "/shared exists, is owned 1000:1000 with mode 0755 and ships empty" in_image '
  [ "$(stat -c %u:%g:%a /shared)" = 1000:1000:755 ] || { stat -c %u:%g:%a /shared; exit 1; }
  [ -z "$(find /shared -mindepth 1 | head -n 1)" ] || { find /shared -mindepth 1; exit 1; }' \
  --entrypoint ""
check "DEV_SHARED_DIR is /shared" in_image '[ "$DEV_SHARED_DIR" = /shared ]'
check "shared label is /shared" bash -c "
  [ \"\$(docker image inspect -f '{{index .Config.Labels \"dev.cbundy.shared\"}}' '$IMAGE')\" = /shared ]"
check "not mounted: dev-init stays quiet and dev-doctor reports it as optional, not failed" in_image '
  out=$( { dev-init; dev-doctor; } 2>&1 ); echo "$out"
  echo "$out" | grep -q "^dev-doctor: OK   /shared not mounted (optional)$" &&
  ! echo "$out" | grep -E "WARNING|FAIL" | grep -q /shared' \
  --entrypoint ""
vol=$(docker volume create --label "$RUN_ID")
check "a writable volume at /shared: node can write and dev-doctor reports OK" in_image '
  out=$( { touch /shared/.probe && rm /shared/.probe && echo wrote; dev-init; dev-doctor; } 2>&1 ); echo "$out"
  echo "$out" | grep -qx wrote &&
  echo "$out" | grep -q "^dev-doctor: OK   /shared mounted and writable$" &&
  ! echo "$out" | grep -E "WARNING|FAIL" | grep -q /shared' \
  -v "$vol:/shared" --entrypoint ""
rootvol=$(docker volume create --label "$RUN_ID")
# Not empty, or Docker copies the image's node-owned /shared into it again.
docker run --rm --user root -v "$rootvol:/shared" "$IMAGE" \
  bash -c 'touch /shared/.root-owned && chown -R root:root /shared'
check "a root-owned volume at /shared: dev-init warns with the fix but exits 0" in_image '
  out=$(dev-init 2>&1); rc=$?; echo "$out"
  [ $rc = 0 ] &&
  echo "$out" | grep -q "dev-init: WARNING: /shared is mounted but not writable by node (1000:1000)" &&
  echo "$out" | grep -q "all_squash,anonuid=1000,anongid=1000"' \
  -v "$rootvol:/shared" --entrypoint ""
check "a root-owned volume at /shared: dev-doctor fails that check with the fix" in_image '
  out=$(dev-doctor 2>&1); rc=$?; echo "$out"
  [ $rc = 1 ] &&
  echo "$out" | grep -A1 "^dev-doctor: FAIL /shared mounted but not writable by node (1000:1000)$" | grep -q "fix: .*all_squash,anonuid=1000,anongid=1000"' \
  -v "$rootvol:/shared" --entrypoint ""
