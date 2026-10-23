import { describe, expect, it } from "vitest";
import { fixtureText, type Layout } from "../test-support/fixtures.ts";
import { parseCodeLists, parseComposites, parseElements, parseSegments } from "./definitions.ts";

const NAME_COLUMN: Record<Layout, number> = { d01b: 11, d96a: 10 };

function collect<T>(run: (report: (message: string) => void) => T): {
  result: T;
  reports: string[];
} {
  const reports: string[] = [];
  return { result: run((message) => reports.push(message)), reports };
}

describe.each<Layout>(["d01b", "d96a"])("parsers of the %s layout", (layout) => {
  const text = (file: string): string => fixtureText(layout, file);
  const codeFiles = layout === "d01b" ? ["codes.txt"] : ["codes-1.txt", "codes-2.txt"];

  describe("parseElements", () => {
    const { result: elements, reports } = collect((report) =>
      parseElements(text("elements.txt"), report),
    );
    const byTag = (tag: string) => elements.find((element) => element.tag === tag);

    it("reads every data element and reports nothing", () => {
      expect(elements.map((element) => element.tag)).toEqual(
        layout === "d01b"
          ? ["9001", "9002", "9003", "9004", "9005", "9006", "9007", "9008", "9009", "9010", "9011"]
          : ["9001", "9002", "9003", "9004", "9005", "9006", "9007", "9008", "9009", "9010"],
      );
      expect(reports).toEqual([]);
    });

    it("reads the name, whatever the usage indicator and the change indicator", () => {
      expect(byTag("9002")?.name).toBe("Example document number");
      expect(byTag("9004")?.name).toBe("Example date value");
    });

    it("joins a description that goes over several lines", () => {
      expect(byTag("9002")?.description).toBe(
        layout === "d01b"
          ? "Number that identifies an invented test document, written on two lines."
          : "Number that identifies an invented test document.",
      );
    });

    it.each([
      ["9001", "an", 1, 3],
      ["9002", "an", 1, 35],
      ["9004", "n", 8, 8],
      ["9005", "a", 2, 2],
      ["9008", "n", 1, 6],
    ])(
      "reads the representation of %s: %s, %i to %i characters",
      (tag, type, minLength, maxLength) => {
        expect(byTag(tag)).toMatchObject({ type, minLength, maxLength });
      },
    );
  });

  describe("parseComposites", () => {
    const { result: composites, reports } = collect((report) =>
      parseComposites(text("composites.txt"), report),
    );

    it("reads the composites in order, including one with an indicator before its tag", () => {
      expect(composites.map((composite) => composite.tag)).toEqual(["C901", "C902", "C904"]);
      expect(reports).toEqual([]);
    });

    it("reads the components with their status", () => {
      expect(composites[0]).toMatchObject({
        name: "EXAMPLE DOCUMENT IDENTIFICATION",
        description: "Identifies an invented document.",
        components: [
          { ref: "9002", status: "M" },
          { ref: "9001", status: "C" },
        ],
      });
      expect(composites[1]?.components).toEqual([
        { ref: "9003", status: "M" },
        { ref: "9004", status: "M" },
      ]);
    });

    it("reads a component whose name goes over two lines", () => {
      expect(composites[2]?.components).toEqual([
        { ref: "9010", status: "M" },
        { ref: "9009", status: "C" },
      ]);
    });

    it("reports a component it cannot read, and keeps the others", () => {
      const rule = "\u00c4".repeat(30);
      const broken = `Title\n${rule}\n       C901 EXAMPLE\n010    9002  Name   M   an..35\n020    9004  Name without status\n`;
      const { result, reports: problems } = collect((report) => parseComposites(broken, report));
      expect(problems).toEqual([
        expect.stringMatching(/composite C901: cannot read the component "020 9004/),
      ]);
      expect(result[0]?.components).toEqual([{ ref: "9002", status: "M" }]);
    });
  });

  describe("parseSegments", () => {
    const { result: segments, reports } = collect((report) =>
      parseSegments(text("segments.txt"), report),
    );
    const byTag = (tag: string) => segments.find((segment) => segment.tag === tag);

    it("reads the segments, including one with an indicator before its tag", () => {
      expect(segments.map((segment) => segment.tag)).toEqual([
        "XHD",
        "XPT",
        "XDT",
        "XLN",
        "XQT",
        "XTT",
      ]);
      expect(reports).toEqual([]);
    });

    it("reads the elements with their status and, from D.01B on, how many times they repeat", () => {
      expect(byTag("XPT")?.elements).toEqual([
        { ref: "9005", status: "M", maxOccurs: 1 },
        { ref: "9006", status: "M", maxOccurs: 1 },
        { ref: "9007", status: "C", maxOccurs: layout === "d01b" ? 3 : 1 },
      ]);
      expect(byTag("XHD")?.elements.map((element) => element.ref)).toEqual(
        layout === "d01b" ? ["C901", "C902", "9011"] : ["C901", "C902"],
      );
      expect(byTag("XHD")?.elements[1]).toMatchObject({
        status: "C",
        maxOccurs: layout === "d01b" ? 5 : 1,
      });
    });

    it("does not take the components listed under a composite for elements", () => {
      expect(byTag("XQT")?.elements).toEqual([{ ref: "C904", status: "M", maxOccurs: 1 }]);
    });

    it("reads an element whose name goes over two lines, and ignores a note after the last one", () => {
      if (layout !== "d01b") return;
      expect(byTag("XLN")?.elements).toEqual([
        { ref: "9008", status: "M", maxOccurs: 1 },
        { ref: "9006", status: "C", maxOccurs: 1 },
      ]);
      expect(byTag("XHD")?.elements).toHaveLength(3);
    });

    it("reads the function, however many lines it takes", () => {
      expect(byTag("XHD")?.description).toBe(
        layout === "d01b"
          ? "To identify the invented document, with a description that goes over two lines."
          : "To identify the invented document.",
      );
    });
  });

  describe("parseCodeLists", () => {
    const { result: lists, reports } = collect((report) =>
      codeFiles.flatMap((file) => parseCodeLists(text(file), NAME_COLUMN[layout], report)),
    );
    const byTag = (tag: string) => lists.find((list) => list.tag === tag);

    it("reads a list for every data element that has one, and nothing else", () => {
      expect(lists.map((list) => list.tag)).toEqual(
        layout === "d01b"
          ? ["9001", "9003", "9005", "9010", "9011"]
          : ["9001", "9003", "9005", "9010"],
      );
      expect(reports).toEqual([]);
    });

    it("reads each code with its name, whatever the width of the code", () => {
      expect(byTag("9005")?.codes.map((code) => [code.value, code.name])).toEqual([
        ["BU", "Buying party"],
        ["SL", "Selling party"],
      ]);
      expect(byTag("9003")?.codes.map((code) => code.value)).toEqual(["10", "20"]);
      expect(byTag("9001")?.codes.map((code) => code.value)).toEqual(
        layout === "d01b" ? ["1", "2", "3", "14"] : ["1", "2", "14"],
      );
    });

    it("joins a name and a description that go over several lines", () => {
      const codes = byTag("9001")?.codes ?? [];
      expect(codes.find((code) => code.value === "2")?.description).toBe(
        "The invented document replaces an earlier one, and this description goes over two lines.",
      );
      expect(codes.find((code) => code.value === "14")?.name).toBe(
        layout === "d01b"
          ? "Fourth code"
          : "Fourth code whose name is too long for one line, so it goes on",
      );
    });

    it("keeps a note out of the description of a code", () => {
      if (layout !== "d01b") return;
      const cancelled = byTag("9001")?.codes.find((code) => code.value === "3");
      expect(cancelled?.name).toBe(
        "Cancellation that has a name too long for one line, so it goes on",
      );
      expect(cancelled?.description).toBe("This code is marked for deletion.");
    });

    it("gives a list without codes an empty list of codes", () => {
      if (layout !== "d01b") return;
      expect(byTag("9011")?.codes).toEqual([]);
    });
  });
});

describe("what the parsers do with text that is not a directory", () => {
  it("gives nothing for an empty file and reports nothing", () => {
    for (const parse of [parseElements, parseComposites, parseSegments]) {
      const { result, reports } = collect((report) => parse("", report));
      expect(result).toEqual([]);
      expect(reports).toEqual([]);
    }
  });

  it("reports an entry that does not start with a header, and a representation it does not know", () => {
    const rule = "Ä".repeat(30);
    const { result, reports } = collect((report) =>
      parseElements(
        `Title\n${rule}\nnot a header\n${rule}\n     9001  Name\n     Repr: x9\n`,
        report,
      ),
    );
    expect(result).toEqual([]);
    expect(reports).toEqual([
      'unexpected entry starting with "not a header"',
      expect.stringMatching(/data element 9001: cannot read the representation "x9"/),
    ]);
  });
});
