import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CodeListCheck, type RegistryView, type ValidationIssue, validate } from "./index.ts";
import { bytesOf } from "./testing/helpers.ts";

/*
 * Structure and data element validation, on small registries that are invented here (and on the
 * fictitious one of contracts/registry/examples): no UN/EDIFACT data.
 */

const registry: RegistryView = {
  directory: { agency: "ZZ", version: "Z", release: "00A" },
  dataElements: {
    A001: { name: "word", type: "an", minLength: 1, maxLength: 5 },
    N001: { name: "count", type: "n", minLength: 1, maxLength: 4 },
    L001: { name: "initials", type: "a", minLength: 2, maxLength: 2 },
    F001: { name: "fixed", type: "an", minLength: 3, maxLength: 3 },
    C001: { name: "kind", type: "an", minLength: 1, maxLength: 3, codeList: "L1" },
    C002: { name: "flavour", type: "an", minLength: 1, maxLength: 3, codeList: "L2" },
    C003: { name: "long kind", type: "an", minLength: 1, maxLength: 20, codeList: "L1" },
  },
  composites: {
    CMP1: {
      name: "pair",
      components: [
        { ref: "A001", status: "M" },
        { ref: "N001", status: "C" },
        { ref: "L001", status: "C" },
      ],
    },
  },
  segments: {
    AAA: {
      name: "first",
      elements: [
        { ref: "A001", status: "M" },
        { ref: "N001", status: "C" },
      ],
    },
    BBB: {
      name: "second",
      elements: [
        { ref: "CMP1", status: "M" },
        { ref: "C001", status: "C" },
        { ref: "C002", status: "C" },
        { ref: "F001", status: "C" },
        { ref: "C003", status: "C" },
      ],
    },
    CCC: { name: "third", elements: [{ ref: "A001", status: "C", maxOccurs: 2 }] },
    DDD: { name: "fourth", elements: [{ ref: "CMP1", status: "C" }] },
    EEE: { name: "fifth", elements: [{ ref: "A001", status: "M" }] },
  },
  codeLists: {
    L1: { closed: true, codes: { K1: {}, K2: {} } },
    L2: { closed: false, codes: { F1: {} } },
  },
  messages: {
    TEST: {
      nodes: [
        { kind: "segment", tag: "AAA", status: "M" },
        { kind: "segment", tag: "BBB", status: "C", maxOccurs: 3 },
        {
          kind: "group",
          id: "SG1",
          status: "C",
          maxOccurs: 2,
          trigger: { tag: "CCC" },
          nodes: [
            { kind: "segment", tag: "DDD", status: "M" },
            { kind: "segment", tag: "BBB", status: "C", maxOccurs: 2 },
          ],
        },
        { kind: "segment", tag: "EEE", status: "M" },
      ],
    },
  },
};

const UNB = "UNB+UNOB:3+A:1+B:1+301015:0830+R1";

/** A TEST message with the segments given, and the UNT, UNZ and counts that make it sound. */
function file(segments: string[], options: { unb?: string; una?: string; unh?: string } = {}) {
  const unh = options.unh ?? "UNH+1+TEST:Z:00A:ZZ";
  const body = [unh, ...segments, `UNT+${segments.length + 2}+1`];
  const all = [options.unb ?? UNB, ...body, "UNZ+1+R1"];
  return `${options.una ?? ""}${all.map((s) => `${s}'`).join("\n")}\n`;
}

const check = (
  segments: string[],
  options: { unb?: string; una?: string; unh?: string; codeLists?: CodeListCheck } = {},
  using: RegistryView = registry,
): readonly ValidationIssue[] =>
  validate(bytesOf(file(segments, options)), {
    registries: [using],
    ...(options.codeLists === undefined ? {} : { codeLists: options.codeLists }),
  }).issues;

const summary = (issues: readonly ValidationIssue[]) =>
  issues.map(
    (i) =>
      [
        i.code,
        i.position.segment,
        i.position.tag,
        i.position.element,
        i.position.component,
      ] as const,
  );

const SOUND = ["AAA+WORD", "BBB+WORD:12:AB+K1", "CCC+X", "DDD+WORD", "BBB+WORD", "EEE+WORD"];

describe("a sound message", () => {
  it("has no issue, whatever the number of occurrences within the limits", () => {
    expect(check(SOUND)).toEqual([]);
    expect(check(["AAA+W", "EEE+W"])).toEqual([]);
    expect(
      check(["AAA+W", "BBB+W", "BBB+W", "BBB+W", "CCC", "DDD+W", "CCC", "DDD+W", "EEE+W"]),
    ).toEqual([]);
  });

  it("is not looked at without registries, and is warned about when none describes it", () => {
    expect(validate(bytesOf(file(["AAA+WORD"]))).issues).toEqual([]);
    const issues = check(SOUND, { unh: "UNH+1+TEST:Z:00B:ZZ" });
    expect(
      issues.map((i) => [i.code, i.severity, i.position.tag, i.position.element, i.found]),
    ).toEqual([["MESSAGE_NOT_CHECKED", "warning", "UNH", 2, "TEST Z 00B ZZ"]]);
    const other = check(SOUND, { unh: "UNH+1+OTHER:Z:00A:ZZ" });
    expect(other.map((i) => i.code)).toEqual(["MESSAGE_NOT_CHECKED"]);
    const report = validate(bytesOf(file(SOUND, { unh: "UNH+1+OTHER:Z:00A:ZZ" })), {
      registries: [registry],
    });
    expect(report).toMatchObject({ valid: true, warningCount: 1, errorCount: 0 });
  });

  it("is checked against the registry of its directory, among several", () => {
    const wrong = { ...registry, directory: { agency: "ZZ", version: "Z", release: "00B" } };
    const report = validate(bytesOf(file(["BBB+W"])), { registries: [wrong, registry] });
    expect(report.issues.map((i) => i.code)).toEqual([
      "MISSING_MANDATORY_SEGMENT",
      "MISSING_MANDATORY_SEGMENT",
    ]);
  });
});

describe("structure", () => {
  it("a mandatory segment that is missing: at the segment found in its place, or at UNT", () => {
    const issues = check(["BBB+W", "EEE+W"]);
    expect(
      issues.map((i) => [i.code, i.position.segment, i.position.tag, i.expected, i.found]),
    ).toEqual([["MISSING_MANDATORY_SEGMENT", 3, "BBB", "AAA", "BBB"]]);
    const atEnd = check(["AAA+W"]);
    expect(atEnd.map((i) => [i.code, i.position.segment, i.position.tag, i.expected])).toEqual([
      ["MISSING_MANDATORY_SEGMENT", 4, "UNT", "EEE"],
    ]);
  });

  it("a mandatory segment of a group is only needed in the occurrences that exist", () => {
    expect(check(["AAA+W", "EEE+W"])).toEqual([]);
    const issues = check(["AAA+W", "CCC", "BBB+W", "EEE+W"]);
    expect(issues.map((i) => [i.code, i.position.segment, i.position.tag, i.expected])).toEqual([
      ["MISSING_MANDATORY_SEGMENT", 5, "BBB", "DDD"],
    ]);
    const second = check(["AAA+W", "CCC", "DDD+W", "CCC", "EEE+W"]);
    expect(second.map((i) => [i.code, i.position.segment, i.position.tag, i.expected])).toEqual([
      ["MISSING_MANDATORY_SEGMENT", 7, "EEE", "DDD"],
    ]);
  });

  it("a segment that occurs too often, counted from the first one that is too many", () => {
    const issues = check(["AAA+W", "BBB+W", "BBB+W", "BBB+W", "BBB+W", "BBB+W", "EEE+W"]);
    expect(issues.map((i) => [i.code, i.position.segment, i.expected, i.found])).toEqual([
      ["TOO_MANY_REPETITIONS", 7, "3 occurrences", "4 occurrences"],
    ]);
    expect(issues[0]?.message).toBe(
      "The BBB segment occurs more often than the message allows: 4 occurrences, and at most 3 occurrences.",
    );
    const one = check(["AAA+W", "AAA+W", "EEE+W"]);
    expect(one[0]?.expected).toBe("1 occurrence");
  });

  it("a group that occurs too often is counted by the segment that opens it", () => {
    const issues = check(["AAA+W", "CCC", "DDD+W", "CCC", "DDD+W", "CCC", "DDD+W", "EEE+W"]);
    expect(issues.map((i) => [i.code, i.position.segment, i.position.tag])).toEqual([
      ["TOO_MANY_REPETITIONS", 8, "CCC"],
    ]);
  });

  it("a segment out of order says what could come, and is not counted", () => {
    const issues = check(["AAA+W", "CCC", "DDD+W", "AAA+W", "EEE+W"]);
    expect(issues.map((i) => [i.code, i.position.segment, i.position.tag, i.expected])).toEqual([
      ["SEGMENT_OUT_OF_ORDER", 6, "AAA", "BBB, CCC or EEE"],
    ]);
    expect(issues[0]?.message).toBe(
      "The AAA segment is out of order: at this point the message can continue with BBB, CCC or EEE.",
    );
    // A group segment without the segment that opens its group.
    const lone = check(["AAA+W", "DDD+W", "EEE+W"]);
    expect(lone.map((i) => [i.code, i.position.tag])).toEqual([["SEGMENT_OUT_OF_ORDER", "DDD"]]);
  });

  it("a segment the message does not have is unknown, once, with nothing after it", () => {
    const issues = check(["AAA+W", "ZZZ+W", "ZZZ+W", "EEE+W"]);
    expect(issues.map((i) => [i.code, i.position.segment, i.position.tag])).toEqual([
      ["UNKNOWN_SEGMENT", 4, "ZZZ"],
      ["UNKNOWN_SEGMENT", 5, "ZZZ"],
    ]);
  });

  it("a message with no UNT is also missing what it needed, after its last segment", () => {
    const text = `${UNB}'\nUNH+1+TEST:Z:00A:ZZ'\nAAA+W'\n`;
    const report = validate(bytesOf(text), { registries: [registry] });
    expect(report.issues.map((i) => [i.code, i.position.segment, i.expected])).toEqual([
      ["MISSING_MANDATORY_SEGMENT", 4, "EEE"],
      ["MISSING_ENVELOPE_SEGMENT", 4, "UNT"],
      ["MISSING_ENVELOPE_SEGMENT", 4, "UNZ"],
    ]);
  });
});

describe("data elements", () => {
  it("a mandatory element that is empty or missing, and a mandatory component", () => {
    expect(summary(check(["AAA", "EEE+W"]))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 3, "AAA", 1, null],
    ]);
    expect(summary(check(["AAA+W", "BBB", "EEE+W"]))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 4, "BBB", 1, null],
    ]);
    const issues = check(["AAA+W", "BBB+:12", "EEE+W"]);
    expect(summary(issues)).toEqual([["MISSING_MANDATORY_ELEMENT", 4, "BBB", 1, 1]]);
    expect(issues[0]?.expected).toBe("word (A001)");
    expect(issues[0]?.layer).toBe("element");
  });

  it("the type: digits for a number (a sign and a decimal mark do not count), letters for a name", () => {
    expect(check(["AAA+W+12", "EEE+W"])).toEqual([]);
    expect(check(["AAA+W+-1.5", "EEE+W"])).toEqual([]);
    expect(summary(check(["AAA+W+ONE", "EEE+W"]))).toEqual([
      ["INVALID_DATA_TYPE", 3, "AAA", 2, null],
    ]);
    expect(summary(check(["AAA+W+1.2.3", "EEE+W"]))).toEqual([
      ["INVALID_DATA_TYPE", 3, "AAA", 2, null],
    ]);
    expect(summary(check(["AAA+W+1-", "EEE+W"]))).toEqual([
      ["INVALID_DATA_TYPE", 3, "AAA", 2, null],
    ]);
    expect(summary(check(["AAA+W", "BBB+W:1:A1", "EEE+W"]))).toEqual([
      ["INVALID_DATA_TYPE", 4, "BBB", 1, 3],
    ]);
    expect(check(["AAA+W", "BBB+W:1:Ab", "EEE+W"])).toEqual([]);
    const issue = check(["AAA+W+ONE", "EEE+W"])[0];
    expect(issue?.message).toBe(
      'The AAA segment has ONE for count (N001), but the value must be a number (digits, with "." as the decimal mark).',
    );
    expect(issue?.expected).toBe('a number (digits, with "." as the decimal mark)');
    expect(issue?.found).toBe("ONE");
  });

  it("the decimal mark is the one of the UNA string", () => {
    const comma = { una: "UNA:+,? '\n" };
    expect(check(["AAA+W+1,5", "EEE+W"], comma)).toEqual([]);
    expect(summary(check(["AAA+W+1.5", "EEE+W"], comma))).toEqual([
      ["INVALID_DATA_TYPE", 3, "AAA", 2, null],
    ]);
    expect(summary(check(["AAA+W+1,5", "EEE+W"]))).toEqual([
      ["INVALID_DATA_TYPE", 3, "AAA", 2, null],
    ]);
  });

  it("the length counts digits only for a number, characters for the rest", () => {
    expect(check(["AAA+W+1234", "EEE+W"])).toEqual([]);
    expect(check(["AAA+W+-12.34", "EEE+W"])).toEqual([]);
    const long = check(["AAA+W+12345", "EEE+W"]);
    expect(long.map((i) => [i.code, i.expected, i.found])).toEqual([
      ["VALUE_TOO_LONG", "4 characters", "5 characters"],
    ]);
    expect(check(["AAA+TOOLONG", "EEE+W"]).map((i) => i.code)).toEqual(["VALUE_TOO_LONG"]);
    expect(
      check(["AAA+W", "BBB+W:1:A", "EEE+W"]).map((i) => [i.code, i.expected, i.found]),
    ).toEqual([["VALUE_TOO_SHORT", "2 characters", "1 character"]]);
    expect(check(["AAA+W", "BBB+W+++AB", "EEE+W"]).map((i) => i.code)).toEqual(["VALUE_TOO_SHORT"]);
    expect(check(["AAA+W", "BBB+W+++ABCD", "EEE+W"]).map((i) => i.code)).toEqual([
      "VALUE_TOO_LONG",
    ]);
    expect(check(["AAA+W", "BBB+W+++ABC", "EEE+W"])).toEqual([]);
  });

  it("an escaped character counts once, and a character outside ASCII counts once", () => {
    expect(check(["AAA+A?+B?:C", "EEE+W"])).toEqual([]); // five characters: A + B : C
    expect(check(["AAA+A?+B?:CD", "EEE+W"]).map((i) => [i.code, i.found])).toEqual([
      ["VALUE_TOO_LONG", "6 characters"],
    ]);
    const unoc = { unb: "UNB+UNOC:3+A:1+B:1+301015:0830+R1" };
    const text = new Uint8Array(Buffer.from(file(["AAA+ééééé", "EEE+W"], unoc), "latin1"));
    expect(validate(text, { registries: [registry] }).issues).toEqual([]);
    const unow = { unb: "UNB+UNOW:4+A:1+B:1+301015:0830+R1" };
    const utf8 = new Uint8Array(Buffer.from(file(["AAA+é€ééé", "EEE+W"], unow), "utf8"));
    expect(validate(utf8, { registries: [registry] }).issues).toEqual([]);
    const tooLong = new Uint8Array(Buffer.from(file(["AAA+é€éééé", "EEE+W"], unow), "utf8"));
    expect(
      validate(tooLong, { registries: [registry] }).issues.map((i) => [i.code, i.found]),
    ).toEqual([["VALUE_TOO_LONG", "6 characters"]]);
  });

  it("a letters-only value may hold accented letters", () => {
    const unoc = { unb: "UNB+UNOC:3+A:1+B:1+301015:0830+R1" };
    const text = new Uint8Array(
      Buffer.from(file(["AAA+W", "BBB+W:1:éè", "EEE+W"], unoc), "latin1"),
    );
    expect(validate(text, { registries: [registry] }).issues).toEqual([]);
    const digits = new Uint8Array(
      Buffer.from(file(["AAA+W", "BBB+W:1:é1", "EEE+W"], unoc), "latin1"),
    );
    expect(validate(digits, { registries: [registry] }).issues.map((i) => i.code)).toEqual([
      "INVALID_DATA_TYPE",
    ]);
  });

  it("the code lists: a closed one is enforced, an open one only when asked", () => {
    const closed = check(["AAA+W", "BBB+W+K9", "EEE+W"]);
    expect(
      closed.map((i) => [
        i.code,
        i.severity,
        i.layer,
        i.position.element,
        i.position.component,
        i.found,
      ]),
    ).toEqual([["UNKNOWN_CODE", "error", "code", 2, null, "K9"]]);
    expect(check(["AAA+W", "BBB+W++X9", "EEE+W"])).toEqual([]);
    const all = check(["AAA+W", "BBB+W++X9", "EEE+W"], { codeLists: "all" });
    expect(all.map((i) => [i.code, i.severity])).toEqual([["UNKNOWN_CODE", "warning"]]);
    expect(check(["AAA+W", "BBB+W+K9++", "EEE+W"], { codeLists: "off" })).toEqual([]);
    expect(check(["AAA+W", "BBB+W+k1", "EEE+W"]).map((i) => i.code)).toEqual(["UNKNOWN_CODE"]);
    expect(check(["AAA+W", "BBB+W+K1+X9", "EEE+W"], { codeLists: "off" })).toHaveLength(0);
    expect(check(["AAA+W", "BBB+W+K1+F1", "EEE+W"], { codeLists: "all" })).toEqual([]);
  });

  it("a code that is the name of something in every object is not a code", () => {
    expect(check(["AAA+W", "BBB+W++++constructor", "EEE+W"]).map((i) => i.code)).toEqual([
      "UNKNOWN_CODE",
    ]);
    expect(check(["AAA+W", "BBB+W++++toString", "EEE+W"]).map((i) => i.code)).toEqual([
      "UNKNOWN_CODE",
    ]);
    expect(check(["AAA+W", "BBB+W++++K2", "EEE+W"])).toEqual([]);
  });

  it("an element or a component beyond the definition, but not the empty ones at the end", () => {
    expect(check(["AAA+W++", "EEE+W"])).toEqual([]);
    expect(check(["AAA+W:::", "EEE+W"]).map((i) => i.code)).toEqual([]);
    const element = check(["AAA+W+1+X", "EEE+W"]);
    expect(element.map((i) => [i.code, i.position.element, i.expected, i.found])).toEqual([
      ["UNEXPECTED_ELEMENT", 3, "at most 2 elements", "3 elements"],
    ]);
    const component = check(["AAA+W", "BBB+W:1:AB:X", "EEE+W"]);
    expect(
      component.map((i) => [i.code, i.position.element, i.position.component, i.expected]),
    ).toEqual([["UNEXPECTED_COMPONENT", 1, 4, "at most 3 components"]]);
    const simple = check(["AAA+W:X", "EEE+W"]);
    expect(simple.map((i) => [i.code, i.position.element, i.position.component])).toEqual([
      ["UNEXPECTED_COMPONENT", 1, 2],
    ]);
  });
});

describe("repetition of an element", () => {
  const v4 = { una: "UNA:+.?*'\n", unb: "UNB+UNOB:4+A:1+B:1+301015:0830+R1" };
  const v3 = { una: "UNA:+.?*'\n", unb: "UNB+UNOB:3+A:1+B:1+301015:0830+R1" };

  it("is allowed in syntax version 4 up to maxOccurs, and names the repetition that is too many", () => {
    expect(check(["AAA+W", "CCC+X*Y", "DDD+W", "EEE+W"], v4)).toEqual([]);
    const issues = check(["AAA+W", "CCC+X*Y*Z", "DDD+W", "EEE+W"], v4);
    expect(
      issues.map((i) => [i.code, i.position.element, i.position.repetition, i.expected, i.found]),
    ).toEqual([["ELEMENT_REPEATED_TOO_OFTEN", 1, 3, "at most 2 times", "3 times"]]);
    const once = check(["AAA+W*V", "EEE+W"], v4);
    expect(once.map((i) => [i.code, i.expected])).toEqual([
      ["ELEMENT_REPEATED_TOO_OFTEN", "at most once"],
    ]);
  });

  it("is not allowed in an earlier version, whatever maxOccurs says", () => {
    const issues = check(["AAA+W", "CCC+X*Y", "DDD+W", "EEE+W"], v3);
    expect(issues.map((i) => [i.code, i.position.element, i.position.repetition, i.found])).toEqual(
      [["REPETITION_NOT_ALLOWED", 1, 2, "3"]],
    );
  });

  it("each repetition is checked, and an error in the second one says so", () => {
    const issues = check(["AAA+W", "CCC+X*TOOLONG", "DDD+W", "EEE+W"], v4);
    expect(
      issues.map((i) => [i.code, i.position.element, i.position.repetition, i.position.component]),
    ).toEqual([["VALUE_TOO_LONG", 1, 2, null]]);
    const composite = check(["AAA+W", "BBB+W:1*W:X", "EEE+W"], { ...v4 }).map((i) => [
      i.code,
      i.position.repetition,
      i.position.component,
    ]);
    expect(composite).toEqual([
      ["ELEMENT_REPEATED_TOO_OFTEN", 2, null],
      ["INVALID_DATA_TYPE", 2, 2],
    ]);
  });
});

describe("the fictitious registry of contracts/registry/examples", () => {
  const path = fileURLToPath(
    new URL("../../../contracts/registry/examples/fictitious-registry.json", import.meta.url),
  );
  const fictitious = JSON.parse(readFileSync(path, "utf8")) as RegistryView;
  const sound = [
    "XHD+DOC1:1",
    "XDT+10:20301015",
    "XPT+BU+NAME",
    "UNS+D",
    "XLN+1+TEXT+X1",
    "XQT+Q1:10",
    "UNS+S",
    "XTT+1",
  ];
  const run = (segments: string[], unb = UNB.replace(":3", ":4")) =>
    validate(bytesOf(file(segments, { unh: "UNH+1+SAMPLE:Z:00A:ZZ", unb })), {
      registries: [fictitious],
    }).issues;

  it("accepts a message that follows it, with groups, a closed list and an open one", () => {
    expect(run(sound)).toEqual([]);
  });

  it("finds a code, a length, a type and a structure error in it", () => {
    const broken = [...sound];
    broken[0] = "XHD+DOC1:9";
    broken[1] = "XDT+10:2030101";
    broken[4] = "XLN+ONE+TEXT+X9";
    broken[5] = "XQT+Q1:TEN";
    broken.splice(3, 1);
    expect(
      run(broken).map((i) => [i.code, i.position.tag, i.position.element, i.position.component]),
    ).toEqual([
      ["UNKNOWN_CODE", "XHD", 1, 2],
      ["VALUE_TOO_SHORT", "XDT", 1, 2],
      ["MISSING_MANDATORY_SEGMENT", "XLN", null, null],
      ["INVALID_DATA_TYPE", "XLN", 1, null],
      ["INVALID_DATA_TYPE", "XQT", 1, 2],
    ]);
  });
});

describe("any message", () => {
  it("is checked without an exception, whatever the registry says about its segments", () => {
    const odd: RegistryView = {
      ...registry,
      segments: { ...registry.segments, AAA: { elements: [{ ref: "NOPE", status: "M" }] } },
    };
    expect(() => check(["AAA+W", "EEE+W"], {}, odd)).not.toThrow();
    expect(check(["AAA+W", "EEE+W"], {}, odd)).toEqual([]);
  });
});

describe("what the message can continue with", () => {
  const seg = (tag: string, status: "M" | "C" = "C", maxOccurs = 1) =>
    ({ kind: "segment", tag, status, maxOccurs }) as const;
  const listing = (nodes: RegistryView["messages"][string]["nodes"]): RegistryView => ({
    ...registry,
    segments: {
      ...registry.segments,
      ...Object.fromEntries(
        ["FFF", "QQQ", "RRR", "MMM", "SSS", "TTT", "UUU", "VVV", "WWW", "XXX", "YYY"].map((tag) => [
          tag,
          { elements: [] },
        ]),
      ),
    },
    messages: { TEST: { nodes } },
  });
  const run = (segments: string[], using: RegistryView) => check(segments, {}, using);

  it("stops at the first mandatory segment that has not been seen", () => {
    const using = listing([seg("FFF"), seg("QQQ", "M"), seg("RRR"), seg("MMM", "M"), seg("SSS")]);
    const [issue] = run(["QQQ", "FFF", "MMM"], using);
    expect(issue?.code).toBe("SEGMENT_OUT_OF_ORDER");
    expect(issue?.expected).toBe("RRR or MMM");
  });

  it("names six segments at most, and leaves out the ones that are full", () => {
    const tags = ["QQQ", "RRR", "SSS", "TTT", "UUU", "VVV", "WWW", "XXX", "YYY"];
    const using = listing([seg("FFF"), ...tags.map((tag) => seg(tag))]);
    const [issue] = run(["QQQ", "FFF"], using);
    expect(issue?.code).toBe("SEGMENT_OUT_OF_ORDER");
    expect(issue?.expected).toBe("RRR, SSS, TTT, UUU, VVV or WWW");
  });

  it("a mandatory group is required, and is named by the segment that opens it", () => {
    const using = listing([
      seg("QQQ", "M"),
      { kind: "group", id: "SG1", status: "M", maxOccurs: 3, trigger: { tag: "MMM" }, nodes: [] },
      seg("SSS"),
    ]);
    expect(run(["QQQ", "MMM", "SSS"], using)).toEqual([]);
    const issues = run(["QQQ", "SSS"], using);
    expect(issues.map((i) => [i.code, i.expected, i.found, i.position.segment])).toEqual([
      ["MISSING_MANDATORY_SEGMENT", "MMM", "SSS", 4],
    ]);
  });
});

describe("registries that differ in agency, version or release", () => {
  it.each([
    ["agency", { agency: "YY", version: "Z", release: "00A" }],
    ["version", { agency: "ZZ", version: "Y", release: "00A" }],
    ["release", { agency: "ZZ", version: "Z", release: "00B" }],
  ])("a different %s is not the registry of the message", (_name, directory) => {
    const other: RegistryView = { ...registry, directory };
    const report = validate(bytesOf(file(["AAA+W", "EEE+W"])), { registries: [other] });
    expect(report.issues.map((i) => i.code)).toEqual(["MESSAGE_NOT_CHECKED"]);
  });
});

describe("an empty repetition", () => {
  it("is not an element with a missing component", () => {
    const v4 = { una: "UNA:+.?*'\n", unb: "UNB+UNOB:4+A:1+B:1+301015:0830+R1" };
    expect(check(["AAA+W", "BBB+W:1*", "EEE+W"], v4)).toEqual([]);
    expect(check(["AAA+W", "BBB+W:1*:2", "EEE+W"], v4).map((i) => i.code)).toEqual([
      "ELEMENT_REPEATED_TOO_OFTEN",
      "MISSING_MANDATORY_ELEMENT",
    ]);
  });
});

describe("the minus sign of a number", () => {
  it("is allowed in front, once, and not counted", () => {
    expect(check(["AAA+W+-123", "EEE+W"])).toEqual([]);
    expect(check(["AAA+W+--1", "EEE+W"]).map((i) => i.code)).toEqual(["INVALID_DATA_TYPE"]);
    expect(check(["AAA+W+1-1", "EEE+W"]).map((i) => i.code)).toEqual(["INVALID_DATA_TYPE"]);
    expect(check(["AAA+W+-1234", "EEE+W"])).toEqual([]);
    expect(check(["AAA+W+-12345", "EEE+W"]).map((i) => i.code)).toEqual(["VALUE_TOO_LONG"]);
  });
});

describe("what the review found", () => {
  it("a message type from the file is never a property of the registry", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const issues = check(["AAA+W"], { unh: `UNH+1+${type}:Z:00A:ZZ` });
      expect(issues.map((i) => i.code)).toEqual(["MESSAGE_NOT_CHECKED"]);
    }
  });

  it("a registry does not remember the message types and tags it has not got", () => {
    const text = (n: number) =>
      file(
        Array.from({ length: n }, (_unused, i) => `ZZ${i % 10}+W`),
        {
          unh: "UNH+1+UNKNOWN:Z:00A:ZZ",
        },
      );
    // Not a measure of memory, only that a lot of different types and tags do not get in the way.
    for (let i = 0; i < 50; i++) {
      validate(bytesOf(text(20).replace("UNKNOWN", `T${i}`)), { registries: [registry] });
    }
    expect(check(["AAA+W", "EEE+W"])).toEqual([]);
  });

  it("the first issues of the file are kept when there are too many, whoever found them", () => {
    const text = file(["CCC", "CCC"]); // missing AAA at the first CCC, and later EEE; UNT is right
    const broken = text.replace("UNT+4+1", "UNT+9+1");
    const all = validate(bytesOf(broken), { registries: [registry] }).issues;
    expect(all.map((i) => i.offset)).toEqual([...all.map((i) => i.offset)].sort((a, b) => a - b));
    for (const maxIssues of [1, 2, 3]) {
      const some = validate(bytesOf(broken), { registries: [registry], maxIssues }).issues;
      expect(some.map((i) => [i.code, i.offset])).toEqual(
        all.slice(0, maxIssues).map((i) => [i.code, i.offset]),
      );
    }
  });

  it("a segment that stands at two places is placed at the one that has room", () => {
    const fictitious = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../contracts/registry/examples/fictitious-registry.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as RegistryView;
    const text = file(["XHD+DOC1:1", "UNS+D", "UNS+S"], {
      unh: "UNH+1+SAMPLE:Z:00A:ZZ",
      unb: UNB.replace(":3", ":4"),
    });
    const issues = validate(bytesOf(text), { registries: [fictitious] }).issues;
    expect(issues.map((i) => [i.code, i.position.segment, i.position.tag, i.expected])).toEqual([
      ["MISSING_MANDATORY_SEGMENT", 5, "UNS", "XLN"],
    ]);
  });

  it("a segment or group that occurs too often is one issue, however many times", () => {
    const issues = check(["AAA+W", ...Array.from({ length: 3000 }, () => "BBB+W"), "EEE+W"]);
    expect(issues.map((i) => [i.code, i.position.segment, i.found])).toEqual([
      ["TOO_MANY_REPETITIONS", 7, "4 occurrences"],
    ]);
  });

  it("a mandatory segment missing at the end of a message with no UNT is told so", () => {
    const text = `${UNB}'\nUNH+1+TEST:Z:00A:ZZ'\nAAA+W'\n`;
    const issue = validate(bytesOf(text), { registries: [registry] }).issues[0];
    expect(issue?.message).toBe("The mandatory EEE segment is missing at the end of the message.");
  });

  it("nothing is said to come when the structure is over", () => {
    const only: RegistryView = {
      ...registry,
      messages: { TEST: { nodes: [{ kind: "segment", tag: "AAA", status: "M" }] } },
    };
    const issue = check(["AAA+W", "AAA+W", "EEE+W"], {}, only).find(
      (i) => i.code === "SEGMENT_OUT_OF_ORDER" || i.code === "UNKNOWN_SEGMENT",
    );
    expect(issue?.code).toBe("UNKNOWN_SEGMENT");
    const outOfOrder = check(
      ["AAA+W", "EEE+W"],
      {},
      {
        ...only,
        messages: {
          TEST: {
            nodes: [
              { kind: "segment", tag: "EEE", status: "C" },
              { kind: "segment", tag: "AAA", status: "M" },
            ],
          },
        },
      },
    ).find((i) => i.code === "SEGMENT_OUT_OF_ORDER");
    expect(outOfOrder?.message).toBe(
      "The EEE segment is out of order: the message structure has nothing more to come at this point.",
    );
  });

  it("a sign or a decimal mark alone is not a number", () => {
    for (const value of ["-", ".", "-.", "."]) {
      expect(check(["AAA+W+" + value, "EEE+W"]).map((i) => i.code)).toEqual(["INVALID_DATA_TYPE"]);
    }
    const unow = { unb: "UNB+UNOW:4+A:1+B:1+301015:0830+R1" };
    const utf8 = new Uint8Array(Buffer.from(file(["AAA+W+é", "EEE+W"], unow), "utf8"));
    expect(validate(utf8, { registries: [registry] }).issues.map((i) => i.code)).toEqual([
      "INVALID_DATA_TYPE",
    ]);
  });

  it("a mandatory simple element whose first component is empty is missing", () => {
    expect(summary(check(["AAA+W", "EEE+:5"]))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 4, "EEE", 1, null],
      ["UNEXPECTED_COMPONENT", 4, "EEE", 1, 2],
    ]);
  });

  it("says where a missing last component would have been, and counts only the components that are there", () => {
    const issues = check(["AAA+W", "BBB+:1", "EEE+W"]);
    expect(issues[0]).toMatchObject({ code: "MISSING_MANDATORY_ELEMENT", line: 4, column: 5 });
    const extra = check(["AAA+W:X:::", "EEE+W"]);
    expect(extra.map((i) => [i.code, i.found])).toEqual([["UNEXPECTED_COMPONENT", "2 components"]]);
  });

  it("an empty repetition at the end is not a repetition", () => {
    const v4 = { una: "UNA:+.?*'\n", unb: "UNB+UNOB:4+A:1+B:1+301015:0830+R1" };
    expect(check(["AAA+W", "CCC+X*Y*", "DDD+W", "EEE+W"], v4)).toEqual([]);
    expect(check(["AAA+W", "CCC+X*Y*Z*", "DDD+W", "EEE+W"], v4).map((i) => i.found)).toEqual([
      "3 times",
    ]);
    // A repetition that is empty first, and then has a value, is there.
    expect(check(["AAA+*W", "EEE+W"], v4).map((i) => i.code)).toEqual([
      "MISSING_MANDATORY_ELEMENT",
      "ELEMENT_REPEATED_TOO_OFTEN",
    ]);
  });

  it("repetition is judged from the version in UNB, which may be older, and not at all without UNB", () => {
    const v2 = { una: "UNA:+.?*'\n", unb: "UNB+UNOB:2+A:1+B:1+301015:0830+R1" };
    const issue = check(["AAA+W", "CCC+X*Y", "DDD+W", "EEE+W"], v2).find(
      (i) => i.code === "REPETITION_NOT_ALLOWED",
    );
    expect(issue?.found).toBe("2");
    const noUnb = `UNA:+.?*'\nUNH+1+TEST:Z:00A:ZZ'\nAAA+W'\nCCC+X*Y'\nDDD+W'\nEEE+W'\nUNT+6+1'\n`;
    const codes = validate(bytesOf(noUnb), { registries: [registry] }).issues.map((i) => i.code);
    expect(codes).not.toContain("REPETITION_NOT_ALLOWED");
  });

  it("a letter counts once in UNOW whatever its bytes, and a letter with an accent is a letter", () => {
    const unow = { unb: "UNB+UNOW:4+A:1+B:1+301015:0830+R1" };
    const astral = new Uint8Array(
      Buffer.from(
        file(["AAA+\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}", "EEE+W"], unow),
        "utf8",
      ),
    );
    expect(validate(astral, { registries: [registry] }).issues).toEqual([]);
    const decomposed = new Uint8Array(
      Buffer.from(
        file(["AAA+W", `BBB+W:1:${String.fromCodePoint(0x65, 0x301)}`, "EEE+W"], unow),
        "utf8",
      ),
    );
    expect(validate(decomposed, { registries: [registry] }).issues).toEqual([]);
  });

  it("says where a registry issue is in the file, to the byte", () => {
    const issues = check(["AAA+TOOLONG", "BBB+W+K9", "EEE"]);
    expect(issues.map((i) => [i.code, i.line, i.column])).toEqual([
      ["VALUE_TOO_LONG", 3, 5],
      ["UNKNOWN_CODE", 4, 7],
      ["MISSING_MANDATORY_ELEMENT", 5, 4],
    ]);
  });

  it("refuses a code list setting that does not exist", () => {
    expect(() =>
      validate(bytesOf(file(["AAA+W"])), {
        registries: [registry],
        codeLists: "none" as unknown as CodeListCheck,
      }),
    ).toThrow(RangeError);
  });
});

describe("more of what the mutants showed", () => {
  const v4 = { una: "UNA:+.?*'\n", unb: "UNB+UNOB:4+A:1+B:1+301015:0830+R1" };

  it("a mandatory element is only needed in its first repetition", () => {
    expect(check(["AAA+W*", "EEE+W"], v4).map((i) => i.code)).toEqual([]);
  });

  it("an escaped sign alone is not a number either", () => {
    expect(check(["AAA+W+?-", "EEE+W"]).map((i) => i.code)).toEqual(["INVALID_DATA_TYPE"]);
  });

  it("a mandatory element with an empty first repetition is told at the element", () => {
    const [issue] = check(["AAA+*W", "EEE+W"], v4);
    expect(issue).toMatchObject({ code: "MISSING_MANDATORY_ELEMENT", line: 4, column: 5 });
  });

  it("a mandatory component that is not there at all is told at the end of its element", () => {
    const using: RegistryView = {
      ...registry,
      composites: {
        ...registry.composites,
        CMP2: {
          name: "two",
          components: [
            { ref: "A001", status: "M" },
            { ref: "N001", status: "M" },
          ],
        },
      },
      segments: { ...registry.segments, GGG: { elements: [{ ref: "CMP2", status: "C" }] } },
      messages: {
        TEST: {
          nodes: [
            { kind: "segment", tag: "GGG", status: "C" },
            { kind: "segment", tag: "EEE", status: "M" },
          ],
        },
      },
    };
    const issues = check(["GGG+W", "EEE+W"], {}, using);
    expect(issues.map((i) => [i.code, i.position.component, i.line, i.column])).toEqual([
      ["MISSING_MANDATORY_ELEMENT", 2, 3, 6],
    ]);
  });
});
