# shellcheck shell=bash
# shellcheck disable=SC2034 # the mp_* variables and MEM_PSI_FULL_WARN are read by the sourcing script
#
# mem-pressure.sh: the memory pressure readings of the container's cgroup (cbundy/dev-system#1124).
# Sourced, not run, by heartbeat-loop (it sends them) and dev-doctor (it prints them). Bash builtins
# and read only: no ps, no awk, as heartbeat-loop's machine_stats. Each value is empty when its file
# or line is missing or not a number, never a guess.

# dev-doctor warns when PSI "full" avg10 (percent of time all tasks stalled on memory) is at or above this.
MEM_PSI_FULL_WARN=10

# _mp_uint V: success when V is a non-negative integer.
_mp_uint() {
  case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# _mp_dec V: success when V is a non-negative decimal (digits, optionally with a fraction).
_mp_dec() {
  case "$1" in
    '' | *[!0-9.]* | .* | *. | *.*.*) return 1 ;;
    *) return 0 ;;
  esac
}

# mem_pressure_read DIR: sets mp_max_events and mp_oom_kills (the "max" and "oom_kill" lines of
# DIR/memory.events) and mp_psi_some_avg10 and mp_psi_full_avg10 (the avg10 of the "some" and "full"
# lines of DIR/memory.pressure).
mem_pressure_read() {
  local dir=$1 k v rest f
  mp_max_events='' mp_oom_kills='' mp_psi_some_avg10='' mp_psi_full_avg10=''
  while read -r k v _; do
    case "$k" in
      max) if _mp_uint "$v"; then mp_max_events=$v; fi ;;
      oom_kill) if _mp_uint "$v"; then mp_oom_kills=$v; fi ;;
    esac
  done < "$dir/memory.events" 2> /dev/null || :
  while read -r k rest; do
    case "$k" in some | full) ;; *) continue ;; esac
    for f in $rest; do
      case "$f" in
        avg10=*)
          v=${f#avg10=}
          if _mp_dec "$v"; then
            if [ "$k" = some ]; then mp_psi_some_avg10=$v; else mp_psi_full_avg10=$v; fi
          fi
          break ;;
      esac
    done
  done < "$dir/memory.pressure" 2> /dev/null || :
  return 0
}

# mem_pressure_rate STATEFILE COUNT NOW_US [--update]: prints the "max" events per minute since the
# reading in STATEFILE ("<count> <epoch_us>"), rounded to 2 decimals. Empty with no (or an invalid)
# reading, after a counter reset (COUNT below the old one) or when no time has passed. With --update
# the new reading is written atomically (tmp + mv) whatever was printed.
mem_pressure_rate() {
  local file=$1 count=$2 now=$3 update=${4:-} pc='' pt='' out='' d dt h
  _mp_uint "$count" && _mp_uint "$now" || return 0
  { read -r pc pt _ < "$file"; } 2> /dev/null || :
  if _mp_uint "$pc" && _mp_uint "$pt" && [ "$count" -ge "$pc" ] && [ "$now" -gt "$pt" ]; then
    d=$((count - pc)) dt=$((now - pt))
    h=$(((d * 6000000000 + dt / 2) / dt))
    out=$(printf '%d.%02d' $((h / 100)) $((h % 100)))
  fi
  if [ "$update" = --update ]; then
    if printf '%s %s\n' "$count" "$now" > "$file.tmp" 2> /dev/null; then mv -f "$file.tmp" "$file" 2> /dev/null || :; fi
  fi
  printf '%s' "$out"
}
