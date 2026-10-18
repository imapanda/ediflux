# 9. Developer Certificate of Origin for contributions

- Status: accepted
- Date: 2026-10-18

## Context

Libredi is AGPL-3.0 and its founder may sell managed hosting. Contributions must be
legally clean without discouraging contributors. A Contributor License Agreement (CLA)
would keep relicensing options open but adds friction; the Developer Certificate of Origin
(DCO) only certifies that the contributor has the right to submit the work under the
project licence.

## Decision

- Contributions are accepted under AGPL-3.0 with a **DCO sign-off** (`git commit -s`,
  `Signed-off-by:` line), no CLA.
- Web commits require sign-off (`web_commit_signoff_required`), and CI checks the sign-off
  of every commit in a pull request.
- Because pull requests are squash-merged, the sign-offs are kept in the squash commit body.

## Consequences

- Selling hosting of the AGPL software is allowed; modified source must be offered to
  network users.
- Relicensing, or a proprietary dual licence, would need the consent of every contributor.
  This option is knowingly given up.
