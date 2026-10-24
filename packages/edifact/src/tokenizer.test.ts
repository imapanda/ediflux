import { describe, expect, it } from "vitest";
import { DEFAULT_SEPARATORS, TokenizeError, Tokenizer, TokenKind } from "./index.ts";
import { bytesOf, failure, show, tokenize } from "./testing/helpers.ts";

describe("default separators", () => {
  it("splits a segment on the default service characters when there is no UNA", () => {
    expect(show("UNB+UNOA:3+SENDER+RECEIVER'")).toEqual([
      "tag:UNB",
      "elem:+",
      "text:UNOA",
      "comp::",
      "text:3",
      "elem:+",
      "text:SENDER",
      "elem:+",
      "text:RECEIVER",
      "end:'",
    ]);
  });

  it("emits no text token for empty elements and components, only the separators", () => {
    expect(show("NAD+BY++9::X'")).toEqual([
      "tag:NAD",
      "elem:+",
      "text:BY",
      "elem:+",
      "elem:+",
      "text:9",
      "comp::",
      "comp::",
      "text:X",
      "end:'",
    ]);
  });

  it("accepts a segment with no element, and one with only empty elements", () => {
    expect(show("UNS'UNT+'")).toEqual(["tag:UNS", "end:'", "tag:UNT", "elem:+", "end:'"]);
  });

  it("treats a plain asterisk as data when no UNA declares a repetition separator", () => {
    expect(show("FTX+A*B'")).toEqual(["tag:FTX", "elem:+", "text:A*B", "end:'"]);
  });

  it("reports the default separators for the batch", () => {
    const { batches } = tokenize("UNB+A'");
    expect(batches).toEqual([DEFAULT_SEPARATORS]);
  });
});

describe("UNA", () => {
  it("is a token of its own, nine bytes long, followed by the segments", () => {
    expect(show("UNA:+.? 'UNB+A'")).toEqual([
      "una:UNA:+.? '",
      "tag:UNB",
      "elem:+",
      "text:A",
      "end:'",
    ]);
  });

  it("makes the tokenizer use the separators it declares", () => {
    expect(show("UNA;*,! %UNB*A;B%")).toEqual([
      "una:UNA;*,! %",
      "tag:UNB",
      "elem:*",
      "text:A",
      "comp:;",
      "text:B",
      "end:%",
    ]);
  });

  it("reports the declared separators for the batch", () => {
    const { batches } = tokenize("UNA;*,! %UNB*A%");
    expect(batches).toEqual([
      {
        component: 0x3b,
        element: 0x2a,
        decimalMark: 0x2c,
        release: 0x21,
        repetition: null,
        terminator: 0x25,
        declared: true,
      },
    ]);
  });

  it("treats the former service characters as data once UNA has changed them", () => {
    expect(show("UNA;*,! %FTX*A+B:C'D%")).toEqual([
      "una:UNA;*,! %",
      "tag:FTX",
      "elem:*",
      "text:A+B:C'D",
      "end:%",
    ]);
  });

  it("emits a repetition separator only when UNA declares one", () => {
    expect(show("UNA:+.?*'FTX+A*B'")).toEqual([
      "una:UNA:+.?*'",
      "tag:FTX",
      "elem:+",
      "text:A",
      "rep:*",
      "text:B",
      "end:'",
    ]);
  });

  it("is accepted in the middle of a file, where it starts a new interchange", () => {
    const { tokens, batches, error } = tokenize("UNB+A'UNZ+1+A'UNA;*,! %UNB*B%UNZ*1*B%");
    expect(error).toBeNull();
    expect(tokens.filter((t) => t.kind === TokenKind.ServiceStringAdvice)).toHaveLength(1);
    expect(batches.map((separators) => separators.element)).toEqual([0x2b, 0x2a]);
  });

  it("is never mixed with another set of separators in one batch", () => {
    const { batches } = tokenize("UNB+A'UNZ+1+A'UNA;*,! %UNB*B%UNZ*1*B%UNB+C'", 1024);
    // Defaults, then the declared set, then the defaults again after the second UNZ.
    expect(batches.map((s) => [s.element, s.declared])).toEqual([
      [0x2b, false],
      [0x2a, true],
      [0x2b, false],
    ]);
  });

  it("starts a new batch at a UNA string even when no UNZ came before it", () => {
    const { batches, tokens, error } = tokenize("UNB+A'FTX+B'UNA;*,! %UNB*C%", 1024);
    expect(error).toBeNull();
    expect(batches.map((s) => [s.element, s.declared])).toEqual([
      [0x2b, false],
      [0x2a, true],
    ]);
    expect(tokens.map((t) => t.kind)).toContain(TokenKind.ServiceStringAdvice);
  });

  it("falls back to the default separators after UNZ", () => {
    expect(show("UNA;*,! %UNB*A%UNZ*1*A%UNB+B'")).toEqual([
      "una:UNA;*,! %",
      "tag:UNB",
      "elem:*",
      "text:A",
      "end:%",
      "tag:UNZ",
      "elem:*",
      "text:1",
      "elem:*",
      "text:A",
      "end:%",
      "tag:UNB",
      "elem:+",
      "text:B",
      "end:'",
    ]);
  });

  it("rejects a malformed string with INVALID_UNA at segment 0, UNA", () => {
    const error = failure("UNA::.? 'UNB+A'");
    expect(error).toBeInstanceOf(TokenizeError);
    expect(error).toMatchObject({
      code: "INVALID_UNA",
      offset: 4,
      line: 1,
      column: 5,
      segment: 0,
      tag: "UNA",
    });
    expect(error.message).toContain("component separator and the element separator");
    expect(error.message).toContain("line 1, column 5");
  });

  it("reports a string cut off by the end of the file like any other cut: UNEXPECTED_END_OF_FILE", () => {
    for (const cut of ["UNA", "UNA:", "UNA:+.", "UNA:+.? "]) {
      expect(failure(cut), cut).toMatchObject({
        code: "UNEXPECTED_END_OF_FILE",
        segment: 0,
        tag: "UNA",
        offset: cut.length,
      });
    }
  });

  it("is read again without a new batch when a file repeats the same string", () => {
    const text = "UNA:+.? 'UNB+A'UNA:+.? 'UNB+B'UNA:+.? 'UNB+C'";
    const { batches, tokens } = tokenize(text);
    expect(batches).toHaveLength(1);
    expect(tokens.filter((t) => t.kind === TokenKind.ServiceStringAdvice)).toHaveLength(3);
    // The same default characters, but declared for the first time in this interchange: a new batch.
    expect(tokenize("UNB+A'UNA:+.? 'UNB+B'").batches.map((s) => s.declared)).toEqual([false, true]);
  });

  it("does not turn a long run of repeated strings into a long run of batches", () => {
    // 10,000 tokens fill three batches of 4096 and no more: the repeated string never ends a batch.
    const { batches } = tokenize("UNA;*,! %".repeat(10_000));
    expect(batches).toHaveLength(3);
  });

  it("counts the segments of each interchange from 1, so a mistake is located within its own", () => {
    expect(failure("UNB+A'UNZ+1+A'bad'")).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      segment: 1,
    });
    expect(failure("UNB+A'UNH+1'UNA:+.? 'bad'")).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      segment: 1,
    });
    expect(failure("UNB+A'UNH+1'bad'")).toMatchObject({ code: "INVALID_SEGMENT_TAG", segment: 3 });
  });
});

describe("release character", () => {
  it("keeps an escaped separator inside the text and flags the text as escaped", () => {
    expect(show("FTX+A?+B?:C?'D'")).toEqual(["tag:FTX", "elem:+", "esc:A?+B?:C?'D", "end:'"]);
  });

  it("keeps the release character itself when it is released", () => {
    expect(show("FTX+A??B+C'")).toEqual([
      "tag:FTX",
      "elem:+",
      "esc:A??B",
      "elem:+",
      "text:C",
      "end:'",
    ]);
  });

  it("lets a released terminator continue the segment", () => {
    expect(show("FTX+A?'B'FTX+C'")).toEqual([
      "tag:FTX",
      "elem:+",
      "esc:A?'B",
      "end:'",
      "tag:FTX",
      "elem:+",
      "text:C",
      "end:'",
    ]);
  });

  it("uses the release character the UNA declares, and a plain ? is then data", () => {
    expect(show("UNA:+.! 'FTX+A!+B?C'")).toEqual([
      "una:UNA:+.! '",
      "tag:FTX",
      "elem:+",
      "esc:A!+B?C",
      "end:'",
    ]);
  });

  it("releases a byte that is not a service character: the pair is still escaped text", () => {
    expect(show("FTX+A?BC'")).toEqual(["tag:FTX", "elem:+", "esc:A?BC", "end:'"]);
  });

  it("releases a line break like any other byte: it is data, and the next separator still splits", () => {
    expect(show("FTX+A?\n+B'")).toEqual([
      "tag:FTX",
      "elem:+",
      "esc:A?\n",
      "elem:+",
      "text:B",
      "end:'",
    ]);
  });
});

describe("line breaks", () => {
  const plain = ["tag:UNB", "elem:+", "text:A", "end:'", "tag:UNH", "elem:+", "text:1", "end:'"];

  it.each([
    ["LF", "\n"],
    ["CR LF", "\r\n"],
    ["CR", "\r"],
    ["several, mixed", "\r\n\n\r"],
  ])("are skipped between segments (%s)", (_name, linebreak) => {
    expect(show(`UNB+A'${linebreak}UNH+1'${linebreak}`)).toEqual(plain);
  });

  it("are skipped before the first segment and after UNA", () => {
    expect(show("\r\nUNA:+.? '\r\nUNB+A'")).toEqual([
      "una:UNA:+.? '",
      "tag:UNB",
      "elem:+",
      "text:A",
      "end:'",
    ]);
  });

  it("leave tokens whose offsets skip exactly the line break", () => {
    const { tokens } = tokenize("UNB+A'\r\nUNH+1'");
    const tag = tokens.filter((t) => t.kind === TokenKind.SegmentTag);
    expect(tag.map((t) => [t.start, t.end])).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("are data inside a segment, left for the character set check to judge", () => {
    expect(show("FTX+A\r\nB'")).toEqual(["tag:FTX", "elem:+", "text:A\r\nB", "end:'"]);
  });

  it("tolerate a UTF-8 byte order mark at the very start", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("UNB+A'")]);
    const { tokens, error } = tokenize(bytes);
    expect(error).toBeNull();
    expect(tokens[0]).toEqual({ kind: TokenKind.SegmentTag, start: 3, end: 6 });
  });

  it("do not mistake a partial byte order mark for one", () => {
    expect(failure(new Uint8Array([0xef, 0xbb, 0x55, 0x4e, 0x42]))).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      offset: 0,
    });
    expect(failure(new Uint8Array([0xef]))).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      offset: 0,
    });
    // A byte order mark anywhere but the start is not a byte order mark.
    expect(failure(new Uint8Array([...bytesOf("UNB+A'"), 0xef, 0xbb, 0xbf]))).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      offset: 6,
      segment: 2,
    });
  });

  it("produce no tokens for an empty file or one with only line breaks and a BOM", () => {
    expect(show("")).toEqual([]);
    expect(show("\r\n\n")).toEqual([]);
    expect(tokenize(new Uint8Array([0xef, 0xbb, 0xbf, 0x0a])).tokens).toEqual([]);
  });
});

describe("segment tags", () => {
  it("accept three capital letters or digits", () => {
    expect(show("A1Z+X'")).toEqual(["tag:A1Z", "elem:+", "text:X", "end:'"]);
  });

  it.each([
    ["lower case", "unb+A'", 0, "u"],
    ["too short", "UN+A'", 2, "+"],
    ["too long", "UNBX+A'", 3, "X"],
    ["a separator first", "+A'", 0, "+"],
    ["a space first", " UNB+A'", 0, " "],
    ["a component separator after the tag", "UNB:A'", 3, ":"],
  ])("reject %s with INVALID_SEGMENT_TAG at the offending byte", (_name, input, offset, found) => {
    const error = failure(input);
    expect(error).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      offset,
      line: 1,
      column: offset + 1,
      segment: 1,
      tag: null,
    });
    expect(error.message).toContain(`"${found}"`);
  });

  it("number the segment that is wrong, counting the ones before it", () => {
    expect(failure("UNB+A'UNH+1'bad+x'")).toMatchObject({
      code: "INVALID_SEGMENT_TAG",
      segment: 3,
      offset: 12,
    });
  });
});

describe("truncated files", () => {
  it("fail with UNEXPECTED_END_OF_FILE, naming the segment, its number and the position", () => {
    const text = "UNB+A'\nUNH+1'\nNAD+BY+952";
    const error = failure(text);
    expect(error).toMatchObject({
      code: "UNEXPECTED_END_OF_FILE",
      segment: 3,
      tag: "NAD",
      offset: text.length,
      line: 3,
      column: 11,
    });
    expect(error.message).toContain("NAD");
    expect(error.message).toContain("segment 3");
    expect(error.message).toContain("line 3, column 11");
  });

  it("fail when the file ends right after a tag", () => {
    expect(failure("UNB")).toMatchObject({
      code: "UNEXPECTED_END_OF_FILE",
      segment: 1,
      tag: "UNB",
    });
  });

  it("fail when the file ends inside a tag", () => {
    expect(failure("UNB+A'UN")).toMatchObject({
      code: "UNEXPECTED_END_OF_FILE",
      segment: 2,
      tag: "UN",
    });
  });

  it("fail when the file ends after a release character", () => {
    const error = failure("FTX+A?");
    expect(error).toMatchObject({ code: "UNEXPECTED_END_OF_FILE", segment: 1, tag: "FTX" });
    expect(error.message).toContain("release character");
  });

  it("fail when the last terminator is released", () => {
    expect(failure("FTX+A?'")).toMatchObject({ code: "UNEXPECTED_END_OF_FILE" });
  });

  it("deliver every complete token before the error, then throw; never half a value", () => {
    const { tokens, error } = tokenize("UNB+A'UNH+1");
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.SegmentTag,
      TokenKind.ElementSeparator,
      TokenKind.Text,
      TokenKind.SegmentTerminator,
      TokenKind.SegmentTag,
      TokenKind.ElementSeparator,
    ]);
    expect(error?.code).toBe("UNEXPECTED_END_OF_FILE");
  });

  it("never echo a raw control byte in the message", () => {
    const error = failure(new Uint8Array([0x55, 0x4e, 0x42, 0x01]));
    expect([...error.message].every((c) => (c.codePointAt(0) as number) >= 0x20)).toBe(true);
    expect(error.message).toContain("0x01");
  });
});

describe("batches", () => {
  const input = "UNA:+.? 'UNB+A:B+C?+D'UNH+1'FTX+X??Y'UNT+2+1'UNZ+1+A'";

  it.each([2, 3, 4, 7, 100])("give the same tokens with a capacity of %i", (capacity) => {
    expect(tokenize(input, capacity).tokens).toEqual(tokenize(input).tokens);
  });

  it("split a long file into several batches of at most the requested size", () => {
    const tokenizer = new Tokenizer(bytesOf(input), { batchSize: 5 });
    const sizes: number[] = [];
    for (const batch of tokenizer) {
      sizes.push(batch.length);
    }
    expect(sizes.length).toBeGreaterThan(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
  });

  it("reuse one batch object, so a consumer must not keep it", () => {
    const tokenizer = new Tokenizer(bytesOf(input), { batchSize: 5 });
    const seen = new Set<unknown>();
    for (const batch of tokenizer) {
      seen.add(batch);
    }
    expect(seen.size).toBe(1);
  });

  it("reject a batch size that is not an integer of at least 2", () => {
    for (const batchSize of [0, 1, 2.5, Number.NaN, -3]) {
      expect(() => new Tokenizer(new Uint8Array(0), { batchSize })).toThrow(RangeError);
    }
  });

  it("continue where they stopped when iterated again", () => {
    const bytes = bytesOf(input);
    const tokenizer = new Tokenizer(bytes, { batchSize: 4 });
    let count = 0;
    for (const batch of tokenizer) {
      count += batch.length;
      break;
    }
    for (const batch of tokenizer) {
      count += batch.length;
    }
    expect(count).toBe(tokenize(bytes).tokens.length);
  });
});

describe("iteration", () => {
  const input = "UNB+A'UNH+1'UNT+2+1'";

  it("refuses a second loop while the first is still running: they would share one batch", () => {
    const tokenizer = new Tokenizer(bytesOf(input), { batchSize: 4 });
    const first = tokenizer[Symbol.iterator]();
    first.next();
    expect(() => tokenizer[Symbol.iterator]().next()).toThrow(/already being iterated/);
    first.return();
    // Once the first loop has stopped, the next one carries on.
    expect(() => tokenizer[Symbol.iterator]().next()).not.toThrow();
  });

  it("allows a new loop after the first one failed", () => {
    const tokenizer = new Tokenizer(bytesOf("UNB+A'bad'"));
    expect(() => [...tokenizer].length).toThrow(TokenizeError);
    expect(() => [...tokenizer].length).toThrow(TokenizeError);
  });

  it("yields nothing when the end has been reached", () => {
    const tokenizer = new Tokenizer(bytesOf(input));
    expect([...tokenizer].length).toBeGreaterThan(0);
    expect([...tokenizer]).toEqual([]);
  });

  it("does not throw the error to a loop that stops before it", () => {
    const tokenizer = new Tokenizer(bytesOf("UNB+A'UNH+1"), { batchSize: 2 });
    for (const _batch of tokenizer) {
      break;
    }
    expect(() => [...tokenizer]).toThrow(TokenizeError);
  });
});

describe("errors in a large file", () => {
  it("are positioned by a scan, so that a file of line breaks costs no index", () => {
    const lines = 300_000;
    const error = failure(`${"\n".repeat(lines)}x`);
    expect(error).toMatchObject({ code: "INVALID_SEGMENT_TAG", line: lines + 1, column: 1 });
  });
});

describe("constructor", () => {
  it.each([
    ["an ArrayBuffer", () => new ArrayBuffer(8)],
    ["a DataView", () => new DataView(new ArrayBuffer(8))],
    ["an Int8Array", () => new Int8Array(8)],
    ["a Uint8ClampedArray", () => new Uint8ClampedArray(8)],
    ["a Uint16Array", () => new Uint16Array(8)],
    ["a string", () => "UNB+A'"],
    ["null", () => null],
  ])("rejects %s with a TypeError instead of spinning forever", (_name, make) => {
    expect(() => new Tokenizer(make() as unknown as Uint8Array)).toThrow(TypeError);
  });

  it("accepts a Node.js Buffer", () => {
    expect(tokenize(Buffer.from("UNB+A'")).tokens).toHaveLength(4);
  });

  it("rejects a batch size above the maximum", () => {
    expect(() => new Tokenizer(new Uint8Array(0), { batchSize: (1 << 20) + 1 })).toThrow(
      RangeError,
    );
    expect(() => new Tokenizer(new Uint8Array(0), { batchSize: 1 << 20 })).not.toThrow();
  });

  it("rejects an input that 32-bit offsets cannot address", () => {
    const huge = new Uint8Array(0);
    Object.defineProperty(huge, "length", { value: 0x8000_0000 });
    expect(() => new Tokenizer(huge)).toThrow(RangeError);
  });

  it("accepts a view on a larger buffer and reports offsets relative to the view", () => {
    const buffer = bytesOf("xxxUNB+A'yyy");
    const { tokens } = tokenize(buffer.subarray(3, 9));
    expect(tokens[0]).toEqual({ kind: TokenKind.SegmentTag, start: 0, end: 3 });
    expect(tokens).toHaveLength(4);
  });
});

describe("locate", () => {
  const text = "UNB+A'\r\nUNH+1'\nFTX+B'\rUNT+3'";
  const tokenizer = new Tokenizer(bytesOf(text));

  it("gives a 1-based line and a 1-based column counted in bytes", () => {
    expect(tokenizer.locate(0)).toEqual({ line: 1, column: 1 });
    expect(tokenizer.locate(5)).toEqual({ line: 1, column: 6 });
    expect(tokenizer.locate(8)).toEqual({ line: 2, column: 1 });
    expect(tokenizer.locate(15)).toEqual({ line: 3, column: 1 });
    expect(tokenizer.locate(21)).toEqual({ line: 3, column: 7 });
    expect(tokenizer.locate(22)).toEqual({ line: 4, column: 1 });
    expect(tokenizer.locate(text.length)).toEqual({ line: 4, column: 7 });
  });

  it("counts CR LF as one line break and a lone CR as one", () => {
    expect(tokenizer.locate(7)).toEqual({ line: 1, column: 8 });
    expect(tokenizer.locate(20)).toEqual({ line: 3, column: 6 });
  });

  it("rejects an offset outside the input", () => {
    expect(() => tokenizer.locate(-1)).toThrow(RangeError);
    expect(() => tokenizer.locate(text.length + 1)).toThrow(RangeError);
    expect(() => tokenizer.locate(1.5)).toThrow(RangeError);
  });

  it("counts the bytes of a byte order mark in the column of the first line", () => {
    const withBom = new Tokenizer(new Uint8Array([0xef, 0xbb, 0xbf, 0x55]));
    expect(withBom.locate(3)).toEqual({ line: 1, column: 4 });
  });
});
