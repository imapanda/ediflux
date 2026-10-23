#!/usr/bin/env bash
# Tests for check-dco.sh. Builds throwaway git repositories with commits of every
# shape the checker must accept or reject, then runs the checker on them.
# Run it locally with: bash .github/scripts/test-check-dco.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checker="$here/check-dco.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

passed=0
failed=0

# Isolate the tests from the developer's git configuration, and from the
# runner's job summary: the checker must not write test noise into it.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
unset GITHUB_STEP_SUMMARY

indent() { sed 's/^/       /'; }

ok() {
  passed=$((passed + 1))
  echo "ok   - $1"
}

ko() {
  failed=$((failed + 1))
  echo "FAIL - $1"
  indent <<<"${output:-}"
}

new_repo() {
  repo="$work/$1"
  git init -q -b main "$repo"
  cd "$repo"
  commit "Root" "root@example.com" "chore: root" "Signed-off-by: Root <root@example.com>"
  base=$(git rev-parse HEAD)
}

# commit <author name> <author email> <subject> [<body paragraph>...]
# The committer is the author, unless COMMITTER_EMAIL is set.
commit() {
  local name=$1 email=$2 subject=$3
  shift 3
  local message="$subject"
  local paragraph
  for paragraph in "$@"; do
    message+=$'\n\n'"$paragraph"
  done
  GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email \
    GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=${COMMITTER_EMAIL:-$email} \
    git commit -q --allow-empty -m "$message"
}

# run <exit status wanted> <description> [<base> <head>]: run the checker, by
# default on base..HEAD, and compare its exit status.
run() {
  local want=$1 description=$2 status=0
  local from=${3-$base} to=${4-$(git rev-parse HEAD)}
  output=$(bash "$checker" "$from" "$to" 2>&1) || status=$?
  if [ "$status" -eq "$want" ]; then
    ok "$description"
  else
    ko "$description (wanted exit status $want, got $status)"
  fi
}

pass() { run 0 "$@"; }
fail() { run 1 "$@"; }

# Lines of the checker's output outside the window in which workflow commands are stopped.
outside_window() {
  awk '/^::stop-commands::/ { inside = 1; next } /^::[0-9a-f]+::$/ { inside = 0; next } !inside { print }' <<<"$output"
}

# expect_confined <marker> <description>: commit text (identified by <marker>)
# is printed only inside the stop-commands window, and nothing else outside the
# window looks like a workflow command except the checker's own annotation.
expect_confined() {
  local marker=$1 description=$2
  if ! grep -q -- "$marker" <<<"$output"; then
    ko "$description (the commit text is not reported at all)"
  elif outside_window | grep -q -- "$marker"; then
    ko "$description (commit text printed outside the stop-commands window)"
  elif outside_window | grep -Ev '^::error title=DCO::' | grep -Eq '::|##\['; then
    ko "$description (unexpected workflow command outside the window)"
  elif grep -q $'\r' <<<"$output"; then
    ko "$description (carriage return in the output)"
  else
    ok "$description"
  fi
}

alice=("Alice Martin" "alice@example.com")

new_repo matching
commit "${alice[@]}" "feat: add parser" "Signed-off-by: Alice Martin <alice@example.com>"
pass "sign-off matching the author passes"

new_repo unsigned
commit "${alice[@]}" "feat: add parser"
fail "commit without sign-off fails"

new_repo other-email
commit "${alice[@]}" "feat: add parser" "Signed-off-by: Bob Durand <bob@example.com>"
fail "sign-off of someone else fails"

new_repo case
commit "${alice[@]}" "feat: add parser" "Signed-off-by: Alice Martin <Alice@Example.COM>"
pass "e-mail comparison ignores case"

new_repo name
commit "${alice[@]}" "feat: add parser" "Signed-off-by: A. Martin <alice@example.com>"
pass "a different spelling of the name passes when the e-mail matches"

new_repo no-brackets
commit "${alice[@]}" "feat: add parser" "Signed-off-by: alice@example.com"
fail "a sign-off without <angle brackets> fails"

new_repo not-a-trailer
commit "${alice[@]}" "feat: add parser" \
  "Signed-off-by: Alice Martin <alice@example.com>" \
  "This paragraph follows, so the line above is not a trailer."
fail "sign-off outside the trailer block does not count"

new_repo first-trailer
commit "${alice[@]}" "feat: add parser" \
  "Signed-off-by: Alice Martin <alice@example.com>
Co-Authored-By: Bob Durand <bob@example.com>
Signed-off-by: Bob Durand <bob@example.com>"
pass "the matching sign-off may come before other trailers"

new_repo last-trailer
commit "${alice[@]}" "feat: add parser" \
  "Co-Authored-By: Bob Durand <bob@example.com>
Signed-off-by: Bob Durand <bob@example.com>
Signed-off-by: Alice Martin <alice@example.com>"
pass "the matching sign-off may come after other trailers"

new_repo committer-only
COMMITTER_EMAIL=bob@example.com commit "${alice[@]}" "feat: add parser" \
  "Signed-off-by: Bob Durand <bob@example.com>"
fail "the sign-off of the committer alone does not count"

new_repo author-differs
COMMITTER_EMAIL=bob@example.com commit "${alice[@]}" "feat: add parser" \
  "Signed-off-by: Alice Martin <alice@example.com>"
pass "the sign-off of the author counts when the committer is someone else"

new_repo one-bad
commit "${alice[@]}" "feat: first" "Signed-off-by: Alice Martin <alice@example.com>"
good=$(git rev-parse --short HEAD)
commit "${alice[@]}" "feat: second"
bad=$(git rev-parse --short HEAD)
commit "${alice[@]}" "feat: third" "Signed-off-by: Alice Martin <alice@example.com>"
fail "one unsigned commit among several fails"
if grep -q "$bad" <<<"$output" && ! grep -q "$good" <<<"$output"; then
  ok "only the unsigned commit is reported"
else
  ko "only the unsigned commit should be reported"
fi

new_repo merge
git switch -q -c topic
commit "${alice[@]}" "feat: on topic" "Signed-off-by: Alice Martin <alice@example.com>"
git switch -q main
commit "Root" "root@example.com" "chore: on main" "Signed-off-by: Root <root@example.com>"
base=$(git rev-parse HEAD)
git switch -q topic
GIT_AUTHOR_NAME=Alice GIT_AUTHOR_EMAIL=alice@example.com \
  GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=alice@example.com \
  git merge -q --no-ff -m "Merge main into topic" main
pass "an unsigned merge commit is ignored"

new_repo empty
pass "an empty range passes"

new_repo unrelated-base
commit "${alice[@]}" "feat: add parser" "Signed-off-by: Alice Martin <alice@example.com>"
git switch -q --orphan elsewhere
commit "Root" "root@example.com" "chore: elsewhere" "Signed-off-by: Root <root@example.com>"
other=$(git rev-parse HEAD)
git switch -q main
pass "a base that is not an ancestor of head still checks the commits" "$other" main

new_repo bad-revision
commit "${alice[@]}" "feat: add parser"
run 2 "an unknown base fails closed" 0123456789abcdef0123456789abcdef01234567 HEAD
run 2 "an unknown head fails closed" "$base" 0123456789abcdef0123456789abcdef01234567
run 2 "an option instead of a revision fails closed" --all HEAD
run 2 "a missing argument fails closed" "$base" ""

new_repo summary
commit "${alice[@]}" "feat: secret subject"
summary_file="$work/summary.md"
output=$(GITHUB_STEP_SUMMARY=$summary_file bash "$checker" "$base" HEAD 2>&1) || true
if grep -q "DCO sign-off missing" "$summary_file" && ! grep -q "secret subject" "$summary_file"; then
  ok "the job summary says what is missing, without commit text"
else
  ko "the job summary should be static text"
fi

new_repo injection-colons
commit "${alice[@]}" "::error::forged-colons annotation"
fail "a subject that looks like a workflow command fails"
expect_confined "forged-colons" "a '::' subject cannot forge a workflow command"

new_repo injection-legacy
commit "${alice[@]}" "legacy ##[error]forged-legacy ##[add-mask]e ##[stop-commands]tok"
fail "a subject with the legacy command syntax fails"
expect_confined "forged-legacy" "a '##[' subject cannot forge a workflow command"

new_repo injection-email
commit "Alice" "x##[warning]forged-email@example.com" "feat: odd e-mail"
fail "an author e-mail with the legacy command syntax fails"
expect_confined "forged-email" "a '##[' author e-mail cannot forge a workflow command"

new_repo injection-carriage-return
commit "${alice[@]}" $'carriage\r::error::forged-cr annotation'
fail "a subject with a carriage return fails"
expect_confined "forged-cr" "a carriage return cannot start a forged workflow command"

new_repo long-trailer
commit "${alice[@]}" "feat: huge sign-off" \
  "Signed-off-by: Mallory <$(printf '<%.0s' $(seq 1 20000))"
start=$SECONDS
fail "a very long malformed sign-off fails"
if [ $((SECONDS - start)) -le 5 ]; then
  ok "a very long malformed sign-off is checked in linear time"
else
  ko "a very long malformed sign-off took $((SECONDS - start)) seconds"
fi

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
