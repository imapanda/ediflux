# 1. Record architecture decisions

- Status: accepted
- Date: 2026-10-17

## Context

Ediflux is built in the open, largely with AI assistance, by a small team. Decisions and
their reasons must survive turnover of people, sessions and tools.

## Decision

Significant decisions are recorded as short ADRs in `docs/adr/`, numbered, in English, with
the sections Context, Decision, Consequences. An ADR starts as `proposed`, becomes
`accepted` when merged after review, and is never edited afterwards except to mark it
`superseded by N`.

## Consequences

- A pull request that changes an accepted decision includes a new ADR.
- Issues and pull requests link the ADRs they rely on.
