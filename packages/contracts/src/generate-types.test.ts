import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edit, get } from "./edit.ts";
import {
  GENERATED,
  generateApiTypes,
  generateCanonicalTypes,
  generateJobTypes,
} from "./generate-types.ts";
import { loadJson, loadYaml } from "./load.ts";

describe("generated TypeScript types", () => {
  describe.each(GENERATED)("$file", ({ path, generate }) => {
    it("are what the contracts generate (run `pnpm --filter @libredi/contracts generate` after a change)", async () => {
      expect(await generate()).toBe(readFileSync(path, "utf8"));
    });

    it("are produced identically every time", async () => {
      expect(await generate()).toBe(await generate());
    });
  });

  it("declare one type per canonical document, and each shared type once", async () => {
    const source = await generateCanonicalTypes();
    for (const name of [
      "Order",
      "OrderResponse",
      "DespatchAdvice",
      "Invoice",
      "Party",
      "Package",
      "UnsignedDecimal",
    ]) {
      expect(source.match(new RegExp(`^export (interface|type) ${name}\\b`, "gm"))).toHaveLength(1);
    }
  });

  it("declare the schemas of the OpenAPI contract and the job envelope", async () => {
    const api = await generateApiTypes();
    for (const name of ["Health", "Problem", "Components"]) {
      expect(api).toMatch(new RegExp(`^export interface ${name}\\b`, "m"));
    }
    expect(await generateJobTypes()).toMatch(/^export interface JobEnvelope\b/m);
  });
});

describe("a deliberate contract break changes the generated types, so the drift check fails", () => {
  const openapi = loadYaml("openapi/api.yaml");
  const envelope = loadJson("jobs/job-envelope.schema.json");
  const current = (file: string) => {
    const generated = GENERATED.find((entry) => entry.file === file);
    if (!generated) throw new Error(`${file} is not a generated file`);
    return generated.generate();
  };

  it.each([
    ["a property of Health is removed", "components.schemas.Health.properties.service", undefined],
    ["a property of Problem becomes optional", "components.schemas.Problem.required", ["type"]],
    ["a status of Health changes", "components.schemas.Health.properties.status.const", "up"],
  ])("OpenAPI: %s", async (_label, path, value) => {
    expect(get(openapi, path), `${path} must exist in the contract`).toBeDefined();
    const broken = edit(openapi, path, value) as Record<string, unknown>;
    expect(await generateApiTypes(broken)).not.toBe(await current("api.ts"));
  });

  it.each([
    ["a new environment", "properties.environment.enum", ["test", "production", "staging"]],
    ["a required property is dropped", "required", ["type"]],
    ["a property is removed", "properties.messageId", undefined],
  ])("job envelope: %s", async (_label, path, value) => {
    expect(get(envelope, path), `${path} must exist in the contract`).toBeDefined();
    const broken = edit(envelope, path, value) as Record<string, unknown>;
    expect(await generateJobTypes(broken)).not.toBe(await current("jobs.ts"));
  });
});
