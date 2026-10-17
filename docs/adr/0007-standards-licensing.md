# 7. Standards licensing: generate, never ship, derived data

- Status: proposed
- Date: 2026-10-17

## Context

See [standards research](../research/standards.md). The UN/EDIFACT directory licence
forbids distributing modified directories without written UN permission; GS1 forbids
redistributing EANCOM material; X12 dictionaries require a paid licence for distribution.

## Decision

- The repository, release artefacts and Docker images contain **no derived UN, GS1 or X12
  data**.
- A **directory generator** downloads the official UNECE zips at install time into the
  operator's volume and builds the JSON definition registry there.
- Test fixtures are synthetic and written by hand from the directory structure.
- EANCOM and partner specifics are user content (mapping packs), never bundled.
- X12 support, when it comes, relies on user-supplied schemas.
- "EANCOM" and other trademarks are used descriptively only.
- We may ask UNECE for written permission to redistribute derived forms; this ADR is
  revisited if granted.

## Consequences

- First start needs internet access (or an offline bundle of the official zips supplied by
  the operator).
- Copyright of Ediflux code stays clean, keeping licensing options open.
