import { describe, expect, it } from "vitest";
import { unescapeValue } from "./index.ts";
import { bytesOf, textOf } from "./testing/helpers.ts";

const RELEASE = 0x3f; // "?"

function unescaped(text: string, start = 0, end = text.length): string {
  return textOf(unescapeValue(bytesOf(text), start, end, RELEASE));
}

describe("unescapeValue", () => {
  it("returns a plain value unchanged, as a copy", () => {
    const bytes = bytesOf("ABC");
    const copy = unescapeValue(bytes, 0, 3, RELEASE);
    expect(textOf(copy)).toBe("ABC");
    copy[0] = 0;
    expect(textOf(bytes)).toBe("ABC");
  });

  it("drops the release character and keeps the byte it releases", () => {
    expect(unescaped("A?+B?:C?'D")).toBe("A+B:C'D");
  });

  it("keeps a released release character", () => {
    expect(unescaped("A??B")).toBe("A?B");
    expect(unescaped("????")).toBe("??");
  });

  it("handles only the range it is given", () => {
    expect(unescaped("xx?+yy", 2, 4)).toBe("+");
    expect(unescaped("xx?+yy", 4, 6)).toBe("yy");
  });

  it("keeps a lone release character at the end of the range: nothing is left to release", () => {
    expect(unescaped("AB?")).toBe("AB?");
  });

  it("returns an empty value for an empty range", () => {
    expect(unescaped("abc", 1, 1)).toBe("");
  });
});
