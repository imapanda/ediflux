import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createServer } from "./server.ts";

// The service tests its own responses against the contract it implements.
const contractFile = fileURLToPath(new URL("../../../contracts/openapi/api.yaml", import.meta.url));
const contract = parse(readFileSync(contractFile, "utf8")) as {
  components: { schemas: Record<string, object> };
};

function schemaOf(name: string): object {
  const schema = contract.components.schemas[name];
  if (schema === undefined) {
    throw new Error(`components.schemas.${name} is missing from contracts/openapi/api.yaml`);
  }
  return schema;
}

describe("the api service honours contracts/openapi/api.yaml", () => {
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
