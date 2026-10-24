/**
 * The tree of a run of segments, as parallel typed arrays: no object per node, about four times
 * the size of the bytes it describes (an object tree is thirty-odd times). The views in tree.ts
 * read it; nothing outside this package should.
 *
 * Offsets are absolute: bytes from the start of the input. Counts are one past the last index
 * in the "first" arrays, so that the size of a node is the difference of two entries.
 */
export interface Store {
  readonly segmentCount: number;
  /** Offset of the first byte of the tag. */
  readonly segmentStart: Int32Array;
  /** Offset just after the terminator. */
  readonly segmentEnd: Int32Array;
  /** Number of the segment in its interchange: UNA is 0, the first segment (UNB) is 1. */
  readonly segmentNumber: Int32Array;
  /** Index of the segment's first element; one more entry than segments. */
  readonly segmentFirstElement: Int32Array;
  /** Offset of the first byte after the separator that opens the element. */
  readonly elementStart: Int32Array;
  /** Index of the element's first component; one more entry than elements. */
  readonly elementFirstComponent: Int32Array;
  /** Repetitions of the element, 1 unless the interchange uses the repetition separator. */
  readonly elementRepetitions: Uint16Array;
  readonly componentStart: Int32Array;
  readonly componentEnd: Int32Array;
  /** Bit 0: the value contains release characters. */
  readonly componentFlags: Uint8Array;
  /** Repetition (0-based) of the element that the component belongs to. */
  readonly componentRepetition: Uint16Array;
}

/**
 * A limit was reached: the working memory (`"memory"`), or the number of repetitions of one
 * element, which the store counts on 16 bits (`"repetitions"`).
 */
export class BudgetExceeded extends Error {
  readonly reason: "memory" | "repetitions";

  constructor(reason: "memory" | "repetitions") {
    super(reason);
    this.reason = reason;
  }
}

/** The most repetitions of one element. */
export const MAX_REPETITIONS = 0xffff;

const SEGMENT_BYTES = 16; // start, end, number, first element
const ELEMENT_BYTES = 10; // start, first component, repetitions
const COMPONENT_BYTES = 11; // start, end, flags, repetition

export const MIN_BUDGET = 4096;

/**
 * Builds a {@link Store} one token at a time. One builder is reused for every message of a
 * file: its arrays only grow, up to `limit` bytes, and `finish()` copies the used part out.
 */
export class StoreBuilder {
  readonly #limit: number;
  #segmentCapacity: number;
  #elementCapacity: number;
  #componentCapacity: number;
  #segmentStart: Int32Array;
  #segmentEnd: Int32Array;
  #segmentNumber: Int32Array;
  #segmentFirstElement: Int32Array;
  #elementStart: Int32Array;
  #elementFirstComponent: Int32Array;
  #elementRepetitions: Uint16Array;
  #componentStart: Int32Array;
  #componentEnd: Int32Array;
  #componentFlags: Uint8Array;
  #componentRepetition: Uint16Array;

  segments = 0;
  elements = 0;
  components = 0;
  /** Largest working memory reached, in bytes. */
  peakBytes = 0;

  #inElement = false;
  /** The component after the last separator has a value. */
  #slotFilled = false;
  #sawSeparator = false;
  #repetition = 0;

  constructor(limit: number) {
    this.#limit = limit;
    this.#segmentCapacity = 16;
    this.#elementCapacity = 32;
    this.#componentCapacity = 64;
    this.#segmentStart = new Int32Array(16);
    this.#segmentEnd = new Int32Array(16);
    this.#segmentNumber = new Int32Array(16);
    this.#segmentFirstElement = new Int32Array(17);
    this.#elementStart = new Int32Array(32);
    this.#elementFirstComponent = new Int32Array(33);
    this.#elementRepetitions = new Uint16Array(32);
    this.#componentStart = new Int32Array(64);
    this.#componentEnd = new Int32Array(64);
    this.#componentFlags = new Uint8Array(64);
    this.#componentRepetition = new Uint16Array(64);
    this.peakBytes = this.workingBytes();
  }

  /** Bytes held by the arrays, whether used or not. */
  workingBytes(): number {
    return (
      this.#segmentCapacity * SEGMENT_BYTES +
      this.#elementCapacity * ELEMENT_BYTES +
      this.#componentCapacity * COMPONENT_BYTES
    );
  }

  /** Forget the segments built so far, keep the memory. */
  reset(): void {
    this.segments = 0;
    this.elements = 0;
    this.components = 0;
    this.#inElement = false;
  }

  beginSegment(start: number, number: number): void {
    if (this.segments === this.#segmentCapacity) {
      this.#growSegments();
    }
    const s = this.segments++;
    this.#segmentStart[s] = start;
    this.#segmentNumber[s] = number;
    this.#segmentFirstElement[s] = this.elements;
  }

  /** `offset` is the end of the separator that opens the element. */
  beginElement(separatorStart: number, offset: number): void {
    this.#closeElement(separatorStart);
    if (this.elements === this.#elementCapacity) {
      this.#growElements();
    }
    const e = this.elements++;
    this.#elementStart[e] = offset;
    this.#elementFirstComponent[e] = this.components;
    this.#elementRepetitions[e] = 1;
    this.#inElement = true;
    this.#slotFilled = false;
    this.#sawSeparator = false;
    this.#repetition = 0;
  }

  addValue(start: number, end: number, escaped: boolean): void {
    this.#pushComponent(start, end, escaped ? 1 : 0);
    this.#slotFilled = true;
  }

  /** A component separator at `at`: an empty component stands for a missing value. */
  componentSeparator(at: number): void {
    if (!this.#slotFilled) {
      this.#pushComponent(at, at, 0);
    }
    this.#slotFilled = false;
    this.#sawSeparator = true;
  }

  repetitionSeparator(at: number): void {
    if (this.#sawSeparator && !this.#slotFilled) {
      this.#pushComponent(at, at, 0);
    }
    if (this.#repetition === MAX_REPETITIONS - 1) {
      throw new BudgetExceeded("repetitions");
    }
    this.#repetition++;
    this.#elementRepetitions[this.elements - 1] = this.#repetition + 1;
    this.#slotFilled = false;
    this.#sawSeparator = false;
  }

  /** The terminator of the segment spans `terminatorStart` to `end`. */
  endSegment(terminatorStart: number, end: number): void {
    this.#closeElement(terminatorStart);
    this.#segmentEnd[this.segments - 1] = end;
  }

  /** A trailing component separator leaves one empty component behind it. */
  #closeElement(at: number): void {
    if (this.#inElement && this.#sawSeparator && !this.#slotFilled) {
      this.#pushComponent(at, at, 0);
    }
    this.#inElement = false;
  }

  #pushComponent(start: number, end: number, flags: number): void {
    if (this.components === this.#componentCapacity) {
      this.#growComponents();
    }
    const c = this.components++;
    this.#componentStart[c] = start;
    this.#componentEnd[c] = end;
    this.#componentFlags[c] = flags;
    this.#componentRepetition[c] = this.#repetition;
  }

  /**
   * The capacity to grow a family of arrays to: double, but no more than what still fits in the
   * limit next to the other families. Throws when it cannot grow at all.
   */
  #nextCapacity(current: number, bytesPerItem: number): number {
    const others = this.workingBytes() - current * bytesPerItem;
    const fits = Math.floor((this.#limit - others) / bytesPerItem);
    if (fits <= current) {
      throw new BudgetExceeded("memory");
    }
    return Math.min(current * 2, fits);
  }

  #growSegments(): void {
    const capacity = this.#nextCapacity(this.#segmentCapacity, SEGMENT_BYTES);
    this.#segmentStart = grown(this.#segmentStart, capacity);
    this.#segmentEnd = grown(this.#segmentEnd, capacity);
    this.#segmentNumber = grown(this.#segmentNumber, capacity);
    this.#segmentFirstElement = grown(this.#segmentFirstElement, capacity + 1);
    this.#segmentCapacity = capacity;
    this.#notePeak();
  }

  #growElements(): void {
    const capacity = this.#nextCapacity(this.#elementCapacity, ELEMENT_BYTES);
    this.#elementStart = grown(this.#elementStart, capacity);
    this.#elementFirstComponent = grown(this.#elementFirstComponent, capacity + 1);
    this.#elementRepetitions = grown(this.#elementRepetitions, capacity);
    this.#elementCapacity = capacity;
    this.#notePeak();
  }

  #growComponents(): void {
    const capacity = this.#nextCapacity(this.#componentCapacity, COMPONENT_BYTES);
    this.#componentStart = grown(this.#componentStart, capacity);
    this.#componentEnd = grown(this.#componentEnd, capacity);
    this.#componentFlags = grown(this.#componentFlags, capacity);
    this.#componentRepetition = grown(this.#componentRepetition, capacity);
    this.#componentCapacity = capacity;
    this.#notePeak();
  }

  #notePeak(): void {
    const bytes = this.workingBytes();
    if (bytes > this.peakBytes) {
      this.peakBytes = bytes;
    }
  }

  /**
   * A copy of what was built, sized to fit, that the builder will not touch again. Its arrays
   * are views on one buffer: a message that is kept costs one allocation, not twelve.
   */
  finish(): Store {
    const segments = this.segments;
    const elements = this.elements;
    const components = this.components;
    this.#segmentFirstElement[segments] = elements;
    this.#elementFirstComponent[elements] = components;
    const words = 3 * segments + (segments + 1) + elements + (elements + 1) + 2 * components;
    const buffer = new ArrayBuffer(words * 4 + (elements + components) * 2 + components);
    let at = 0;
    const int32 = (from: Int32Array, length: number): Int32Array => {
      const view = new Int32Array(buffer, at, length);
      view.set(from.subarray(0, length));
      at += length * 4;
      return view;
    };
    const segmentStart = int32(this.#segmentStart, segments);
    const segmentEnd = int32(this.#segmentEnd, segments);
    const segmentNumber = int32(this.#segmentNumber, segments);
    const segmentFirstElement = int32(this.#segmentFirstElement, segments + 1);
    const elementStart = int32(this.#elementStart, elements);
    const elementFirstComponent = int32(this.#elementFirstComponent, elements + 1);
    const componentStart = int32(this.#componentStart, components);
    const componentEnd = int32(this.#componentEnd, components);
    const uint16 = (from: Uint16Array, length: number): Uint16Array => {
      const view = new Uint16Array(buffer, at, length);
      view.set(from.subarray(0, length));
      at += length * 2;
      return view;
    };
    const elementRepetitions = uint16(this.#elementRepetitions, elements);
    const componentRepetition = uint16(this.#componentRepetition, components);
    const componentFlags = new Uint8Array(buffer, at, components);
    componentFlags.set(this.#componentFlags.subarray(0, components));
    return {
      segmentCount: segments,
      segmentStart,
      segmentEnd,
      segmentNumber,
      segmentFirstElement,
      elementStart,
      elementFirstComponent,
      elementRepetitions,
      componentStart,
      componentEnd,
      componentFlags,
      componentRepetition,
    };
  }
}

function grown<T extends Int32Array | Uint16Array | Uint8Array>(array: T, length: number): T {
  const bigger = new (array.constructor as new (length: number) => T)(length);
  bigger.set(array);
  return bigger;
}
