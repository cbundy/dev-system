# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 2 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 2. toolchain"
for tool in node npm claude codex gh git no-mistakes treehouse uv uvx agentsview shellcheck psql; do
  check "$tool runs --version as node" in_image "[ \"\$(id -un)\" = node ] && $tool --version"
done
check "callum-flow-event writes a line, rejects an unknown state, and event-push-loop is installed" in_image '
  d=$(mktemp -d) && CALLUM_EVENTS_DIR=$d callum-flow-event ready --issue 1 && [ "$(wc -l < "$d"/*.jsonl)" = 1 ] &&
  ! CALLUM_EVENTS_DIR=$d callum-flow-event bogus --issue 1 2>/dev/null && [ -x /usr/local/share/dev-system/event-push-loop ]'
check "nm-push-loop and nm-export are installed and executable, and nm-export rejects bad usage" in_image '
  [ -x /usr/local/share/dev-system/nm-push-loop ] && [ -x /usr/local/share/dev-system/nm-export ] &&
  ! /usr/local/share/dev-system/nm-export 2>/dev/null'
check "callum-flow-merge-guard and callum-flow-merge are on PATH, show usage, and reject a bad option" in_image '
  callum-flow-merge-guard --help 2>/dev/null; [ $? = 2 ] && ! callum-flow-merge-guard 7 --bogus 2>/dev/null &&
  [ -x "$(command -v callum-flow-merge)" ] && ! callum-flow-merge 7 --method bogus 2>/dev/null'
check "callum-flow-rollout is on PATH and exits 2 on bad arguments" in_image '
  [ -x "$(command -v callum-flow-rollout)" ] && callum-flow-rollout 2>/dev/null; [ $? = 2 ] && callum-flow-rollout abc 2>/dev/null; [ $? = 2 ]'
check "callum-flow-fix-linkage is on PATH and rejects a bad option with exit 2" in_image '
  [ -x "$(command -v callum-flow-fix-linkage)" ] && callum-flow-fix-linkage 7 --bogus 2>/dev/null; [ $? = 2 ]'
check "callum-flow-claim and callum-flow-sweep are on PATH and exit 2 on bad arguments" in_image '
  callum-flow-claim 2>/dev/null; [ $? = 2 ] && ! callum-flow-claim abc 2>/dev/null &&
  callum-flow-sweep --bogus 2>/dev/null; [ $? = 2 ]'
check "callum-flow-evaluate is on PATH, exits 2 on a bad argument and prints every report key (all n/a) for empty inputs" in_image '
  [ -x "$(command -v callum-flow-evaluate)" ] && callum-flow-evaluate --bogus 2>/dev/null; [ $? = 2 ] &&
  d=$(mktemp -d) &&
  CLAUDE_CONFIG_DIR=$d CALLUM_EVENTS_DIR=$d NO_MISTAKES_HOME=$d callum-flow-evaluate --repo a/b --since 2026-01-01T00:00:00Z |
    node -e "const r = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")); const keys = [\"window\", \"throughput\", \"first_pass\", \"review\", \"adjudicator_agreement\", \"spend\", \"waste\", \"pipeline\", \"sources\"]; if (keys.some((k) => !(k in r)) || !r.throughput[\"n/a\"] || !r.pipeline[\"n/a\"]) process.exit(1)"'
check "dev-prune-worktrees is installed and runs a dry run in a repo with no bridge worktrees" in_image '
  git init -q /tmp/prune-r && dev-prune-worktrees --workspace /tmp/prune-r | grep -q "no bridge worktrees"'
check "codex helper binaries are installed (codex-code-mode-host)" in_image '
  find "$(npm prefix -g)/lib/node_modules/@openai/codex" -name codex-code-mode-host -type f -perm -u+x | grep -q .'
# The one check that reaches PyPI: a Python repo's gates install their deps
# this way (cbundy/dev-system#149), so only a real install proves they can.
# UV_PYTHON_DOWNLOADS=never pins it to the image's own python3, the one that
# lacks pip and venv.
check "uv installs a package and runs it with the image's python3, as node" in_image '
  [ "$(id -un)" = node ] &&
  UV_PYTHON_DOWNLOADS=never uv run --no-project --with pytest python -c "import pytest"' \
  --entrypoint ""
check "callum-tools scripts staged where the callum-flow skills call them" in_image '
  for s in check-pr-linkage.sh pipeline-watch.sh queue-watch.sh usage-check.sh recover-no-mistakes.sh pin-codex-model.sh; do
    test -x /usr/local/share/callum-tools/$s || { echo "missing $s"; exit 1; }
  done'
check "models.env and models.sh are baked in, and the old codex-model.default is gone" in_image '
  . /usr/local/share/dev-system/models.sh &&
  models_value /usr/local/share/dev-system/models.env CODEX_MODEL &&
  models_value /usr/local/share/dev-system/models.env CLAUDE_MODEL &&
  [ ! -e /usr/local/share/dev-system/codex-model.default ]'
# The Coder CLI is pinned to the deployment's server version by the Dockerfile's
# CODER_VERSION: a mismatched CLI silently ignores flags (cbundy/dev-system#108).
coder_pin=$(sed -n 's/^ARG CODER_VERSION=//p' "$(dirname "${BASH_SOURCE[0]}")/../../Dockerfile")
check "coder CLI runs as node and reports the Dockerfile's CODER_VERSION pin ($coder_pin)" in_image "
  [ \"\$(id -un)\" = node ] && [ -n '$coder_pin' ] &&
  coder version | grep -q 'v$coder_pin'" \
  --entrypoint ""
