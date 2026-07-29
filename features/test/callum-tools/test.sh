#!/bin/bash
# Default-scenario test for the callum-tools feature: all three tools
# installed. Runs inside a container built with the feature applied;
# postCreate lifecycle hooks have already run by the time this executes.
set -e

source dev-container-features-test-lib

check "no-mistakes on PATH" bash -lc "command -v no-mistakes"
check "treehouse on PATH" bash -lc "command -v treehouse"
check "claude CLI on PATH" bash -lc "command -v claude"
check "setup script staged" test -x /usr/local/share/callum-tools/setup.sh

reportResults
