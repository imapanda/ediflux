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
 * Lines and columns of offsets that come in increasing order, in one pass over the bytes in all:
 * for a list of problems found while reading a file, which is how the splitter uses it. An offset
 * below the last one is still answered correctly, by starting again from the beginning.
 */
export class LineCursor {
  readonly #bytes: Uint8Array;
  #offset = 0;
  #line = 1;
  #lineStart = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  advanceTo(offset: number): LineColumn {
    const bytes = this.#bytes;
    if (offset < this.#offset) {
      this.#offset = 0;
      this.#line = 1;
      this.#lineStart = 0;
    }
    let line = this.#line;
    let lineStart = this.#lineStart;
    for (let i = this.#offset; i < offset; i++) {
      const byte = bytes[i];
      if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
        line++;
        lineStart = i + 1;
      }
    }
    this.#offset = offset;
    this.#line = line;
    this.#lineStart = lineStart;
    return { line, column: offset - lineStart + 1 };
  }
}

const BLOCK = 1 << 16;

/**
 * Maps byte offsets to lines and columns for many lookups. It remembers the line at the start of
 * every 64 KiB block (two numbers per block, 3 KiB for 100 MB) and scans at most one block per
 * lookup, so building it costs one pass and its memory does not depend on the number of lines.
 * Same line rules as {@link scanLocate}.
 */
export class LineIndex {
  readonly #bytes: Uint8Array;
  /** Lines ended before the first byte of each block. */
  readonly #linesBefore: Uint32Array;
  /** Offset of the start of the line that holds the first byte of each block. */
  readonly #lineStartAt: Uint32Array;

  constructor(bytes: Uint8Array) {
    const length = bytes.length;
    const blocks = Math.floor(length / BLOCK) + 1;
    const linesBefore = new Uint32Array(blocks);
    const lineStartAt = new Uint32Array(blocks);
    let lines = 0;
    let lineStart = 0;
    for (let block = 0; block < blocks; block++) {
      linesBefore[block] = lines;
      lineStartAt[block] = lineStart;
      const end = Math.min(length, (block + 1) * BLOCK);
      for (let i = block * BLOCK; i < end; i++) {
        const byte = bytes[i];
        if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
          lines++;
          lineStart = i + 1;
        }
      }
    }
    this.#bytes = bytes;
    this.#linesBefore = linesBefore;
    this.#lineStartAt = lineStartAt;
  }

  /** `offset` may be the length of the input, the position just after its last byte. */
  locate(offset: number): LineColumn {
    const bytes = this.#bytes;
    const block = Math.floor(offset / BLOCK);
    let lines = this.#linesBefore[block] as number;
    let lineStart = this.#lineStartAt[block] as number;
    for (let i = block * BLOCK; i < offset; i++) {
      const byte = bytes[i];
      if (byte === 0x0a || (byte === 0x0d && bytes[i + 1] !== 0x0a)) {
        lines++;
        lineStart = i + 1;
      }
    }
    return { line: lines + 1, column: offset - lineStart + 1 };
  }
}
