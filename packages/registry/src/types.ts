/**
 * TypeScript view of contracts/registry/registry.schema.json, written by hand until the contract
 * tooling generates it (issue #182). The schema is the source of truth: keep both in step.
 */

/** M = mandatory (at least one occurrence), C = conditional (may be absent). */
export type Status = "M" | "C";

export type Section = "header" | "detail" | "summary";

export interface DataElement {
  name: string;
  description?: string;
  /** a = alphabetic, n = numeric, an = alphanumeric. */
  type: "a" | "an" | "n";
  minLength: number;
  maxLength: number;
  /** Key of codeLists. */
  codeList?: string;
}

export interface ComponentPosition {
  /** Tag of a simple data element. */
  ref: string;
  status: Status;
}

export interface Composite {
  name: string;
  description?: string;
  components: ComponentPosition[];
}

export interface ElementPosition {
  /** Tag of a simple data element or of a composite. */
  ref: string;
  status: Status;
  /** Defaults to 1. */
  maxOccurs?: number;
}

export interface Segment {
  name: string;
  description?: string;
  elements: ElementPosition[];
}

export interface Code {
  name: string;
  description?: string;
}

export interface CodeList {
  name: string;
  description?: string;
  /** True when `codes` holds every valid value; false when the list is maintained elsewhere. */
  closed: boolean;
  codes: Record<string, Code>;
}

interface NodeBase {
  status: Status;
  /** Defaults to 1. */
  maxOccurs?: number;
  /** Position in the message structure table of the directory, for example "0020". */
  sequence?: string;
  section?: Section;
}

export interface SegmentNode extends NodeBase {
  kind: "segment";
  tag: string;
}

export interface GroupNode extends NodeBase {
  kind: "group";
  /** SG1, SG2, … unique in the message. */
  id: string;
  /** Opens each occurrence of the group: a mandatory segment that occurs once. */
  trigger: { tag: string; sequence?: string };
  /** What follows the trigger inside the group, in order. Defaults to none. */
  nodes?: MessageNode[];
}

export type MessageNode = SegmentNode | GroupNode;

export interface Message {
  name: string;
  description?: string;
  /** The segments and groups between UNH and UNT, in order. */
  nodes: MessageNode[];
}

export interface Registry {
  schemaVersion: 1;
  directory: { agency: string; version: string; release: string };
  syntaxVersions: number[];
  source: {
    kind: "unece-directory" | "handwritten";
    archives?: { name: string; sha256: string }[];
    generator?: { name: string; version: string };
    generatedAt?: string;
  };
  dataElements: Record<string, DataElement>;
  composites: Record<string, Composite>;
  segments: Record<string, Segment>;
  codeLists: Record<string, CodeList>;
  messages: Record<string, Message>;
}
