import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkRegistry } from "./check.ts";
import { loadJson } from "./load.ts";
import type { GroupNode, MessageNode, Registry } from "./types.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const schema = loadJson("registry.schema.json") as Record<string, unknown>;
const example = loadJson("examples/fictitious-registry.json") as Registry;
const validate = ajv.compile(schema);

/** A copy of the example with one change, so that every test starts from a valid registry. */
function edit(change: (registry: Registry) => void): Registry {
  const copy = structuredClone(example);
  change(copy);
  return copy;
}

/** Fails the test, not the type checker, when the example no longer has the expected shape. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the fictitious example changed: update this test");
  return value;
}

function isValid(document: unknown): boolean {
  return validate(document);
}

const REQUIRED = [
  "schemaVersion",
  "directory",
  "syntaxVersions",
  "source",
  "dataElements",
  "composites",
  "segments",
  "codeLists",
  "messages",
];

type Change = [label: string, change: (registry: Registry) => void];

describe("contracts/registry/registry.schema.json", () => {
  it("is a JSON Schema 2020-12 document with a stable URN identifier", () => {
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["$id"]).toBe("urn:libredi:schema:edifact-registry");
  });

  it("accepts the fictitious example", () => {
    expect(isValid(example), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(REQUIRED)("rejects a registry without %s", (field) => {
    const { [field]: _removed, ...rest } = example as unknown as Record<string, unknown>;
    expect(isValid(rest)).toBe(false);
  });

  it("rejects a document that is not an object", () => {
    expect(isValid([])).toBe(false);
    expect(isValid("registry")).toBe(false);
  });

  describe("accepts what the format leaves optional or open", () => {
    it.each<Change>([
      ["a registry without messages (a partial registry)", (r) => (r.messages = {})],
      [
        "an open code list without any code",
        (r) => {
          must(r.codeLists["9010"]).codes = {};
        },
      ],
      [
        "a group that is only its trigger, with or without an empty list of nodes",
        (r) => {
          const nodes = must(r.messages["SAMPLE"]).nodes;
          const only = nodes.find((n) => n.kind === "group" && n.id === "SG1");
          if (only?.kind !== "group") throw new Error("the example has no group SG1");
          expect(only.nodes).toBeUndefined();
          nodes.push({ ...only, id: "SG9", nodes: [] });
        },
      ],
      [
        "a source built from UNECE files, with its archives, generator and time",
        (r) => {
          r.source = {
            kind: "unece-directory",
            archives: [{ name: "d00a.zip", sha256: "0123456789abcdef".repeat(4) }],
            generator: { name: "libredi-registry", version: "0.1.0" },
            generatedAt: "2026-10-24T09:30:00Z",
          };
        },
      ],
      [
        "a handwritten source without archives, generator or time",
        (r) => {
          r.source = { kind: "handwritten" };
        },
      ],
      [
        "a directory whose parts are one character long, like the syntax service messages",
        (r) => {
          r.directory = { agency: "UN", version: "4", release: "2" };
        },
      ],
      [
        "properties it does not know, so that a later version can add some",
        (r) => {
          Object.assign(r, { future: true });
          Object.assign(must(r.segments["XHD"]), { future: [1] });
          Object.assign(must(r.messages["SAMPLE"]?.nodes[0]), { future: "x" });
        },
      ],
    ])("%s", (_label, change) => {
      const registry = edit(change);
      expect(isValid(registry), JSON.stringify(validate.errors)).toBe(true);
    });
  });

  describe("rejects a malformed header", () => {
    it.each<Change>([
      ["another schemaVersion", (r) => Object.assign(r, { schemaVersion: 2 })],
      ["no syntax version", (r) => (r.syntaxVersions = [])],
      ["syntax version 5", (r) => (r.syntaxVersions = [5])],
      ["syntax version 0", (r) => (r.syntaxVersions = [0])],
      ["a fractional syntax version", (r) => (r.syntaxVersions = [3.5])],
      ["a repeated syntax version", (r) => (r.syntaxVersions = [3, 3])],
      [
        "a directory without a release",
        (r) => Object.assign(r, { directory: { agency: "ZZ", version: "Z" } }),
      ],
      [
        "a lower-case release",
        (r) => Object.assign(r, { directory: { agency: "ZZ", version: "Z", release: "00a" } }),
      ],
      [
        "a release of four characters",
        (r) => Object.assign(r, { directory: { agency: "ZZ", version: "Z", release: "00AA" } }),
      ],
      ["an unknown source kind", (r) => Object.assign(r.source, { kind: "downloaded" })],
      [
        "an archive without a checksum",
        (r) => Object.assign(r.source, { archives: [{ name: "d00a.zip" }] }),
      ],
      [
        "an archive checksum that is not a SHA-256",
        (r) => Object.assign(r.source, { archives: [{ name: "d00a.zip", sha256: "abc" }] }),
      ],
      [
        "an upper-case archive checksum",
        (r) =>
          Object.assign(r.source, {
            archives: [{ name: "d00a.zip", sha256: "A".repeat(64) }],
          }),
      ],
      [
        "a generator without a version",
        (r) => Object.assign(r.source, { generator: { name: "g" } }),
      ],
      [
        "a generation time that is not a date-time",
        (r) => Object.assign(r.source, { generatedAt: "today" }),
      ],
    ])("%s", (_label, change) => {
      expect(isValid(edit(change))).toBe(false);
    });
  });

  describe("rejects a malformed data element or code list", () => {
    it.each<Change>([
      ["a tag of three digits", (r) => (r.dataElements["900"] = must(r.dataElements["9002"]))],
      ["a tag with a letter", (r) => (r.dataElements["900A"] = must(r.dataElements["9002"]))],
      ["no name", (r) => Reflect.deleteProperty(must(r.dataElements["9002"]), "name")],
      ["an empty name", (r) => (must(r.dataElements["9002"]).name = "")],
      ["no type", (r) => Reflect.deleteProperty(must(r.dataElements["9002"]), "type")],
      ["an unknown type", (r) => Object.assign(must(r.dataElements["9002"]), { type: "x" })],
      ["a type in upper case", (r) => Object.assign(must(r.dataElements["9002"]), { type: "AN" })],
      [
        "no minimum length",
        (r) => Reflect.deleteProperty(must(r.dataElements["9002"]), "minLength"),
      ],
      [
        "no maximum length",
        (r) => Reflect.deleteProperty(must(r.dataElements["9002"]), "maxLength"),
      ],
      ["a minimum length of 0", (r) => (must(r.dataElements["9002"]).minLength = 0)],
      ["a maximum length of 0", (r) => (must(r.dataElements["9002"]).maxLength = 0)],
      ["a fractional maximum length", (r) => (must(r.dataElements["9002"]).maxLength = 35.5)],
      ["a code list name with a space", (r) => (must(r.dataElements["9002"]).codeList = "my list")],
      ["a code list name that is empty", (r) => (must(r.dataElements["9002"]).codeList = "")],
      ["a code list key with a space", (r) => (r.codeLists["my list"] = must(r.codeLists["9001"]))],
      [
        "a code list without closed",
        (r) => Reflect.deleteProperty(must(r.codeLists["9001"]), "closed"),
      ],
      [
        "a closed that is not a boolean",
        (r) => Object.assign(must(r.codeLists["9001"]), { closed: "yes" }),
      ],
      [
        "a code list without codes",
        (r) => Reflect.deleteProperty(must(r.codeLists["9001"]), "codes"),
      ],
      ["a code without a name", (r) => (must(r.codeLists["9001"]).codes["1"] = {} as never)],
      ["an empty code value", (r) => (must(r.codeLists["9001"]).codes[""] = { name: "Empty" })],
    ])("%s", (_label, change) => {
      expect(isValid(edit(change))).toBe(false);
    });
  });

  describe("rejects a malformed composite or segment", () => {
    it.each<Change>([
      ["a composite tag in lower case", (r) => (r.composites["c901"] = must(r.composites["C901"]))],
      ["a composite tag of two digits", (r) => (r.composites["C90"] = must(r.composites["C901"]))],
      [
        "a composite tag with another letter",
        (r) => (r.composites["X901"] = must(r.composites["C901"])),
      ],
      ["a composite without components", (r) => (must(r.composites["C901"]).components = [])],
      [
        "a component that refers to a composite",
        (r) => (must(r.composites["C901"]).components[0] = { ref: "C902", status: "M" }),
      ],
      [
        "a component without a status",
        (r) => (must(r.composites["C901"]).components[0] = { ref: "9002" } as never),
      ],
      [
        "a status other than M or C",
        (r) => (must(r.composites["C901"]).components[0] = { ref: "9002", status: "O" } as never),
      ],
      [
        "a status in lower case",
        (r) => (must(r.composites["C901"]).components[0] = { ref: "9002", status: "m" } as never),
      ],
      ["a segment tag in lower case", (r) => (r.segments["xhd"] = must(r.segments["XHD"]))],
      ["a segment tag of two letters", (r) => (r.segments["XH"] = must(r.segments["XHD"]))],
      ["a segment tag with a digit", (r) => (r.segments["XH1"] = must(r.segments["XHD"]))],
      ["a segment without elements", (r) => (must(r.segments["XHD"]).elements = [])],
      ["a segment without a name", (r) => Reflect.deleteProperty(must(r.segments["XHD"]), "name")],
      [
        "an element reference of five digits",
        (r) => (must(r.segments["XHD"]).elements[0] = { ref: "90011", status: "M" }),
      ],
      [
        "an element reference that is a lower-case composite tag",
        (r) => (must(r.segments["XHD"]).elements[0] = { ref: "c901", status: "M" }),
      ],
      [
        "a maxOccurs of 0",
        (r) => (must(r.segments["XPT"]).elements[2] = { ref: "9007", status: "C", maxOccurs: 0 }),
      ],
      [
        "a fractional maxOccurs",
        (r) => (must(r.segments["XPT"]).elements[2] = { ref: "9007", status: "C", maxOccurs: 1.5 }),
      ],
    ])("%s", (_label, change) => {
      expect(isValid(edit(change))).toBe(false);
    });
  });

  describe("rejects a malformed message structure", () => {
    const sample = (r: Registry) => must(r.messages["SAMPLE"]);
    const lines = (r: Registry): GroupNode => {
      const group = sample(r).nodes.find((n) => n.kind === "group" && n.id === "SG2");
      if (group?.kind !== "group") throw new Error("the example has no group SG2");
      return group;
    };

    it.each<Change>([
      ["a message type of five letters", (r) => (r.messages["ORDER"] = sample(r))],
      ["a message type in lower case", (r) => (r.messages["sample"] = sample(r))],
      ["no nodes", (r) => (sample(r).nodes = [])],
      ["no name", (r) => Reflect.deleteProperty(sample(r), "name")],
      ["a node of an unknown kind", (r) => (sample(r).nodes[0] = { kind: "loop" } as never)],
      ["a node without a kind", (r) => (sample(r).nodes[0] = { tag: "XHD", status: "M" } as never)],
      [
        "a segment node without a tag",
        (r) => (sample(r).nodes[0] = { kind: "segment", status: "M" } as never),
      ],
      [
        "a segment node without a status",
        (r) => (sample(r).nodes[0] = { kind: "segment", tag: "XHD" } as never),
      ],
      [
        "a segment node with a section that does not exist",
        (r) =>
          (sample(r).nodes[0] = {
            kind: "segment",
            tag: "XHD",
            status: "M",
            section: "body",
          } as never),
      ],
      [
        "a sequence of two digits",
        (r) => (sample(r).nodes[0] = { kind: "segment", tag: "XHD", status: "M", sequence: "10" }),
      ],
      [
        "a maxOccurs of 0 on a node",
        (r) => (sample(r).nodes[0] = { kind: "segment", tag: "XHD", status: "M", maxOccurs: 0 }),
      ],
      ["a group id that is not SG followed by digits", (r) => (lines(r).id = "G2")],
      ["a group without a status", (r) => Reflect.deleteProperty(lines(r), "status")],
      ["a group without a trigger", (r) => Reflect.deleteProperty(lines(r), "trigger")],
      ["a trigger without a tag", (r) => (lines(r).trigger = {} as never)],
      ["a trigger tag in lower case", (r) => (lines(r).trigger = { tag: "xln" })],
      [
        "a trigger sequence of two digits",
        (r) => (lines(r).trigger = { tag: "XLN", sequence: "70" }),
      ],
      [
        "a group whose nodes are not a list",
        (r) => Object.assign(lines(r), { nodes: { kind: "segment", tag: "XQT", status: "C" } }),
      ],
      [
        "a nested group without a trigger",
        (r) => {
          const nested = (lines(r).nodes ?? []).find((n) => n.kind === "group");
          if (nested?.kind !== "group") throw new Error("the example has no nested group");
          Reflect.deleteProperty(nested, "trigger");
        },
      ],
    ])("%s", (_label, change) => {
      expect(isValid(edit(change))).toBe(false);
    });
  });

  describe("properties", () => {
    const tag = fc.stringMatching(/^[0-9]{4}$/);

    it("accepts any pair of lengths: putting them in order is the job of checkRegistry", () => {
      const element = fc.record({
        name: fc.string({ minLength: 1 }),
        type: fc.constantFrom("a", "an", "n"),
        minLength: fc.integer({ min: 1, max: 100 }),
        maxLength: fc.integer({ min: 1, max: 1000 }),
      });
      fc.assert(
        fc.property(tag, element, (key, definition) => {
          const registry = edit((r) => {
            r.dataElements[key] = definition;
          });
          expect(isValid(registry), JSON.stringify(validate.errors)).toBe(true);
          const misordered = definition.minLength > definition.maxLength;
          expect(checkRegistry(registry)).toHaveLength(misordered ? 1 : 0);
        }),
      );
    });

    it("accepts message structures with groups nested to any depth", () => {
      // A shape is a list of children; a child is either a segment (null) or a nested shape.
      type Shape = (Shape | null)[];
      const { shape } = fc.letrec<{ shape: Shape }>((tie) => ({
        shape: fc.array(fc.oneof({ depthSize: "small" }, fc.constant(null), tie("shape")), {
          maxLength: 4,
        }),
      }));
      const status = fc.constantFrom("M" as const, "C" as const);

      fc.assert(
        fc.property(shape, status, fc.integer({ min: 1, max: 9999 }), (top, groupStatus, max) => {
          let groups = 0;
          const build = (children: Shape): MessageNode[] =>
            children.map((child): MessageNode => {
              if (child === null)
                return { kind: "segment", tag: "XDT", status: "C", maxOccurs: max };
              groups += 1;
              const id = `SG${groups}`;
              const trigger = { tag: "XPT" };
              return {
                kind: "group",
                id,
                status: groupStatus,
                maxOccurs: max,
                trigger,
                nodes: build(child),
              };
            });
          const registry = edit((r) => {
            must(r.messages["SAMPLE"]).nodes = [
              { kind: "segment", tag: "XHD", status: "M" },
              ...build(top),
            ];
          });
          expect(isValid(registry), JSON.stringify(validate.errors)).toBe(true);
          expect(checkRegistry(registry)).toEqual([]);
        }),
      );
    });
  });
});
