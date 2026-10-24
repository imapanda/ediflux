import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TokenizeError, Tokenizer, TokenKind, unescapeValue } from "./index.ts";
import { tokenize } from "./testing/helpers.ts";
import { referenceTokenize } from "./testing/reference.ts";
import {
  buildInterchange,
  escapeValue,
  interchangeArbitrary,
  separatorsArbitrary,
  serviceStringOf,
} from "./testing/writer.ts";

const SEPARATOR_KINDS: number[] = [
  TokenKind.ComponentSeparator,
  TokenKind.ElementSeparator,
  TokenKind.RepetitionSeparator,
  TokenKind.SegmentTerminator,
];

function utf8Bom(bytes: Uint8Array): number {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

const corpus = new URL("../../../samples/edifact/", import.meta.url).pathname;

describe("escaping with the release character", () => {
  it("any value, whatever its bytes, comes back unchanged from one element", () => {
    fc.assert(
      fc.property(separatorsArbitrary, fc.uint8Array({ maxLength: 40 }), (separators, value) => {
        const { bytes: escapedValue, escaped } = escapeValue(value, separators);
        const file = Uint8Array.from([
          ...serviceStringOf(separators),
          ...Buffer.from("FTX", "latin1"),
          separators.element,
          ...escapedValue,
          separators.terminator,
        ]);
        const { tokens, error, batches } = tokenize(file);

        expect(error).toBeNull();
        expect(batches).toHaveLength(1);
        expect(batches[0]?.release).toBe(separators.release);
        const kinds = tokens.map((token) => token.kind);
        if (value.length === 0) {
          expect(kinds).toEqual([
            TokenKind.ServiceStringAdvice,
            TokenKind.SegmentTag,
            TokenKind.ElementSeparator,
            TokenKind.SegmentTerminator,
          ]);
          return;
        }
        expect(kinds).toEqual([
          TokenKind.ServiceStringAdvice,
          TokenKind.SegmentTag,
          TokenKind.ElementSeparator,
          escaped ? TokenKind.EscapedText : TokenKind.Text,
          TokenKind.SegmentTerminator,
        ]);
        const text = tokens[3];
        expect(text).toBeDefined();
        const roundTrip = unescapeValue(
          file,
          text?.start as number,
          text?.end as number,
          separators.release,
        );
        expect(Array.from(roundTrip)).toEqual(Array.from(value));
      }),
    );
  });

  it("a released byte never acts as a separator, and an unreleased one always does", () => {
    fc.assert(
      fc.property(
        separatorsArbitrary,
        fc.integer({ min: 0, max: 255 }),
        fc.boolean(),
        (separators, byte, released) => {
          // "XXX+A", the byte (released or not), "B", then the terminator.
          const file = Uint8Array.from([
            ...serviceStringOf(separators),
            ...Buffer.from("XXX", "latin1"),
            separators.element,
            0x41,
            ...(released ? [separators.release] : []),
            byte,
            0x42,
            separators.terminator,
          ]);
          const { tokens, error } = tokenize(file);

          if (!released && byte === separators.terminator) {
            // The segment ends after "A"; "B'" is then not a segment tag.
            expect(error?.code).toBe("INVALID_SEGMENT_TAG");
            return;
          }
          expect(error).toBeNull();
          const splits =
            !released &&
            (byte === separators.component ||
              byte === separators.element ||
              byte === separators.repetition);
          const texts = tokens.filter(
            (t) => t.kind === TokenKind.Text || t.kind === TokenKind.EscapedText,
          );
          expect(texts).toHaveLength(splits ? 2 : 1);
        },
      ),
    );
  });
});

describe("interchanges written from a model", () => {
  it("are tokenized exactly as the writer laid them out, whatever the separators and line breaks", () => {
    fc.assert(
      fc.property(interchangeArbitrary, (spec) => {
        const built = buildInterchange(spec);
        const { tokens, error, batches } = tokenize(built.bytes);

        expect(error).toBeNull();
        expect(tokens).toEqual(built.tokens.map(({ kind, start, end }) => ({ kind, start, end })));
        for (const separators of batches) {
          expect(separators.element).toBe(spec.separators.element);
          expect(separators.declared).toBe(spec.declareUna);
        }
        const release = spec.separators.release;
        built.tokens.forEach((expected, i) => {
          if (expected.value !== undefined) {
            const token = tokens[i] as { start: number; end: number };
            const value = unescapeValue(built.bytes, token.start, token.end, release);
            expect(Array.from(value)).toEqual(Array.from(expected.value));
          }
        });
      }),
    );
  });

  it("give the same tokens whatever the batch size", () => {
    fc.assert(
      fc.property(interchangeArbitrary, fc.integer({ min: 2, max: 12 }), (spec, batchSize) => {
        const { bytes } = buildInterchange(spec);
        expect(tokenize(bytes, batchSize).tokens).toEqual(tokenize(bytes).tokens);
      }),
    );
  });

  it("report the position of every token as the line and column of a plain scan", () => {
    fc.assert(
      fc.property(interchangeArbitrary, (spec) => {
        const { bytes } = buildInterchange(spec);
        const { tokens, tokenizer } = tokenize(bytes);
        for (const token of tokens) {
          expect(tokenizer.locate(token.start)).toEqual(naiveLocate(bytes, token.start));
        }
      }),
    );
  });
});

const SERVICE_ALPHABET = [
  "U",
  "N",
  "A",
  "B",
  "Z",
  "H",
  "T",
  "+",
  ":",
  "'",
  "?",
  "*",
  ".",
  ",",
  " ",
];

const arbitraryBytes = fc.oneof(
  fc.uint8Array({ maxLength: 200 }),
  fc
    .array(fc.constantFrom(...SERVICE_ALPHABET, "\n", "\r", "1", "x"), { maxLength: 120 })
    .map((chars) => Uint8Array.from(Buffer.from(chars.join(""), "latin1"))),
  fc
    .array(
      fc.constantFrom(
        "UNB+A'",
        "UNH+1:2'",
        "UNA:+.? '",
        "UNZ+1+A'",
        "?'",
        "\r\n",
        "?",
        "FTX+x?+y'",
      ),
      {
        maxLength: 12,
      },
    )
    .map((chunks) => Uint8Array.from(Buffer.from(chunks.join(""), "latin1"))),
);

const SAMPLES = ["valid", "invalid"].flatMap((directory) =>
  readdirSync(`${corpus}${directory}`)
    .filter((name) => name.endsWith(".edi"))
    .map((name) => new Uint8Array(readFileSync(`${corpus}${directory}/${name}`))),
);

/** A real sample, then cut, with a byte changed or inserted, or joined to another sample. */
const mutatedSample = fc
  .record({
    sample: fc.nat(SAMPLES.length - 1),
    other: fc.nat(SAMPLES.length - 1),
    cut: fc.nat(2000),
    at: fc.nat(2000),
    byte: fc.oneof(
      fc.integer({ min: 0, max: 255 }),
      fc.constantFrom(0x27, 0x2b, 0x3a, 0x3f, 0x0a, 0x0d, 0x55),
    ),
    how: fc.constantFrom("cut", "change", "insert", "join", "delete"),
  })
  .map(({ sample, other, cut, at, byte, how }) => {
    const bytes = SAMPLES[sample] as Uint8Array;
    const where = at % (bytes.length + 1);
    switch (how) {
      case "cut":
        return bytes.slice(0, cut % (bytes.length + 1));
      case "change": {
        const copy = bytes.slice();
        if (copy.length > 0) {
          copy[where % copy.length] = byte;
        }
        return copy;
      }
      case "insert":
        return Uint8Array.from([...bytes.subarray(0, where), byte, ...bytes.subarray(where)]);
      case "delete":
        return Uint8Array.from([...bytes.subarray(0, where), ...bytes.subarray(where + 1)]);
      default:
        return Uint8Array.from([...bytes, ...(SAMPLES[other] as Uint8Array)]);
    }
  });

describe("any bytes at all", () => {
  it("end in tokens or in a TokenizeError, never in another exception or a hang", () => {
    fc.assert(
      fc.property(arbitraryBytes, fc.integer({ min: 2, max: 9 }), (bytes, batchSize) => {
        const { error } = tokenize(bytes, batchSize);
        if (error !== null) {
          expect(error).toBeInstanceOf(TokenizeError);
          expect(error.offset).toBeGreaterThanOrEqual(0);
          expect(error.offset).toBeLessThanOrEqual(bytes.length);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("are covered without gap or overlap: only line breaks and a byte order mark are skipped", () => {
    fc.assert(
      fc.property(arbitraryBytes, (bytes) => {
        const { tokens, error } = tokenize(bytes);
        let covered = utf8Bom(bytes);
        for (const token of tokens) {
          expect(token.end).toBeGreaterThan(token.start);
          expect(token.start).toBeGreaterThanOrEqual(covered);
          for (let at = covered; at < token.start; at++) {
            expect([0x0a, 0x0d]).toContain(bytes[at]);
          }
          covered = token.end;
        }
        expect(covered).toBeLessThanOrEqual(bytes.length);
        if (error === null) {
          for (let at = covered; at < bytes.length; at++) {
            expect([0x0a, 0x0d]).toContain(bytes[at]);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("deliver only complete tokens: text is always followed by a separator, tags by an element or end", () => {
    fc.assert(
      fc.property(arbitraryBytes, (bytes) => {
        const { tokens } = tokenize(bytes);
        tokens.forEach((token, i) => {
          const next = tokens[i + 1];
          if (token.kind === TokenKind.Text || token.kind === TokenKind.EscapedText) {
            if (next !== undefined) {
              expect(SEPARATOR_KINDS).toContain(next.kind);
            }
          }
          if (token.kind === TokenKind.SegmentTag && next !== undefined) {
            expect([TokenKind.ElementSeparator, TokenKind.SegmentTerminator]).toContain(next.kind);
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it("give the same tokens, separators and error as a plain byte-by-byte reference tokenizer", () => {
    fc.assert(
      fc.property(arbitraryBytes, fc.integer({ min: 2, max: 9 }), (bytes, batchSize) => {
        const actual = tokenize(bytes, batchSize);
        const reference = referenceTokenize(bytes);

        expect(actual.tokens).toEqual(reference.tokens);
        expect(actual.separatorsOfToken).toEqual(reference.separatorsOfToken);
        if (reference.error === null) {
          expect(actual.error).toBeNull();
        } else {
          expect(actual.error).toMatchObject(reference.error);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it("agree with the reference on files built from real samples that are cut, bent or joined", () => {
    fc.assert(
      fc.property(mutatedSample, fc.integer({ min: 2, max: 9 }), (bytes, batchSize) => {
        const actual = tokenize(bytes, batchSize);
        const reference = referenceTokenize(bytes);
        expect(actual.tokens).toEqual(reference.tokens);
        if (reference.error === null) {
          expect(actual.error).toBeNull();
        } else {
          expect(actual.error).toMatchObject(reference.error);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it("locate the same line and column as a plain scan of the bytes", () => {
    fc.assert(
      fc.property(arbitraryBytes, fc.nat(), (bytes, seed) => {
        const tokenizer = new Tokenizer(bytes);
        const offset = bytes.length === 0 ? 0 : seed % (bytes.length + 1);
        expect(tokenizer.locate(offset)).toEqual(naiveLocate(bytes, offset));
      }),
      { numRuns: 500 },
    );
  });
});

const fileOfInterchanges = fc.oneof(
  fc.record({
    specs: fc.array(interchangeArbitrary, { minLength: 1, maxLength: 3 }),
    unz: fc.constant(true),
  }),
  fc.record({
    specs: fc
      .tuple(
        interchangeArbitrary,
        fc.array(
          interchangeArbitrary.filter((spec) => spec.declareUna),
          { maxLength: 2 },
        ),
      )
      .map(([first, rest]) => [first, ...rest]),
    unz: fc.constant(false),
  }),
);

describe("several interchanges in one file", () => {
  it("are tokenized one after the other, each with its own separators, one set per batch", () => {
    fc.assert(
      fc.property(
        fileOfInterchanges,
        fc.integer({ min: 2, max: 16 }),
        ({ specs, unz }, batchSize) => {
          // After a UNZ the separators are the defaults again. Without one, only a new UNA string
          // can change them, so every interchange after the first declares its own.
          const parts = specs.map((spec) =>
            buildInterchange(
              unz ? { ...spec, segments: [...spec.segments, { tag: "UNZ", elements: [] }] } : spec,
            ),
          );
          const bytes = Uint8Array.from(parts.flatMap((part) => [...part.bytes]));
          let shift = 0;
          const expected = parts.flatMap((part) => {
            const tokens = part.tokens.map(({ kind, start, end }) => ({
              kind,
              start: start + shift,
              end: end + shift,
            }));
            shift += part.bytes.length;
            return tokens;
          });

          expect(tokenize(bytes, batchSize).tokens).toEqual(expected);

          // Every separator token is the character of the separators its own batch reports.
          for (const batch of new Tokenizer(bytes, { batchSize })) {
            const { separators } = batch;
            const byKind: Record<number, number | null> = {
              [TokenKind.ComponentSeparator]: separators.component,
              [TokenKind.ElementSeparator]: separators.element,
              [TokenKind.RepetitionSeparator]: separators.repetition,
              [TokenKind.SegmentTerminator]: separators.terminator,
            };
            for (let i = 0; i < batch.length; i++) {
              const wanted = byKind[batch.kinds[i] as number];
              if (wanted !== undefined) {
                expect(bytes[batch.starts[i] as number]).toBe(wanted);
              }
            }
          }
        },
      ),
    );
  });
});

/** A plain, obviously correct line/column: walk the bytes and count. */
function naiveLocate(bytes: Uint8Array, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const byte = bytes[i];
    if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
