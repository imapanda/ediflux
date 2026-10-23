import { describe, expect, it } from "vitest";
import { parseComposites, parseElements, parseSegments } from "./definitions.ts";
import { parseMessage } from "./messages.ts";
import { decodeDirectoryText, paragraph, parseRepresentation, splitEntries } from "./text.ts";

describe("decodeDirectoryText", () => {
  it("reads Latin-1, drops carriage returns and keeps the box characters as code points", () => {
    const bytes = Uint8Array.from([0x61, 0x0d, 0x0a, 0xc4, 0xbf, 0xb3, 0xc1, 0xd9]);
    expect(decodeDirectoryText(bytes)).toBe("a\n\u00c4\u00bf\u00b3\u00c1\u00d9");
  });

  it("cuts a line longer than any line of a directory file", () => {
    const text = decodeDirectoryText(Buffer.from(`${"x".repeat(100_000)}\nshort\n`));
    expect(text.split("\n").map((line) => line.length)).toEqual([200, 5, 0]);
  });
});

describe("a line made to make the patterns slow", () => {
  const spaces = " ".repeat(100_000);
  const rule = "\u00c4".repeat(30);
  const slow = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it.each([
    [
      "a data element header",
      () => parseElements(decode(`${rule}\n     1001  A${spaces}x\n`), () => {}),
    ],
    [
      "a composite header",
      () => parseComposites(decode(`${rule}\n       C001 A${spaces}x\n`), () => {}),
    ],
    [
      "a segment header",
      () => parseSegments(decode(`${rule}\n       ABC  A${spaces}x\n`), () => {}),
    ],
    [
      "a segment line of a table",
      () =>
        parseMessage(
          decode(`Message Type : ABCDEF\n4.3.1  Segment table\n0010 UNH Name${spaces}x M 1\n`),
          () => {},
        ),
    ],
    [
      "a field of the head of a message",
      () =>
        parseMessage(
          decode(`${"\n".repeat(100_000)}Message Type : ABCDEF\n4.3.1  Segment table\n`),
          () => {},
        ),
    ],
  ])("is read in well under a second: %s", (_label, run) => {
    expect(slow(run)).toBeLessThan(1000);
  });

  function decode(text: string): string {
    return decodeDirectoryText(Buffer.from(text, "latin1"));
  }
});

describe("splitEntries", () => {
  it("cuts at the lines of rules, with or without a corner, and trims blank lines", () => {
    const rule = "\u00c4".repeat(20);
    expect(splitEntries(`title\n${rule}\n\n  a\n\n${rule}\u00bf\n  b\n`)).toEqual([
      ["title"],
      ["  a"],
      ["  b"],
    ]);
  });

  it("turns a change indicator in the first column into a space", () => {
    expect(splitEntries("+    9002  Name\nX    9003  Other\n")[0]).toEqual([
      "     9002  Name",
      "     9003  Other",
    ]);
  });

  it("does not take a short run of rules for a separator", () => {
    expect(splitEntries(`a\n${"\u00c4".repeat(5)}\nb\n`)).toHaveLength(1);
  });
});

describe("paragraph", () => {
  it("stops at a blank line, a label or a line that is not indented deeper than the label", () => {
    const lines = [
      "      Desc: First line",
      "            second line",
      "010   9001 not part of it",
      "      Repr: an3",
    ];
    expect(paragraph(lines, "Desc")).toBe("First line second line");
    expect(paragraph(lines, "Function")).toBe("");
  });
});

describe("parseRepresentation", () => {
  it.each([
    ["an..35", { type: "an", minLength: 1, maxLength: 35 }],
    ["AN3", { type: "an", minLength: 3, maxLength: 3 }],
    ["n..15", { type: "n", minLength: 1, maxLength: 15 }],
    ["a1", { type: "a", minLength: 1, maxLength: 1 }],
  ])("reads %s", (text, expected) => {
    expect(parseRepresentation(text)).toEqual(expected);
  });

  it.each(["", "x3", "an..", "an..3,2", "35"])("does not read %j", (text) => {
    expect(parseRepresentation(text)).toBeUndefined();
  });
});
