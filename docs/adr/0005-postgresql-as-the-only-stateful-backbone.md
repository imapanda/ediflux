# 5. PostgreSQL as the only stateful backbone

- Status: accepted
- Date: 2026-10-17

## Context

Reliability requires durable state, a job queue with retries and dead-letter, scheduled
jobs and replay. Brokers (RabbitMQ, NATS, Kafka) and workflow engines (Temporal) add
stateful containers to operate, back up and secure.

## Decision

- PostgreSQL stores configuration, messages, transitions, numbering and the **job queue**
  (`FOR UPDATE SKIP LOCKED`), using a maintained queue library in the worker's language
  (pg-boss for TypeScript, River for Go; see ADR 4).
- Raw and rendered files live in a content-addressed archive (filesystem volume or
  S3-compatible storage), referenced by SHA-256 from the database.
- State changes and the jobs they trigger are written in one transaction.
- Duplicate detection: unique key on environment + partner + interchange sender, recipient
  and control reference, plus the content hash.

## Consequences

- One stateful container to back up; simple Compose file.
- Queue throughput is bounded by PostgreSQL; sufficient for millions of messages per day.
  Revisit (broker or durable-workflow engine) only if measurements demand it.
- Multi-tenancy later uses row-level security and per-tenant concurrency limits.
