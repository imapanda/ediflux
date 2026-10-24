import type { Separators } from "./separators.ts";

/**
 * What a token is. The tokenizer finds the shape of an interchange and nothing else: it does
 * not know what a segment means and does not decode text.
 *
 * - A value is a run of bytes between two separators. It may contain release characters, which
 *   `EscapedText` flags; `Text` is guaranteed to contain none.
 * - An empty element or component has no token of its own: two separators in a row are the
 *   whole story. Every text token is directly followed by a separator token.
 */
export const TokenKind = {
  /** `UNA` and its six service characters (9 bytes). */
  ServiceStringAdvice: 1,
  /** The three characters that name a segment. Always followed by an element separator or the terminator. */
  SegmentTag: 2,
  /** A value with no release character in it: the bytes are the value. */
  Text: 3,
  /** A value with at least one release character: pass it through `unescapeValue`. */
  EscapedText: 4,
  ComponentSeparator: 5,
  ElementSeparator: 6,
  /** Syntax 4 only, and only when UNA declares the character. */
  RepetitionSeparator: 7,
  SegmentTerminator: 8,
} as const;

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

/**
 * A run of consecutive tokens, as three parallel arrays: no object per token, so scanning
 * allocates nothing and a file of any size takes the same small amount of memory.
 *
 * The tokenizer reuses one batch object for the whole file. Read it before asking for the next
 * one; copy what you need to keep. Offsets are in bytes from the start of the input. The bytes
 * between one token's `end` and the next token's `start` were skipped: line breaks between
 * segments (and a UTF-8 byte order mark before the first token). Nothing else is ever skipped.
 */
export interface TokenBatch {
  /** `kinds[i]` is a {@link TokenKind} for `i < length`. */
  readonly kinds: Uint8Array;
  /** Offset of the first byte of token `i`. */
  readonly starts: Int32Array;
  /** Offset just after the last byte of token `i`. */
  readonly ends: Int32Array;
  /** Number of tokens in this batch. */
  readonly length: number;
  /**
   * The service characters that apply to every token of this batch. A batch never mixes two
   * sets: it ends before a new UNA string, and after UNZ.
   */
  readonly separators: Separators;
}
