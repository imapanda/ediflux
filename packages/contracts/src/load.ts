import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const contractsDir = fileURLToPath(new URL("../../../contracts/", import.meta.url));

/** Reads a file of the top-level contracts/ directory, relative to it. */
export function readContract(path: string): string {
  return readFileSync(`${contractsDir}${path}`, "utf8");
}

export function loadYaml(path: string): unknown {
  return parse(readContract(path));
}

export function loadJson(path: string): unknown {
  return JSON.parse(readContract(path));
}
