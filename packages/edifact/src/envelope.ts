import { type IssueDraft, shown } from "./issues.ts";
import type { LineColumn } from "./line-index.ts";
import type { Envelope, Message, MessageInterchange, Segment } from "./tree.ts";

/*
 * Envelope validation: the segments that wrap the data, checked without a registry. The rules are
 * those of ISO 9735 for UNB/UNZ (interchange), UNG/UNE (group) and UNH/UNT (message): the
 * mandatory data of each segment, the control references that open and close, and the counts.
 *
 * The checker reads the stream of messages and envelope segments in file order, one item at a
 * time, and keeps only a few numbers: the memory does not depend on the size of the file. It
 * never asks a message for its list of segments, which would build a node for each of them.
 */

/** Where the checker puts what it finds. */
export interface IssueSink {
  add(draft: IssueDraft, locate: (offset: number) => LineColumn): void;
}

/** A mandatory data element of an envelope segment, and the components that it must have. */
interface Mandatory {
  readonly element: number;
  readonly name: string;
  /** The names of the components of a composite; absent for a simple data element. */
  readonly components?: readonly string[];
}

const MANDATORY: Readonly<Record<string, readonly Mandatory[]>> = {
  UNB: [
    { element: 1, name: "syntax identifier", components: ["syntax identifier", "syntax version"] },
    { element: 2, name: "sender", components: ["sender identification"] },
    { element: 3, name: "recipient", components: ["recipient identification"] },
    {
      element: 4,
      name: "date and time of preparation",
      components: ["date of preparation", "time of preparation"],
    },
    { element: 5, name: "interchange control reference" },
  ],
  UNZ: [
    { element: 1, name: "interchange control count" },
    { element: 2, name: "interchange control reference" },
  ],
  UNG: [
    { element: 1, name: "functional group identification" },
    { element: 2, name: "sender", components: ["sender identification"] },
    { element: 3, name: "recipient", components: ["recipient identification"] },
    {
      element: 4,
      name: "date and time of preparation",
      components: ["date of preparation", "time of preparation"],
    },
    { element: 5, name: "group reference number" },
    { element: 6, name: "controlling agency" },
    {
      element: 7,
      name: "message version",
      components: ["message version number", "message release number"],
    },
  ],
  UNE: [
    { element: 1, name: "group message count" },
    { element: 2, name: "group reference number" },
  ],
  UNH: [
    { element: 1, name: "message reference number" },
    {
      element: 2,
      name: "message identifier",
      components: [
        "message type",
        "message version number",
        "message release number",
        "controlling agency",
      ],
    },
  ],
  UNT: [
    { element: 1, name: "segment count" },
    { element: 2, name: "message reference number" },
  ],
};

const WHOLE_NUMBER = /^[0-9]+$/;
const SYNTAX_VERSIONS: ReadonlySet<string> = new Set(["3", "4"]);

interface GroupState {
  readonly ung: Segment;
  messages: number;
}

/** An interchange while it is read. */
interface InterchangeState {
  readonly index: number;
  readonly locate: (offset: number) => LineColumn;
  unb: Segment | null;
  messages: number;
  groups: number;
  group: GroupState | null;
  closed: boolean;
  /** The header was found missing and said so: once per interchange. */
  headerReported: boolean;
  /** The last message ran into whatever comes next, without a UNT: the next segment says where. */
  untMissing: boolean;
  /** Where the last segment seen ends, and its number: where a missing closing segment belongs. */
  lastNumber: number;
  lastEnd: number;
}

export class EnvelopeChecker {
  readonly #sink: IssueSink;
  #state: InterchangeState | null = null;

  constructor(sink: IssueSink) {
    this.#sink = sink;
  }

  /** A message: counted, and its UNH and UNT checked. */
  message(message: Message): void {
    const state = this.#enter(message.interchange);
    const { unh, unt } = message;
    this.#gap(state, unh);
    if (message.interchange.unb === null && !state.headerReported) {
      // Messages, and no UNB in front of them: the interchange has no header.
      state.headerReported = true;
      this.#sink.add(
        {
          code: "MISSING_ENVELOPE_SEGMENT",
          segment: unh.number,
          tag: unh.tag,
          expected: "UNB",
          found: unh.tag,
          offset: unh.start,
        },
        state.locate,
      );
    }
    state.messages++;
    if (state.group !== null) {
      state.group.messages++;
    }
    this.#mandatory(state, unh);
    if (unt === null) {
      state.untMissing = true;
    } else {
      this.#mandatory(state, unt);
      this.#count(state, unt, "UNT_COUNT_MISMATCH", message.segmentCount, "segments");
      this.#reference(state, unt, unh, 1, "UNT_REFERENCE_MISMATCH");
    }
    state.lastNumber = unh.number + message.segmentCount - 1;
    state.lastEnd = message.end;
  }

  /** The segments between messages: the envelope of the interchange and of its groups. */
  envelope(envelope: Envelope): void {
    for (const segment of envelope.segments) {
      const state = this.#enter(envelope.interchange);
      this.#gap(state, segment);
      state.lastNumber = segment.number;
      state.lastEnd = segment.end;
      switch (segment.tag) {
        case "UNB":
          this.#open(state, segment);
          break;
        case "UNG":
          this.#openGroup(state, segment);
          break;
        case "UNE":
          this.#closeGroup(state, segment);
          break;
        case "UNZ":
          this.#close(state, segment);
          break;
        case "UNT":
          this.#unexpected(
            state,
            segment,
            "The UNT segment closes a message, but no message is open here.",
            "Check that the UNH segment that opens the message is present, and that UNT is not repeated; or remove this UNT.",
          );
          break;
        default:
          this.#unexpected(
            state,
            segment,
            `The ${segment.tag} segment is between messages, where only the envelope segments UNB, UNG, UNE and UNZ can be.`,
            "Segments other than the envelope segments belong between a UNH and its UNT. Move the segment into its message, or remove it.",
          );
      }
    }
  }

  /**
   * The end of the file. `complete` is false when the file stopped on an error: what is missing
   * then is a consequence of that error, which has been reported, not a second problem.
   */
  finish(complete: boolean): void {
    const state = this.#state;
    if (state !== null && !state.closed && complete) {
      this.#missingEnd(state);
    }
    this.#state = null;
  }

  // --- Interchange ------------------------------------------------------------------------

  /** The state of the interchange an item belongs to, closing the last one if this is a new one. */
  #enter(interchange: MessageInterchange): InterchangeState {
    const current = this.#state;
    if (current !== null && current.index === interchange.index) {
      return current;
    }
    if (current !== null && !current.closed) {
      this.#missingEnd(current);
    }
    const state: InterchangeState = {
      index: interchange.index,
      locate: (offset) => interchange.locate(offset),
      unb: null,
      messages: 0,
      groups: 0,
      group: null,
      closed: false,
      headerReported: false,
      untMissing: false,
      lastNumber: 0,
      lastEnd: 0,
    };
    this.#state = state;
    return state;
  }

  /** A segment arrives: if the message before it had no UNT, the UNT was to be just before it. */
  #gap(state: InterchangeState, next: Segment): void {
    if (state.untMissing) {
      state.untMissing = false;
      this.#sink.add(
        {
          code: "MISSING_ENVELOPE_SEGMENT",
          segment: next.number,
          tag: next.tag,
          expected: "UNT",
          found: next.tag,
          offset: next.start,
        },
        state.locate,
      );
    }
  }

  /**
   * What is still open when the interchange stops, at the end of the file or when another one
   * begins: UNT for a message, UNE for a group, UNZ for the interchange. An interchange that held
   * nothing but loose segments has nothing to close.
   */
  #missingEnd(state: InterchangeState): void {
    state.closed = true;
    if (state.unb === null && state.messages === 0) {
      return;
    }
    const missing = [
      ...(state.untMissing ? ["UNT"] : []),
      ...(state.group === null ? [] : ["UNE"]),
      "UNZ",
    ];
    for (const expected of missing) {
      this.#sink.add(
        {
          code: "MISSING_ENVELOPE_SEGMENT",
          segment: state.lastNumber + 1,
          tag: null,
          expected,
          offset: state.lastEnd,
        },
        state.locate,
      );
    }
  }

  #open(state: InterchangeState, unb: Segment): void {
    state.unb = unb;
    this.#mandatory(state, unb);
    const version = unb.text(1, 2);
    if (version !== undefined && version !== "" && !SYNTAX_VERSIONS.has(version)) {
      this.#sink.add(
        {
          code: "UNSUPPORTED_SYNTAX_VERSION",
          segment: unb.number,
          tag: "UNB",
          element: 1,
          component: 2,
          expected: "3 or 4",
          found: shown(version),
          offset: unb.component(1, 2)?.start ?? unb.start,
        },
        state.locate,
      );
    }
  }

  #close(state: InterchangeState, unz: Segment): void {
    if (state.group !== null) {
      this.#missingGroupEnd(state, unz);
    }
    state.closed = true;
    this.#mandatory(state, unz);
    // The count is of groups when the interchange has any, of messages otherwise.
    const [counted, unit] =
      state.groups > 0 ? [state.groups, "groups"] : [state.messages, "messages"];
    this.#count(state, unz, "UNZ_COUNT_MISMATCH", counted, unit);
    this.#reference(state, unz, state.unb, 5, "UNZ_REFERENCE_MISMATCH");
  }

  // --- Group ------------------------------------------------------------------------------

  #openGroup(state: InterchangeState, ung: Segment): void {
    if (state.group !== null) {
      this.#missingGroupEnd(state, ung);
    }
    state.groups++;
    state.group = { ung, messages: 0 };
    this.#mandatory(state, ung);
  }

  #closeGroup(state: InterchangeState, une: Segment): void {
    const group = state.group;
    if (group === null) {
      this.#unexpected(
        state,
        une,
        "The UNE segment closes a group, but no UNG has opened one.",
        "Check that the UNG segment that opens the group is present, and that UNE is not repeated; or remove this UNE.",
      );
      return;
    }
    state.group = null;
    this.#mandatory(state, une);
    this.#count(state, une, "UNE_COUNT_MISMATCH", group.messages, "messages");
    this.#reference(state, une, group.ung, 5, "UNE_REFERENCE_MISMATCH");
  }

  /** A group is still open when `next` arrives: its UNE is missing, just before `next`. */
  #missingGroupEnd(state: InterchangeState, next: Segment): void {
    this.#sink.add(
      {
        code: "MISSING_ENVELOPE_SEGMENT",
        segment: next.number,
        tag: next.tag,
        expected: "UNE",
        found: next.tag,
        offset: next.start,
      },
      state.locate,
    );
    state.group = null;
  }

  // --- Shared -----------------------------------------------------------------------------

  #unexpected(state: InterchangeState, segment: Segment, message: string, hint: string): void {
    this.#sink.add(
      {
        code: "UNEXPECTED_SEGMENT",
        segment: segment.number,
        tag: segment.tag,
        found: segment.tag,
        message,
        hint,
        offset: segment.start,
      },
      state.locate,
    );
  }

  /**
   * Every mandatory element and component of a segment has a value. A composite that is absent
   * or empty is one problem, not one for each of its components.
   */
  #mandatory(state: InterchangeState, segment: Segment): void {
    for (const { element, name, components } of MANDATORY[segment.tag] ?? []) {
      const view = segment.element(element);
      const has = (components ?? [name]).map(
        (_name, c) => (segment.text(element, c + 1) ?? "") !== "",
      );
      // A composite counts as there when any of its components has a value.
      const anyValue = view?.components.some((component) => !component.empty) ?? false;
      const where = {
        code: "MISSING_MANDATORY_ELEMENT",
        segment: segment.number,
        tag: segment.tag,
        element,
        found: "nothing",
        layer: "envelope",
      } as const;
      if (!anyValue) {
        this.#sink.add(
          { ...where, component: null, expected: name, offset: view?.start ?? segment.end - 1 },
          state.locate,
        );
        continue;
      }
      has.forEach((present, c) => {
        if (!present) {
          this.#sink.add(
            {
              ...where,
              component: c + 1,
              expected: components?.[c] ?? name,
              offset: segment.component(element, c + 1)?.start ?? view?.end ?? segment.end - 1,
            },
            state.locate,
          );
        }
      });
    }
  }

  /** The count in the first element of a closing segment is the number that was counted. */
  #count(
    state: InterchangeState,
    closing: Segment,
    code: "UNT_COUNT_MISMATCH" | "UNE_COUNT_MISMATCH" | "UNZ_COUNT_MISMATCH",
    counted: number,
    unit: string,
  ): void {
    const text = closing.text(1);
    if (text === undefined || text === "") {
      return; // missing: reported with the mandatory data
    }
    const offset = closing.element(1)?.start ?? closing.start;
    if (!WHOLE_NUMBER.test(text)) {
      this.#sink.add(
        {
          code: "INVALID_DATA_TYPE",
          segment: closing.number,
          tag: closing.tag,
          element: 1,
          expected: "a whole number",
          found: shown(text),
          layer: "envelope",
          offset,
        },
        state.locate,
      );
      return;
    }
    const written = text.replace(/^0+(?=[0-9])/, "");
    if (Number(written) !== counted) {
      this.#sink.add(
        {
          code,
          segment: closing.number,
          tag: closing.tag,
          element: 1,
          expected: String(counted),
          found: shown(written),
          unit,
          offset,
        },
        state.locate,
      );
    }
  }

  /**
   * The control reference of a closing segment (its second element) is the one of the segment that
   * opened: element `from` of the opener.
   */
  #reference(
    state: InterchangeState,
    closing: Segment,
    opener: Segment | null,
    from: number,
    code: "UNT_REFERENCE_MISMATCH" | "UNE_REFERENCE_MISMATCH" | "UNZ_REFERENCE_MISMATCH",
  ): void {
    const at = 2;
    const wanted = opener?.text(from);
    const written = closing.text(at);
    if (wanted === undefined || wanted === "" || written === undefined || written === "") {
      return; // nothing to compare, or missing: reported with the mandatory data
    }
    if (wanted !== written) {
      this.#sink.add(
        {
          code,
          segment: closing.number,
          tag: closing.tag,
          element: at,
          expected: shown(wanted),
          found: shown(written),
          offset: closing.element(at)?.start ?? closing.start,
        },
        state.locate,
      );
    }
  }
}
