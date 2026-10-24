/*
 * The design this package does NOT use, kept as a yardstick: a first-cut parser that builds an
 * object per segment, an array per element and a string per component. It is the shape of
 * tokenizer that docs/research/languages.md measured at 41 MB/s and 34 times the input in memory.
 * Default separators only, and no error handling: it exists to be compared with, not to be used.
 */

export interface TreeSegment {
  tag: string;
  elements: string[][];
}

export function parseToObjectTree(bytes: Uint8Array): TreeSegment[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const segments: TreeSegment[] = [];
  let pos = text.startsWith("UNA") ? 9 : 0;
  while (pos < text.length) {
    while (text.charCodeAt(pos) === 0x0a || text.charCodeAt(pos) === 0x0d) {
      pos++;
    }
    if (pos >= text.length) {
      break;
    }
    const segment: TreeSegment = { tag: text.slice(pos, pos + 3), elements: [] };
    pos += 3;
    let components: string[] = [];
    let value = "";
    for (; pos < text.length; pos++) {
      const code = text.charCodeAt(pos);
      if (code === 0x3f) {
        value += text[++pos] ?? "";
      } else if (code === 0x3a) {
        components.push(value);
        value = "";
      } else if (code === 0x2b || code === 0x27) {
        components.push(value);
        segment.elements.push(components);
        components = [];
        value = "";
        if (code === 0x27) {
          pos++;
          break;
        }
      } else {
        value += text[pos];
      }
    }
    // The first "+" ends the tag, not an element.
    segment.elements.shift();
    segments.push(segment);
  }
  return segments;
}
