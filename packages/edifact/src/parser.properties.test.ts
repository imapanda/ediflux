import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Group,
  type Interchange,
  type Message,
  parseInterchanges,
  parseMessages,
  type Segment,
  TokenizeError,
  TokenKind,
} from "./index.ts";
import { tokenize } from "./testing/helpers.ts";
import { readSegments, treeToModel } from "./testing/segments.ts";
import {
  buildInterchange,
  type ElementSpec,
  interchangeArbitrary,
  tagArbitrary,
} from "./testing/writer.ts";

/** What a repetition of an element holds: nothing at all if its only component is empty. */
function expectedComponents(repetition: Uint8Array[]): Uint8Array[] {
  return repetition.length === 1 && repetition[0]?.length === 0 ? [] : repetition;
}

const array = (bytes: Uint8Array): number[] => Array.from(bytes);

describe("a tree of segments written from a model", () => {
  it("has the segments, elements, repetitions and components of the model, with the bytes' own spans", () => {
    fc.assert(
      fc.property(interchangeArbitrary, (spec) => {
        const built = buildInterchange(spec);
        const { interchanges, issues } = parseInterchanges(built.bytes);

        expect(issues).toEqual([]);
        expect(interchanges).toHaveLength(1);
        const segments = [...(interchanges[0] as Interchange).segments()];
        expect(segments).toHaveLength(spec.segments.length);

        const valueTokens = built.tokens.filter(
          (t) => t.kind === TokenKind.Text || t.kind === TokenKind.EscapedText,
        );
        const tags = built.tokens.filter((t) => t.kind === TokenKind.SegmentTag);
        const terminators = built.tokens.filter((t) => t.kind === TokenKind.SegmentTerminator);
        let valueIndex = 0;

        spec.segments.forEach((expected, s) => {
          const segment = segments[s] as Segment;
          expect(segment.tag).toBe(expected.tag);
          expect(segment.number).toBe(s + 1);
          expect(segment.start).toBe(tags[s]?.start);
          expect(segment.end).toBe(terminators[s]?.end);
          expect(segment.elements).toHaveLength(expected.elements.length);

          expected.elements.forEach((spec: ElementSpec, e) => {
            const element = segment.elements[e];
            expect(element?.repetitions).toHaveLength(spec.length);
            spec.forEach((repetition, r) => {
              const components = element?.repetitions[r] ?? [];
              const wanted = expectedComponents(repetition);
              expect(components).toHaveLength(wanted.length);
              wanted.forEach((value, c) => {
                const component = components[c];
                expect(array(component?.bytes() ?? new Uint8Array())).toEqual(array(value));
                expect(component?.position).toEqual({
                  segment: s + 1,
                  tag: expected.tag,
                  element: e + 1,
                  component: c + 1,
                });
                if (value.length > 0) {
                  const token = valueTokens[valueIndex++];
                  expect(component?.start).toBe(token?.start);
                  expect(component?.end).toBe(token?.end);
                  expect(component?.empty).toBe(false);
                } else {
                  expect(component?.empty).toBe(true);
                }
              });
            });
          });
        });
        expect(valueIndex).toBe(valueTokens.length);
      }),
      { numRuns: 300 },
    );
  });

  it("says the same as the tokens do, component by component", () => {
    fc.assert(
      fc.property(interchangeArbitrary, (spec) => {
        const { bytes } = buildInterchange(spec);
        const [interchange] = parseInterchanges(bytes).interchanges;
        expect(treeToModel(interchange as Interchange)).toEqual(readSegments(bytes, "latin1"));
      }),
      { numRuns: 300 },
    );
  });

  it("does not depend on the batch size of the tokenizer", () => {
    fc.assert(
      fc.property(interchangeArbitrary, fc.integer({ min: 2, max: 11 }), (spec, batchSize) => {
        const { bytes } = buildInterchange(spec);
        const small = parseInterchanges(bytes, { batchSize }).interchanges[0] as Interchange;
        const normal = parseInterchanges(bytes).interchanges[0] as Interchange;
        const spans = (i: Interchange) => [...i.segments()].map((s) => [s.start, s.end]);
        expect(spans(small)).toEqual(spans(normal));
        expect(treeToModel(small)).toEqual(treeToModel(normal));
      }),
      { numRuns: 200 },
    );
  });
});

describe("the envelope of messages", () => {
  const body = fc.array(tagArbitrary, { maxLength: 3 });
  const file = fc.record({
    messages: fc.array(fc.record({ body, closed: fc.boolean() }), { maxLength: 4 }),
    grouped: fc.boolean(),
    endGroup: fc.boolean(),
    endInterchange: fc.boolean(),
  });

  function write(model: {
    messages: { body: string[]; closed: boolean }[];
    grouped: boolean;
    endGroup: boolean;
    endInterchange: boolean;
  }): string {
    let text = "UNB+UNOA:3+A'";
    if (model.grouped) {
      text += "UNG+X+A+B'";
    }
    model.messages.forEach(({ body: segments, closed }, m) => {
      text += `UNH+${m + 1}+X'${segments.map((t) => `${t}+1'`).join("")}`;
      text += closed ? `UNT+${segments.length + 2}+${m + 1}'` : "";
    });
    if (model.grouped && model.endGroup) {
      text += "UNE+1+G'";
    }
    return model.endInterchange ? `${text}UNZ+1+1'` : text;
  }

  it("splits into the messages written, whether or not they end with UNT, in groups or not", () => {
    fc.assert(
      fc.property(file, (model) => {
        const text = write(model);
        const bytes = new TextEncoder().encode(text);
        const { interchanges, issues } = parseInterchanges(bytes);
        expect(issues).toEqual([]);
        expect(interchanges).toHaveLength(1);
        const interchange = interchanges[0] as Interchange;

        const found: Message[] = (
          model.grouped ? (interchange.items[0] as Group).items : interchange.items
        ).filter((item): item is Message => item.kind === "message");
        expect(found).toHaveLength(model.messages.length);
        found.forEach((message, m) => {
          const wanted = model.messages[m];
          expect(message.unh.text(1)).toBe(String(m + 1));
          expect(message.segments.map((s) => s.tag)).toEqual([
            "UNH",
            ...(wanted?.body ?? []),
            ...(wanted?.closed ? ["UNT"] : []),
          ]);
          expect(message.unt === null).toBe(!wanted?.closed);
          expect(message.ung === null).toBe(!model.grouped);
        });

        // The group and the interchange end where the file says, or run to the end of the file.
        if (model.grouped) {
          const group = interchange.items[0] as Group;
          expect(group.kind).toBe("group");
          expect(group.une === null).toBe(!model.endGroup);
        }
        expect(interchange.unz === null).toBe(!model.endInterchange);
        expect(interchange.end).toBe(bytes.length);

        // The stream gives the same messages.
        const streamed = [...parseMessages(bytes)];
        expect(streamed.map((m) => [m.start, m.end])).toEqual(found.map((m) => [m.start, m.end]));
      }),
      { numRuns: 300 },
    );
  });
});

describe("character sets", () => {
  /** Printable ISO 8859-1, which is what UNOC allows, apart from the characters that split. */
  const unoc = (byte: number) => (byte >= 0x20 && byte <= 0x7e) || byte >= 0xa0;
  const splitters = [0x27, 0x2b, 0x3a, 0x3f];
  /** Level A of UNOA. */
  const unoa = (byte: number) =>
    ' .,-()/=!"%&*;<>'.includes(String.fromCharCode(byte)) ||
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a);

  it.each([
    ["UNOC", unoc],
    ["UNOA", unoa],
  ] as const)(
    "%s: a value is reported if and only if it has a byte the set does not allow",
    (name, allowed) => {
      const value = fc
        .uint8Array({ minLength: 1, maxLength: 20 })
        .filter((bytes) => bytes.every((b) => !splitters.includes(b)));
      fc.assert(
        fc.property(value, (bytes) => {
          const head = new TextEncoder().encode(`UNB+${name}:3+A'FTX+AAI+++`);
          const file = Uint8Array.from([
            ...head,
            ...bytes,
            ...new TextEncoder().encode("'UNZ+0+1'"),
          ]);
          const { issues, issueCount, interchanges } = parseInterchanges(file);
          const bad = bytes.findIndex((b) => !allowed(b));

          expect(issueCount).toBe(bad === -1 ? 0 : 1);
          if (bad !== -1) {
            expect(issues[0]).toMatchObject({
              code: "INVALID_CHARACTER",
              offset: head.length + bad,
              position: { segment: 2, tag: "FTX", element: 4, component: 1 },
            });
          }
          // Whatever the verdict, the tree holds the value as written.
          const segments = [...(interchanges[0] as Interchange).segments()];
          expect(array(segments[1]?.component(4, 1)?.bytes() ?? new Uint8Array())).toEqual(
            array(bytes),
          );
        }),
        { numRuns: 400 },
      );
    },
  );
});

describe("any bytes at all", () => {
  const arbitraryBytes = fc.oneof(
    fc.uint8Array({ maxLength: 150 }),
    fc
      .array(
        fc.constantFrom(
          "UNA:+.? '",
          "UNB+UNOA:3+A'",
          "UNH+1+X'",
          "UNT+1+1'",
          "UNZ+1+1'",
          "UNG+X+A+B'",
          "UNE+1+G'",
          "FTX+a:b'",
          "\n",
          "?",
          "'",
          "+",
          ":",
        ),
        { maxLength: 16 },
      )
      .map((chunks) => new TextEncoder().encode(chunks.join(""))),
  );

  it("parse into a consistent tree, or stop with the tokenizer's error: nothing else happens", () => {
    fc.assert(
      fc.property(arbitraryBytes, fc.integer({ min: 2, max: 9 }), (bytes, batchSize) => {
        const tokens = tokenize(bytes, batchSize);
        let result: ReturnType<typeof parseInterchanges> | null = null;
        try {
          result = parseInterchanges(bytes, { batchSize });
        } catch (error) {
          expect(error).toBeInstanceOf(TokenizeError);
          expect(tokens.error).not.toBeNull();
          expect((error as TokenizeError).code).toBe(tokens.error?.code);
          return;
        }
        expect(tokens.error).toBeNull();

        let previousEnd = 0;
        let count = 0;
        for (const interchange of result.interchanges) {
          let number = 0;
          for (const segment of interchange.segments()) {
            expect(segment.number).toBe(++number);
            expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
            expect(segment.end).toBeGreaterThan(segment.start);
            expect(segment.end).toBeLessThanOrEqual(bytes.length);
            previousEnd = segment.end;
            count++;
            for (const element of segment.elements) {
              expect(element.start).toBeGreaterThan(segment.start);
              expect(element.end).toBeLessThan(segment.end);
              for (const repetition of element.repetitions) {
                for (const component of repetition) {
                  expect(component.start).toBeGreaterThanOrEqual(element.start);
                  expect(component.end).toBeLessThanOrEqual(element.end);
                }
              }
            }
          }
        }
        // Every segment of the tokens is in some interchange, in the same order.
        expect(count).toBe(tokens.tokens.filter((t) => t.kind === TokenKind.SegmentTag).length);
        const fromTree = result.interchanges.flatMap((i) => treeToModel(i).segments);
        const fromTokens = readSegments(bytes, "latin1").segments;
        expect(fromTree).toEqual(fromTokens);
      }),
      { numRuns: 1500 },
    );
  });

  it("stream the same messages as the whole tree holds", () => {
    fc.assert(
      fc.property(arbitraryBytes, (bytes) => {
        let streamed: number[][] = [];
        let tree: number[][] = [];
        let streamError: unknown;
        let treeError: unknown;
        try {
          streamed = [...parseMessages(bytes)].map((m) => [m.start, m.end]);
        } catch (error) {
          streamError = error;
        }
        try {
          tree = parseInterchanges(bytes).interchanges.flatMap((i) =>
            i.items.flatMap((item) =>
              item.kind === "message"
                ? [[item.start, item.end]]
                : item.kind === "group"
                  ? item.items.flatMap((inner) =>
                      inner.kind === "message" ? [[inner.start, inner.end]] : [],
                    )
                  : [],
            ),
          );
        } catch (error) {
          treeError = error;
        }
        expect(streamError === undefined).toBe(treeError === undefined);
        if (treeError === undefined) {
          expect(streamed).toEqual(tree);
        } else {
          // Only the tokenizer can stop a parse of ordinary-sized input.
          expect(streamError).toBeInstanceOf(TokenizeError);
          expect(treeError).toBeInstanceOf(TokenizeError);
        }
      }),
      { numRuns: 800 },
    );
  });
});
