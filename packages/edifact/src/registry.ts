/*
 * What the validator reads of a definition registry (contracts/registry/registry.schema.json):
 * the data elements, composites, segments, code lists and message structures of one directory.
 *
 * `RegistryView` is the part of the registry document that validation uses, written as an
 * interface so that this package does not depend on the registry package (which downloads and
 * builds registries and has no place in an engine): a document that follows the schema, a
 * `Registry` of `@libredi/registry` or a hand-written object for a test is one.
 *
 * `compileRegistry` turns it once into the shapes the validator walks: references resolved,
 * lengths and cardinalities as numbers, code lists as lookups. A registry is trusted after that:
 * `checkRegistry()` of the registry package is where its references are checked.
 */

export type Status = "M" | "C";

export interface DataElementView {
  readonly name?: string;
  readonly type: "a" | "an" | "n";
  readonly minLength: number;
  readonly maxLength: number;
  readonly codeList?: string;
}

export interface PositionView {
  readonly ref: string;
  readonly status: Status;
  readonly maxOccurs?: number;
}

export interface CodeListView {
  readonly closed: boolean;
  /** Own properties are the codes; the values are not read. */
  readonly codes: Readonly<Record<string, unknown>>;
}

export type NodeView =
  | {
      readonly kind: "segment";
      readonly tag: string;
      readonly status: Status;
      readonly maxOccurs?: number;
    }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly status: Status;
      readonly maxOccurs?: number;
      readonly trigger: { readonly tag: string };
      readonly nodes?: readonly NodeView[];
    };

export interface RegistryView {
  readonly directory: {
    readonly agency: string;
    readonly version: string;
    readonly release: string;
  };
  readonly dataElements: Readonly<Record<string, DataElementView>>;
  readonly composites: Readonly<
    Record<string, { readonly name?: string; readonly components: readonly PositionView[] }>
  >;
  readonly segments: Readonly<
    Record<string, { readonly name?: string; readonly elements: readonly PositionView[] }>
  >;
  readonly codeLists: Readonly<Record<string, CodeListView>>;
  readonly messages: Readonly<Record<string, { readonly nodes: readonly NodeView[] }>>;
}

// --- What the validator walks -------------------------------------------------------------

/** A simple data element: its type and length in characters, and its code list if it has one. */
export interface ElementDef {
  readonly ref: string;
  /** How a message names it: the name of the registry and the tag, "quantity (6060)". */
  readonly label: string;
  readonly type: "a" | "an" | "n";
  readonly min: number;
  readonly max: number;
  readonly codes: CodeListView | null;
}

export interface ComponentDef {
  readonly mandatory: boolean;
  readonly element: ElementDef;
}

/** A position of a segment: a simple element, or a composite with its components. */
export interface PositionDef {
  readonly ref: string;
  readonly label: string;
  readonly mandatory: boolean;
  readonly maxOccurs: number;
  readonly element: ElementDef | null;
  readonly components: readonly ComponentDef[] | null;
}

export interface SegmentDef {
  readonly tag: string;
  readonly positions: readonly PositionDef[];
}

/** A node of a message: a segment, or a group seen by its trigger. */
export interface NodeDef {
  readonly kind: "segment" | "group";
  /** The tag of the segment, or of the trigger of the group. */
  readonly tag: string;
  readonly id: string | null;
  /** 1 for a mandatory node, 0 for a conditional one. */
  readonly min: 0 | 1;
  readonly max: number;
  /** What follows the trigger of a group. */
  readonly nodes: readonly NodeDef[];
}

export interface MessageDef {
  readonly nodes: readonly NodeDef[];
  /** Every tag that is somewhere in the structure, to tell a segment out of order from a stranger. */
  readonly tags: ReadonlySet<string>;
}

export interface CompiledRegistry {
  readonly directory: RegistryView["directory"];
  segment(tag: string): SegmentDef | undefined;
  message(type: string): MessageDef | undefined;
}

class Compiled implements CompiledRegistry {
  readonly directory: RegistryView["directory"];
  readonly #registry: RegistryView;
  readonly #elements = new Map<string, ElementDef>();
  readonly #segments = new Map<string, SegmentDef>();
  readonly #messages = new Map<string, MessageDef>();

  constructor(registry: RegistryView) {
    this.#registry = registry;
    this.directory = registry.directory;
  }

  // Only what the registry has is kept: a tag or a message type is text from the file, and a
  // cache of misses would grow with whatever the files hold.
  segment(tag: string): SegmentDef | undefined {
    let def = this.#segments.get(tag);
    if (def === undefined) {
      if (!Object.hasOwn(this.#registry.segments, tag)) {
        return undefined;
      }
      const source = this.#registry.segments[tag] as RegistryView["segments"][string];
      def = { tag, positions: source.elements.map((position) => this.#position(position)) };
      this.#segments.set(tag, def);
    }
    return def;
  }

  message(type: string): MessageDef | undefined {
    let def = this.#messages.get(type);
    if (def === undefined) {
      if (!Object.hasOwn(this.#registry.messages, type)) {
        return undefined;
      }
      const source = this.#registry.messages[type] as RegistryView["messages"][string];
      const tags = new Set<string>();
      def = { nodes: nodes(source.nodes, tags), tags };
      this.#messages.set(type, def);
    }
    return def;
  }

  #element(ref: string): ElementDef {
    let def = this.#elements.get(ref);
    if (def === undefined) {
      const source = Object.hasOwn(this.#registry.dataElements, ref)
        ? this.#registry.dataElements[ref]
        : undefined;
      const list = source?.codeList;
      // A reference to nothing is a defect of the registry, which checkRegistry() reports; here
      // the element is simply free, so that one bad definition cannot stop a validation.
      def =
        source === undefined
          ? { ref, label: ref, type: "an", min: 0, max: Number.POSITIVE_INFINITY, codes: null }
          : {
              ref,
              label: label(source.name, ref),
              type: source.type,
              min: source.minLength,
              max: source.maxLength,
              codes:
                list !== undefined && Object.hasOwn(this.#registry.codeLists, list)
                  ? (this.#registry.codeLists[list] as CodeListView)
                  : null,
            };
      this.#elements.set(ref, def);
    }
    return def;
  }

  #position(position: PositionView): PositionDef {
    const composite = Object.hasOwn(this.#registry.composites, position.ref)
      ? this.#registry.composites[position.ref]
      : undefined;
    return {
      ref: position.ref,
      label:
        composite === undefined
          ? this.#element(position.ref).label
          : label(composite.name, position.ref),
      mandatory: position.status === "M",
      maxOccurs: position.maxOccurs ?? 1,
      element: composite === undefined ? this.#element(position.ref) : null,
      components:
        composite === undefined
          ? null
          : composite.components.map((component) => ({
              mandatory: component.status === "M",
              element: this.#element(component.ref),
            })),
    };
  }
}

const label = (name: string | undefined, ref: string): string =>
  name === undefined ? ref : `${name} (${ref})`;

function nodes(source: readonly NodeView[], tags: Set<string>): NodeDef[] {
  return source.map((node): NodeDef => {
    if (node.kind === "segment") {
      tags.add(node.tag);
      return {
        kind: "segment",
        tag: node.tag,
        id: null,
        min: node.status === "M" ? 1 : 0,
        max: node.maxOccurs ?? 1,
        nodes: [],
      };
    }
    tags.add(node.trigger.tag);
    return {
      kind: "group",
      tag: node.trigger.tag,
      id: node.id,
      min: node.status === "M" ? 1 : 0,
      max: node.maxOccurs ?? 1,
      nodes: nodes(node.nodes ?? [], tags),
    };
  });
}

const COMPILED = new WeakMap<RegistryView, CompiledRegistry>();

/** The registry as the validator walks it; made once per registry object. */
export function compileRegistry(registry: RegistryView): CompiledRegistry {
  let compiled = COMPILED.get(registry);
  if (compiled === undefined) {
    compiled = new Compiled(registry);
    COMPILED.set(registry, compiled);
  }
  return compiled;
}

/** The registry for a message identifier (UNH S009: agency, version, release), if there is one. */
export function findRegistry(
  registries: readonly RegistryView[],
  agency: string,
  version: string,
  release: string,
): CompiledRegistry | undefined {
  for (const registry of registries) {
    const { directory } = registry;
    if (
      directory.agency === agency &&
      directory.version === version &&
      directory.release === release
    ) {
      return compileRegistry(registry);
    }
  }
  return undefined;
}
