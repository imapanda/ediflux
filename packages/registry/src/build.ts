import { checkRegistry } from "./check.ts";
import type { DirectoryPin } from "./directories.ts";
import { sha256Hex } from "./download.ts";
import { validateRegistry } from "./schema.ts";
import type { MessageNode, Registry } from "./types.ts";
import {
  parseCodeLists,
  parseComposites,
  parseElements,
  parseSegments,
} from "./untdid/definitions.ts";
import { parseMessage } from "./untdid/messages.ts";
import { addServiceDefinitions } from "./untdid/service.ts";
import { decodeDirectoryText } from "./untdid/text.ts";
import { readZip, type ZipEntry } from "./zip.ts";

/** The text of the files of a directory that a registry is built from. */
export interface DirectoryTexts {
  elements: string;
  composites: string;
  segments: string;
  codes: string[];
  messages: string[];
}

export class RegistryBuildError extends Error {
  override name = "RegistryBuildError";
}

export interface BuildOptions {
  generator: { name: string; version: string };
  generatedAt: string;
  /** Overrides the checksum pinned for the directory, like the same option of the download. */
  expectedSha256?: string;
}

export interface BuildResult {
  registry: Registry;
  /** Lines of the directory files that were not understood. Empty for the supported directories. */
  warnings: string[];
}

const baseName = (name: string): string => (name.split("/").pop() ?? name).toLowerCase();

/** Far above the real archives (D.01B: 2 MB in all), and low enough to stop a bomb. */
const LIMITS = {
  maxEntries: 1_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

/** Warnings kept, and their length: the files are not trusted to be short. */
const MAX_WARNINGS = 200;
const MAX_WARNING_LENGTH = 300;

/**
 * Takes the files a registry needs out of the archive downloaded from UNECE: the archive holds
 * one archive per part of the directory (data elements, composites, segments, messages, code
 * lists), and each of these holds text files.
 */
export function readDirectoryArchive(bytes: Uint8Array, pin: DirectoryPin): DirectoryTexts {
  const outer = readZip(bytes, LIMITS);
  const release = pin.release.toLowerCase();
  const open = (part: string): ZipEntry[] => {
    const entry = outer.find(
      (candidate) => baseName(candidate.name) === `${part}.zip`.toLowerCase(),
    );
    if (!entry) throw new RegistryBuildError(`${pin.fileName} contains no ${part}.ZIP`);
    return readZip(entry.data, LIMITS);
  };
  const text = (entry: ZipEntry): string => decodeDirectoryText(entry.data);
  const single = (part: string): string => {
    const entry = open(part).find(
      (candidate) => baseName(candidate.name) === `${part}.${release}`.toLowerCase(),
    );
    if (!entry) throw new RegistryBuildError(`${part}.ZIP contains no ${part}.${pin.release}`);
    return text(entry);
  };
  const many = (part: string, wanted: RegExp): string[] => {
    const entries = open(part)
      .filter((candidate) => wanted.test(baseName(candidate.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0)
      throw new RegistryBuildError(`${part}.ZIP contains no file for ${pin.id}`);
    return entries.map(text);
  };

  return {
    elements: single(pin.parts.elements),
    composites: single(pin.parts.composites),
    segments: single(pin.parts.segments),
    codes: many(pin.parts.codes, new RegExp(`^${pin.parts.codes.toLowerCase()}.*\\.${release}$`)),
    messages: many(pin.parts.messages, new RegExp(`_d\\.${release}$`)),
  };
}

/** Builds the registry of a directory from its files, without checking it (see `buildRegistryFromArchive`). */
export function buildRegistry(
  texts: DirectoryTexts,
  pin: DirectoryPin,
  source: Registry["source"],
  warn: (message: string) => void,
): Registry {
  const byTag = <T extends { tag: string }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.tag.localeCompare(b.tag));
  const registry: Registry = {
    schemaVersion: 1,
    directory: { agency: "UN", version: pin.version, release: pin.release },
    syntaxVersions: pin.syntaxVersions,
    source,
    dataElements: {},
    composites: {},
    segments: {},
    codeLists: {},
    messages: {},
  };

  const lists = byTag(
    texts.codes.flatMap((text) => parseCodeLists(text, pin.codeNameColumn, warn)),
  );
  const codeListTags = new Set(
    lists.filter((list) => list.codes.length > 0).map((list) => list.tag),
  );
  for (const element of byTag(parseElements(texts.elements, warn))) {
    const { tag, name, description, type, minLength, maxLength } = element;
    registry.dataElements[tag] = {
      name,
      ...(description && { description }),
      type,
      minLength,
      maxLength,
      ...(codeListTags.has(tag) && { codeList: tag }),
    };
  }
  for (const list of lists) {
    if (list.codes.length === 0) continue;
    if (!registry.dataElements[list.tag]) {
      warn(`code list ${list.tag} belongs to no data element`);
      continue;
    }
    // UNCL does not say which lists are exhaustive; the validator decides how strict to be.
    registry.codeLists[list.tag] = {
      name: list.name,
      closed: true,
      codes: Object.fromEntries(
        list.codes.map((code) => [
          code.value,
          { name: code.name, ...(code.description && { description: code.description }) },
        ]),
      ),
    };
  }
  for (const composite of byTag(parseComposites(texts.composites, warn))) {
    registry.composites[composite.tag] = {
      name: composite.name,
      ...(composite.description && { description: composite.description }),
      components: composite.components,
    };
  }
  for (const segment of byTag(parseSegments(texts.segments, warn))) {
    registry.segments[segment.tag] = {
      name: segment.name,
      ...(segment.description && { description: segment.description }),
      elements: segment.elements.map(({ ref, status, maxOccurs }) => ({
        ref,
        status,
        ...(maxOccurs > 1 && { maxOccurs }),
      })),
    };
  }
  for (const text of texts.messages) {
    const message = parseMessage(text, warn);
    if (!message) continue;
    if (message.version !== pin.version || message.release !== pin.release) {
      warn(
        `${message.type} is ${message.version} ${message.release}, not ${pin.version} ${pin.release}`,
      );
    }
    registry.messages[message.type] = { name: message.name, nodes: message.nodes };
  }
  addServiceDefinitions(registry);
  // A message that uses a segment which no file defines cannot be described, and is left out. In
  // D.01B two messages do, with the segments UGH and UGT of ISO 9735 syntax version 4.
  for (const [type, message] of Object.entries(registry.messages)) {
    const missing = [...new Set(tagsOf(message.nodes))].filter((tag) => !registry.segments[tag]);
    if (missing.length > 0) {
      warn(
        `${type} is left out: it uses ${missing.join(", ")}, which the directory does not define`,
      );
      delete registry.messages[type];
    }
  }
  // The same files always give the same bytes, which keeps a rebuilt registry easy to compare.
  registry.dataElements = sortedByKey(registry.dataElements);
  registry.composites = sortedByKey(registry.composites);
  registry.segments = sortedByKey(registry.segments);
  registry.codeLists = sortedByKey(registry.codeLists);
  registry.messages = sortedByKey(registry.messages);
  return registry;
}

function sortedByKey<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

function tagsOf(nodes: MessageNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "segment" ? [node.tag] : [node.trigger.tag, ...tagsOf(node.nodes ?? [])],
  );
}

/**
 * Builds the registry of a directory from the archive downloaded from UNECE, and refuses to
 * return one that does not validate against the schema or whose references do not resolve.
 */
export function buildRegistryFromArchive(
  bytes: Uint8Array,
  pin: DirectoryPin,
  options: BuildOptions,
): BuildResult {
  const actual = sha256Hex(bytes);
  const expected = (options.expectedSha256 ?? pin.sha256).toLowerCase();
  if (actual !== expected) {
    throw new RegistryBuildError(
      `The archive for ${pin.id} has SHA-256 ${actual}, not ${expected}`,
    );
  }
  const warnings: string[] = [];
  let dropped = 0;
  const texts = readDirectoryArchive(bytes, pin);
  const registry = buildRegistry(
    texts,
    pin,
    {
      kind: "unece-directory",
      archives: [{ name: pin.fileName, sha256: actual }],
      generator: options.generator,
      generatedAt: options.generatedAt,
    },
    (message) => {
      if (warnings.length < MAX_WARNINGS) warnings.push(message.slice(0, MAX_WARNING_LENGTH));
      else dropped += 1;
    },
  );
  if (dropped > 0) warnings.push(`… and ${dropped} more warnings`);
  const shape = validateRegistry(registry);
  const problems = shape.length > 0 ? shape : checkRegistry(registry);
  if (problems.length > 0) {
    const shown = problems
      .slice(0, 20)
      .map((problem) => `  ${problem.path || "/"}: ${problem.message}`);
    const more = problems.length > 20 ? [`  … and ${problems.length - 20} more`] : [];
    throw new RegistryBuildError(
      `The registry for ${pin.id} is not valid (${problems.length} problems):\n${[...shown, ...more].join("\n")}`,
    );
  }
  return { registry, warnings };
}
