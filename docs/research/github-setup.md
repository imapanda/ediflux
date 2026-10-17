# Research: GitHub features for the project

> Research snapshot of **2026-10-17** (docs.github.com, GitHub changelog, OpenAPI
> description). Facts marked *(unverified)* could not be confirmed on a primary source.

## What we use and how

| Feature | Use in Ediflux | Notes |
| --- | --- | --- |
| **Projects** (public) | Roadmap, board, backlog and "good first issues" views; fields Status, Priority (P0–P3), Size (XS–XL), Iteration (2 weeks), Start and Target dates | Fields and views can be created through the API; roadmap date settings and built-in workflows (auto-add, auto-archive) are UI only |
| **Milestones** | One per release (v0.1, v0.2…), with due dates | Shown as markers on the roadmap |
| **Sub-issues** | Epic → tasks (max 100 per parent, 8 levels) | GA 2025-04; availability on personal-account repos is unclear *(smoke-test first)* |
| **Issue dependencies** | "blocked by" between tasks across epics | GA 2025-08 |
| **Issue types / issue fields** | Bug, Feature, Task, Epic; custom fields | **Organization-only**; on a personal repo, use `type:` labels and project fields |
| **Labels** | `type:*`, `area:*` (one per service), `needs-triage`, `breaking-change`, `dependencies`, `security`, `partner-format`, `good first issue`, `help wanted` | `good first issue` feeds GitHub's discovery |
| **Issue forms** | Bug, feature, partner-format request, docs; blank issues disabled; questions redirected to Discussions | `.github/ISSUE_TEMPLATE/*.yml` |
| **Discussions** | Announcements, General, Ideas, Polls, Q&A, Show and tell, plus "Partner formats & mappings" and "RFCs"; forms per category | Categories are created in the UI only |
| **Actions** | CI with one always-on required check (`CI result`), path filters per service, reusable workflows | Standard runners, including `ubuntu-24.04-arm`, are free and unlimited for public repos |
| **GHCR** | Multi-arch images per service, built on native amd64 and arm64 runners, merged by digest | First publish of a package is private: switch to public in the UI; packages do **not** follow a repository transfer |
| **Attestations** | Build provenance and SBOM for every image (`actions/attest`) | Free for public repos |
| **Releases** | release-please (manifest mode, one version for all images), draft then publish; immutable releases | Release PRs need a PAT or GitHub App token to trigger CI |
| **Pages** | Documentation site with Astro Starlight | Not for running a commercial SaaS site |
| **Security** | Dependabot (alerts, security and version updates), secret scanning with push protection, private vulnerability reporting, CodeQL default setup, OpenSSF Scorecard | Generic secret patterns and validity checks are paid features |
| **Community files** | Code of conduct (Contributor Covenant 3.0), contributing (DCO), security, support, governance, funding, CODEOWNERS, PR template | Social preview image is UI only |
| **Codespaces** | Devcontainer matching the Compose stack | 120 core-hours/month free on personal accounts |
| **Sponsors** | Optional, for the founder | France is supported |

## Personal account or organization?

Features only available to organizations: issue types, issue fields, merge queue, custom
properties, teams, organization projects and templates. Moving later is costly: GHCR
packages stay with the old owner, Pages URLs are not redirected, and user-owned projects
cannot be linked to an organization repository.

**Recommendation**: create a free `ediflux` organization and transfer the repository before
publishing images, enabling Pages or creating the project board.

## DCO or CLA

With AGPL-3.0 and a DCO, contributors keep their copyright and certify they can contribute
under the project licence; hosting and selling the AGPL software is allowed without a CLA.
Relicensing or a proprietary dual licence would require every contributor's consent or a
CLA. The choice must be made before the first external contribution. Not legal advice.

## Pitfalls to remember

- A workflow skipped by path filters leaves a required check pending: require only the
  always-on aggregate job (`CI result`).
- `sub_issue_id` and `issue_id` in the REST API are database ids, not issue numbers.
- Squash merges drop per-commit `Signed-off-by` lines unless they are in the PR body.
- Pin actions by SHA, let Dependabot update them, then enforce SHA pinning.
- Add `org.opencontainers.image.source` to every image before its first push.

## Sources

[Projects REST views](https://docs.github.com/en/rest/projects/views),
[hierarchy view and view API (2026-01-15)](https://github.blog/changelog/2026-01-15-hierarchy-view-now-available-in-github-projects/),
[sub-issues and issue types (2025-04-09)](https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/),
[issue dependencies (2025-08-21)](https://github.blog/changelog/2025-08-21-dependencies-on-issues/),
[issue fields (2026-07-02)](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available),
[Discussions categories](https://docs.github.com/en/discussions/managing-discussions-for-your-community/managing-categories-for-discussions),
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[arm64 runners GA (2025-08-07)](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/),
[required checks and path filters](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
[GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[actions/attest](https://github.com/actions/attest),
[immutable releases (2025-10-28)](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/),
[release-please](https://github.com/googleapis/release-please-action),
[Starlight](https://starlight.astro.build/),
[OpenSSF Scorecard action](https://github.com/ossf/scorecard-action),
[Contributor Covenant 3.0](https://www.contributor-covenant.org/version/3/0/code_of_conduct/),
[repository transfer](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository),
[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
