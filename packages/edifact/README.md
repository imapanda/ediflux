# @libredi/edifact

The UN/EDIFACT engine of Libredi. Today it holds the **tokenizer** (bytes in, a flat stream of
tokens out), **character sets** (UNOA, UNOB, UNOC, UNOW) and the **splitter**, which finds the
messages of a file in constant memory. The tree (issue #39), the serializer (#40) and the
validator (#42) build on them.

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
- **Nothing is decoded by the tokenizer.** `Text` is a run of bytes; see "Character sets" for
  what reads them. All four character sets of the roadmap, UNOA, UNOB, UNOC and UNOW (UTF-8), keep
  the separators in the ASCII range, so scanning byte by byte is correct for them.
- **Positions**: every token has its byte offsets. Between two tokens, only line breaks and a
  leading UTF-8 byte order mark are skipped. `tokenizer.locate(offset)` gives the line and
  column (1-based, columns count bytes); it reads the input once to build an index of two numbers
  per 64 KiB, then a lookup scans at most one block. Errors do not use it: they carry their own
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

## Locate the messages

```ts
import { splitMessages } from "@libredi/edifact";

const stream = splitMessages(bytes);
for (const message of stream) {
  message.start; // from the UNH tag ...
  message.end; // ... to just after UNT (or after the last segment, when UNT is missing)
  message.segmentCount;
  message.closed; // false when the message runs into the next UNH, UNG, UNE, UNZ, UNA or UNB, or the end of the file
  message.ung; // the span of the UNG of its group, or null
  message.interchange; // UNA, separators, syntax identifier and version, character set, UNB, locate()
}
stream.issues; // problems with values, see below (at most maxIssues of them)
stream.issueCount; // ... and how many there were in all
stream.messageCount; // messages handed out so far
```

- **Constant memory.** The splitter keeps no segment: a few numbers whatever the size of the file.
  A slice is a span of the input and the facts of its interchange. A worker can tokenize the span
  with `new Tokenizer(bytes.subarray(start, end))` when the interchange uses the default
  separators; a UNA with other characters cannot be handed over yet, because `Tokenizer` has no
  option to start with a given set of separators.
- **Nothing is checked about the structure.** A message without UNT, a segment outside any
  message, a UNE without UNG are all found as they are; the validator (issues #43 to #45)
  reports them. Segments outside messages (UNB, UNG, UNE, UNZ, loose segments) are not slices.
- **Several interchanges** in one file give slices whose `interchange` differs (`index` 0, 1, ...).
  An interchange starts at UNA or UNB, and ends at UNZ.
- A cut file ends the loop with the tokenizer's `TokenizeError`, after the messages before it.
  A stream reads its input once; a second loop yields nothing.

## Character sets

UNB names the character set in the first component of S001. The splitter reads that component as
ISO 646 (plain ASCII), which is how the start of UNB is always written, and checks every value
that follows against the set. A problem is an *issue*: it does not stop anything and loses
nothing. `issue.code` is `INVALID_CHARACTER` or `UNSUPPORTED_CHARSET` (the codes of the sample
corpus, which issue #46 may rename), with the offset, line and column, a plain message, and the
position in the terms of the registry (segment, tag, element, component counted from 1).

| Set | Allowed in a value |
| --- | --- |
| UNOA | Level A of ISO 9735: capital letters, digits, space and `. , - ( ) / = ! " % & * ; < > ' + : ?`. Lower case is **not** allowed. |
| UNOB | Every printable ISO 646 character: `0x20` to `0x7E`. |
| UNOC | ISO 8859-1: `0x20` to `0x7E` and `0xA0` to `0xFF`. |
| UNOW | Well-formed UTF-8 (no overlong form, surrogate or code point above U+10FFFF). |

- Control characters are never allowed, C1 (`0x80` to `0x9F`, `U+0080` to `U+009F`) included in
  UNOC and UNOW: a line break **inside** a value is an issue. Line breaks between segments are not.
- The service characters that UNA declares are always allowed, whatever the set.
- A release character comes before a whole character, never inside one: in UNOW, `C3 ? A9` (the
  release character between the two bytes of an "e acute") is an issue, because the check reads the
  bytes as they are written.
- S001 is read once per interchange, from its first repetition. Its first two components, as
  `syntaxIdentifier` and `syntaxVersion`, are kept to 32 characters, with `?` for anything that is not
  printable ASCII and `...` after a cut, so that a hostile file cannot put raw bytes or a megabyte
  of text in a message.
- An unsupported set (UNOD to UNOK, UNOX, UNOY, anything else) gives one `UNSUPPORTED_CHARSET`
  issue; `characterSet` is then null, values are read as ISO 8859-1 and not checked. Without a
  UNB (or without an S001) there is no set and no check.
- `decodeText(bytes, start, end, set)` turns the bytes of a value into text: UNOA, UNOB, UNOC and
  an unknown set as ISO 8859-1, UNOW as UTF-8 with U+FFFD for a broken sequence. Remove the release
  characters first with `unescapeValue`. `checkCharacters: false` skips the check.

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
- every sample once more through the splitter (message counts and sizes, facts of the interchange,
  UNOC and UTF-8 values decoded to the text of the expected-result file, the character issues of
  the invalid samples at the positions of their expected-result files);
- examples for each rule above;
- [fast-check](https://fast-check.dev) properties: any bytes survive escaping, a released byte
  never acts as a separator, an interchange written from a model is tokenized exactly as laid
  out for any legal separators and line breaks, several interchanges in one file keep their own
  separators, the result does not depend on the batch size, every byte is covered by a token or
  is a skipped line break, and `locate` agrees with a plain scan; messages written from a model
  (with or without UNT, in groups or not) are found where they were written; a value is reported
  if and only if it has a byte its character set does not allow;
- a second, deliberately plain tokenizer (`src/testing/reference.ts`, one byte at a time, no
  tables, no batches) that must give the same tokens, separators and errors on arbitrary bytes
  and on real samples that are cut, bent, joined or have a byte changed.

## Benchmark

```bash
pnpm --filter @libredi/edifact bench               # about 10 MB, 15 runs
pnpm --filter @libredi/edifact bench -- --sweep    # also compare batch sizes
pnpm --filter @libredi/edifact bench -- --size-mb=100 --runs=5 --no-baseline  # memory does not grow
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
| `splitMessages`, with the character check | 182 MB/s, 21,000 orders/s, 47 µs per 8.5 KB order |
| `splitMessages`, without the character check | 225 MB/s (the check adds about 24 % to the time) |
| One tokenizer per 8.5 KB order | 34,000 orders/s, 29 µs per order (1.5 % of the 2 ms budget of ADR 10) |
| One tokenizer per 0.5 KB order | 380,000 orders/s, 2.6 µs per order |
| Memory of the tokenizer | 36 KiB while scanning, 9 MB or 90 MB of input alike |
| Memory of `splitMessages` | nothing held but the envelope; the sampled heap stays under 2 MiB for 90 MB of input (garbage of slices not yet collected) |
| Object tree (baseline, not used) | 42 to 45 MB/s, 320 MB retained for 9.25 MB (34.6 times the input) |

The floor on the same machine, a loop that only looks every byte up in a table, is 2.5 GB/s. The
flat scanner of the language study reached 737 MB/s on Node 24 but only counted segments; this
tokenizer also writes the 3.8 million tokens of the file. Against the object tree it is 6 to 7
times faster, and still 6 times faster when it also builds a string for every value, as the tree
does. What was tried to get here, with the same benchmark: one table lookup per byte instead of
three for the byte that ends a value (+16 %), signed instead of unsigned offsets (+3 to 5 %),
one allocation for the three arrays and arrays sized to small inputs (a 0.5 KB order went from
71 to 177 MB/s); `bytes.length` as the loop bound was slower and was dropped.
