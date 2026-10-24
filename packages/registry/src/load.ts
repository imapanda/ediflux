import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const registryDir = fileURLToPath(new URL("../../../contracts/registry/", import.meta.url));

/**
 * Reads a JSON file of contracts/registry/, relative to it. For tests: a bundled service must not
 * read the repository tree, so this is not exported from index.ts.
 */
export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(`${registryDir}${path}`, "utf8"));
}
