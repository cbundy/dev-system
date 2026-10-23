#!/bin/sh
# shellcheck disable=SC2016 # the bash -c scripts are single-quoted on purpose
# Plain-shell tests for images/base/mem-pressure.sh (cbundy/dev-system#1124): the cgroup memory
# readings and the rate of "max" events.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LIB="$SCRIPT_DIR/../mem-pressure.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[ -f "$LIB" ] || fail "$LIB is missing"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# read DIR: prints the four values, one per line, labelled.
reading() {
  bash -c '. "$1"; mem_pressure_read "$2"; printf "%s|%s|%s|%s" "$mp_max_events" "$mp_oom_kills" "$mp_psi_some_avg10" "$mp_psi_full_avg10"' _ "$LIB" "$1"
}
expect() { # EXPECTED LABEL GOT
  [ "$3" = "$1" ] || fail "$2: expected '$1', got '$3'"
}

# the real file shapes
d="$tmp/real"
mkdir "$d"
printf 'low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n' > "$d/memory.events"
printf 'some avg10=1.50 avg60=0.80 avg300=0.10 total=123456\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=789\n' > "$d/memory.pressure"
expect '12|2|1.50|0.25' "real shapes" "$(reading "$d")"

# a missing directory, a missing file and a missing line are empty
expect '|||' "missing dir" "$(reading "$tmp/none")"
d="$tmp/partial"
mkdir "$d"
printf 'low 0\nmax 5\n' > "$d/memory.events"
expect '5|||' "no oom_kill line, no pressure file" "$(reading "$d")"
printf 'some avg10=3.00 avg60=0 avg300=0 total=1\n' > "$d/memory.pressure"
expect '5||3.00|' "no full line" "$(reading "$d")"

# a non-number is empty
d="$tmp/junk"
mkdir "$d"
printf 'max lots\noom_kill -1\n' > "$d/memory.events"
printf 'some avg10=x avg60=0\nfull avg10=1.2.3 avg60=0\n' > "$d/memory.pressure"
expect '|||' "non numbers" "$(reading "$d")"

# the rate
rate() { bash -c '. "$1"; shift; mem_pressure_rate "$@"' _ "$LIB" "$@"; }
st="$tmp/state"
printf '10 1000000\n' > "$st"
expect '30.00' "30 events in 60 s" "$(rate "$st" 40 61000000)"
expect '15.00' "30 events in 120 s" "$(rate "$st" 40 121000000)"
expect '0.33' "rounds to 2 decimals" "$(rate "$st" 11 181000000)"
expect '0.00' "no new events" "$(rate "$st" 10 61000000)"
expect '10 1000000' "no --update leaves the file" "$(cat "$st")"
expect '' "no state file" "$(rate "$tmp/nostate" 40 61000000)"
expect '' "counter went down" "$(rate "$st" 9 61000000)"
expect '' "no time passed" "$(rate "$st" 40 1000000)"
expect '' "clock went back" "$(rate "$st" 40 500000)"
printf 'junk\n' > "$tmp/bad"
expect '' "invalid state file" "$(rate "$tmp/bad" 40 61000000)"
expect '' "non-number count" "$(rate "$st" x 61000000)"

# --update writes the new reading, atomically (no tmp file left), also when nothing is printed
expect '30.00' "--update prints the rate" "$(rate "$st" 40 61000000 --update)"
expect '40 61000000' "--update rewrites the file" "$(cat "$st")"
[ ! -e "$st.tmp" ] || fail "the tmp file is left behind"
expect '' "--update with no previous reading prints nothing" "$(rate "$tmp/new" 7 5000000 --update)"
expect '7 5000000' "--update creates the file" "$(cat "$tmp/new")"
expect '' "--update after a reset prints nothing" "$(rate "$tmp/new" 3 6000000 --update)"
expect '3 6000000' "--update stores the lower reading" "$(cat "$tmp/new")"

# the constant dev-doctor uses
expect 10 "MEM_PSI_FULL_WARN" "$(bash -c '. "$1"; echo "$MEM_PSI_FULL_WARN"' _ "$LIB")"

echo "mem-pressure: ok"
