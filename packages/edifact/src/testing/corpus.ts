import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The sample corpus: fictitious interchanges and the results they must give. */
const corpus = fileURLToPath(new URL("../../../../samples/edifact/", import.meta.url));

export interface ExpectedValid {
  sample: string;
  interchange: {
    syntaxIdentifier: string;
    syntaxVersion: number;
    encoding: "ascii" | "iso-8859-1" | "utf-8";
    una: string | null;
    interchangeReference: string;
    messages: {
      reference: string;
      type: string;
      version: string;
      release: string;
      agency: string;
    }[];
  };
  segments: { tag: string; elements: unknown[] }[];
}

export interface ExpectedInvalid {
  sample: string;
  layer: "tokenizer" | "envelope" | "structure" | "element" | "code";
  expectedErrors: {
    code: string;
    position: { segment: number; tag: string; element: number | null; component: number | null };
  }[];
}

export function samples(directory: "valid" | "invalid"): string[] {
  return readdirSync(`${corpus}${directory}`)
    .filter((name) => name.endsWith(".edi"))
    .map((name) => name.slice(0, -".edi".length))
    .sort();
}

export function readSample(directory: "valid" | "invalid", name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${corpus}${directory}/${name}.edi`));
}

export function expectedOf<T>(directory: "valid" | "invalid", name: string): T {
  return JSON.parse(readFileSync(`${corpus}${directory}/${name}.expected.json`, "utf8")) as T;
}
