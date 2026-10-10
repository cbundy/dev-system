#!/bin/sh
#
# Plain-shell tests for callum-flow-issue-read and the trusted-author list
# (cbundy/dev-system#307). A stub gh serves fixture JSON files, so nothing here
# touches the real API. Hermetic PATH, no network, no Docker.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
READ="$ROOT/images/base/callum-flow-issue-read"
EVENT="$ROOT/images/base/callum-flow-event"
SHARE="$ROOT/images/base"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

d="$tmpdir/state"
# Fixtures in $STUB_DIR are named after the API path with / and ? turned into _.
# <name>.json is served; <name>.fail makes the call fail; <name>.page2fail serves
# the file and then fails, as gh does when a later page errors.
cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
[ "$1" = api ] || { echo "unexpected gh $*" >&2; exit 1; }
shift
[ "$1" != --paginate ] || shift
name=$(printf '%s' "$1" | tr '/?&=' '____')
echo "$1" >> "$d/calls"
[ ! -f "$d/$name.fail" ] || exit 1
[ -f "$d/$name.json" ] || { echo "no fixture for $1" >&2; exit 1; }
cat "$d/$name.json"
[ ! -f "$d/$name.page2fail" ] || exit 1
STUB
chmod +x "$tmpdir/gh"

TRUSTED='cbundy:13131067'
run() {
  PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r \
    CALLUM_FLOW_EVENT_BIN="${EVENT_BIN:-$EVENT}" CALLUM_EVENTS_DIR="$tmpdir/events" CALLUM_FLOW_SHARE_DIR="$SHARE" \
    CALLUM_FLOW_TRUSTED_AUTHORS="$TRUSTED" "$SH" "$@"
}
rc_of() { set +e; run "$@" >"$tmpdir/out" 2>"$tmpdir/err"; rc=$?; set -e; }
expect_rc() { [ "$rc" = "$1" ] || fail "$2: exit $rc, wanted $1 (stderr: $(cat "$tmpdir/err"))"; }
no_out() { [ ! -s "$tmpdir/out" ] || fail "$1: stdout not empty: $(cat "$tmpdir/out")"; }
# $1 = secret text that must appear nowhere in stdout or stderr
absent() { ! grep -qF -- "$1" "$tmpdir/out" "$tmpdir/err" || fail "$2: '$1' leaked"; }
present() { grep -qF -- "$1" "$tmpdir/out" || fail "$2: '$1' missing from: $(cat "$tmpdir/out")"; }
events() { cat "$tmpdir/events"/* 2>/dev/null || true; }

reset() {
  rm -rf "$d" "$tmpdir/events"
  mkdir -p "$d" "$tmpdir/events"
  : > "$d/calls"
  TRUSTED='cbundy:13131067'
  unset EVENT_BIN
}
# user <login> <id>
user() { jq -n --arg l "$1" --argjson i "$2" '{login: $l, id: $i}'; }
OWNER=$(user cbundy 13131067)
# issue <n> <user-json> <title> <body> -> repos/o/r/issues/<n>.json
issue() {
  jq -n --argjson n "$1" --argjson u "$2" --arg t "$3" --arg b "$4" \
    '{number: $n, state: "open", title: $t, body: $b, user: $u, labels: [{name: "ready"}]}' > "$d/repos_o_r_issues_$1.json"
}
# comment <id> <user-json> <body>
comment() { jq -n --argjson i "$1" --argjson u "$2" --arg b "$3" '{id: $i, user: $u, created_at: "2026-10-10T10:00:00Z", body: $b}'; }
put() { f=$1; shift; "$@" > "$d/$f.json"; }
arr() { jq -s '.'; }

reset

# --- the trusted list: unset or malformed fails closed, naming the variable ------
issue 7 "$OWNER" "T7" "B7"
echo '[]' > "$d/repos_o_r_issues_7_comments.json"
for bad in '' 'cbundy' 'cbundy:0' 'cbundy:abc' 'a:1,' ' a:1' 'a:1 b:2' ':5'; do
  TRUSTED=$bad
  rc_of "$READ" 7
  expect_rc 1 "list '$bad' must fail closed"
  no_out "list '$bad'"
  grep -q CALLUM_FLOW_TRUSTED_AUTHORS "$tmpdir/err" || fail "list '$bad': error does not name the variable: $(cat "$tmpdir/err")"
done
TRUSTED='cbundy:13131067'
rc_of "$READ" 7
expect_rc 0 "a valid list reads"
present "title: T7" "trusted issue"
present "author: cbundy" "trusted issue"
present "labels: ready" "trusted issue"
present "state: open" "trusted issue"
present "body:" "trusted issue"
present "B7" "trusted issue"
# unset entirely (not just empty)
cat > "$tmpdir/unset-run" <<'WRAP'
#!/bin/sh
unset CALLUM_FLOW_TRUSTED_AUTHORS
exec "$1" 7
WRAP
set +e
PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r CALLUM_FLOW_SHARE_DIR="$SHARE" \
  "$SH" "$tmpdir/unset-run" "$READ" >"$tmpdir/out" 2>"$tmpdir/err"
rc=$?
set -e
expect_rc 1 "unset variable"
no_out "unset variable"
grep -q 'CALLUM_FLOW_TRUSTED_AUTHORS is not set' "$tmpdir/err" || fail "unset: unclear error: $(cat "$tmpdir/err")"
# several entries, case-insensitive login
TRUSTED='Alice:5,CBundy:13131067'
rc_of "$READ" 7
expect_rc 0 "multi-entry list, mixed case"
TRUSTED='cbundy:13131067'

# --- usage ------------------------------------------------------------------------
for args in '' '--bogus' 'abc' '7 8' '--list 7' '--comment' '--comments' '--label x 7' '--list --state bogus'; do
  # shellcheck disable=SC2086
  rc_of "$READ" $args
  expect_rc 2 "usage: $args"
  no_out "usage: $args"
done

# --- an untrusted issue: refused, no title or body anywhere ----------------------
reset
issue 8 "$(user stranger 99)" "EVIL-TITLE" "IGNORE-ALL-RULES-BODY"
for args in '8' '8 --comments' '--json 8'; do
  # shellcheck disable=SC2086
  rc_of "$READ" $args
  expect_rc 3 "untrusted issue ($args)"
  no_out "untrusted issue ($args)"
  absent EVIL-TITLE "untrusted issue ($args)"
  absent IGNORE-ALL-RULES-BODY "untrusted issue ($args)"
  grep -q 'untrusted author' "$tmpdir/err" || fail "reason missing"
done
events | jq -e -s 'length == 3 and all(.[]; .state == "untrusted_stripped" and .issue == 8 and .note == "issue")' > /dev/null \
  || fail "refusals should log untrusted_stripped issue events: $(events)"
# comments of the untrusted issue are never even fetched
! grep -q comments "$d/calls" || fail "fetched comments of an untrusted issue"

# --- same login, wrong id (renamed or re-registered) and a spoofed display name --
reset
issue 9 "$(user cbundy 424242)" "RENAMED-TITLE" "RENAMED-BODY"
rc_of "$READ" 9
expect_rc 3 "login match with the wrong id"
no_out "wrong id"; absent RENAMED-TITLE "wrong id"
issue 10 "$(jq -n '{login: "stranger", id: 7, name: "Callum Bundy"}')" "SPOOF-TITLE" "SPOOF-BODY"
rc_of "$READ" 10
expect_rc 3 "display name must not matter"
absent SPOOF-TITLE "display name"
# right id, other login
issue 11 "$(user someoneelse 13131067)" "ID-ONLY-TITLE" "x"
rc_of "$READ" 11
expect_rc 3 "id match with the wrong login"

# --- mixed comments --------------------------------------------------------------
reset
issue 7 "$OWNER" "T7" "B7"
{
  comment 1 "$OWNER" "owner-comment-one"
  comment 2 "$(user stranger 99)" "STRANGER-INJECTION"
  comment 3 "$(user cbundy 5)" "WRONG-ID-INJECTION"
  comment 4 "$(jq -n '{login: "x", id: 3, name: "Callum Bundy"}')" "DISPLAY-NAME-INJECTION"
  comment 5 "$(user CBundy 13131067)" "owner-comment-two"
} | arr > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments
expect_rc 0 "mixed comments"
present "owner-comment-one" "mixed"; present "owner-comment-two" "mixed"
present "stripped: 3" "mixed"
absent STRANGER-INJECTION mixed; absent WRONG-ID-INJECTION mixed; absent DISPLAY-NAME-INJECTION mixed
absent origin mixed
events | jq -e -s 'length == 1 and .[0].state == "untrusted_stripped" and .[0].issue == 7 and .[0].note == "comments=3"' > /dev/null \
  || fail "stripped comments should log comments=3: $(events)"
# no stripping, no event
reset
issue 7 "$OWNER" "T7" "B7"
comment 1 "$OWNER" "fine" | arr > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments
expect_rc 0 "clean comments"; present "stripped: 0" "clean"
[ -z "$(events)" ] || fail "nothing stripped, nothing logged"

# --json: stable shape, untrusted removed, count present
{ comment 1 "$OWNER" "keep-me"; comment 2 "$(user stranger 99)" "DROP-ME"; } | arr > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" --json 7 --comments
expect_rc 0 "json"
jq -e '.issue.number == 7 and .stripped == 1 and (.comments | length) == 1 and .comments[0].body == "keep-me"' "$tmpdir/out" > /dev/null \
  || fail "json shape: $(cat "$tmpdir/out")"
absent DROP-ME json
# paginated comments (two arrays concatenated, as gh --paginate prints them)
{ comment 1 "$OWNER" "page-one" | arr; comment 2 "$OWNER" "page-two" | arr; } | jq -c . > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments
expect_rc 0 "paginated"; present page-one paginated; present page-two paginated

# --- a failure event binary never fails the read ---------------------------------
{ comment 1 "$OWNER" "keep-me"; comment 2 "$(user stranger 99)" "DROP-ME"; } | arr > "$d/repos_o_r_issues_7_comments.json"
EVENT_BIN="$tmpdir/does-not-exist"
rc_of "$READ" 7 --comments
expect_rc 0 "event binary missing"; present keep-me "event failure"; present "stripped: 1" "event failure"
printf '#!/bin/sh\nexit 9\n' > "$tmpdir/bad-event"; chmod +x "$tmpdir/bad-event"
EVENT_BIN="$tmpdir/bad-event"
rc_of "$READ" 7 --comments
expect_rc 0 "event binary failing"; present keep-me "event failure"
unset EVENT_BIN

# --- fail closed -----------------------------------------------------------------
reset
issue 7 "$OWNER" "T7" "B7"
comment 1 "$OWNER" "ok" | arr > "$d/repos_o_r_issues_7_comments.json"
# the author lookup fails
touch "$d/repos_o_r_issues_7.fail"
rc_of "$READ" 7 --comments; expect_rc 1 "author lookup failure"; no_out "author lookup failure"
rm "$d/repos_o_r_issues_7.fail"
# page 2 of the comments fails
touch "$d/repos_o_r_issues_7_comments.page2fail"
rc_of "$READ" 7 --comments; expect_rc 1 "page 2 failure"; no_out "page 2 failure"
rm "$d/repos_o_r_issues_7_comments.page2fail"
# a comment with no user object
jq -n '{id: 1, body: "NO-USER-BODY"}' | arr > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments; expect_rc 1 "comment without user"; no_out "comment without user"; absent NO-USER-BODY "no user"
# a null user (deleted account) and a user without a numeric id
jq -n '{id: 1, body: "NULL-USER-BODY", user: null}' | arr > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments; expect_rc 1 "null user"; no_out "null user"
jq -n '{id: 1, body: "x", user: {login: "cbundy"}}' | arr > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments; expect_rc 1 "user without id"; no_out "user without id"
# unexpected JSON
echo '{"message": "Not Found"}' > "$d/repos_o_r_issues_7_comments.json"
rc_of "$READ" 7 --comments; expect_rc 1 "comments not an array"; no_out "comments not an array"
echo '[1, 2]' > "$d/repos_o_r_issues_7.json"
rc_of "$READ" 7; expect_rc 1 "issue not an object"; no_out "issue not an object"
echo 'not json' > "$d/repos_o_r_issues_7.json"
rc_of "$READ" 7; expect_rc 1 "garbage"; no_out "garbage"
# an issue object with no user
jq -n '{number: 7, title: "NO-USER-TITLE", body: "x"}' > "$d/repos_o_r_issues_7.json"
rc_of "$READ" 7; expect_rc 1 "issue without user"; no_out "issue without user"; absent NO-USER-TITLE "issue without user"

# --- --comment -------------------------------------------------------------------
reset
issue 7 "$OWNER" "T7" "B7"
issue 8 "$(user stranger 99)" "T8" "B8"
jq -n --argjson u "$OWNER" '{id: 55, user: $u, body: "single-ok", created_at: "x", issue_url: "https://api.github.com/repos/o/r/issues/7"}' > "$d/repos_o_r_issues_comments_55.json"
rc_of "$READ" --comment 55; expect_rc 0 "--comment"; present single-ok "--comment"
rc_of "$READ" --comment 'https://github.com/o/r/issues/7#issuecomment-55'; expect_rc 0 "--comment url"; present single-ok "--comment url"
# trusted comment on an untrusted issue
jq -n --argjson u "$OWNER" '{id: 56, user: $u, body: "ON-UNTRUSTED-ISSUE", created_at: "x", issue_url: "https://api.github.com/repos/o/r/issues/8"}' > "$d/repos_o_r_issues_comments_56.json"
rc_of "$READ" --comment 56; expect_rc 3 "comment on untrusted issue"; no_out "comment on untrusted issue"; absent ON-UNTRUSTED-ISSUE "comment on untrusted issue"
# untrusted comment on a trusted issue
jq -n '{id: 57, user: {login: "stranger", id: 99}, body: "STRANGER-SINGLE", created_at: "x", issue_url: "https://api.github.com/repos/o/r/issues/7"}' > "$d/repos_o_r_issues_comments_57.json"
rc_of "$READ" --comment 57; expect_rc 3 "untrusted comment"; no_out "untrusted comment"; absent STRANGER-SINGLE "untrusted comment"

# --- --list ----------------------------------------------------------------------
reset
{
  jq -n --argjson u "$OWNER" '{number: 1, title: "mine", user: $u, state: "open"}'
  jq -n '{number: 2, title: "STRANGER-ISSUE", user: {login: "stranger", id: 99}, state: "open"}'
  jq -n --argjson u "$OWNER" '{number: 3, title: "a-pr", user: $u, state: "open", pull_request: {}}'
  jq -n '{number: 4, title: "IMPERSONATED", user: {login: "cbundy", id: 1}, state: "open"}'
} | arr > "$d/repos_o_r_issues_state_open_per_page_100_labels_ready.json"
rc_of "$READ" --list --label ready
expect_rc 0 "--list"
present "#1 mine" "--list"; present "stripped: 2" "--list"
absent STRANGER-ISSUE list; absent IMPERSONATED list; absent a-pr list
events | jq -e -s 'length == 1 and .[0].issue == 2 and (.[0].note | startswith("list"))' > /dev/null || fail "list event: $(events)"
rc_of "$READ" --json --list --label ready
jq -e '(.issues | length) == 1 and .stripped == 2' "$tmpdir/out" > /dev/null || fail "list json"
# a label with a space is encoded
echo '[]' > "$d/repos_o_r_issues_state_open_per_page_100_labels_In%20development.json"
rc_of "$READ" --list --label 'In development'
expect_rc 0 "--list encoded label"; present "stripped: 0" "--list encoded label"
echo '[]' > "$d/repos_o_r_issues_state_all_per_page_100.json"
rc_of "$READ" --list --state all; expect_rc 0 "--list --state all"
touch "$d/repos_o_r_issues_state_open_per_page_100.fail"
rc_of "$READ" --list; expect_rc 1 "--list api failure"; no_out "--list api failure"

# --- --pr ------------------------------------------------------------------------
reset
jq -n --argjson u "$OWNER" '{number: 20, title: "PR-TITLE", body: "PR-BODY", state: "open", user: $u, labels: []}' > "$d/repos_o_r_pulls_20.json"
{ comment 1 "$OWNER" "conv-ok"; comment 2 "$(user stranger 99)" "CONV-EVIL"; } | arr > "$d/repos_o_r_issues_20_comments.json"
{ comment 3 "$OWNER" "rc-ok"; comment 4 "$(user stranger 99)" "RC-EVIL"; } | arr > "$d/repos_o_r_pulls_20_comments.json"
{ jq -n --argjson u "$OWNER" '{id: 5, user: $u, body: "rev-ok", state: "APPROVED", submitted_at: "x"}'
  jq -n '{id: 6, user: {login: "stranger", id: 99}, body: "REV-EVIL", state: "COMMENTED"}'; } | arr > "$d/repos_o_r_pulls_20_reviews.json"
rc_of "$READ" --pr 20
expect_rc 0 "--pr"; present PR-TITLE "--pr"; present PR-BODY "--pr"; present "stripped: 0" "--pr"
rc_of "$READ" --pr 20 --comments
expect_rc 0 "--pr --comments"
for ok in conv-ok rc-ok rev-ok "stripped: 3"; do present "$ok" "--pr --comments"; done
for bad in CONV-EVIL RC-EVIL REV-EVIL; do absent "$bad" "--pr --comments"; done
events | jq -e -s 'length == 1 and .[0].issue == 20 and .[0].pr == 20 and .[0].note == "comments=3"' > /dev/null || fail "pr event: $(events)"
rc_of "$READ" --json --pr 20 --comments
jq -e '.pr.number == 20 and .stripped == 3 and (.comments | length) == 1 and (.review_comments | length) == 1 and (.reviews | length) == 1' "$tmpdir/out" > /dev/null || fail "pr json"
# an untrusted PR is refused
jq -n '{number: 21, title: "EVIL-PR", body: "EVIL-PR-BODY", user: {login: "stranger", id: 99}}' > "$d/repos_o_r_pulls_21.json"
rc_of "$READ" --pr 21 --comments; expect_rc 3 "untrusted PR"; no_out "untrusted PR"; absent EVIL-PR "untrusted PR"
# one of the three comment fetches failing fails the read
touch "$d/repos_o_r_pulls_20_reviews.fail"
rc_of "$READ" --pr 20 --comments; expect_rc 1 "reviews failure"; no_out "reviews failure"

# --- --timeline ------------------------------------------------------------------
reset
{
  jq -n --argjson u "$OWNER" '{event: "labeled", actor: $u, created_at: "t1", label: {name: "ready"}}'
  jq -n '{event: "labeled", actor: {login: "stranger", id: 99}, created_at: "t2", label: {name: "EVIL-LABEL"}}'
  jq -n --argjson u "$OWNER" '{event: "cross-referenced", actor: $u, created_at: "t3", source: {issue: {number: 30, title: "TRUSTED-XREF", user: $u}}}'
  jq -n --argjson u "$OWNER" '{event: "cross-referenced", actor: $u, created_at: "t4", source: {issue: {number: 31, title: "UNTRUSTED-XREF", user: {login: "stranger", id: 99}}}}'
  jq -n '{event: "committed", message: "NO-ACTOR-COMMIT"}'
} | arr > "$d/repos_o_r_issues_7_timeline.json"
rc_of "$READ" --timeline 7
expect_rc 0 "--timeline"
present "labeled cbundy ready" "--timeline"; present "TRUSTED-XREF" "--timeline"; present "stripped: 3" "--timeline"
absent EVIL-LABEL timeline; absent UNTRUSTED-XREF timeline; absent NO-ACTOR-COMMIT timeline
events | jq -e -s 'length == 1 and .[0].note == "timeline=3"' > /dev/null || fail "timeline event: $(events)"
rc_of "$READ" --json --timeline 7
jq -e '(.events | length) == 2 and .stripped == 3' "$tmpdir/out" > /dev/null || fail "timeline json"
touch "$d/repos_o_r_issues_7_timeline.page2fail"
rc_of "$READ" --timeline 7; expect_rc 1 "timeline page 2 failure"; no_out "timeline page 2 failure"

reset
jq -n --argjson u "$OWNER" '{number: 7, title: "large", body: ("\n" * 65536), state: "open", labels: [], user: $u}' > "$d/repos_o_r_issues_7.json"
cp "$d/repos_o_r_issues_7.json" "$d/repos_o_r_pulls_7.json"
jq -cn --argjson u "$OWNER" 'range(1; 4) | [{id: ., user: $u, body: ("x" * 51200)}]' > "$d/repos_o_r_issues_7_comments.json"
cp "$d/repos_o_r_issues_7_comments.json" "$d/repos_o_r_pulls_7_comments.json"
cp "$d/repos_o_r_issues_7_comments.json" "$d/repos_o_r_pulls_7_reviews.json"
rc_of "$READ" --json 7 --comments
expect_rc 0 "large issue and paginated comments"
jq -e '(.issue.body == ("\n" * 65536)) and (.comments | length) == 3 and all(.comments[]; .body == ("x" * 51200)) and .stripped == 0' "$tmpdir/out" > /dev/null \
  || fail "large issue or comments truncated"
rc_of "$READ" --json --pr 7 --comments
expect_rc 0 "large PR and all comment collections"
jq -e '(.pr.body == ("\n" * 65536)) and all(.comments, .review_comments, .reviews; length == 3 and all(.[]; .body == ("x" * 51200))) and .stripped == 0' "$tmpdir/out" > /dev/null \
  || fail "large PR or comment collections truncated"
jq -n --argjson u "$OWNER" '{id: 55, user: $u, body: ("\n" * 65536), issue_url: "https://api.github.com/repos/o/r/issues/7"}' > "$d/repos_o_r_issues_comments_55.json"
rc_of "$READ" --json --comment 55
expect_rc 0 "large single comment and parent issue"
jq -e '.comment.id == 55 and .comment.body == ("\n" * 65536) and .stripped == 0' "$tmpdir/out" > /dev/null \
  || fail "large single comment truncated"

# a late formatting failure must not leave partial stdout
{
  jq -n --argjson u "$OWNER" '{event: "labeled", actor: $u, created_at: "2026-10-10T10:00:00Z", label: {name: "ready"}}'
  jq -n --argjson u "$OWNER" '{event: "labeled", actor: $u, created_at: "2026-10-10T10:01:00Z", label: 1}'
} | arr > "$d/repos_o_r_issues_7_timeline.json"
rm -f "$d/repos_o_r_issues_7_timeline.page2fail"
rc_of "$READ" --timeline 7
[ "$rc" != 0 ] || fail "timeline with a malformed trusted event must fail"
no_out "timeline with a malformed trusted event"

echo "issue-read tests passed"
