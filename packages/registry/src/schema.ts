import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../../contracts/registry/registry.schema.json" with { type: "json" };
import type { Problem } from "./check.ts";

let validator: ReturnType<Ajv2020["compile"]> | undefined;

/**
 * Validates a document against contracts/registry/registry.schema.json. The schema is imported, not
 * read from disk, so that a bundled service carries it. Returns every violation with the JSON
 * Pointer of the offending value; an empty list means the document has the right shape (call
 * `checkRegistry` for the references).
 */
export function validateRegistry(document: unknown): Problem[] {
  if (!validator) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    validator = ajv.compile(schema);
  }
  if (validator(document)) return [];
  return (validator.errors ?? []).map((error) => ({
    path: error.instancePath,
    message: error.message ?? "is invalid",
  }));
}
