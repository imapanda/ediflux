import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { CANONICAL_DOCUMENTS } from "./canonical.ts";

const schemaDir = fileURLToPath(new URL("../../../contracts/canonical/v1/", import.meta.url));

export const CANONICAL_TYPES_PATH = fileURLToPath(
  new URL("./generated/canonical-v1.ts", import.meta.url),
);

const BANNER = `/**
 * Types of the canonical documents, version 1.
 *
 * Generated from contracts/canonical/v1/*.schema.json by src/generate-types.ts.
 * Do not edit: change the schemas, then run \`pnpm --filter @libredi/contracts generate\`.
 * The tests fail when this file is out of date.
 */`;

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
    cwd: schemaDir,
    bannerComment: BANNER,
    additionalProperties: false,
    style: { singleQuote: false, semi: true, printWidth: 100 },
  });
}

if (import.meta.main) {
  writeFileSync(CANONICAL_TYPES_PATH, await generateCanonicalTypes());
}
