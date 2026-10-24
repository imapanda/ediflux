import { describe, expect, it } from "vitest";
import { TokenizeError, Tokenizer } from "./index.ts";
import {
  type ExpectedInvalid,
  type ExpectedValid,
  expectedOf,
  readSample,
  samples,
} from "./testing/corpus.ts";
import { readSegments } from "./testing/segments.ts";

const read = (directory: "valid" | "invalid", name: string) => readSample(directory, name);
const expected = <T>(directory: "valid" | "invalid", name: string) =>
  expectedOf<T>(directory, name);

function drain(bytes: Uint8Array): void {
  for (const _batch of new Tokenizer(bytes)) {
    // Only the end of the iteration matters.
  }
}

describe("valid samples", () => {
  const names = samples("valid");

  it("are all there", () => {
    expect(names.length).toBeGreaterThanOrEqual(24);
  });

  it.each(names)("%s tokenizes to the segments of its expected-result file", (name) => {
    const bytes = read("valid", name);
    const { interchange, segments } = expected<ExpectedValid>("valid", name);
    const result = readSegments(bytes, interchange.encoding === "utf-8" ? "utf8" : "latin1");
    expect(result.una).toBe(interchange.una);
    expect(result.segments).toEqual(segments);
  });
});

describe("invalid samples that concern the tokenizer", () => {
  it("INVALID_UNA is reported with the position the expected-result file gives", () => {
    const { expectedErrors } = expected<ExpectedInvalid>("invalid", "invalid-una");
    const [wanted] = expectedErrors;
    const error = catchTokenizeError(read("invalid", "invalid-una"));
    expect(error.code).toBe(wanted?.code);
    expect(error.segment).toBe(wanted?.position.segment);
    expect(error.tag).toBe(wanted?.position.tag);
    expect(error.message).toMatch(/component separator and the element separator/);
  });

  it("UNEXPECTED_END_OF_FILE is reported with the position the expected-result file gives", () => {
    const { expectedErrors } = expected<ExpectedInvalid>("invalid", "unexpected-end-of-file");
    const [wanted] = expectedErrors;
    const bytes = read("invalid", "unexpected-end-of-file");
    const error = catchTokenizeError(bytes);
    expect(error.code).toBe(wanted?.code);
    expect(error.segment).toBe(wanted?.position.segment);
    expect(error.tag).toBe(wanted?.position.tag);
    expect(error.offset).toBe(bytes.length);
  });

  // Character sets are issue #37 and the UNB checks are the validator's (#43): the tokenizer
  // only splits bytes, so these tokenize without complaint and are reported by the later layers.
  it.each(
    samples("invalid").filter((name) => {
      const { layer, expectedErrors } = expected<ExpectedInvalid>("invalid", name);
      const code = expectedErrors[0]?.code;
      return layer !== "tokenizer" || (code !== "INVALID_UNA" && code !== "UNEXPECTED_END_OF_FILE");
    }),
  )("%s is well formed at the tokenizer level", (name) => {
    expect(() => drain(read("invalid", name))).not.toThrow();
  });
});

describe("every prefix of every valid sample", () => {
  it.each(samples("valid"))(
    "%s either ends on a segment boundary or fails with UNEXPECTED_END_OF_FILE at its end",
    (name) => {
      const bytes = read("valid", name);
      let boundaries = 0;
      for (let length = 0; length <= bytes.length; length++) {
        const prefix = bytes.subarray(0, length);
        try {
          drain(prefix);
          boundaries++;
          // Whole segments only: the cut is just after a terminator, or in the line breaks after it.
          const last = length === 0 ? 0x27 : (prefix[length - 1] as number);
          expect([0x27, 0x25, 0x0a, 0x0d]).toContain(last);
        } catch (error) {
          expect(error).toBeInstanceOf(TokenizeError);
          expect((error as TokenizeError).code).toBe("UNEXPECTED_END_OF_FILE");
          expect((error as TokenizeError).offset).toBe(length);
        }
      }
      expect(boundaries).toBeGreaterThan(5);
    },
  );
});

function catchTokenizeError(bytes: Uint8Array): TokenizeError {
  try {
    drain(bytes);
  } catch (error) {
    if (error instanceof TokenizeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a TokenizeError");
}
