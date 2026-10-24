import { crc32, inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  override name = "ZipError";
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipLimits {
  maxEntries?: number;
  /** Largest uncompressed size of one entry, in bytes. */
  maxEntryBytes?: number;
  /** Largest uncompressed size of all entries together, in bytes. */
  maxTotalBytes?: number;
}

const DEFAULT_LIMITS: Required<ZipLimits> = {
  maxEntries: 5_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/**
 * Reads a ZIP archive held in memory: the minimal reader that the UNECE directory archives need
 * (stored and deflated entries, sizes taken from the central directory). Nothing is written to
 * disk, so an entry name cannot place a file anywhere, but a name that could (absolute path,
 * `..`, drive letter, NUL) is still refused. The declared sizes are checked against the limits
 * before inflating, and used as the ceiling while inflating, so that an archive cannot expand
 * beyond what it announced. Every entry is checked against its CRC-32. ZIP64, encryption and
 * multi-disk archives are refused.
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  if (
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    buffer.readUInt16LE(end + 8) !== count
  ) {
    throw new ZipError("multi-disk archives are not supported");
  }
  const directorySize = buffer.readUInt32LE(end + 12);
  let position = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || position === 0xffffffff) {
    throw new ZipError("ZIP64 archives are not supported");
  }
  if (count > maxEntries) throw new ZipError(`archive has more than ${maxEntries} entries`);

  const entries: ZipEntry[] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_ENTRY) {
      throw new ZipError("damaged central directory");
    }
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.length) throw new ZipError("damaged central directory");
    const name = buffer
      .subarray(position + 46, position + 46 + nameLength)
      .toString(flags & 0x0800 ? "utf8" : "latin1");
    position = next;

    if (name.endsWith("/")) continue;
    assertSafeName(name);
    // The name is quoted wherever it is shown: it comes from the file.
    const label = `entry ${JSON.stringify(name)}`;
    if (flags & 0x0001) throw new ZipError(`${label} is encrypted`);
    if (size > maxEntryBytes) {
      throw new ZipError(`${label} is larger than ${maxEntryBytes} bytes`);
    }
    total += size;
    if (total > maxTotalBytes) {
      throw new ZipError(`entries add up to more than ${maxTotalBytes} bytes`);
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new ZipError(`${label} has no local header`);
    }
    const start =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) throw new ZipError(`${label} is cut short`);
    const body = buffer.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = body;
    } else if (method === 8) {
      try {
        data = inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
      } catch (error) {
        throw new ZipError(`${label} cannot be inflated: ${(error as Error).message}`);
      }
    } else {
      throw new ZipError(`${label} uses compression method ${method}`);
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new ZipError(`${label} does not match its size and checksum`);
    }
    entries.push({ name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes long, followed by a comment of at most 65535 bytes.
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipError("not a ZIP archive");
}

function assertSafeName(name: string): void {
  const unsafe =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..");
  if (unsafe) throw new ZipError(`unsafe entry name ${JSON.stringify(name)}`);
}
