import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type MessageSlice, splitMessages, TokenizeError } from "./index.ts";
import { readSample, samples } from "./testing/corpus.ts";
import { tokenize } from "./testing/helpers.ts";
import { referenceSplit } from "./testing/split-reference.ts";
import { tagArbitrary } from "./testing/writer.ts";

const enc = (text: string) => new TextEncoder().encode(text);

describe("the envelope of messages", () => {
  const file = fc.record({
    messages: fc.array(
      fc.record({ body: fc.array(tagArbitrary, { maxLength: 3 }), closed: fc.boolean() }),
      {
        maxLength: 4,
      },
    ),
    grouped: fc.boolean(),
    endGroup: fc.boolean(),
    endInterchange: fc.boolean(),
  });

  function write(model: {
    messages: { body: string[]; closed: boolean }[];
    grouped: boolean;
    endGroup: boolean;
    endInterchange: boolean;
  }): { text: string; starts: number[]; ends: number[] } {
    let text = "UNB+UNOA:3+A'";
    if (model.grouped) {
      text += "UNG+X+A+B'";
    }
    const starts: number[] = [];
    const ends: number[] = [];
    model.messages.forEach(({ body, closed }, m) => {
      starts.push(text.length);
      text += `UNH+${m + 1}+X'${body.map((tag) => `${tag}+1'`).join("")}`;
      text += closed ? `UNT+${body.length + 2}+${m + 1}'` : "";
      ends.push(text.length);
    });
    if (model.grouped && model.endGroup) {
      text += "UNE+1+G'";
    }
    return { text: model.endInterchange ? `${text}UNZ+1+1'` : text, starts, ends };
  }

  it("is cut into the messages written, whether or not they end with UNT, in groups or not", () => {
    fc.assert(
      fc.property(file, fc.integer({ min: 2, max: 9 }), (model, batchSize) => {
        const { text, starts, ends } = write(model);
        const stream = splitMessages(enc(text), { batchSize });
        const found = [...stream];

        expect(stream.issues).toEqual([]);
        expect(found).toHaveLength(model.messages.length);
        found.forEach((slice, m) => {
          const wanted = model.messages[m];
          expect([slice.start, slice.end]).toEqual([starts[m], ends[m]]);
          expect(slice.segmentCount).toBe(
            1 + (wanted?.body.length ?? 0) + (wanted?.closed ? 1 : 0),
          );
          expect(slice.closed).toBe(wanted?.closed);
          expect(slice.ung === null).toBe(!model.grouped);
          expect(slice.interchange.characterSet).toBe("UNOA");
        });
      }),
      { numRuns: 400 },
    );
  });
});

describe("character sets", () => {
  /** Printable ISO 8859-1, which is what UNOC allows, apart from the characters that split. */
  const unoc = (byte: number) => (byte >= 0x20 && byte <= 0x7e) || byte >= 0xa0;
  const splitters = [0x27, 0x2b, 0x3a, 0x3f];
  /** Level A of UNOA. */
  const unoa = (byte: number) =>
    ' .,-()/=!"%&*;<>'.includes(String.fromCharCode(byte)) ||
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a);

  it.each([
    ["UNOC", unoc],
    ["UNOA", unoa],
  ] as const)(
    "%s: a value is reported if and only if it has a byte the set does not allow",
    (name, allowed) => {
      const value = fc
        .uint8Array({ minLength: 1, maxLength: 20 })
        .filter((bytes) => bytes.every((b) => !splitters.includes(b)));
      fc.assert(
        fc.property(value, (bytes) => {
          const head = enc(`UNB+${name}:3+A'FTX+AAI+++`);
          const file = Uint8Array.from([...head, ...bytes, ...enc("'UNZ+0+1'")]);
          const stream = splitMessages(file);
          [...stream];
          const bad = bytes.findIndex((b) => !allowed(b));

          expect(stream.issueCount).toBe(bad === -1 ? 0 : 1);
          if (bad !== -1) {
            expect(stream.issues[0]).toMatchObject({
              code: "INVALID_CHARACTER",
              offset: head.length + bad,
              position: { segment: 2, tag: "FTX", element: 4, component: 1 },
            });
          }
        }),
        { numRuns: 400 },
      );
    },
  );
});

describe("any bytes at all", () => {
  const arbitraryBytes = fc.oneof(
    fc.uint8Array({ maxLength: 150 }),
    fc
      .array(
        fc.constantFrom(
          "UNA:+.? '",
          "UNB+UNOA:3+A'",
          "UNH+1+X'",
          "UNT+1+1'",
          "UNZ+1+1'",
          "UNG+X+A+B'",
          "UNE+1+G'",
          "FTX+a:b'",
          "\n",
          "?",
          "'",
          "+",
          ":",
        ),
        { maxLength: 16 },
      )
      .map((chunks) => enc(chunks.join(""))),
  );

  it("are cut into consistent messages, or stop with the tokenizer's error: nothing else happens", () => {
    fc.assert(
      fc.property(arbitraryBytes, fc.integer({ min: 2, max: 9 }), (bytes, batchSize) => {
        const tokens = tokenize(bytes, batchSize);
        const stream = splitMessages(bytes, { batchSize });
        const found: { start: number; end: number; segmentCount: number }[] = [];
        let error: unknown;
        try {
          for (const slice of stream) {
            found.push(slice);
          }
        } catch (caught) {
          error = caught;
        }
        if (tokens.error === null) {
          expect(error).toBeUndefined();
        } else {
          expect(error).toBeInstanceOf(TokenizeError);
          expect((error as TokenizeError).code).toBe(tokens.error.code);
        }
        let previousEnd = 0;
        for (const slice of found) {
          expect(slice.start).toBeGreaterThanOrEqual(previousEnd);
          expect(slice.end).toBeGreaterThan(slice.start);
          expect(slice.end).toBeLessThanOrEqual(bytes.length);
          expect(slice.segmentCount).toBeGreaterThan(0);
          previousEnd = slice.end;
        }
        // A message starts at a UNH tag, and every segment it holds is a tag in the tokens.
        const tags = tokens.tokens.filter((t) => t.kind === 2);
        for (const slice of found) {
          const inside = tags.filter((t) => t.start >= slice.start && t.end <= slice.end);
          expect(inside).toHaveLength(slice.segmentCount);
          expect(String.fromCharCode(...bytes.subarray(slice.start, slice.start + 3))).toBe("UNH");
        }
        expect(stream.issueCount).toBeGreaterThanOrEqual(stream.issues.length);
      }),
      { numRuns: 1500 },
    );
  });
});

// --- Against a plain second version of the splitter --------------------------------------------

const SAMPLES = ["valid", "invalid"].flatMap((directory) =>
  samples(directory as "valid" | "invalid").map((name) =>
    readSample(directory as "valid" | "invalid", name),
  ),
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
      fc.constantFrom(0x27, 0x2b, 0x3a, 0x3f, 0x0a, 0x0d, 0x55, 0x2a, 0xc3, 0xe9),
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

/** Messages, characters and envelopes put together at random, with every set and some UNA strings. */
const structured = fc
  .array(
    fc.constantFrom(
      "UNA:+.?*'",
      "UNA|{.}^~",
      "UNA;*,! %",
      "UNB+UNOA:3+A'",
      "UNB+UNOB:3+a'",
      "UNB+UNOC:3+A'",
      "UNB+UNOW:4+A'",
      "UNB+UNOX:3+A'",
      "UNB+UNOA:3*UNOX:3+A'",
      "UNB+UNOA:3:b+c'",
      "UNH+1+X'",
      "UNT+1+1'",
      "UNZ+1+1'",
      "UNG+X+A+B'",
      "UNE+1+G'",
      "FTX+AAI+++text'",
      "FTX+AAI+++A?+b'",
      "FTX+AAI+++A*b'",
      "FTX+AAI+++é'",
      "FTX+AAI+++Ã©'",
      "FTX+AAI+++a\nb'",
      "\r\n",
      "ï»¿",
    ),
    { maxLength: 14 },
  )
  .map((chunks) => Uint8Array.from(Buffer.from(chunks.join(""), "latin1")));

describe("against a plain second version of the splitter", () => {
  function same(bytes: Uint8Array, batchSize: number, check: boolean, maxIssues: number): void {
    const reference = referenceSplit(bytes, check, maxIssues);
    const stream = splitMessages(bytes, { batchSize, checkCharacters: check, maxIssues });
    const found: MessageSlice[] = [];
    let failed = false;
    try {
      for (const slice of stream) {
        found.push(slice);
      }
    } catch (error) {
      expect(error).toBeInstanceOf(TokenizeError);
      failed = true;
    }
    expect(failed).toBe(reference.failed);

    expect(
      found.map((s) => [
        s.start,
        s.end,
        s.segmentCount,
        s.closed,
        s.ung && [s.ung.start, s.ung.end],
        s.interchange.index,
      ]),
    ).toEqual(
      reference.slices.map((s) => [s.start, s.end, s.segmentCount, s.closed, s.ung, s.facts.index]),
    );
    found.forEach((slice, i) => {
      const facts = reference.slices[i]?.facts;
      expect(slice.interchange.characterSet).toBe(facts?.characterSet);
      expect(slice.interchange.syntaxIdentifier).toBe(facts?.syntaxIdentifier);
      expect(slice.interchange.syntaxVersion).toBe(facts?.syntaxVersion);
      expect(slice.interchange.una?.text ?? null).toBe(facts?.una);
      const unb = slice.interchange.unb;
      expect(unb && [unb.start, unb.end]).toEqual(facts?.unb);
    });

    expect(stream.issueCount).toBe(reference.issueCount);
    expect(stream.issues).toHaveLength(reference.issues.length);
    stream.issues.forEach((issue, i) => {
      const wanted = reference.issues[i];
      expect(issue.code).toBe(wanted?.code);
      expect(issue.position).toEqual(wanted?.position);
      // Where the first bad byte of a UTF-8 value is, is not modelled: line and column follow it.
      if (wanted?.offset !== null) {
        expect(issue.offset).toBe(wanted?.offset);
        expect([issue.line, issue.column]).toEqual([wanted?.line, wanted?.column]);
      }
    });
  }

  it("finds the same messages, interchanges, issues and positions in random structured files", () => {
    fc.assert(
      fc.property(
        structured,
        fc.integer({ min: 2, max: 9 }),
        fc.boolean(),
        (bytes, batchSize, check) => {
          same(bytes, batchSize, check, 100);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("finds the same in real samples that are cut, bent, joined or have a byte changed", () => {
    fc.assert(
      fc.property(mutatedSample, fc.integer({ min: 2, max: 9 }), (bytes, batchSize) => {
        same(bytes, batchSize, true, 100);
      }),
      { numRuns: 2000 },
    );
  });

  it("finds the same in arbitrary bytes, with a cap on the issues", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 120 }),
        fc.integer({ min: 0, max: 3 }),
        (bytes, maxIssues) => {
          same(Uint8Array.from([...enc("UNB+UNOC:3+A'FTX+AAI+++"), ...bytes]), 5, true, maxIssues);
        },
      ),
      { numRuns: 800 },
    );
  });
});
