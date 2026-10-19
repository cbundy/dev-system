#!/bin/sh
# Sourced by scripts/test.sh: one full test run per machine, and a fair CPU share for the rest.
#
#   test_lock_take      a full run (no ids) takes an exclusive flock on <lock dir>/lock, after the
#                       caller's validation and before any setup. While another full run holds it,
#                       prints one stderr line naming the holder and waits. The holder writes its pid
#                       and checkout dir into the lock file. The wait is a background flock that is
#                       `wait`ed on, so the caller's INT and TERM traps fire at once.
#   test_runs_register  a run that is not nested registers as <lock dir>/<pid> (the checkout dir
#                       inside); entries of dead pids are ignored and removed. Sets TEST_LOCK_SHARE
#                       when TEST_JOBS is unset and live runs share the CPUs.
#   test_lock_clean     EXIT: stops a waiting flock and removes this run's entry.
#
# The lock dir is $TEST_LOCK_DIR, default /tmp/callum-dev-system-test. The lock is held on fd 9 of
# the caller, which must close it (9>&-) for anything long-lived it starts (the job pool, the
# PostgreSQL server): a stray process can then never keep the lock past the run. flock releases it
# when the holder exits for any reason, so there is no stale-lock cleanup.
#
# A run started from inside another run exports/sees TEST_LOCK_HELD=<lock dir> and then neither
# locks nor registers, so the gate's own tests that run test.sh cannot deadlock on it. Without
# flock on PATH a full run runs unlocked and TEST_LOCK_NOTE says so for the summary line.

# shellcheck disable=SC2034 # read by scripts/test.sh, which sources this file
TEST_LOCK_NOTE=""
# shellcheck disable=SC2034 # read by scripts/test.sh
TEST_LOCK_SHARE=""
_tl_dir=""
_tl_entry=""
_tl_waiter=""

# _tl_nested: sets _tl_dir; true when this run is nested in a run of the same lock dir.
_tl_nested() {
  _tl_dir=${TEST_LOCK_DIR:-/tmp/callum-dev-system-test}
  [ "${TEST_LOCK_HELD:-}" = "$_tl_dir" ]
}

_tl_alive() { # _tl_alive <pid>
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2> /dev/null
}

# test_lock_take: full runs only. Returns non-zero when the lock dir cannot be made.
test_lock_take() {
  _tl_nested && return 0
  mkdir -p "$_tl_dir" || return 1
  if ! command -v flock > /dev/null 2>&1; then
    TEST_LOCK_NOTE=" (runs unlocked: flock not on PATH)"
    return 0
  fi
  # <> never truncates, so a waiter can still read the holder's line.
  exec 9<> "$_tl_dir/lock" || return 1
  if ! flock -n 9; then
    _tl_holder=""
    _tl_tries=0
    while [ "$_tl_tries" -lt 20 ]; do
      _tl_holder=$(cat "$_tl_dir/lock" 2> /dev/null)
      _tl_hpid=${_tl_holder%% *}
      _tl_alive "$_tl_hpid" && break
      _tl_tries=$((_tl_tries + 1))
      sleep 0.1
    done
    if _tl_alive "$_tl_hpid"; then
      echo "test: waiting for another full run (pid $_tl_hpid, ${_tl_holder#* }) to finish" >&2
    else
      echo "test: waiting for another full run (pid unknown, unknown) to finish" >&2
    fi
    # Background, so a trap fires while we wait; the flock shares fd 9's open file description.
    flock 9 &
    _tl_waiter=$!
    wait "$_tl_waiter"
    _tl_status=$?
    _tl_waiter=""
    [ "$_tl_status" -eq 0 ] || return 1
  fi
  printf '%s %s\n' "$$" "$(pwd)" > "$_tl_dir/lock"
  return 0
}

# test_runs_register: every run that is not nested. Exports the marker for runs nested in it.
test_runs_register() {
  _tl_nested && return 0
  mkdir -p "$_tl_dir" || return 1
  TEST_LOCK_HELD=$_tl_dir
  export TEST_LOCK_HELD
  pwd > "$_tl_dir/$$" || return 1
  _tl_entry="$_tl_dir/$$"
  _tl_live=0
  for _tl_f in "$_tl_dir"/[0-9]*; do
    [ -f "$_tl_f" ] || continue
    if _tl_alive "${_tl_f##*/}"; then
      _tl_live=$((_tl_live + 1))
    else
      rm -f "$_tl_f"
    fi
  done
  [ "$_tl_live" -lt 1 ] && _tl_live=1
  TEST_LOCK_SHARE=""
  if [ "${TEST_JOBS+set}" != set ] && [ "$_tl_live" -gt 1 ]; then
    _tl_cpus=$(sh scripts/test-pool.sh --cpus)
    _tl_share=$((_tl_cpus / _tl_live))
    [ "$_tl_share" -lt 1 ] && _tl_share=1
    [ "$_tl_share" -lt "$_tl_cpus" ] && TEST_LOCK_SHARE=$_tl_share
  fi
  return 0
}

test_lock_clean() {
  [ -n "$_tl_waiter" ] && kill "$_tl_waiter" 2> /dev/null
  [ -n "$_tl_entry" ] && rm -f "$_tl_entry"
  return 0
}
