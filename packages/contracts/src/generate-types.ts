import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { CANONICAL_DOCUMENTS } from "./canonical.ts";
import { loadJson, loadYaml } from "./load.ts";

const schemaDir = fileURLToPath(new URL("../../../contracts/canonical/v1/", import.meta.url));
const generatedDir = fileURLToPath(new URL("./generated/", import.meta.url));

const banner = (what: string, from: string) => `/**
 * ${what}
 *
 * Generated from ${from} by src/generate-types.ts.
 * Do not edit: change the contract, then run \`pnpm --filter @libredi/contracts generate\`.
 * The tests fail when this file is out of date.
 */`;

const options = { style: { singleQuote: false, semi: true, printWidth: 100 } } as const;

/**
 * TypeScript source for every canonical document. One root type lists the documents, so that the
 * definitions they share (parties, quantities, packages) are declared once.
 */
export async function generateCanonicalTypes(): Promise<string> {
  const root = {
    title: "CanonicalDocument",
    oneOf: CANONICAL_DOCUMENTS.map(({ file }) => ({ $ref: `${file}.schema.json` })),
  };
  return compile(root, "CanonicalDocument", {
    ...options,
    additionalProperties: false, // the canonical schemas are closed
    cwd: schemaDir,
    bannerComment: banner(
      "Types of the canonical documents, version 1.",
      "contracts/canonical/v1/*.schema.json",
    ),
  });
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Points the references of an OpenAPI document's schemas at the `$defs` of the generated root. */
function localRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(localRefs);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string"
        ? value.replace("#/components/schemas/", "#/$defs/")
        : localRefs(value),
    ]),
  );
}

/**
 * TypeScript source for the schemas of the OpenAPI contract. They are JSON Schema 2020-12, so the
 * same generator serves; `Components["schemas"]` has the shape of the `openapi-typescript` output,
 * which can replace this when it runs on the TypeScript version of the repository.
 */
export async function generateApiTypes(
  openapi: unknown = loadYaml("openapi/api.yaml"),
): Promise<string> {
  const { schemas } = (openapi as { components: { schemas: Record<string, Json> } }).components;
  const names = Object.keys(schemas);
  const root = {
    title: "Components",
    type: "object",
    properties: {
      schemas: {
        type: "object",
        properties: Object.fromEntries(names.map((name) => [name, { $ref: `#/$defs/${name}` }])),
        required: names,
        additionalProperties: false,
      },
    },
    required: ["schemas"],
    additionalProperties: false,
    $defs: Object.fromEntries(
      names.map((name) => [name, { title: name, ...(localRefs(schemas[name] as Json) as object) }]),
    ),
  };
  return compile(root as JSONSchema, "Components", {
    ...options,
    bannerComment: banner(
      "Types of the schemas of the REST API.",
      "components.schemas of contracts/openapi/api.yaml",
    ),
  });
}

/** TypeScript source for the envelope of the jobs in the queue. */
export async function generateJobTypes(
  envelope: unknown = loadJson("jobs/job-envelope.schema.json"),
): Promise<string> {
  return compile(envelope as JSONSchema, "JobEnvelope", {
    ...options,
    cwd: generatedDir,
    bannerComment: banner("Types of the job envelope.", "contracts/jobs/job-envelope.schema.json"),
  });
}

/** Every generated file: its name, where it is written and how to produce it. */
export const GENERATED = [
  { file: "canonical-v1.ts", generate: generateCanonicalTypes },
  { file: "api.ts", generate: generateApiTypes },
  { file: "jobs.ts", generate: generateJobTypes },
].map((entry) => ({ ...entry, path: `${generatedDir}${entry.file}` }));

if (import.meta.main) {
  for (const { path, generate } of GENERATED) {
    writeFileSync(path, await generate());
  }
}
