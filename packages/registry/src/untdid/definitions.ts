import type { Status } from "../types.ts";
import {
  isLabel,
  paragraph,
  parseRepresentation,
  type Report,
  type Representation,
  splitEntries,
} from "./text.ts";

export interface ElementDef extends Representation {
  tag: string;
  name: string;
  description: string;
}

export interface CompositeDef {
  tag: string;
  name: string;
  description: string;
  components: { ref: string; status: Status }[];
}

export interface SegmentDef {
  tag: string;
  name: string;
  description: string;
  elements: { ref: string; status: Status; maxOccurs: number }[];
}

export interface CodeListDef {
  tag: string;
  name: string;
  codes: { value: string; name: string; description: string }[];
}

const NAME_TAIL = String.raw`\s+([MC])`;
// A change indicator can also follow the position: `010 X  C529 PROCESSING INDICATOR`.
const MARK = String.raw`(?:[+*#|X-]\s+)?`;
const REPRESENTATION_TAIL = String.raw`(?:a|an|n)(?:\.\.)?\d+`;

/**
 * The entries of a file, with their header matched. An entry that does not start with a header is
 * reported, except the title block at the top of the file.
 */
function* entries(
  text: string,
  header: RegExp,
  report: Report,
): Generator<{ match: RegExpExecArray; body: string[] }> {
  for (const [index, lines] of splitEntries(text).entries()) {
    // A change indicator can also sit just before the tag: `    X  C110 PAYMENT TERMS`.
    const first = (lines[0] ?? "").replace(
      /^( *)([+*#|X-]{1,2})(?= )/,
      (_, indent, mark) => indent + " ".repeat(mark.length),
    );
    const match = header.exec(first);
    if (match) yield { match, body: lines.slice(1) };
    else if (index > 0 && lines.length > 0)
      report(`unexpected entry starting with "${first.trim()}"`);
  }
}

/**
 * Lines that start an item (a numbered position), joined with the lines that continue it. A name
 * that does not fit goes on at a deeper indent, without a digit at its start, until the line that
 * ends with the status. Text that follows a complete item explains it and is left out.
 */
function items(lines: string[], start: RegExp, complete: RegExp): string[] {
  const found: string[] = [];
  let open = false;
  for (const line of lines) {
    if (start.test(line)) {
      found.push(line.trim());
      open = !complete.test(line);
    } else if (open && /^ {10,}[^\s\d]/.test(line) && !isLabel(line)) {
      found[found.length - 1] += ` ${line.trim()}`;
      open = !complete.test(line);
    }
  }
  return found.map((item) => item.replace(/\s+/g, " "));
}

/** EDED (D.01B) and TRED (D.96A): one entry per data element, with its representation. */
export function parseElements(text: string, report: Report): ElementDef[] {
  const header = /^ {1,6}(\d{4}) {2}(\S.*?)(?: +\[[BIC]\])?\s*$/;
  const result: ElementDef[] = [];
  for (const { match, body } of entries(text, header, report)) {
    const [, tag = "", name = ""] = match;
    const repr = body.map((line) => /^\s*Repr:\s*(\S+)/.exec(line)?.[1]).find(Boolean) ?? "";
    const representation = parseRepresentation(repr);
    if (!representation) {
      report(`data element ${tag}: cannot read the representation "${repr}"`);
      continue;
    }
    result.push({ tag, name, description: paragraph(body, "Desc"), ...representation });
  }
  return result;
}

/** EDCD (D.01B) and TRCD (D.96A): one entry per composite, with its components in order. */
export function parseComposites(text: string, report: Report): CompositeDef[] {
  const header = /^ {1,9}([CS]\d{3}) +(\S.*?)\s*$/;
  const component = new RegExp(
    String.raw`^(\d{3})\s+${MARK}(\d{4})\s+(.*?)${NAME_TAIL}\s+${REPRESENTATION_TAIL}$`,
  );
  const result: CompositeDef[] = [];
  for (const { match, body } of entries(text, header, report)) {
    const [, tag = "", name = ""] = match;
    const components: CompositeDef["components"] = [];
    for (const item of items(
      body,
      new RegExp(String.raw`^\d{3}\s+${MARK}\d{4}\s`),
      new RegExp(`\\s[MC]\\s+${REPRESENTATION_TAIL}\\s*$`),
    )) {
      const parts = component.exec(item);
      if (parts) components.push({ ref: parts[2] ?? "", status: parts[4] as Status });
      else report(`composite ${tag}: cannot read the component "${item}"`);
    }
    result.push({ tag, name, description: paragraph(body, "Desc"), components });
  }
  return result;
}

/**
 * EDSD (D.01B) and TRSD (D.96A): one entry per segment. Its elements are the numbered lines. The
 * unnumbered lines under a composite repeat its components, which EDCD already gives. D.01B adds
 * how many times an element may repeat; D.96A does not say, which means once.
 */
export function parseSegments(text: string, report: Report): SegmentDef[] {
  const header = /^ {1,9}([A-Z]{3}) +(\S.*?)\s*$/;
  const element = new RegExp(
    String.raw`^(\d{3})\s+${MARK}([CS]\d{3}|\d{4})\s+(.*?)${NAME_TAIL}(?:\s+(\d+))?(?:\s+${REPRESENTATION_TAIL})?$`,
  );
  const result: SegmentDef[] = [];
  for (const { match, body } of entries(text, header, report)) {
    const [, tag = "", name = ""] = match;
    const elements: SegmentDef["elements"] = [];
    for (const item of items(
      body,
      new RegExp(String.raw`^\d{3}\s+${MARK}([CS]\d{3}|\d{4})\s`),
      new RegExp(`\\s[MC](?:\\s+\\d+)?(?:\\s+${REPRESENTATION_TAIL})?\\s*$`),
    )) {
      const parts = element.exec(item);
      if (parts) {
        elements.push({
          ref: parts[2] ?? "",
          status: parts[4] as Status,
          maxOccurs: Number(parts[5] ?? 1),
        });
      } else {
        report(`segment ${tag}: cannot read the element "${item}"`);
      }
    }
    result.push({ tag, name, description: paragraph(body, "Function"), elements });
  }
  return result;
}

/**
 * UNCL: one entry per code list, named by the tag of its data element. After the `Repr:` line come
 * the codes. A code starts left of `nameColumn` and its name begins at that column; the lines
 * that follow, at that column, go on with the name, and the deeper ones describe the code.
 */
export function parseCodeLists(text: string, nameColumn: number, report: Report): CodeListDef[] {
  const header = /^ {1,6}(\d{4}) {2}(\S.*?)(?: +\[[BIC]\])?\s*$/;
  const result: CodeListDef[] = [];
  for (const { match, body } of entries(text, header, report)) {
    const [, tag = "", name = ""] = match;
    const codes: CodeListDef["codes"] = [];
    let listed = false;
    let inNote = false;
    for (const line of body) {
      if (/^\s*Repr:/.test(line)) listed = true;
      if (!listed) continue;
      if (line.trim() === "") {
        inNote = false;
        continue;
      }
      if (isLabel(line)) {
        inNote = /^\s*Note:/.test(line);
        continue;
      }
      const indent = line.length - line.trimStart().length;
      const last = codes[codes.length - 1];
      if (indent < nameColumn - 1) {
        const parts = /^ *(\S+) +(\S.*)$/.exec(line);
        if (parts)
          codes.push({ value: parts[1] ?? "", name: (parts[2] ?? "").trim(), description: "" });
        else report(`code list ${tag}: cannot read the line "${line.trim()}"`);
        inNote = false;
      } else if (last && !inNote) {
        const words = line.trim();
        if (indent === nameColumn) last.name = `${last.name} ${words}`;
        else last.description = last.description ? `${last.description} ${words}` : words;
      }
    }
    result.push({ tag, name, codes });
  }
  return result;
}
