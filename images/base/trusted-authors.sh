# shellcheck shell=sh
# trusted-authors.sh: the one definition of CALLUM_FLOW_TRUSTED_AUTHORS, sourced
# by callum-flow-issue-read and dev-doctor (cbundy/dev-system#307).
#
# The variable is the ONLY source of the trusted list; the image bakes none. It
# is comma-separated `login:numeric_id` entries, e.g. cbundy:13131067. Look an id
# up with: gh api users/<login> --jq .id
#
# POSIX sh, no side effects when sourced.

TRUSTED_AUTHORS_FORMAT='comma-separated login:numeric_id entries, e.g. cbundy:13131067'

# trusted_authors_check: exit 0 if the variable is set and every entry is valid.
# Otherwise print one line naming the variable and the problem on stdout, exit 1.
trusted_authors_check() {
  if [ -z "${CALLUM_FLOW_TRUSTED_AUTHORS-}" ]; then
    echo "CALLUM_FLOW_TRUSTED_AUTHORS is not set (expected $TRUSTED_AUTHORS_FORMAT)"
    return 1
  fi
  _ta_nl=$(printf '\n_')
  _ta_nl=${_ta_nl%_}
  _ta_ok=true
  case "$CALLUM_FLOW_TRUSTED_AUTHORS" in *"$_ta_nl"*) _ta_ok=false ;; esac
  _ta_entry='[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?:[1-9][0-9]*'
  if [ "$_ta_ok" = false ] || ! printf '%s\n' "$CALLUM_FLOW_TRUSTED_AUTHORS" | grep -Eq "^${_ta_entry}(,${_ta_entry})*\$"; then
    echo "CALLUM_FLOW_TRUSTED_AUTHORS is malformed (expected $TRUSTED_AUTHORS_FORMAT, no spaces)"
    return 1
  fi
  return 0
}

# trusted_authors_json: the valid list as a JSON array of {"login": lower-cased,
# "id": number}, for jq. Call only after trusted_authors_check succeeded.
trusted_authors_json() {
  printf '%s' "$CALLUM_FLOW_TRUSTED_AUTHORS" | jq -R -c \
    'split(",") | map(split(":") | {login: (.[0] | ascii_downcase), id: (.[1] | tonumber)})'
}
