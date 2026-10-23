# Governance

How Libredi is run, how decisions are made, and how to become a maintainer. Libredi is free
software under the [GNU Affero General Public License v3.0](LICENSE). Today it has a single
maintainer, its founder ([@imapanda](https://github.com/imapanda)); this document is written for
the day other people join.

## Roles

- **Contributor**: anyone who opens an issue, joins a discussion, or sends a pull request.
  Contributions are accepted under the project licence with a Developer Certificate of Origin
  sign-off, and without a CLA ([ADR 9](docs/adr/0009-developer-certificate-of-origin.md)).
  See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Maintainer**: a contributor trusted with write access. Maintainers triage issues, review and
  squash-merge pull requests, moderate [Discussions](https://github.com/imapanda/libredi/discussions),
  publish releases and look after the repository settings. They are listed in
  [`.github/CODEOWNERS`](.github/CODEOWNERS).

## How decisions are made

The kind of change decides where it is discussed:

- **Bug fix, small improvement, documentation:** an issue and a pull request, merged when the
  checks pass and the review conversations are resolved.
- **New capability, behavior or contract change:** an issue first, to agree on the approach
  before writing code.
- **Significant or hard-to-reverse change:** an RFC in Discussions, then an ADR.

The rules are:

- **Lazy consensus.** A maintainer merges a pull request once the checks pass, the review
  conversations are resolved and nobody has raised an unresolved objection.
- **RFCs.** A significant change (a new service, a new message format or contract, a change of
  a core technology) is proposed in the
  [RFCs](https://github.com/imapanda/libredi/discussions/categories/rfcs) category of Discussions.
  It stays open for comments for at least a week. Maintainers then accept it, ask for changes, or
  decline it, and explain why in the discussion.
- **ADRs.** An accepted decision is recorded as an architecture decision record in
  [`docs/adr`](docs/adr/) ([ADR 1](docs/adr/0001-record-architecture-decisions.md)). A pull
  request that changes an accepted decision includes a new ADR that supersedes the old one.
- **Disagreement.** Maintainers aim for consensus. With a single maintainer, that person decides
  after hearing the discussion and writes the reasoning down in the issue, the RFC or the ADR.
  With several, a decision without consensus needs a majority of maintainers.
- **Licence.** Relicensing would need the consent of every contributor, because there is no
  CLA ([ADR 9](docs/adr/0009-developer-certificate-of-origin.md)): in practice, the licence is
  fixed.
- **Managed hosting.** The founder may sell managed hosting of Libredi
  ([ADR 9](docs/adr/0009-developer-certificate-of-origin.md), [roadmap](docs/roadmap.md)). The
  project's own decisions are still made in the open, as described here.

## Becoming a maintainer

Maintainers are invited, not appointed on request. A contributor becomes a candidate after
several months of regular, good contributions: pull requests that merge with little rework,
helpful reviews, answers in Discussions, and care for the project's principles
([vision](docs/vision.md)).

1. A maintainer proposes the candidate to the other maintainers, in private, and the candidate
   accepts. While there are fewer than three maintainers, the proposal needs unanimous agreement;
   after that, a majority.
2. The candidate is given write access and added to [`.github/CODEOWNERS`](.github/CODEOWNERS).
3. When a second maintainer joins, the ruleset on `main` starts to require one approval from a
   code owner ([CI/CD](docs/ci-cd.md)).

A maintainer can step down at any time by telling the others. After about six months without any
activity, the other maintainers may ask a maintainer to step down, then remove their access and
thank them for their work.

## Security

Vulnerability reports are private and handled by the maintainers, following the
[security policy](SECURITY.md).

## Changing this document

Open a pull request. A substantial change, such as a new role or a new decision rule, goes
through an RFC first.
