import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { loadJson } from "./load.ts";

/** The canonical documents of version 1: the type written in `documentType`, and their file names. */
export const CANONICAL_DOCUMENTS = [
  { type: "order", file: "order" },
  { type: "orderResponse", file: "order-response" },
  { type: "despatchAdvice", file: "despatch-advice" },
  { type: "invoice", file: "invoice" },
] as const;

export type CanonicalDocumentType = (typeof CANONICAL_DOCUMENTS)[number]["type"];

export interface JsonSchema {
  $id: string;
  [keyword: string]: unknown;
}

const canonicalDir = "canonical/v1/";

export function loadCanonicalSchema(file: string): JsonSchema {
  return loadJson(`${canonicalDir}${file}.schema.json`) as JsonSchema;
}

export function loadCanonicalExample(file: string): Record<string, unknown> {
  return loadJson(`${canonicalDir}examples/${file}.json`) as Record<string, unknown>;
}

/** An Ajv instance (JSON Schema 2020-12, strict) that knows every canonical schema. */
export function canonicalAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(loadCanonicalSchema("common"));
  for (const { file } of CANONICAL_DOCUMENTS) {
    ajv.addSchema(loadCanonicalSchema(file));
  }
  return ajv;
}
