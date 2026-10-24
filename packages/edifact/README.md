# @libredi/edifact

The UN/EDIFACT engine of Libredi. Today it holds the **tokenizer**: bytes in, a flat stream of
tokens out. The parser (issue #39), the serializer (#40) and the validator (#42) build on it.

The package is private to the monorepo and exports its TypeScript source, like the other
packages (see [development](../../docs/development.md#typescript-conventions)). Its interface is
deliberately narrow, bytes in and tokens out, so that a faster implementation in another
language could replace it behind the same shape (ADR 4).

## Use

```ts
import { Tokenizer, TokenKind, unescapeValue } from "@libredi/edifact";

for (const batch of new Tokenizer(bytes)) {
  for (let i = 0; i < batch.length; i++) {
    const kind = batch.kinds[i]; // one of the TokenKind values
    const start = batch.starts[i] as number; // byte offsets in `bytes`
    const end = batch.ends[i] as number;
    if (kind === TokenKind.EscapedText) {
      const value = unescapeValue(bytes, start, end, batch.separators.release);
    }
  }
}
```

- **Tokens**: `ServiceStringAdvice` (UNA), `SegmentTag`, `Text`, `EscapedText`,
  `ComponentSeparator`, `ElementSeparator`, `RepetitionSeparator`, `SegmentTerminator`.
  An empty element or component has no token: two separators in a row say it. A text token is
  always directly followed by a separator token.
- **No tree.** A token is three array cells (kind, start, end), not an object. Tokens come in
  batches of up to 4096 that reuse the same arrays (36 KiB), so memory does not depend on the
  size of the file. Read a batch before asking for the next one, and run one loop at a time:
  they share the batch, and a second loop that starts too early is refused.
- **Nothing is decoded.** `Text` is a run of bytes; the character set is the caller's business
  (issue #37). All four character sets of the roadmap, UNOA, UNOB, UNOC and UNOW (UTF-8), keep
  the separators in the ASCII range, so scanning byte by byte is correct for them.
- **Positions**: every token has its byte offsets. Between two tokens, only line breaks and a
  leading UTF-8 byte order mark are skipped. `tokenizer.locate(offset)` gives the line and
  column (1-based, columns count bytes); it reads the input once and keeps four bytes per line,
  so call it for a few messages, not for every token. Errors do not use it: they carry their own
  position, found by a scan that allocates nothing.
- **Errors**: a `TokenizeError` carries a `code`, the `offset`, `line` and `column`, the number
  of the `segment` (UNB is 1, UNA is 0) and its `tag`. Every token before the problem is
  delivered first, then the loop's next step throws. A loop that stops early never sees the
  error, so a caller that must know whether the file is whole has to read to the end.
- **The input** must be a `Uint8Array` (a Node.js `Buffer` is one), smaller than 2 GiB, and must
  not be modified, resized or detached while a loop is running.

| Code | When |
| --- | --- |
| `INVALID_UNA` | A UNA service character is not an ASCII punctuation mark (a letter, a digit, a space outside the repetition position, a control character or a byte above 0x7E), two of them are the same, or the decimal mark is not `.` or `,`. |
| `UNEXPECTED_END_OF_FILE` | The file ends inside the UNA string, inside a tag, inside a segment, or right after a release character. Any cut file ends this way. |
| `INVALID_SEGMENT_TAG` | A segment does not start with three capital letters or digits followed by the element separator or the terminator. |

The codes are the working names of the [sample corpus](../../samples/edifact/README.md); the
error model of issue #46 may rename them.

## Rules it follows

- UNA gives the six service characters; without it the defaults `:+.? '` apply. A UNA string
  may also start a second interchange in the same file; after UNZ the defaults apply again. A
  batch never mixes two sets of separators: it ends before a new, different UNA and after UNZ,
  and `batch.separators` holds the set for the whole batch. The same UNA string repeated does
  not end the batch.
- The release character makes the next byte data, whatever it is: a separator, a line break or
  the release character itself.
- CR, LF and CR LF are skipped between segments, before the first one, after UNA and at the end
  of the file. Inside a segment they are data, which the character set check will judge.
- The syntax 4 repetition separator exists only when UNA declares one. Without UNA, `*` is
  plain text (syntax 4 details are issue #41).
- A file of 2 GiB or more is refused: offsets are signed 32-bit integers, which V8 reads
  faster.

## Tests

`pnpm --filter @libredi/edifact test` runs:

- every valid sample of the [sample corpus](../../samples/edifact/README.md) against its
  `.expected.json`, written by an independent tool, and every prefix of every sample (a cut file
  ends in `UNEXPECTED_END_OF_FILE` at its last byte, never in anything else);
- examples for each rule above;
- [fast-check](https://fast-check.dev) properties: any bytes survive escaping, a released byte
  never acts as a separator, an interchange written from a model is tokenized exactly as laid
  out for any legal separators and line breaks, several interchanges in one file keep their own
  separators, the result does not depend on the batch size, every byte is covered by a token or
  is a skipped line break, and `locate` agrees with a plain scan;
- a second, deliberately plain tokenizer (`src/testing/reference.ts`, one byte at a time, no
  tables, no batches) that must give the same tokens, separators and errors on arbitrary bytes
  and on real samples that are cut, bent, joined or have a byte changed.

## Benchmark

```bash
pnpm --filter @libredi/edifact bench               # about 10 MB, 15 runs
pnpm --filter @libredi/edifact bench -- --sweep    # also compare batch sizes
pnpm --filter @libredi/edifact bench -- --size-mb=100 --runs=5 --no-baseline
```

It generates a deterministic ORDERS interchange (1,087 orders of 80 lines, 443,498 segments,
9.25 MB, the shape measured in [languages](../../docs/research/languages.md)) and prints
throughput and memory. MB means 10^6 bytes. There is no threshold yet: issue #54 adds fuzzing
and a regression check in CI.

Measured on 2026-10-23, Node.js 26.12.1, AMD EPYC 9R45 (one core of a shared cloud machine;
three runs agree within 2 %, but expect other machines to differ):

| What | Result |
| --- | --- |
| Tokenizer, counting tokens | 420 MB/s, 173 million tokens/s |
| Tokenizer, reading every token | 293 MB/s, 14 million segments/s |
| Tokenizer, also making a string of every tag and value | 261 MB/s |
| One tokenizer per 8.5 KB order | 34,000 orders/s, 29 µs per order (1.5 % of the 2 ms budget of ADR 10) |
| One tokenizer per 0.5 KB order | 380,000 orders/s, 2.6 µs per order |
| Memory | 36 KiB while scanning, 9 MB or 90 MB of input alike |
| Object tree (baseline, not used) | 42 to 45 MB/s, 320 MB retained for 9.25 MB (34.6 times the input) |

The floor on the same machine, a loop that only looks every byte up in a table, is 2.5 GB/s. The
flat scanner of the language study reached 737 MB/s on Node 24 but only counted segments; this
tokenizer also writes the 3.8 million tokens of the file. Against the object tree it is 6 to 7
times faster, and still 6 times faster when it also builds a string for every value, as the tree
does. What was tried to get here, with the same benchmark: one table lookup per byte instead of
three for the byte that ends a value (+16 %), signed instead of unsigned offsets (+3 to 5 %),
one allocation for the three arrays and arrays sized to small inputs (a 0.5 KB order went from
71 to 177 MB/s); `bytes.length` as the loop bound was slower and was dropped.
