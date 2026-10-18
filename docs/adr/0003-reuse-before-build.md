# 3. Reuse proven components before building

- Status: accepted
- Date: 2026-10-17

## Context

Research ([open-source landscape](../research/open-source.md)) found mature open-source
components for transports and infrastructure, but no ecosystem that ships validated,
message-level EDIFACT definitions or a usable configuration model.

## Decision

- **Reuse as containers**: SFTPGo (AGPL-3.0) for `sftp-gateway`; OpenAS2 (GPL-3.0) for
  `as2-gateway` unless our own TypeScript service passes the interoperability gate of ADR 4
  (milestone 8); phase4 for AS4 later.
- **Reuse as libraries**: a PostgreSQL-backed job queue, JSONata for mappings, the official
  MCP SDK, StAEDI as a test oracle in CI.
- **Build**: the definition registry generator, the EDIFACT parser/validator/serializer,
  CONTRL/APERAK, the archive/idempotency/replay layer, the single declarative *flow* model
  (replacing Bots' routes, channels, translations, grammars and scripts), the console and the
  MCP tools.

## Consequences

- Third-party containers keep their licences; SFTPGo's NOTICE requires attribution and a
  source link when offered over a network (hosted offer).
- GPL-licensed data (e.g. bots-grammars) may be used for cross-checks only, not copied.
