import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { loadYaml, readContract } from "./load.ts";

interface OpenApiDocument {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, object> };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const raw = loadYaml("openapi/api.yaml") as Record<string, unknown>;
const document = raw as unknown as OpenApiDocument;

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

  it("declares no x-go-* extension, which the Go generator would turn into code", () => {
    expect(readContract("openapi/api.yaml")).not.toMatch(/x-go-/);
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
