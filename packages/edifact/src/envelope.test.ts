import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatIssue, type ValidationIssue, validate } from "./index.ts";
import { bytesOf } from "./testing/helpers.ts";

/** A control character in a text that is meant for a person. */
const hasControl = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0) as number;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

/** An interchange from its segments, one per line. */
const file = (...segments: string[]): string => `${segments.map((s) => `${s}'`).join("\n")}\n`;

const UNB = "UNB+UNOA:3+SENDER:14+RECEIVER:14+301015:0830+REF1";
const UNH = "UNH+1+ORDERS:D:96A:UN";
const BGM = "BGM+220+PO1+9";

const codes = (text: string) =>
  validate(bytesOf(text)).issues.map((issue) => [issue.code, issue.position.segment] as const);

const only = (text: string): ValidationIssue => {
  const { issues } = validate(bytesOf(text));
  expect(issues).toHaveLength(1);
  return issues[0] as ValidationIssue;
};

describe("a sound interchange", () => {
  it("has no issue, with one message or several, in a group or not", () => {
    expect(codes(file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1"))).toEqual([]);
    expect(
      codes(file(UNB, UNH, BGM, "UNT+3+1", "UNH+2+ORDERS:D:96A:UN", BGM, "UNT+3+2", "UNZ+2+REF1")),
    ).toEqual([]);
    expect(
      codes(
        file(
          UNB,
          "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A",
          UNH,
          BGM,
          "UNT+3+1",
          "UNH+2+ORDERS:D:96A:UN",
          BGM,
          "UNT+3+2",
          "UNE+2+G1",
          "UNZ+1+REF1",
        ),
      ),
    ).toEqual([]);
  });

  it("accepts syntax version 4 and several interchanges in one file", () => {
    const v4 = file("UNB+UNOA:4+A:14+B:14+301015:0830+R4", UNH, BGM, "UNT+3+1", "UNZ+1+R4");
    expect(codes(v4)).toEqual([]);
    const both = file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1") + v4;
    const report = validate(bytesOf(both));
    expect(report.issues).toEqual([]);
    expect(report.interchangeCount).toBe(2);
    expect(report.messageCount).toBe(2);
  });
});

describe("counts and references", () => {
  it("UNT: segments counted from UNH to UNT, and the message reference of UNH", () => {
    expect(codes(file(UNB, UNH, BGM, "UNT+4+1", "UNZ+1+REF1"))).toEqual([
      ["UNT_COUNT_MISMATCH", 4],
    ]);
    expect(codes(file(UNB, UNH, BGM, "UNT+2+1", "UNZ+1+REF1"))).toEqual([
      ["UNT_COUNT_MISMATCH", 4],
    ]);
    expect(codes(file(UNB, UNH, BGM, "UNT+3+2", "UNZ+1+REF1"))).toEqual([
      ["UNT_REFERENCE_MISMATCH", 4],
    ]);
    const issue = only(file(UNB, UNH, BGM, "UNT+4+1", "UNZ+1+REF1"));
    expect(issue.expected).toBe("3");
    expect(issue.found).toBe("4");
    expect(issue.message).toBe(
      "UNT gives the number of segments as 4, but the message has 3 (UNH and UNT included).",
    );
    expect(issue.layer).toBe("envelope");
    expect(issue.position).toEqual({
      segment: 4,
      tag: "UNT",
      element: 1,
      component: null,
      repetition: null,
    });
  });

  it("UNZ: messages counted, or groups when there are some, and the interchange reference", () => {
    expect(codes(file(UNB, UNH, BGM, "UNT+3+1", "UNZ+2+REF1"))).toEqual([
      ["UNZ_COUNT_MISMATCH", 5],
    ]);
    expect(codes(file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+OTHER"))).toEqual([
      ["UNZ_REFERENCE_MISMATCH", 5],
    ]);
    const grouped = file(
      UNB,
      "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A",
      UNH,
      BGM,
      "UNT+3+1",
      "UNE+1+G1",
      "UNZ+1+REF1",
    );
    expect(codes(grouped)).toEqual([]);
    const miscounted = grouped.replace("UNZ+1+", "UNZ+3+");
    const issue = only(miscounted);
    expect(issue.code).toBe("UNZ_COUNT_MISMATCH");
    expect(issue.message).toBe(
      "UNZ gives the number of groups in the interchange as 3, but it has 1.",
    );
  });

  it("UNE: messages of the group, and the reference of UNG", () => {
    const group = (une: string) =>
      file(
        UNB,
        "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A",
        UNH,
        BGM,
        "UNT+3+1",
        une,
        "UNZ+1+REF1",
      );
    expect(codes(group("UNE+1+G1"))).toEqual([]);
    expect(codes(group("UNE+2+G1"))).toEqual([["UNE_COUNT_MISMATCH", 6]]);
    expect(codes(group("UNE+1+G2"))).toEqual([["UNE_REFERENCE_MISMATCH", 6]]);
  });

  it("a count that is not a whole number is a data type error, not a count error", () => {
    const issue = only(file(UNB, UNH, BGM, "UNT+THREE+1", "UNZ+1+REF1"));
    expect(issue.code).toBe("INVALID_DATA_TYPE");
    expect(issue.layer).toBe("envelope");
    expect(issue.position).toMatchObject({ segment: 4, tag: "UNT", element: 1, component: null });
    expect(issue.found).toBe("THREE");
  });

  it.each(["A3", "3A", "-3", "3.5", " 3", "3 "])("a count of %j is not a whole number", (count) => {
    const issue = only(file(UNB, UNH, BGM, `UNT+${count}+1`, "UNZ+1+REF1"));
    expect(issue.code).toBe("INVALID_DATA_TYPE");
  });

  it("shows the beginning of a count that is a long text", () => {
    const issue = only(file(UNB, UNH, BGM, `UNT+${"X".repeat(60)}+1`, "UNZ+1+REF1"));
    expect(issue.found).toBe(`${"X".repeat(32)}...`);
  });

  it("compares numbers as numbers: 03 is 3", () => {
    expect(codes(file(UNB, UNH, BGM, "UNT+03+1", "UNZ+01+REF1"))).toEqual([]);
  });
});

describe("mandatory envelope data", () => {
  it.each([
    [
      "UNB+UNOA:3+SENDER:14+RECEIVER:14+301015:0830",
      "UNB",
      5,
      null,
      "interchange control reference",
    ],
    ["UNB+UNOA:3+SENDER:14+RECEIVER:14+301015+REF1", "UNB", 4, 2, "time of preparation"],
    ["UNB+UNOA:3+:14+RECEIVER:14+301015:0830+REF1", "UNB", 2, 1, "sender identification"],
    ["UNB+UNOA:3+SENDER:14++301015:0830+REF1", "UNB", 3, null, "recipient"],
    ["UNB+UNOA:3+SENDER:14+RECEIVER:14++REF1", "UNB", 4, null, "date and time of preparation"],
  ])("%s lacks a mandatory element", (unb, tag, element, component, name) => {
    const issue = only(file(unb, UNH, BGM, "UNT+3+1", "UNZ+1+REF1"));
    expect(issue.code).toBe("MISSING_MANDATORY_ELEMENT");
    expect(issue.layer).toBe("envelope");
    expect(issue.position).toMatchObject({ segment: 1, tag, element, component });
    expect(issue.expected).toBe(name);
  });

  it("UNH, UNT, UNZ, UNG and UNE are checked too", () => {
    expect(codes(file(UNB, "UNH+1+ORDERS:D:96A", BGM, "UNT+3+1", "UNZ+1+REF1"))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 2],
    ]);
    expect(codes(file(UNB, UNH, BGM, "UNT+3", "UNZ+1+REF1"))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 4],
    ]);
    expect(codes(file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1"))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 5],
    ]);
    const noTime = only(
      file(
        UNB,
        "UNG+ORDERS+A:14+B:14+301015+G1+UN+D:96A",
        UNH,
        BGM,
        "UNT+3+1",
        "UNE+1+G1",
        "UNZ+1+REF1",
      ),
    );
    expect(noTime.position).toMatchObject({ segment: 2, tag: "UNG", element: 4, component: 2 });
    const ung = file(
      UNB,
      "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN",
      UNH,
      BGM,
      "UNT+3+1",
      "UNE+1+G1",
      "UNZ+1+REF1",
    );
    // The whole composite for the message version is missing: one issue, not one per component.
    const missingVersion = only(ung);
    expect(missingVersion.position).toMatchObject({
      segment: 2,
      tag: "UNG",
      element: 7,
      component: null,
    });
    expect(missingVersion.expected).toBe("message version");
    expect(codes(ung.replace("UNE+1+G1", "UNE+1"))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 2],
      ["MISSING_MANDATORY_ELEMENT", 6],
    ]);
  });
});

describe("the syntax version", () => {
  it.each(["1", "2", "5", "9", "X"])("%s is not supported", (version) => {
    const issue = only(file(UNB.replace(":3", `:${version}`), UNH, BGM, "UNT+3+1", "UNZ+1+REF1"));
    expect(issue.code).toBe("UNSUPPORTED_SYNTAX_VERSION");
    expect(issue.found).toBe(version);
    expect(issue.expected).toBe("3 or 4");
    expect(issue.position).toMatchObject({ segment: 1, tag: "UNB", element: 1, component: 2 });
  });

  it("an empty version is missing data, not an unsupported one", () => {
    expect(codes(file(UNB.replace(":3", ":"), UNH, BGM, "UNT+3+1", "UNZ+1+REF1"))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 1],
    ]);
  });
});

describe("a missing envelope segment", () => {
  it("UNT: the message runs into the next one, and the position is the segment that interrupted", () => {
    const issues = validate(
      bytesOf(file(UNB, UNH, BGM, "UNH+2+ORDERS:D:96A:UN", BGM, "UNT+3+2", "UNZ+2+REF1")),
    ).issues;
    expect(issues.map((i) => [i.code, i.position.segment, i.expected])).toEqual([
      ["MISSING_ENVELOPE_SEGMENT", 4, "UNT"],
    ]);
  });

  it("UNZ: a file that stops after its last message has no UNZ, at the segment after the last", () => {
    const issue = only(file(UNB, UNH, BGM, "UNT+3+1"));
    expect(issue.code).toBe("MISSING_ENVELOPE_SEGMENT");
    expect(issue.expected).toBe("UNZ");
    expect(issue.position).toMatchObject({ segment: 5, tag: null });
  });

  it("UNE: a group closed by UNZ, or by the next UNG", () => {
    const ung = "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A";
    const closedByUnz = validate(bytesOf(file(UNB, ung, UNH, BGM, "UNT+3+1", "UNZ+1+REF1"))).issues;
    expect(closedByUnz.map((i) => [i.code, i.position.segment, i.expected])).toEqual([
      ["MISSING_ENVELOPE_SEGMENT", 6, "UNE"],
    ]);
    const closedByUng = validate(
      bytesOf(
        file(UNB, ung, UNH, BGM, "UNT+3+1", ung.replace("G1", "G2"), "UNE+0+G2", "UNZ+2+REF1"),
      ),
    ).issues;
    expect(closedByUng.map((i) => [i.code, i.position.segment, i.expected])).toEqual([
      ["MISSING_ENVELOPE_SEGMENT", 6, "UNE"],
    ]);
  });

  it("UNZ and UNE together at the end of a file that is cut after a message of a group", () => {
    const ung = "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A";
    const issues = validate(bytesOf(file(UNB, ung, UNH, BGM, "UNT+3+1"))).issues;
    expect(issues.map((i) => [i.expected, i.position.segment])).toEqual([
      ["UNE", 6],
      ["UNZ", 6],
    ]);
  });

  it("UNB: messages with no interchange header", () => {
    const issue = only(file(UNH, BGM, "UNT+3+1", "UNZ+1+REF1"));
    expect(issue.code).toBe("MISSING_ENVELOPE_SEGMENT");
    expect(issue.expected).toBe("UNB");
    expect(issue.position.segment).toBe(1);
  });

  it("a second UNB before the first interchange was closed", () => {
    const issues = validate(
      bytesOf(
        file(
          UNB,
          UNH,
          BGM,
          "UNT+3+1",
          UNB.replace("REF1", "REF2"),
          UNH,
          BGM,
          "UNT+3+1",
          "UNZ+1+REF2",
        ),
      ),
    ).issues;
    expect(issues.map((i) => [i.code, i.expected])).toEqual([["MISSING_ENVELOPE_SEGMENT", "UNZ"]]);
  });

  it("a file cut between segments lacks what the cut took away; one cut inside a segment says so", () => {
    const text = file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1");
    const afterBgm = validate(bytesOf(text.slice(0, text.indexOf("UNT+3")))).issues;
    expect(afterBgm.map((i) => [i.code, i.expected, i.position.segment])).toEqual([
      ["MISSING_ENVELOPE_SEGMENT", "UNT", 4],
      ["MISSING_ENVELOPE_SEGMENT", "UNZ", 4],
    ]);
    // Inside a segment the tokenizer stops: the rest is a consequence, and is not reported.
    for (const cut of [3, 4, 5, 6, 7]) {
      expect(codes(text.slice(0, text.indexOf("UNT+3") + cut))).toEqual([
        ["UNEXPECTED_END_OF_FILE", 4],
      ]);
    }
  });
});

describe("a segment where none can be", () => {
  it("between messages, or after UNB", () => {
    expect(codes(file(UNB, BGM, UNH, BGM, "UNT+3+1", "UNZ+1+REF1"))).toEqual([
      ["UNEXPECTED_SEGMENT", 2],
    ]);
    expect(codes(file(UNB, UNH, BGM, "UNT+3+1", "DTM+137:20301015:102", "UNZ+1+REF1"))).toEqual([
      ["UNEXPECTED_SEGMENT", 5],
    ]);
  });

  it("UNE with no UNG", () => {
    const issue = only(file(UNB, UNH, BGM, "UNT+3+1", "UNE+1+G1", "UNZ+1+REF1"));
    expect(issue.code).toBe("UNEXPECTED_SEGMENT");
    expect(issue.position).toMatchObject({ segment: 5, tag: "UNE" });
  });
});

describe("the report", () => {
  const broken = file(UNB, UNH, BGM, "UNT+9+2", "UNZ+5+OTHER");

  it("puts the issues in file order even when they were not found in that order", () => {
    // The bad character comes first in the file but is found by the reader, before the envelope check.
    const text = file(UNB, UNH, "BGM+220+po1", "UNT+9+1", "UNZ+1+REF1");
    const { issues } = validate(bytesOf(text));
    expect(issues.map((i) => i.code)).toEqual(["INVALID_CHARACTER", "UNT_COUNT_MISMATCH"]);
    expect(issues[0]?.found).toMatch(/not a character of UNOA/);
    expect(issues[0]?.expected).toBe("a character of UNOA");
    expect(issues[0]?.message).toMatch(/\.$/);
  });

  it("counts the character issues that were not kept", () => {
    const text = file(UNB, UNH, "BGM+220+aaa+bbb+ccc", "UNT+3+1", "UNZ+1+REF1");
    const report = validate(bytesOf(text), { maxIssues: 1 });
    expect(report.issues).toHaveLength(1);
    expect(report).toMatchObject({ issueCount: 3, errorCount: 3, valid: false });
  });

  it("says where a mandatory element is missing, down to the byte", () => {
    const unb = UNB.replace("301015:0830", "301015:");
    const [issue] = validate(bytesOf(file(unb, UNH, BGM, "UNT+3+1", "UNZ+1+REF1"))).issues;
    expect(issue).toMatchObject({ code: "MISSING_MANDATORY_ELEMENT", line: 1, column: 41 });
  });

  it("lists the issues in file order, each with its place in the file", () => {
    const report = validate(bytesOf(broken));
    expect(report.issues.map((i) => i.code)).toEqual([
      "UNT_COUNT_MISMATCH",
      "UNT_REFERENCE_MISMATCH",
      "UNZ_COUNT_MISMATCH",
      "UNZ_REFERENCE_MISMATCH",
    ]);
    expect(report.issues.map((i) => i.offset)).toEqual(
      [...report.issues.map((i) => i.offset)].sort((a, b) => a - b),
    );
    expect(report.issues.map((i) => [i.line, i.column])).toEqual([
      [4, 5],
      [4, 7],
      [5, 5],
      [5, 7],
    ]);
    expect(report).toMatchObject({ errorCount: 4, warningCount: 0, valid: false, issueCount: 4 });
  });

  it("keeps the first issues and counts them all when there are too many", () => {
    const report = validate(bytesOf(broken), { maxIssues: 2 });
    expect(report.issues).toHaveLength(2);
    expect(report).toMatchObject({ issueCount: 4, errorCount: 4, valid: false });
    expect(validate(bytesOf(broken), { maxIssues: 0 }).issues).toEqual([]);
    expect(() => validate(bytesOf(broken), { maxIssues: -1 })).toThrow(RangeError);
  });

  it("formats an issue as a block a person can read", () => {
    const [issue] = validate(bytesOf(broken)).issues;
    expect(formatIssue(issue as ValidationIssue)).toBe(
      [
        "error UNT_COUNT_MISMATCH at line 4, column 5 (segment 4 UNT, element 1)",
        "  UNT gives the number of segments as 9, but the message has 3 (UNH and UNT included).",
        "  Hint: Count the segments from UNH to UNT inclusive and write that number in the first element of UNT. A sender that edits a message by hand must update it.",
      ].join("\n"),
    );
  });

  it("is also true of an empty file, which has nothing to check", () => {
    expect(validate(new Uint8Array(0))).toMatchObject({
      valid: true,
      issueCount: 0,
      messageCount: 0,
    });
    expect(validate(bytesOf("\n\n"))).toMatchObject({ valid: true, issueCount: 0 });
  });
});

describe("every mandatory element of the envelope segments", () => {
  // Each element and component of each envelope segment, emptied in turn from a sound file.
  const sound = {
    UNB: "UNB+UNOA:3+SENDER:14+RECEIVER:14+301015:0830+REF1",
    UNG: "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A",
    UNH: "UNH+1+ORDERS:D:96A:UN",
    UNT: "UNT+3+1",
    UNE: "UNE+1+G1",
    UNZ: "UNZ+1+REF1",
  } as const;
  const interchange = (replace: string, by: string) =>
    file(
      ...[sound.UNB, sound.UNG, sound.UNH, BGM, sound.UNT, sound.UNE, sound.UNZ].map((segment) =>
        segment.startsWith(replace.slice(0, 3)) ? by : segment,
      ),
    );

  it("starts from a file with no issue", () => {
    expect(codes(interchange("UNB", sound.UNB))).toEqual([]);
  });

  // [segment, element, component or null]: every place that must have a value.
  const places: [keyof typeof sound, number, number | null][] = [
    ["UNB", 1, 1],
    ["UNB", 1, 2],
    ["UNB", 2, 1],
    ["UNB", 3, 1],
    ["UNB", 4, 1],
    ["UNB", 4, 2],
    ["UNB", 5, null],
    ["UNG", 1, null],
    ["UNG", 2, 1],
    ["UNG", 3, 1],
    ["UNG", 4, 1],
    ["UNG", 4, 2],
    ["UNG", 5, null],
    ["UNG", 6, null],
    ["UNG", 7, 1],
    ["UNG", 7, 2],
    ["UNH", 1, null],
    ["UNH", 2, 1],
    ["UNH", 2, 2],
    ["UNH", 2, 3],
    ["UNH", 2, 4],
    ["UNT", 1, null],
    ["UNT", 2, null],
    ["UNE", 1, null],
    ["UNE", 2, null],
    ["UNZ", 1, null],
    ["UNZ", 2, null],
  ];

  it.each(places)("%s element %i component %s is mandatory", (tag, element, component) => {
    // Empty the place and nothing else: the other elements keep their text.
    const elements = sound[tag].slice(4).split("+");
    const parts = (elements[element - 1] as string).split(":");
    parts[(component ?? 1) - 1] = "";
    elements[element - 1] = parts.join(":");
    const broken = `${tag}+${elements.join("+")}`;
    const issues = validate(bytesOf(interchange(tag, broken))).issues.filter(
      (i) => i.code === "MISSING_MANDATORY_ELEMENT",
    );
    expect(issues.map((i) => [i.position.tag, i.position.element, i.position.component])).toEqual([
      [
        tag,
        element,
        component ?? (parts.every((part) => part === "") && parts.length > 1 ? null : component),
      ],
    ]);
    expect(issues[0]?.layer).toBe("envelope");
  });
});

describe("where a missing envelope segment is", () => {
  it("UNB: at the first message of the interchange that lacks it, not at the start of the file", () => {
    const text =
      file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1") + file(UNH, BGM, "UNT+3+1", "UNZ+1+REF1");
    const [issue] = validate(bytesOf(text)).issues;
    expect(issue).toMatchObject({
      code: "MISSING_ENVELOPE_SEGMENT",
      line: 6,
      column: 1,
      position: { segment: 1, tag: "UNH" },
      expected: "UNB",
      found: "UNH",
    });
    expect(issue?.offset).toBe(text.indexOf(UNH, text.indexOf("UNZ")));
  });

  it("UNB: once for an interchange of several messages", () => {
    const text = file(UNH, BGM, "UNT+3+1", "UNH+2+ORDERS:D:96A:UN", BGM, "UNT+3+2", "UNZ+2+REF1");
    expect(validate(bytesOf(text)).issues.map((i) => i.expected)).toEqual(["UNB"]);
  });

  it("UNB: after a byte order mark and blank lines, at the first segment", () => {
    const text = `\n\n${file(UNH, BGM, "UNT+3+1", "UNZ+1+REF1")}`;
    const [issue] = validate(bytesOf(text)).issues;
    expect(issue?.offset).toBe(2);
    expect(issue).toMatchObject({ line: 3, column: 1 });
  });

  it("UNT: just before the segment that interrupted the message, with its tag", () => {
    const text = file(UNB, UNH, BGM, "UNH+2+ORDERS:D:96A:UN", BGM, "UNT+3+2", "UNZ+2+REF1");
    const [issue] = validate(bytesOf(text)).issues;
    expect(issue).toMatchObject({
      code: "MISSING_ENVELOPE_SEGMENT",
      expected: "UNT",
      found: "UNH",
      position: { segment: 4, tag: "UNH" },
      line: 4,
      column: 1,
    });
  });

  it("UNT, UNE and UNZ: at the end of the file, after the last segment, with no tag", () => {
    const ung = "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A";
    const text = file(UNB, ung, UNH, BGM);
    const { issues } = validate(bytesOf(text));
    expect(issues.map((i) => [i.expected, i.position.segment, i.position.tag, i.found])).toEqual([
      ["UNT", 5, null, null],
      ["UNE", 5, null, null],
      ["UNZ", 5, null, null],
    ]);
    expect(issues.map((i) => i.offset)).toEqual([
      text.lastIndexOf("'") + 1,
      text.lastIndexOf("'") + 1,
      text.lastIndexOf("'") + 1,
    ]);
  });

  it("loose segments after the last UNZ are one issue each, and nothing else", () => {
    const text = `${file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1")}XYZ+1'\n`;
    const { issues } = validate(bytesOf(text));
    expect(issues.map((i) => [i.code, i.position.tag])).toEqual([["UNEXPECTED_SEGMENT", "XYZ"]]);
  });

  it("a stray UNT, and a UNE with no UNG, are told apart from loose segments", () => {
    const stray = only(file(UNB, UNH, BGM, "UNT+3+1", "UNT+3+1", "UNZ+1+REF1"));
    expect(stray.message).toBe("The UNT segment closes a message, but no message is open here.");
    expect(stray.hint).toMatch(/UNH segment that opens the message/);
    const une = only(file(UNB, UNH, BGM, "UNT+3+1", "UNE+1+G1", "UNZ+1+REF1"));
    expect(une.hint).toMatch(/UNG segment that opens the group/);
    expect(une.position.tag).toBe("UNE");
  });
});

describe("what comes from the file is quoted with care", () => {
  it("cuts a long reference, and hides control characters", () => {
    const reference = `RE\u001b[2JF1\nerror FAKE ${"X".repeat(100)}`;
    const text = file(UNB, UNH, BGM, "UNT+3+1", `UNZ+1+${reference.replaceAll("\n", " ")}`);
    const issue = validate(bytesOf(text)).issues.find((i) => i.code === "UNZ_REFERENCE_MISMATCH");
    if (issue === undefined) {
      throw new Error("no UNZ_REFERENCE_MISMATCH");
    }
    expect(issue.found).toBe("RE?[2JF1 error FAKE XXXXXXXXXXXX...");
    expect(hasControl(issue.found ?? "")).toBe(false);
    expect(hasControl(issue.message)).toBe(false);
    expect(issue.message.length).toBeLessThan(200);
  });

  it("shows a count that is very large as it is written, without the zeros in front", () => {
    const issue = only(file(UNB, UNH, BGM, "UNT+99999999999999999999+1", "UNZ+1+REF1"));
    expect(issue.found).toBe("99999999999999999999");
    const padded = only(file(UNB, UNH, BGM, "UNT+0000000000000000000004+1", "UNZ+1+REF1"));
    expect(padded.found).toBe("4");
    expect(padded.expected).toBe("3");
  });

  it("compares references exactly: case counts", () => {
    // UNOB allows lowercase letters, so the character set has nothing to say.
    const unb = UNB.replace("UNOA", "UNOB");
    expect(codes(file(unb, UNH, BGM, "UNT+3+1", "UNZ+1+ref1"))).toEqual([
      ["UNZ_REFERENCE_MISMATCH", 5],
    ]);
  });
});

describe("the report, more", () => {
  it("says whether the whole file was read", () => {
    const text = file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1");
    expect(validate(bytesOf(text)).complete).toBe(true);
    expect(validate(bytesOf(text.slice(0, text.indexOf("UNT+3") + 5))).complete).toBe(false);
    expect(validate(bytesOf("UNA:+."), { memoryBudget: 4096 }).complete).toBe(false);
    const big = file(UNB, UNH, ...Array.from({ length: 2000 }, () => BGM), "UNT+3+1", "UNZ+1+REF1");
    const small = validate(bytesOf(big), { memoryBudget: 4096 });
    expect(small.complete).toBe(false);
    expect(small.issues.map((i) => i.code)).toEqual(["MESSAGE_TOO_LARGE"]);
  });

  it("names the repetition of an element in which a character is not allowed", () => {
    const text = `UNA:+.?*'\n${file(UNB.replace(":3", ":4"), UNH, BGM, "FTX+AAI+++OK*b:OK", "UNT+4+1", "UNZ+1+REF1")}`;
    const [issue] = validate(bytesOf(text)).issues;
    expect(issue).toMatchObject({
      code: "INVALID_CHARACTER",
      position: { tag: "FTX", element: 4, repetition: 2, component: 1 },
    });
    expect(formatIssue(issue as ValidationIssue)).toMatch(/element 4, repetition 2, component 1/);
  });

  it("counts the messages that are not closed", () => {
    const report = validate(bytesOf(file(UNB, UNH, BGM, "UNH+2+ORDERS:D:96A:UN", BGM)));
    expect(report.messageCount).toBe(2);
  });

  it("keeps the first issues of the file when there are too many, whoever found them", () => {
    // The bad character is the first issue in the file, but the envelope check finds its own first.
    const text = file(UNB, UNH, "BGM+220+po1", "UNT+9+1", "UNZ+1+REF1");
    const { issues, issueCount } = validate(bytesOf(text), { maxIssues: 1 });
    expect(issueCount).toBe(2);
    expect(issues.map((i) => i.code)).toEqual(["INVALID_CHARACTER"]);
  });

  it("gives the reader's message for a file that cannot be read, not a general one", () => {
    const [issue] = validate(bytesOf("UNA:::.? 'UNB+A'")).issues;
    expect(issue?.code).toBe("INVALID_UNA");
    expect(issue?.message).toMatch(/both|twice|same/);
    const [cut] = validate(bytesOf("UNB+UNOA:3+A")).issues;
    expect(cut?.message).toMatch(/UNB segment/);
  });
});

describe("any bytes at all", () => {
  const SAMPLES = [
    file(UNB, UNH, BGM, "UNT+3+1", "UNZ+1+REF1"),
    file(
      UNB,
      "UNG+ORDERS+A:14+B:14+301015:0830+G1+UN+D:96A",
      UNH,
      BGM,
      "UNT+3+1",
      "UNE+1+G1",
      "UNZ+1+REF1",
    ),
  ];

  it("never make validate throw, and always give the issues in file order", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SAMPLES),
        fc.array(
          fc.record({
            at: fc.nat(300),
            cut: fc.nat(8),
            insert: fc.string({ maxLength: 6 }),
          }),
          { maxLength: 4 },
        ),
        fc.integer({ min: 0, max: 5 }),
        (sample, edits, maxIssues) => {
          let text = sample;
          for (const { at, cut, insert } of edits) {
            text = text.slice(0, at) + insert + text.slice(at + cut);
          }
          const bytes = bytesOf(text);
          const report = validate(bytes, { maxIssues });
          expect(report.issues.length).toBeLessThanOrEqual(maxIssues);
          expect(report.issueCount).toBeGreaterThanOrEqual(report.issues.length);
          expect(report.errorCount + report.warningCount).toBe(report.issueCount);
          expect(report.valid).toBe(report.errorCount === 0);
          const offsets = report.issues.map((i) => i.offset);
          expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
          for (const issue of report.issues) {
            expect(issue.offset).toBeGreaterThanOrEqual(0);
            expect(issue.offset).toBeLessThanOrEqual(bytes.length);
            expect(issue.line).toBeGreaterThanOrEqual(1);
            expect(hasControl(issue.message)).toBe(false);
            expect(issue.message).not.toContain("undefined");
          }
        },
      ),
      { numRuns: 1500 },
    );
  });

  it("random bytes too", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (bytes) => {
        const report = validate(bytes);
        expect(report.errorCount + report.warningCount).toBe(report.issueCount);
      }),
      { numRuns: 1000 },
    );
  });
});
