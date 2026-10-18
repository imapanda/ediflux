# 2. Technical services and horizontal scaling

- Status: accepted
- Date: 2026-10-17

## Context

Libredi must run on a single small server for a self-hosting company and on a cluster for
the hosted offer. Load is uneven: translation is CPU-bound, transports are I/O-bound, the
API is request-driven. The founder wants to be able to run, for example, five workers and
two translators.

## Decision

1. Split the application into **technical services**: `api`, `worker`, `translator`,
   `sftp-gateway`, `as2-gateway`, `connectors`, `web`, `mcp`, plus PostgreSQL and a file
   archive. No business-domain microservices: business rules live in the worker and in
   mappings.
2. Every service follows the **scaling rules** of [architecture.md](../architecture.md):
   no local state, safety through database constraints, no leader, graceful shutdown,
   health and readiness endpoints, configuration through environment variables.
3. Services are reached through a reverse proxy, never through fixed host ports, so
   `docker compose up --scale <service>=N` works on one machine; a Helm chart covers
   several machines later.
4. Only the `api` and `worker` write to the database. Gateways and the MCP server go
   through the `api`; the translator is pure (input in, result out).

## Consequences

- Each service can use the language that suits it (see ADR 4) and be scaled on its own.
- More moving parts than a monolith: one Compose file, shared conventions and an
  end-to-end test suite are mandatory from the start.
- PostgreSQL remains the single stateful core; it is scaled vertically first.
