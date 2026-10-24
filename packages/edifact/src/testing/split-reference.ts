import { TokenKind } from "../index.ts";
import type { Separators } from "../separators.ts";
import { referenceTokenize } from "./reference.ts";

/*
 * A second, plain version of splitMessages for the property tests, written from the README and
 * not from src/split.ts: it takes the tokens of the reference tokenizer (which is not the real
 * one either), and the character rules are one function per set. Offsets of invalid UTF-8 are not
 * modelled (null): only that, and where in the segment, a value is wrong.
 */

export interface RefIssue {
  readonly code: "INVALID_CHARACTER" | "UNSUPPORTED_CHARSET";
  /** Null when the model does not say (UNOW). */
  readonly offset: number | null;
  readonly line: number;
  readonly column: number;
  readonly position: {
    readonly segment: number;
    readonly tag: string;
    readonly element: number;
    readonly component: number;
  };
}

export interface RefFacts {
  readonly index: number;
  characterSet: string | null;
  syntaxIdentifier: string | null;
  syntaxVersion: string | null;
  una: string | null;
  unb: [number, number] | null;
}

export interface RefSlice {
  readonly start: number;
  readonly end: number;
  readonly segmentCount: number;
  readonly closed: boolean;
  readonly ung: [number, number] | null;
  readonly facts: RefFacts;
}

export interface RefSplit {
  readonly slices: RefSlice[];
  readonly issues: RefIssue[];
  /** All the issues, including the ones past `maxIssues`. */
  readonly issueCount: number;
  readonly failed: boolean;
}

const SETS = ["UNOA", "UNOB", "UNOC", "UNOW"];
const LEVEL_A = " .,-()/=!\"%&*;<>'+:?";

function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Up to 32 bytes, a printable ASCII byte as itself and any other as "?", "..." after a cut. */
function iso646(bytes: Uint8Array, start: number, end: number): string {
  let shown = "";
  for (let i = start; i < Math.min(end, start + 32); i++) {
    const byte = bytes[i] as number;
    shown += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
  }
  return end - start > 32 ? `${shown}...` : shown;
}

function allowedByte(set: string, byte: number, separators: Separators): boolean {
  if (set === "UNOB") {
    return byte >= 0x20 && byte <= 0x7e;
  }
  if (set === "UNOC") {
    return (byte >= 0x20 && byte <= 0x7e) || byte >= 0xa0;
  }
  const service = [
    separators.component,
    separators.element,
    separators.decimalMark,
    separators.release,
    separators.repetition,
    separators.terminator,
  ];
  return (
    LEVEL_A.includes(String.fromCharCode(byte)) ||
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    service.includes(byte)
  );
}

const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** True when the bytes are not well-formed UTF-8, or hold a control character. */
function badUtf8(bytes: Uint8Array, start: number, end: number): boolean {
  let decoded: string;
  try {
    decoded = STRICT.decode(bytes.subarray(start, end));
  } catch {
    return true;
  }
  return [...decoded].some((char) => {
    const code = char.codePointAt(0) as number;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

function lineColumn(bytes: Uint8Array, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (bytes[i] === 0x0a || (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function referenceSplit(bytes: Uint8Array, check = true, maxIssues = 100): RefSplit {
  const { tokens, separatorsOfToken, error } = referenceTokenize(bytes);
  const slices: RefSlice[] = [];
  const issues: RefIssue[] = [];
  let interchanges = 0;
  let facts: RefFacts | null = null;
  let used = false;
  let ung: [number, number] | null = null;
  let segment = 0;
  let element = 0;
  let component = 0;
  let repetitions = 0;
  let tag = "";
  let segmentStart = 0;
  let open: { start: number; end: number; segments: number } | null = null;

  const newFacts = (una: string | null): RefFacts => ({
    index: interchanges++,
    characterSet: null,
    syntaxIdentifier: null,
    syntaxVersion: null,
    una,
    unb: null,
  });
  const finish = (closed: boolean): void => {
    if (open !== null && facts !== null) {
      slices.push({
        start: open.start,
        end: open.end,
        segmentCount: open.segments,
        closed,
        ung,
        facts,
      });
    }
    open = null;
  };
  let issueCount = 0;
  const report = (code: RefIssue["code"], offset: number | null, at: number): void => {
    issueCount++;
    if (issues.length < maxIssues) {
      const { line, column } = lineColumn(bytes, at);
      issues.push({ code, offset, line, column, position: { segment, tag, element, component } });
    }
  };

  tokens.forEach((token, i) => {
    const separators = separatorsOfToken[i] as Separators;
    switch (token.kind) {
      case TokenKind.ServiceStringAdvice:
        finish(false);
        facts = newFacts(text(bytes, token.start + 3, token.end));
        used = false;
        segment = 0;
        ung = null;
        break;
      case TokenKind.SegmentTag: {
        tag = text(bytes, token.start, token.end);
        if (facts === null) {
          facts = newFacts(null);
        } else if (tag === "UNB" && used) {
          finish(false);
          facts = newFacts(null);
          segment = 0;
          ung = null;
        }
        if (tag === "UNH") {
          finish(false);
          open = { start: token.start, end: token.start, segments: 0 };
        } else if (open !== null && ["UNG", "UNE", "UNZ"].includes(tag)) {
          finish(false);
        }
        used = true;
        segmentStart = token.start;
        segment++;
        element = 0;
        component = 0;
        repetitions = 0;
        break;
      }
      case TokenKind.ElementSeparator:
        element++;
        component = 1;
        repetitions = 0;
        break;
      case TokenKind.ComponentSeparator:
        component++;
        break;
      case TokenKind.RepetitionSeparator:
        component = 1;
        repetitions++;
        break;
      case TokenKind.Text:
      case TokenKind.EscapedText: {
        const current = facts as RefFacts;
        if (tag === "UNB" && element === 1 && component <= 2 && repetitions === 0) {
          if (component === 1) {
            current.syntaxIdentifier = iso646(bytes, token.start, token.end);
            const name = text(bytes, token.start, token.end);
            current.characterSet =
              token.end - token.start === 4 && SETS.includes(name) ? name : null;
            if (current.characterSet === null) {
              report("UNSUPPORTED_CHARSET", token.start, token.start);
            }
          } else {
            current.syntaxVersion = iso646(bytes, token.start, token.end);
          }
        } else if (check && current.characterSet !== null) {
          const set = current.characterSet;
          if (set === "UNOW") {
            if (badUtf8(bytes, token.start, token.end)) {
              report("INVALID_CHARACTER", null, token.start);
            }
          } else {
            for (let at = token.start; at < token.end; at++) {
              if (!allowedByte(set, bytes[at] as number, separators)) {
                report("INVALID_CHARACTER", at, at);
                break;
              }
            }
          }
        }
        break;
      }
      case TokenKind.SegmentTerminator: {
        const current = facts as RefFacts;
        if (open !== null) {
          open.segments++;
          open.end = token.end;
          if (tag === "UNT") {
            finish(true);
          }
        }
        if (tag === "UNB") {
          current.unb ??= [segmentStart, token.end];
        } else if (tag === "UNG") {
          ung = [segmentStart, token.end];
        } else if (tag === "UNE") {
          ung = null;
        } else if (tag === "UNZ") {
          facts = null;
          ung = null;
          segment = 0;
        }
        break;
      }
    }
  });
  if (error === null) {
    finish(false);
  }
  return { slices, issues, issueCount, failed: error !== null };
}
