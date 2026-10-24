/*
 * Benchmark of the tokenizer: throughput and memory on a generated multi-megabyte interchange.
 *
 *   pnpm --filter @libredi/edifact bench                  # defaults: about 10 MB, 15 runs
 *   pnpm --filter @libredi/edifact bench -- --sweep       # also compare batch sizes
 *   pnpm --filter @libredi/edifact bench -- --size-mb=100 --runs=5 --no-baseline
 *   pnpm --filter @libredi/edifact bench -- --json                 # numbers for a script
 *
 * It runs on Node.js with `--expose-gc` (the script sets it) and prints Markdown tables to paste
 * in a pull request. Nothing here fails a build: a regression threshold is issue #54.
 * MB means 10^6 bytes. Timings are the median of the runs after a warm-up.
 */
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { Tokenizer, TokenKind } from "../src/index.ts";
import { generateOrders } from "./generate.ts";
import { parseToObjectTree } from "./object-tree.ts";

const options = parseOptions(process.argv.slice(2));
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) {
  console.error("Run with `node --expose-gc bench/run.ts` (the package script does).");
  process.exit(1);
}

/** Keeps the work observable so that the engine cannot drop it. */
let sink = 0;

// --- Inputs ------------------------------------------------------------------------------

// One order of 80 lines is about 9 KB (the "9 KB message" of docs/research/languages.md); a
// one-line order is about 0.6 KB. The big file holds enough 9 KB orders to reach the size asked.
const BIG_LINES = 80;
const bigMessages = Math.max(1, Math.round((options.sizeMb * 1e6) / 9_200));
const big = generateOrders({
  messages: bigMessages,
  linesPerMessage: BIG_LINES,
  seed: options.seed,
});
const small = generateOrders({
  messages: Math.max(1, Math.round((options.sizeMb * 1e6) / 560)),
  linesPerMessage: 3,
  seed: options.seed,
});

// --- Things to measure ---------------------------------------------------------------------

/** What any scanner pays just to look at every byte: one table lookup per byte, nothing else. */
const SPECIAL = new Uint8Array(256);
for (const byte of [0x27, 0x2b, 0x3a, 0x3f]) {
  SPECIAL[byte] = 1;
}

function rawLoop(bytes: Uint8Array): number {
  const length = bytes.length;
  let special = 0;
  for (let i = 0; i < length; i++) {
    special += SPECIAL[bytes[i] as number] as number;
  }
  return special;
}

/** The tokenizer with the lightest consumer: it only counts the tokens. */
function countTokens(bytes: Uint8Array, batchSize?: number): number {
  let tokens = 0;
  for (const batch of new Tokenizer(bytes, batchSize === undefined ? undefined : { batchSize })) {
    tokens += batch.length;
  }
  return tokens;
}

/** The tokenizer with a consumer that reads every token, as a parser would. */
function readTokens(bytes: Uint8Array, batchSize?: number): number {
  let segments = 0;
  let checksum = 0;
  for (const batch of new Tokenizer(bytes, batchSize === undefined ? undefined : { batchSize })) {
    const { kinds, starts, ends, length } = batch;
    for (let i = 0; i < length; i++) {
      if (kinds[i] === TokenKind.SegmentTag) {
        segments++;
      }
      checksum = (checksum + (ends[i] as number) - (starts[i] as number)) | 0;
    }
  }
  return segments + checksum;
}

/**
 * The tokenizer with a consumer that also turns every tag and value into a string, as the object
 * tree does. Strings are only measured, not kept: this is the like-for-like speed, not the memory.
 */
function decodeValues(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  let total = 0;
  for (const batch of new Tokenizer(bytes)) {
    const { kinds, starts, ends, length } = batch;
    for (let i = 0; i < length; i++) {
      const kind = kinds[i];
      if (
        kind === TokenKind.Text ||
        kind === TokenKind.EscapedText ||
        kind === TokenKind.SegmentTag
      ) {
        total += text.slice(starts[i] as number, ends[i] as number).length;
      }
    }
  }
  return total;
}

/** One tokenizer per message, as the translator will see them once issue #38 splits the file. */
function perMessage(
  bytes: Uint8Array,
  messages: readonly { start: number; end: number }[],
): number {
  let total = 0;
  for (const { start, end } of messages) {
    total += readTokens(bytes.subarray(start, end));
  }
  return total;
}

// --- Measuring -----------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

interface Timing {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

function time(work: () => number, runs = options.runs, warmup = options.warmup): Timing {
  for (let i = 0; i < warmup; i++) {
    sink ^= work();
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    gc?.();
    const start = performance.now();
    sink ^= work();
    samples.push(performance.now() - start);
  }
  return { medianMs: median(samples), minMs: Math.min(...samples), maxMs: Math.max(...samples) };
}

const mbPerSecond = (bytes: number, ms: number): number => bytes / 1e6 / (ms / 1000);
const fixed = (value: number, digits = 0): string => value.toFixed(digits);
const heapNow = (): number => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
};

/**
 * What the tokenizer holds while it runs and after it is done. `workingSet` is the ArrayBuffer
 * memory it adds (its batch: a few tens of KiB, sampled during the scan); `retained` is what
 * is still in use after a full collection (nothing, if it keeps no state).
 */
function tokenizerMemory(bytes: Uint8Array): { workingSet: number; retained: number } {
  gc?.();
  gc?.();
  const baseBuffers = process.memoryUsage().arrayBuffers;
  const baseTotal = heapNow();
  let workingSet = 0;
  let batches = 0;
  const tokenizer = new Tokenizer(bytes);
  for (const batch of tokenizer) {
    sink ^= batch.length;
    if (++batches % 16 === 1) {
      workingSet = Math.max(workingSet, process.memoryUsage().arrayBuffers - baseBuffers);
    }
  }
  gc?.();
  gc?.();
  const retained = Math.max(0, heapNow() - baseTotal);
  sink ^= tokenizer.locate(0).line;
  return { workingSet, retained };
}

/** Memory still held by the tree once it is built, after a full collection. */
function objectTreeRetained(bytes: Uint8Array): number {
  gc?.();
  gc?.();
  const base = heapNow();
  const tree = parseToObjectTree(bytes);
  gc?.();
  gc?.();
  const retained = heapNow() - base;
  sink ^= tree.length;
  return retained;
}

// --- Report --------------------------------------------------------------------------------

const bigBytes = big.bytes.length;
const smallBytes = small.bytes.length;
const smallAverage = smallBytes / small.messages.length;
const bigAverage = bigBytes / big.messages.length;

const tokens = countTokens(big.bytes);
const rows: {
  scenario: string;
  input: string;
  throughput: string;
  detail: string;
  range: string;
}[] = [];

function addThroughput(scenario: string, bytes: number, timing: Timing, detail: string): number {
  const rate = mbPerSecond(bytes, timing.medianMs);
  rows.push({
    scenario,
    input: `${fixed(bytes / 1e6, 1)} MB`,
    throughput: `${fixed(rate)} MB/s`,
    detail,
    range: `${fixed(mbPerSecond(bytes, timing.maxMs))}–${fixed(mbPerSecond(bytes, timing.minMs))}`,
  });
  return rate;
}

const rawTiming = time(() => rawLoop(big.bytes));
addThroughput("raw byte loop (the floor: read every byte once)", bigBytes, rawTiming, "");

const countTiming = time(() => countTokens(big.bytes));
addThroughput(
  "tokenizer, counting tokens",
  bigBytes,
  countTiming,
  `${fixed(tokens / 1e6, 2)} M tokens, ${fixed(tokens / (countTiming.medianMs / 1000) / 1e6, 1)} M tokens/s`,
);

const readTiming = time(() => readTokens(big.bytes));
const readRate = addThroughput(
  "tokenizer, reading every token",
  bigBytes,
  readTiming,
  `${big.segments.toLocaleString("en-US")} segments, ${fixed(big.segments / (readTiming.medianMs / 1000) / 1e3)} k segments/s`,
);

const decodeTiming = time(() => decodeValues(big.bytes));
const decodeRate = addThroughput(
  "tokenizer, turning every tag and value into a string",
  bigBytes,
  decodeTiming,
  "the work the object tree does too, without keeping the strings",
);

const bigMessageTiming = time(() => perMessage(big.bytes, big.messages));
const bigMessageRate = big.messages.length / (bigMessageTiming.medianMs / 1000);
addThroughput(
  `one tokenizer per ${fixed(bigAverage / 1000, 1)} KB order`,
  bigBytes,
  bigMessageTiming,
  `${fixed(bigMessageRate)} orders/s, ${fixed(1e6 / bigMessageRate, 1)} µs per order`,
);

const smallMessageTiming = time(() => perMessage(small.bytes, small.messages));
const smallMessageRate = small.messages.length / (smallMessageTiming.medianMs / 1000);
addThroughput(
  `one tokenizer per ${fixed(smallAverage / 1000, 1)} KB order`,
  smallBytes,
  smallMessageTiming,
  `${fixed(smallMessageRate)} orders/s, ${fixed(1e6 / smallMessageRate, 1)} µs per order`,
);

let treeRate: number | null = null;
if (options.baseline) {
  const treeTiming = time(
    () => parseToObjectTree(big.bytes).length,
    Math.max(3, options.runs >> 2),
    2,
  );
  treeRate = addThroughput(
    "baseline: object tree (what we avoid)",
    bigBytes,
    treeTiming,
    "an object per segment, an array per element, a string per component",
  );
}

const memory = tokenizerMemory(big.bytes);
const retained = options.baseline ? objectTreeRetained(big.bytes) : null;

const lines: string[] = [];
lines.push(
  `Node.js ${process.version} on ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"}`,
  `Input: ${fixed(bigBytes / 1e6, 2)} MB, ${big.messages.length.toLocaleString("en-US")} orders of ${BIG_LINES} lines, ${big.segments.toLocaleString("en-US")} segments, seed ${options.seed}; median of ${options.runs} runs after ${options.warmup} warm-up runs.`,
  "",
  "| Scenario | Input | Throughput (median) | Range (MB/s) | Detail |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.scenario} | ${r.input} | ${r.throughput} | ${r.range} | ${r.detail} |`),
  "",
  "| Memory | Extra heap and buffers | Relative to the input |",
  "| --- | --- | --- |",
  `| tokenizer, while scanning (its batch, sampled) | ${fixed(memory.workingSet / 1024, 1)} KiB | ${fixed(memory.workingSet / bigBytes, 4)}× |`,
  `| tokenizer, after the scan and a collection | ${fixed(memory.retained / 1024, 1)} KiB | ${fixed(memory.retained / bigBytes, 4)}× |`,
  ...(retained === null || treeRate === null
    ? []
    : [
        `| object tree, once built (retained) | ${fixed(retained / 1e6, 1)} MB | ${fixed(retained / bigBytes, 1)}× |`,
        "",
        `Tokenizer vs object tree: ${fixed(readRate / treeRate, 1)}× faster as is, ${fixed(decodeRate / treeRate, 1)}× faster when it also builds every string; ${fixed(retained / Math.max(memory.workingSet, 1))}× less memory.`,
      ]),
  `ADR 10 asks for 500 typical orders per second per core, a budget of 2,000 µs per order for the whole translator; tokenizing one ${fixed(bigAverage / 1000, 1)} KB order takes ${fixed(1e6 / bigMessageRate, 1)} µs (${fixed((1e6 / bigMessageRate / 2000) * 100, 1)} % of it).`,
);

if (options.sweep) {
  lines.push("", "| Batch size | Throughput, reading every token |", "| --- | --- |");
  for (const batchSize of [64, 256, 1024, 4096, 16384, 65536]) {
    const timing = time(() => readTokens(big.bytes, batchSize));
    lines.push(`| ${batchSize} | ${fixed(mbPerSecond(bigBytes, timing.medianMs))} MB/s |`);
  }
}

if (options.json) {
  console.info(
    JSON.stringify({
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: cpus()[0]?.model,
      inputBytes: bigBytes,
      segments: big.segments,
      tokens,
      mbPerSecond: {
        raw: mbPerSecond(bigBytes, rawTiming.medianMs),
        tokenizer: readRate,
        objectTree: treeRate,
      },
      ordersPerSecond: { large: bigMessageRate, small: smallMessageRate },
      memoryBytes: {
        tokenizerWorkingSet: memory.workingSet,
        tokenizerRetained: memory.retained,
        objectTreeRetained: retained,
      },
      sink,
    }),
  );
} else {
  console.info(lines.join("\n"));
}

// --- Options -------------------------------------------------------------------------------

function parseOptions(argv: string[]): {
  sizeMb: number;
  runs: number;
  warmup: number;
  seed: number;
  sweep: boolean;
  json: boolean;
  baseline: boolean;
} {
  const result = {
    sizeMb: 10,
    runs: 15,
    warmup: 8,
    seed: 1,
    sweep: false,
    json: false,
    baseline: true,
  };
  for (const arg of argv) {
    const [name, value] = arg.split("=");
    const number = Number(value);
    switch (name) {
      case "--size-mb":
        result.sizeMb = number;
        break;
      case "--runs":
        result.runs = number;
        break;
      case "--warmup":
        result.warmup = number;
        break;
      case "--seed":
        result.seed = number;
        break;
      case "--sweep":
        result.sweep = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--no-baseline":
        result.baseline = false;
        break;
      case "--":
        break;
      default:
        console.error(
          `Unknown option ${arg}. Known: --size-mb --runs --warmup --seed --sweep --json --no-baseline`,
        );
        process.exit(1);
    }
  }
  for (const [name, value] of Object.entries(result)) {
    if (typeof value === "number" && !(value > 0)) {
      console.error(`${name} must be a positive number`);
      process.exit(1);
    }
  }
  return result;
}
