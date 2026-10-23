import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkRegistry } from "./check.ts";
import { loadJson } from "./load.ts";
import type { GroupNode, Registry } from "./types.ts";

const example = loadJson("examples/fictitious-registry.json") as Registry;

/** A copy of the example with one change, so that every test starts from a coherent registry. */
function edit(change: (registry: Registry) => void): Registry {
  const copy = structuredClone(example);
  change(copy);
  return copy;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the fictitious example changed: update this test");
  return value;
}

function group(registry: Registry, id: string): GroupNode {
  const find = (nodes: GroupNode["nodes"]): GroupNode | undefined => {
    for (const node of nodes ?? []) {
      if (node.kind !== "group") continue;
      if (node.id === id) return node;
      const nested = find(node.nodes);
      if (nested) return nested;
    }
    return undefined;
  };
  return must(find(must(registry.messages["SAMPLE"]).nodes));
}

describe("checkRegistry", () => {
  it("finds nothing to report in the fictitious example", () => {
    expect(checkRegistry(example)).toEqual([]);
  });

  it("finds nothing to report in an empty registry", () => {
    const empty = edit((r) => {
      r.dataElements = {};
      r.composites = {};
      r.segments = {};
      r.codeLists = {};
      r.messages = {};
    });
    expect(checkRegistry(empty)).toEqual([]);
  });

  it.each<[label: string, change: (registry: Registry) => void, path: string, message: RegExp]>([
    [
      "a data element whose code list does not exist",
      (r) => {
        must(r.dataElements["9001"]).codeList = "nope";
      },
      "/dataElements/9001/codeList",
      /code list "nope".*does not exist/,
    ],
    [
      "a data element whose minimum length is above its maximum",
      (r) => {
        must(r.dataElements["9002"]).minLength = 36;
      },
      "/dataElements/9002",
      /minLength \(36\).*maxLength \(35\)/,
    ],
    [
      "a component that refers to a missing data element",
      (r) => {
        must(r.composites["C901"]).components[1] = { ref: "9999", status: "C" };
      },
      "/composites/C901/components/1/ref",
      /data element "9999".*does not exist/,
    ],
    [
      "a segment element that refers to a missing data element",
      (r) => {
        must(r.segments["XPT"]).elements[1] = { ref: "9999", status: "M" };
      },
      "/segments/XPT/elements/1/ref",
      /data element "9999".*does not exist/,
    ],
    [
      "a segment element that refers to a missing composite",
      (r) => {
        must(r.segments["XHD"]).elements[0] = { ref: "C999", status: "M" };
      },
      "/segments/XHD/elements/0/ref",
      /composite "C999".*does not exist/,
    ],
    [
      "a top-level node that refers to a missing segment",
      (r) => {
        must(r.messages["SAMPLE"]).nodes[0] = { kind: "segment", tag: "ZZZ", status: "M" };
      },
      "/messages/SAMPLE/nodes/0/tag",
      /segment "ZZZ".*does not exist/,
    ],
    [
      "a group trigger that refers to a missing segment",
      (r) => {
        group(r, "SG1").trigger = { tag: "ZZZ" };
      },
      "/messages/SAMPLE/nodes/2/trigger/tag",
      /segment "ZZZ".*does not exist/,
    ],
    [
      "a node of a nested group that refers to a missing segment",
      (r) => {
        group(r, "SG3").trigger = { tag: "ZZZ" };
      },
      "/messages/SAMPLE/nodes/4/nodes/1/trigger/tag",
      /segment "ZZZ".*does not exist/,
    ],
    [
      "two groups with the same id",
      (r) => {
        group(r, "SG3").id = "SG1";
      },
      "/messages/SAMPLE/nodes/4/nodes/1/id",
      /group id "SG1".*already used/,
    ],
  ])("reports %s", (_label, change, path, message) => {
    const problems = checkRegistry(edit(change));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe(path);
    expect(problems[0]?.message).toMatch(message);
  });

  it("reports every problem, section by section, not just the first", () => {
    const registry = edit((r) => {
      must(r.dataElements["9001"]).codeList = "nope";
      must(r.segments["XHD"]).elements[0] = { ref: "C999", status: "M" };
      group(r, "SG3").id = "SG2";
    });
    expect(checkRegistry(registry).map((p) => p.path)).toEqual([
      "/dataElements/9001/codeList",
      "/segments/XHD/elements/0/ref",
      "/messages/SAMPLE/nodes/4/nodes/1/id",
    ]);
  });

  it("resolves the reference of a segment element to a service composite (S and 3 digits)", () => {
    const registry = edit((r) => {
      r.composites["S001"] = {
        name: "Example service composite",
        components: [{ ref: "9002", status: "M" }],
      };
      must(r.segments["XHD"]).elements.push({ ref: "S001", status: "C" });
    });
    expect(checkRegistry(registry)).toEqual([]);
  });

  it("keeps group ids apart from one message to the next", () => {
    const registry = edit((r) => {
      r.messages["OTHERS"] = structuredClone(must(r.messages["SAMPLE"]));
    });
    expect(Object.keys(registry.messages)).toEqual(["SAMPLE", "OTHERS"]);
    expect(checkRegistry(registry)).toEqual([]);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "does not take the inherited property %s for a code list",
    (name) => {
      const registry = edit((r) => {
        must(r.dataElements["9001"]).codeList = name;
      });
      expect(checkRegistry(registry).map((p) => p.path)).toEqual(["/dataElements/9001/codeList"]);
    },
  );

  it("accepts equal minimum and maximum lengths", () => {
    expect(must(example.dataElements["9004"]).minLength).toBe(8);
    expect(must(example.dataElements["9004"]).maxLength).toBe(8);
    expect(checkRegistry(example)).toEqual([]);
  });

  it("reports a dangling code list for any element key and list name", () => {
    const key = fc.stringMatching(/^[0-9]{4}$/);
    const list = fc
      .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)
      .filter((l) => !Object.hasOwn(example.codeLists, l));
    fc.assert(
      fc.property(key, list, (tag, codeList) => {
        const registry = edit((r) => {
          r.dataElements[tag] = { name: "Any", type: "an", minLength: 1, maxLength: 3, codeList };
        });
        expect(checkRegistry(registry).map((p) => p.path)).toEqual([
          `/dataElements/${tag}/codeList`,
        ]);
      }),
    );
  });
});
