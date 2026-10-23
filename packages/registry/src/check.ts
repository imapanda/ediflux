import type { MessageNode, Registry } from "./types.ts";

/** One thing wrong in a registry, and where: `path` is a JSON Pointer (RFC 6901) into it. */
export interface Problem {
  path: string;
  message: string;
}

const COMPOSITE_TAG = /^[CS][0-9]{3}$/;

/**
 * Checks what registry.schema.json cannot express: references that must resolve, lengths that
 * must be in order and group identifiers that must be unique. The registry must already be valid
 * against the schema, which keeps every key safe to put in a JSON Pointer. Returns every problem
 * found, section by section (data elements, composites, segments, messages); an empty list means
 * the registry is coherent. The rules are listed in contracts/registry/README.md so that a reader
 * in another language can apply them too.
 */
export function checkRegistry(registry: Registry): Problem[] {
  const problems: Problem[] = [];
  const report = (path: string, message: string): void => {
    problems.push({ path, message });
  };
  const hasSegment = (tag: string): boolean => Object.hasOwn(registry.segments, tag);

  for (const [tag, element] of Object.entries(registry.dataElements)) {
    if (element.minLength > element.maxLength) {
      report(
        `/dataElements/${tag}`,
        `minLength (${element.minLength}) is greater than maxLength (${element.maxLength})`,
      );
    }
    if (element.codeList !== undefined && !Object.hasOwn(registry.codeLists, element.codeList)) {
      report(
        `/dataElements/${tag}/codeList`,
        `code list "${element.codeList}" does not exist in codeLists`,
      );
    }
  }

  for (const [tag, composite] of Object.entries(registry.composites)) {
    composite.components.forEach((component, index) => {
      if (!Object.hasOwn(registry.dataElements, component.ref)) {
        report(
          `/composites/${tag}/components/${index}/ref`,
          `data element "${component.ref}" does not exist in dataElements`,
        );
      }
    });
  }

  for (const [tag, segment] of Object.entries(registry.segments)) {
    segment.elements.forEach((element, index) => {
      const isComposite = COMPOSITE_TAG.test(element.ref);
      const known = isComposite ? registry.composites : registry.dataElements;
      if (!Object.hasOwn(known, element.ref)) {
        report(
          `/segments/${tag}/elements/${index}/ref`,
          `${isComposite ? "composite" : "data element"} "${element.ref}" does not exist in ${
            isComposite ? "composites" : "dataElements"
          }`,
        );
      }
    });
  }

  for (const [type, message] of Object.entries(registry.messages)) {
    const groupIds = new Set<string>();
    const visit = (nodes: MessageNode[], path: string): void => {
      nodes.forEach((node, index) => {
        const here = `${path}/${index}`;
        if (node.kind === "segment") {
          if (!hasSegment(node.tag)) {
            report(`${here}/tag`, `segment "${node.tag}" does not exist in segments`);
          }
          return;
        }
        if (groupIds.has(node.id)) {
          report(`${here}/id`, `group id "${node.id}" is already used in message ${type}`);
        }
        groupIds.add(node.id);
        if (!hasSegment(node.trigger.tag)) {
          report(`${here}/trigger/tag`, `segment "${node.trigger.tag}" does not exist in segments`);
        }
        visit(node.nodes ?? [], `${here}/nodes`);
      });
    };
    visit(message.nodes, `/messages/${type}/nodes`);
  }

  return problems;
}
