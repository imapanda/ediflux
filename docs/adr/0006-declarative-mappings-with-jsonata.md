# 6. Declarative mappings with JSONata

- Status: accepted
- Date: 2026-10-17

## Context

Bots' mappings are arbitrary Python scripts: hard to review, impossible to sandbox, and
debugged with print statements. Libredi mappings must be readable by a human, writable by
an AI assistant, testable, and safe to run in a hosted environment.

## Decision

- A mapping is a **versioned YAML document**: metadata (flow, message type and version,
  direction), one JSONata expression per target field, lookup tables as data, and embedded
  fixtures (input sample → expected output).
- Mappings target or read **canonical documents** defined as JSON Schema, so partner
  mappings and ERP formats are independent.
- The runner is sandboxed: `$eval` disabled, limits on time, recursion depth and memory.
- A mapping version can be promoted to production only when all its fixtures pass.
- Mappings are one-way; inbound and outbound flows each have their own.

## Consequences

- The reference JSONata implementation is JavaScript; services in other languages must use
  a port or call the translator (see ADR 4).
- AI-drafted mappings can carry a confidence level and a spec reference per field, which the
  console displays for review.
