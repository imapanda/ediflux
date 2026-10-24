import { describe, expect, it } from "vitest";
import { fixtureText, type Layout } from "../test-support/fixtures.ts";
import type { MessageNode } from "../types.ts";
import { parseMessage } from "./messages.ts";

function parse(text: string): { message: ReturnType<typeof parseMessage>; reports: string[] } {
  const reports: string[] = [];
  return { message: parseMessage(text, (report) => reports.push(report)), reports };
}

const segment = (
  tag: string,
  status: "M" | "C",
  maxOccurs: number | undefined,
  sequence: string,
  section?: string,
) => ({
  kind: "segment",
  tag,
  status,
  ...(maxOccurs !== undefined && { maxOccurs }),
  sequence,
  ...(section && { section }),
});

describe.each<Layout>(["d01b", "d96a"])("parseMessage of the %s layout", (layout) => {
  const { message, reports } = parse(fixtureText(layout, "message-sample.txt"));
  const nested = layout === "d01b";

  it("reads the identity and the title of the message", () => {
    expect(message).toMatchObject({
      type: "SAMPLE",
      version: "Z",
      release: layout === "d01b" ? "01B" : "96A",
      agency: "UN",
      name: "Fictitious sample message",
    });
    expect(reports).toEqual([]);
  });

  it("leaves out UNH and UNT, and keeps the order of the table", () => {
    const tags = JSON.stringify(message?.nodes);
    expect(tags).not.toContain('"UNH"');
    expect(tags).not.toContain('"UNT"');
    expect(message?.nodes.map((node) => (node.kind === "segment" ? node.tag : node.id))).toEqual([
      "XHD",
      "XDT",
      "SG1",
      "UNS",
      "SG2",
      "UNS",
      "XTT",
    ]);
  });

  it("gives a top-level node its section, and its position in the table", () => {
    expect(message?.nodes[0]).toEqual(segment("XHD", "M", undefined, "0020", "header"));
    expect(message?.nodes[1]).toEqual(segment("XDT", "C", 5, "0030", "header"));
    expect(message?.nodes[3]).toMatchObject({ tag: "UNS", section: "detail" });
    expect(message?.nodes[5]).toMatchObject({ tag: "UNS", section: "summary" });
    expect(message?.nodes[6]).toMatchObject({ tag: "XTT", status: "C", section: "summary" });
  });

  it("makes the first segment under a group heading its trigger", () => {
    expect(message?.nodes[2]).toEqual({
      kind: "group",
      id: "SG1",
      status: "C",
      maxOccurs: 9,
      sequence: "0040",
      section: "header",
      trigger: { tag: "XPT", sequence: "0050" },
      nodes: [segment("XDT", "C", 5, "0060")],
    });
  });

  it("closes a group at the corner, and nests groups drawn inside it", () => {
    const lines = message?.nodes[4];
    expect(lines).toMatchObject({
      kind: "group",
      id: "SG2",
      status: "C",
      maxOccurs: layout === "d01b" ? 999 : 99,
      section: "detail",
      trigger: { tag: "XLN", sequence: "0090" },
    });
    const children = lines?.kind === "group" ? lines.nodes : [];
    const kinds = children?.map((node: MessageNode) =>
      node.kind === "segment" ? node.tag : node.id,
    );
    expect(kinds).toEqual(nested ? ["XQT", "SG3"] : ["XQT"]);
    if (nested) {
      expect(children?.[1]).toEqual({
        kind: "group",
        id: "SG3",
        status: "C",
        maxOccurs: 3,
        sequence: "0110",
        trigger: { tag: "XPT", sequence: "0120" },
        nodes: [segment("XDT", "C", 5, "0130")],
      });
    }
  });

  it("does not read what follows the table", () => {
    expect(JSON.stringify(message)).not.toContain("Annex");
    expect(reports.join()).not.toContain("Annex");
  });
});

describe("parseMessage on a table with a wrapped name", () => {
  it("joins the two lines of a segment name that does not fit", () => {
    const { message, reports } = parse(fixtureText("d01b", "message-sample.txt"));
    const lines = message?.nodes.find((node) => node.kind === "group" && node.id === "SG2");
    const quantity = lines?.kind === "group" ? lines.nodes?.[0] : undefined;
    expect(quantity).toMatchObject({
      kind: "segment",
      tag: "XQT",
      status: "C",
      maxOccurs: 5,
      sequence: "0100",
    });
    expect(reports).toEqual([]);
  });
});

describe("parseMessage on text it cannot read", () => {
  const head = (type = "SAMPLE") =>
    `UN/EDIFACT\n\nSTATUS\n\nTitle\n\nMessage Type : ${type}\nVersion : Z\nRelease : 01B\nContr. Agency: UN\n\n4.3.1  Segment table\n\n`;

  it("gives up, and says why, when there is no message type or no table", () => {
    expect(parse("nothing useful")).toEqual({
      message: undefined,
      reports: ['cannot find the message type ("")'],
    });
    expect(parse("Message Type : SAMPLE\n")).toEqual({
      message: undefined,
      reports: ["SAMPLE: cannot find the segment table"],
    });
  });

  it("reports a line of the table it cannot read, and goes on", () => {
    const { message, reports } = parse(
      `${head()}0010   XHD Header   M   1\nwhat is this\n0020   XDT Date   C   5\n`,
    );
    expect(reports).toEqual(['SAMPLE: cannot read the line "what is this"']);
    expect(message?.nodes.map((node) => (node.kind === "segment" ? node.tag : ""))).toEqual([
      "XHD",
      "XDT",
    ]);
  });

  it("reports a group that is never closed and a corner with no group", () => {
    const rule = "Ä".repeat(5);
    const opened = parse(
      `${head()}0010       ${rule} Segment group 1  ${rule} C   9${rule}¿\n0020   XPT Party   M   1\n`,
    );
    expect(opened.reports).toEqual(["SAMPLE: group SG1 is never closed"]);
    const stray = parse(`${head()}0010   XHD Header   M   1   Ù\n`);
    expect(stray.reports).toEqual(["SAMPLE: a group is closed that was never opened"]);
  });

  it("gives up on groups nested deeper than any directory goes", () => {
    const rule = "\u00c4".repeat(5);
    const heading = (n: number) =>
      `${String(n).padStart(4, "0")}       ${rule} Segment group ${n}  ${rule} C   9${rule}\u00bf`;
    const table = Array.from({ length: 40 }, (_, index) => heading(index + 1)).join("\n");
    const { message, reports } = parse(`${head()}${table}\n`);
    expect(message).toBeUndefined();
    expect(reports).toEqual(["SAMPLE: segment groups are nested more than 32 deep"]);
  });

  it("reports a trigger that is not mandatory and single", () => {
    const rule = "Ä".repeat(5);
    const { reports } = parse(
      `${head()}0010       ${rule} Segment group 1  ${rule} C   9${rule}¿\n0020   XPT Party   C   3   Ù\n`,
    );
    expect(reports).toEqual(["SAMPLE: the first segment of SG1 should be mandatory, once"]);
  });
});
