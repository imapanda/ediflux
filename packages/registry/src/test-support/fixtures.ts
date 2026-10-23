import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DirectoryPin } from "../directories.ts";
import { sha256Hex } from "../download.ts";
import { makeZip, type ZipFile } from "./make-zip.ts";

/**
 * Fictitious directories for tests. The files in `fixtures/` are plain UTF-8 text that imitate the
 * layout of the UNTDID files with invented tags and invented texts; nothing in them comes from
 * the UN/EDIFACT directories. `archive()` packs them the way UNECE does: an archive of archives,
 * in the DOS code page that the real files use.
 */
export type Layout = "d01b" | "d96a";

const BOX_TO_CODE_PAGE: Record<string, string> = {
  "─": "Ä",
  "┐": "¿",
  "│": "³",
  "┴": "Á",
  "┘": "Ù",
};

/** The text of a fixture as a parser receives it: box characters as the bytes of the real files. */
export function fixtureText(layout: Layout, file: string): string {
  return readFixture(layout, file);
}

function readFixture(layout: Layout, file: string): string {
  const path = fileURLToPath(new URL(`./fixtures/${layout}-layout/${file}`, import.meta.url));
  return readFileSync(path, "utf8").replace(/[─┐│┴┘]/g, (char) => BOX_TO_CODE_PAGE[char] ?? char);
}

const asFile = (name: string, text: string): ZipFile => ({
  name,
  data: Buffer.from(text.replaceAll("\n", "\r\n"), "latin1"),
});

const PARTS = {
  d01b: { elements: "EDED", composites: "EDCD", segments: "EDSD", messages: "EDMD", codes: "UNCL" },
  d96a: { elements: "TRED", composites: "TRCD", segments: "TRSD", messages: "TRMD", codes: "UNCL" },
} as const;

/**
 * The archive of a fictitious directory, with files that must be ignored next to the real ones.
 * `overrides` replaces the text of a fixture file, to build a directory that is broken on purpose.
 */
export function fixtureArchive(layout: Layout, overrides: Record<string, string> = {}): Buffer {
  const fixtureText = (kind: Layout, file: string): string =>
    overrides[file] ?? readFixture(kind, file);
  const release = layout === "d01b" ? "01B" : "96A";
  const parts = PARTS[layout];
  const inner = (name: string, files: ZipFile[]): ZipFile => ({
    name: `${name}.ZIP`,
    data: makeZip(files),
  });
  const codes =
    layout === "d01b"
      ? [asFile(`UNCL.${release}`, fixtureText(layout, "codes.txt"))]
      : [
          asFile(`UNCL-1.${release}`, fixtureText(layout, "codes-1.txt")),
          asFile(`UNCL-2.${release}`, fixtureText(layout, "codes-2.txt")),
        ];
  const messages = [
    asFile(`SAMPLE_D.${release}`, fixtureText(layout, "message-sample.txt")),
    asFile(`EDMDI1.${release}`, "A list for interactive messages: not a message.\n"),
    ...(layout === "d01b"
      ? [asFile(`ODDITY_D.${release}`, fixtureText(layout, "message-oddity.txt"))]
      : []),
  ];
  return makeZip([
    inner(parts.elements, [
      asFile(`${parts.elements}.${release}`, fixtureText(layout, "elements.txt")),
    ]),
    inner(parts.composites, [
      asFile(`${parts.composites}.${release}`, fixtureText(layout, "composites.txt")),
    ]),
    inner(parts.segments, [
      asFile(`${parts.segments}.${release}`, fixtureText(layout, "segments.txt")),
    ]),
    inner(parts.messages, messages),
    inner(parts.codes, codes),
    { name: "CONTENT.TXT", data: "A file of the archive that is not used.\n" },
  ]);
}

/** The pin of a fictitious directory, with the checksum of its archive. */
export function fixturePin(layout: Layout): DirectoryPin {
  const release = layout === "d01b" ? "01B" : "96A";
  return {
    id: `Z${release}`,
    version: "Z",
    release,
    syntaxVersions: layout === "d01b" ? [3, 4] : [3],
    fileName: `z${release.toLowerCase()}.zip`,
    url: `https://directory.example/z${release.toLowerCase()}.zip`,
    sha256: sha256Hex(fixtureArchive(layout)),
    parts: { ...PARTS[layout] },
    codeNameColumn: layout === "d01b" ? 11 : 10,
  };
}
