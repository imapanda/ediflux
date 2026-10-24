import { describe, expect, it } from "vitest";
import {
  decodeText,
  splitMessages,
  TokenizeError,
  Tokenizer,
  TokenKind,
  unescapeValue,
} from "./index.ts";
import {
  type ExpectedInvalid,
  type ExpectedValid,
  expectedOf,
  readSample,
  samples,
} from "./testing/corpus.ts";
import { textOf } from "./testing/helpers.ts";

/** How many segments each message has, from the expected result: UNH to UNT, both included. */
function segmentCounts(tags: string[]): number[] {
  const counts: number[] = [];
  let from = -1;
  tags.forEach((tag, i) => {
    if (tag === "UNH") {
      from = i;
    } else if (tag === "UNT" && from >= 0) {
      counts.push(i - from + 1);
      from = -1;
    }
  });
  return counts;
}

describe("valid samples", () => {
  it.each(samples("valid"))("%s is cut into the messages of its expected-result file", (name) => {
    const bytes = readSample("valid", name);
    const wanted = expectedOf<ExpectedValid>("valid", name);
    const stream = splitMessages(bytes);
    const slices = [...stream];

    expect(stream.issues, "no issue in a valid sample").toEqual([]);
    expect(slices).toHaveLength(wanted.interchange.messages.length);
    expect(slices.map((s) => s.segmentCount)).toEqual(
      segmentCounts(wanted.segments.map((s) => s.tag)),
    );

    for (const slice of slices) {
      const text = textOf(bytes, slice.start, slice.end);
      expect(text.startsWith("UNH")).toBe(true);
      expect(slice.closed).toBe(true);
      const terminator = String.fromCharCode(slice.interchange.separators.terminator);
      expect(text.slice(-1)).toBe(terminator);
      // The last segment is UNT, after the line break that follows the one before it.
      const lastSegment = text.slice(0, -1).split(terminator).at(-1) ?? "";
      expect(lastSegment.replace(/^[\r\n]+/, "").startsWith("UNT")).toBe(true);

      const { interchange } = slice;
      expect(interchange.index).toBe(0);
      expect(interchange.syntaxIdentifier).toBe(wanted.interchange.syntaxIdentifier);
      expect(interchange.syntaxVersion).toBe(String(wanted.interchange.syntaxVersion));
      expect(interchange.characterSet).toBe(wanted.interchange.syntaxIdentifier);
      expect(interchange.una?.text ?? null).toBe(wanted.interchange.una);
      expect(textOf(bytes, interchange.unb?.start ?? 0, (interchange.unb?.start ?? 0) + 3)).toBe(
        "UNB",
      );
      expect(interchange.source).toBe(bytes);
    }
  });

  it.each(samples("valid").filter((name) => /-(unoc|unow)-/.test(name)))(
    "%s: UNOC and UTF-8 values decode to the text of its expected-result file",
    (name) => {
      const bytes = readSample("valid", name);
      const wanted = expectedOf<ExpectedValid>("valid", name);
      const [slice] = [...splitMessages(bytes)];
      const set = slice?.interchange.characterSet ?? null;
      expect(set === "UNOC" || set === "UNOW").toBe(true);

      // Every value of the file, in order, decoded with the character set of the interchange.
      const release = slice?.interchange.separators.release ?? 0x3f;
      const values: string[] = [];
      for (const batch of new Tokenizer(bytes)) {
        for (let i = 0; i < batch.length; i++) {
          const kind = batch.kinds[i];
          if (kind === TokenKind.Text || kind === TokenKind.EscapedText) {
            const start = batch.starts[i] as number;
            const end = batch.ends[i] as number;
            const unescaped =
              kind === TokenKind.EscapedText
                ? unescapeValue(bytes, start, end, release)
                : bytes.subarray(start, end);
            values.push(decodeText(unescaped, 0, unescaped.length, set));
          }
        }
      }
      const expectedValues = wanted.segments
        .flatMap((segment) => segment.elements as (string[] | { repetitions: string[][] })[])
        .flatMap((element) => (Array.isArray(element) ? element : element.repetitions.flat()))
        .filter((value) => value !== "");
      expect(values).toEqual(expectedValues);
    },
  );

  it.each(["orders-d96a-s3-unoc-accents", "orders-d01b-s4-unow-utf8"])(
    "%s has characters outside ASCII, and they come out right",
    (name) => {
      const bytes = readSample("valid", name);
      const [slice] = [...splitMessages(bytes)];
      const wanted = JSON.stringify(expectedOf<ExpectedValid>("valid", name).segments);
      const nonAscii = [...wanted].filter((char) => (char.codePointAt(0) as number) > 0x7f);
      expect(nonAscii.length).toBeGreaterThan(0);
      // The raw bytes, decoded, contain the text that the independent tool wrote.
      const decoded = decodeText(bytes, 0, bytes.length, slice?.interchange.characterSet ?? null);
      for (const text of nonAscii) {
        expect(decoded).toContain(text);
      }
    },
  );
});

describe("invalid samples", () => {
  it("a bad UNA and a cut file are tokenizer errors, which stop the split", () => {
    for (const name of ["invalid-una", "unexpected-end-of-file"]) {
      expect(() => [...splitMessages(readSample("invalid", name))], name).toThrow(TokenizeError);
    }
  });

  const charsetSamples = [
    "invalid-character-unoa",
    "invalid-character-unow",
    "unsupported-charset",
  ];

  it.each(charsetSamples)("%s: the issue has the position of the expected-result file", (name) => {
    const stream = splitMessages(readSample("invalid", name));
    const slices = [...stream];
    const [wanted] = expectedOf<ExpectedInvalid>("invalid", name).expectedErrors;
    expect(slices.length).toBeGreaterThan(0);
    expect(stream.issues).toHaveLength(1);
    expect(stream.issues[0]?.code).toBe(wanted?.code);
    expect(stream.issues[0]?.position).toEqual({
      segment: wanted?.position.segment,
      tag: wanted?.position.tag,
      element: wanted?.position.element,
      component: wanted?.position.component,
    });
    expect(stream.issues[0]?.line).toBeGreaterThan(0);
  });

  it("an unsupported character set leaves the character set unset", () => {
    const [slice] = [...splitMessages(readSample("invalid", "unsupported-charset"))];
    expect(slice?.interchange.syntaxIdentifier).toBe("UNOZ");
    expect(slice?.interchange.characterSet).toBeNull();
  });

  it.each(
    samples("invalid").filter(
      (name) => !["invalid-una", "unexpected-end-of-file", ...charsetSamples].includes(name),
    ),
  )("%s is well formed as far as the split goes: the validator finds its fault", (name) => {
    const stream = splitMessages(readSample("invalid", name));
    expect([...stream].length).toBeGreaterThan(0);
    expect(stream.issues).toEqual([]);
  });
});
