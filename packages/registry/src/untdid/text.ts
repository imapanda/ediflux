/**
 * Helpers shared by the parsers of the UNTDID files. The files are text in the DOS code page 437
 * with CR LF line ends: read as Latin-1, the box-drawing characters that separate entries and
 * draw the message tables have the code points below. The text itself is plain ASCII.
 */
export const BOX = {
  horizontal: "Ä",
  topRight: "¿",
  bottomRight: "Ù",
  teeUp: "Á",
} as const;

/** Where a parser reports a line it could not make sense of. */
export type Report = (message: string) => void;

/**
 * Longest line the parsers look at. The longest line of D.96A and D.01B has 71 characters; a longer
 * line is cut, so that no pattern can be made to run for long on a line that is not from a directory.
 */
const MAX_LINE = 200;

export function decodeDirectoryText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line))
    .join("\n");
}

const SEPARATOR = new RegExp(`^${BOX.horizontal}{10,}${BOX.topRight}?\\s*$`);

/**
 * Cuts a directory file into entries at the lines drawn with box characters. The first entry is
 * what comes before the first separator (a title and the legend of the change indicators).
 */
export function splitEntries(text: string): string[][] {
  const entries: string[][] = [[]];
  for (const line of text.split("\n")) {
    if (SEPARATOR.test(line)) entries.push([]);
    else entries[entries.length - 1]?.push(stripIndicator(line));
  }
  return entries.map(trimBlankLines);
}

/**
 * A change indicator (`+ * # | - X`) sits in the first column, where the entry has a space.
 * It tells how the entry changed since the previous version, which does not matter here.
 */
function stripIndicator(line: string): string {
  return /^[+*#|X-]/.test(line) ? ` ${line.slice(1)}` : line;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

const LABEL = /^\s*(Desc|Repr|Note|Function):\s?(.*)$/;

export function isLabel(line: string): boolean {
  return LABEL.test(line);
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The text of a labelled paragraph (`Desc:`, `Function:`), which runs on the following lines
 * while they are indented deeper than the label: in some files no blank line separates it from
 * what comes next. Spaces are collapsed. Empty when there is no such label.
 */
export function paragraph(lines: string[], label: string): string {
  const start = lines.findIndex((line) => LABEL.exec(line)?.[1] === label);
  if (start < 0) return "";
  const words = [LABEL.exec(lines[start] ?? "")?.[2] ?? ""];
  const labelIndent = indentOf(lines[start] ?? "");
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || isLabel(line) || indentOf(line) <= labelIndent) break;
    words.push(line);
  }
  return words.join(" ").replace(/\s+/g, " ").trim();
}

export interface Representation {
  type: "a" | "an" | "n";
  minLength: number;
  maxLength: number;
}

/**
 * `an..35` is one to 35 alphanumeric characters, `n3` exactly three digits.
 */
export function parseRepresentation(text: string): Representation | undefined {
  const match = /^(an|a|n)(\.\.)?(\d+)$/i.exec(text.trim());
  if (!match) return undefined;
  const maxLength = Number(match[3]);
  return {
    type: (match[1] ?? "an").toLowerCase() as Representation["type"],
    minLength: match[2] ? 1 : maxLength,
    maxLength,
  };
}
