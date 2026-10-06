# shellcheck shell=sh
#
# Reads a dev-system models file (images/base/models.env, baked into the image
# at /usr/local/share/dev-system/models.env): KEY=value lines, # comments and
# blank lines. The file is parsed, never sourced or eval'd, so a copy fetched
# from elsewhere cannot run code here.
#
#   . /usr/local/share/dev-system/models.sh
#   model=$(models_value <file> <KEY>)
#
# models_value prints the value of KEY and returns 0 when the file sets it to a
# valid value; returns 1 when the file is unreadable, KEY is not a known key or
# the file does not set it; returns 2 (with a note on stderr) when the value is
# empty or has characters outside [A-Za-z0-9._:/-]. The last line that sets a
# key wins. Spaces around a line, and a trailing CR, are ignored.

MODELS_KEYS="CODEX_MODEL CLAUDE_MODEL"

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
  case "$_mv_value" in
    "" | *[!A-Za-z0-9._:/-]*)
      echo "models: ignored $_mv_key in $_mv_file - its value is empty or has characters outside [A-Za-z0-9._:/-]" >&2
      return 2
      ;;
  esac
  printf '%s\n' "$_mv_value"
}
