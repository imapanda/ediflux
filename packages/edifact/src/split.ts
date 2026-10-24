import type { CharacterSet } from "./charset.ts";
import {
  CharacterChecker,
  characterSetOf,
  decodeText,
  explainInvalidCharacter,
} from "./charset.ts";
import { type LineColumn, LineCursor } from "./line-index.ts";
import type { Separators } from "./separators.ts";
import { Source } from "./source.ts";
import { Tokenizer } from "./tokenizer.ts";
import { TokenKind } from "./tokens.ts";
import {
  type InterchangeInfo,
  type ParseIssue,
  ParseIssueCode,
  type ServiceStringAdvice,
  type Span,
} from "./types.ts";

export interface SplitOptions {
  /** Check every value against the character set of the interchange. Default true. */
  readonly checkCharacters?: boolean;
  /** Most issues to keep (all are counted). Default 100. */
  readonly maxIssues?: number;
  /** Tokens per batch of the tokenizer underneath. */
  readonly batchSize?: number;
}

/** A message located in the file: where it is and which interchange and group it is in. */
export interface MessageSlice extends Span {
  readonly kind: "message";
  readonly interchange: InterchangeInfo;
  /** The UNG segment of the group that the message is in, if it is in one. */
  readonly ung: Span | null;
  /** Segments, from UNH to UNT. */
  readonly segmentCount: number;
  /** The message ends with UNT. False when it runs into the next UNH, UNG, UNE, UNZ or the end of the file. */
  readonly closed: boolean;
}

const UNB = 0x554e42;
const UNG = 0x554e47;
const UNE = 0x554e45;
const UNH = 0x554e48;
const UNT = 0x554e54;
const UNZ = 0x554e5a;

/** An interchange while it is read: what UNA and UNB say, as they are met. */
class InterchangeFacts implements InterchangeInfo {
  readonly index: number;
  readonly source: Uint8Array;
  una: ServiceStringAdvice | null = null;
  separators: Separators;
  syntaxIdentifier: string | null = null;
  syntaxVersion: string | null = null;
  characterSet: CharacterSet | null = null;
  /** Checks values against `characterSet`; made once, when UNB names the set. */
  checker: CharacterChecker | null = null;
  unb: Span | null = null;
  readonly #sourceOf: Source;

  constructor(index: number, source: Source, separators: Separators) {
    this.index = index;
    this.source = source.bytes;
    this.#sourceOf = source;
    this.separators = separators;
  }

  locate(offset: number): LineColumn {
    return this.#sourceOf.locate(offset);
  }
}

const MAX_SHOWN = 32;

/**
 * Up to 32 bytes read as ISO 646: a printable ASCII byte as itself, any other as "?", and "..."
 * after a cut. The name of a character set comes from a file that nobody has checked yet, and
 * ends up in messages: it is kept short and printable.
 */
function iso646(bytes: Uint8Array, start: number, end: number): string {
  const shown = Math.min(end - start, MAX_SHOWN);
  let text = "";
  for (let i = 0; i < shown; i++) {
    const byte = bytes[start + i] as number;
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
  }
  return end - start > shown ? `${text}...` : text;
}

function tagName(code: number): string {
  return String.fromCharCode((code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff);
}

/**
 * Reads the tokens of the tokenizer once, cuts them into messages, and keeps what the envelope
 * says. It holds no segment: the memory it uses is a few numbers, whatever the size of the file.
 */
class Splitter {
  readonly source: Source;
  readonly issues: ParseIssue[] = [];
  issueCount = 0;
  messageCount = 0;
  readonly #check: boolean;
  readonly #maxIssues: number;
  readonly #tokenizer: Tokenizer;
  /** Issues come in file order, so their lines and columns are found in one pass in all. */
  readonly #lines: LineCursor;

  node: InterchangeFacts | null = null;
  nodeUsed = false;
  interchangeCount = 0;
  ung: Span | null = null;
  inMessage = false;
  messageStart = 0;
  messageEnd = 0;
  messageSegments = 0;
  segmentStart = 0;
  tagCode = 0;
  segmentNumber = 0;
  elementNo = 0;
  componentNo = 0;
  /** Repetition separators met in the element being read. */
  repetitionNo = 0;

  constructor(bytes: Uint8Array, options: SplitOptions) {
    const maxIssues = options.maxIssues ?? 100;
    if (!Number.isInteger(maxIssues) || maxIssues < 0) {
      throw new RangeError(`maxIssues must be a whole number, not ${maxIssues}`);
    }
    this.source = new Source(bytes);
    this.#check = options.checkCharacters ?? true;
    this.#maxIssues = maxIssues;
    this.#lines = new LineCursor(bytes);
    // Made now, so that an input or a batch size that is not valid is refused by the call.
    this.#tokenizer = new Tokenizer(
      bytes,
      options.batchSize === undefined ? {} : { batchSize: options.batchSize },
    );
  }

  *messages(): Generator<MessageSlice> {
    for (const batch of this.#tokenizer) {
      const { kinds, starts, ends, length, separators } = batch;
      for (let i = 0; i < length; i++) {
        const start = starts[i] as number;
        let done: MessageSlice | null = null;
        switch (kinds[i]) {
          case TokenKind.Text:
          case TokenKind.EscapedText:
            this.text(start, ends[i] as number);
            break;
          case TokenKind.ElementSeparator:
            this.elementNo++;
            this.componentNo = 1;
            this.repetitionNo = 0;
            break;
          case TokenKind.ComponentSeparator:
            this.componentNo++;
            break;
          case TokenKind.RepetitionSeparator:
            this.componentNo = 1;
            this.repetitionNo++;
            break;
          case TokenKind.SegmentTag:
            done = this.tag(start, separators);
            break;
          case TokenKind.SegmentTerminator:
            done = this.terminator(ends[i] as number);
            break;
          case TokenKind.ServiceStringAdvice:
            done = this.una(start, ends[i] as number, separators);
            break;
        }
        if (done !== null) {
          yield done;
        }
      }
    }
    const last = this.finishMessage(false);
    if (last !== null) {
      yield last;
    }
  }

  una(start: number, end: number, separators: Separators): MessageSlice | null {
    const done = this.finishMessage(false);
    this.node = new InterchangeFacts(this.interchangeCount++, this.source, separators);
    this.nodeUsed = false;
    this.node.una = {
      kind: "una",
      start,
      end,
      text: decodeText(this.source.bytes, start + 3, end, null),
    };
    this.segmentNumber = 0;
    this.ung = null;
    return done;
  }

  tag(start: number, separators: Separators): MessageSlice | null {
    const bytes = this.source.bytes;
    const code =
      ((bytes[start] as number) << 16) |
      ((bytes[start + 1] as number) << 8) |
      (bytes[start + 2] as number);
    let done: MessageSlice | null = null;
    if (this.node === null) {
      this.node = new InterchangeFacts(this.interchangeCount++, this.source, separators);
    } else if (code === UNB && this.nodeUsed) {
      // A new interchange that has no UNA, after one that has no UNZ.
      done = this.finishMessage(false);
      this.node = new InterchangeFacts(this.interchangeCount++, this.source, separators);
      this.segmentNumber = 0;
      this.ung = null;
    }
    if (code === UNH) {
      done = this.finishMessage(false);
      this.inMessage = true;
      this.messageStart = start;
      this.messageSegments = 0;
    } else if (this.inMessage && (code === UNG || code === UNE || code === UNZ)) {
      done = this.finishMessage(false);
    }
    this.nodeUsed = true;
    this.segmentStart = start;
    this.tagCode = code;
    this.segmentNumber++;
    this.elementNo = 0;
    this.componentNo = 0;
    this.repetitionNo = 0;
    return done;
  }

  terminator(end: number): MessageSlice | null {
    let done: MessageSlice | null = null;
    if (this.inMessage) {
      this.messageSegments++;
      this.messageEnd = end;
      if (this.tagCode === UNT) {
        done = this.finishMessage(true);
      }
    }
    const node = this.node as InterchangeFacts;
    if (this.tagCode === UNB) {
      node.unb = { start: this.segmentStart, end };
    } else if (this.tagCode === UNG) {
      this.ung = { start: this.segmentStart, end };
    } else if (this.tagCode === UNE) {
      this.ung = null;
    } else if (this.tagCode === UNZ) {
      this.node = null;
      this.ung = null;
      this.segmentNumber = 0;
    }
    return done;
  }

  text(start: number, end: number): void {
    const node = this.node as InterchangeFacts;
    if (
      this.tagCode === UNB &&
      this.elementNo === 1 &&
      this.componentNo <= 2 &&
      this.repetitionNo === 0
    ) {
      // The start of UNB is ISO 646 whatever the character set: read S001 as plain ASCII.
      const bytes = this.source.bytes;
      if (this.componentNo === 1) {
        node.syntaxIdentifier = iso646(bytes, start, end);
        node.characterSet = characterSetOf(bytes, start, end);
        node.checker =
          node.characterSet === null
            ? null
            : new CharacterChecker(node.characterSet, node.separators);
        if (node.characterSet === null) {
          this.report(
            ParseIssueCode.UnsupportedCharset,
            `The character set "${node.syntaxIdentifier}" is not supported (UNOA, UNOB, UNOC and UNOW are); values are read as ISO 8859-1 and not checked`,
            start,
          );
        }
      } else {
        node.syntaxVersion = iso646(bytes, start, end);
      }
      return;
    }
    const checker = node.checker;
    if (this.#check && checker !== null) {
      const bytes = this.source.bytes;
      const bad = checker.find(bytes, start, end);
      if (bad >= 0) {
        this.report(
          ParseIssueCode.InvalidCharacter,
          `Invalid character in ${checker.set}: ${explainInvalidCharacter(bytes, bad, checker.set)}`,
          bad,
        );
      }
    }
  }

  /** Ends the message being read, if there is one, and hands it out. */
  finishMessage(closed: boolean): MessageSlice | null {
    if (!this.inMessage) {
      return null;
    }
    this.inMessage = false;
    this.messageCount++;
    return {
      kind: "message",
      interchange: this.node as InterchangeFacts,
      ung: this.ung,
      start: this.messageStart,
      end: this.messageEnd,
      segmentCount: this.messageSegments,
      closed,
    };
  }

  report(code: ParseIssue["code"], message: string, offset: number): void {
    this.issueCount++;
    if (this.issues.length < this.#maxIssues) {
      const { line, column } = this.#lines.advanceTo(offset);
      this.issues.push({
        code,
        message,
        offset,
        line,
        column,
        position: {
          segment: this.segmentNumber,
          tag: tagName(this.tagCode),
          element: this.elementNo,
          component: this.componentNo,
        },
      });
    }
  }
}

/** The messages of a file, located but not parsed, one at a time. */
export class SliceStream implements Iterable<MessageSlice> {
  readonly #splitter: Splitter;
  #slices: Generator<MessageSlice> | null = null;

  constructor(bytes: Uint8Array, options: SplitOptions) {
    this.#splitter = new Splitter(bytes, options);
  }

  /** Problems found so far in the values (at most `maxIssues`). Complete once the stream has ended. */
  get issues(): readonly ParseIssue[] {
    return this.#splitter.issues;
  }

  /** How many problems were found, including the ones that were not kept. */
  get issueCount(): number {
    return this.#splitter.issueCount;
  }

  /** Messages handed out so far. */
  get messageCount(): number {
    return this.#splitter.messageCount;
  }

  /**
   * Every message, in file order. A file that is cut inside a message ends the loop with a
   * `TokenizeError`, after the messages before it; the cut message is not handed out. A stream
   * reads its input once: after a first loop, even one that stopped early, another yields nothing.
   */
  [Symbol.iterator](): Generator<MessageSlice> {
    this.#slices ??= this.#splitter.messages();
    return this.#slices;
  }
}

/**
 * Locates the messages of a file: for each, where it starts and ends, how many segments it has,
 * and the facts of its interchange (UNA, separators, syntax identifier, character set, UNB) and
 * group. Nothing but the envelope is read, so the memory used is a few numbers whatever the size
 * of the file, and the slices can be handed to workers that parse them. While it reads, it
 * checks every value against the character set that UNB declares (`issues`).
 */
export function splitMessages(bytes: Uint8Array, options: SplitOptions = {}): SliceStream {
  return new SliceStream(bytes, options);
}
