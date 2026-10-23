# 10. Service boundaries and communication

- Status: accepted
- Date: 2026-10-23

## Context

The founder wants real microservices (each service built, versioned, deployed, scaled and,
if needed, rewritten on its own) and a strong focus on performance. A decision council
(2026-10-23) compared gRPC with REST and a "best language per service" approach with the
TypeScript-first choice of [ADR 4](0004-language-per-service.md). Its main findings:

- With files passed by reference, inter-service payloads are small; serialization costs
  microseconds while PostgreSQL commits and archive writes cost milliseconds.
- The measured gap between a naive and a well-designed EDIFACT scanner in the same
  language (about 15×) dwarfs the gap between Node.js and Go (about 2×).
- The throughput ceiling of the system is PostgreSQL (writes per state transition, queue
  churn, vacuum), not the language of the services.
- The mapping language, JSONata, is only reliable in its JavaScript reference
  implementation, and the console must preview mappings exactly as the server runs them.
- Connectors share no code with the other services and benefit from Go's SFTP/FTP stack.

## Decision

### 1. Deployment units

- **One Docker image per service** (`libredi-api`, `libredi-worker`, `libredi-translator`,
  `libredi-connectors`, `libredi-mcp`, `libredi-web`, later `libredi-as2-gateway`), built
  from `services/<name>/Dockerfile`, versioned and released per service.
- **One CI job per service**, path-filtered and aggregated in the required `CI result` check.
- A service never imports another service's code. Shared code lives in `packages/*`
  (per language) and language-neutral contracts in `contracts/`; CI enforces the boundary.

### 2. Synchronous calls: REST/JSON with OpenAPI

- Used when a caller waits for an answer: `web`, `mcp`, ERPs and integrators call `api`;
  `sftp-gateway` and `as2-gateway` hand received files to `api`; `worker` calls
  `translator`.
- Contracts are OpenAPI 3.1 documents in `contracts/openapi/`, with generated clients and
  contract tests in CI. Calls carry timeouts, idempotency keys and a W3C `traceparent`.
- **gRPC is not used**: it would save microseconds on small payloads, while its long-lived
  HTTP/2 connections defeat DNS and layer-4 load balancing under `--scale`, it cannot be
  called from a browser or with `curl`, and it adds a protobuf toolchain for every
  contributor. Revisit only if a measured internal hot path is dominated by serialization.

### 3. Asynchronous steps: pgmq queues in PostgreSQL

- Every step that must survive a failure (processing stages, deliveries, retries, scheduled
  work) goes through **pgmq** queues in PostgreSQL. pgmq is used through its SQL API
  (`send`, `read` with visibility timeout, `archive`, `delete`), so a consumer can be
  written in any language. It is installed in its SQL-only form, to work on any PostgreSQL
  (to be confirmed on managed PostgreSQL by the load test below).
- Job payloads are JSON documents described by versioned JSON Schemas in
  `contracts/jobs/` (`type`, `version`, ids, archive references, `traceparent`).
- Delivery is at least once: consumers are idempotent. Retries with backoff and a
  dead-letter queue are implemented by a small shared library per language.
- A job is enqueued in the same transaction as the state change that triggers it.
- The queue sits behind a narrow interface so a broker (NATS JetStream) can replace it if
  measurements ever require it.

### 4. Files travel by reference

Files are never inside requests or jobs: they are stored once in the content-addressed
archive and referenced by SHA-256 (claim-check pattern).

### 5. Data ownership

- **One PostgreSQL schema and one database role per service**, with least privilege; no
  service reads another service's tables.
- `translator`, `web` and `mcp` have no database access; `mcp` goes through `api`.

### 6. Language per service

| Service | Language | Reason specific to the service |
| --- | --- | --- |
| `api` | TypeScript | Bound by PostgreSQL, shares contracts and types with `web` and `mcp` |
| `worker` | TypeScript | Bound by PostgreSQL and the queue |
| `translator` | TypeScript, separate service with a worker-thread pool | JSONata reference engine, identical preview in the browser, isolation of user mappings |
| `connectors` | Go | Best SFTP/FTP stack for legacy partner servers, small memory per connection, no shared code |
| `as2-gateway` | Decided by the M8 interop spike: our own (TypeScript or Go) or OpenAS2 | Cryptography is native either way |
| `web` | TypeScript (static single-page app) | Browser |
| `mcp` | TypeScript | Tier 1 official SDK, generated API client |
| `sftp-gateway` | SFTPGo (Go), unmodified | Off the shelf |

Rust and Python are not used today. Rust is the candidate if the `translator` misses its
performance budget; Python may serve a specification-reading component at milestone 6 for
its PDF ecosystem.

### 7. Performance is measured, not assumed

- **Initial service-level objectives**, to be confirmed by measurement:
  - `translator`: at least 500 typical orders per second per core;
  - end to end: 95 % of messages delivered within 5 s of receipt at nominal load;
  - memory budget per idle replica: 150 MiB for TypeScript services, 50 MiB for Go;
  - cost per 1,000 messages tracked for the hosted offer.
- **Per-service benchmarks in CI** with regression thresholds.
- **PostgreSQL and pgmq load test before milestone 3**, with the real number of writes per
  message; its results drive the schema (writes per message, partitioning, autovacuum).

## Consequences

- Two languages to maintain for our own code (TypeScript and Go), plus pinned third-party
  images; contracts become the source of truth between them.
- Any service can be rewritten in another language without touching the others, as long as
  it keeps its contracts and passes its contract tests.
- Supersedes parts of earlier ADRs:
  - [ADR 2](0002-technical-services-and-horizontal-scaling.md), decision 4 (only `api` and
    `worker` write to the database) → section 5 above;
  - [ADR 4](0004-language-per-service.md): `connectors` in TypeScript, `worker` with pg-boss
    and the single image with several entrypoints → sections 1, 3 and 6 above;
  - [ADR 5](0005-postgresql-as-the-only-stateful-backbone.md): queue library per language
    (pg-boss, River) → section 3 above.
