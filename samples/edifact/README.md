# Synthetic EDIFACT sample corpus

Fictitious UN/EDIFACT interchanges to develop and test the Libredi tokenizer, parser and validator
against (milestone M1). Valid samples cover ORDERS, ORDRSP, DESADV and CONTRL in directories
D.96A and D.01B, syntax versions 3 and 4, and the character sets UNOA, UNOB, UNOC and UNOW.
Invalid samples cover one defect per validator error class (see the limits below). This is the
work of epic #23.

Nothing here is real. The corpus contains no partner data, no text from GS1 or EANCOM documents
and no UN directory data, as required by the
[standards licensing decision](../../docs/adr/0007-standards-licensing.md) and the
[standards research](../../docs/research/standards.md).

## Rules

Every sample added to this directory must follow these rules.

1. **Everything is fictitious.**
   - Companies are called `SAMPLE …` or are obviously invented; streets, towns and the postcode
     `00000` are made up or too generic to identify anyone. Real place names (Łódź, Tokyo)
     appear only as character-set test text. No telephone numbers, e-mail addresses or real
     references.
   - GLN, GTIN and SSCC numbers sit under GS1 prefix 952, which GS1 sets aside for
     demonstrations and examples ([GS1 prefixes](https://www.gs1.org/prefixes)). Their check
     digits are correct, so parsers that verify them still work. We assume, without a GS1
     statement about GLNs specifically, that no company owns numbers under this prefix.
   - Prices are round (`1.00`, `2.50`, `12.00`), dates are in 2030, references look like
     `PO-0001` or `IC000001`.
2. **Written by hand from public syntax and structure only.** Segments follow the ISO 9735
   syntax rules and the public UN/EDIFACT message structures. Do not copy text, examples, code
   subsets or segment tables from GS1 or EANCOM manuals, from partner implementation guides or
   from the UN directory files. The word EANCOM does not appear in any sample. The association
   assigned code in UNH (`LBR001`) and the agreement identifier (`LBRTEST`) are invented.
3. **One concern per sample.** A valid sample shows one feature. An invalid sample is a valid
   sample with exactly one defect, and its expected file names that sample in `basedOn`.
4. **Byte-exact files.** A `.edi` file is stored exactly as a partner would send it: its line
   endings, its character set and its lack of a final newline are part of the test.
   [`.gitattributes`](../../.gitattributes) marks `*.edi` as non-text so that Git never converts
   it, and [`.editorconfig`](../../.editorconfig) and the spell checker skip it. Do not reformat
   a sample, and check your editor does not add a final newline or change the encoding.
5. **One expected-result file per sample**, next to it, with the same name and the suffix
   `.expected.json`. A sample without an expected file, or the other way round, is a defect.
   The JSON files follow the repository formatter (Biome, `pnpm fix`), so that `pnpm check`
   accepts them.
6. **Expected results never come from Libredi's own code.** Otherwise a bug in the tokenizer
   would silently "confirm" itself. The current files were produced with a throwaway script and
   cross-checked with [pydifact](https://github.com/nerdocs/pydifact) 0.2.3 (MIT), which
   tokenizes all valid samples to the same segments and elements, apart from the repetition
   separator that it does not know.

## Layout and naming

```text
samples/edifact/
  README.md
  valid/     <message>-<directory>-s<syntax>-<charset>-<variant>.edi  + .expected.json
  invalid/   <error-code-in-kebab-case>.edi                           + .expected.json
```

- Valid names are lower case: message type (`orders`, `ordrsp`, `desadv`, `contrl`), directory
  (`d96a`, `d01b`; omitted for CONTRL, which is not tied to a directory), `s3` or `s4` for the
  syntax version, the character set (`unoa`, `unob`, `unoc`, `unow`) and a short variant.
- Invalid names are the expected error code in lower case with hyphens, for example
  `unt-count-mismatch`. Samples that share a code add the variant (`invalid-character-unoa`).
- Line endings: LF after every segment unless the variant says otherwise. `crlf` uses CR LF
  (also after UNA); `no-una` and `custom-una` have no line break at all and no final newline.

## Expected result of a valid sample

```json
{
  "sample": "orders-d96a-s3-unoa-minimal.edi",
  "kind": "valid",
  "description": "Smallest useful ORDERS: one line, two parties, no free text.",
  "interchange": {
    "syntaxIdentifier": "UNOA",
    "syntaxVersion": 3,
    "encoding": "ascii",
    "una": ":+.? '",
    "interchangeReference": "IC000001",
    "messages": [
      { "reference": "1", "type": "ORDERS", "version": "D", "release": "96A", "agency": "UN" }
    ]
  },
  "segments": [
    {
      "tag": "UNB",
      "elements": [
        ["UNOA", "3"],
        ["9520000000011", "14"],
        ["9520000000035", "14"],
        ["301015", "0830"],
        ["IC000001"]
      ]
    },
    { "tag": "UNH", "elements": [["1"], ["ORDERS", "D", "96A", "UN", "LBR001"]] }
  ]
}
```

(The real file lists every segment; this excerpt stops after UNH.)

- `segments` lists the segments from UNB to UNZ in file order. UNA is not a segment: its six
  characters are in `interchange.una`, or `null` when the file has no UNA.
- Each element is a list of its components, as text, with release characters removed.
  A single value is a list of one string. An empty element is `[]`; an empty component is `""`.
  Nothing is added or trimmed: an element the file omits at the end of a segment is absent.
- In syntax 4, an element that uses the repetition separator is
  `{"repetitions": [[…], […]]}`, one list of components per repetition.
- Text is decoded with the character set of the interchange (UNOC as ISO 8859-1, UNOW as
  UTF-8), then written in the JSON file, which is always UTF-8.
- `interchange.encoding` names the byte encoding. `notes` is optional and explains a limit of
  the sample.

## Expected result of an invalid sample

```json
{
  "sample": "missing-mandatory-segment.edi",
  "kind": "invalid",
  "description": "BGM, mandatory in ORDERS, is absent.",
  "basedOn": "valid/orders-d96a-s3-unoa-minimal.edi",
  "layer": "structure",
  "expectedErrors": [
    {
      "code": "MISSING_MANDATORY_SEGMENT",
      "severity": "error",
      "position": { "segment": 3, "tag": "DTM", "element": null, "component": null },
      "expected": "BGM",
      "found": "DTM"
    }
  ]
}
```

- `expectedErrors` lists every error a conforming validator must report for the file. Each
  sample has exactly one. Tests should compare `code` and `position`; `expected` and `found` are
  human-readable hints, not strings to match.
- `position.segment` is the 1-based number of the segment in the interchange, UNB being 1. The
  UNA string is segment 0. For a missing segment it is the first segment after the gap.
- `position.element` and `position.component` are 1-based. The tag does not count, and a
  composite element counts as one element. They are `null` when the error concerns the whole
  segment or the whole file.
- `layer` is the first validation layer that can detect the error: `tokenizer` (service string,
  character set, file integrity), `envelope` (UNB, UNG, UNH, UNT, UNE, UNZ), `structure`
  (segment order and repetition), `element` (type, length, mandatory values) or `code`
  (code lists).

## Error codes

The codes are working names chosen for this corpus. The error model of the validator is designed
in issue #46 and may rename them; when it does, change the codes here and in the `invalid`
expected files together.

| Code | Layer | Meaning |
| --- | --- | --- |
| `INVALID_UNA` | tokenizer | The UNA string is malformed or reuses a service character. |
| `UNEXPECTED_END_OF_FILE` | tokenizer | The file ends inside a segment. |
| `INVALID_CHARACTER` | tokenizer | A byte is not valid in the declared character set. |
| `UNSUPPORTED_CHARSET` | tokenizer | The syntax identifier in UNB is not a supported character set. |
| `UNSUPPORTED_SYNTAX_VERSION` | envelope | The syntax version in UNB is not 3 or 4. |
| `UNT_COUNT_MISMATCH` | envelope | UNT declares a wrong number of segments. |
| `UNT_REFERENCE_MISMATCH` | envelope | UNT repeats another message reference than UNH. |
| `UNZ_COUNT_MISMATCH` | envelope | UNZ declares a wrong number of messages. |
| `UNZ_REFERENCE_MISMATCH` | envelope | UNZ repeats another interchange reference than UNB. |
| `MISSING_MANDATORY_SEGMENT` | structure | A mandatory segment is absent. |
| `TOO_MANY_REPETITIONS` | structure | A segment or group occurs more often than allowed. |
| `SEGMENT_OUT_OF_ORDER` | structure | A segment appears before one that must precede it. |
| `MISSING_MANDATORY_ELEMENT` | element | A mandatory data element or component is empty. |
| `INVALID_DATA_TYPE` | element | A value does not match the data type, for example text in a number. |
| `VALUE_TOO_LONG` | element | A value exceeds the maximum length of its data element. |
| `UNKNOWN_CODE` | code | A coded value is not in the code list for that position. |

## What "valid" means here

A valid sample is well formed under the ISO 9735 syntax rules and written to follow the segment
order and cardinality of the D.96A or D.01B message structure. It has **not** been validated
against the official directories: those files are not stored in this repository and could not
be fetched when the samples were written. Re-check every valid sample with the validator once the directory
generator exists, and fix the sample, not the validator, if they disagree about the sample.

Known limits:

- Every invalid sample is an ORDERS D.96A in syntax 3 and UNOA, except `invalid-character-unow`,
  which is a D.01B syntax 4 UNOW sample. There is no syntax 4 envelope or structure error sample
  yet, and no D.01B structure error.
- `orders-d01b-s4-unoc-repetition-separator` is there for the tokenizer. D.01B probably does not
  allow a repeated text element in FTX, so a structure validator may report it. Its expected
  file says so in `notes`.
- ORDRSP and DESADV exist in D.96A and D.01B with syntax 3, and in D.01B with syntax 4 only;
  CONTRL does not depend on a directory.
- UNOW appears only with syntax version 4. Some partners may send `UNOW:3`; there is no sample
  for that yet.
- CONTRL samples use `CONTRL:D:3:UN` for syntax 3 and `CONTRL:4:2:UN` for syntax 4, and the
  action and error code values 4, 7, 28 and 29. They are written from memory of ISO 9735 and are
  unverified; the samples check the structure of an acknowledgement, not the meaning of codes.
  In particular, an interchange-level action 7 above a rejected message (action 4) in
  `contrl-s3-unoa-partially-rejected` is unconfirmed.
- The invalid samples use values (for example the party qualifier `QQQ`) that are not in the
  D.96A code lists as far as we know, and data types and lengths as remembered for D.96A.
  Confirm them with the validator once it reads the real directories.

## Adding a sample

1. Write the `.edi` file under `valid/` or `invalid/`, following the rules and naming above.
   An invalid sample starts from a valid one and changes exactly one thing.
2. Write its `.expected.json` with an independent tokenizer, not Libredi's, and cross-check the
   valid ones with a second library such as pydifact.
3. Add the sample to the list below and, for a new error code, to the table above.
4. Check that `git ls-files --eol samples/edifact` reports `-text` for the new `.edi` file and
   that `git diff --cached --stat` shows the byte count you expect.

## Valid samples

| Sample | Message | Directory | Syntax | Charset | Line ends | Covers |
| --- | --- | --- | --- | --- | --- | --- |
| [`orders-d96a-s3-unoa-minimal`](valid/orders-d96a-s3-unoa-minimal.edi) | ORDERS | D.96A | 3 | UNOA | LF | Smallest useful ORDERS: one line, two parties, no free text. |
| [`orders-d96a-s3-unoa-multi-line`](valid/orders-d96a-s3-unoa-multi-line.edi) | ORDERS | D.96A | 3 | UNOA | LF | Three order lines with product identification, description, quantity and price; buyer, supplier and delivery parties with addresses. |
| [`orders-d96a-s3-unoa-free-text`](valid/orders-d96a-s3-unoa-free-text.edi) | ORDERS | D.96A | 3 | UNOA | LF | Free text (FTX) containing every service character escaped with the release character: colon, plus, question mark and apostrophe. |
| [`orders-d96a-s3-unoc-accents`](valid/orders-d96a-s3-unoc-accents.edi) | ORDERS | D.96A | 3 | UNOC | LF | UNOC (ISO 8859-1) text with accented letters, the degree sign, one half and an escaped apostrophe, stored as single bytes. |
| [`orders-d96a-s3-unoa-multi-message`](valid/orders-d96a-s3-unoa-multi-message.edi) | ORDERS | D.96A | 3 | UNOA | LF | Two ORDERS messages in one interchange (UNZ counts 2). |
| [`orders-d96a-s3-unoa-no-una`](valid/orders-d96a-s3-unoa-no-una.edi) | ORDERS | D.96A | 3 | UNOA | none | No UNA string and no line breaks at all, as sent on a network: default separators apply. Quantities are integers because no decimal mark is declared. |
| [`orders-d96a-s3-unoa-crlf`](valid/orders-d96a-s3-unoa-crlf.edi) | ORDERS | D.96A | 3 | UNOA | CRLF | Every segment, including UNA, is followed by CR LF. The line breaks are not part of the data. |
| [`orders-d96a-s3-unoa-custom-una`](valid/orders-d96a-s3-unoa-custom-una.edi) | ORDERS | D.96A | 3 | UNOA | none | UNA declares non-default separators (semicolon, asterisk, decimal comma, exclamation mark as release, percent as terminator). |
| [`orders-d96a-s3-unob-lowercase`](valid/orders-d96a-s3-unob-lowercase.edi) | ORDERS | D.96A | 3 | UNOB | LF | UNOB (ISO 646 with lower case): mixed-case text, still plain ASCII bytes. |
| [`ordrsp-d96a-s3-unoa-accepted`](valid/ordrsp-d96a-s3-unoa-accepted.edi) | ORDRSP | D.96A | 3 | UNOA | LF | D.96A order response accepting the three lines of orders-d96a-s3-unoa-multi-line without amendment. |
| [`desadv-d96a-s3-unoa-sscc`](valid/desadv-d96a-s3-unoa-sscc.edi) | DESADV | D.96A | 3 | UNOA | LF | D.96A despatch advice with one pallet identified by an SSCC carrying two lines. |
| [`orders-d01b-s3-unoc-basic`](valid/orders-d01b-s3-unoc-basic.edi) | ORDERS | D.01B | 3 | UNOC | LF | D.01B ORDERS over syntax 3 with UNOC text, a requested delivery date and prices. |
| [`orders-d01b-s3-unoa-group`](valid/orders-d01b-s3-unoa-group.edi) | ORDERS | D.01B | 3 | UNOA | LF | The message is wrapped in a functional group (UNG/UNE) inside the interchange. |
| [`orders-d01b-s3-unoa-test-interchange`](valid/orders-d01b-s3-unoa-test-interchange.edi) | ORDERS | D.01B | 3 | UNOA | LF | UNB requests an acknowledgement, carries an agreement identifier and sets the test indicator. |
| [`orders-d01b-s4-unoc-repetition-separator`](valid/orders-d01b-s4-unoc-repetition-separator.edi) | ORDERS | D.01B | 4 | UNOC | LF | Syntax 4: UNA declares the asterisk as repetition separator and one data element is repeated three times; an escaped asterisk stays literal. |
| [`orders-d01b-s4-unow-utf8`](valid/orders-d01b-s4-unow-utf8.edi) | ORDERS | D.01B | 4 | UNOW | LF | Syntax 4 with UNOW (UTF-8): characters outside ISO 8859-1 encoded on two, three and four bytes. |
| [`ordrsp-d01b-s3-unoc-accepted`](valid/ordrsp-d01b-s3-unoc-accepted.edi) | ORDRSP | D.01B | 3 | UNOC | LF | Order response accepting every line without amendment. |
| [`ordrsp-d01b-s4-unoc-changes`](valid/ordrsp-d01b-s4-unoc-changes.edi) | ORDRSP | D.01B | 4 | UNOC | LF | Syntax 4 order response with one accepted line, one changed line (quantity and price) and one rejected line; new delivery date. |
| [`desadv-d01b-s3-unoc-sscc`](valid/desadv-d01b-s3-unoc-sscc.edi) | DESADV | D.01B | 3 | UNOC | LF | Despatch advice with one pallet identified by an SSCC carrying two lines. |
| [`desadv-d01b-s4-unow-packaging-levels`](valid/desadv-d01b-s4-unow-packaging-levels.edi) | DESADV | D.01B | 4 | UNOW | LF | Syntax 4 / UNOW despatch advice with a pallet, two cartons below it (hierarchy via CPS), each with its SSCC and a batch number. |
| [`contrl-s3-unoa-accepted`](valid/contrl-s3-unoa-accepted.edi) | CONTRL | — | 3 | UNOA | LF | Syntax 3 CONTRL accepting the interchange and both messages of orders-d96a-s3-unoa-multi-message. |
| [`contrl-s4-unow-accepted`](valid/contrl-s4-unow-accepted.edi) | CONTRL | — | 4 | UNOW | LF | Syntax 4 CONTRL, itself in UNOW, accepting the interchange and its message. |
| [`contrl-s3-unoa-rejected`](valid/contrl-s3-unoa-rejected.edi) | CONTRL | — | 3 | UNOA | LF | Syntax 3 CONTRL rejecting the whole interchange because the UNZ reference does not match UNB. |
| [`contrl-s3-unoa-partially-rejected`](valid/contrl-s3-unoa-partially-rejected.edi) | CONTRL | — | 3 | UNOA | LF | Syntax 3 CONTRL acknowledging the interchange, accepting the first message and rejecting the second one because of its UNT count. |

## Invalid samples

| Sample | Code | Layer | Defect |
| --- | --- | --- | --- |
| [`unt-count-mismatch`](invalid/unt-count-mismatch.edi) | `UNT_COUNT_MISMATCH` | envelope | The second message declares one segment too many in UNT. |
| [`unt-reference-mismatch`](invalid/unt-reference-mismatch.edi) | `UNT_REFERENCE_MISMATCH` | envelope | UNT repeats reference 2 while UNH opened the message with 1. |
| [`unz-count-mismatch`](invalid/unz-count-mismatch.edi) | `UNZ_COUNT_MISMATCH` | envelope | UNZ announces two messages but the interchange contains one. |
| [`unz-reference-mismatch`](invalid/unz-reference-mismatch.edi) | `UNZ_REFERENCE_MISMATCH` | envelope | UNZ carries a different interchange reference than UNB. |
| [`unsupported-syntax-version`](invalid/unsupported-syntax-version.edi) | `UNSUPPORTED_SYNTAX_VERSION` | envelope | UNB announces syntax version 9. |
| [`missing-mandatory-segment`](invalid/missing-mandatory-segment.edi) | `MISSING_MANDATORY_SEGMENT` | structure | BGM, mandatory in ORDERS, is absent. |
| [`too-many-repetitions`](invalid/too-many-repetitions.edi) | `TOO_MANY_REPETITIONS` | structure | BGM appears twice; it is allowed once. |
| [`segment-out-of-order`](invalid/segment-out-of-order.edi) | `SEGMENT_OUT_OF_ORDER` | structure | The optional FTX comes between the two NAD segments instead of before them. |
| [`missing-mandatory-element`](invalid/missing-mandatory-element.edi) | `MISSING_MANDATORY_ELEMENT` | element | The QTY composite has a qualifier but no quantity. |
| [`invalid-data-type`](invalid/invalid-data-type.edi) | `INVALID_DATA_TYPE` | element | The line item number, a numeric element, is the text ONE. |
| [`value-too-long`](invalid/value-too-long.edi) | `VALUE_TOO_LONG` | element | The BGM document number has 36 characters where 35 are allowed. |
| [`unknown-code`](invalid/unknown-code.edi) | `UNKNOWN_CODE` | code | The party qualifier QQQ is not in the code list. |
| [`invalid-una`](invalid/invalid-una.edi) | `INVALID_UNA` | tokenizer | UNA reuses the colon as both component and element separator. |
| [`unexpected-end-of-file`](invalid/unexpected-end-of-file.edi) | `UNEXPECTED_END_OF_FILE` | tokenizer | The interchange is truncated in the middle of a NAD segment; UNT and UNZ are missing. |
| [`invalid-character-unoa`](invalid/invalid-character-unoa.edi) | `INVALID_CHARACTER` | tokenizer | An UNOA interchange contains the byte 0xC9 (capital E acute in ISO 8859-1), carried by a party name added to NAD. |
| [`invalid-character-unow`](invalid/invalid-character-unow.edi) | `INVALID_CHARACTER` | tokenizer | A UNOW interchange contains a byte sequence that is not UTF-8. |
| [`unsupported-charset`](invalid/unsupported-charset.edi) | `UNSUPPORTED_CHARSET` | tokenizer | UNB announces the character set identifier UNOZ, which Libredi does not support. |
