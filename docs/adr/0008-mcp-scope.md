# 8. MCP server scope and safety

- Status: proposed
- Date: 2026-10-17

## Context

Everything in Ediflux should be usable by an AI assistant, and the main differentiator is
drafting a partner flow from its specification. EDI traffic is business-critical and partner
specifications are confidential.

## Decision

- The `mcp` service exposes tools over Streamable HTTP and calls only the `api`, with the
  rights of the authenticated user. A local stdio variant wraps the CLI during early
  milestones.
- **Read tools** are available in every environment; **write tools** act only on the test
  environment. Promotion to production is always a human action in the console or API.
- Drafted mappings carry a confidence level and a specification reference per field;
  low-confidence fields block promotion until a human accepts them.
- Partner specifications and samples are tenant data: never sent anywhere except the model
  the user configured (bring your own key); never committed to the repository.
- Every MCP action is recorded in the audit log.

## Consequences

- The `api` must expose every capability the console has, with fine-grained permissions.
- Tools are designed for idempotency (`dry_run`, idempotency keys) like the rest of the API.
