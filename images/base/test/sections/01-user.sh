# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 1 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 1. user"
check "default user is node with uid 1000 / gid 1000" in_image '
  [ "$(id -un)" = node ] && [ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ] &&
  [ "$(id -u node)" = 1000 ] && [ "$(id -g node)" = 1000 ]'
check "the baked factory migrations are traversable and readable by node (cbundy/dev-system#797)" in_image '
  d=/usr/local/share/dev-system/factory-db
  [ "$(stat -c %a $d)" = 755 ] && [ "$(stat -c %a $d/migrations)" = 755 ] &&
  [ "$(stat -c %U $d $d/migrations | sort -u)" = root ] &&
  set -- $d/migrations/*.sql && [ -f "$1" ] &&
  for f in "$@"; do [ -r "$f" ] || exit 1; done &&
  . /usr/local/share/dev-system/factory-db.sh &&
  v=$(factory_db_expected_version) && [ "$v" -ge 1 ]' --entrypoint ""
