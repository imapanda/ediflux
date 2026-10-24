import { describe, expect, it } from "vitest";
import { LineCursor, LineIndex, scanLocate } from "./line-index.ts";
import { bytesOf } from "./testing/helpers.ts";

/** Bytes that are mostly text and sometimes CR, LF or CR LF, from a fixed seed. */
function sample(length: number, breakEvery: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 12345;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const roll = (state >>> 16) % breakEvery;
    bytes[i] = roll === 0 ? 0x0a : roll === 1 ? 0x0d : 0x41 + (state % 26);
  }
  return bytes;
}

describe("LineIndex", () => {
  const edges = [0, 1, 65535, 65536, 65537, 131071, 131072, 131073];

  it.each([3, 50, 100_000])(
    "agrees with a plain scan across block edges (a break about every %i bytes)",
    (breakEvery) => {
      const bytes = sample(140_000, breakEvery);
      const index = new LineIndex(bytes);
      for (const offset of [...edges, bytes.length - 1, bytes.length]) {
        expect(index.locate(offset), `offset ${offset}`).toEqual(scanLocate(bytes, offset));
      }
      for (let offset = 0; offset <= bytes.length; offset += 7919) {
        expect(index.locate(offset)).toEqual(scanLocate(bytes, offset));
      }
    },
  );

  it("counts a CR LF that straddles a block edge as one break", () => {
    const bytes = new Uint8Array(65536 + 10).fill(0x41);
    bytes[65535] = 0x0d;
    bytes[65536] = 0x0a;
    const index = new LineIndex(bytes);
    expect(index.locate(65536)).toEqual({ line: 1, column: 65537 });
    expect(index.locate(65537)).toEqual({ line: 2, column: 1 });
  });

  it("handles an input that is exactly a whole number of blocks, and an empty one", () => {
    const bytes = new Uint8Array(65536).fill(0x41);
    expect(new LineIndex(bytes).locate(65536)).toEqual({ line: 1, column: 65537 });
    expect(new LineIndex(new Uint8Array(0)).locate(0)).toEqual({ line: 1, column: 1 });
  });

  it("keeps a line that is longer than a block", () => {
    const bytes = new Uint8Array(200_000).fill(0x41);
    bytes[10] = 0x0a;
    expect(new LineIndex(bytes).locate(199_999)).toEqual({ line: 2, column: 199_989 });
  });
});

describe("LineCursor", () => {
  it.each([3, 50, 100_000])(
    "agrees with a plain scan on offsets that grow (a break about every %i bytes)",
    (breakEvery) => {
      const bytes = sample(140_000, breakEvery);
      const cursor = new LineCursor(bytes);
      for (let offset = 0; offset <= bytes.length; offset += 6007) {
        expect(cursor.advanceTo(offset), `offset ${offset}`).toEqual(scanLocate(bytes, offset));
      }
      expect(cursor.advanceTo(bytes.length)).toEqual(scanLocate(bytes, bytes.length));
    },
  );

  it("answers the same offset twice, and an offset below the last one, correctly", () => {
    const bytes = sample(5000, 20);
    const cursor = new LineCursor(bytes);
    expect(cursor.advanceTo(4000)).toEqual(scanLocate(bytes, 4000));
    expect(cursor.advanceTo(4000)).toEqual(scanLocate(bytes, 4000));
    expect(cursor.advanceTo(10)).toEqual(scanLocate(bytes, 10));
    expect(cursor.advanceTo(0)).toEqual({ line: 1, column: 1 });
    expect(cursor.advanceTo(5000)).toEqual(scanLocate(bytes, 5000));
  });

  it("counts a CR LF as one break whichever call crosses it", () => {
    const bytes = bytesOf("ab\r\ncd");
    const cursor = new LineCursor(bytes);
    expect(cursor.advanceTo(3)).toEqual({ line: 1, column: 4 }); // between CR and LF
    expect(cursor.advanceTo(4)).toEqual({ line: 2, column: 1 });
  });
});
