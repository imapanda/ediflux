#!/usr/bin/env bash
# Developer Certificate of Origin check (ADR 9): every non-merge commit in
# <base>..<head> must carry a "Signed-off-by:" trailer whose e-mail is the one
# of the commit author. Case is ignored, and so is the name, which people spell
# in different ways.
#
# Usage: check-dco.sh <base> <head>   (commits or refs, for example origin/main HEAD)
# Exit status:
#   0  all commits are signed off;
#   1  at least one commit has no matching sign-off;
#   2  the commits could not be read (bad usage, unknown revision). This fails
#      closed: an unreadable range is never reported as "signed off".
#
# Commit subjects and e-mails are untrusted input. Before they are printed,
# control characters are removed and the runner's workflow commands are stopped
# with a random token, so that a subject cannot forge an annotation
# ("::error::...", or the legacy "##[error]...").
set -euo pipefail

# Same result in CI and on a laptop: ASCII-only case folding and character classes.
export LC_ALL=C

if [ "$#" -ne 2 ]; then
  echo "usage: check-dco.sh <base> <head>" >&2
  exit 2
fi

resolve() {
  git rev-parse --verify --quiet --end-of-options "$1^{commit}" || {
    echo "::error title=DCO::Cannot read the commits of this pull request"
    echo "check-dco.sh: cannot resolve a base or head revision to a commit" >&2
    exit 2
  }
}
base=$(resolve "$1")
head=$(resolve "$2")

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Removes control characters (a lone CR splits lines in the runner log) and caps the length.
clean() { tr -d '\000-\010\013-\037\177' | cut -c1-200; }

# A plain assignment, unlike a process substitution, aborts the script when git fails.
commits=$(git rev-list --no-merges --reverse "$base..$head")

unsigned=()

while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  author_email=$(git log -1 --format=%ae "$sha")
  author_email=$(lower "$author_email")
  signoffs=$(git log -1 --format='%(trailers:key=Signed-off-by,valueonly,unfold)' "$sha")
  signed=false
  # git only reads trailers from the last paragraph of the message, so a
  # "Signed-off-by:" line in the middle of the body does not count.
  while IFS= read -r signer; do
    signer=${signer%"${signer##*[![:space:]]}"} # trailing whitespace
    # The expected form is "Name <email>".
    case $signer in
      *'<'*'>')
        email=${signer##*<}
        email=${email%>}
        if [ -n "$email" ] && [ "$(lower "$email")" = "$author_email" ]; then
          signed=true
          break
        fi
        ;;
    esac
  done <<<"$signoffs"
  if [ "$signed" = false ]; then
    unsigned+=("$sha")
  fi
done <<<"$commits"

if [ "${#unsigned[@]}" -eq 0 ]; then
  echo "All commits are signed off."
  exit 0
fi

echo "::error title=DCO::${#unsigned[@]} commit(s) without a matching Signed-off-by line"
echo
echo "These commits have no Signed-off-by line matching the e-mail of their author:"
token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
echo "::stop-commands::$token"
for sha in "${unsigned[@]}"; do
  subject=$(git log -1 --format=%s "$sha" | clean)
  author=$(git log -1 --format=%ae "$sha" | clean)
  echo "  ${sha:0:7} <$author> $subject"
done
echo "::$token::"
cat <<'EOF'

By signing off, you certify the Developer Certificate of Origin
(https://developercertificate.org/): you wrote the change or have the right to
submit it under the project licence. To fix this, sign off your commits and push
again (origin is the remote that points at imapanda/libredi, upstream for a fork):

  git fetch origin
  git rebase --signoff origin/main
  git push --force-with-lease

If a commit was made with another e-mail than the one in your git configuration,
rewrite its author too:

  git rebase -f --exec 'git commit --amend --no-edit --reset-author --signoff' origin/main

See CONTRIBUTING.md, "Fix a failed DCO check".
EOF

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### DCO sign-off missing"
    echo
    echo "${#unsigned[@]} commit(s) have no \`Signed-off-by:\` line matching their author."
    echo "Run \`git rebase --signoff origin/main\`, then \`git push --force-with-lease\`."
    echo "See \`CONTRIBUTING.md\`, \"Fix a failed DCO check\"."
  } >>"$GITHUB_STEP_SUMMARY"
fi

exit 1
