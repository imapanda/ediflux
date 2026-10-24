import { describe, expect, it } from "vitest";
import { parseInterchanges, parseMessages, TokenizeError } from "./index.ts";
import {
  type ExpectedInvalid,
  type ExpectedValid,
  expectedOf,
  readSample,
  samples,
} from "./testing/corpus.ts";
import { readSegments, treeToModel } from "./testing/segments.ts";

describe("valid samples", () => {
  it.each(samples("valid"))(
    "%s parses into a tree that matches its expected-result file",
    (name) => {
      const bytes = readSample("valid", name);
      const wanted = expectedOf<ExpectedValid>("valid", name);
      const { interchanges, issues } = parseInterchanges(bytes);

      expect(issues, "no issue in a valid sample").toEqual([]);
      expect(interchanges).toHaveLength(1);
      const [interchange] = interchanges;
      if (interchange === undefined) {
        throw new Error("no interchange");
      }

      // The content, component by component, as the independent tool wrote it.
      const model = treeToModel(interchange);
      expect(model.una).toBe(wanted.interchange.una);
      expect(model.segments).toEqual(wanted.segments);
      // ... and the same as what the tokens say.
      const encoding = wanted.interchange.encoding === "utf-8" ? "utf8" : "latin1";
      expect(model).toEqual(readSegments(bytes, encoding));

      // The interchange.
      expect(interchange.syntaxIdentifier).toBe(wanted.interchange.syntaxIdentifier);
      expect(interchange.syntaxVersion).toBe(String(wanted.interchange.syntaxVersion));
      expect(interchange.characterSet).toBe(wanted.interchange.syntaxIdentifier);
      expect(interchange.unb?.tag).toBe("UNB");
      expect(interchange.unz?.tag).toBe("UNZ");

      // The messages, in order, with the identifiers of UNH.
      const messages = interchange.items.flatMap((item) =>
        item.kind === "message"
          ? [item]
          : item.kind === "group"
            ? item.items.filter((i) => i.kind === "message")
            : [],
      );
      expect(messages.map((m) => m.kind === "message" && m.unh.text(1))).toEqual(
        wanted.interchange.messages.map((m) => m.reference),
      );
      expect(messages.map((m) => m.kind === "message" && m.unh.text(2, 1))).toEqual(
        wanted.interchange.messages.map((m) => m.type),
      );
      for (const message of messages) {
        expect(message.kind === "message" && message.unt?.tag).toBe("UNT");
      }
    },
  );

  it.each(samples("valid"))("%s: every node has positions that agree with the bytes", (name) => {
    const bytes = readSample("valid", name);
    const [interchange] = parseInterchanges(bytes).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange");
    }
    expect(interchange.source).toBe(bytes);

    let previousEnd = 0;
    let number = 0;
    for (const segment of interchange.segments()) {
      number++;
      // Segments are numbered from 1 (UNA is 0), in order, and do not overlap.
      expect(segment.number).toBe(number);
      expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
      expect(segment.start).toBeLessThan(segment.end);
      previousEnd = segment.end;
      const text = Buffer.from(bytes.subarray(segment.start, segment.end)).toString("latin1");
      expect(text.startsWith(segment.tag)).toBe(true);
      // Only line breaks lie between segments.
      expect(segment.position).toEqual({
        segment: number,
        tag: segment.tag,
        element: null,
        component: null,
      });

      segment.elements.forEach((element, e) => {
        expect(element.position).toEqual({
          segment: number,
          tag: segment.tag,
          element: e + 1,
          component: null,
        });
        expect(element.start).toBeGreaterThanOrEqual(segment.start + 3);
        expect(element.end).toBeLessThan(segment.end);
        expect(bytes[element.start - 1]).toBe(interchange.separators.element);
        let componentEnd = element.start;
        for (const repetition of element.repetitions) {
          repetition.forEach((component, c) => {
            expect(component.position).toEqual({
              segment: number,
              tag: segment.tag,
              element: e + 1,
              component: c + 1,
            });
            expect(component.start).toBeGreaterThanOrEqual(componentEnd);
            expect(component.end).toBeLessThanOrEqual(element.end);
            componentEnd = component.end;
            expect(component.empty).toBe(component.start === component.end);
          });
        }
      });
    }
    // The first and last bytes of the interchange.
    expect(interchange.start).toBe(interchange.una?.start ?? interchange.unb?.start);
    expect(interchange.end).toBe(interchange.unz?.end);
  });
});

describe("invalid samples", () => {
  it("a bad UNA and a cut file are tokenizer errors, which stop the parse", () => {
    for (const name of ["invalid-una", "unexpected-end-of-file"]) {
      expect(() => parseInterchanges(readSample("invalid", name)), name).toThrow(TokenizeError);
    }
  });

  it("the messages before a cut are delivered, then the error is thrown", () => {
    const bytes = readSample("invalid", "unexpected-end-of-file");
    const seen: string[] = [];
    expect(() => {
      for (const message of parseMessages(bytes)) {
        seen.push(message.unh.text(1) ?? "");
      }
    }).toThrow(TokenizeError);
    expect(seen).toEqual([]); // the one message of the sample is the one that is cut
  });

  const charsetSamples = [
    "invalid-character-unoa",
    "invalid-character-unow",
    "unsupported-charset",
  ];

  it.each(charsetSamples)(
    "%s: the character issue has the position of the expected-result file",
    (name) => {
      const { issues, interchanges } = parseInterchanges(readSample("invalid", name));
      const [wanted] = expectedOf<ExpectedInvalid>("invalid", name).expectedErrors;
      expect(interchanges).toHaveLength(1);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe(wanted?.code);
      expect(issues[0]?.position).toEqual({
        segment: wanted?.position.segment,
        tag: wanted?.position.tag,
        element: wanted?.position.element,
        component: wanted?.position.component,
      });
      expect(issues[0]?.line).toBeGreaterThan(0);
    },
  );

  it("an unsupported character set is read as ISO 8859-1 and leaves the character set unset", () => {
    const [interchange] = parseInterchanges(
      readSample("invalid", "unsupported-charset"),
    ).interchanges;
    expect(interchange?.syntaxIdentifier).toBe("UNOZ");
    expect(interchange?.characterSet).toBeNull();
  });

  it.each(
    samples("invalid").filter(
      (name) => !["invalid-una", "unexpected-end-of-file", ...charsetSamples].includes(name),
    ),
  )("%s is well formed as far as the parser goes: the validator finds its fault", (name) => {
    const { interchanges, issues } = parseInterchanges(readSample("invalid", name));
    expect(interchanges).toHaveLength(1);
    expect(issues).toEqual([]);
  });
});
