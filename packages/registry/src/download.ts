import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DirectoryPin } from "./directories.ts";

/** A failure that trying again cannot fix: a refusal, a wrong checksum, a file that is too large. */
export class DownloadError extends Error {
  override name = "DownloadError";
}

/** The part of `fetch` that is used, so that a test can replace it. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface DownloadOptions {
  fetch?: FetchLike;
  /** Number of tries before giving up. Defaults to 3. */
  attempts?: number;
  /** Wait before the second try, doubled each time. Defaults to 1000. */
  backoffMs?: number;
  /** Time allowed for one try, in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
  /** Largest file accepted, in bytes, downloaded or read. Defaults to 64 MiB. */
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the checksum pinned in the directory table. */
  expectedSha256?: string;
}

export interface ObtainOptions extends DownloadOptions {
  /** Folder with the archives supplied by the operator. When set, nothing is downloaded. */
  offlineDir?: string;
  /** Folder where a downloaded archive is kept, so that the next run needs no network. */
  cacheDir?: string;
}

export interface ObtainedDirectory {
  bytes: Uint8Array;
  source: "offline" | "cache" | "download";
}

const USER_AGENT = "libredi-registry (+https://github.com/imapanda/libredi)";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkSha256(bytes: Uint8Array, expected: string, what: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new DownloadError(
      `Wrong checksum for ${what}: expected SHA-256 ${expected}, got ${actual}. ` +
        "If UNECE replaced the file, check the change and update the pinned checksum.",
    );
  }
}

/** Downloads the archive of a directory and checks its SHA-256 before anyone reads it. */
export async function downloadDirectory(
  pin: DirectoryPin,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetch ?? fetch;
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 1000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      const bytes = await fetchOnce(pin, fetchImpl, options);
      checkSha256(bytes, options.expectedSha256 ?? pin.sha256, pin.url);
      return bytes;
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      if (attempt >= attempts) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new DownloadError(
          `Could not download ${pin.url} after ${attempts} attempts: ${reason}`,
        );
      }
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
}

async function fetchOnce(
  pin: DirectoryPin,
  fetchImpl: FetchLike,
  options: DownloadOptions,
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const response = await fetchImpl(pin.url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    headers: { "user-agent": USER_AGENT },
  });
  // fetch follows redirects, to any host. The checksum protects the content; this keeps the
  // transfer itself on HTTPS (a response built by hand has no address).
  if (response.url !== "" && !response.url.startsWith("https://")) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadError(
      `${pin.url} was redirected to ${JSON.stringify(response.url)}, which is not HTTPS`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // A server error or a throttling answer may pass; anything else will not.
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`HTTP ${response.status}`);
    }
    throw new DownloadError(
      `${pin.url} answered HTTP ${response.status}. UNECE refuses some data-centre addresses: ` +
        `download ${pin.fileName} on another machine and use the offline mode.`,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadError(`${pin.url} is larger than ${maxBytes} bytes`);
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DownloadError(`${pin.url} is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a regular file of at most `maxBytes`. It is opened without blocking and measured before
 * it is read, so that a link to a device or a named pipe is refused instead of read for ever.
 */
async function readRegularFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DownloadError(`${path} is not a regular file`);
    if (info.size > maxBytes) throw new DownloadError(`${path} is larger than ${maxBytes} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Reads the archive that the operator put in a folder, and checks its SHA-256. */
export async function readSuppliedDirectory(
  dir: string,
  pin: DirectoryPin,
  options: { expectedSha256?: string; maxBytes?: number } = {},
): Promise<Uint8Array> {
  const expected = options.expectedSha256 ?? pin.sha256;
  const wanted = pin.fileName.toLowerCase();
  const found = (await readdir(dir)).find((name) => name.toLowerCase() === wanted);
  if (!found) {
    throw new DownloadError(
      `There is no file named ${pin.fileName} in ${dir}. Download ${pin.url} on a machine that ` +
        `can reach UNECE and put it there; its SHA-256 must be ${expected}.`,
    );
  }
  const bytes = await readRegularFile(join(dir, found), options.maxBytes ?? DEFAULT_MAX_BYTES);
  checkSha256(bytes, expected, join(dir, found));
  return bytes;
}

/**
 * Gets the archive of a directory: from the folder of the operator in offline mode (and never
 * from the network), else from the cache, else from UNECE, in which case it is cached.
 */
export async function obtainDirectory(
  pin: DirectoryPin,
  options: ObtainOptions = {},
): Promise<ObtainedDirectory> {
  if (pin.fileName !== basename(pin.fileName)) {
    throw new DownloadError(`${JSON.stringify(pin.fileName)} is not a plain file name`);
  }
  const expected = options.expectedSha256 ?? pin.sha256;
  if (options.offlineDir !== undefined) {
    const bytes = await readSuppliedDirectory(options.offlineDir, pin, {
      expectedSha256: expected,
      ...(options.maxBytes !== undefined && { maxBytes: options.maxBytes }),
    });
    return { bytes, source: "offline" };
  }

  const cached = options.cacheDir === undefined ? undefined : join(options.cacheDir, pin.fileName);
  if (cached !== undefined) {
    const bytes = await readRegularFile(cached, options.maxBytes ?? DEFAULT_MAX_BYTES).catch(
      () => undefined,
    );
    if (bytes !== undefined && sha256Hex(bytes) === expected.toLowerCase()) {
      return { bytes, source: "cache" };
    }
  }

  const bytes = await downloadDirectory(pin, options);
  if (cached !== undefined && options.cacheDir !== undefined) {
    await mkdir(options.cacheDir, { recursive: true });
    // A name nobody can guess, created only if new: a link left in the folder cannot redirect it.
    const temporary = `${cached}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
      await rename(temporary, cached);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return { bytes, source: "download" };
}
