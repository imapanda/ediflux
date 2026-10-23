# Contracts

The language-neutral interfaces between services, written before the code that implements
them. A service in any language reads these files; none of them is generated from code.

| Path | Describes | Used for |
| --- | --- | --- |
| [`openapi/api.yaml`](openapi/api.yaml) | The REST API of the `api` service (OpenAPI 3.1) | Synchronous calls between services, the web console and the MCP server |
| [`jsonschema/job-envelope.schema.json`](jsonschema/job-envelope.schema.json) | The envelope of every job in the PostgreSQL queue (JSON Schema 2020-12) | Asynchronous steps, through pgmq |

## Rules

- **Contract first.** Change the file, then the code. A pull request that changes a route or a
  payload changes the matching file in `contracts/`.
- **Compatible within a version.** Add optional properties and new job types freely. Removing
  or renaming a property, or making one required, needs a new `schemaVersion` (queue) or
  a new path or version (REST). Readers ignore properties they do not know.
- **No raw EDI in the queue.** Payloads are small. Raw and rendered files stay in the archive
  and are referenced by their SHA-256.
- **Examples live next to the schema**, with fictitious data only.
- **Checked by the CI** whenever `contracts/`, a package or a service changes, through
  [`packages/contracts`](../packages/contracts): the files are valid, the examples pass,
  broken variants fail, and the `api` service's responses match the OpenAPI document.

Each job type will get its own payload schema under `jsonschema/jobs/` when the worker
implements it.
