import { type Interchange, Tokenizer, TokenKind, unescapeValue } from "../index.ts";
import { textOf } from "./helpers.ts";

/** A data element as the expected-result files of samples/edifact write it. */
export type ElementModel = string[] | { repetitions: string[][] };

export interface SegmentModel {
  tag: string;
  elements: ElementModel[];
}

export interface InterchangeModel {
  /** The six service characters of UNA, or null when the file has none. */
  una: string | null;
  segments: SegmentModel[];
}

/**
 * Rebuilds segments, elements and components from the tokens, in the shape of the
 * `.expected.json` files. This is the job of the parser (issue #39); the tests need a throwaway
 * version of it to compare the tokenizer with files that were written without it.
 */
export function readSegments(bytes: Uint8Array, encoding: "latin1" | "utf8"): InterchangeModel {
  const model: InterchangeModel = { una: null, segments: [] };
  let release = 0x3f;
  let current: SegmentModel | null = null;
  let inElement = false;
  let repetitions: string[][] = [];
  let parts: string[] = [];
  let index = 0;

  const closeRepetition = (): string[] => {
    const length = index > 0 || parts.length > 0 ? index + 1 : 0;
    return Array.from({ length }, (_unused, i) => parts[i] ?? "");
  };
  const closeElement = (): void => {
    if (current !== null && inElement) {
      const last = closeRepetition();
      current.elements.push(
        repetitions.length > 0 ? { repetitions: [...repetitions, last] } : last,
      );
    }
    inElement = false;
    repetitions = [];
    parts = [];
    index = 0;
  };

  for (const batch of new Tokenizer(bytes)) {
    release = batch.separators.release;
    for (let i = 0; i < batch.length; i++) {
      const start = batch.starts[i] as number;
      const end = batch.ends[i] as number;
      switch (batch.kinds[i]) {
        case TokenKind.ServiceStringAdvice:
          model.una = textOf(bytes, start + 3, end);
          break;
        case TokenKind.SegmentTag:
          closeElement();
          current = {
            tag: textOf(bytes, start, end),
            elements: [],
          };
          model.segments.push(current);
          break;
        case TokenKind.ElementSeparator:
          closeElement();
          inElement = true;
          break;
        case TokenKind.ComponentSeparator:
          index++;
          break;
        case TokenKind.RepetitionSeparator:
          repetitions.push(closeRepetition());
          parts = [];
          index = 0;
          break;
        case TokenKind.Text:
          parts[index] = Buffer.from(bytes.subarray(start, end)).toString(encoding);
          break;
        case TokenKind.EscapedText:
          parts[index] = Buffer.from(unescapeValue(bytes, start, end, release)).toString(encoding);
          break;
        case TokenKind.SegmentTerminator:
          closeElement();
          break;
      }
    }
  }
  return model;
}

/** The same shape as {@link readSegments}, read from the tree instead of from the tokens. */
export function treeToModel(interchange: Interchange): InterchangeModel {
  return {
    una: interchange.una === null ? null : interchange.una.text,
    segments: [...interchange.segments()].map((segment) => ({
      tag: segment.tag,
      elements: segment.elements.map((element) =>
        element.repetitions.length > 1
          ? { repetitions: element.repetitions.map((r) => r.map((c) => c.text())) }
          : element.components.map((c) => c.text()),
      ),
    })),
  };
}
