import { describe, expect, it } from "vitest";
import { checkRegistry } from "../check.ts";
import { loadJson } from "../load.ts";
import { validateRegistry } from "../schema.ts";
import type { Registry } from "../types.ts";
import { addServiceDefinitions } from "./service.ts";

const example = loadJson("examples/fictitious-registry.json") as Registry;

describe("addServiceDefinitions", () => {
  it("defines UNS and its data element when a structure uses UNS and no file defines it", () => {
    const registry = structuredClone(example);
    delete registry.segments["UNS"];
    delete registry.dataElements["0081"];
    delete registry.codeLists["0081"];
    addServiceDefinitions(registry);
    expect(registry.segments["UNS"]?.elements).toEqual([{ ref: "0081", status: "M" }]);
    expect(Object.keys(registry.codeLists["0081"]?.codes ?? {})).toEqual(["D", "S"]);
    expect(validateRegistry(registry)).toEqual([]);
    expect(checkRegistry(registry)).toEqual([]);
  });

  it("finds UNS in a nested group", () => {
    const registry = structuredClone(example);
    delete registry.segments["UNS"];
    registry.messages = {
      SAMPLE: {
        name: "Nested",
        nodes: [
          {
            kind: "group",
            id: "SG1",
            status: "C",
            trigger: { tag: "XHD" },
            nodes: [{ kind: "segment", tag: "UNS", status: "M" }],
          },
        ],
      },
    };
    addServiceDefinitions(registry);
    expect(registry.segments).toHaveProperty("UNS");
  });

  it("leaves the registry alone when UNS is not used, or already defined", () => {
    const unused = structuredClone(example);
    unused.messages = {
      SAMPLE: { name: "Short", nodes: [{ kind: "segment", tag: "XHD", status: "M" }] },
    };
    delete unused.segments["UNS"];
    addServiceDefinitions(unused);
    expect(unused.segments).not.toHaveProperty("UNS");

    const defined = structuredClone(example);
    const before = JSON.stringify(defined);
    addServiceDefinitions(defined);
    expect(JSON.stringify(defined)).toBe(before);
  });
});
