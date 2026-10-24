/*
 * Deterministic synthetic ORDERS interchanges for the benchmark. Everything here is invented: the
 * numbers sit under the GS1 demonstration prefix 952 and the texts are made-up product names, as
 * in samples/edifact. The same seed always gives the same bytes, so two runs, or two machines,
 * tokenize the same input.
 */

export interface GeneratedInterchange {
  /** UNA, UNB, the messages, UNZ. */
  readonly bytes: Uint8Array;
  /** Byte range of each message, UNH to UNT included. */
  readonly messages: readonly { readonly start: number; readonly end: number }[];
  /** Number of segments in the file, UNA excluded. */
  readonly segments: number;
}

export interface GenerateOptions {
  readonly messages: number;
  /** Order lines per message; each line is five segments (LIN, PIA, IMD, QTY, PRI). */
  readonly linesPerMessage: number;
  readonly seed?: number;
  /** Written after every segment. Default LF, as in the sample corpus. */
  readonly lineBreak?: "" | "\n" | "\r\n";
}

/** A small, well-known 32-bit generator: the benchmark must not depend on Math.random. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "SAMPLE",
  "WIDGET",
  "GADGET",
  "BOLT",
  "PANEL",
  "CABLE",
  "FILTER",
  "VALVE",
  "SENSOR",
  "BRACKET",
  "SPRING",
  "GASKET",
];

/** Digits of a GTIN-13 under the demonstration prefix, check digit included. */
function gtin(random: () => number): string {
  const body = `952${String(Math.floor(random() * 1e9)).padStart(9, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

export function generateOrders(options: GenerateOptions): GeneratedInterchange {
  const random = mulberry32(options.seed ?? 1);
  const lineBreak = options.lineBreak ?? "\n";
  const chunks: string[] = [];
  const messages: { start: number; end: number }[] = [];
  let length = 0;
  let segments = 0;
  const push = (text: string): void => {
    chunks.push(text);
    length += text.length;
  };
  const segment = (text: string): void => {
    push(`${text}'${lineBreak}`);
    segments++;
  };

  push(`UNA:+.? '${lineBreak}`);
  segment("UNB+UNOA:3+9520000000011:14+9520000000035:14+301015:0830+IC000001");
  for (let m = 1; m <= options.messages; m++) {
    const start = length;
    let count = 0;
    const body = (text: string): void => {
      segment(text);
      count++;
    };
    body(`UNH+${m}+ORDERS:D:96A:UN:LBR001`);
    body(`BGM+220+PO-${String(m).padStart(6, "0")}+9`);
    body("DTM+137:20301015:102");
    body("NAD+BY+9520000000011::9");
    body("NAD+SU+9520000000035::9");
    for (let line = 1; line <= options.linesPerMessage; line++) {
      const name = `${WORDS[Math.floor(random() * WORDS.length)]} ${WORDS[Math.floor(random() * WORDS.length)]} ${Math.floor(random() * 900) + 100}`;
      // One description in twenty carries service characters, escaped with the release character.
      const text = random() < 0.05 ? `${name} ?+ 2?:1 ?'S` : name;
      body(`LIN+${line}++${gtin(random)}:EN`);
      body(`PIA+1+${String(Math.floor(random() * 1e6)).padStart(6, "0")}:SA`);
      body(`IMD+F++:::${text}`);
      body(`QTY+21:${Math.floor(random() * 99) + 1}:PCE`);
      body(`PRI+AAA:${Math.floor(random() * 5000) / 100}:CA`);
    }
    body("UNS+S");
    body(`CNT+2:${options.linesPerMessage}`);
    segment(`UNT+${count + 1}+${m}`);
    messages.push({ start, end: length - lineBreak.length });
  }
  segment(`UNZ+${options.messages}+IC000001`);

  const bytes = new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
  return { bytes, messages, segments };
}
