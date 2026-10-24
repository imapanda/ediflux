import type { GroupNode, MessageNode, Section, Status } from "../types.ts";
import { BOX, type Report } from "./text.ts";

export interface MessageDef {
  type: string;
  version: string;
  release: string;
  agency: string;
  name: string;
  nodes: MessageNode[];
}

// A change indicator may sit between the position and the tag: `0230 X GIS General indicator`.
const MARK = String.raw`(?:[+*#|X-]\s+)?`;
const SEGMENT = new RegExp(
  String.raw`^(\d{4})\s+${MARK}([A-Z]{3})\s+(\S.*?)\s+([MC])\s+(\d+)(.*)$`,
);
const GROUP = new RegExp(
  `^(\\d{4})\\s+${MARK}${BOX.horizontal}+\\s+Segment group (\\d+)\\s+${BOX.horizontal}+\\s+([MC])\\s+(\\d+)`,
);
const SECTION = /^\s+(HEADER|DETAIL|SUMMARY) SECTION\s*$/;
const DRAWING_ONLY = new RegExp(
  `^[\\s${BOX.horizontal}${BOX.topRight}${BOX.bottomRight}${BOX.teeUp}\\u00b3]*$`,
);
const CLOSING = new RegExp(`[${BOX.bottomRight}${BOX.teeUp}]`, "g");

/** The deepest nesting of segment groups in D.96A and D.01B is far below this. */
const MAX_GROUP_DEPTH = 32;

const SEGMENT_NAME_ONLY = new RegExp(String.raw`^(\d{4})\s+${MARK}[A-Z]{3}\s+\S`);
const WRAPPED_REST = /^(?!\d{4}\s)\s*\S.*\s[MC]\s+\d+/;

/**
 * A segment name that does not fit on its line goes on at the start of the next one, which
 * carries the status and the count: the two lines are one.
 */
function joinWrappedNames(lines: string[]): string[] {
  const joined: string[] = [];
  for (const line of lines) {
    const previous = joined[joined.length - 1];
    if (
      previous &&
      SEGMENT_NAME_ONLY.test(previous) &&
      !SEGMENT.test(previous) &&
      WRAPPED_REST.test(line)
    ) {
      joined[joined.length - 1] =
        `${previous.replace(/\u00b3+\s*$/, "").trimEnd()} ${line.trimStart()}`;
    } else {
      joined.push(line);
    }
  }
  return joined;
}

function field(lines: string[], label: string): string {
  const pattern = new RegExp(`^\\s*${label}\\s*:\\s*(\\S+)`);
  for (const line of lines) {
    const found = pattern.exec(line)?.[1];
    if (found) return found;
  }
  return "";
}

/**
 * One file of EDMD (D.01B) or TRMD (D.96A): a message type with its structure. The structure is
 * the segment table, a drawing: a segment group is a line of rules, and the lines under it that
 * end in a vertical bar belong to it. A corner (`┘`, or `┴` where two groups end together) on a
 * line closes one group each. UNH and UNT are in every table and left out.
 */
export function parseMessage(text: string, report: Report): MessageDef | undefined {
  const lines = text.split("\n");
  const type = field(lines, "Message Type");
  if (!/^[A-Z]{6}$/.test(type)) {
    report(`cannot find the message type ("${type}")`);
    return undefined;
  }
  // The file starts with `UN/EDIFACT`, the status of the message, then its title.
  const head = lines
    .slice(0, 40)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = head[0] === "UN/EDIFACT" ? head[2] : undefined;
  const start = lines.findLastIndex((line) => /^4\.3\.1\s+Segment table/.test(line));
  if (start < 0) {
    report(`${type}: cannot find the segment table`);
    return undefined;
  }

  const top: MessageNode[] = [];
  const open: { group: GroupNode; triggered: boolean }[] = [];
  let section: Section | undefined;

  const target = (): MessageNode[] => {
    const group = open[open.length - 1]?.group;
    if (!group) return top;
    group.nodes ??= [];
    return group.nodes;
  };
  const closeGroups = (rest: string): void => {
    for (let count = (rest.match(CLOSING) ?? []).length; count > 0; count -= 1) {
      if (open.pop() === undefined) report(`${type}: a group is closed that was never opened`);
    }
  };

  for (const line of joinWrappedNames(lines.slice(start + 1))) {
    if (/^(?:4\.\d|Annex\b)/.test(line)) break;
    const heading = GROUP.exec(line);
    const segment = SEGMENT.exec(line);
    const named = SECTION.exec(line);
    if (named) {
      section = (named[1] ?? "").toLowerCase() as Section;
    } else if (heading) {
      if (open.length >= MAX_GROUP_DEPTH) {
        report(`${type}: segment groups are nested more than ${MAX_GROUP_DEPTH} deep`);
        return undefined;
      }
      const [, sequence = "", number = "", status = "", count = "1"] = heading;
      const group: GroupNode = {
        kind: "group",
        id: `SG${number}`,
        status: status as Status,
        ...(Number(count) > 1 && { maxOccurs: Number(count) }),
        sequence,
        ...(open.length === 0 && section !== undefined && { section }),
        trigger: { tag: "" },
      };
      target().push(group);
      open.push({ group, triggered: false });
    } else if (segment) {
      const [, sequence = "", tag = "", , status = "", count = "1", rest = ""] = segment;
      const current = open[open.length - 1];
      if (tag !== "UNH" && tag !== "UNT") {
        if (current && !current.triggered) {
          current.triggered = true;
          current.group.trigger = { tag, sequence };
          if (status !== "M" || Number(count) !== 1) {
            report(`${type}: the first segment of ${current.group.id} should be mandatory, once`);
          }
        } else {
          target().push({
            kind: "segment",
            tag,
            status: status as Status,
            ...(Number(count) > 1 && { maxOccurs: Number(count) }),
            sequence,
            ...(open.length === 0 && section !== undefined && { section }),
          });
        }
      }
      closeGroups(rest);
    } else if (
      line.trim() !== "" &&
      !DRAWING_ONLY.test(line) &&
      !/^\s*Pos\s+Tag\s+Name/.test(line)
    ) {
      report(`${type}: cannot read the line "${line.trim()}"`);
    }
  }
  if (open.length > 0) report(`${type}: group ${open[open.length - 1]?.group.id} is never closed`);

  return {
    type,
    version: field(lines, "Version"),
    release: field(lines, "Release"),
    agency: field(lines, "Contr\\. Agency"),
    name: title ?? type,
    nodes: top,
  };
}
