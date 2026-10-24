import { describe, expect, it } from "vitest";
import { generateOrders } from "../bench/generate.ts";
import { type MessageSlice, splitMessages, TokenizeError } from "./index.ts";
import { bytesOf, textOf } from "./testing/helpers.ts";

function slices(text: string, options = {}): MessageSlice[] {
  return [...splitMessages(bytesOf(text), options)];
}

const ENVELOPE = "UNB+UNOA:3+SENDER+RECEIVER+301015:0830+IC1'";

describe("messages of a well-formed interchange", () => {
  const text = `UNA:+.? '${ENVELOPE}UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1'UNT+3+1'UNH+2+ORDERS:D:96A:UN'BGM+220+PO-2'UNT+3+2'UNZ+2+IC1'`;

  it("are located from UNH to the end of UNT, with their number of segments", () => {
    const found = slices(text);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.kind)).toEqual(["message", "message"]);
    expect(found.map((s) => textOf(bytesOf(text), s.start, s.end))).toEqual([
      "UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1'UNT+3+1'",
      "UNH+2+ORDERS:D:96A:UN'BGM+220+PO-2'UNT+3+2'",
    ]);
    expect(found.map((s) => s.segmentCount)).toEqual([3, 3]);
    expect(found.map((s) => s.closed)).toEqual([true, true]);
    expect(found.map((s) => s.ung)).toEqual([null, null]);
  });

  it("know the facts of their interchange, which they share", () => {
    const [first, second] = slices(text);
    const facts = first?.interchange;
    expect(second?.interchange).toBe(facts);
    expect(facts?.index).toBe(0);
    expect(facts?.una).toEqual({ kind: "una", start: 0, end: 9, text: ":+.? '" });
    expect(facts?.separators.declared).toBe(true);
    expect(facts?.syntaxIdentifier).toBe("UNOA");
    expect(facts?.syntaxVersion).toBe("3");
    expect(facts?.characterSet).toBe("UNOA");
    expect(textOf(bytesOf(text), facts?.unb?.start ?? 0, facts?.unb?.end ?? 0)).toBe(ENVELOPE);
  });

  it("give the line and column of any offset", () => {
    const multi = "UNB+UNOA:3+A'\nUNH+1+X'\r\nBGM+1'\nUNT+2+1'\n";
    const [slice] = slices(multi);
    expect(slice?.interchange.locate(slice.start)).toEqual({ line: 2, column: 1 });
    expect(slice?.interchange.locate(slice.end)).toEqual({ line: 4, column: 9 });
  });

  it("are the messages whatever the line breaks between segments", () => {
    const withBreaks = text.replaceAll("'", "'\r\n");
    expect(slices(withBreaks).map((s) => s.segmentCount)).toEqual([3, 3]);
  });
});

describe("a structure that is not what it should be still has its messages", () => {
  it("lets a message run on without UNT until the next UNH", () => {
    const found = slices(`${ENVELOPE}UNH+1+X'BGM+1'UNH+2+X'BGM+2'UNT+2+2'UNZ+2+IC1'`);
    expect(found.map((s) => [s.segmentCount, s.closed])).toEqual([
      [2, false],
      [3, true],
    ]);
  });

  it("lets a message and an interchange end with the file", () => {
    const text = `${ENVELOPE}UNH+1+X'BGM+1'`;
    const [only] = slices(text);
    expect(only?.closed).toBe(false);
    expect(only?.end).toBe(text.length);
  });

  it("ends a message at UNE or UNZ as well as at UNH", () => {
    const found = slices(
      `${ENVELOPE}UNG+ORDERS+A+B'UNH+1+X'BGM+1'UNE+1+G1'UNH+2+X'BGM+2'UNZ+1+IC1'`,
    );
    expect(found.map((s) => [s.segmentCount, s.closed])).toEqual([
      [2, false],
      [2, false],
    ]);
  });

  it("does not take a segment outside a message for one", () => {
    const found = slices(`${ENVELOPE}BGM+0'UNH+1+X'UNT+1+1'FTX+AAI'UNT+1+1'UNH+2+X'UNT+1+2'`);
    expect(found.map((s) => s.segmentCount)).toEqual([1 + 1, 1 + 1]);
  });

  it("finds messages in a file that has no envelope at all", () => {
    const [slice] = slices("UNH+1+X'BGM+1'UNT+2+1'");
    expect(slice?.interchange.unb).toBeNull();
    expect(slice?.interchange.characterSet).toBeNull();
    expect(slice?.interchange.una).toBeNull();
  });

  it("finds none in an empty file, a file of line breaks, or an envelope without messages", () => {
    expect(slices("")).toEqual([]);
    expect(slices("\r\n\n")).toEqual([]);
    expect(slices(`${ENVELOPE}UNZ+0+IC1'`)).toEqual([]);
  });
});

describe("groups", () => {
  const text = `${ENVELOPE}UNG+ORDERS+A+B'UNH+1+X'UNT+1+1'UNH+2+X'UNT+1+2'UNE+2+G1'UNH+3+X'UNT+1+3'UNZ+2+IC1'`;

  it("tell each message which group it is in, by the span of its UNG", () => {
    const found = slices(text);
    expect(found.map((s) => s.ung !== null)).toEqual([true, true, false]);
    const ung = found[0]?.ung;
    expect(textOf(bytesOf(text), ung?.start ?? 0, ung?.end ?? 0)).toBe("UNG+ORDERS+A+B'");
    expect(found[1]?.ung).toEqual(ung);
  });

  it("forget a group when its interchange ends, even without UNE", () => {
    const found = slices(
      `${ENVELOPE}UNG+X+A+B'UNH+1+X'UNT+1+1'UNZ+1+1'${ENVELOPE}UNH+1+X'UNT+1+1'UNZ+1+2'`,
    );
    expect(found.map((s) => s.ung !== null)).toEqual([true, false]);
  });
});

describe("several interchanges in one file", () => {
  const text = `UNA:+.? 'UNB+UNOA:3+A'UNH+1+X'UNT+1+1'UNZ+1+1'UNB+UNOC:3+B'UNH+1+X'UNT+1+1'UNZ+1+2'UNA;*,! %UNB*UNOW;4*C%UNH*1*X%UNT*1*1%UNZ*1*3%`;

  it("have their own facts: index, separators, character set", () => {
    const found = slices(text);
    expect(found.map((s) => s.interchange.index)).toEqual([0, 1, 2]);
    expect(found.map((s) => s.interchange.characterSet)).toEqual(["UNOA", "UNOC", "UNOW"]);
    expect(found.map((s) => s.interchange.una?.text ?? null)).toEqual([":+.? '", null, ";*,! %"]);
    expect(found.map((s) => s.interchange.separators.element)).toEqual([0x2b, 0x2b, 0x2a]);
  });

  it("start a new one at UNA when the last one has no UNZ", () => {
    const found = slices("UNB+UNOA:3+A'UNH+1+X'UNT+1+1'UNA;*,! %UNB*UNOC;3*B%UNH*1*X%UNT*1*1%");
    expect(found.map((s) => s.interchange.index)).toEqual([0, 1]);
    expect(found.map((s) => s.interchange.characterSet)).toEqual(["UNOA", "UNOC"]);
    expect(found.map((s) => s.interchange.una?.text ?? null)).toEqual([null, ";*,! %"]);
  });

  it("start a new one at UNB when the last one has no UNZ", () => {
    const found = slices("UNB+UNOA:3+A'UNH+1+X'UNB+UNOA:3+B'UNH+1+X'UNT+1+1'");
    expect(found.map((s) => s.interchange.index)).toEqual([0, 1]);
    expect(found.map((s) => s.closed)).toEqual([false, true]);
  });
});

describe("character sets", () => {
  it("accept UNOC and UNOW text", () => {
    const unoc = Uint8Array.from([
      ...bytesOf("UNB+UNOC:3+A'FTX+AAI+++Cr"),
      0xe8,
      ...bytesOf("me'UNZ+0+1'"),
    ]);
    const unow = Uint8Array.from([
      ...bytesOf("UNB+UNOW:4+A'FTX+AAI+++"),
      ...new TextEncoder().encode("Crème € 😀"),
      ...bytesOf("'UNZ+0+1'"),
    ]);
    for (const bytes of [unoc, unow]) {
      const stream = splitMessages(bytes);
      expect([...stream]).toEqual([]);
      expect(stream.issues).toEqual([]);
    }
  });

  it("report a bad value once, with its position and a plain message", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOA:3+A'FTX+AAI+++SAMPLE CRE"),
      0xc9,
      ...bytesOf(" SA'UNZ+0+1'"),
    ]);
    const stream = splitMessages(bytes);
    expect([...stream]).toEqual([]);
    expect(stream.issueCount).toBe(1);
    expect(stream.issues[0]).toMatchObject({
      code: "INVALID_CHARACTER",
      message: "Invalid character in UNOA: byte 0xC9 is not a character of UNOA",
      offset: 33,
      line: 1,
      column: 34,
      position: { segment: 2, tag: "FTX", element: 4, component: 1 },
    });
  });

  it("report a line break inside a value, which the tokenizer leaves as data", () => {
    const stream = splitMessages(bytesOf("UNB+UNOA:3+A'FTX+AAI+++ONE\nTWO'UNZ+0+1'"));
    expect([...stream]).toEqual([]);
    expect(stream.issues).toHaveLength(1);
    expect(stream.issues[0]?.message).toContain("byte 0x0A");
  });

  it("report an unsupported character set and read on, unchecked", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOK:3+A'UNH+1+X'FTX+AAI+++"),
      0xe9,
      0x01,
      ...bytesOf("'UNT+2+1'"),
    ]);
    const stream = splitMessages(bytes);
    const found = [...stream];
    expect(stream.issues.map((i) => i.code)).toEqual(["UNSUPPORTED_CHARSET"]);
    expect(stream.issues[0]?.position).toEqual({
      segment: 1,
      tag: "UNB",
      element: 1,
      component: 1,
    });
    expect(stream.issues[0]?.message).toContain('"UNOK"');
    expect(found[0]?.interchange.syntaxIdentifier).toBe("UNOK");
    expect(found[0]?.interchange.characterSet).toBeNull();
  });

  it("have no set to check against when UNB is missing or has no S001", () => {
    expect(splitMessages(bytesOf("UNH+1+X'FTX+\u0001'UNT+2+1'")).issues).toEqual([]);
    const stream = splitMessages(bytesOf("UNB+'UNH+1+X'FTX+\u0001'UNT+2+1'"));
    expect([...stream]).toHaveLength(1);
    expect(stream.issues).toEqual([]);
  });

  it("accept what UNA declares as separators, whatever the set", () => {
    const stream = splitMessages(bytesOf("UNA|{.}^~UNB{UNOA|3~FTX{AAI{{{A}|B}~UNZ{0{1~"));
    expect([...stream]).toEqual([]);
    expect(stream.issues).toEqual([]);
  });

  it("can be told not to check", () => {
    const text = bytesOf("UNB+UNOA:3+A'FTX+AAI+++lower case'UNZ+0+1'");
    const checked = splitMessages(text);
    const unchecked = splitMessages(text, { checkCharacters: false });
    [...checked];
    [...unchecked];
    expect(checked.issueCount).toBe(1);
    expect(unchecked.issueCount).toBe(0);
  });

  it("keep at most maxIssues of them but count them all", () => {
    const text = bytesOf(`UNB+UNOA:3+A'${"FTX+AAI+++lower'".repeat(5)}UNZ+0+1'`);
    const stream = splitMessages(text, { maxIssues: 2 });
    [...stream];
    expect(stream.issues).toHaveLength(2);
    expect(stream.issueCount).toBe(5);
    const none = splitMessages(text, { maxIssues: 0 });
    [...none];
    expect(none.issues).toEqual([]);
    expect(none.issueCount).toBe(5);
    expect(() => splitMessages(text, { maxIssues: -1 })).toThrow(RangeError);
  });
});

describe("the stream", () => {
  const text = `${ENVELOPE}UNH+1+X'BGM+1'UNT+2+1'UNH+2+X'BGM+2'UNT+2+2'UNZ+2+IC1'`;

  it("reads its input once", () => {
    const stream = splitMessages(bytesOf(text));
    expect([...stream]).toHaveLength(2);
    expect(stream.messageCount).toBe(2);
    expect([...stream]).toEqual([]);
  });

  it("gives the same slices whatever the tokenizer's batch size", () => {
    const small = slices(text, { batchSize: 2 }).map((s) => [s.start, s.end, s.segmentCount]);
    const normal = slices(text).map((s) => [s.start, s.end, s.segmentCount]);
    expect(small).toEqual(normal);
  });

  it("hands out the messages before a cut, then throws the tokenizer's error", () => {
    const cut = `${ENVELOPE}UNH+1+X'BGM+1'UNT+2+1'UNH+2+X'BGM+2'UNT+2`;
    const seen: number[] = [];
    expect(() => {
      for (const slice of splitMessages(bytesOf(cut))) {
        seen.push(slice.segmentCount);
      }
    }).toThrow(TokenizeError);
    expect(seen).toEqual([3]);
  });
});

describe("a large interchange", () => {
  it("is cut into its messages with nothing kept but the envelope", { timeout: 30_000 }, () => {
    const { bytes, messages } = generateOrders({ messages: 400, linesPerMessage: 80 });
    expect(bytes.length).toBeGreaterThan(3_000_000);
    const stream = splitMessages(bytes);
    let count = 0;
    let segments = 0;
    for (const slice of stream) {
      expect([slice.start, slice.end]).toEqual([messages[count]?.start, messages[count]?.end]);
      count++;
      segments += slice.segmentCount;
    }
    expect(count).toBe(messages.length);
    expect(segments).toBe(messages.length * 408);
    expect(stream.issueCount).toBe(0);
  });
});

describe("the call", () => {
  it("refuses an input that is not a Uint8Array, or a bad option, at once", () => {
    expect(() => splitMessages(new ArrayBuffer(4) as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => splitMessages(new Uint8Array(0), { batchSize: 1 })).toThrow(RangeError);
    expect(() => splitMessages(new Uint8Array(0), { maxIssues: 1.5 })).toThrow(RangeError);
  });

  it("answers locate() for an offset inside the input only", () => {
    const [slice] = slices(`${ENVELOPE}UNH+1+X'UNT+1+1'`);
    const facts = slice?.interchange;
    expect(facts?.locate(0)).toEqual({ line: 1, column: 1 });
    for (const offset of [-1, Number.NaN, 1e9, 2.5]) {
      expect(() => facts?.locate(offset)).toThrow(RangeError);
    }
  });
});

describe("the name of the character set", () => {
  it("is kept short and printable in the facts and in the message", () => {
    const hostile = "\u001b[31m\r\n2026-01-01 ERROR forged line:3";
    const stream = splitMessages(bytesOf(`UNB+${hostile.replaceAll(":", "?:")}'UNH+1+X'UNT+1+1'`));
    const [slice] = [...stream];
    const shown = slice?.interchange.syntaxIdentifier ?? "";
    expect(shown).toBe("?[31m??2026-01-01 ERROR forged l...");
    const message = stream.issues[0]?.message ?? "";
    expect([...message].every((char) => (char.codePointAt(0) as number) >= 0x20)).toBe(true);
  });

  it("is cut at 32 characters, however long it is", () => {
    const long = "X".repeat(100_000);
    const stream = splitMessages(bytesOf(`UNB+${long}:${long}'UNH+1+X'UNT+1+1'`));
    const [slice] = [...stream];
    expect(slice?.interchange.syntaxIdentifier).toBe(`${"X".repeat(32)}...`);
    expect(slice?.interchange.syntaxVersion).toBe(`${"X".repeat(32)}...`);
    expect(stream.issues[0]?.message.length).toBeLessThan(250);
  });

  it("is taken once: a repetition in S001 does not replace it", () => {
    const stream = splitMessages(
      bytesOf("UNA:+.?*'UNB+UNOA:3*UNOX:3+A'UNH+1+X'FTX+AAI+++lower'UNT+2+1'"),
    );
    const [slice] = [...stream];
    expect(slice?.interchange.syntaxIdentifier).toBe("UNOA");
    expect(slice?.interchange.syntaxVersion).toBe("3");
    expect(slice?.interchange.characterSet).toBe("UNOA");
    expect(stream.issues.map((i) => i.code)).toEqual(["INVALID_CHARACTER"]);
  });
});

describe("where an issue is", () => {
  it("has its line and column, after line breaks of every kind", () => {
    const text = "UNB+UNOA:3+A'\r\nUNH+1+X'\nFTX+AAI+++OK'\rFTX+AAI+++lower'UNT+1+1'";
    const stream = splitMessages(bytesOf(text));
    [...stream];
    expect(stream.issues[0]).toMatchObject({
      offset: text.indexOf("lower"),
      line: 4,
      column: 11,
      position: { segment: 4, tag: "FTX", element: 4, component: 1 },
    });
  });

  it("counts a component from the repetition separator, and an element after it from its own start", () => {
    const stream = splitMessages(bytesOf("UNA:+.?*'UNB+UNOA:3'FTX+AAI+++A:B*c+d'"));
    [...stream];
    expect(stream.issues.map((i) => i.position)).toEqual([
      { segment: 2, tag: "FTX", element: 4, component: 1 },
      { segment: 2, tag: "FTX", element: 5, component: 1 },
    ]);
  });

  it("is found in a value that has release characters, and the released byte is data", () => {
    const stream = splitMessages(bytesOf("UNB+UNOA:3+A'FTX+AAI+++A?+b?'C'UNZ+0+1'"));
    [...stream];
    expect(stream.issues).toHaveLength(1);
    expect(stream.issues[0]?.message).toContain('"b"');
    const clean = splitMessages(bytesOf("UNB+UNOA:3+A'FTX+AAI+++A?+?'?:C'UNZ+0+1'"));
    [...clean];
    expect(clean.issues).toEqual([]);
  });

  it("is found in the values of UNB after S001, and in the third component of S001", () => {
    const stream = splitMessages(bytesOf("UNB+UNOA:3:lower+lower'UNZ+0+1'"));
    [...stream];
    expect(stream.issues.map((i) => i.position)).toEqual([
      { segment: 1, tag: "UNB", element: 1, component: 3 },
      { segment: 1, tag: "UNB", element: 2, component: 1 },
    ]);
  });

  it("restarts at segment 1 for each interchange, however the last one ended", () => {
    const text =
      "UNB+UNOA:3+A'FTX+X+lower'UNZ+0+1'" + // ended by UNZ
      "UNB+UNOA:3+A'FTX+X+lower'" + // ended by the next UNB
      "UNB+UNOA:3+A'FTX+X+lower'" +
      "UNA:+.? 'UNB+UNOA:3+A'FTX+X+lower'"; // ended by a UNA
    const stream = splitMessages(bytesOf(text));
    [...stream];
    expect(stream.issues.map((i) => i.position.segment)).toEqual([2, 2, 2, 2]);
  });

  it("keeps the first hundred issues by default, and counts the rest", () => {
    const stream = splitMessages(bytesOf(`UNB+UNOA:3+A'${"FTX+AAI+++lower'".repeat(150)}`));
    [...stream];
    expect(stream.issues).toHaveLength(100);
    expect(stream.issueCount).toBe(150);
  });

  it("puts a release character inside a UTF-8 character out of bounds: it is a character, not a byte", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOW:4+A'FTX+AAI+++"),
      0xc3,
      0x3f,
      0xa9,
      ...bytesOf("'"),
    ]);
    const stream = splitMessages(bytes);
    [...stream];
    expect(stream.issues).toHaveLength(1);
    expect(stream.issues[0]?.message).toContain("does not continue a UTF-8 sequence");
  });

  it("allows the marks of level A as data under a UNA that does not make them separators", () => {
    // The decimal mark is a comma here, so that the point is only a mark of level A.
    const stream = splitMessages(bytesOf("UNA|{,}^~UNB{UNOA|3~FTX{AAI{{{A'B+C:D?E.F~"));
    [...stream];
    expect(stream.issues).toEqual([]);
  });
});

describe("UNOB and UNOW in the stream", () => {
  it("accept the printable range and refuse the rest", () => {
    const ok = splitMessages(bytesOf("UNB+UNOB:3+a'FTX+AAI+++lower @#$ [] {}'UNZ+0+1'"));
    [...ok];
    expect(ok.issues).toEqual([]);
    const bad = splitMessages(
      Uint8Array.from([...bytesOf("UNB+UNOB:3+a'FTX+AAI+++"), 0xe9, ...bytesOf("'")]),
    );
    [...bad];
    expect(bad.issues.map((i) => i.code)).toEqual(["INVALID_CHARACTER"]);
  });
});
