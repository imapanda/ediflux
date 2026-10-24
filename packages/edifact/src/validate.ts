import { EnvelopeChecker, type IssueSink } from "./envelope.ts";
import { ParseError, TokenizeError } from "./errors.ts";
import {
  ISSUE_CATALOGUE,
  type IssueDraft,
  isIssueCode,
  makeIssue,
  type ValidationIssue,
} from "./issues.ts";
import type { LineColumn } from "./line-index.ts";
import { type ParseOptions, parseMessages } from "./parser.ts";
import type { ParseIssue } from "./types.ts";

export interface ValidateOptions {
  /** Most issues to keep (all are counted). Default 1000. */
  readonly maxIssues?: number;
  /** Most memory, in bytes, for the arrays of one message; see {@link ParseOptions}. */
  readonly memoryBudget?: number;
}

export interface ValidationReport {
  /** The first issues found, in file order, at most `maxIssues` of them. */
  readonly issues: readonly ValidationIssue[];
  /** How many issues were found, including the ones that were not kept. */
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  /** No error was found. Warnings do not count. */
  readonly valid: boolean;
  /**
   * The whole file was read. False when the check stopped on a problem that makes the rest of the
   * file unreadable (a cut-off file, a bad UNA string, a message too large for the memory budget):
   * the issue says which, and what comes after it has not been checked.
   */
  readonly complete: boolean;
  /** Messages and interchanges that were read before the check ended. */
  readonly messageCount: number;
  readonly interchangeCount: number;
}

const DEFAULT_MAX_ISSUES = 1000;

/**
 * Keeps the first issues, counts all of them. The envelope check and the reader of the values find
 * theirs in two sequences that are each in file order and each cut at the limit, so that the first
 * issues of the file are among the ones kept: they are merged by offset at the end.
 */
class Collector implements IssueSink {
  readonly #max: number;
  readonly #byChecker: ValidationIssue[] = [];
  readonly #byReader: ValidationIssue[] = [];
  count = 0;
  errors = 0;
  warnings = 0;

  constructor(max: number) {
    this.#max = max;
  }

  add(draft: IssueDraft, locate: (offset: number) => LineColumn): void {
    this.#keep(this.#byChecker, draft, locate);
  }

  /** An issue the splitter found in a value (INVALID_CHARACTER, UNSUPPORTED_CHARSET). */
  addParseIssue(issue: ParseIssue): void {
    this.#keep(
      this.#byReader,
      {
        code: issue.code,
        segment: issue.position.segment,
        tag: issue.position.tag,
        element: issue.position.element,
        component: issue.position.component,
        repetition: issue.repetition,
        expected: issue.expected,
        found: issue.found,
        message: issue.message,
        offset: issue.offset,
      },
      () => ({ line: issue.line, column: issue.column }),
    );
  }

  /** The error that stopped the tokenizer or the parser. */
  addStop(error: TokenizeError | ParseError): void {
    if (!isIssueCode(error.code)) {
      throw error;
    }
    this.add(
      {
        code: error.code,
        segment: error.segment,
        tag: error.tag,
        message: error.detail,
        offset: error.offset,
      },
      () => ({ line: error.line, column: error.column }),
    );
  }

  /** Issues the splitter counted but did not keep: they are all errors. */
  addDropped(count: number): void {
    this.count += count;
    this.errors += count;
  }

  /** The kept issues in file order. */
  issues(): ValidationIssue[] {
    return [...this.#byChecker, ...this.#byReader]
      .sort((a, b) => a.offset - b.offset)
      .slice(0, this.#max);
  }

  #keep(into: ValidationIssue[], draft: IssueDraft, locate: (offset: number) => LineColumn): void {
    this.count++;
    if ((draft.severity ?? ISSUE_CATALOGUE[draft.code].severity) === "error") {
      this.errors++;
    } else {
      this.warnings++;
    }
    if (into.length < this.#max) {
      into.push(makeIssue(draft, locate));
    }
  }
}

/**
 * Checks a file and reports what is wrong with it, in plain language. A file is read once, a
 * message at a time, so the memory used is that of the largest message, not that of the file.
 *
 * What it checks: the file itself (the UNA string, segment tags, character sets, a file that is
 * cut off) and the envelopes (UNB and UNZ, UNG and UNE, UNH and UNT: mandatory data, references
 * and counts). It needs no registry for these.
 *
 * It never throws for a problem in the file: a file that stops the tokenizer ends the check with
 * an issue (`complete` is then false), and everything delivered before it has been checked.
 */
export function validate(bytes: Uint8Array, options: ValidateOptions = {}): ValidationReport {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  if (!Number.isInteger(maxIssues) || maxIssues < 0) {
    throw new RangeError(`maxIssues must be a non-negative integer, not ${maxIssues}`);
  }
  const collector = new Collector(maxIssues);
  const envelope = new EnvelopeChecker(collector);
  const parseOptions: ParseOptions = {
    maxIssues,
    ...(options.memoryBudget === undefined ? {} : { memoryBudget: options.memoryBudget }),
  };
  const stream = parseMessages(bytes, parseOptions);
  let complete = true;
  let messageCount = 0;
  const interchanges = new Set<number>();
  try {
    for (const item of stream.items()) {
      interchanges.add(item.interchange.index);
      if (item.kind === "message") {
        messageCount++;
        envelope.message(item);
      } else {
        envelope.envelope(item);
      }
    }
  } catch (error) {
    if (!(error instanceof TokenizeError || error instanceof ParseError)) {
      throw error;
    }
    complete = false;
    collector.addStop(error);
  }
  envelope.finish(complete);

  for (const issue of stream.issues) {
    collector.addParseIssue(issue);
  }
  collector.addDropped(stream.issueCount - stream.issues.length);

  return {
    issues: collector.issues(),
    issueCount: collector.count,
    errorCount: collector.errors,
    warningCount: collector.warnings,
    valid: collector.errors === 0,
    complete,
    messageCount,
    interchangeCount: interchanges.size,
  };
}
