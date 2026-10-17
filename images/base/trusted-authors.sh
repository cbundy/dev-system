# shellcheck shell=sh
# trusted-authors.sh: the one definition of CALLUM_FLOW_TRUSTED_AUTHORS, sourced
# by callum-flow-issue-read and dev-doctor (cbundy/dev-system#307).
#
# The variable is the ONLY source of the trusted list; the image bakes none. It
# is comma-separated `login:numeric_id` entries, e.g. cbundy:13131067. Look an id
# up with: gh api users/<login> --jq .id
#
# In token mode (DEV_GH_TOKEN_FILE set and non-empty, cbundy/dev-system#728) the
# account of that token is trusted too: dev-init writes its `login` and `id`
# (no token) to $GH_CONFIG_DIR/dev-system-identity.json, and the effective list
# is the variable's entries plus that one. Outside token mode the file is ignored.
#
# POSIX sh, no side effects when sourced.

TRUSTED_AUTHORS_FORMAT='comma-separated login:numeric_id entries, e.g. cbundy:13131067'

# trusted_authors_identity_file: where dev-init records the token account.
trusted_authors_identity_file() {
  printf '%s\n' "${GH_CONFIG_DIR:-/persist/gh}/dev-system-identity.json"
}

# _ta_entry_re: the regex of one valid login:numeric_id entry.
_ta_entry_re() {
  printf '%s\n' '[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?:[1-9][0-9]*'
}

# trusted_authors_identity_entry: the identity file's `login:id`, only in token
# mode. Prints nothing and returns 0 when not in token mode or the file is
# absent; prints nothing and returns 1 when the file exists but is malformed.
trusted_authors_identity_entry() {
  [ -n "${DEV_GH_TOKEN_FILE-}" ] || return 0
  _ta_file=$(trusted_authors_identity_file)
  [ -e "$_ta_file" ] || return 0
  _ta_re=$(_ta_entry_re)
  _ta_e=$(jq -r 'select(type == "object" and (.login | type) == "string" and (.id | type) == "number" and (.id | floor) == .id) | "\(.login):\(.id)"' "$_ta_file" 2>/dev/null) || _ta_e=""
  if [ -z "$_ta_e" ] || ! printf '%s\n' "$_ta_e" | grep -Eq "^${_ta_re}\$"; then
    return 1
  fi
  printf '%s\n' "$_ta_e"
}

# trusted_authors_effective: the trusted list, comma-separated: the variable's
# entries plus the token account's from the identity file (token mode only),
# deduplicated by id and case-insensitive login. Empty when there is none.
# Call after trusted_authors_check; a malformed identity file adds nothing.
trusted_authors_effective() {
  _ta_id=$(trusted_authors_identity_entry 2>/dev/null) || _ta_id=""
  jq -n -r --arg env "${CALLUM_FLOW_TRUSTED_AUTHORS-}" --arg id "$_ta_id" '
    [($env | split(",")[]), $id] | map(select(contains(":")))
    | reduce .[] as $e ({seen: {}, out: []};
        ($e | split(":")) as $p | (($p[0] | ascii_downcase) + ":" + $p[1]) as $k
        | if .seen[$k] then . else .seen[$k] = true | .out += [$e] end)
    | .out | join(",")'
}

# trusted_authors_check: exit 0 if the effective list is non-empty and valid.
# Otherwise print one line naming the variable (or the identity file) and the
# problem on stdout, exit 1.
trusted_authors_check() {
  _ta_nl=$(printf '\n_')
  _ta_nl=${_ta_nl%_}
  _ta_ok=true
  _ta_entry=$(_ta_entry_re)
  case "${CALLUM_FLOW_TRUSTED_AUTHORS-}" in *"$_ta_nl"*) _ta_ok=false ;; esac
  if [ -n "${CALLUM_FLOW_TRUSTED_AUTHORS-}" ] \
    && { [ "$_ta_ok" = false ] || ! printf '%s\n' "$CALLUM_FLOW_TRUSTED_AUTHORS" | grep -Eq "^${_ta_entry}(,${_ta_entry})*\$"; }; then
    echo "CALLUM_FLOW_TRUSTED_AUTHORS is malformed (expected $TRUSTED_AUTHORS_FORMAT, no spaces)"
    return 1
  fi
  if ! trusted_authors_identity_entry >/dev/null 2>&1; then
    echo "$(trusted_authors_identity_file) is malformed (expected a JSON object with a string login and a numeric id)"
    return 1
  fi
  if [ -z "$(trusted_authors_effective)" ]; then
    echo "CALLUM_FLOW_TRUSTED_AUTHORS is not set (expected $TRUSTED_AUTHORS_FORMAT)"
    return 1
  fi
  return 0
}

# trusted_authors_json: the effective list as a JSON array of {"login":
# lower-cased, "id": number}, for jq. Call only after trusted_authors_check succeeded.
trusted_authors_json() {
  trusted_authors_effective | jq -R -c \
    'split(",") | map(split(":") | {login: (.[0] | ascii_downcase), id: (.[1] | tonumber)})'
}
