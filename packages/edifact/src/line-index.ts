/** A position in the input: line and column both start at 1, and columns count bytes. */
export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/**
 * Line and column of a byte offset, by one pass over the bytes before it and no allocation.
 * Errors use this, so that reporting a problem in a huge file costs time but never memory.
 *
 * A line ends at LF, at CR LF, or at a CR that is not followed by LF.
 */
export function scanLocate(bytes: Uint8Array, offset: number): LineColumn {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const byte = bytes[i];
    if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Maps byte offsets to lines and columns quickly, for many lookups. It holds four bytes per line
 * of the input, so it is built only when someone asks for it ({@link Tokenizer.locate}), never to
 * report an error. Same line rules as {@link scanLocate}.
 */
export class LineIndex {
  readonly #lineStarts: Uint32Array;

  constructor(bytes: Uint8Array) {
    const length = bytes.length;
    let lines = 1;
    for (let i = 0; i < length; i++) {
      const byte = bytes[i];
      if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
        lines++;
      }
    }
    const starts = new Uint32Array(lines);
    let line = 1;
    for (let i = 0; i < length; i++) {
      const byte = bytes[i];
      if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
        starts[line++] = i + 1;
      }
    }
    this.#lineStarts = starts;
  }

  /** `offset` may be the length of the input, the position just after its last byte. */
  locate(offset: number): LineColumn {
    const starts = this.#lineStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if ((starts[middle] as number) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - (starts[low] as number) + 1 };
  }
}
