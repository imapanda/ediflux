/** Copy of a JSON document with the value at `path` (dot separated) set, or removed if undefined. */
export function edit(document: unknown, path: string, value?: unknown): unknown {
  const copy = structuredClone(document);
  const keys = path.split(".");
  const last = keys.pop() as string;
  let node = copy as Record<string, unknown>;
  for (const key of keys) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

/** The value at `path` (dot separated) of a JSON document. */
export function get(document: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], document);
}
