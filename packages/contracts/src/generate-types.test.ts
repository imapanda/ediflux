import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANONICAL_TYPES_PATH, generateCanonicalTypes } from "./generate-types.ts";

describe("generated TypeScript types of the canonical documents", () => {
  it("are what the schemas in contracts/canonical generate (run `pnpm --filter @libredi/contracts generate` after a change)", async () => {
    expect(await generateCanonicalTypes()).toBe(readFileSync(CANONICAL_TYPES_PATH, "utf8"));
  });

  it("are produced identically every time", async () => {
    expect(await generateCanonicalTypes()).toBe(await generateCanonicalTypes());
  });

  it("declare one type per canonical document, and each shared type once", async () => {
    const source = await generateCanonicalTypes();
    for (const name of [
      "Order",
      "OrderResponse",
      "DespatchAdvice",
      "Invoice",
      "Party",
      "Package",
      "UnsignedDecimal",
    ]) {
      expect(source.match(new RegExp(`^export (interface|type) ${name}\\b`, "gm"))).toHaveLength(1);
    }
  });
});
