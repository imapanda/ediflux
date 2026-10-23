import type { MessageNode, Registry } from "../types.ts";

function uses(nodes: MessageNode[] | undefined, tag: string): boolean {
  return (nodes ?? []).some((node) =>
    node.kind === "segment" ? node.tag === tag : node.trigger.tag === tag || uses(node.nodes, tag),
  );
}

/**
 * The section control segment `UNS` is in every message table, but it belongs to the ISO 9735
 * syntax and the directory files do not define it. Written by hand, with plain names, so that the
 * structures that mention it refer to a definition. UNH and UNT are not in the structures.
 */
export function addServiceDefinitions(registry: Registry): void {
  const needed = Object.values(registry.messages).some((message) => uses(message.nodes, "UNS"));
  if (!needed || registry.segments["UNS"]) return;
  registry.dataElements["0081"] ??= {
    name: "Section marker",
    description: "Tells which section of the message starts after the separator.",
    type: "a",
    minLength: 1,
    maxLength: 1,
    codeList: "0081",
  };
  registry.codeLists["0081"] ??= {
    name: "Section markers",
    closed: true,
    codes: {
      D: { name: "Detail section starts", description: "Separates the header from the detail." },
      S: { name: "Summary section starts", description: "Separates the detail from the summary." },
    },
  };
  registry.segments["UNS"] = {
    name: "Section separator",
    description: "Separates the header, detail and summary sections of a message.",
    elements: [{ ref: "0081", status: "M" }],
  };
}
