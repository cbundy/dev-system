#!/bin/bash
# Container scripts are single-quoted on purpose: they expand inside the image.
# shellcheck disable=SC2016
#
# Container tests for the dev-system base image (cbundy/dev-system#59, #64 for
# the entrypoint and Remote Control, #65 for the /shared mount point, #73
# for per-repo /persist volumes, #74 for first-run logins and #77 for the
# workspace repo clone), #103 for the agentsview URL as a secret file.
#
# Usage: images/base/test/test.sh <image> [group|section number ...]
#        images/base/test/test.sh --list-groups
#
# With no group it runs every section, in order: the single entrypoint for a Docker host.
# A group name (see GROUPS_TABLE below) or a section number runs just that part. publish-base-image.yml
# runs one group per parallel job against the same built image (cbundy/dev-system#199). The
# sections live in sections/NN-name.sh and share the helpers in lib.sh.
#
# Runs on a Docker host against an already-built image - locally and in
# publish-base-image.yml. Sections 1-7 match the tests in #59, section 8 the
# entrypoint tests in #64, section 9 the agentsview push in #69, section 10
# the /shared tests in #65 (Docker volumes stand in for the NAS), section 11
# the first-run logins in #74 (against stub CLIs), including the page behind
# an nginx path prefix (#79, a throwaway nginx container), section 12 the
# workspace repo clone in #77 (local bare repos over file:// and a git smart
# HTTP server in the container, so no network is needed), section 13 the
# Claude plugins in #112 and #148 (against a stub `claude plugin`, plus one
# real callum-flow install over the network),
# section 14 the opt-in telemetry export in #68 (stub CLIs, unreachable or
# in-container endpoints; no collector needed). Two checks need the network:
# section 2's uv check (#149) installs pytest from PyPI, and section 13's real
# install fetches callum-flow from GitHub. Test 7 needs
# the devcontainer CLI (`devcontainer` on PATH, or set
# DEVCONTAINER="npx -y @devcontainers/cli"); SKIP_DEVCONTAINER=1 skips it.
# Test 9 starts a throwaway postgres:17 container. No test needs real
# credentials: the logged-in path runs against a stub `claude`, and the
# agentsview URLs point at that throwaway database or at nowhere.
set -euo pipefail

# Group -> section numbers. Every section is in exactly one group, and the workflow's test
# matrix lists exactly these groups (both enforced by groups.test.sh, part of `npm test`).
# Sized by measured section time so the jobs finish together; the slowest, logins (11), is the
# floor. Needs: 2 and 13 the network, 7 the devcontainer CLI, 9 a throwaway postgres.
GROUPS_TABLE="
basics: 1 2 3 4 6 10
init-plugins: 5 13
devcontainer-telemetry: 7 14
entrypoint: 8
agentsview-repo: 9 12
logins: 11
"

if [ "${1:-}" = --list-groups ]; then
  printf '%s\n' "$GROUPS_TABLE" | sed -n 's/^\([a-z-]*\):.*/\1/p'
  exit 0
fi

IMAGE="${1:?usage: test.sh <image> [group|section number ...]}"
shift
TEST_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=lib.sh
. "$TEST_DIR/lib.sh"

# section_file <number>: the file for a section number.
section_file() {
  printf '%s\n' "$TEST_DIR"/sections/"$(printf "%02d" "$((10#$1))")"-*.sh
}

# Resolve the arguments to section numbers; no arguments means all of them.
wanted=""
if [ "$#" -eq 0 ]; then
  for f in "$TEST_DIR"/sections/*.sh; do
    n=$(basename "$f" | sed 's/^0*\([0-9]*\)-.*/\1/')
    wanted="$wanted $n"
  done
else
  for arg in "$@"; do
    if grep -q "^$arg:" <<< "$GROUPS_TABLE"; then
      wanted="$wanted $(sed -n "s/^$arg: *//p" <<< "$GROUPS_TABLE")"
    elif [[ "$arg" =~ ^[0-9]+$ ]] && [ -e "$(section_file "$arg")" ]; then
      wanted="$wanted $arg"
    else
      echo "test.sh: unknown group or section '$arg' (groups: $(sed -n 's/^\([a-z-]*\):.*/\1/p' <<< "$GROUPS_TABLE" | tr '\n' ' '))" >&2
      exit 2
    fi
  done
fi

for n in $wanted; do
  # shellcheck source=/dev/null
  . "$(section_file "$n")"
done

echo
echo "$PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
