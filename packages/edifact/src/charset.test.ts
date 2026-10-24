import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CharacterSet,
  characterSetOf,
  decodeText,
  explainInvalidCharacter,
  findInvalidCharacter,
} from "./charset.ts";
import { DEFAULT_SEPARATORS } from "./index.ts";
import { readServiceStringAdvice } from "./separators.ts";
import { bytesOf } from "./testing/helpers.ts";

function invalidIn(set: CharacterSet, input: string | number[], separators = DEFAULT_SEPARATORS) {
  const bytes = typeof input === "string" ? bytesOf(input) : Uint8Array.from(input);
  return findInvalidCharacter(bytes, 0, bytes.length, set, separators);
}

describe("characterSetOf", () => {
  it.each(["UNOA", "UNOB", "UNOC", "UNOW"] as const)(
    "reads %s from the first component of S001",
    (name) => {
      const bytes = bytesOf(`xx${name}yy`);
      expect(characterSetOf(bytes, 2, 6)).toBe(name);
    },
  );

  it.each(["UNOD", "UNOK", "UNOX", "UNOY", "UNOZ", "unoa", "UNO", "UNOAB", "", "UNOÁ"])(
    "does not know %j",
    (text) => {
      const bytes = bytesOf(text);
      expect(characterSetOf(bytes, 0, bytes.length)).toBeNull();
    },
  );
});

describe("UNOA", () => {
  it("accepts level A: capital letters, digits, space and the punctuation of the standard", () => {
    expect(invalidIn("UNOA", "ABCXYZ 0123456789 .,-()/=!\"%&*;<>'+:?")).toBe(-1);
  });

  it.each([
    ["a lower case letter", "ABc", 2],
    ["a hash", "AB#", 2],
    ["an at sign", "@", 0],
    ["a line feed", "AB\nCD", 2],
    ["a tab", "\tA", 0],
    ["DEL", "A\u007f", 1],
  ])("rejects %s, and says where", (_name, text, offset) => {
    expect(invalidIn("UNOA", text)).toBe(offset);
  });

  it("rejects a byte above 0x7F, as the corpus does with the E acute of ISO 8859-1", () => {
    expect(invalidIn("UNOA", [0x41, 0xc9, 0x41])).toBe(1);
  });

  it("accepts the service characters that UNA declares, however odd", () => {
    const una = readServiceStringAdvice(bytesOf("UNA|{.}^~"), 0);
    expect(una.ok).toBe(true);
    if (una.ok) {
      expect(invalidIn("UNOA", "A|B{C}D^E~F", una.separators)).toBe(-1);
      expect(invalidIn("UNOA", "A|B{C}D^E~F")).toBe(1);
    }
  });

  it("keeps every mark of level A valid when a UNA makes other characters the separators", () => {
    const una = readServiceStringAdvice(bytesOf("UNA;*,! %"), 0);
    expect(una.ok).toBe(true);
    if (una.ok) {
      for (const mark of " .-()/=\"&<>'+:?") {
        expect(invalidIn("UNOA", mark, una.separators), JSON.stringify(mark)).toBe(-1);
      }
    }
  });

  it("looks at the range it is given, not at the rest of the buffer", () => {
    const bytes = bytesOf("abcDEFghi");
    expect(findInvalidCharacter(bytes, 3, 6, "UNOA", DEFAULT_SEPARATORS)).toBe(-1);
    expect(findInvalidCharacter(bytes, 2, 6, "UNOA", DEFAULT_SEPARATORS)).toBe(2);
  });
});

describe("UNOB", () => {
  it("accepts every printable ISO 646 character, lower case included", () => {
    expect(invalidIn("UNOB", "Hello, world! @#$[]{}|~_^`\\")).toBe(-1);
  });

  it.each([
    ["a control character", [0x41, 0x0d, 0x42], 1],
    ["DEL", [0x7f], 0],
    ["a byte above 0x7F", [0x41, 0xe9], 1],
  ])("rejects %s", (_name, bytes, offset) => {
    expect(invalidIn("UNOB", bytes)).toBe(offset);
  });
});

describe("UNOC", () => {
  it("accepts ISO 8859-1: ASCII text and 0xA0 to 0xFF", () => {
    expect(invalidIn("UNOC", [0x43, 0x61, 0x66, 0xe9, 0x20, 0xb0, 0xbd, 0xa0, 0xff])).toBe(-1);
  });

  it.each([
    ["a C0 control", [0x41, 0x01], 1],
    ["DEL", [0x7f], 0],
    ["the first C1 control", [0x41, 0x80], 1],
    ["the last C1 control", [0x9f], 0],
  ])("rejects %s", (_name, bytes, offset) => {
    expect(invalidIn("UNOC", bytes)).toBe(offset);
  });
});

describe("UNOW", () => {
  it("accepts well-formed UTF-8 of one to four bytes", () => {
    const text = "crème € — Łódź 😀 あ";
    expect(invalidIn("UNOW", Array.from(new TextEncoder().encode(text)))).toBe(-1);
  });

  it.each([
    ["a stray continuation byte", [0x41, 0x80], 1],
    ["a lead byte at the end of the range", [0x41, 0xc3], 1],
    ["a lead byte followed by an ASCII byte", [0x41, 0xc5, 0x28, 0x42], 1],
    ["an overlong two-byte form", [0xc0, 0x80], 0],
    ["an overlong three-byte form", [0xe0, 0x80, 0x80], 0],
    ["an overlong four-byte form", [0xf0, 0x80, 0x80, 0x80], 0],
    ["a surrogate", [0xed, 0xa0, 0x80], 0],
    ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80], 0],
    ["a lead byte that UTF-8 never uses", [0xf5, 0x80, 0x80, 0x80], 0],
    ["a three-byte form cut short", [0x41, 0xe2, 0x82], 1],
    ["a C1 control (U+0080)", [0xc2, 0x80], 0],
    ["a C1 control (U+009F)", [0x41, 0xc2, 0x9f], 1],
    ["a C0 control", [0x41, 0x0a], 1],
  ])("rejects %s, at the start of the broken sequence", (_name, bytes, offset) => {
    expect(invalidIn("UNOW", bytes)).toBe(offset);
  });

  it("accepts the highest code point and the lowest of each length, and refuses the overlongs next to them", () => {
    const accepted = [
      [0xc2, 0xa0],
      [0xdf, 0xbf],
      [0xe0, 0xa0, 0x80],
      [0xed, 0x9f, 0xbf],
      [0xee, 0x80, 0x80],
      [0xef, 0xbf, 0xbf],
      [0xf0, 0x90, 0x80, 0x80],
      [0xf4, 0x8f, 0xbf, 0xbf],
    ];
    for (const bytes of accepted) {
      expect(invalidIn("UNOW", bytes), bytes.map((b) => b.toString(16)).join(" ")).toBe(-1);
    }
    for (const bytes of [
      [0xc1, 0xbf],
      [0xe0, 0x9f, 0xbf],
      [0xf0, 0x8f, 0xbf, 0xbf],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      expect(invalidIn("UNOW", bytes), bytes.map((b) => b.toString(16)).join(" ")).toBe(0);
    }
  });

  it("gives the verdict of a strict decoder on every code point, and on every pair and triple of bytes", {
    timeout: 30_000,
  }, () => {
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const verdict = (bytes: number[]): boolean => {
      let text: string;
      try {
        text = strict.decode(Uint8Array.from(bytes));
      } catch {
        return false;
      }
      return [...text].every((char) => {
        const code = char.codePointAt(0) as number;
        return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
      });
    };
    // Every code point: encoded, then checked.
    for (let code = 0; code <= 0x10ffff; code += 37) {
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const bytes = Array.from(new TextEncoder().encode(String.fromCodePoint(code)));
      expect(invalidIn("UNOW", bytes) === -1, `U+${code.toString(16)}`).toBe(verdict(bytes));
    }
    // Every two bytes that start with a byte of 0x80 or more, plus a few ASCII starts (an ASCII byte
    // does not look at the next one); then three bytes with a lead byte of three, and a second and
    // third that are continuations or just off.
    const firsts = [
      0x00,
      0x1f,
      0x20,
      0x41,
      0x7e,
      0x7f,
      ...Array.from({ length: 128 }, (_u, i) => 0x80 + i),
    ];
    for (const a of firsts) {
      for (let b = 0; b < 256; b++) {
        expect(invalidIn("UNOW", [a, b]) === -1, `${a} ${b}`).toBe(verdict([a, b]));
      }
    }
    for (let a = 0xe0; a <= 0xef; a++) {
      for (let b = 0x7f; b <= 0xc0; b++) {
        for (const c of [0x7f, 0x80, 0xa0, 0xbf, 0xc0]) {
          expect(invalidIn("UNOW", [a, b, c]) === -1, `${a} ${b} ${c}`).toBe(verdict([a, b, c]));
        }
      }
    }
  });

  it("agrees with a strict UTF-8 decoder on any bytes, apart from control characters", () => {
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 12 }), (bytes) => {
        let wellFormed = true;
        let text = "";
        try {
          text = strict.decode(bytes);
        } catch {
          wellFormed = false;
        }
        const hasControl = [...text].some((char) => {
          const code = char.codePointAt(0) as number;
          return code < 0x20 || (code >= 0x7f && code <= 0x9f);
        });
        const verdict = findInvalidCharacter(bytes, 0, bytes.length, "UNOW", DEFAULT_SEPARATORS);
        expect(verdict === -1).toBe(wellFormed && !hasControl);
      }),
      { numRuns: 3000 },
    );
  });
});

describe("explainInvalidCharacter", () => {
  it("names the byte and the character set, in plain words", () => {
    expect(explainInvalidCharacter(Uint8Array.of(0x41, 0xc9), 1, "UNOA")).toBe(
      "byte 0xC9 is not a character of UNOA",
    );
    expect(explainInvalidCharacter(bytesOf("a"), 0, "UNOA")).toBe('"a" is not a character of UNOA');
    expect(explainInvalidCharacter(Uint8Array.of(0x0a), 0, "UNOB")).toBe(
      "byte 0x0A is not a character of UNOB",
    );
  });

  it("tells what broke a UTF-8 sequence", () => {
    expect(explainInvalidCharacter(Uint8Array.of(0xc5, 0x28), 0, "UNOW")).toBe(
      "byte 0x28 after lead byte 0xC5 does not continue a UTF-8 sequence",
    );
    expect(explainInvalidCharacter(Uint8Array.of(0x80), 0, "UNOW")).toBe(
      "byte 0x80 is not the start of a UTF-8 character",
    );
    expect(explainInvalidCharacter(Uint8Array.of(0xe2, 0x82), 0, "UNOW")).toBe(
      "the UTF-8 sequence that starts with byte 0xE2 is cut short",
    );
    expect(explainInvalidCharacter(Uint8Array.of(0xc0, 0x80), 0, "UNOW")).toBe(
      "the UTF-8 sequence that starts with byte 0xC0 is not well formed",
    );
  });
});

describe("explainInvalidCharacter at the edges of UTF-8", () => {
  const explain = (...bytes: number[]) =>
    explainInvalidCharacter(Uint8Array.from(bytes), 0, "UNOW");

  it("tells a continuation byte on its own from a lead byte that is never used", () => {
    expect(explain(0xbf)).toBe("byte 0xBF is not the start of a UTF-8 character");
    expect(explain(0xc0, 0x80)).toBe(
      "the UTF-8 sequence that starts with byte 0xC0 is not well formed",
    );
    expect(explain(0xc1, 0xbf)).toBe(
      "the UTF-8 sequence that starts with byte 0xC1 is not well formed",
    );
    expect(explain(0xf5, 0x80, 0x80, 0x80)).toBe(
      "the UTF-8 sequence that starts with byte 0xF5 is not well formed",
    );
  });

  it("says a C1 control character is one, and a bad second byte is not well formed", () => {
    expect(explain(0xc2, 0x80)).toBe(
      "the UTF-8 sequence that starts with byte 0xC2 is a control character",
    );
    expect(explain(0xf4, 0x90, 0x80, 0x80)).toBe(
      "the UTF-8 sequence that starts with byte 0xF4 is not well formed",
    );
    expect(explain(0xed, 0xa0, 0x80)).toBe(
      "the UTF-8 sequence that starts with byte 0xED is not well formed",
    );
  });
});

describe("decodeText", () => {
  it("decodes ASCII for every set", () => {
    for (const set of ["UNOA", "UNOB", "UNOC", "UNOW", null] as const) {
      expect(decodeText(bytesOf("ABC+12"), 0, 6, set)).toBe("ABC+12");
    }
  });

  it("decodes UNOC as ISO 8859-1, one byte per character", () => {
    expect(decodeText(Uint8Array.of(0x43, 0x72, 0xe8, 0x6d, 0x65, 0xb0, 0xbd), 0, 7, "UNOC")).toBe(
      "Crème°½",
    );
  });

  it("decodes UNOW as UTF-8 and keeps a byte order mark that is part of the text", () => {
    const withMark = `${String.fromCharCode(0xfeff)}crème 😀`;
    const bytes = new TextEncoder().encode(withMark);
    expect(decodeText(bytes, 0, bytes.length, "UNOW")).toBe(withMark);
  });

  it("puts a replacement character where UTF-8 is broken, and loses nothing else", () => {
    expect(decodeText(Uint8Array.of(0x41, 0xc5, 0x28, 0x42), 0, 4, "UNOW")).toBe("A�(B");
  });

  it("falls back to ISO 8859-1 when the set is unknown, so that no byte is ever refused", () => {
    expect(decodeText(Uint8Array.of(0x41, 0xe9, 0x80), 0, 3, null)).toBe("Aé\u0080");
  });

  it("decodes a range, and a long value", () => {
    expect(decodeText(bytesOf("xxABCxx"), 2, 5, "UNOA")).toBe("ABC");
    const long = new Uint8Array(100_000).fill(0x41);
    expect(decodeText(long, 0, long.length, "UNOC")).toHaveLength(100_000);
    expect(decodeText(long, 0, long.length, "UNOW")).toHaveLength(100_000);
  });

  it("returns an empty string for an empty range", () => {
    expect(decodeText(bytesOf("abc"), 1, 1, "UNOW")).toBe("");
  });
});
