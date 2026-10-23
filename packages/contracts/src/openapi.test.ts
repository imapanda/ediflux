import type { AddressInfo } from "node:net";
import { createServer } from "@libredi/api/server";
import { Validator } from "@seriousme/openapi-schema-validator";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadYaml } from "./load.ts";

interface OpenApiDocument {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, object> };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const raw = loadYaml("openapi/api.yaml") as Record<string, unknown>;
const document = raw as unknown as OpenApiDocument;

function schemaOf(name: string): object {
  const schema = document.components.schemas[name];
  if (schema === undefined) {
    throw new Error(`components.schemas.${name} is missing from contracts/openapi/api.yaml`);
  }
  return schema;
}

describe("contracts/openapi/api.yaml", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(structuredClone(raw));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(document.openapi).toMatch(/^3\.1\./);
  });

  it("is served under /api, the prefix the reverse proxy strips", () => {
    expect(document.servers.map((server) => server.url)).toEqual(["/api"]);
  });

  it("gives every operation a unique operationId", () => {
    const ids = Object.values(document.paths).flatMap((item) =>
      HTTP_METHODS.filter((method) => method in item).map(
        (method) => (item[method] as { operationId?: unknown }).operationId,
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the api service honours the contract", () => {
  const server = createServer();
  const ajv = new Ajv2020({ strict: true });
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  it("GET /healthz returns a Health document", async () => {
    const validate = ajv.compile(schemaOf("Health"));
    const body: unknown = await (await fetch(`${base}/healthz`)).json();
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("errors are Problem documents", async () => {
    const validate = ajv.compile(schemaOf("Problem"));
    const response = await fetch(`${base}/missing`);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    const body: unknown = await response.json();
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  });
});
