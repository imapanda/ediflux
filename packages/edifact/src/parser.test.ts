import { describe, expect, it } from "vitest";
import { generateOrders } from "../bench/generate.ts";
import {
  type Envelope,
  type Group,
  type Interchange,
  type Message,
  ParseError,
  parseInterchanges,
  parseMessages,
  type Segment,
  TokenizeError,
} from "./index.ts";
import { bytesOf } from "./testing/helpers.ts";

function parse(text: string): Interchange {
  const { interchanges } = parseInterchanges(bytesOf(text));
  const [first] = interchanges;
  if (first === undefined) {
    throw new Error("no interchange");
  }
  return first;
}

/** The first of a list, which a test knows is there. */
function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) {
    throw new Error("the list is empty");
  }
  return item;
}

const tags = (segments: readonly Segment[]): string[] => segments.map((s) => s.tag);

const ENVELOPE = "UNB+UNOA:3+SENDER+RECEIVER+301015:0830+IC1'";

describe("shape of a well-formed interchange", () => {
  const text = `UNA:+.? '${ENVELOPE}UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1'UNT+3+1'UNH+2+ORDERS:D:96A:UN'BGM+220+PO-2'UNT+3+2'UNZ+2+IC1'`;

  it("has a header, messages and a trailer", () => {
    const interchange = parse(text);
    expect(interchange.kind).toBe("interchange");
    expect(interchange.una?.text).toBe(":+.? '");
    expect(interchange.unb?.tag).toBe("UNB");
    expect(interchange.unz?.tag).toBe("UNZ");
    expect(interchange.items.map((i) => i.kind)).toEqual(["message", "message"]);
    const [first, second] = interchange.items as Message[];
    expect(tags(first?.segments ?? [])).toEqual(["UNH", "BGM", "UNT"]);
    expect(first?.unh.text(1)).toBe("1");
    expect(second?.unh.text(1)).toBe("2");
    expect(first?.unt?.text(2)).toBe("1");
    expect(first?.segmentCount).toBe(3);
  });

  it("numbers segments from 1 in the interchange, UNB being 1, across messages", () => {
    const interchange = parse(text);
    expect([...interchange.segments()].map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const second = interchange.items[1] as Message;
    expect(second.segments.map((s) => s.number)).toEqual([5, 6, 7]);
  });

  it("covers the interchange from UNA to the last terminator", () => {
    const interchange = parse(text);
    expect(interchange.start).toBe(0);
    expect(interchange.end).toBe(text.length);
    const [first] = interchange.items as Message[];
    expect(text.slice(first?.start, first?.end)).toBe(
      "UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1'UNT+3+1'",
    );
  });

  it("gives the facts of the envelope to every message", () => {
    const interchange = parse(text);
    const [first] = interchange.items as Message[];
    expect(first?.interchange).toBe(interchange);
    expect(first?.ung).toBeNull();
    expect(interchange.index).toBe(0);
    expect(interchange.syntaxIdentifier).toBe("UNOA");
    expect(interchange.syntaxVersion).toBe("3");
    expect(interchange.characterSet).toBe("UNOA");
  });

  it("is lossless: the bytes between nodes are line breaks and nothing else", () => {
    const withBreaks = text.replaceAll("'", "'\r\n");
    const interchange = parse(`ï»¿${withBreaks}`);
    const bytes = interchange.source;
    expect(interchange.una?.start).toBe(3); // after the byte order mark
    let end = interchange.una?.end ?? 3;
    for (const segment of interchange.segments()) {
      const between = Buffer.from(bytes.subarray(end, segment.start)).toString("latin1");
      expect(between === "" || /^[\r\n]+$/.test(between)).toBe(true);
      end = segment.end;
    }
    expect(interchange.start).toBe(3);
  });
});

describe("segments, elements and components", () => {
  const interchange = parse(
    "UNB+UNOA:3+A'NAD+BY+9520000000011::9++SAMPLE?+ONE:'FTX+AAI'UNZ+0+IC1'",
  );
  const nad = [...interchange.segments()][1] as Segment;

  it("reach the values by position, counted from 1", () => {
    expect(nad.tag).toBe("NAD");
    expect(nad.elements).toHaveLength(4);
    expect(nad.text(1)).toBe("BY");
    expect(nad.text(2, 1)).toBe("9520000000011");
    expect(nad.text(2, 3)).toBe("9");
    expect(nad.element(0)).toBeUndefined();
    expect(nad.element(5)).toBeUndefined();
    expect(nad.component(2, 4)).toBeUndefined();
    expect(nad.text(9)).toBeUndefined();
  });

  it("keep an empty component and an empty element, as the registry counts them", () => {
    expect(nad.element(2)?.components.map((c) => c.empty)).toEqual([false, true, false]);
    expect(nad.component(2, 2)?.text()).toBe("");
    expect(nad.element(3)?.components).toEqual([]);
    expect(nad.element(4)?.components.map((c) => c.text())).toEqual(["SAMPLE+ONE", ""]);
  });

  it("give every node its position", () => {
    expect(nad.position).toEqual({ segment: 2, tag: "NAD", element: null, component: null });
    expect(nad.element(2)?.position).toEqual({
      segment: 2,
      tag: "NAD",
      element: 2,
      component: null,
    });
    expect(nad.component(2, 3)?.position).toEqual({
      segment: 2,
      tag: "NAD",
      element: 2,
      component: 3,
    });
    expect(nad.component(4, 2)?.position).toEqual({
      segment: 2,
      tag: "NAD",
      element: 4,
      component: 2,
    });
  });

  it("know the bytes they span", () => {
    const text = (node: { start: number; end: number }) =>
      Buffer.from(interchange.source.subarray(node.start, node.end)).toString("latin1");
    expect(text(nad)).toBe("NAD+BY+9520000000011::9++SAMPLE?+ONE:'");
    expect(text(nad.element(2) as { start: number; end: number })).toBe("9520000000011::9");
    expect(text(nad.component(2, 1) as { start: number; end: number })).toBe("9520000000011");
    expect(text(nad.element(4) as { start: number; end: number })).toBe("SAMPLE?+ONE:");
    expect(text(nad.component(4, 1) as { start: number; end: number })).toBe("SAMPLE?+ONE");
    // An empty component sits at the separator that stands for it.
    const empty = nad.component(2, 2);
    expect(empty?.start).toBe(empty?.end);
    expect(text(nad.element(3) as { start: number; end: number })).toBe("");
  });

  it("give the value with its release characters removed, as text or as bytes", () => {
    const value = nad.component(4, 1);
    expect(value?.text()).toBe("SAMPLE+ONE");
    expect(Buffer.from(value?.bytes() ?? []).toString("latin1")).toBe("SAMPLE+ONE");
    expect(Buffer.from(nad.component(1, 1)?.bytes() ?? []).toString("latin1")).toBe("BY");
  });

  it("make a segment without elements, and the position of a tag-only segment", () => {
    const ftx = [...interchange.segments()][2] as Segment;
    expect(ftx.elements).toHaveLength(1);
    const uns = parse("UNB+UNOA:3'UNS'UNZ+0+1'");
    expect([...uns.segments()][1]?.elements).toEqual([]);
  });

  it("give the line and column of any offset", () => {
    const multi = parse("UNB+UNOA:3+A'\nNAD+BY'\r\nFTX+AAI'");
    const [, nadSegment, ftxSegment] = [...multi.segments()];
    expect(multi.locate(nadSegment?.start ?? 0)).toEqual({ line: 2, column: 1 });
    expect(multi.locate(ftxSegment?.start ?? 0)).toEqual({ line: 3, column: 1 });
    expect(multi.locate(nadSegment?.element(1)?.start ?? 0)).toEqual({ line: 2, column: 5 });
  });
});

describe("repetitions (syntax 4)", () => {
  const interchange = parse("UNA:+.?*'UNB+UNOA:4'FTX+AAI+A:B*C**D'UNZ+0+1'");
  const ftx = [...interchange.segments()][1] as Segment;

  it("are listed per element, each with its components", () => {
    const element = ftx.element(2);
    expect(element?.repetitions.map((r) => r.map((c) => c.text()))).toEqual([
      ["A", "B"],
      ["C"],
      [],
      ["D"],
    ]);
    expect(element?.components.map((c) => c.text())).toEqual(["A", "B"]);
  });

  it("number components within their repetition", () => {
    const element = ftx.element(2);
    expect(element?.repetitions[1]?.[0]?.position).toEqual({
      segment: 2,
      tag: "FTX",
      element: 2,
      component: 1,
    });
    expect(element?.repetitions[3]?.[0]?.position).toEqual({
      segment: 2,
      tag: "FTX",
      element: 2,
      component: 1,
    });
    expect(element?.repetitions[0]?.[1]?.position).toEqual({
      segment: 2,
      tag: "FTX",
      element: 2,
      component: 2,
    });
  });

  it("keep the first repetition for component(e, c): the next one is not a component of the first", () => {
    expect(ftx.component(2, 2)?.text()).toBe("B");
    expect(ftx.component(2, 3)).toBeUndefined();
    expect(ftx.text(2, 3)).toBeUndefined();
    expect(ftx.element(2)?.components).toHaveLength(2);
  });

  it("have a single repetition when the element is not repeated", () => {
    expect(ftx.element(1)?.repetitions).toHaveLength(1);
  });
});

describe("a structure that is not what it should be is still a tree", () => {
  it("lets a message run on without UNT until the next UNH", () => {
    const interchange = parse(`${ENVELOPE}UNH+1+X'BGM+1'UNH+2+X'BGM+2'UNT+2+2'UNZ+2+IC1'`);
    const [first, second] = interchange.items as Message[];
    expect(first?.unt).toBeNull();
    expect(tags(first?.segments ?? [])).toEqual(["UNH", "BGM"]);
    expect(second?.unt?.tag).toBe("UNT");
  });

  it("lets a message and an interchange end with the file", () => {
    const interchange = parse(`${ENVELOPE}UNH+1+X'BGM+1'`);
    const [only] = interchange.items as Message[];
    expect(only?.unt).toBeNull();
    expect(interchange.unz).toBeNull();
  });

  it("keeps a segment outside any message where it is, between the messages", () => {
    const interchange = parse(
      `${ENVELOPE}BGM+0'UNH+1+X'UNT+1+1'FTX+AAI'UNH+2+X'UNT+1+2'UNZ+2+IC1'`,
    );
    expect(interchange.items.map((i) => (i.kind === "segment" ? i.tag : i.kind))).toEqual([
      "BGM",
      "message",
      "FTX",
      "message",
    ]);
  });

  it("ends a message at UNE or UNZ as well as at UNH", () => {
    const interchange = parse(`${ENVELOPE}UNG+ORDERS+A+B'UNH+1+X'BGM+1'UNE+1+G1'UNZ+1+IC1'`);
    const group = first(interchange.items as Group[]);
    expect(group.kind).toBe("group");
    const message = first(group.items as Message[]);
    expect(message?.unt).toBeNull();
    expect(tags(message?.segments ?? [])).toEqual(["UNH", "BGM"]);
    expect(group?.une?.tag).toBe("UNE");
    expect(interchange.unz?.tag).toBe("UNZ");
  });

  it("parses a file that has no envelope at all", () => {
    const interchange = parse("UNH+1+X'BGM+1'UNT+2+1'");
    expect(interchange.unb).toBeNull();
    expect(interchange.characterSet).toBeNull();
    expect(interchange.items.map((i) => i.kind)).toEqual(["message"]);
  });

  it("keeps UNE without UNG, and UNG without UNE", () => {
    const stray = parse(`${ENVELOPE}UNE+1+G1'UNZ+0+IC1'`);
    expect(stray.items.map((i) => (i.kind === "segment" ? i.tag : i.kind))).toEqual(["UNE"]);
    const open = parse(`${ENVELOPE}UNG+ORDERS+A+B'UNH+1+X'UNT+1+1'`);
    const [group] = open.items as Group[];
    expect(group?.une).toBeNull();
    expect(group?.items).toHaveLength(1);
    expect(group?.end).toBe(open.end);
  });

  it("parses a file with only line breaks as nothing, and an empty file too", () => {
    expect(parseInterchanges(bytesOf("")).interchanges).toEqual([]);
    expect(parseInterchanges(bytesOf("\r\n\n")).interchanges).toEqual([]);
  });
});

describe("groups", () => {
  const text = `${ENVELOPE}UNG+ORDERS+A+B'UNH+1+X'UNT+1+1'UNH+2+X'UNT+1+2'UNE+2+G1'UNH+3+X'UNT+1+3'UNZ+2+IC1'`;

  it("hold their messages, and tell each message which group it is in", () => {
    const interchange = parse(text);
    expect(interchange.items.map((i) => i.kind)).toEqual(["group", "message"]);
    const [group, outside] = interchange.items as [Group, Message];
    expect(group.items).toHaveLength(2);
    expect(group.ung.tag).toBe("UNG");
    expect(group.une?.tag).toBe("UNE");
    expect((group.items[0] as Message).ung?.tag).toBe("UNG");
    expect(outside.ung).toBeNull();
    expect([...interchange.segments()].map((s) => s.tag)).toEqual([
      "UNB",
      "UNG",
      "UNH",
      "UNT",
      "UNH",
      "UNT",
      "UNE",
      "UNH",
      "UNT",
      "UNZ",
    ]);
  });

  it("span from UNG to UNE", () => {
    const interchange = parse(text);
    const [group] = interchange.items as Group[];
    expect(text.slice(group?.start, group?.end)).toBe(
      "UNG+ORDERS+A+B'UNH+1+X'UNT+1+1'UNH+2+X'UNT+1+2'UNE+2+G1'",
    );
  });
});

describe("several interchanges in one file", () => {
  const text = `UNA:+.? 'UNB+UNOA:3+A'UNH+1+X'UNT+1+1'UNZ+1+1'UNB+UNOC:3+B'UNH+1+X'UNT+1+1'UNZ+1+2'UNA;*,! %UNB*UNOW;4*C%UNH*1*X%UNT*1*1%UNZ*1*3%`;

  it("come out one by one, with their own envelope, separators and character set", () => {
    const { interchanges } = parseInterchanges(bytesOf(text));
    expect(interchanges.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(interchanges.map((i) => i.characterSet)).toEqual(["UNOA", "UNOC", "UNOW"]);
    expect(interchanges.map((i) => i.una?.text ?? null)).toEqual([":+.? '", null, ";*,! %"]);
    expect(interchanges.map((i) => i.separators.element)).toEqual([0x2b, 0x2b, 0x2a]);
    expect(interchanges.map((i) => i.unz?.text(2))).toEqual(["1", "2", "3"]);
    for (const interchange of interchanges) {
      expect(interchange.items).toHaveLength(1);
      expect([...interchange.segments()].map((s) => s.number)).toEqual([1, 2, 3, 4]);
    }
  });

  it("each cover their own bytes", () => {
    const { interchanges } = parseInterchanges(bytesOf(text));
    const spans = interchanges.map((i) => [i.start, i.end]);
    expect(spans[0]?.[0]).toBe(0);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] ?? 0);
    }
    expect(spans.at(-1)?.[1]).toBe(text.length);
  });

  it("start a new one at UNB when the last one has no UNZ", () => {
    const { interchanges } = parseInterchanges(
      bytesOf("UNB+UNOA:3+A'UNH+1+X'UNB+UNOA:3+B'UNZ+0+1'"),
    );
    expect(interchanges).toHaveLength(2);
    expect(interchanges[0]?.unz).toBeNull();
    expect(interchanges[1]?.unz?.tag).toBe("UNZ");
  });
});

describe("character sets", () => {
  it("decode UNOC as ISO 8859-1", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOC:3+A'FTX+AAI+++Cr"),
      0xe8,
      ...bytesOf("me'UNZ+0+1'"),
    ]);
    const { interchanges, issues } = parseInterchanges(bytes);
    expect(issues).toEqual([]);
    expect([...(interchanges[0]?.segments() ?? [])][1]?.text(4)).toBe("Crème");
  });

  it("decode UNOW as UTF-8, up to four bytes", () => {
    const text = "Crème € 😀";
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOW:4+A'FTX+AAI+++"),
      ...new TextEncoder().encode(text),
      ...bytesOf("'UNZ+0+1'"),
    ]);
    const { interchanges, issues } = parseInterchanges(bytes);
    expect(issues).toEqual([]);
    expect([...(interchanges[0]?.segments() ?? [])][1]?.text(4)).toBe(text);
  });

  it("report a bad value once, with its position and a plain message, and keep the tree whole", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOA:3+A'FTX+AAI+++SAMPLE CRE"),
      0xc9,
      ...bytesOf(" SA'UNZ+0+1'"),
    ]);
    const { interchanges, issues, issueCount } = parseInterchanges(bytes);
    expect(issueCount).toBe(1);
    expect(issues[0]).toMatchObject({
      code: "INVALID_CHARACTER",
      message: "Invalid character in UNOA: byte 0xC9 is not a character of UNOA",
      offset: 33,
      line: 1,
      position: { segment: 2, tag: "FTX", element: 4, component: 1 },
    });
    // The value is still there, decoded as ISO 8859-1, and so are the other segments.
    const segments = [...(interchanges[0]?.segments() ?? [])];
    expect(segments.map((s) => s.tag)).toEqual(["UNB", "FTX", "UNZ"]);
    expect(segments[1]?.text(4)).toBe("SAMPLE CREÉ SA");
  });

  it("report a line break inside a value, which the tokenizer leaves as data", () => {
    const { issues } = parseInterchanges(bytesOf("UNB+UNOA:3+A'FTX+AAI+++ONE\nTWO'UNZ+0+1'"));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("byte 0x0A");
  });

  it("report an unsupported character set and read on, unchecked", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOK:3+A'FTX+AAI+++"),
      0xe9,
      0x01,
      ...bytesOf("'UNZ+0+1'"),
    ]);
    const { interchanges, issues } = parseInterchanges(bytes);
    expect(issues.map((i) => i.code)).toEqual(["UNSUPPORTED_CHARSET"]);
    expect(issues[0]?.position).toEqual({ segment: 1, tag: "UNB", element: 1, component: 1 });
    expect(issues[0]?.message).toContain('"UNOK"');
    expect(interchanges[0]?.characterSet).toBeNull();
    expect([...(interchanges[0]?.segments() ?? [])][1]?.text(4)).toBe("é\u0001");
  });

  it("have no set to check against when UNB is missing or has no S001", () => {
    expect(parseInterchanges(bytesOf("UNH+1+X'FTX+\u0001'UNT+2+1'")).issues).toEqual([]);
    expect(parseInterchanges(bytesOf("UNB+'FTX+\u0001'UNZ+0+1'")).issues).toEqual([]);
  });

  it("accept what UNA declares as separators, whatever the set", () => {
    const { issues } = parseInterchanges(bytesOf("UNA|{.}^~UNB{UNOA|3~FTX{AAI{{{A}|B}~UNZ{0{1~"));
    expect(issues).toEqual([]);
  });

  it("can be told not to check", () => {
    const text = "UNB+UNOA:3+A'FTX+AAI+++lower case'UNZ+0+1'";
    expect(parseInterchanges(bytesOf(text)).issueCount).toBe(1);
    expect(parseInterchanges(bytesOf(text), { checkCharacters: false }).issueCount).toBe(0);
  });

  it("keep at most maxIssues of them but count them all", () => {
    const text = `UNB+UNOA:3+A'${"FTX+AAI+++lower'".repeat(5)}UNZ+0+1'`;
    const result = parseInterchanges(bytesOf(text), { maxIssues: 2 });
    expect(result.issues).toHaveLength(2);
    expect(result.issueCount).toBe(5);
    expect(parseInterchanges(bytesOf(text), { maxIssues: 0 }).issues).toEqual([]);
  });
});

describe("parseMessages", () => {
  const text = `${ENVELOPE}UNG+ORDERS+A+B'UNH+1+X'BGM+1'UNT+2+1'UNH+2+X'BGM+2'UNT+2+2'UNE+2+G1'UNZ+2+IC1'`;

  it("hands out the messages one by one, each with its envelope and group", () => {
    const stream = parseMessages(bytesOf(text));
    const refs: (string | undefined)[] = [];
    for (const message of stream) {
      refs.push(message.unh.text(1));
      expect(message.interchange.unb?.tag).toBe("UNB");
      expect(message.interchange.characterSet).toBe("UNOA");
      expect(message.ung?.tag).toBe("UNG");
    }
    expect(refs).toEqual(["1", "2"]);
    expect(stream.messageCount).toBe(2);
  });

  it("is the same messages as the whole tree has", () => {
    const interchange = first(parseInterchanges(bytesOf(text)).interchanges);
    const group = first(interchange.items as Group[]);
    const streamed = [...parseMessages(bytesOf(text))].map((m) => [m.start, m.end]);
    expect(streamed).toEqual((group.items as Message[]).map((m) => [m.start, m.end]));
  });

  it("reads its input once", () => {
    const stream = parseMessages(bytesOf(text));
    expect([...stream]).toHaveLength(2);
    expect([...stream]).toEqual([]);
  });

  it("delivers the messages before a cut, then throws the tokenizer's error", () => {
    const cut = `${ENVELOPE}UNH+1+X'BGM+1'UNT+2+1'UNH+2+X'BGM+2'UNT+2`;
    const seen: (string | undefined)[] = [];
    expect(() => {
      for (const message of parseMessages(bytesOf(cut))) {
        seen.push(message.unh.text(1));
      }
    }).toThrow(TokenizeError);
    expect(seen).toEqual(["1"]);
    expect(() => parseInterchanges(bytesOf(cut))).toThrow(TokenizeError);
  });

  it("tells the issues it found while it read", () => {
    const stream = parseMessages(bytesOf(`${ENVELOPE}UNH+1+X'FTX+AAI+++lower'UNT+2+1'UNZ+1+IC1'`));
    expect([...stream]).toHaveLength(1);
    expect(stream.issues.map((i) => i.code)).toEqual(["INVALID_CHARACTER"]);
    expect(stream.issueCount).toBe(1);
  });

  it("gives the same messages whatever the tokenizer's batch size", () => {
    const small = [...parseMessages(bytesOf(text), { batchSize: 2 })].map((m) => [m.start, m.end]);
    const normal = [...parseMessages(bytesOf(text))].map((m) => [m.start, m.end]);
    expect(small).toEqual(normal);
  });
});

describe("memory budget", () => {
  const order = (lines: number) => generateOrders({ messages: 1, linesPerMessage: lines });

  it("refuses a message that needs more than the budget, naming where it starts", () => {
    const { bytes } = order(200);
    let error: unknown;
    try {
      for (const _message of parseMessages(bytes, { memoryBudget: 4096 })) {
        // Nothing fits in 4 KiB.
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({
      code: "MESSAGE_TOO_LARGE",
      tag: expect.stringMatching(/^[A-Z0-9]{3}$/),
    });
    expect((error as ParseError).message).toContain("memory budget of 4096 bytes");
    expect((error as ParseError).line).toBeGreaterThan(0);
  });

  it("delivers the messages that fit before one that does not", () => {
    const small = generateOrders({ messages: 3, linesPerMessage: 1 }).bytes;
    const text = Buffer.from(small).toString("latin1");
    const big = Buffer.from(generateOrders({ messages: 1, linesPerMessage: 400 }).bytes).toString(
      "latin1",
    );
    // One big message at the end of three small ones.
    const mixed = bytesOf(text.replace("UNZ+3+IC000001'\n", "") + big.slice(big.indexOf("UNH+")));
    const seen: number[] = [];
    expect(() => {
      for (const message of parseMessages(mixed, { memoryBudget: 16 * 1024 })) {
        seen.push(message.segmentCount);
      }
    }).toThrow(ParseError);
    expect(seen).toHaveLength(3);
  });

  it("says where the message that is too large starts: offset, line and column", () => {
    const small = "UNH+1+X'BGM+1'UNT+2+1'\n";
    const big = `UNH+2+X'${"FTX+AAI+++SAMPLE TEXT'".repeat(600)}UNT+602+2'\n`;
    const text = `${ENVELOPE}\n${small}${small}${big}`;
    let error: ParseError | undefined;
    try {
      for (const _message of parseMessages(bytesOf(text), { memoryBudget: 16 * 1024 })) {
        // The two small messages fit.
      }
    } catch (caught) {
      error = caught as ParseError;
    }
    expect(error).toBeInstanceOf(ParseError);
    expect(error?.offset).toBe(text.indexOf("UNH+2"));
    expect([error?.line, error?.column]).toEqual([4, 1]);
    expect(error?.message).toContain("line 4, column 1");
  });

  it("also bounds the segments that are not in a message", () => {
    const text = `${ENVELOPE}${"FTX+AAI+++SAMPLE TEXT'".repeat(2000)}UNZ+0+IC1'`;
    expect(() => parseInterchanges(bytesOf(text), { memoryBudget: 8192 })).toThrow(ParseError);
    try {
      parseInterchanges(bytesOf(text), { memoryBudget: 8192 });
    } catch (error) {
      expect((error as ParseError).message).toContain("outside any message");
    }
    // ... and parses with a budget big enough for them.
    expect(
      parseInterchanges(bytesOf(text), { memoryBudget: 1024 * 1024 }).interchanges,
    ).toHaveLength(1);
  });

  it("never goes over the budget it was given", () => {
    const { bytes } = generateOrders({ messages: 20, linesPerMessage: 10 });
    const stream = parseMessages(bytes, { memoryBudget: 64 * 1024 });
    expect([...stream]).toHaveLength(20);
    expect(stream.peakWorkingBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("checks the budget it is given", () => {
    for (const memoryBudget of [0, 4095, 1.5, Number.NaN]) {
      expect(() => parseMessages(new Uint8Array(0), { memoryBudget })).toThrow(RangeError);
    }
    expect(() => parseMessages(new Uint8Array(0), { maxIssues: -1 })).toThrow(RangeError);
  });

  it("parses a large interchange one message at a time with a few KiB of working memory", () => {
    const { bytes, messages } = generateOrders({ messages: 2500, linesPerMessage: 80 });
    expect(bytes.length).toBeGreaterThan(20_000_000);
    const stream = parseMessages(bytes, { memoryBudget: 1024 * 1024 });
    let count = 0;
    let segments = 0;
    for (const message of stream) {
      count++;
      segments += message.segmentCount;
    }
    expect(count).toBe(messages.length);
    expect(segments).toBe(messages.length * 408);
    expect(stream.issueCount).toBe(0);
    // About 4 times the size of one 8.5 KB message, not of the 20 MB file.
    expect(stream.peakWorkingBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(stream.peakWorkingBytes).toBeLessThan(bytes.length / 20);
  });
});

describe("an interchange that is only a UNA string", () => {
  it("is an interchange of its own, with the 9 bytes of its UNA", () => {
    const { interchanges } = parseInterchanges(bytesOf("UNA:+.? '"));
    expect(interchanges).toHaveLength(1);
    const [only] = interchanges;
    expect(only?.index).toBe(0);
    expect(only?.una).toEqual({ kind: "una", start: 0, end: 9, text: ":+.? '" });
    expect([only?.start, only?.end]).toEqual([0, 9]);
    expect(only?.items).toEqual([]);
    expect(only?.unb).toBeNull();
  });

  it("keeps its place and its index among the others, before and after", () => {
    const text = "UNA:+.? 'UNA:+.? 'UNB+UNOA:3'UNZ+0+1'UNA;*,! %";
    const { interchanges } = parseInterchanges(bytesOf(text));
    expect(interchanges.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(interchanges.map((i) => i.una?.text)).toEqual([":+.? '", ":+.? '", ";*,! %"]);
    expect(interchanges.map((i) => [i.start, i.end])).toEqual([
      [0, 9],
      [9, text.indexOf(";*,! %") - 3],
      [text.length - 9, text.length],
    ]);
    expect(interchanges.map((i) => i.unz !== null)).toEqual([false, true, false]);
  });
});

describe("the segments between messages, in a stream", () => {
  const text = `${ENVELOPE}UNG+X+A+B'UNH+1+X'BGM+1'UNT+2+1'FTX+AAI'UNH+2+X'UNT+1+2'UNE+2+G1'UNZ+2+IC1'`;

  it("come out as envelope items, in file order, with the messages", () => {
    const stream = parseMessages(bytesOf(text));
    const items = [...stream.items()];
    expect(items.map((i) => i.kind)).toEqual([
      "envelope",
      "message",
      "envelope",
      "message",
      "envelope",
    ]);
    const tagsOf = (item: Envelope | Message) =>
      item.kind === "envelope" ? tags(item.segments) : [];
    expect(items.map(tagsOf)).toEqual([["UNB", "UNG"], [], ["FTX"], [], ["UNE", "UNZ"]]);
    const [first, , loose, , last] = items as Envelope[];
    expect(text.slice(first?.start, first?.end)).toBe(`${ENVELOPE}UNG+X+A+B'`);
    expect(text.slice(loose?.start, loose?.end)).toBe("FTX+AAI'");
    expect(last?.end).toBe(text.length);
    expect(last?.interchange.unb?.tag).toBe("UNB");
    expect(stream.messageCount).toBe(2);
  });

  it("let a validator check the counts of UNE and UNZ against the messages it has seen", () => {
    let messages = 0;
    let unz: string | undefined;
    for (const item of parseMessages(bytesOf(text)).items()) {
      if (item.kind === "message") {
        messages++;
      } else {
        unz = item.segments.find((s) => s.tag === "UNZ")?.text(1) ?? unz;
      }
    }
    expect(unz).toBe("2");
    expect(messages).toBe(Number(unz));
  });

  it("are one pass with the plain loop over the messages: whichever starts first reads the file", () => {
    const stream = parseMessages(bytesOf(text));
    const messages = [...stream];
    expect(messages).toHaveLength(2);
    expect([...stream.items()]).toEqual([]);
    const other = parseMessages(bytesOf(text));
    expect([...other.items()]).toHaveLength(5);
    expect([...other]).toEqual([]);
  });
});

describe("the memory budget, array by array", () => {
  const fails = (text: string, memoryBudget: number): ParseError | undefined => {
    try {
      for (const _item of parseMessages(bytesOf(text), { memoryBudget }).items()) {
        // Read to the end.
      }
    } catch (error) {
      return error as ParseError;
    }
    return undefined;
  };

  it.each([
    ["a run of segments with no element", `${ENVELOPE}${"ABC'".repeat(20_000)}`],
    ["a run of empty elements", `${ENVELOPE}FTX${"+".repeat(300_000)}'`],
    ["a run of empty components", `${ENVELOPE}FTX+${":".repeat(300_000)}'`],
    [
      "a message of segments with no element",
      `${ENVELOPE}UNH+1+X'${"ABC'".repeat(20_000)}UNT+1+1'`,
    ],
  ])("stops %s well before it has used the memory it asks for", (_name, text) => {
    const error = fails(text, 64 * 1024);
    expect(error?.code).toBe("MESSAGE_TOO_LARGE");
    expect(error?.message).toContain("memory budget of 65536 bytes");
  });

  it("lets a message grow to the limit, not to the double of what it needs", () => {
    const colons = ":".repeat(600_000);
    const text = `${ENVELOPE}UNH+1+X'FTX+${colons}'UNT+3+1'`;
    expect(fails(text, 8 * 1024 * 1024)).toBeUndefined();
    expect(fails(text, 6 * 1024 * 1024)?.code).toBe("MESSAGE_TOO_LARGE");
  });

  it("is monotonic: a message that fits a budget fits any larger one, within it", () => {
    const text = `${ENVELOPE}UNH+1+X'${"FTX+AAI+++SAMPLE TEXT:MORE'".repeat(300)}UNT+302+1'`;
    let fitted = false;
    for (let budget = 4096; budget <= 64 * 1024; budget += 1024) {
      const stream = parseMessages(bytesOf(text), { memoryBudget: budget });
      let ok = true;
      try {
        for (const _message of stream) {
          // Read to the end.
        }
      } catch (error) {
        expect((error as ParseError).code).toBe("MESSAGE_TOO_LARGE");
        ok = false;
      }
      expect(ok || !fitted, `budget ${budget}`).toBe(true);
      if (ok) {
        fitted = true;
        expect(stream.peakWorkingBytes).toBeLessThanOrEqual(budget);
      }
    }
    expect(fitted).toBe(true);
  });

  it("reports the peak of the arrays: the start size for a tiny message, more for a big one", () => {
    const tiny = parseMessages(bytesOf(`${ENVELOPE}UNH+1+X'UNT+1+1'`));
    [...tiny];
    expect(tiny.peakWorkingBytes).toBe(16 * 16 + 32 * 10 + 64 * 11);
    const big = parseMessages(
      bytesOf(`${ENVELOPE}UNH+1+X'${"FTX+AAI+++A:B'".repeat(500)}UNT+2+1'`),
    );
    [...big];
    expect(big.peakWorkingBytes).toBeGreaterThan(tiny.peakWorkingBytes);
    expect(big.peakWorkingBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it.each([
    ["segments", `${ENVELOPE}UNH+1+X'${"ABC'".repeat(2000)}UNT+1+1'`],
    ["elements", `${ENVELOPE}UNH+1+X'FTX${"+".repeat(2000)}'UNT+1+1'`],
    ["components", `${ENVELOPE}UNH+1+X'FTX+${":".repeat(2000)}'UNT+1+1'`],
  ])("notes the peak when only the %s arrays have grown", (_name, text) => {
    const stream = parseMessages(bytesOf(text));
    [...stream];
    expect(stream.peakWorkingBytes).toBeGreaterThan(16 * 16 + 32 * 10 + 64 * 11);
  });

  it("places the error at the segment where its unit starts, whatever segment overflowed", () => {
    const text = `${ENVELOPE}UNH+1+X'${"NAD+BY+9520000000011::9'".repeat(300)}UNT+302+1'`;
    const error = fails(text, 4096);
    expect(error).toMatchObject({ code: "MESSAGE_TOO_LARGE", segment: 2, tag: "UNH" });
    expect(error?.offset).toBe(ENVELOPE.length);
  });

  it("refuses a budget above 2 GiB, which no typed array could back", () => {
    for (const memoryBudget of [2 ** 31 + 1, 2 ** 40]) {
      expect(() => parseMessages(new Uint8Array(0), { memoryBudget })).toThrow(RangeError);
    }
    expect(() => parseMessages(new Uint8Array(0), { memoryBudget: 2 ** 31 })).not.toThrow();
  });
});

describe("repetitions", () => {
  const una = "UNA:+.?*'UNB+UNOA:3'";

  it("count up to 65,535 in an element", () => {
    const text = `${una}FTX+${"A*".repeat(65_534)}A'`;
    const [ftx] = [...(parseInterchanges(bytesOf(text)).interchanges[0]?.segments() ?? [])].slice(
      1,
    );
    expect(ftx?.element(1)?.repetitions).toHaveLength(65_535);
  });

  it("stop the parse with a message of their own at 65,536, never wrap round", () => {
    const text = `${una}UNH+1+X'FTX+${"A*".repeat(65_535)}A'UNT+3+1'`;
    let error: ParseError | undefined;
    try {
      parseInterchanges(bytesOf(text));
    } catch (caught) {
      error = caught as ParseError;
    }
    expect(error?.code).toBe("TOO_MANY_REPETITIONS");
    expect(error?.message).toContain("65535 repetitions");
    expect(error?.message).not.toContain("memoryBudget");
    // Placed where the message that holds the element starts.
    expect([error?.segment, error?.tag]).toEqual([2, "UNH"]);
  });

  it("keep their own counts in a message that is kept while others are read", () => {
    const text = `${una}${["UNH+1+X'FTX+A*B*C'UNT+2+1'", "UNH+2+X'FTX+A'UNT+2+2'", "UNH+3+X'FTX+A*B*C*D*E'UNT+2+3'"].join("")}`;
    const kept = [...parseMessages(bytesOf(text))];
    const counts = kept.map((m) => m.segments[1]?.element(1)?.repetitions.length);
    expect(counts).toEqual([3, 1, 5]);
    expect(
      kept.map((m) => m.segments[1]?.element(1)?.repetitions.map((r) => r.map((c) => c.text()))),
    ).toEqual([[["A"], ["B"], ["C"]], [["A"]], [["A"], ["B"], ["C"], ["D"], ["E"]]]);
  });
});

describe("reaching a node that is not there", () => {
  const ftx = [...parse(`${ENVELOPE}FTX+AAI+++A:B'UNZ+0+IC1'`).segments()][1] as Segment;

  it.each([
    ["element 0", () => ftx.element(0)],
    ["element 1.5", () => ftx.element(1.5)],
    ["element NaN", () => ftx.element(Number.NaN)],
    ["element 9", () => ftx.element(9)],
    ["component 0 of element 4", () => ftx.component(4, 0)],
    ["component 1.5 of element 4", () => ftx.component(4, 1.5)],
    ["component 3 of element 4", () => ftx.component(4, 3)],
    ["component 1 of element 0", () => ftx.component(0, 1)],
    ["component 1 of element 1.5", () => ftx.component(1.5, 1)],
    ["component 1 of element 5", () => ftx.component(5, 1)],
  ])("gives undefined for %s", (_name, reach) => {
    expect(reach()).toBeUndefined();
  });

  it("still gives the nodes that are there, next to the ones that are not", () => {
    expect(ftx.component(4, 1)?.text()).toBe("A");
    expect(ftx.component(4, 2)?.text()).toBe("B");
    expect(ftx.element(4)?.components).toHaveLength(2);
  });
});

describe("groups that end without UNE", () => {
  it("end where their last message ends, when UNG or UNZ closes them", () => {
    const text = `${ENVELOPE}UNG+X+A+B'UNH+1+X'UNT+1+1'UNG+X+C+D'UNH+2+X'UNT+1+2'UNH+3+X'UNT+1+3'UNZ+2+IC1'`;
    const interchange = parse(text);
    const [first, second] = interchange.items as Group[];
    expect(text.slice(first?.start, first?.end)).toBe("UNG+X+A+B'UNH+1+X'UNT+1+1'");
    expect(text.slice(second?.start, second?.end)).toBe(
      "UNG+X+C+D'UNH+2+X'UNT+1+2'UNH+3+X'UNT+1+3'",
    );
    expect(first?.une).toBeNull();
    expect(second?.une).toBeNull();
    expect(second?.items).toHaveLength(2);
  });
});

describe("bytes read from a Node.js Buffer", () => {
  it("are copied by bytes(), so that writing to the copy does not change the file or its text", () => {
    const input = Buffer.from(`${ENVELOPE}FTX+AAI+++ABC:D?+E'UNZ+0+IC1'`);
    const interchange = first(parseInterchanges(input).interchanges);
    const ftx = [...interchange.segments()][1] as Segment;
    for (const [e, c, text] of [
      [4, 1, "ABC"],
      [4, 2, "D+E"],
    ] as const) {
      const copy = ftx.component(e, c)?.bytes() as Uint8Array;
      expect(Buffer.isBuffer(copy)).toBe(false);
      copy.fill(0x58);
      expect(ftx.component(e, c)?.text()).toBe(text);
    }
    expect(input.toString("latin1")).toBe(`${ENVELOPE}FTX+AAI+++ABC:D?+E'UNZ+0+IC1'`);
  });

  it("parse like a plain Uint8Array", () => {
    const text = `${ENVELOPE}UNH+1+X'UNT+1+1'`;
    expect([...parseMessages(Buffer.from(text))]).toHaveLength(1);
  });
});

describe("the list of segments of a message", () => {
  const message = first([...parseMessages(bytesOf(`${ENVELOPE}UNH+1+X'BGM+1'UNT+2+1'`))]);

  it("cannot be changed by whoever reads it, and gives the same UNH each time", () => {
    expect(() => (message.segments as Segment[]).push(message.unh)).toThrow(TypeError);
    expect(message.segments).toBe(message.segments);
    expect(message.unh).toBe(message.unh);
    expect(message.segments).toHaveLength(3);
  });
});

describe("an element with a very large number of components", () => {
  it("answers the position of any of them at once", () => {
    const count = 200_000;
    const text = `${ENVELOPE}FTX+${"A:".repeat(count - 1)}A'UNZ+0+IC1'`;
    const ftx = [...parse(text).segments()][1] as Segment;
    const components = ftx.element(1)?.components ?? [];
    expect(components).toHaveLength(count);
    const started = performance.now();
    for (const at of [0, 1, 2, 1000, 99_999, count - 2, count - 1]) {
      expect(components[at]?.position).toEqual({
        segment: 2,
        tag: "FTX",
        element: 1,
        component: at + 1,
      });
    }
    // Every component's position, in a time that a walk over the element for each could not meet.
    for (let at = 0; at < count; at += 1) {
      components[at]?.position;
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("the memory of the whole tree", () => {
  it("is capped, so that a file of tiny messages cannot cost hundreds of times its size", () => {
    const text = `${ENVELOPE}${"UNH+1+X'UNT+1+1'".repeat(30_000)}`;
    let error: ParseError | undefined;
    try {
      parseInterchanges(bytesOf(text), { maxTreeBytes: 8 * 1024 * 1024 });
    } catch (caught) {
      error = caught as ParseError;
    }
    expect(error).toMatchObject({ code: "TREE_TOO_LARGE", segment: 0, tag: "UNH" });
    expect(error?.message).toContain("parseMessages");
    expect(error?.offset).toBeGreaterThan(ENVELOPE.length);
    expect(error?.line).toBe(1);
  });

  it("is capped for a file of interchanges as well", () => {
    const text = "UNB+UNOA:3'".repeat(30_000);
    expect(() => parseInterchanges(bytesOf(text), { maxTreeBytes: 8 * 1024 * 1024 })).toThrow(
      ParseError,
    );
  });

  it("does not touch a file that is within it, nor the stream", () => {
    const text = `${ENVELOPE}${"UNH+1+X'UNT+1+1'".repeat(30_000)}`;
    expect([...parseMessages(bytesOf(text), { maxTreeBytes: 4096 })]).toHaveLength(30_000);
    expect(parseInterchanges(bytesOf(text)).interchanges[0]?.items).toHaveLength(30_000);
  });

  it("must be a whole number of at least 4096", () => {
    for (const maxTreeBytes of [0, 4095, 1.5, Number.NaN]) {
      expect(() => parseInterchanges(new Uint8Array(0), { maxTreeBytes })).toThrow(RangeError);
    }
  });
});
