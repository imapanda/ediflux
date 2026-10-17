# Contributing to Ediflux

Thanks for your interest! Ediflux is in early design, so the most useful contributions right
now are ideas, feedback and real-world EDI requirements in
[Discussions](https://github.com/imapanda/ediflux/discussions).

## Ground rules

- **No real partner data, ever.** Messages, logs and samples must be anonymized: company
  names, addresses, GLNs, prices and references. The repository is public.
- Security issues go through the [security policy](SECURITY.md), not public issues.
- Repository content is written in English.

## How a change reaches `main`

1. **Discuss first.** Open or pick an [issue](https://github.com/imapanda/ediflux/issues)
   so that the approach is agreed before you spend time on code.
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
4. **Pass the checks.** Every pull request must pass the required checks (see
   [CI/CD](docs/ci-cd.md)) and have all review conversations resolved.
5. **Mark it ready for review.** A maintainer reviews it and squash-merges it.

Releases are automated: merged changes accumulate in a release pull request, and merging that
pull request publishes the version.

## Running the checks locally

The CI tools all run without installing anything permanently:

```bash
npx markdownlint-cli2 "**/*.md"
uvx typos
uvx zizmor .
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12
```
