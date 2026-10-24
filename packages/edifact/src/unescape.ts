/**
 * The bytes of a value with its release characters removed: each release character is dropped
 * and the byte it releases is kept as it is, whether that byte is a separator, a line break or
 * another release character. Returns a new array.
 *
 * Meant for the range of an `EscapedText` token. A release character that ends the range has
 * nothing to release (the tokenizer never produces such a token) and is kept.
 */
export function unescapeValue(
  bytes: Uint8Array,
  start: number,
  end: number,
  release: number,
): Uint8Array {
  const out = new Uint8Array(end - start);
  let length = 0;
  for (let i = start; i < end; i++) {
    let byte = bytes[i] as number;
    if (byte === release && i + 1 < end) {
      i++;
      byte = bytes[i] as number;
    }
    out[length++] = byte;
  }
  return length === out.length ? out : out.slice(0, length);
}
