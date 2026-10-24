import { type LineColumn, LineIndex } from "./line-index.ts";

/** The input of a parse, shared by everything read from it. */
export class Source {
  readonly bytes: Uint8Array;
  #index: LineIndex | null = null;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Line and column of an offset. The first call reads the input once to build the index. */
  locate(offset: number): LineColumn {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.bytes.length) {
      throw new RangeError(
        `offset must be an integer from 0 to ${this.bytes.length}, not ${offset}`,
      );
    }
    this.#index ??= new LineIndex(this.bytes);
    return this.#index.locate(offset);
  }
}
