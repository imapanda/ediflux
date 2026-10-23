# Contracts

The language-neutral interfaces between services, written before the code that implements
them. A service in any language reads these files; none of them is generated from code.

| Path | Describes | Used for |
| --- | --- | --- |
| [`openapi/api.yaml`](openapi/api.yaml) | The REST API of the `api` service (OpenAPI 3.1) | Synchronous calls between services, the web console and the MCP server |
| [`jobs/job-envelope.schema.json`](jobs/job-envelope.schema.json) | The envelope of every job in the PostgreSQL queue (JSON Schema 2020-12) | Asynchronous steps, through pgmq |
| [`registry/registry.schema.json`](registry/registry.schema.json) | The EDIFACT definition registry: segments, composites, data elements, code lists, message structures (JSON Schema 2020-12) | The registry generator writes it; the parser and the validator read it. See its [README](registry/README.md) |

## Rules

- **Contract first.** Change the file, then the code. A pull request that changes a route or a
  payload changes the matching file in `contracts/`.
- **Compatible within a version.** Add optional properties and new job types freely. Removing
  or renaming a property, or making one required, needs a new job `version` (queue) or
  a new path or version (REST). Readers ignore properties they do not know.
- **No raw EDI in the queue.** Payloads are small. Raw and rendered files stay in the archive
  and are referenced by their SHA-256.
- **Examples live next to the schema**, with fictitious data only.
- **Checked by the CI** whenever `contracts/`, a package or a service changes:
  [`packages/contracts`](../packages/contracts) checks that the files are valid, that the
  examples pass and that broken variants fail; each service tests its own responses against
  the contract (see `services/api/src/contract.test.ts`). A service never imports another
  service's code. The registry schema is checked the same way by
  [`packages/registry`](../packages/registry), which will also hold the code that reads registries.

Each job type will get its own payload schema next to the envelope, in `jobs/`, when the
worker implements it. Generated TypeScript and Go clients and validators come with the
contract tooling (issue #182).
