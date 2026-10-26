# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 2 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 2. toolchain"
for tool in node npm claude codex gh git treehouse uv uvx agentsview shellcheck psql; do
  check "$tool runs --version as node" in_image "[ \"\$(id -un)\" = node ] && $tool --version"
done
check "fabriek-event writes one new event and no old line, rejects an unknown state, and event-push-loop is installed" in_image '
  d=$(mktemp -d) && CALLUM_FLOW_REPO=o/r CALLUM_EVENTS_DIR=$d fabriek-event ready --issue 1 && [ -z "$(find "$d" -maxdepth 1 -name "*.jsonl")" ] &&
  [ "$(cat "$d"/factory/*.jsonl | wc -l)" = 1 ] && [ -r /usr/local/share/dev-system/factory-event-translate.js ] &&
  ! CALLUM_EVENTS_DIR=$d fabriek-event bogus --issue 1 2>/dev/null && [ -x /usr/local/share/dev-system/event-push-loop ] &&
  [ -x /usr/local/share/dev-system/factory-event-push-loop ]'
check "fabriek-event --type writes a checked new-format event only to the new log and refuses a missing required field" in_image '
  d=$(mktemp -d) && [ -r /usr/local/share/dev-system/factory-event-shapes.json ] && [ -r /usr/local/share/dev-system/factory-event-write.js ] &&
  CALLUM_FLOW_REPO=o/r CALLUM_EVENTS_DIR=$d fabriek-event --type claimed --issue 1 --data "{\"lease_minutes\":30}" &&
  [ "$(cat "$d"/factory/*.jsonl | wc -l)" = 1 ] && ! ls "$d"/*.jsonl >/dev/null 2>&1 &&
  ! CALLUM_FLOW_REPO=o/r CALLUM_EVENTS_DIR=$d fabriek-event --type claimed --issue 1 --data "{}" 2>/dev/null &&
  [ "$(cat "$d"/factory/*.jsonl | wc -l)" = 1 ]'
check "factory-source.js loads and exports resolveSource, runShadow and diff" in_image '
  node -e "const m=require(\"/usr/local/share/dev-system/factory-source.js\");for(const k of [\"resolveSource\",\"runShadow\",\"diff\"])if(typeof m[k]!==\"function\")process.exit(1)"'
check "heartbeat-state finds factory-source.js beside itself and prints a state under --source new" in_image '
  d=$(mktemp -d) && CALLUM_FLOW_HEARTBEAT_STATE_SOURCE=new CALLUM_EVENTS_DIR=$d CLAUDE_CONFIG_DIR=$d \
    /usr/local/share/dev-system/heartbeat-state | node -e "const o=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(!o||typeof o!==\"object\"||!o.state)process.exit(1)"'
check "evaluate-new-events.js loads, and fabriek-evaluate finds the shared helpers and rejects a bad --source" in_image '
  node -e "const m=require(\"/usr/local/share/dev-system/evaluate-new-events.js\");for(const k of [\"mapEvent\",\"loadNewEvents\",\"normalize\"])if(typeof m[k]!==\"function\")process.exit(1)" &&
  fabriek-evaluate --repo o/r --since 2026-10-01T00:00:00Z --source bogus 2>&1 | grep -q "invalid source"'
check "dev-query is on PATH, prints usage, and exits 78 with no URL configured" in_image '
  [ -x "$(command -v dev-query)" ] && dev-query --help >/dev/null &&
  env -u AGENTSVIEW_PG_URL DEV_SECRETS_DIR=$(mktemp -d) dev-query -c "select 1" 2>/dev/null; [ $? = 78 ]'
check "fabriek-evidence-upload is on PATH, prints usage, and exits 78 with no credentials configured" in_image '
  [ -x "$(command -v fabriek-evidence-upload)" ] && fabriek-evidence-upload --help >/dev/null &&
  env -u ARTIFACT_SAS DEV_SECRETS_DIR=$(mktemp -d) DEV_WORKSPACE_SECRETS_DIR=$(mktemp -d) fabriek-evidence-upload --repo o/r --check 2>/dev/null; [ $? = 78 ]'
check "fabriek-capture is on PATH, shows usage, rejects bad usage, and exits 69 with no Playwright, leaving no server" in_image '
  [ -x "$(command -v fabriek-capture)" ] && fabriek-capture --help >/dev/null &&
  fabriek-capture --start true 2>/dev/null; [ $? = 2 ] &&
  d=$(mktemp -d) && cd "$d" && NODE_PATH= fabriek-capture --start "echo \$\$ > $d/p; exec sleep 300" shot 2>/dev/null; [ $? = 69 ] &&
  { [ ! -f "$d/p" ] || ! kill -0 "$(cat "$d/p")" 2>/dev/null; }'
check "fabriek-merge-guard and fabriek-merge are on PATH, show usage, and reject a bad option" in_image '
  fabriek-merge-guard --help 2>/dev/null; [ $? = 2 ] && ! fabriek-merge-guard 7 --bogus 2>/dev/null &&
  [ -x "$(command -v fabriek-merge)" ] && ! fabriek-merge 7 --method bogus 2>/dev/null'
check "fabriek-patch-id is on PATH, exits 2 on bad usage and 1 outside a repository, and the guard takes --patch" in_image '
  [ -x "$(command -v fabriek-patch-id)" ] && fabriek-patch-id 2>/dev/null; [ $? = 2 ] &&
  (cd "$(mktemp -d)" && fabriek-patch-id issue-1 main 2>/dev/null; [ $? = 1 ]) &&
  fabriek-merge-guard 7 --patch xyz 2>/dev/null; [ $? = 2 ]'
check "fabriek-milestone is on PATH, shows usage, and exits 2 on a bad subcommand" in_image '
  [ -x "$(command -v fabriek-milestone)" ] && fabriek-milestone --help >/dev/null &&
  fabriek-milestone bogus 2>/dev/null; [ $? = 2 ]'
check "fabriek-released is on PATH, shows usage, exits 2 on a bad flag, and release-contents.js loads" in_image '
  [ -x "$(command -v fabriek-released)" ] && fabriek-released --help | grep -q "^usage: fabriek-released" &&
  fabriek-released --help | grep -q -e "--attach" && fabriek-released --help | grep -q -e "--collect" &&
  node -e "const r=require(\"/usr/local/share/dev-system/release-contents.js\"); for (const f of [\"previousTag\",\"parseCommit\",\"gitRangeCommits\",\"firstParentChain\",\"prLinks\",\"contents\",\"headlines\"]) if (typeof r[f] !== \"function\") process.exit(1)" &&
  fabriek-released --bogus 2>/dev/null; [ $? = 2 ]'
check "fabriek-test-weakening is on PATH, exits 2 on bad usage and 1 on an unknown ref" in_image '
  [ -x "$(command -v fabriek-test-weakening)" ] && fabriek-test-weakening --bogus 2>/dev/null; [ $? = 2 ] &&
  fabriek-test-weakening --base nope --head HEAD 2>/dev/null; [ $? = 1 ]'
check "fabriek-rollout is on PATH and exits 2 on bad arguments" in_image '
  [ -x "$(command -v fabriek-rollout)" ] && fabriek-rollout 2>/dev/null; [ $? = 2 ] && fabriek-rollout abc 2>/dev/null; [ $? = 2 ]'
check "fabriek-claim and fabriek-sweep are on PATH and exit 2 on bad arguments" in_image '
  fabriek-claim 2>/dev/null; [ $? = 2 ] && ! fabriek-claim abc 2>/dev/null &&
  fabriek-sweep --bogus 2>/dev/null; [ $? = 2 ]'
check "fabriek-implementer-route is on PATH and exits 2 on a bad argument and on a bad CALLUM_FLOW_IMPLEMENTER_OPUS_PCT, and --help exits 0" in_image '
  [ -x "$(command -v fabriek-implementer-route)" ] && fabriek-implementer-route 2>/dev/null; [ $? = 2 ] && fabriek-implementer-route abc 2>/dev/null; [ $? = 2 ] &&
  CALLUM_FLOW_IMPLEMENTER_OPUS_PCT=abc fabriek-implementer-route 1 2>/dev/null; [ $? = 2 ] &&
  fabriek-implementer-route --help >/dev/null'
check "fabriek-designer-route is on PATH and exits 2 on a bad argument and on a bad CALLUM_FLOW_DESIGNER_SONNET_PCT, and --help exits 0" in_image '
  [ -x "$(command -v fabriek-designer-route)" ] && fabriek-designer-route 2>/dev/null; [ $? = 2 ] && fabriek-designer-route abc 2>/dev/null; [ $? = 2 ] &&
  CALLUM_FLOW_DESIGNER_SONNET_PCT=abc fabriek-designer-route 1 2>/dev/null; [ $? = 2 ] &&
  fabriek-designer-route --help >/dev/null'
check "fabriek-issue-read is on PATH, fails closed without CALLUM_FLOW_TRUSTED_AUTHORS and exits 2 on a bad argument" in_image '
  [ -x "$(command -v fabriek-issue-read)" ] && out=$(env -u CALLUM_FLOW_TRUSTED_AUTHORS -u FABRIEK_TRUSTED_AUTHORS CALLUM_FLOW_REPO=o/r fabriek-issue-read 1 2>&1); [ $? = 1 ] &&
  echo "$out" | grep -q FABRIEK_TRUSTED_AUTHORS && out=$(CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:1 fabriek-issue-read --bogus 2>/dev/null); [ $? = 2 ] && [ -z "$out" ]'
check "dev-doctor FAILs without FABRIEK_TRUSTED_AUTHORS (or the older CALLUM_FLOW_ name) with the fix, and reports OK once it is set" in_image '
  out=$(env -u CALLUM_FLOW_TRUSTED_AUTHORS -u FABRIEK_TRUSTED_AUTHORS dev-doctor 2>&1); echo "$out" | grep -q "^dev-doctor: FAIL FABRIEK_TRUSTED_AUTHORS is not set" &&
  echo "$out" | grep -A1 "FAIL FABRIEK_TRUSTED_AUTHORS" | grep -q "fix: " &&
  CALLUM_FLOW_TRUSTED_AUTHORS=bad dev-doctor 2>&1 | grep -q "FAIL FABRIEK_TRUSTED_AUTHORS is malformed" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 dev-doctor 2>&1 | grep -qxF "dev-doctor: OK   FABRIEK_TRUSTED_AUTHORS is set (1 trusted author(s))" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067,other:2 dev-doctor 2>&1 | grep -qxF "dev-doctor: OK   FABRIEK_TRUSTED_AUTHORS is set (2 trusted author(s))"'
check "fabriek-evaluate is on PATH, exits 2 on a bad argument and prints every report key (all n/a) for empty inputs" in_image '
  [ -x "$(command -v fabriek-evaluate)" ] && fabriek-evaluate --bogus 2>/dev/null; [ $? = 2 ] &&
  d=$(mktemp -d) &&
  CLAUDE_CONFIG_DIR=$d CALLUM_EVENTS_DIR=$d fabriek-evaluate --repo a/b --since 2026-01-01T00:00:00Z |
    node -e "const r = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")); const keys = [\"window\", \"throughput\", \"first_pass\", \"review\", \"adjudicator_agreement\", \"spend\", \"waste\", \"sources\"]; if (keys.some((k) => !(k in r)) || \"pipeline\" in r || !r.throughput[\"n/a\"]) process.exit(1)"'
check "fabriek-factory-state is on PATH, exits 2 on a bad argument and prints its usage with --help" in_image '
  [ -x "$(command -v fabriek-factory-state)" ] && fabriek-factory-state --bogus 2>/dev/null; [ $? = 2 ] &&
  fabriek-factory-state --help | grep -q "^usage: fabriek-factory-state"'
check "each callum-flow-* alias is on PATH, runs its fabriek-* command (same --help output and exit code), and fabriek-env.sh/js are baked in" in_image '
  for x in capture claim designer-route dual-write-check evaluate event evidence-upload factory-state implementer-route issue-read merge merge-guard milestone patch-id released rollout sweep test-weakening; do
    [ -x "$(command -v fabriek-$x)" ] && [ -x "$(command -v callum-flow-$x)" ] || { echo "missing $x"; exit 1; }
    n=$(fabriek-$x --help 2>&1); nrc=$?
    o=$(callum-flow-$x --help 2>&1); orc=$?
    [ "$n" = "$o" ] && [ "$nrc" = "$orc" ] || { echo "callum-flow-$x differs from fabriek-$x"; exit 1; }
  done &&
  [ -r /usr/local/share/dev-system/fabriek-env.sh ] && [ -r /usr/local/share/dev-system/fabriek-env.js ] &&
  [ "$(CALLUM_FLOW_REPO=o/r CALLUM_EVENTS_DIR=/tmp/x fabriek-event --path)" = "/tmp/x/o__r.jsonl" ] &&
  [ "$(FABRIEK_REPO=a/b CALLUM_FLOW_REPO=o/r CALLUM_EVENTS_DIR=/tmp/x fabriek-event --path)" = "/tmp/x/a__b.jsonl" ]'
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
  for s in check-pr-linkage.sh queue-watch.sh usage-check.sh; do
    test -x /usr/local/share/callum-tools/$s || { echo "missing $s"; exit 1; }
  done'
check "the retired watchers and helper tools are neither on PATH nor in /usr/local/share/callum-tools" in_image '
  for t in orchestrator-watch.sh pipeline-watch.sh callum-flow-regate callum-flow-fix-linkage callum-flow-design-route; do
    ! command -v "$t" >/dev/null 2>&1 || { echo "$t is on PATH"; exit 1; }
    [ ! -e "/usr/local/share/callum-tools/$t" ] || { echo "$t is in callum-tools"; exit 1; }
  done'
check "no-mistakes, models.env and the retired model pin tooling are gone" in_image '
  ! command -v no-mistakes >/dev/null 2>&1 && [ -z "${NO_MISTAKES_HOME+set}${NM_HOME+set}${NO_MISTAKES_NO_UPDATE_CHECK+set}" ] &&
  [ ! -e /home/node/.no-mistakes ] && [ ! -e /persist/no-mistakes ] &&
  ! grep -q NO_MISTAKES /usr/local/share/dev-system/image-release &&
  for f in /usr/local/share/dev-system/models.sh /usr/local/share/dev-system/models.env /usr/local/share/callum-tools/recover-no-mistakes.sh /usr/local/share/callum-tools/pin-codex-model.sh; do
    [ ! -e "$f" ] || { echo "$f is still there"; exit 1; }
  done'
# The Coder CLI is pinned to the deployment's server version by the Dockerfile's
# CODER_VERSION: a mismatched CLI silently ignores flags (cbundy/dev-system#108).
coder_pin=$(sed -n 's/^ARG CODER_VERSION=//p' "$(dirname "${BASH_SOURCE[0]}")/../../Dockerfile")
check "coder CLI runs as node and reports the Dockerfile's CODER_VERSION pin ($coder_pin)" in_image "
  [ \"\$(id -un)\" = node ] && [ -n '$coder_pin' ] &&
  coder version | grep -q 'v$coder_pin'" \
  --entrypoint ""
