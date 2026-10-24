import type { CharacterSet } from "./charset.ts";
import type { LineColumn } from "./line-index.ts";
import type { Separators } from "./separators.ts";

export interface Span {
  /** Offset of the first byte, from the start of the input. */
  readonly start: number;
  /** Offset just after the last byte. */
  readonly end: number;
}

/**
 * Where something is, in the terms of the sample corpus, the registry and the validator: the
 * number of its segment in the interchange (UNA is 0, UNB is 1), the tag, and its element and
 * component counted from 1. A composite counts as one element and an empty element counts.
 * `element` and `component` are null when the position is that of a whole segment or element.
 */
export interface Position {
  readonly segment: number;
  readonly tag: string;
  readonly element: number | null;
  readonly component: number | null;
}

/** The UNA string. */
export interface ServiceStringAdvice extends Span {
  readonly kind: "una";
  /** The six service characters, as written. */
  readonly text: string;
}

/** What is known about an interchange as soon as its UNB segment has been read. */
export interface InterchangeInfo {
  /** Which interchange of the file, from 0. */
  readonly index: number;
  readonly source: Uint8Array;
  readonly una: ServiceStringAdvice | null;
  readonly separators: Separators;
  /**
   * The first component of S001, read as ISO 646: UNOA, UNOB, UNOC, UNOW or whatever was written,
   * at most 32 characters (anything not printable ASCII shown as `?`, `...` after a cut).
   */
  readonly syntaxIdentifier: string | null;
  /** The second component of S001, read the same way. Not checked here. */
  readonly syntaxVersion: string | null;
  /** The character set values are decoded with; null when the name is missing or not supported. */
  readonly characterSet: CharacterSet | null;
  /** The UNB segment. */
  readonly unb: Span | null;
  /** Line and column of a byte offset. The first call reads the file once. */
  locate(offset: number): LineColumn;
}

export const ParseIssueCode = {
  /** A value has a character that the character set of the interchange does not allow. */
  InvalidCharacter: "INVALID_CHARACTER",
  /** UNB names a character set that is not supported. */
  UnsupportedCharset: "UNSUPPORTED_CHARSET",
} as const;

export type ParseIssueCode = (typeof ParseIssueCode)[keyof typeof ParseIssueCode];

/**
 * A problem that does not stop the parse: nothing is lost, and the validator (issues #43 to
 * #45) decides what to do with it. The codes are those of the sample corpus.
 */
export interface ParseIssue {
  readonly code: ParseIssueCode;
  readonly message: string;
  /** What the rules ask for, as a short phrase. */
  readonly expected: string;
  /** What the file has. */
  readonly found: string;
  /**
   * The 1-based number of the repetition of the element, counted from the second: null for the
   * first, which is the element itself. `position.component` counts within the repetition.
   */
  readonly repetition: number | null;
  /** Offset of the byte at fault. */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly position: Position;
}
