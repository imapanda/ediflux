import { describe, expect, it } from "vitest";
import { describeByte } from "./errors.ts";
import { DEFAULT_SEPARATORS } from "./index.ts";
import { matchesServiceString, readServiceStringAdvice } from "./separators.ts";
import { bytesOf } from "./testing/helpers.ts";

function read(text: string) {
  return readServiceStringAdvice(bytesOf(text), 0);
}

describe("DEFAULT_SEPARATORS", () => {
  it("are the characters of the standard: colon, plus, point, question mark, apostrophe", () => {
    expect(DEFAULT_SEPARATORS).toEqual({
      component: 0x3a,
      element: 0x2b,
      decimalMark: 0x2e,
      release: 0x3f,
      repetition: null,
      terminator: 0x27,
      declared: false,
    });
  });
});

describe("readServiceStringAdvice", () => {
  it("reads the usual syntax 3 string, whose repetition position is a reserved space", () => {
    expect(read("UNA:+.? '")).toEqual({
      ok: true,
      separators: { ...DEFAULT_SEPARATORS, declared: true },
    });
  });

  it("reads the usual syntax 4 string with the asterisk as repetition separator", () => {
    const result = read("UNA:+.?*'");
    expect(result).toEqual({
      ok: true,
      separators: { ...DEFAULT_SEPARATORS, repetition: 0x2a, declared: true },
    });
  });

  it("reads a string with every service character changed", () => {
    expect(read("UNA;*,! %")).toEqual({
      ok: true,
      separators: {
        component: 0x3b,
        element: 0x2a,
        decimalMark: 0x2c,
        release: 0x21,
        repetition: null,
        terminator: 0x25,
        declared: true,
      },
    });
  });

  it("reads the string wherever it starts and ignores what follows", () => {
    const bytes = bytesOf("xxUNA:+.? 'UNB+");
    expect(readServiceStringAdvice(bytes, 2)).toEqual({
      ok: true,
      separators: { ...DEFAULT_SEPARATORS, declared: true },
    });
  });

  it("rejects a component separator that is also the element separator", () => {
    expect(read("UNA::.? '")).toMatchObject({
      ok: false,
      offset: 4,
      reason: expect.stringContaining("component separator and the element separator are both"),
    });
  });

  it("names the two roles when any service characters are the same", () => {
    expect(read("UNA:+.?:'")).toMatchObject({
      ok: false,
      offset: 7,
      reason: 'the component separator and the repetition separator are both ":"',
    });
    expect(read("UNA:+.?+'")).toMatchObject({ ok: false, offset: 7 });
    expect(read("UNA:+.??'")).toMatchObject({ ok: false, offset: 7 });
    expect(read("UNA:+.? ?")).toMatchObject({ ok: false, offset: 8 });
    expect(read("UNA:+.. '")).toMatchObject({
      ok: false,
      offset: 6,
      reason: 'the decimal mark and the release character are both "."',
    });
  });

  it("rejects a decimal mark that is neither a point nor a comma", () => {
    expect(read("UNA:+;? '")).toMatchObject({
      ok: false,
      offset: 5,
      reason: expect.stringContaining("decimal mark"),
    });
  });

  it("rejects service characters that are letters, digits, spaces or control characters", () => {
    expect(read("UNAA+.? '")).toMatchObject({ ok: false, offset: 3 });
    expect(read("UNA:5.? '")).toMatchObject({ ok: false, offset: 4 });
    expect(read("UNA: .? '")).toMatchObject({ ok: false, offset: 4 });
    expect(read("UNA:+.\n '")).toMatchObject({ ok: false, offset: 6 });
    expect(read("UNA:+.? \n")).toMatchObject({ ok: false, offset: 8 });
    expect(read("UNA:+.?a'")).toMatchObject({ ok: false, offset: 7 });
  });

  it("rejects a string that is not plain ASCII", () => {
    const bytes = new Uint8Array([0x55, 0x4e, 0x41, 0x3a, 0x2b, 0x2e, 0x3f, 0x20, 0xe9]);
    expect(readServiceStringAdvice(bytes, 0)).toMatchObject({ ok: false, offset: 8 });
  });

  it("rejects a string that is cut off, and says how much is missing", () => {
    expect(read("UNA:+.")).toEqual({
      ok: false,
      offset: 6,
      reason: "only 6 of the 9 bytes it needs are left",
      truncated: true,
    });
    expect(read("UNA")).toMatchObject({ ok: false, offset: 3, truncated: true });
  });

  it("describes unprintable offenders by their byte value, never raw", () => {
    const result = read("UNA:+.\u0001 '");
    expect(result).toMatchObject({ ok: false, offset: 6 });
    expect(JSON.stringify(result)).toContain("byte 0x01");
  });

  it("rejects DEL and bytes above 0x7E, which are not punctuation", () => {
    expect(read("UNA:+.\u007f '")).toMatchObject({ ok: false, offset: 6 });
    expect(describeByte(0x7f)).toBe("byte 0x7F");
    expect(describeByte(0x20)).toBe('" "');
    expect(describeByte(0xe9)).toBe("byte 0xE9");
  });

  it("returns frozen separators, and the one shared set for the usual default string", () => {
    const usual = read("UNA:+.? '");
    const other = read("UNA;*,! %");
    expect(usual.ok && Object.isFrozen(usual.separators)).toBe(true);
    expect(other.ok && Object.isFrozen(other.separators)).toBe(true);
    const again = read("UNA:+.? '");
    expect(usual.ok && again.ok && usual.separators === again.separators).toBe(true);
  });
});

describe("matchesServiceString", () => {
  const custom = read("UNA;*,! %");

  it("is true for the very string that was read, wherever it sits", () => {
    expect(custom.ok).toBe(true);
    if (custom.ok) {
      expect(matchesServiceString(bytesOf("UNA;*,! %"), 0, custom.separators)).toBe(true);
      expect(matchesServiceString(bytesOf("xxUNA;*,! %"), 2, custom.separators)).toBe(true);
    }
  });

  it("is false when any of the six characters differs", () => {
    if (custom.ok) {
      for (const other of [
        "UNA:*,! %",
        "UNA;+,! %",
        "UNA;*.! %",
        "UNA;*,? %",
        "UNA;*,!*%",
        "UNA;*,! '",
      ]) {
        expect(matchesServiceString(bytesOf(other), 0, custom.separators), other).toBe(false);
      }
    }
  });
});
