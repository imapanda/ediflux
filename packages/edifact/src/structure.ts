import type { IssueSink } from "./envelope.ts";
import type { LineColumn } from "./line-index.ts";
import type { MessageDef, NodeDef } from "./registry.ts";

/*
 * Structure validation: the segments of a message against the message structure of the registry,
 * which says in what order the segments and groups come, which are mandatory and how often each
 * may occur. Counts are per occurrence of the parent: a node of a group is counted within one
 * occurrence of the group.
 *
 * The structures of the directories are written so that the next segment alone tells where it
 * belongs, and the checker relies on it: it reads the segments one at a time, with a stack of the
 * groups that are open, and never looks ahead. For each segment it asks, in this order:
 *
 *   1. Is it one of the nodes still ahead in the group I am in (the node I am at, which may
 *      repeat, or a later one)? Then the nodes skipped on the way that were mandatory are missing;
 *      a node that is full is too often repeated; a group opens a frame of its own.
 *   2. Is it ahead in a group that contains this one? Then this group is over: what it still
 *      needed is missing, and the question is asked again one level up.
 *   3. Neither: the segment is out of order if the message has it somewhere, unknown otherwise,
 *      and is left out of the count, so that one stray segment is one issue.
 *
 * One cause gives one issue: a segment in the wrong place can make the ones after it look
 * missing, and the matching resumes at the next segment that fits.
 */

interface Frame {
  readonly nodes: readonly NodeDef[];
  /** The node the next segment is expected at, or later. */
  at: number;
  readonly counts: number[];
}

const MAX_LISTED = 6;

export class StructureChecker {
  readonly #sink: IssueSink;
  readonly #message: MessageDef;
  readonly #locate: (offset: number) => LineColumn;
  readonly #stack: Frame[];

  constructor(message: MessageDef, sink: IssueSink, locate: (offset: number) => LineColumn) {
    this.#message = message;
    this.#sink = sink;
    this.#locate = locate;
    this.#stack = [frame(message.nodes)];
  }

  /** The next segment of the message, UNH and UNT left out. */
  feed(tag: string, number: number, offset: number): void {
    for (;;) {
      const top = this.#stack[this.#stack.length - 1] as Frame;
      const found = this.#ahead(top, tag);
      if (found >= 0) {
        this.#skipTo(top, found, tag, number, offset);
        const node = top.nodes[found] as NodeDef;
        top.at = found;
        const seen = (top.counts[found] as number) + 1;
        top.counts[found] = seen;
        if (seen === node.max + 1) {
          this.#tooMany(node, seen, number, offset);
        }
        if (node.kind === "group") {
          this.#stack.push(frame(node.nodes));
        }
        return;
      }
      const level = this.#level(tag);
      if (level >= 0) {
        this.#close(level, tag, number, offset);
        continue;
      }
      this.#stray(tag, number, offset);
      return;
    }
  }

  /** The message ends, at `tag` (UNT, or the segment that cut the message short). */
  end(tag: string | null, number: number, offset: number): void {
    this.#close(-1, tag, number, offset);
  }

  // --- Where a segment goes ---------------------------------------------------------------

  /**
   * Index of the node from the one the frame is at that a segment of `tag` fits, or -1: the first
   * with room left, or, if they are all full, the first (which then has one too many). A segment
   * can stand at several places of a structure, as UNS does on each side of a group.
   */
  #ahead(frame: Frame, tag: string): number {
    const nodes = frame.nodes;
    let full = -1;
    for (let i = frame.at; i < nodes.length; i++) {
      const node = nodes[i] as NodeDef;
      if (node.tag === tag) {
        if ((frame.counts[i] as number) < node.max) {
          return i;
        }
        if (full < 0) {
          full = i;
        }
      }
    }
    return full;
  }

  /** The deepest open group below the top whose frame has a node ahead for `tag`, or -1. */
  #level(tag: string): number {
    for (let level = this.#stack.length - 2; level >= 0; level--) {
      if (this.#ahead(this.#stack[level] as Frame, tag) >= 0) {
        return level;
      }
    }
    return -1;
  }

  /** Closes the frames above `level`, saying what each still needed. */
  #close(level: number, tag: string | null, number: number, offset: number): void {
    while (this.#stack.length - 1 > level) {
      const top = this.#stack.pop() as Frame;
      this.#skipTo(top, top.nodes.length, tag, number, offset);
    }
  }

  /** The nodes from the one the frame is at up to `to` were skipped: the mandatory ones are missing. */
  #skipTo(frame: Frame, to: number, before: string | null, number: number, offset: number): void {
    for (let i = frame.at; i < to; i++) {
      const node = frame.nodes[i] as NodeDef;
      if (node.min > 0 && frame.counts[i] === 0) {
        this.#sink.add(
          {
            code: "MISSING_MANDATORY_SEGMENT",
            segment: number,
            tag: before,
            expected: node.tag,
            found: before,
            ...(before === null
              ? {
                  message: `The mandatory ${node.tag} segment is missing at the end of the message.`,
                }
              : {}),
            offset,
          },
          this.#locate,
        );
      }
    }
  }

  // --- What is wrong ----------------------------------------------------------------------

  #tooMany(node: NodeDef, seen: number, number: number, offset: number): void {
    this.#sink.add(
      {
        code: "TOO_MANY_REPETITIONS",
        segment: number,
        tag: node.tag,
        expected: node.max === 1 ? "1 occurrence" : `${node.max} occurrences`,
        found: `${seen} occurrences`,
        offset,
      },
      this.#locate,
    );
  }

  #stray(tag: string, number: number, offset: number): void {
    if (!this.#message.tags.has(tag)) {
      this.#sink.add(
        { code: "UNKNOWN_SEGMENT", segment: number, tag, found: tag, offset },
        this.#locate,
      );
      return;
    }
    const allowed = this.#allowed();
    this.#sink.add(
      {
        code: "SEGMENT_OUT_OF_ORDER",
        segment: number,
        tag,
        expected: allowed,
        found: tag,
        ...(allowed === null
          ? {
              message: `The ${tag} segment is out of order: the message structure has nothing more to come at this point.`,
            }
          : {}),
        offset,
      },
      this.#locate,
    );
  }

  /**
   * The tags that the message can continue with, for the message of an issue: the ones ahead in the
   * group it is in, up to the first mandatory node that has not been seen, and then in the groups
   * around it. A phrase such as "NAD, LIN or UNS".
   */
  #allowed(): string | null {
    const tags: string[] = [];
    scan: for (let level = this.#stack.length - 1; level >= 0; level--) {
      const frame = this.#stack[level] as Frame;
      for (let i = frame.at; i < frame.nodes.length; i++) {
        const node = frame.nodes[i] as NodeDef;
        const full = (frame.counts[i] as number) >= node.max;
        if (!full && !tags.includes(node.tag)) {
          tags.push(node.tag);
        }
        if (tags.length >= MAX_LISTED) {
          break scan;
        }
        if (node.min > 0 && frame.counts[i] === 0) {
          break scan;
        }
      }
    }
    if (tags.length === 0) {
      return null;
    }
    const last = tags.pop() as string;
    return tags.length === 0 ? last : `${tags.join(", ")} or ${last}`;
  }
}

function frame(nodes: readonly NodeDef[]): Frame {
  return { nodes, at: 0, counts: new Array<number>(nodes.length).fill(0) };
}
