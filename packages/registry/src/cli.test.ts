import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRegistry } from "./check.ts";
import { type CliContext, runCli } from "./cli.ts";
import { type FetchLike, sha256Hex } from "./download.ts";
import { GENERATOR } from "./generator.ts";
import { validateRegistry } from "./schema.ts";
import { fixtureArchive, fixturePin } from "./test-support/fixtures.ts";
import type { Registry } from "./types.ts";

const D01B = fixturePin("d01b");
const D96A = fixturePin("d96a");

let dir: string;
let out: string;
let offline: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "libredi-cli-"));
  out = join(dir, "registry");
  offline = join(dir, "archives");
  await mkdir(offline);
  await writeFile(join(offline, D01B.fileName), fixtureArchive("d01b"));
  await writeFile(join(offline, D96A.fileName), fixtureArchive("d96a"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string[];
  stderr: string[];
}

async function run(argv: string[], context: Partial<CliContext> = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runCli(argv, {
    env: {},
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    directories: [D96A, D01B],
    now: () => new Date("2030-01-01T00:00:00Z"),
    sleep: async () => {},
    ...context,
  });
  return { status, stdout, stderr };
}

const build = (...extra: string[]) => [
  "registry",
  "build",
  "--out",
  out,
  "--offline",
  offline,
  ...extra,
];
const read = async (name: string): Promise<Registry> =>
  JSON.parse(await readFile(join(out, name), "utf8")) as Registry;

describe("libredi registry build", () => {
  it("writes the registry of every directory in the output folder", async () => {
    const result = await run(build());
    expect(result.status).toBe(0);
    expect(result.stderr).toEqual([
      "Z01B: ODDITY is left out: it uses XZZ, which the directory does not define",
    ]);
    expect(result.stdout).toEqual([
      `Z96A: 1 messages written to ${join(out, "z96a.json")} (archive from offline)`,
      `Z01B: 1 messages written to ${join(out, "z01b.json")} (archive from offline)`,
    ]);
    expect((await readdir(out)).sort()).toEqual(["z01b.json", "z96a.json"]);
  });

  it("writes registries that follow the schema and whose references resolve", async () => {
    await run(build());
    for (const name of ["z01b.json", "z96a.json"]) {
      const registry = await read(name);
      expect(validateRegistry(registry)).toEqual([]);
      expect(checkRegistry(registry)).toEqual([]);
      expect(registry.source).toMatchObject({
        kind: "unece-directory",
        generator: GENERATOR,
        generatedAt: "2030-01-01T00:00:00.000Z",
      });
    }
  });

  it("leaves a registry that is up to date alone, and builds nothing", async () => {
    await run(build());
    const before = await readFile(join(out, "z01b.json"), "utf8");
    const modified = (await stat(join(out, "z01b.json"))).mtimeMs;

    const fetch = vi.fn<FetchLike>();
    const again = await run(["registry", "build", "--out", out], {
      fetch,
      now: () => new Date("2031-06-01T00:00:00Z"),
    });
    expect(again.status).toBe(0);
    expect(again.stderr).toEqual([]);
    expect(again.stdout).toEqual([
      `Z96A: up to date (${join(out, "z96a.json")})`,
      `Z01B: up to date (${join(out, "z01b.json")})`,
    ]);
    expect(await readFile(join(out, "z01b.json"), "utf8")).toBe(before);
    expect((await stat(join(out, "z01b.json"))).mtimeMs).toBe(modified);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds again with --force, from the cache or the folder, and rewrites the time", async () => {
    await run(build());
    const forced = await run(build("--force"), { now: () => new Date("2031-06-01T00:00:00Z") });
    expect(forced.status).toBe(0);
    expect(forced.stdout[0]).toContain("messages written");
    expect((await read("z01b.json")).source.generatedAt).toBe("2031-06-01T00:00:00.000Z");
  });

  it.each([
    [
      "it was built from another archive",
      (r: Registry) => {
        r.source.archives = [{ name: "x.zip", sha256: "0".repeat(64) }];
      },
    ],
    [
      "another version of the generator wrote it",
      (r: Registry) => {
        r.source.generator = { name: GENERATOR.name, version: "0.0.1" };
      },
    ],
    [
      "it was edited by hand and a reference no longer resolves",
      (r: Registry) => {
        delete r.dataElements["9002"];
      },
    ],
    [
      "it no longer follows the schema",
      (r: Registry) => {
        (r as unknown as Record<string, unknown>)["schemaVersion"] = 2;
      },
    ],
  ])("builds again when %s", async (_label, damage) => {
    await run(build());
    const registry = await read("z01b.json");
    damage(registry);
    await writeFile(join(out, "z01b.json"), JSON.stringify(registry));
    const result = await run(build("--directory", "Z01B"));
    expect(result.stdout[0]).toContain("messages written");
    expect(validateRegistry(await read("z01b.json"))).toEqual([]);
  });

  it("builds again when the file is not JSON", async () => {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "z01b.json"), "{ truncated");
    const result = await run(build("--directory", "z01b"));
    expect(result.stdout[0]).toContain("messages written");
  });

  it("builds only the directories asked for", async () => {
    const result = await run(build("--directory", "z96a"));
    expect(result.stdout).toHaveLength(1);
    expect(await readdir(out)).toEqual(["z96a.json"]);
  });

  it("leaves no temporary file behind", async () => {
    await run(build());
    expect((await readdir(out)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads the folders from the environment when the options are not given", async () => {
    const result = await run(["registry", "build", "--directory", "Z01B"], {
      env: { LIBREDI_REGISTRY_DIR: out, LIBREDI_REGISTRY_OFFLINE_DIR: offline },
    });
    expect(result.status).toBe(0);
    expect(await readdir(out)).toEqual(["z01b.json"]);
  });

  it("writes in the data folder of the user when no output folder is given", async () => {
    const data = join(dir, "data");
    const result = await run(["registry", "build", "--directory", "Z01B", "--offline", offline], {
      env: { XDG_DATA_HOME: data },
    });
    expect(result.status).toBe(0);
    expect(await readdir(join(data, "libredi", "registry"))).toContain("z01b.json");
  });

  it("downloads an archive that is not supplied, keeps it in the cache, and does not need it again", async () => {
    const archive = fixtureArchive("d01b");
    const fetch = vi.fn<FetchLike>(async () => new Response(archive, { status: 200 }));
    const first = await run(["registry", "build", "--out", out, "--directory", "Z01B"], { fetch });
    expect(first.stdout[0]).toContain("(archive from download)");
    expect(await readdir(join(out, ".downloads"))).toEqual([D01B.fileName]);

    const forced = await run(
      ["registry", "build", "--out", out, "--directory", "Z01B", "--force"],
      { fetch },
    );
    expect(forced.stdout[0]).toContain("(archive from cache)");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never uses the network in offline mode, and says which archive is missing", async () => {
    await rm(join(offline, D96A.fileName));
    const fetch = vi.fn<FetchLike>();
    const result = await run(build(), { fetch });
    expect(result.status).toBe(1);
    expect(result.stderr.join("\n")).toMatch(
      /Z96A: There is no file named z96a.zip in .*Download https:\/\/directory\.example\/z96a\.zip/,
    );
    expect(result.stdout).toHaveLength(1); // the other directory is still built
    expect(await readdir(out)).toEqual(["z01b.json"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a supplied archive with the wrong checksum, and writes nothing for it", async () => {
    await writeFile(join(offline, D01B.fileName), "tampered");
    const result = await run(build("--directory", "Z01B"));
    expect(result.status).toBe(1);
    expect(result.stderr[0]).toMatch(/^Z01B: Wrong checksum/);
    await expect(readdir(out)).resolves.toEqual([]);
  });

  it("accepts the checksum given on the command line for an archive UN/ECE replaced", async () => {
    // Bytes after the end of a ZIP archive are ignored by readers, which makes a new file with a new checksum.
    const replaced = Buffer.concat([fixtureArchive("d01b"), Buffer.from("padding")]);
    await writeFile(join(offline, D01B.fileName), replaced);

    const refused = await run(build("--directory", "Z01B"));
    expect(refused.status).toBe(1);
    expect(refused.stderr[0]).toMatch(/Wrong checksum/);

    const accepted = await run(
      build("--directory", "Z01B", "--sha256", `z01b=${sha256Hex(replaced)}`),
    );
    expect(accepted.status).toBe(0);
    expect((await read("z01b.json")).source.archives?.[0]?.sha256).toBe(sha256Hex(replaced));
  });

  it("prints the warnings of the build on the error output", async () => {
    // The fictitious D.01B directory holds a message that uses a segment nobody defines.
    const result = await run(build("--directory", "Z01B"));
    expect(result.status).toBe(0);
    expect(result.stderr).toEqual([
      "Z01B: ODDITY is left out: it uses XZZ, which the directory does not define",
    ]);
  });
});

describe("libredi registry build, wrong use", () => {
  it.each([
    [
      ["registry", "build", "--directory", "D99Z"],
      /unknown directory "D99Z" \(supported: Z96A, Z01B\)/,
    ],
    [["registry", "build", "--sha256", "Z01B=abc"], /--sha256 expects/],
    [["registry", "build", "--sha256", `D99Z=${"a".repeat(64)}`], /--sha256 expects/],
    [["registry", "build", "--nope"], /Unknown option/],
    [["registry", "build", "extra"], /Unexpected argument/],
    [["registry", "publish"], /unknown command "registry publish"/],
    [["something"], /unknown command/],
  ])("exits with 2 and the usage for %j", async (argv, message) => {
    const result = await run(argv);
    expect(result.status).toBe(2);
    expect(result.stderr.join("\n")).toMatch(message);
    expect(result.stderr.join("\n")).toContain("Usage: libredi registry build");
  });

  it("prints the usage and exits with 0 for --help, or with 2 for no argument", async () => {
    const help = await run(["registry", "build", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout.join("\n")).toContain("--offline <dir>");
    expect((await run(["--help"])).status).toBe(0);
    expect((await run([])).status).toBe(2);
  });
});
