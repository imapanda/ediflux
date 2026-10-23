# Contracts

The language-neutral interfaces between services, written before the code that implements
them. A service in any language reads these files; none of them is generated from code.

| Path | Describes | Used for |
| --- | --- | --- |
| [`openapi/api.yaml`](openapi/api.yaml) | The REST API of the `api` service (OpenAPI 3.1) | Synchronous calls between services, the web console and the MCP server |
| [`jobs/job-envelope.schema.json`](jobs/job-envelope.schema.json) | The envelope of every job in the PostgreSQL queue (JSON Schema 2020-12) | Asynchronous steps, through pgmq |
| [`canonical/`](canonical/README.md) | The neutral order, order response, despatch advice and invoice (JSON Schema 2020-12, versioned) | The documents partner mappings produce and ERP exports read |
| [`mapping/`](mapping/README.md) | The YAML format of a mapping, with its JSON Schema and examples | Declarative conversion between a message and a canonical document |

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
  service's code.

Each job type will get its own payload schema next to the envelope, in `jobs/`, when the
worker implements it. The TypeScript types of the canonical documents are generated into
`packages/contracts`; generated TypeScript and Go clients and validators for the OpenAPI and
job contracts come with the contract tooling (issue #182).
