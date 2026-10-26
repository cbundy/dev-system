# fabriek-env.sh: the one place the FABRIEK_<X> settings fall back to the old CALLUM_FLOW_<X> names.
# Sourced (never run) by every factory command and helper at the top, before it reads a setting.
# For each setting named below whose FABRIEK_<X> is unset and CALLUM_FLOW_<X> is set, it sets and
# exports FABRIEK_<X> to the old value, so FABRIEK_<X> wins when both are set (an empty FABRIEK_<X>
# counts as set). The old names stay readable for the 10-minor-release alias window (the Coder template
# and the consumers' devcontainer.json still set CALLUM_FLOW_TRUSTED_AUTHORS); the alias-removal child
# drops this file. The list is fixed, not read from the environment, so the file runs under the bare
# PATH the tests give the commands (no env, no sed): tests/fabriek-env.test.js fails when a setting the
# commands read is missing from it. The node twin is fabriek-env.js, which walks the environment.
for _fe_n in ACTOR CLAIM_EVENTS_SOURCE CLAIM_SCORE DESIGNER_SONNET_PCT DEV_QUERY_BIN EVALUATE_SOURCE EVENT_BIN \
  FACTORY_STATE_BIN FACTORY_STATE_SOURCE GH_BIN GUARD_BIN HEARTBEAT_STATE_NEW_TIMEOUT_MS \
  HEARTBEAT_STATE_SHADOW_QUIET_SECONDS HEARTBEAT_STATE_SOURCE IMPLEMENTER_OPUS_PCT ISSUE_READ_BIN LEASE_MINUTES \
  LINKAGE_BIN MERGEABLE_SLEEP MERGEABLE_TRIES MERGE_METHOD MILESTONE_BIN PATCH_ID_BIN READY_LABEL REPO ROLLOUT_BIN \
  SHADOW_SETTLE_SECONDS SHADOW_WINDOW_SECONDS SHARE_DIR SWEEP_MERGE_SETTLE_SECONDS SWEEP_MERGE_WINDOW_SECONDS \
  TEST_PATHS TRUSTED_AUTHORS WEAKENING_BIN; do
  eval "if [ -z \"\${FABRIEK_$_fe_n+x}\" ] && [ -n \"\${CALLUM_FLOW_$_fe_n+x}\" ]; then FABRIEK_$_fe_n=\$CALLUM_FLOW_$_fe_n; export FABRIEK_$_fe_n; fi"
done
unset _fe_n
