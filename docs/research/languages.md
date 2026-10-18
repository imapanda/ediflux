# Research: language per service

> Research snapshot of **2026-10-17**. Benchmarks are indicative: throwaway code, a shared
> and loaded x86_64 host (AMD EPYC, 16 vCPU), Node 24.21 and Go 1.25.

## Summary

| Service | Recommended | Runner-up | Key reason |
| --- | --- | --- | --- |
| api | TypeScript (Node LTS, Fastify, Zod) | Go (huma, pgx, sqlc) | Schemas shared with web, mcp and worker; OpenAPI generated from them |
| worker | TypeScript + pg-boss | Go + River | I/O-bound state machine sharing the api's domain types |
| translator | TypeScript with a worker-thread pool | Go (gnata) or a Rust core as WebAssembly, on triggers | JSONata reference engine is JavaScript and runs in the browser too |
| sftp-gateway | SFTPGo (Go), off the shelf | custom Go service on `pkg/sftp` | Mature and active; nothing to write |
| as2-gateway | OpenAS2 (Java), off the shelf | custom Java service on phase2 | Only mature, maintained AS2 option; nothing production-grade in TS or Python (see the decision below) |
| connectors | TypeScript (ssh2, ImapFlow, undici) | Go (`x/crypto/ssh`, `pkg/sftp`, go-imap) | I/O-bound, shares worker code; Go's SFTP stack is stronger, first candidate to switch |
| web | React + Vite SPA | SvelteKit | Runs the mapping engine in the browser; largest ecosystem |
| mcp | TypeScript, official SDK (Tier 1) | Go SDK (Tier 1) | Zod schemas become tool schemas; MCP spec 2026-07-28 is stateless, good for replicas |

## Benchmarks

Synthetic 10 MB ORDERS-like interchange (1,083 messages, 443k segments), throwaway
tokenizer building an object tree:

| Test | Node 24 | Go 1.25 |
| --- | --- | --- |
| Whole interchange | 41–42 MB/s | 76–96 MB/s |
| Per 9 KB message | ~5.4k msg/s | 12.4–13.2k msg/s |
| Per 0.6 KB message | ~88k msg/s | ~158k msg/s |
| Flat scanner (no objects) | 737 MB/s | — |

- JSONata (compiled once) maps a 100-line order in **1.36 ms**: with parsing, about
  **600 orders per second per core**.
- The naive object tree used 34× the input size in memory: parse **message by message**
  with a memory budget.
- A runaway JSONata expression in a worker thread is stopped by `terminate()` after the
  timeout (verified at 300 ms); each worker thread costs ~16 MiB.

Runtime cost per replica (indicative):

| | Idle RSS | Cold start | Image |
| --- | --- | --- | --- |
| Go static binary | ~6 MiB | ~4 ms | ~12 MB with distroless |
| Node 24 + Fastify + Zod + pg | ~84 MiB | ~130 ms | ~215–245 MB |
| Python FastAPI stack | ~70 MiB | ~490 ms | ~180 MB + dependencies |

## Polyglot trade-off

- **Best language per service** would put Go in `connectors` and maybe Rust in the
  translator's hot path. The gain is mostly memory per replica, which matters only when
  running a dedicated stack per tenant.
- **One language for custom code** shares behaviour, not only types, across five services
  and the browser (validation, mappings, canonical documents), with one toolchain, one
  Dependabot ecosystem and one base image.
- **Rust/Go core compiled to WebAssembly** is mature for plain modules but adds a second
  toolchain and a boundary cost, and JSONata would still need a port. Keep the `edifact`
  package interface narrow so this stays possible.

**Decision on AS2 (ADR 4)**: build our own TypeScript `as2-gateway` on PKI.js and Node.js
crypto (Node 24 with OpenSSL 3.5 supports RSA-SHA256, RSA PKCS#1 v1.5 key transport,
AES-CBC/GCM and 3DES, checked locally) if it passes an interop matrix against OpenAS2,
phase2 and mendelson; otherwise use OpenAS2.

**Result**: one language to maintain (TypeScript); Go (SFTPGo) and Java (OpenAS2) only as
pinned third-party images.

## Rewrite triggers

- **translator → Rust or Go**: p95 CPU above ~20 ms per typical 50 KB message with
  validation and mapping; more than ~8–10 cores needed; large-interchange memory that
  cannot be bounded; JSONata above ~70 % of profiles after caching and pooling.
- **connectors → Go**: `ssh2` interop failures with real partner servers, or poor
  performance on files above 100 MB.
- **as2-gateway → custom Java on phase2**: need for HA with shared state, multi-tenant
  isolation, or tighter API integration.

## Risks

1. Heavy or runaway mappings blocking the event loop → worker threads with hard timeouts.
2. Memory amplification while parsing → streaming, message-at-a-time design.
3. OpenAS2 runs as a single replica with file state → documented exception.
4. `ssh2` has a single maintainer → narrow interface, pinned versions.
5. Young dependencies (MCP SDK v2, Drizzle RC, Bun) → prefer stable pins; no Bun in production.
6. Licences of bundled third-party containers → legal review before distributing a bundle.

## Sources

[MCP SDK tiers](https://modelcontextprotocol.io/community/sdk-tiers),
[MCP spec 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
[Node.js release schedule](https://endoflife.date/nodejs),
[Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/),
[Stack Overflow survey 2025](https://survey.stackoverflow.co/2025/technology/),
[SWE-bench Multilingual](https://www.swebench.com/multilingual.html),
[gnata](https://github.com/RecoLabs/gnata), [jsonata-python](https://github.com/rayokota/jsonata-python),
[Waarp AS2 (Go)](https://pkg.go.dev/code.waarp.fr/lib/as2), [OpenAS2](https://github.com/OpenAS2/OpenAs2App),
[phase2](https://github.com/phax/phase2), [SFTPGo](https://github.com/drakkan/sftpgo),
[Prisma: Rust to TypeScript](https://blog.prisma.io/blog/rust-to-typescript-update-boosting-prisma-orm-performance).
