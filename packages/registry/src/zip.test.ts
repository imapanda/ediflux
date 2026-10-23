import { describe, expect, it } from "vitest";
import { makeZip } from "./test-support/make-zip.ts";
import { readZip, ZipError } from "./zip.ts";

/** Where the first entry of the central directory starts, to damage it on purpose. */
const centralOffset = (zip: Buffer): number => zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

const text = (entry: { data: Uint8Array } | undefined): string =>
  Buffer.from(entry?.data ?? []).toString("latin1");

describe("readZip", () => {
  it("reads stored and deflated entries, with their names", () => {
    const zip = makeZip([
      { name: "a.txt", data: "stored text", method: "stored" },
      { name: "dir/b.txt", data: "deflated text ".repeat(50) },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.txt"]);
    expect(text(entries[0])).toBe("stored text");
    expect(text(entries[1])).toBe("deflated text ".repeat(50));
  });

  it("returns the bytes of the file without conversion", () => {
    const bytes = Uint8Array.from([0xc4, 0xbf, 0x00, 0x0d, 0x0a, 0xff]);
    const [entry] = readZip(makeZip([{ name: "bin", data: bytes }]));
    expect([...(entry?.data ?? [])]).toEqual([...bytes]);
  });

  it("reads an archive nested in an archive", () => {
    const inner = makeZip([{ name: "EDED.01B", data: "inner" }]);
    const outer = readZip(makeZip([{ name: "EDED.ZIP", data: inner }]));
    const [nested] = readZip(outer[0]?.data ?? new Uint8Array());
    expect(nested?.name).toBe("EDED.01B");
    expect(text(nested)).toBe("inner");
  });

  it("skips directory entries and reads an empty archive", () => {
    expect(readZip(makeZip([{ name: "dir/", data: "", method: "stored" }]))).toEqual([]);
    expect(readZip(makeZip([]))).toEqual([]);
  });

  it("keeps a name with spaces and capitals as it is", () => {
    const [entry] = readZip(makeZip([{ name: "Dat Report D01B.zip", data: "x" }]));
    expect(entry?.name).toBe("Dat Report D01B.zip");
  });

  it.each([
    ["bytes that are not a ZIP archive", () => Buffer.from("not a zip file at all, just text")],
    [
      "an archive cut in the middle",
      () => makeZip([{ name: "a", data: "x".repeat(500) }]).subarray(0, 60),
    ],
    [
      "a damaged entry (the checksum no longer matches)",
      () => {
        const zip = makeZip([{ name: "a", data: "hello world", method: "stored" }]);
        zip[30 + 1 + 3] = zip[30 + 1 + 3] === 0x78 ? 0x79 : 0x78; // a byte of the stored data
        return zip;
      },
    ],
  ])("refuses %s", (_label, build) => {
    expect(() => readZip(build())).toThrow(ZipError);
  });

  it("refuses an entry whose name could leave the target directory", () => {
    for (const name of [
      "../evil.txt",
      "/etc/passwd",
      "a/../../b",
      "c:\\x",
      "a\0b",
      "a\nb",
      "\x1b[2J",
    ]) {
      expect(() => readZip(makeZip([{ name, data: "x" }])), name).toThrow(/name/);
    }
  });

  it("refuses an encrypted entry and an unsupported compression method", () => {
    const encrypted = makeZip([{ name: "a", data: "x" }]);
    encrypted.writeUInt16LE(0x0801, centralOffset(encrypted) + 8); // flags: encrypted bit
    expect(() => readZip(encrypted)).toThrow(/encrypted/);

    const lzma = makeZip([{ name: "a", data: "x" }]);
    lzma.writeUInt16LE(14, centralOffset(lzma) + 10); // compression method
    expect(() => readZip(lzma)).toThrow(/compression method 14/);
  });

  it("quotes a name in an error message, so that it cannot forge a line of the log", () => {
    const zip = makeZip([{ name: "evil", data: "x" }]);
    const named = Buffer.from(zip.toString("latin1").replaceAll("evil", "e\nil"), "latin1");
    expect(() => readZip(named)).toThrow('unsafe entry name "e\\nil"');
  });

  it("refuses an archive that is split over several disks", () => {
    const zip = makeZip([{ name: "a", data: "x" }]);
    zip.writeUInt16LE(1, zip.length - 22 + 4); // number of this disk
    expect(() => readZip(zip)).toThrow(/multi-disk/);
  });

  it("refuses a central directory entry whose name runs past the end", () => {
    const zip = makeZip([{ name: "a", data: "x" }]);
    zip.writeUInt16LE(60_000, centralOffset(zip) + 28); // name length
    expect(() => readZip(zip)).toThrow(/damaged central directory/);
  });

  describe("limits", () => {
    it("refuses an archive with too many entries", () => {
      const zip = makeZip([1, 2, 3].map((n) => ({ name: `f${n}`, data: "x" })));
      expect(() => readZip(zip, { maxEntries: 2 })).toThrow(/more than 2 entries/);
    });

    it("refuses an entry larger than the limit, from its declared size", () => {
      const zip = makeZip([{ name: "big", data: "x".repeat(2000) }]);
      expect(() => readZip(zip, { maxEntryBytes: 1000 })).toThrow(/larger than 1000/);
    });

    it("refuses an archive whose entries add up to more than the limit", () => {
      const zip = makeZip([
        { name: "a", data: "x".repeat(600) },
        { name: "b", data: "y".repeat(600) },
      ]);
      expect(() => readZip(zip, { maxTotalBytes: 1000 })).toThrow(/more than 1000 bytes/);
    });

    it("does not trust a declared size smaller than what the data inflates to", () => {
      const zip = makeZip([{ name: "bomb", data: Buffer.alloc(100_000) }]);
      zip.writeUInt32LE(10, centralOffset(zip) + 24); // declared size of the content
      expect(() => readZip(zip)).toThrow(ZipError);
    });
  });
});
