import { type Separators, TokenizeError, Tokenizer, TokenKind } from "../index.ts";

export interface Token {
  readonly kind: number;
  readonly start: number;
  readonly end: number;
}

export interface Tokenized {
  /** Every token delivered, in order, including those before an error. */
  readonly tokens: Token[];
  /** The separators in force for each batch, in order. */
  readonly batches: Separators[];
  /** The separators in force for each token, in order. */
  readonly separatorsOfToken: Separators[];
  /** The error that stopped the tokenizer, if any. */
  readonly error: TokenizeError | null;
  readonly tokenizer: Tokenizer;
}

/** Text in the tests is Latin-1: one character is one byte. */
export function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

export function textOf(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString("latin1");
}

/** Runs the tokenizer to the end, or to its first error, and collects everything it delivered. */
export function tokenize(input: Uint8Array | string, batchSize?: number): Tokenized {
  const bytes = typeof input === "string" ? bytesOf(input) : input;
  const tokenizer = new Tokenizer(bytes, batchSize === undefined ? undefined : { batchSize });
  const tokens: Token[] = [];
  const batches: Separators[] = [];
  const separatorsOfToken: Separators[] = [];
  let error: TokenizeError | null = null;
  try {
    for (const batch of tokenizer) {
      batches.push(batch.separators);
      for (let i = 0; i < batch.length; i++) {
        separatorsOfToken.push(batch.separators);
        tokens.push({
          kind: batch.kinds[i] as number,
          start: batch.starts[i] as number,
          end: batch.ends[i] as number,
        });
      }
    }
  } catch (caught) {
    if (!(caught instanceof TokenizeError)) {
      throw caught;
    }
    error = caught;
  }
  return { tokens, batches, separatorsOfToken, error, tokenizer };
}

const LABELS: Record<number, string> = {
  [TokenKind.ServiceStringAdvice]: "una",
  [TokenKind.SegmentTag]: "tag",
  [TokenKind.Text]: "text",
  [TokenKind.EscapedText]: "esc",
  [TokenKind.ComponentSeparator]: "comp",
  [TokenKind.ElementSeparator]: "elem",
  [TokenKind.RepetitionSeparator]: "rep",
  [TokenKind.SegmentTerminator]: "end",
};

/** Tokens as readable strings such as `tag:UNB` or `esc:A?+B`, for example-based tests. */
export function show(input: string, batchSize?: number): string[] {
  const bytes = bytesOf(input);
  const { tokens, error } = tokenize(bytes, batchSize);
  if (error !== null) {
    throw error;
  }
  return tokens.map((token) => `${LABELS[token.kind]}:${textOf(bytes, token.start, token.end)}`);
}

/** The tokenizer's error for an input that must fail. */
export function failure(input: Uint8Array | string, batchSize?: number): TokenizeError {
  const { error } = tokenize(input, batchSize);
  if (error === null) {
    throw new Error("expected the tokenizer to fail, but it did not");
  }
  return error;
}
