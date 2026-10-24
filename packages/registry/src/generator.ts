/**
 * Who wrote a registry, recorded in `source.generator`. Change `version` whenever the same archive
 * would give a different registry (a parser fix, a new field): `libredi registry build` rebuilds
 * the registries that another version wrote, and leaves the others alone.
 */
export const GENERATOR = { name: "@libredi/registry", version: "1.0.0" } as const;
