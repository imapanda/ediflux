import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jsonata from "jsonata";
import { describe, expect, it } from "vitest";
import { isScalar, parseDocument, visit } from "yaml";
import { CANONICAL_DOCUMENTS, canonicalAjv, type JsonSchema } from "./canonical.ts";
import { edit, get } from "./edit.ts";
import { loadJson, loadYaml, readContract } from "./load.ts";
import { evaluateMapping, type FieldNode, type MappingFile } from "./reference-evaluator.ts";

interface Mapping extends MappingFile {
  flow: { direction: "inbound" | "outbound"; canonical: { documentType: string } };
  fixtures: { name: string; input: unknown; expected: unknown }[];
}

const schema = loadJson("mapping/mapping.schema.json") as JsonSchema;
const ajv = canonicalAjv();
ajv.addSchema(schema);
const validateMapping = ajv.getSchema(schema.$id);
const validate = (document: unknown): boolean => validateMapping?.(document) as boolean;

const examplesDir = fileURLToPath(new URL("../../../contracts/mapping/examples/", import.meta.url));
const exampleNames = readdirSync(examplesDir).filter((name) => name.endsWith(".mapping.yaml"));
const example = (name: string) => loadYaml(`mapping/examples/${name}`) as Mapping;

/** Every node of a mapping with the dotted path of its field names. */
function* nodes(
  fields: Record<string, FieldNode>,
  path: string[] = [],
): Generator<[string, FieldNode]> {
  for (const [name, node] of Object.entries(fields)) {
    yield [[...path, name].join("."), node];
    if (node.fields) yield* nodes(node.fields, [...path, name]);
  }
}

/** The rule of the promotion gate: a field of low confidence blocks it. */
const lowConfidencePaths = (mapping: Mapping) =>
  [...nodes(mapping.fields)].filter(([, node]) => node.confidence === "low").map(([path]) => path);

describe("contracts/mapping/mapping.schema.json", () => {
  it("is a valid schema in strict mode", () => {
    expect(validateMapping).toBeTypeOf("function");
  });

  it("lists the canonical document types of version 1", () => {
    const listed = get(schema, "properties.flow.properties.canonical.properties.documentType.enum");
    expect(listed).toEqual(CANONICAL_DOCUMENTS.map(({ type }) => type));
  });

  describe.each(exampleNames)("%s", (name) => {
    const mapping = example(name);

    it("is valid", () => {
      expect(validate(mapping), JSON.stringify(validateMapping?.errors)).toBe(true);
    });

    it("has JSONata expressions that parse", () => {
      const expressions = [...nodes(mapping.fields)].flatMap(([path, node]) =>
        [node.expression, node.forEach]
          .filter((e): e is string => e !== undefined)
          .map((e) => [path, e]),
      );
      expect(expressions.length).toBeGreaterThan(0);
      for (const [path, expression] of expressions) {
        expect(() => jsonata(expression as string), `${path}: ${expression}`).not.toThrow();
      }
    });

    it("has fixtures with unique names", () => {
      const names = mapping.fixtures.map((fixture) => fixture.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("uses no YAML anchors, aliases or merge keys", () => {
      const found: string[] = [];
      visit(parseDocument(readContract(`mapping/examples/${name}`)), {
        Alias: () => void found.push("alias"),
        Node: (_, node) =>
          void ("anchor" in node && node.anchor ? found.push(node.anchor) : undefined),
        Pair: (_, pair) =>
          void (isScalar(pair.key) && pair.key.value === "<<" ? found.push("<<") : undefined),
      });
      expect(found).toEqual([]);
    });

    it("gives the expected output for every fixture input", async () => {
      for (const fixture of mapping.fixtures) {
        expect(await evaluateMapping(mapping, fixture.input), fixture.name).toEqual(
          fixture.expected,
        );
      }
    });

    it("has fixtures whose canonical side is a valid canonical document", () => {
      const { direction, canonical } = mapping.flow;
      const canonicalValidator = ajv.getSchema(
        (
          loadJson(
            `canonical/v1/${CANONICAL_DOCUMENTS.find((d) => d.type === canonical.documentType)?.file}.schema.json`,
          ) as JsonSchema
        ).$id,
      );
      for (const fixture of mapping.fixtures) {
        const document = direction === "inbound" ? fixture.expected : fixture.input;
        expect(
          canonicalValidator?.(document),
          `${fixture.name}: ${JSON.stringify(canonicalValidator?.errors)}`,
        ).toBe(true);
      }
    });
  });

  it("has an example of each direction", () => {
    expect(new Set(exampleNames.map((name) => example(name).flow.direction))).toEqual(
      new Set(["inbound", "outbound"]),
    );
  });

  describe("confidence and promotion", () => {
    it("a reviewed mapping has no field of low confidence", () => {
      expect(lowConfidencePaths(example("order-to-csv.mapping.yaml"))).toEqual([]);
    });

    it("an AI draft keeps its low-confidence field visible, so promotion is refused until reviewed", () => {
      expect(lowConfidencePaths(example("csv-to-order-response.mapping.yaml"))).toEqual([
        "lines.unitPrice",
      ]);
    });
  });

  describe("broken variants", () => {
    const base = example("csv-to-order-response.mapping.yaml");

    it.each([
      "formatVersion",
      "name",
      "version",
      "flow",
      "flow.direction",
      "flow.message",
      "flow.message.syntax",
      "flow.message.type",
      "flow.canonical",
      "flow.canonical.documentType",
      "flow.canonical.schemaVersion",
      "fields",
      "fixtures",
      "fixtures.0.name",
      "fixtures.0.input",
      "fixtures.0.expected",
    ])("rejects a mapping without %s", (path) => {
      expect(validate(edit(base, path))).toBe(false);
    });

    it.each([
      ["another format version", "formatVersion", 2],
      ["a version of 0", "version", 0],
      ["an unknown direction", "flow.direction", "both"],
      ["an unknown syntax", "flow.message.syntax", "edi"],
      ["an unknown canonical document", "flow.canonical.documentType", "creditNote"],
      ["another canonical version", "flow.canonical.schemaVersion", 2],
      ["an unknown top-level property", "mapping", {}],
      ["no field", "fields", {}],
      ["no fixture", "fixtures", []],
      ["a fixture without expected output", "fixtures", [{ name: "x", input: {} }]],
      ["a lookup table with an invalid name", "lookups", { "1bad": { a: "b" } }],
      ["a lookup value that is a number", "lookups", { t: { a: 1 } }],
      ["a lookup value that is an object", "lookups", { t: { a: { b: 1 } } }],
      [
        "an expected output that is not an object",
        "fixtures",
        [{ name: "x", input: {}, expected: [] }],
      ],
      ["a field with neither expression nor fields", "fields.documentType", { note: "x" }],
      [
        "a field with both expression and fields",
        "fields.documentType",
        { expression: "1", fields: { a: { expression: "1" } } },
      ],
      ["an empty expression", "fields.documentType", { expression: "" }],
      ["forEach without fields", "fields.documentType", { forEach: "rows", expression: "1" }],
      ["an unknown property in a field", "fields.documentType", { expression: "1", colour: "red" }],
      ["a confidence outside high, medium and low", "fields.documentType.confidence", "certain"],
      ["a spec reference without source", "fields.documentType.specRef", { location: "x" }],
      [
        "a spec reference with a URL that is not one",
        "fields.documentType.specRef",
        { source: "x", url: "not a url" },
      ],
    ])("rejects %s", (_label, path, value) => {
      expect(validate(edit(base, path, value))).toBe(false);
    });

    it.each(["high", "medium", "low"])("accepts the confidence %s", (confidence) => {
      expect(validate(edit(base, "fields.documentType.confidence", confidence))).toBe(true);
    });
  });

  describe("evaluation rules of the README", () => {
    const rows = { forEach: "rows", fields: { a: { expression: "n" } } };
    const lookups = { t: { x: "X" } };
    const cases: [string, MappingFile, unknown, unknown][] = [
      [
        "leaves out a value that is missing",
        { fields: { a: { expression: "x" }, b: { expression: "y" } } },
        { y: 1 },
        { b: 1 },
      ],
      ["leaves out null", { fields: { a: { expression: "x" } } }, { x: null }, {}],
      [
        "leaves out a group with nothing left",
        { fields: { g: { fields: { a: { expression: "x" } } } } },
        {},
        {},
      ],
      [
        "takes one value as a list of one item",
        { fields: { l: rows } },
        { rows: { n: 1 } },
        { l: [{ a: 1 }] },
      ],
      ["leaves out a forEach without item", { fields: { l: rows } }, { rows: [] }, {}],
      [
        "drops an item that ends up empty",
        { fields: { l: rows } },
        { rows: [{ n: 1 }, { m: 2 }] },
        { l: [{ a: 1 }] },
      ],
      [
        "numbers the items from 0",
        { fields: { l: { forEach: "rows", fields: { i: { expression: "$index" } } } } },
        { rows: [{}, {}] },
        { l: [{ i: 0 }, { i: 1 }] },
      ],
      [
        "reads the whole input with $root",
        { fields: { l: { forEach: "rows", fields: { t: { expression: "$root.top" } } } } },
        { top: "T", rows: [{}] },
        { l: [{ t: "T" }] },
      ],
      [
        "always gives an array with []",
        { fields: { n: { expression: "rows.note[]" } } },
        { rows: { note: "a" } },
        { n: ["a"] },
      ],
      [
        "leaves out an unknown lookup key",
        { lookups, fields: { u: { expression: "$lookup($lookups.t, k)" } } },
        { k: "y" },
        {},
      ],
      [
        "finds a known lookup key",
        { lookups, fields: { u: { expression: "$lookup($lookups.t, k)" } } },
        { k: "x" },
        { u: "X" },
      ],
    ];

    it.each(cases)("%s", async (_label, mapping, input, expected) => {
      expect(await evaluateMapping(mapping, input)).toEqual(expected);
    });

    it.each([
      [
        "refuses an unknown code on request",
        '$lookup($lookups.t, k) ?? $error("unknown")',
        { k: "y" },
      ],
      ["has no $now()", "$now()", {}],
      ["has no $random()", "$random()", {}],
      ["has no $eval()", '$eval("1")', {}],
    ])("%s", async (_label, expression, input) => {
      await expect(
        evaluateMapping({ lookups, fields: { a: { expression } } }, input),
      ).rejects.toThrow();
    });
  });
});
