import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryPin } from "./directories.ts";
import type { FetchLike } from "./download.ts";
import { DownloadError, downloadDirectory, obtainDirectory, sha256Hex } from "./download.ts";

const BYTES = Buffer.from("pretend this is a directory archive");
const SHA = createHash("sha256").update(BYTES).digest("hex");

const pin: DirectoryPin = {
  id: "D00X",
  version: "D",
  release: "00X",
  syntaxVersions: [3],
  fileName: "d00x.zip",
  url: "https://directory.example/d00x.zip",
  sha256: SHA,
  parts: { elements: "E", composites: "C", segments: "S", messages: "M", codes: "U" },
  codeNameColumn: 10,
};

const ok = (body: Uint8Array = BYTES, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers });
const status = (code: number): Response => new Response("no", { status: code });

const noWait = async (): Promise<void> => {};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "libredi-registry-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sha256Hex", () => {
  it("gives the lower-case hexadecimal SHA-256", () => {
    expect(sha256Hex(BYTES)).toBe(SHA);
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("downloadDirectory", () => {
  it("returns the bytes when the checksum matches, asking for the pinned URL", async () => {
    const fetch = vi.fn<FetchLike>(async () => ok());
    const bytes = await downloadDirectory(pin, { fetch, sleep: noWait });
    expect(Buffer.from(bytes).equals(BYTES)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(pin.url);
  });

  it("retries a server error and a network error, waiting longer each time", async () => {
    const answers = [status(503), new TypeError("fetch failed"), status(429), ok()];
    const fetch = vi.fn(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? ok();
    });
    const waits: number[] = [];
    const bytes = await downloadDirectory(pin, {
      fetch,
      attempts: 4,
      backoffMs: 10,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(bytes.length).toBe(BYTES.length);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([10, 20, 40]);
  });

  it("gives up after the last attempt and says why", async () => {
    const fetch = vi.fn(async () => status(502));
    await expect(downloadDirectory(pin, { fetch, attempts: 3, sleep: noWait })).rejects.toThrow(
      /after 3 attempts.*HTTP 502/s,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refusal, and points to the offline mode", async () => {
    const fetch = vi.fn(async () => status(403));
    const failure = downloadDirectory(pin, { fetch, sleep: noWait });
    await expect(failure).rejects.toThrow(DownloadError);
    await expect(failure).rejects.toThrow(/HTTP 403.*offline/s);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a file whose checksum differs and reports both checksums", async () => {
    const fetch = vi.fn(async () => ok(Buffer.from("something else")));
    const failure = downloadDirectory(pin, { fetch, sleep: noWait });
    await expect(failure).rejects.toThrow(DownloadError);
    await expect(failure).rejects.toThrow(
      new RegExp(`${SHA}.*${sha256Hex(Buffer.from("something else"))}`, "s"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts another checksum when the caller gives one", async () => {
    const other = Buffer.from("updated by the publisher");
    const fetch = vi.fn(async () => ok(other));
    const bytes = await downloadDirectory(pin, { fetch, expectedSha256: sha256Hex(other) });
    expect(Buffer.from(bytes).equals(other)).toBe(true);
  });

  it("refuses a file that announces a size above the limit, without reading it", async () => {
    const fetch = vi.fn(async () => ok(BYTES, { "content-length": "999999999" }));
    await expect(downloadDirectory(pin, { fetch, maxBytes: 1000 })).rejects.toThrow(
      /larger than 1000/,
    );
  });

  it("stops reading a body that grows beyond the limit", async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(400));
      },
    });
    const fetch = vi.fn(async () => new Response(endless, { status: 200 }));
    await expect(downloadDirectory(pin, { fetch, maxBytes: 1000 })).rejects.toThrow(
      /larger than 1000/,
    );
  });
});

describe("downloadDirectory and redirects", () => {
  it("refuses a download that ended on a page that is not HTTPS", async () => {
    const response = ok();
    Object.defineProperty(response, "url", { value: "http://elsewhere.example/d00x.zip" });
    const fetch = vi.fn<FetchLike>(async () => response);
    await expect(downloadDirectory(pin, { fetch })).rejects.toThrow(/redirected to .*not HTTPS/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts a download that ended on another HTTPS page", async () => {
    const response = ok();
    Object.defineProperty(response, "url", { value: "https://cdn.example/d00x.zip" });
    await expect(downloadDirectory(pin, { fetch: async () => response })).resolves.toBeDefined();
  });
});

describe("obtainDirectory on files it should not trust", () => {
  it("refuses a supplied file that is not a regular file", async () => {
    await symlink("/dev/null", join(dir, "d00x.zip"));
    await expect(obtainDirectory(pin, { offlineDir: dir })).rejects.toThrow(/not a regular file/);
  });

  it("refuses a supplied file above the size limit, without reading it", async () => {
    await writeFile(join(dir, "d00x.zip"), BYTES);
    await expect(obtainDirectory(pin, { offlineDir: dir, maxBytes: 10 })).rejects.toThrow(
      /larger than 10 bytes/,
    );
  });

  it("does not follow a link that is waiting at the place of the cache file", async () => {
    const cacheDir = join(dir, "cache");
    await mkdir(cacheDir);
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "do not touch");
    await symlink(victim, join(cacheDir, "d00x.zip"));
    const result = await obtainDirectory(pin, { cacheDir, fetch: async () => ok(), sleep: noWait });
    expect(result.source).toBe("download");
    expect(await readFile(victim, "utf8")).toBe("do not touch");
    expect(await readFile(join(cacheDir, "d00x.zip"))).toEqual(BYTES);
    expect(await readdir(cacheDir)).toEqual(["d00x.zip"]);
  });

  it("refuses a pin whose file name is a path", async () => {
    await expect(
      obtainDirectory(
        { ...pin, fileName: "../escaped.zip" },
        { cacheDir: dir, fetch: async () => ok() },
      ),
    ).rejects.toThrow(/not a plain file name/);
  });
});

describe("obtainDirectory", () => {
  it("offline mode reads the file the operator supplied, whatever the case of its name", async () => {
    await writeFile(join(dir, "D00X.ZIP"), BYTES);
    const fetch = vi.fn(async () => ok());
    const result = await obtainDirectory(pin, { offlineDir: dir, fetch });
    expect(result.source).toBe("offline");
    expect(Buffer.from(result.bytes).equals(BYTES)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offline mode never falls back to the network, and says where to get the file", async () => {
    const fetch = vi.fn(async () => ok());
    await expect(obtainDirectory(pin, { offlineDir: dir, fetch })).rejects.toThrow(
      new RegExp(`d00x.zip.*${pin.url.replaceAll(".", "\\.")}`, "s"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offline mode refuses a supplied file with the wrong checksum", async () => {
    await writeFile(join(dir, "d00x.zip"), "tampered");
    await expect(obtainDirectory(pin, { offlineDir: dir })).rejects.toThrow(/checksum/);
  });

  it("downloads once, caches the file, then serves it from the cache", async () => {
    const cacheDir = join(dir, "cache");
    const fetch = vi.fn(async () => ok());
    const first = await obtainDirectory(pin, { cacheDir, fetch, sleep: noWait });
    expect(first.source).toBe("download");
    expect(await readFile(join(cacheDir, "d00x.zip"))).toEqual(BYTES);
    expect(await readdir(cacheDir)).toEqual(["d00x.zip"]); // no temporary file left behind

    const second = await obtainDirectory(pin, { cacheDir, fetch, sleep: noWait });
    expect(second.source).toBe("cache");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("downloads again when the cached file no longer matches", async () => {
    const cacheDir = join(dir, "cache");
    await mkdir(cacheDir);
    await writeFile(join(cacheDir, "d00x.zip"), "corrupted");
    const fetch = vi.fn(async () => ok());
    const result = await obtainDirectory(pin, { cacheDir, fetch, sleep: noWait });
    expect(result.source).toBe("download");
    expect(await readFile(join(cacheDir, "d00x.zip"))).toEqual(BYTES);
  });

  it("does not cache a file that fails its checksum", async () => {
    const cacheDir = join(dir, "cache");
    const fetch = vi.fn(async () => ok(Buffer.from("something else")));
    await expect(obtainDirectory(pin, { cacheDir, fetch })).rejects.toThrow(/checksum/);
    await expect(readdir(cacheDir)).rejects.toThrow(); // nothing was created
  });

  it("downloads without caching when no cache directory is given", async () => {
    const result = await obtainDirectory(pin, { fetch: async () => ok(), sleep: noWait });
    expect(result.source).toBe("download");
  });
});
