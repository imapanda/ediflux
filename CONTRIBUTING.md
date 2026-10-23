# Contributing to Libredi

Thanks for your interest! Libredi is in early design, so the most useful contributions right
now are ideas, feedback and real-world EDI requirements in
[Discussions](https://github.com/imapanda/libredi/discussions). Questions are welcome too:
see [SUPPORT.md](SUPPORT.md). [GOVERNANCE.md](GOVERNANCE.md) explains how decisions are made
and how to become a maintainer.

## Ground rules

- **No real partner data, ever.** Messages, logs and samples must be anonymized: company
  names, addresses, GLNs, prices and references. The repository is public.
- Security issues go through the [security policy](SECURITY.md), not public issues.
- Repository content is written in English.
- **Sign off every commit** with `git commit -s`. The `Signed-off-by:` line certifies the
  [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change
  or have the right to submit it under the project licence (AGPL-3.0). There is no CLA
  ([ADR 9](docs/adr/0009-developer-certificate-of-origin.md)). The `DCO` check fails on a
  commit without a sign-off: see [Sign off your commits](#sign-off-your-commits).

## How a change reaches `main`

1. **Discuss first.** Open or pick an [issue](https://github.com/imapanda/libredi/issues)
   so that the approach is agreed before you spend time on code. A significant change starts
   as an RFC in Discussions instead ([how decisions are made](GOVERNANCE.md)).
2. **Branch.** Fork the repository (or create a branch if you have write access) and work
   on a topic branch. To bring in changes from `main`, merge it into your branch.
3. **Open a draft pull request** early. Its title must follow
   [Conventional Commits](https://www.conventionalcommits.org/):

   | Title                               | Meaning         | Release                  |
   | ----------------------------------- | --------------- | ------------------------ |
   | `feat: add EANCOM ORDERS parser`    | New feature     | minor                    |
   | `fix(sftp): retry on timeout`       | Bug fix         | patch                    |
   | `perf: stream large interchanges`   | Faster          | patch                    |
   | `feat!: rename mapping file format` | Breaking change | major (minor before 1.0) |

   Use `docs:`, `test:`, `refactor:`, `build:`, `ci:` or `chore:` for changes that users do
   not see: they stay in the history but not in the changelog.

   The title becomes the commit message on `main` and the changelog entry, so describe the
   change for a user, in lowercase, without a final period.
4. **Pass the checks.** Every pull request must pass the required checks (`CI result`,
   `PR title`, `DCO` and CodeQL, see [CI/CD](docs/ci-cd.md)) and have all review conversations
   resolved.
5. **Mark it ready for review.** A maintainer reviews it and squash-merges it.

Releases are automated: merged changes accumulate in a release pull request, and merging that
pull request publishes the version.

## Sign off your commits

Add `-s` when you commit:

```bash
git commit -s -m "fix(sftp): retry on timeout"
```

Git appends a line such as `Signed-off-by: Ada Lovelace <ada@example.com>`. By adding it you
certify the [Developer Certificate of Origin](https://developercertificate.org/). In VS Code,
turn on the setting `git.alwaysSignOff`; commits made in GitHub's web editor are signed off
for you.

The `DCO` check looks at every commit of your pull request. Each one needs a `Signed-off-by:`
line whose e-mail is the e-mail of the commit's author (`git config user.email`); upper and
lower case do not matter. The line must be in the trailer block at the end of the message,
where `git commit -s` puts it. Merge commits and pull requests opened by bots (Dependabot,
release automation) are not checked.

### Fix a failed DCO check

The check lists the commits without a matching sign-off. Sign off all the commits of your
branch, then push again. Below, `origin` is the remote that points at `imapanda/libredi`; if
you cloned your own fork, that remote is usually called `upstream`.

```bash
git fetch origin
git rebase --signoff origin/main
git push --force-with-lease
```

To fix only the last commit:

```bash
git commit --amend --no-edit --signoff
git push --force-with-lease
```

The sign-off uses your current `user.name` and `user.email`, but the check compares it with the
e-mail of each commit's author. If the check still fails, some commits were made with another
e-mail: compare `git log --format='%h %ae' origin/main..HEAD` with `git config user.email`.
For your own commits, rewrite the author as well:

```bash
git rebase -f --exec 'git commit --amend --no-edit --reset-author --signoff' origin/main
git push --force-with-lease
```

## Running the checks locally

To set up the development environment (Node.js, pnpm, Go, Docker Compose) and run the code
checks (`pnpm verify`, Go tests, image and Compose smoke tests), see
[docs/development.md](docs/development.md). The documentation and workflow checks are below.

The CI tools all run without installing anything permanently. Where a version is given, it is
the one of [`ci.yml`](.github/workflows/ci.yml):

```bash
npx markdownlint-cli2 "**/*.md"
uvx typos@1.51.1
docker run --rm -v "$PWD:/check" -w /check mstruebing/editorconfig-checker:4.0.2
docker run --rm -v "$PWD:/repo" -w /repo lycheeverse/lychee --offline --include-fragments --no-progress "./**/*.md"
uvx zizmor@1.31.1 .
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12
```

Before you push, check your sign-offs the way the `DCO` check does (after `git fetch origin`):

```bash
bash .github/scripts/check-dco.sh origin/main HEAD
```

If you change the checker itself, run its tests with `bash .github/scripts/test-check-dco.sh`.
