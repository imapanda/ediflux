# @libredi/edifact

The UN/EDIFACT engine of Libredi. Today it holds the **tokenizer** (bytes in, a flat stream of
tokens out), **character sets** (UNOA, UNOB, UNOC, UNOW), the **splitter**, which finds the
messages of a file in constant memory, and the **tree**, which reads one message at a time into
segments, elements and components with their positions, within a memory budget. The serializer
(issue #40) and the validator (#42) build on them.

The package is private to the monorepo and exports its TypeScript source, like the other
packages (see [development](../../docs/development.md#typescript-conventions)). Its interface is
deliberately narrow, bytes in and tokens, slices or messages out, so that a faster
implementation in another language could replace it behind the same shape (ADR 4).

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

## Read the tree

```ts
import { parseInterchanges, parseMessages } from "@libredi/edifact";

for (const message of parseMessages(bytes)) {
  for (const segment of message.segments) {
    segment.tag; // "NAD"
    segment.text(2, 1); // component 1 of element 2, as text, or undefined
    const component = segment.component(2, 3);
    component?.position; // { segment: 5, tag: "NAD", element: 2, component: 3 }
    component?.start; // bytes of the value in the input, release characters included
  }
}

const { interchanges, issues } = parseInterchanges(bytes); // the whole file, kept in memory
```

- **A tree of nodes**: `Interchange` (UNA, separators, character set, `items`, UNB, UNZ), `Group`
  (UNG to UNE), `Message` (UNH to UNT), `Segment`, `Element`, `Component`. Each has `start` and
  `end`, the bytes it spans in the input. Elements and components come from `segment.elements`,
  `element.components` and `element.repetitions` (syntax 4: one list of components per repetition;
  one list otherwise).
- **Positions** are those of the sample corpus, the registry and the validator: the number of the
  segment in the interchange (UNA is 0, UNB is 1), the tag, and the element and component counted
  from 1. A composite counts as one element and an empty element counts; an empty component stands
  between two separators and has a `start` equal to its `end`. `interchange.locate(offset)` gives
  line and column.
- **Lossless.** The input is kept (`interchange.source`) and every node knows its bytes, so
  nothing of the file is lost: values keep their release characters until `text()` or `bytes()`
  asks for them without, and the bytes between two nodes (the line breaks after a terminator, a
  byte order mark in front of the first segment) are exactly the bytes between their spans. The
  serializer (issue #40) writes the tree back.
- **Nodes are views** on compact typed arrays, made when they are asked for. `segment.elements`
  builds its list on each call: keep it if you read it often. The arrays of a message of a few KB
  take about four times its size, against thirty and more for an object tree.
- **The structure is not judged.** A message without UNT (`unt` is null), a segment outside any
  message (an item of the interchange or of the group, next to messages), a UNE without UNG, a file
  with no UNB or no UNZ all come out as they are; the validator reports them.
- **Values are decoded with the character set of UNB** (`text()`), or as ISO 8859-1 when there is
  none. A value with a character the set does not allow is in the `issues` and still in the tree.
- **`parseMessages`** gives the messages of a file one at a time, each with its own arrays, so a
  message can be kept or dropped on its own. `parseMessages(bytes).items()` gives the messages
  and, between them, the segments that are not in a message (UNB, UNG, UNE, UNZ, loose segments)
  as `Envelope` items, so that a validator that reads a large file message by message still sees
  the envelope and its counts. `parseInterchanges` is the whole file at once, for small files: it
  throws the `TokenizeError` or `ParseError` and returns nothing. An interchange that is only a UNA
  string is an interchange (and an `Interchange` of its own); the stream does not hand out UNA
  strings, which `message.interchange.una` has.
- **`bytes()` is a copy**, even for an input that is a Node.js `Buffer`: writing to it does not
  change the file or the text of other nodes. `message.segments` cannot be changed.
- **A long element is paid for when it is asked for.** `element.components` makes one node for each
  component (about 80 bytes each), and `component.position` finds its repetition by a binary
  search; a million components are fine to read one at a time, not to list at once.

### Memory

- `memoryBudget` (default 64 MiB, from 4096 bytes to 2 GiB) is the most that the arrays of one
  message may use. A message of 9 KB takes 40 KiB, so the default allows messages of about 16 MB.
  The same limit applies to a run of segments that are not in a message (UNB, UNG, UNE, UNZ, loose
  segments). Arrays grow by doubling, up to what fits in the limit. A message that needs more stops
  the parse with a `ParseError` (`MESSAGE_TOO_LARGE`) that says where the message starts.
  `stream.peakWorkingBytes` is the most a message needed. While a message is copied out, the arrays
  and the copy exist together, so the peak of the process is up to about twice the budget.
- `maxTreeBytes` (default 256 MiB) caps the whole tree that `parseInterchanges` keeps. It counts the
  arrays of every message and about 2 KiB of nodes for each message and each run of segments between
  messages: that fixed cost is why the tree is **3.7 times the input for messages of a few KB**, and
  100 times and more for a file of tiny messages (`UNH+1+X'UNT+1+1'` is 16 bytes and costs 1.6 KB).
  A larger tree stops the parse with `TREE_TOO_LARGE`; read such a file with `parseMessages`.
- An element with more than 65,535 repetitions stops the parse with `TOO_MANY_REPETITIONS`.

| Code of a `ParseError` | When |
| --- | --- |
| `MESSAGE_TOO_LARGE` | One message, or one run of segments outside messages, needs more than `memoryBudget`. |
| `TREE_TOO_LARGE` | The whole tree of `parseInterchanges` needs more than `maxTreeBytes`. |
| `TOO_MANY_REPETITIONS` | An element has more than 65,535 repetitions. |

The bound is on what the parser holds, not on the input, which the caller has already read into a
`Uint8Array`, and not on the garbage of messages that were delivered and dropped: V8 collects the
arrays of dropped messages when it decides to. The benchmark shows both (live set and free-running
heap).

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
- every sample once more through the parser: the tree, read component by component, is the content
  of its expected-result file and what the tokens say; the segment, element and component
  positions and spans agree with the bytes;
- examples for each rule above, including a structure that is not what it should be (no UNT, no
  UNZ, loose segments, groups, several interchanges) and the memory budget (the error, its place,
  the segments outside messages, a 20 MB interchange parsed within 1 MiB);
- [fast-check](https://fast-check.dev) properties: any bytes survive escaping, a released byte
  never acts as a separator, an interchange written from a model is tokenized exactly as laid
  out for any legal separators and line breaks, several interchanges in one file keep their own
  separators, the result does not depend on the batch size, every byte is covered by a token or
  is a skipped line break, and `locate` agrees with a plain scan; messages written from a model
  (with or without UNT, in groups or not) are found where they were written; a value is reported
  if and only if it has a byte its character set does not allow; a tree written from a model has
  the segments, elements, repetitions, components, positions and spans of the model, and says
  what the tokens say; the same messages come out of `parseMessages` and `parseInterchanges`,
  whatever the batch size; arbitrary bytes parse into a consistent tree or stop with the
  tokenizer's error;
- a second, deliberately plain tokenizer (`src/testing/reference.ts`, one byte at a time, no
  tables, no batches) and a second, plain splitter on top of it (`src/testing/split-reference.ts`)
  that must give the same tokens, separators, errors, messages, interchange facts and issues on
  arbitrary bytes, on random envelopes and on real samples that are cut, bent, joined or have a
  byte changed.

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

Measured on 2026-10-24, Node.js 26.12.1, AMD EPYC 9R45 (one core of a shared cloud machine, on a
quiet moment; runs agree within 5 %, but expect other machines to differ):

| What | Result |
| --- | --- |
| Tokenizer, counting tokens | 419 MB/s, 173 million tokens/s |
| Tokenizer, reading every token | 294 MB/s, 14 million segments/s |
| Tokenizer, also making a string of every tag and value | 261 MB/s |
| `splitMessages`, with the character check | 162 MB/s, 19,000 orders/s, 53 µs per 8.5 KB order |
| `splitMessages`, without the character check | 209 MB/s (the check adds about 28 % to the time) |
| `parseMessages`, building every message | 126 MB/s, 14,500 orders/s, **68 µs per 8.5 KB order** (3.4 % of the 2 ms budget of ADR 10) |
| ... and visiting every segment, element and component | 86 MB/s, 10,000 orders/s |
| ... and reading every value as text | 31 MB/s, 3,600 orders/s, 277 µs per order |
| `parseInterchanges`, the whole file as one tree | 126 MB/s |
| One tokenizer per 8.5 KB order | 33,000 orders/s, 30 µs per order |
| One tokenizer per 0.5 KB order | 360,000 orders/s, 2.8 µs per order |
| Memory of the tokenizer | 36 KiB while scanning, 9 MB or 90 MB of input alike |
| Memory of `splitMessages` | nothing held but the envelope; 0.5 MiB sampled for 9 MB of input and 3 MiB for 92 MB, all of it garbage of slices not yet collected |
| Memory of `parseMessages` | the arrays of one message: **40 KiB** for an 8.5 KB order, which is the bound; 1.4 to 2 MiB live (collected every 64 messages) for 9 MB and for 92 MB of input alike; left to V8, the heap reaches 33 MiB and 72 MiB, which is the garbage of messages that were delivered and dropped |
| Memory of `parseInterchanges` | the whole tree: **3.7 times the input** for orders of 8.5 KB (34 MB for 9.25 MB, 342 MB for 92.5 MB); **102 times** for a file of 16-byte messages, whose fixed cost is 1.6 KB each |
| Object tree (baseline, not used) | 42 to 49 MB/s, 320 MB retained for 9.25 MB (34.6 times the input) |

At 92.5 MB (`-- --size-mb=100`) `parseMessages` runs at 121 MB/s, 14,300 orders/s and 70 µs per
order, with the same 40 KiB bound. `parseInterchanges` falls to 39 MB/s there, because it builds
342 MB of arrays (and needs `maxTreeBytes` raised above its default of 256 MiB): for a file of that
size, loop over `parseMessages`.

The floor on the same machine, a loop that only looks every byte up in a table, is 2.5 GB/s. The
flat scanner of the language study reached 737 MB/s on Node 24 but only counted segments; this
tokenizer also writes the 3.8 million tokens of the file. Against the object tree it is 6 to 7
times faster, and still 6 times faster when it also builds a string for every value, as the tree
does. Building the tree costs about 40 µs per order on top of the 30 µs of tokenizing; the null
checks that let the splitter share its loop with the tree cost it about 7 %; walking it
through nodes costs more than building it, because every node is made on demand: a consumer that
reads a few values pays for a few. What was tried to get here, with the same benchmark: one table
lookup per byte instead of three for the byte that ends a value (+16 %), signed instead of unsigned
offsets (+3 to 5 %), one allocation for the three arrays and arrays sized to small inputs (a 0.5 KB
order went from 71 to 177 MB/s), a character table made once per interchange instead of looked up
for every value (the check went from 40 % to 23 % of the time of the splitter), `component(e, c)`
and `element.components` without the lists and nodes they do not need (visiting every node went from
34 to 85 MB/s); `bytes.length` as the loop bound was slower and was dropped.
