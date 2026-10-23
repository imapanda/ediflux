# 4. Language per service

- Status: accepted, partly superseded by [ADR 10](0010-service-boundaries-and-communication.md)
- Date: 2026-10-17

> Partly superseded by ADR 10: one image per service instead of one image with several
> entrypoints, `connectors` in Go, pgmq instead of pg-boss, and the `as2-gateway` language
> left to the milestone 8 spike.

## Context

Services may use different languages (ADR 2). The comparison is in
[research/languages.md](../research/languages.md). Key facts:

- No ecosystem ships a validated EDIFACT engine: the parser is ours in every language.
- The mapping language, JSONata, has its reference implementation in JavaScript; the Go,
  Rust and Python ports are young or behave differently. The console must preview a
  mapping in the browser exactly as the server will run it.
- A throwaway benchmark on Node 24 parsed ~50 MB/s with a naive object tree (737 MB/s with
  a flat scanner) and mapped a 100-line order in 1.4 ms: about 600 orders per second per
  core, orders of magnitude above the target volume. Go was ~2× faster on the same naive
  design; the design mattered more than the language.
- The work is mostly I/O-bound (API, worker, connectors). Runtime memory per replica is the
  main cost of Node (~60–110 MiB vs ~10–30 MiB for Go).
- The project starts with a solo maintainer, fluent in TypeScript, working with AI
  assistance; TypeScript is the most-used language on GitHub (Octoverse 2025).

## Decision

| Service | Language / product | Rewrite trigger |
| --- | --- | --- |
| `api` | TypeScript, Node.js LTS, Fastify + Zod (OpenAPI generated from schemas) | — |
| `worker` | TypeScript + pg-boss | — |
| `translator` | TypeScript, mappings run in a worker-thread pool with hard timeouts | p95 CPU > ~20 ms per typical message, > ~8–10 cores needed, or unbounded memory on large interchanges → Rust or Go core (possibly as WebAssembly) |
| `connectors` | TypeScript (ssh2, ImapFlow, undici) | Interop failures with real partner SFTP servers or poor large-file performance → Go |
| `web` | TypeScript, React + Vite single-page app | — |
| `mcp` | TypeScript, official MCP SDK (Tier 1) | — |
| `sftp-gateway` | **SFTPGo** (Go), unmodified container | — |
| `as2-gateway` | TypeScript, our own service (PKI.js for CMS/S-MIME, Node.js crypto), stateless with keys in the database — **only if it passes the interoperability gate below** | Gate failed → **OpenAS2** (Java) container, active/passive |

- One **pnpm monorepo** with shared packages (`canonical`, `registry`, `edifact`, `mapping`,
  `api-client`) used by the services and by the browser.
- **One image, several entrypoints** (`ROLE=api|worker|translator|connectors|mcp`), plus
  `ROLE=all` for small installations; each role still scales independently.
- Plain SQL migration files, so a future service in another language can share the schema.
- The `edifact` package keeps a narrow interface (bytes in, JSON tree out) so it can be
  replaced by a Rust/WebAssembly implementation without touching its callers.

## Consequences

- One language to maintain for custom code; Go and Java only as pinned third-party images.
- Behaviour (validation, mappings) is shared, not re-implemented, between server, console
  and MCP server.
- Mitigations required from the first milestone: worker-thread isolation and timeouts for
  mappings, message-at-a-time parsing with a memory budget, benchmarks in CI re-run on the
  target ARM64 hardware.
- **AS2 interoperability gate** (milestone 8): our `as2-gateway` replaces OpenAS2 only if a
  spike passes an automated interop matrix against OpenAS2, phase2 and mendelson AS2
  containers: signing (SHA-1/SHA-256), encryption (3DES, AES-128/256-CBC, RSA PKCS#1 v1.5
  key transport), compression (RFC 5402), sync and async signed MDN with correct MIC, in
  both directions. Node.js 24 (OpenSSL 3.5) provides every primitive; PKI.js (active,
  v3.4) provides the CMS structures. Why build it: OpenAS2 keeps file-based state and runs as
  a single replica, is configured with XML files, is not multi-tenant and adds a Java
  runtime; our service would scale like the others, keep keys and partner settings in the
  database, and track MDNs in the same message lifecycle. If the gate fails, OpenAS2 runs
  as an active/passive exception to the scaling rules.
