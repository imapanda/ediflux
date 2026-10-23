import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DOCUMENTS,
  canonicalAjv,
  loadCanonicalExample,
  loadCanonicalSchema,
} from "./canonical.ts";

const ajv = canonicalAjv();
const validators = Object.fromEntries(
  CANONICAL_DOCUMENTS.map(({ type, file }) => [type, ajv.getSchema(loadCanonicalSchema(file).$id)]),
);
const examples = Object.fromEntries(
  CANONICAL_DOCUMENTS.map(({ type, file }) => [type, loadCanonicalExample(file)]),
);

function validate(type: string, document: unknown): boolean {
  const validator = validators[type];
  if (!validator) throw new Error(`no schema for ${type}`);
  return validator(document) as boolean;
}

/** Copy of the example with the value at `path` (dot separated) replaced, or removed if undefined. */
function edit(type: string, path: string, value?: unknown): unknown {
  const copy = structuredClone(examples[type]);
  const keys = path.split(".");
  const last = keys.pop() as string;
  let node = copy as Record<string, unknown>;
  for (const key of keys) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

describe("canonical documents, version 1", () => {
  it.each(CANONICAL_DOCUMENTS)("$file: the schema is valid and strict", ({ file }) => {
    expect(ajv.getSchema(loadCanonicalSchema(file).$id)).toBeTypeOf("function");
  });

  it.each(CANONICAL_DOCUMENTS)("$file: the example is valid", ({ type }) => {
    const validator = validators[type];
    expect(validator?.(examples[type]), JSON.stringify(validator?.errors)).toBe(true);
  });

  it.each(CANONICAL_DOCUMENTS)("$file: the example declares its type and version", ({ type }) => {
    expect(examples[type]).toMatchObject({ documentType: type, schemaVersion: 1 });
  });

  describe.each(CANONICAL_DOCUMENTS)("$file: broken variants", ({ type }) => {
    it.each([
      "documentType",
      "schemaVersion",
      "documentNumber",
      "issueDate",
      "parties",
      "parties.buyer",
      "parties.supplier",
      "lines",
      "lines.0.lineNumber",
      "lines.0.product",
    ])("rejects a document without %s", (path) => {
      expect(validate(type, edit(type, path))).toBe(false);
    });

    it.each([
      ["another schema version", "schemaVersion", 2],
      ["another document type", "documentType", "creditNote"],
      ["an unknown property", "reference", "PO-1"],
      ["no line", "lines", []],
      ["a line number of 0", "lines.0.lineNumber", 0],
      ["an unknown property in a line", "lines.0.colour", "red"],
      ["an empty party", "parties.buyer", {}],
      ["a GLN of 12 digits", "parties.buyer.gln", "952000000001"],
      ["a GLN given as a number", "parties.buyer.gln", 9520000000011],
      ["a GTIN with letters", "lines.0.product.gtin", "95200000100AB"],
      ["an invalid calendar date", "issueDate", "2030-13-01"],
      ["a date-time without offset", "issueDate", "2030-10-15T09:00:00"],
      ["a country in three letters", "parties.buyer.address.country", "FRA"],
      ["an unknown property in an address", "parties.buyer.address.region", "X"],
      ["an unknown reference type", "references", [{ type: "waybill", value: "W-1" }]],
      ["a reference without value", "references", [{ type: "order" }]],
    ])("rejects %s", (_label, path, value) => {
      expect(validate(type, edit(type, path, value))).toBe(false);
    });
  });

  describe("decimals", () => {
    const withQuantity = (value: unknown) => edit("order", "lines.0.quantity.value", value);

    it.each(["0", "12", "-3", "2.50", "0.001"])("accepts %s", (value) => {
      expect(validate("order", withQuantity(value))).toBe(true);
    });

    it.each([12, 2.5, "1,5", "1e3", "+1", "01", ".5", "5.", "", " 1", "NaN"])(
      "rejects %j",
      (value) => {
        expect(validate("order", withQuantity(value))).toBe(false);
      },
    );

    it("accepts every decimal written with digits and a point", () => {
      const decimal = fc
        .tuple(fc.boolean(), fc.nat(1_000_000), fc.option(fc.stringMatching(/^[0-9]{1,6}$/)))
        .map(
          ([negative, whole, fraction]) =>
            `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`,
        );
      fc.assert(fc.property(decimal, (value) => validate("order", withQuantity(value))));
    });
  });

  describe.each(["order", "orderResponse", "despatchAdvice"])("%s function", (type) => {
    it.each(["original", "replacement", "cancellation"])("accepts %s", (value) => {
      expect(validate(type, edit(type, "documentFunction", value))).toBe(true);
    });
    it("rejects an unknown function", () => {
      expect(validate(type, edit(type, "documentFunction", "copy"))).toBe(false);
    });
  });

  describe("order", () => {
    it("rejects a line without quantity", () => {
      expect(validate("order", edit("order", "lines.0.quantity"))).toBe(false);
    });
    it("accepts a date-time with an offset as issue date", () => {
      expect(validate("order", edit("order", "issueDate", "2030-10-15T09:00:00+02:00"))).toBe(true);
    });
    it("accepts a product known by its description only", () => {
      expect(validate("order", edit("order", "lines.0.product", { description: "X" }))).toBe(true);
    });
    it("rejects a product without any identification", () => {
      expect(validate("order", edit("order", "lines.0.product", {}))).toBe(false);
    });
  });

  describe("order response", () => {
    it.each([
      ["a response status", "responseStatus"],
      ["a line status", "lines.0.status"],
    ])("rejects a response without %s", (_label, path) => {
      expect(validate("orderResponse", edit("orderResponse", path))).toBe(false);
    });
    it("rejects an unknown line status", () => {
      expect(validate("orderResponse", edit("orderResponse", "lines.0.status", "partial"))).toBe(
        false,
      );
    });
  });

  describe("despatch advice", () => {
    const packages = (value: unknown) => edit("despatchAdvice", "packages", value);

    it("accepts packages nested three levels deep", () => {
      const leaf = { type: "carton", sscc: "395200000000000012" };
      const nested = [{ type: "pallet", packages: [{ type: "pallet", packages: [leaf] }] }];
      expect(validate("despatchAdvice", packages(nested))).toBe(true);
    });
    it.each([
      ["an SSCC of 17 digits", [{ sscc: "39520000000000001" }]],
      ["an unknown package type", [{ type: "box" }]],
      ["a package without any property", [{}]],
      ["content without quantity", [{ contents: [{ lineNumber: 1 }] }]],
      ["a nested package that is invalid", [{ packages: [{ sscc: "1" }] }]],
    ])("rejects %s", (_label, value) => {
      expect(validate("despatchAdvice", packages(value))).toBe(false);
    });
  });

  describe("invoice", () => {
    it.each([
      "invoiceKind",
      "currency",
      "taxSubtotals",
      "totals",
      "totals.payableAmount",
      "lines.0.lineAmount",
      "lines.0.tax",
    ])("rejects an invoice without %s", (path) => {
      expect(validate("invoice", edit("invoice", path))).toBe(false);
    });

    it.each([
      ["an unknown invoice kind", "invoiceKind", "proforma"],
      ["an unknown tax category", "lines.0.tax.category", "reduced"],
      ["an unknown adjustment kind", "adjustments.0.kind", "tip"],
      ["a total given as a number", "totals.taxTotal", 20.36],
      ["a negative discount or charge", "adjustments.0.amount", "-10.00"],
      ["a negative unit price", "lines.0.unitPrice.amount", "-1.00"],
      ["a negative tax rate", "lines.0.tax.rate", "-5"],
      ["an IBAN in lower case", "payment.iban", "fr0000000000000000000000000"],
    ])("rejects %s", (_label, path, value) => {
      expect(validate("invoice", edit("invoice", path, value))).toBe(false);
    });

    it.each(["intraCommunity", "export", "reverseCharge"])(
      "accepts the tax category %s",
      (category) => {
        expect(validate("invoice", edit("invoice", "lines.0.tax.category", category))).toBe(true);
      },
    );

    it("accepts a credit note", () => {
      expect(validate("invoice", edit("invoice", "invoiceKind", "creditNote"))).toBe(true);
    });
  });
});

describe("the examples cover the sample corpus", () => {
  const corpusDir = fileURLToPath(new URL("../../../samples/edifact/valid/", import.meta.url));
  // Every party, product and package identifier of the sample is in the example, and the other way round.
  const identifiers = (text: string) => new Set(text.match(/\d{13,18}/g));

  it.each([
    ["order", "orders-d96a-s3-unoa-multi-line"],
    ["orderResponse", "ordrsp-d01b-s4-unoc-changes"],
    ["despatchAdvice", "desadv-d01b-s4-unow-packaging-levels"],
  ])("%s mirrors %s", (type, sample) => {
    const edi = readFileSync(`${corpusDir}${sample}.edi`, "utf8");
    expect(identifiers(JSON.stringify(examples[type]))).toEqual(identifiers(edi));
  });
});
