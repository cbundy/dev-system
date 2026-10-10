#!/bin/sh
#
# Plain-shell tests for callum-flow-test-weakening (cbundy/dev-system#314).
# Real commits in a temp git repo, no stubs. The three flagged commits are
# rebuilt from `git show 8bc09bf`, `cb78337` and `7152dff` with their subjects and
# changed lines verbatim; the rest are the cases that must stay unflagged.
# shellcheck disable=SC2016,SC2028  # fixture text is written verbatim
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
DET="$SCRIPT_DIR/../../../images/base/callum-flow-test-weakening"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset CALLUM_FLOW_TEST_PATHS

new_repo() {
  r="$tmpdir/$1"
  git init -q "$r"
  cd "$r"
  git commit -q --allow-empty -m base
  git tag base
}
# commit <subject>: stage everything and commit; prints nothing
commit() {
  git add -A
  git commit -q -m "$1"
}
# expect <label> <expected-output-with-SHA>: run the detector over base..HEAD
expect() {
  label=$1 want=$2
  got=$(sh "$DET" --base base --head HEAD) || fail "$label: detector exited $?"
  want=$(printf '%s' "$want" | sed "s/SHA/$(git rev-parse HEAD)/")
  [ "$got" = "$want" ] || fail "$label: expected [$want] got [$got]"
}

# --- 8bc09bf: the ci step removed a whole test ----------------------------------
new_repo r8bc
mkdir tests
cat > tests/evaluate.test.js <<'JS'
  check(mod.NM_OPTIONAL);
  check(mod.NM_EXPORT_SCHEMA);
});

test("the export query is the same in docs/metrics.md and the evaluate-sessions skill", () => {
  const body = (file) => {
    const m = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(fs.readFileSync(file, "utf8"));
    assert.ok(m, `${file} has no export query`);
    return m[1];
  };
  const root = path.join(__dirname, "..");
  const doc = body(path.join(root, "docs", "metrics.md"));
  assert.equal(body(path.join(root, "plugins", "callum-flow", "skills", "evaluate-sessions", "SKILL.md")), doc);
  // every table it exports is one the tool reads or knowingly ignores, with a real nm-export table
  const { TABLES } = require(path.join(root, "images", "base", "nm-export"));
  for (const m of doc.matchAll(/'table', '(\w+)'/g)) assert.ok(TABLES[m[1]], `${m[1]} is not a mirrored table`);
});
JS
git add -A && git commit -q -m "feat: add the export query test"
git tag -f base >/dev/null
cat > tests/evaluate.test.js <<'JS'
  check(mod.NM_OPTIONAL);
  check(mod.NM_EXPORT_SCHEMA);
});
JS
commit "no-mistakes(ci): Removed the obsolete test requiring duplicated export SQL after the skill switched to linking the canonical query. Reproduced the CI failure first. Verification passed: 220 node tests, 18 shell suites, lint, and whitespace checks. Terraform lint checks were skipped because terraform is not on PATH"
expect 8bc09bf "WEAKENED commit=SHA step=ci restored=no files=tests/evaluate.test.js kinds=removed-assertion"
# a later commit that puts the test back turns restored=no into restored=yes
git checkout -q base -- tests/evaluate.test.js
commit "restore the export query test"
got=$(sh "$DET" --base base --head HEAD)
printf '%s\n' "$got" | sed -n 1p | grep -q ' step=ci restored=yes files=tests/evaluate.test.js kinds=removed-assertion$' || fail "restore: expected restored=yes, got [$got]"
[ "$(printf '%s\n' "$got" | wc -l | tr -d ' ')" = 1 ] || fail "restore: the restoring commit must not be flagged: [$got]"

# --- cb78337: a repair commit with no pipeline subject added --warn-only --------
new_repo rcb78
mkdir -p images/base/test/sections
cat > images/base/test/sections/06-dev-doctor.sh <<'SH'
check "dev-doctor reports a STALE base image as WARN with the rebuild fix, and stays exit 0" in_image '
  mkdir -p /tmp/stub
  printf "#!/bin/sh\necho \"dev-version: STALE base-image running=aaaaaaa latest=bbbbbbb (x)\"\necho \"dev-version: STALE claude running=1 latest=2\"\n" > /tmp/stub/dev-version
  chmod +x /tmp/stub/dev-version
  out=$(PATH=/tmp/stub:$PATH dev-doctor 2>&1); rc=$?
  echo "$out"
  [ $rc -eq 0 ] &&
  echo "$out" | grep -q "dev-doctor: WARN image is out of date: STALE base-image"
SH
git add -A && git commit -q -m "feat: stale image check" && git tag -f base > /dev/null
sed -i 's|PATH=/tmp/stub:\$PATH dev-doctor 2>&1|PATH=/tmp/stub:$PATH dev-doctor --warn-only 2>\&1|' images/base/test/sections/06-dev-doctor.sh
grep -q -- '--warn-only' images/base/test/sections/06-dev-doctor.sh || fail "fixture edit did not apply"
commit "test(base): run the stale-image dev-doctor check with --warn-only"
expect cb78337 "WEAKENED commit=SHA step=none restored=no files=images/base/test/sections/06-dev-doctor.sh kinds=warn-only"

# --- 7152dff: a review fix removed asserts in one file and strengthened another --
new_repo r7152
mkdir -p coder/test images/base/test/sections images/base
cat > coder/test/push-next.test.sh <<'SH'
grep -q 'Testing template changes from a workspace' "$case/out" || fail "no README pointer: $(cat "$case/out")"
[ ! -s "$case/calls" ] || fail "called coder without the template-tester directory: $(cat "$case/calls")"

# 5. The template's variables are committed: terraform.tfvars is in the pushed directory
# and sets the telemetry endpoint.
grep -q '^otlp_endpoint = "http://' "$TEMPLATE_DIR/terraform.tfvars" \
  || fail "$TEMPLATE_DIR/terraform.tfvars does not set otlp_endpoint"
grep -q '^trusted_authors = "[A-Za-z0-9-]*:[0-9]*"' "$TEMPLATE_DIR/terraform.tfvars" \
  || fail "$TEMPLATE_DIR/terraform.tfvars does not set trusted_authors"

# 6. smoke, agent ready: push, create from dev-system-next, ssh for the log, delete.
SH
cat > images/base/test/sections/02-toolchain.sh <<'SH'
check "dev-doctor FAILs without CALLUM_FLOW_TRUSTED_AUTHORS with the fix, and reports the count" in_image '
  out=$(env -u CALLUM_FLOW_TRUSTED_AUTHORS dev-doctor 2>&1); echo "$out" | grep -q "^dev-doctor: FAIL CALLUM_FLOW_TRUSTED_AUTHORS is not set" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=bad dev-doctor 2>&1 | grep -q "FAIL CALLUM_FLOW_TRUSTED_AUTHORS is malformed" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 dev-doctor 2>&1 | grep -q "OK   CALLUM_FLOW_TRUSTED_AUTHORS is set"'
SH
echo '  ok "CALLUM_FLOW_TRUSTED_AUTHORS is set ($(printf '"'%s'"' "$CALLUM_FLOW_TRUSTED_AUTHORS" | wc -l))"' > images/base/dev-doctor
git add -A && git commit -q -m "feat: trusted author checks" && git tag -f base > /dev/null
cat > coder/test/push-next.test.sh <<'SH'
grep -q 'Testing template changes from a workspace' "$case/out" || fail "no README pointer: $(cat "$case/out")"
[ ! -s "$case/calls" ] || fail "called coder without the template-tester directory: $(cat "$case/calls")"

# 6. smoke, agent ready: push, create from dev-system-next, ssh for the log, delete.
SH
cat > images/base/test/sections/02-toolchain.sh <<'SH'
check "dev-doctor FAILs without CALLUM_FLOW_TRUSTED_AUTHORS with the fix, and reports the count" in_image '
  out=$(env -u CALLUM_FLOW_TRUSTED_AUTHORS dev-doctor 2>&1); echo "$out" | grep -q "^dev-doctor: FAIL CALLUM_FLOW_TRUSTED_AUTHORS is not set" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=bad dev-doctor 2>&1 | grep -q "FAIL CALLUM_FLOW_TRUSTED_AUTHORS is malformed" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 dev-doctor 2>&1 | grep -qxF "dev-doctor: OK   CALLUM_FLOW_TRUSTED_AUTHORS is set (1 trusted author(s))" &&
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067,other:2 dev-doctor 2>&1 | grep -qxF "dev-doctor: OK   CALLUM_FLOW_TRUSTED_AUTHORS is set (2 trusted author(s))"'
SH
echo '  ok "CALLUM_FLOW_TRUSTED_AUTHORS is set ($(printf '"'%s\\n'"' "$CALLUM_FLOW_TRUSTED_AUTHORS" | wc -l))"' > images/base/dev-doctor
commit "no-mistakes(review): Fix trusted-author counts and remove source-only assertions"
expect 7152dff "WEAKENED commit=SHA step=review restored=no files=coder/test/push-next.test.sh kinds=removed-assertion"

# --- commits that must not be flagged --------------------------------------------
new_repo clean
mkdir tests
printf 'assert.equal(a, 1);\nassert.equal(b, 2);\n' > tests/a.test.js
printf 'check "one" run_one || true\n' > tests/b.test.sh
git add -A && git commit -q -m "feat: tests" && git tag -f base > /dev/null
# only adds tests
printf 'assert.equal(c, 3);\n' >> tests/a.test.js
commit "test: add a test"
# moves a test to another file
printf 'assert.equal(b, 2);\n' > tests/moved.test.js
printf 'assert.equal(a, 1);\nassert.equal(c, 3);\n' > tests/a.test.js
commit "test: move a test to its own file"
# rewrites assertions without reducing their count
printf 'assert.equal(a, 10);\nassert.equal(c, 30);\n' > tests/a.test.js
commit "test: tighten the assertions"
# edits a line that already contained || true
printf 'check "one" run_one_better || true\n' > tests/b.test.sh
commit "test: edit a tolerant line"
expect "unflagged" ""

# a merge commit that brings in main's test deletions is not scanned
git checkout -q -b side base
git rm -q -r tests
git commit -q -m "main deletes tests"
git checkout -q -
git merge -q --no-edit -s ours side > /dev/null 2>&1 || fail "merge failed"
# (main's own commits are reachable from the PR base, so they are out of range)
[ -z "$(sh "$DET" --base side --head HEAD)" ] || fail "a merge commit was flagged"

# --- one file's additions never offset another file's removals --------------------
new_repo perfile
mkdir tests
printf 'assert.equal(a, 1);\n' > tests/a.test.js
printf 'assert.equal(z, 0);\n' > tests/z.test.js
git add -A && git commit -q -m "feat: tests" && git tag -f base > /dev/null
: > tests/a.test.js
printf 'assert.equal(n, 1);\nassert.equal(m, 2);\n' > tests/new.test.js
git rm -q tests/z.test.js
commit "fix: shuffle"
out=$(sh "$DET" --base base --head HEAD)
printf '%s\n' "$out" | grep -q 'files=tests/a.test.js,tests/z.test.js kinds=removed-assertion$' || fail "per-file judgement: $out"

# --- skip, only, or-true and commented-assert -------------------------------------
new_repo kinds
mkdir tests
printf 'test("a", () => {\n  assert.ok(x);\n});\n' > tests/a.test.js
printf 'check "one" run_one\n' > tests/b.test.sh
git add -A && git commit -q -m "feat: tests" && git tag -f base > /dev/null
printf 'test.skip("a", () => {\n  assert.ok(x);\n});\n' > tests/a.test.js
printf 'check "one" run_one || true\n' > tests/b.test.sh
commit "no-mistakes(test): make it pass"
expect "skip and or-true" "WEAKENED commit=SHA step=test restored=no files=tests/a.test.js,tests/b.test.sh kinds=or-true,skip"
printf 'test("a", () => {\n  assert.ok(x);\n});\n' > tests/a.test.js
printf 'check "one" run_one\n' > tests/b.test.sh
commit "undo"
git tag base2
printf 'test("a", () => {\n  // assert.ok(x);\n});\n' > tests/a.test.js
commit "no-mistakes(lint): quiet"
got=$(sh "$DET" --base base2 --head HEAD)
printf '%s\n' "$got" | grep -q 'step=lint restored=no files=tests/a.test.js kinds=removed-assertion,commented-assert$' || fail "commented-assert: $got"
printf 'test("a", () => {\n  assert.ok(x);\n});\n' > tests/a.test.js
printf 'test.only("b", () => {});\n' >> tests/a.test.js
commit "add only"
sh "$DET" --base base2 --head HEAD | tail -1 | grep -q 'kinds=only$' || fail "only not flagged"

# a commit that only adds a token and removes nothing is still judged
printf 'test.skip("x", () => {});\n' >> tests/a.test.js
commit "add skip only"
sh "$DET" --base base2 --head HEAD | tail -1 | grep -q 'kinds=skip$' || fail "add-only commit not judged"

# --- CALLUM_FLOW_TEST_PATHS widens the test-path match -----------------------------
new_repo widen
mkdir checks
printf 'assert x\n' > checks/a.sh
git add -A && git commit -q -m "feat: checks" && git tag -f base > /dev/null
: > checks/a.sh
commit "drop the check"
[ -z "$(sh "$DET" --base base --head HEAD)" ] || fail "checks/ is not a test path by default"
got=$(CALLUM_FLOW_TEST_PATHS='^checks/' sh "$DET" --base base --head HEAD)
printf '%s\n' "$got" | grep -q 'files=checks/a.sh kinds=removed-assertion$' || fail "CALLUM_FLOW_TEST_PATHS: $got"

# --- exit codes ---------------------------------------------------------------------
rc=0; sh "$DET" --base nope --head HEAD > /dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "bad --base should exit 1, got $rc"
rc=0; sh "$DET" --base base --head nope > /dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "bad --head should exit 1, got $rc"
rc=0; sh "$DET" --base base > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "missing --head should exit 2, got $rc"
rc=0; sh "$DET" --bogus > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "unknown option should exit 2, got $rc"
rc=0; sh "$DET" > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "no arguments should exit 2, got $rc"

echo "PASS: test-weakening.test.sh"
