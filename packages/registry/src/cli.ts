import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRegistryFromArchive } from "./build.ts";
import { checkRegistry } from "./check.ts";
import { DIRECTORIES, type DirectoryPin } from "./directories.ts";
import { type FetchLike, obtainDirectory } from "./download.ts";
import { GENERATOR } from "./generator.ts";
import { validateRegistry } from "./schema.ts";
import type { Registry } from "./types.ts";

export interface CliContext {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** The directories that can be built. Defaults to the table of directories.ts. */
  directories?: readonly DirectoryPin[];
  /** For tests. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const USAGE = `Usage: libredi registry build [options]

Builds the EDIFACT definition registry from the official UN/ECE directories and writes one file
per directory, <directory>.json, in the output folder. A registry that is already there and was
built from the same archive by this version is left alone, so the command can run at every start.

Options:
  --directory <id>      Directory to build, for example D01B. Repeat for several. Default: all.
  --out <dir>           Output folder. Default: $LIBREDI_REGISTRY_DIR, else
                        $XDG_DATA_HOME/libredi/registry (~/.local/share/libredi/registry).
  --offline <dir>       Read the archives (d96a.zip, d01b.zip) from this folder and never use
                        the network. Default: $LIBREDI_REGISTRY_OFFLINE_DIR.
  --cache <dir>         Where downloaded archives are kept. Default: <out>/.downloads.
  --sha256 <id>=<hex>   Expect this checksum for a directory instead of the pinned one.
  --force               Build again even when the registry is up to date.
  -h, --help            Show this help.

Exit status: 0 when every directory is built or up to date, 1 when one failed, 2 on a usage error.
`;

class UsageError extends Error {}

/**
 * `libredi registry build`. The arguments are those after the program name: `registry build ...`.
 * Returns the exit status instead of exiting, so that a test can run it.
 */
export async function runCli(argv: string[], context: CliContext): Promise<number> {
  const { stdout, stderr } = context;
  try {
    if (argv[0] !== "registry" || argv[1] !== "build") {
      if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
        stdout(USAGE);
        return argv.length === 0 ? 2 : 0;
      }
      throw new UsageError(`unknown command "${argv.slice(0, 2).join(" ")}"`);
    }
    const { values } = parseArgs({
      args: argv.slice(2),
      strict: true,
      options: {
        directory: { type: "string", multiple: true },
        out: { type: "string" },
        offline: { type: "string" },
        cache: { type: "string" },
        sha256: { type: "string", multiple: true },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      stdout(USAGE);
      return 0;
    }
    return await build(values, context);
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      stderr(`${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

interface BuildArguments {
  directory?: string[] | undefined;
  out?: string | undefined;
  offline?: string | undefined;
  cache?: string | undefined;
  sha256?: string[] | undefined;
  force?: boolean | undefined;
}

async function build(args: BuildArguments, context: CliContext): Promise<number> {
  const { env, stdout, stderr } = context;
  const known = context.directories ?? DIRECTORIES;
  const selected = (args.directory ?? known.map((pin) => pin.id)).map((id) => {
    const pin = known.find((candidate) => candidate.id === id.toUpperCase());
    if (!pin) {
      throw new UsageError(
        `unknown directory "${id}" (supported: ${known.map((p) => p.id).join(", ")})`,
      );
    }
    return pin;
  });
  const checksums = new Map<string, string>();
  for (const entry of args.sha256 ?? []) {
    const [id = "", hex = ""] = entry.split("=");
    if (!selected.some((pin) => pin.id === id.toUpperCase()) || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new UsageError(`--sha256 expects <directory>=<64 hexadecimal digits>, got "${entry}"`);
    }
    checksums.set(id.toUpperCase(), hex.toLowerCase());
  }

  const out = resolve(
    args.out ??
      env["LIBREDI_REGISTRY_DIR"] ??
      join(env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "libredi", "registry"),
  );
  const offlineDir = args.offline ?? env["LIBREDI_REGISTRY_OFFLINE_DIR"];
  const cacheDir = resolve(args.cache ?? join(out, ".downloads"));
  await mkdir(out, { recursive: true });

  let failures = 0;
  for (const pin of selected) {
    const target = join(out, `${pin.id.toLowerCase()}.json`);
    const expectedSha256 = checksums.get(pin.id) ?? pin.sha256;
    try {
      if (!args.force && (await isUpToDate(target, expectedSha256))) {
        stdout(`${pin.id}: up to date (${target})`);
        continue;
      }
      const archive = await obtainDirectory(pin, {
        expectedSha256,
        cacheDir,
        ...(offlineDir !== undefined && { offlineDir }),
        ...(context.fetch && { fetch: context.fetch }),
        ...(context.sleep && { sleep: context.sleep }),
      });
      const { registry, warnings } = buildRegistryFromArchive(archive.bytes, pin, {
        generator: GENERATOR,
        generatedAt: (context.now?.() ?? new Date()).toISOString(),
        expectedSha256,
      });
      for (const warning of warnings) stderr(`${pin.id}: ${warning}`);
      await writeAtomically(target, `${JSON.stringify(registry)}\n`);
      const count = Object.keys(registry.messages).length;
      stdout(`${pin.id}: ${count} messages written to ${target} (archive from ${archive.source})`);
    } catch (error) {
      failures += 1;
      stderr(`${pin.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures > 0 ? 1 : 0;
}

/**
 * A registry is up to date when it was built from the archive we expect, by this generator, and
 * is still valid: a file that was edited or damaged is built again.
 */
async function isUpToDate(path: string, expectedSha256: string): Promise<boolean> {
  let registry: Registry;
  try {
    registry = JSON.parse(await readFile(path, "utf8")) as Registry;
  } catch {
    return false;
  }
  const { source } = registry;
  return (
    source?.kind === "unece-directory" &&
    source.archives?.[0]?.sha256 === expectedSha256 &&
    source.generator?.name === GENERATOR.name &&
    source.generator.version === GENERATOR.version &&
    validateRegistry(registry).length === 0 &&
    checkRegistry(registry).length === 0
  );
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
