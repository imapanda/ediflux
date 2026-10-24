import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { Components } from "./generated/api.ts";
import type { JobEnvelope } from "./generated/jobs.ts";
import { loadJson, loadYaml } from "./load.ts";

// Each literal is checked twice: by the compiler against the generated type, and by Ajv against
// the contract. When a contract changes and the types are regenerated, this file stops compiling.
const health: Components["schemas"]["Health"] = { status: "ok", service: "api" };
const problem: Components["schemas"]["Problem"] = {
  type: "about:blank",
  title: "Not Found",
  status: 404,
};
const envelope: JobEnvelope = {
  type: "message.parse",
  version: 1,
  messageId: "0b0a5f5e-5d0c-4f43-9d52-4a3f0d9d7a11",
  correlationId: "7c1d3a52-93f6-4a7b-8d19-2f6a1b0c5e34",
  environment: "test",
  enqueuedAt: "2026-01-15T09:30:00Z",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa1c3d02e7-01",
  payload: { archiveSha256: "0".repeat(64) },
};

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const openapi = loadYaml("openapi/api.yaml") as { components: { schemas: Record<string, object> } };

describe("typed examples agree with the contracts", () => {
  it.each([
    ["Health", health],
    ["Problem", problem],
  ])("OpenAPI %s", (name, value) => {
    const schema = openapi.components.schemas[name] as object;
    expect(ajv.validate(schema, value), JSON.stringify(ajv.errors)).toBe(true);
  });

  it("job envelope", () => {
    const schema = loadJson("jobs/job-envelope.schema.json") as object;
    expect(ajv.validate(schema, envelope), JSON.stringify(ajv.errors)).toBe(true);
    expect(envelope).toEqual(loadJson("jobs/examples/job-envelope.json"));
  });
});
