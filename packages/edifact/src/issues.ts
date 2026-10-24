import type { LineColumn } from "./line-index.ts";

/*
 * The error model of the validator: what an issue is made of, and the catalogue of codes.
 *
 * An issue answers four questions for someone who does not know EDIFACT: what is wrong (`code`,
 * `message`), where (`position`, plus `line` and `column` in the file), what was expected and
 * what was found (`expected`, `found`), and what to do about it (`hint`). The codes are stable:
 * they are the names of the sample corpus (samples/edifact), a program may switch on them, and
 * renaming one is a breaking change. Messages and hints are English text for people; they can be
 * improved without a version change, so a program must not parse them.
 *
 * The catalogue below is the single source of the codes. docs/validation-errors.md lists it, and a
 * test keeps the two in step.
 */

/**
 * The first layer of validation that can find the problem, as the sample corpus names them:
 * `tokenizer` (service string, character set, file integrity), `envelope` (UNB, UNG, UNH, UNT,
 * UNE, UNZ), `structure` (segment order and repetition), `element` (type, length, mandatory
 * values) and `code` (code lists).
 */
export type ValidationLayer = "tokenizer" | "envelope" | "structure" | "element" | "code";

/** `error`: the message cannot be trusted as it is. `warning`: it can, but something is off. */
export type Severity = "error" | "warning";

/**
 * Where an issue is. `segment` is the 1-based number of the segment in the interchange (UNB is 1,
 * the UNA string is 0); for a segment that is missing it is the first segment after the gap, or
 * the one after the last when the file ends. `element` and `component` are 1-based, a composite
 * counts as one element and an empty element counts, and they are null when the issue concerns the
 * whole segment, the whole element or the whole file. `repetition` is the 1-based number of the
 * repetition of an element that uses the repetition separator (syntax version 4), counted from the
 * second: null means the element itself, which is its first repetition, and `component` counts
 * within the repetition. `tag` is null when there is no segment to name.
 */
export interface IssuePosition {
  readonly segment: number;
  readonly tag: string | null;
  readonly element: number | null;
  readonly component: number | null;
  readonly repetition: number | null;
}

export interface ValidationIssue {
  /** A stable name such as `UNT_COUNT_MISMATCH`, one of {@link ISSUE_CODES}. */
  readonly code: IssueCode;
  readonly severity: Severity;
  /** The layer that found it, which for a few codes is not the layer of the catalogue. */
  readonly layer: ValidationLayer;
  readonly position: IssuePosition;
  /** What the rules ask for, as a short phrase; null when there is nothing to compare. */
  readonly expected: string | null;
  /** What the file has, as a short phrase; null when there is nothing to show. */
  readonly found: string | null;
  /** What is wrong, in a sentence that names what it talks about. */
  readonly message: string;
  /** What to do about it. */
  readonly hint: string;
  /** Offset in the file of the byte at fault, from 0. */
  readonly offset: number;
  /** Line and column of that byte, both from 1; the column counts bytes. */
  readonly line: number;
  readonly column: number;
}

/** Values for the words in braces of a message, to show a filled example in the documentation. */
interface Example {
  readonly tag?: string;
  readonly expected?: string;
  readonly found?: string;
  readonly unit?: string;
}

interface CodeInfo {
  readonly layer: ValidationLayer;
  readonly severity: Severity;
  /** A few words for lists and headings. */
  readonly title: string;
  /** For the catalogue: when the code is raised. */
  readonly meaning: string;
  /**
   * The message, with `{expected}`, `{found}`, `{tag}` and `{unit}` filled in. A finder that knows
   * better (the tokenizer, which names the place in its own words) gives its own.
   */
  readonly message: string;
  readonly hint: string;
  /** What to put in the braces when the documentation shows the message. */
  readonly example?: Example;
}

/** The catalogue: every code the validator can report, with its layer and default severity. */
export const ISSUE_CATALOGUE = {
  INVALID_UNA: {
    layer: "tokenizer",
    severity: "error",
    title: "The UNA service string is not valid",
    meaning:
      "The UNA string, which declares the six service characters, uses a character that is not punctuation, a decimal mark that is neither . nor ,, or the same character twice.",
    message:
      "The UNA service string is not valid: the component separator and the element separator are both ':'.",
    hint: "Write UNA followed by six different punctuation marks: component separator, element separator, decimal mark (. or ,), release character, repetition separator (a space before syntax version 4) and segment terminator. The usual string is UNA:+.? '.",
  },
  UNEXPECTED_END_OF_FILE: {
    layer: "tokenizer",
    severity: "error",
    title: "The file ends too early",
    meaning:
      "The file ends inside the UNA string, a segment tag or a segment, or right after a release character. Everything delivered before is still checked, and what the cut took away is not reported as missing.",
    message:
      'The file ends inside the {tag} segment (segment 6): the segment terminator "\'" is missing.',
    hint: "The file was probably cut off. Check that all of it was received or copied, and that every segment ends with its terminator.",
    example: { tag: "NAD" },
  },
  INVALID_SEGMENT_TAG: {
    layer: "tokenizer",
    severity: "error",
    title: "A segment does not start with a valid tag",
    meaning:
      "A segment does not begin with three capital letters or digits followed by the element separator or the terminator.",
    message:
      'Segment 4 does not start with a valid tag: a tag is three capital letters or digits followed by the element separator "+" or the segment terminator "\'", but found "a".',
    hint: "A segment starts with a three-character tag such as BGM or NAD, then the element separator or the terminator. Look for a stray character, a lowercase tag or a missing terminator before this point.",
  },
  INVALID_CHARACTER: {
    layer: "tokenizer",
    severity: "error",
    title: "A character is not allowed in the character set",
    meaning:
      "A value holds a byte that the character set named in UNB does not allow, such as a lowercase letter in UNOA, a control character, or a broken UTF-8 sequence in UNOW.",
    message: 'Invalid character in UNOA: "p" is not a character of UNOA.',
    hint: "Re-encode the file in the character set that UNB declares, or declare a wider one in UNB: UNOB for lowercase letters, UNOC for Western European accents, UNOW (UTF-8) for any character.",
  },
  UNSUPPORTED_CHARSET: {
    layer: "tokenizer",
    severity: "error",
    title: "The character set is not supported",
    meaning:
      "The syntax identifier in UNB is not one of the character sets that are read: UNOA, UNOB, UNOC or UNOW. Values are then read as ISO 8859-1 and not checked.",
    message:
      'The character set "UNOZ" is not supported (UNOA, UNOB, UNOC and UNOW are); values are read as ISO 8859-1 and not checked.',
    hint: "Declare UNOA, UNOB, UNOC or UNOW in the first component of the first element of UNB, and write the file in that set.",
  },
  MESSAGE_TOO_LARGE: {
    layer: "tokenizer",
    severity: "error",
    title: "A message is larger than the memory budget",
    meaning:
      "A message, or a run of segments outside messages, needs more memory than the budget allows. The check stops there; the file may be valid, only too large to check as it is.",
    message:
      "The message that starts here needs more than the memory budget of 67108864 bytes; raise memoryBudget, or check that the file has the UNH and UNT segments it should.",
    hint: "Raise memoryBudget if the message really is that large. If it is not, a UNT is probably missing, which makes the rest of the file one message.",
  },
  TOO_MANY_ELEMENT_REPETITIONS: {
    layer: "tokenizer",
    severity: "error",
    title: "An element is repeated too many times",
    meaning: "An element has more than 65,535 repetitions. The check stops there.",
    message: "An element is repeated more than 65,535 times.",
    hint: "Look for a repetition separator used as ordinary text (write it with the release character in front), or for a missing segment terminator.",
  },
  UNSUPPORTED_SYNTAX_VERSION: {
    layer: "envelope",
    severity: "error",
    title: "The syntax version is not supported",
    meaning:
      "The second component of the first element of UNB is not 3 or 4, the ISO 9735 syntax versions that are read. An empty version is a missing mandatory element instead.",
    message: "UNB declares syntax version {found}, which is not supported.",
    hint: "Use syntax version 3 or 4, as the second component of the first element of UNB (for example UNOC:3).",
    example: { found: "9" },
  },
  MISSING_ENVELOPE_SEGMENT: {
    layer: "envelope",
    severity: "error",
    title: "An envelope segment is missing",
    meaning:
      "A message has no UNT, a group no UNE, an interchange no UNZ, or the messages are not preceded by a UNB. The position is the segment found where the missing one belongs, or the one after the last when the file ends.",
    message: "The {expected} segment is missing.",
    hint: "Every UNB is closed by UNZ, every UNG by UNE and every UNH by UNT. Add the missing segment, or check that the file was not cut off.",
    example: { expected: "UNT" },
  },
  UNEXPECTED_SEGMENT: {
    layer: "envelope",
    severity: "error",
    title: "A segment is where no segment can be",
    meaning:
      "A segment that is not part of a message stands between messages, or UNT or UNE has nothing to close.",
    message:
      "The {tag} segment is between messages, where only the envelope segments UNB, UNG, UNE and UNZ can be.",
    hint: "Segments other than the envelope segments belong between a UNH and its UNT. Move the segment into its message, or remove it.",
    example: { tag: "BGM" },
  },
  UNT_COUNT_MISMATCH: {
    layer: "envelope",
    severity: "error",
    title: "UNT counts the wrong number of segments",
    meaning:
      "The first element of UNT is not the number of segments of the message, UNH and UNT included.",
    message:
      "UNT gives the number of segments as {found}, but the message has {expected} (UNH and UNT included).",
    hint: "Count the segments from UNH to UNT inclusive and write that number in the first element of UNT. A sender that edits a message by hand must update it.",
    example: { expected: "12", found: "13" },
  },
  UNT_REFERENCE_MISMATCH: {
    layer: "envelope",
    severity: "error",
    title: "UNT closes another message than UNH opened",
    meaning: "The message reference in UNT is not the one in UNH.",
    message: "UNT closes message {found}, but UNH opened message {expected}.",
    hint: "Write the message reference of UNH (its first element) as the second element of UNT.",
    example: { expected: "1", found: "2" },
  },
  UNE_COUNT_MISMATCH: {
    layer: "envelope",
    severity: "error",
    title: "UNE counts the wrong number of messages",
    meaning: "The first element of UNE is not the number of messages in the group.",
    message:
      "UNE gives the number of messages in the group as {found}, but the group has {expected}.",
    hint: "Write the number of messages between UNG and UNE in the first element of UNE.",
    example: { expected: "2", found: "3" },
  },
  UNE_REFERENCE_MISMATCH: {
    layer: "envelope",
    severity: "error",
    title: "UNE closes another group than UNG opened",
    meaning: "The group reference in UNE is not the one in UNG.",
    message: "UNE closes group {found}, but UNG opened group {expected}.",
    hint: "Write the group reference of UNG (its fifth element) as the second element of UNE.",
    example: { expected: "G1", found: "G2" },
  },
  UNZ_COUNT_MISMATCH: {
    layer: "envelope",
    severity: "error",
    title: "UNZ counts the wrong number of messages or groups",
    meaning:
      "The first element of UNZ is not the number of messages in the interchange, or the number of groups when it holds groups.",
    message: "UNZ gives the number of {unit} in the interchange as {found}, but it has {expected}.",
    hint: "Write the number of messages (or of groups, if the interchange uses groups) between UNB and UNZ in the first element of UNZ.",
    example: { expected: "1", found: "2", unit: "messages" },
  },
  UNZ_REFERENCE_MISMATCH: {
    layer: "envelope",
    severity: "error",
    title: "UNZ closes another interchange than UNB opened",
    meaning: "The interchange control reference in UNZ is not the one in UNB.",
    message: "UNZ closes interchange {found}, but UNB opened interchange {expected}.",
    hint: "Write the interchange control reference of UNB (its fifth element) as the second element of UNZ.",
    example: { expected: "IC000001", found: "IC999999" },
  },
  MISSING_MANDATORY_ELEMENT: {
    layer: "element",
    severity: "error",
    title: "A mandatory element or component is empty",
    meaning:
      "A data element or component that the segment definition makes mandatory has no value. The envelope segments (UNB, UNG, UNH, UNT, UNE, UNZ) have fixed definitions and are checked without a registry: for them the issue has the layer `envelope`.",
    message: "The mandatory {expected} of the {tag} segment is empty.",
    hint: "Give the element a value, even if the sender has nothing to say: a mandatory element cannot be left out.",
    example: { expected: "interchange control reference", tag: "UNB" },
  },
  INVALID_DATA_TYPE: {
    layer: "element",
    severity: "error",
    title: "A value is not of the right type",
    meaning:
      "A value does not match the data type of its element: letters where digits are expected, or digits where letters are expected. The counts of UNT, UNE and UNZ are checked without a registry: for them the issue has the layer `envelope`.",
    message: "The {tag} segment has {found} where {expected} is expected.",
    hint: "Check the value against the type of the element: numeric elements hold digits (and a sign and a decimal mark), alphabetic elements hold letters.",
    example: { tag: "UNT", found: "THREE", expected: "a whole number" },
  },
} as const satisfies Record<string, CodeInfo>;

export type IssueCode = keyof typeof ISSUE_CATALOGUE;

/** Every code of the catalogue, in catalogue order. */
export const ISSUE_CODES = Object.keys(ISSUE_CATALOGUE) as IssueCode[];

export function isIssueCode(value: string): value is IssueCode {
  return Object.hasOwn(ISSUE_CATALOGUE, value);
}

/** What a finder knows about an issue; the rest comes from the catalogue. */
export interface IssueDraft {
  readonly code: IssueCode;
  /** The segment, with `element`, `component` and `repetition` when they apply. */
  readonly segment: number;
  readonly tag: string | null;
  readonly element?: number | null;
  readonly component?: number | null;
  readonly repetition?: number | null;
  readonly expected?: string | null;
  readonly found?: string | null;
  /** Layer and severity where they differ from the default of the code. */
  readonly layer?: ValidationLayer;
  readonly severity?: Severity;
  /** The message and the hint, when the finder has better ones than the catalogue's. */
  readonly message?: string;
  readonly hint?: string;
  /** Fills `{unit}` of a message. */
  readonly unit?: string;
  readonly offset: number;
}

const PLACEHOLDER = /\{(expected|found|tag|unit)\}/g;

/** A message from a lower layer may lack the full stop that the others end with. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const MAX_SHOWN = 32;

/**
 * Text from the file, fit to be quoted in a message: control characters shown as "?" and cut after
 * 32 characters. A reference in a file can hold anything, including line breaks and escape
 * sequences, and must not be able to forge a line of a log.
 */
export function shown(text: string): string {
  const cut = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;
  let out = "";
  for (const char of cut) {
    const code = char.codePointAt(0) as number;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }
  return out;
}

/** Makes an issue of a draft: the position, the text of the catalogue, and where in the file. */
export function makeIssue(
  draft: IssueDraft,
  locate: (offset: number) => LineColumn,
): ValidationIssue {
  const info: CodeInfo = ISSUE_CATALOGUE[draft.code];
  const { line, column } = locate(draft.offset);
  const values = {
    expected: draft.expected ?? "what the rules ask for",
    found: draft.found ?? "something else",
    tag: draft.tag ?? "last",
    unit: draft.unit ?? "messages",
  };
  return {
    code: draft.code,
    severity: draft.severity ?? info.severity,
    layer: draft.layer ?? info.layer,
    position: {
      segment: draft.segment,
      tag: draft.tag,
      element: draft.element ?? null,
      component: draft.component ?? null,
      repetition: draft.repetition ?? null,
    },
    expected: draft.expected ?? null,
    found: draft.found ?? null,
    message: sentence(
      draft.message ??
        info.message.replace(PLACEHOLDER, (_all, name: keyof typeof values) => values[name]),
    ),
    hint: draft.hint ?? info.hint,
    offset: draft.offset,
    line,
    column,
  };
}

/** The message of a code with the example values of the catalogue in the place of its words in braces. */
export function exampleMessage(code: IssueCode): string {
  const info: CodeInfo = ISSUE_CATALOGUE[code];
  const example: Example = info.example ?? {};
  const values = {
    expected: example.expected ?? "what the rules ask for",
    found: example.found ?? "something else",
    tag: example.tag ?? "last",
    unit: example.unit ?? "messages",
  };
  return info.message.replace(PLACEHOLDER, (_all, name: keyof typeof values) => values[name]);
}

/**
 * An issue as one readable block, for a terminal or a log:
 *
 * ```text
 * error UNT_COUNT_MISMATCH at line 23, column 5 (segment 23 UNT, element 1)
 *   UNT gives the number of segments as 13, but the message has 12 (UNH and UNT included).
 *   Hint: Count the segments from UNH to UNT inclusive ...
 * ```
 */
export function formatIssue(issue: ValidationIssue): string {
  const { segment, tag, element, component, repetition } = issue.position;
  const parts = [`segment ${segment}${tag === null ? "" : ` ${tag}`}`];
  if (element !== null) {
    parts.push(`element ${element}`);
  }
  if (repetition !== null) {
    parts.push(`repetition ${repetition}`);
  }
  if (component !== null) {
    parts.push(`component ${component}`);
  }
  return [
    `${issue.severity} ${issue.code} at line ${issue.line}, column ${issue.column} (${parts.join(", ")})`,
    `  ${issue.message}`,
    `  Hint: ${issue.hint}`,
  ].join("\n");
}
