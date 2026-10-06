# shellcheck shell=sh
#
# Reads a dev-system models file (images/base/models.env, baked into the image
# at /usr/local/share/dev-system/models.env): KEY=value lines, # comments and
# blank lines. The file is parsed, never sourced or eval'd, so a copy fetched
# from elsewhere cannot run code here.
#
#   . /usr/local/share/dev-system/models.sh
#   model=$(models_value <file> <KEY>)
#   url=$(models_url) && reason=$(models_fetch "$url" <dest>)
#   model=$(models_resolve <ENV_VAR> <KEY> <file>...)
#
# models_value prints the value of KEY and returns 0 when the file sets it to a
# valid value; returns 1 when the file is unreadable, KEY is not a known key or
# the file does not set it; returns 2 (with a note on stderr) when the value is
# not valid for KEY (models_valid). The last line that sets a key wins. Spaces
# around a line, and a trailing CR, are ignored.

MODELS_KEYS="CODEX_MODEL CLAUDE_MODEL AGENTS"

# models_valid <KEY> <value>: returns 0 when value is valid for KEY. AGENTS is
# the pipeline's ordered agent list: one or more comma-separated names, each
# matching [a-z0-9][a-z0-9:_-]*, with no empty entries and no spaces. Every
# other key is a model: one or more of [A-Za-z0-9._:/-].
models_valid() {
  case "$1" in
    AGENTS)
      case "$2" in
        "" | *[!a-z0-9:_,-]*) return 1 ;;
      esac
      _mv_rest="$2,"
      while [ -n "$_mv_rest" ]; do
        case "${_mv_rest%%,*}" in
          [a-z0-9]*) ;;
          *) return 1 ;;
        esac
        _mv_rest="${_mv_rest#*,}"
      done
      ;;
    *)
      case "$2" in
        "" | *[!A-Za-z0-9._:/-]*) return 1 ;;
      esac
      ;;
  esac
}

# models_rule <KEY>: what models_valid wants for KEY, for a note.
models_rule() {
  case "$1" in
    AGENTS) echo "a comma-separated list of agent names, each [a-z0-9][a-z0-9:_-]*, with no spaces" ;;
    *) echo "one or more of [A-Za-z0-9._:/-]" ;;
  esac
}

models_value() {
  _mv_file="$1"
  _mv_key="$2"
  case " $MODELS_KEYS " in
    *" $_mv_key "*) ;;
    *) return 1 ;;
  esac
  [ -r "$_mv_file" ] || return 1
  _mv_value=$(K="$_mv_key" awk '
    { sub(/\r$/, ""); sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "") }
    /^#/ || $0 == "" { next }
    index($0, ENVIRON["K"] "=") == 1 { value = substr($0, length(ENVIRON["K"]) + 2); found = 1 }
    END { if (found) print value; exit !found }' "$_mv_file") || return 1
  if ! models_valid "$_mv_key" "$_mv_value"; then
    echo "models: ignored $_mv_key in $_mv_file - its value must be $(models_rule "$_mv_key")" >&2
    return 2
  fi
  printf '%s\n' "$_mv_value"
}

# Where dev-init fetches the models file from on every start, so a model change
# merged to main reaches every workspace on its next start (cbundy/dev-system#162).
MODELS_URL_DEFAULT=https://raw.githubusercontent.com/cbundy/dev-system/main/images/base/models.env
# The fetch must never hold up a start for long: seconds to connect, and in all.
MODELS_FETCH_CONNECT_TIMEOUT=3
MODELS_FETCH_MAX_TIME=8

# models_url prints the URL to fetch the models file from: DEV_MODELS_URL when
# set, else MODELS_URL_DEFAULT. Returns 1 (and prints nothing) when
# DEV_MODELS_URL is set but empty, which turns the fetch off.
models_url() {
  _mu_url="${DEV_MODELS_URL-$MODELS_URL_DEFAULT}"
  [ -n "$_mu_url" ] || return 1
  printf '%s\n' "$_mu_url"
}

# models_fetch <url> <dest>: downloads the models file at url (https, or file
# for tests) into dest and returns 0 when it sets at least one known key to a
# valid value. Otherwise returns 1 and prints the reason, one line, on stdout;
# dest may then hold a partial or invalid download, which the caller removes.
models_fetch() {
  _mf_url="$1"
  _mf_dest="$2"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is not installed"
    return 1
  fi
  if ! _mf_err=$(curl -fsSL --proto '=https,file' --proto-redir '=https' \
    --connect-timeout "$MODELS_FETCH_CONNECT_TIMEOUT" --max-time "$MODELS_FETCH_MAX_TIME" \
    -o "$_mf_dest" "$_mf_url" 2>&1 </dev/null); then
    _mf_err=$(printf '%s\n' "$_mf_err" | sed -n '$s/^curl: //p')
    echo "${_mf_err:-curl failed}"
    return 1
  fi
  for _mf_key in $MODELS_KEYS; do
    models_value "$_mf_dest" "$_mf_key" >/dev/null 2>&1 && return 0
  done
  echo "it sets no valid $(echo "$MODELS_KEYS" | sed 's/ /, /g; s/, \([^,]*\)$/ or \1/')"
  return 1
}

# models_resolve <ENV_VAR> <KEY> <file>...: prints the value to use for KEY.
# ENV_VAR, when set at all, wins (even empty, which means none); otherwise
# the first file that sets KEY to a valid value. Prints nothing when none does.
models_resolve() {
  _mr_var="$1"
  _mr_key="$2"
  shift 2
  case "$_mr_var" in
    "" | [0-9]* | *[!A-Za-z0-9_]*) return 1 ;;
  esac
  if eval "[ \"\${$_mr_var+set}\" = set ]"; then
    eval "printf '%s\\n' \"\$$_mr_var\""
    return 0
  fi
  for _mr_file in "$@"; do
    _mr_value=$(models_value "$_mr_file" "$_mr_key") || continue
    printf '%s\n' "$_mr_value"
    return 0
  done
  return 0
}
