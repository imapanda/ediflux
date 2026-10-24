import { describe, expect, it } from "vitest";
import {
  buildRegistry,
  buildRegistryFromArchive,
  RegistryBuildError,
  readDirectoryArchive,
} from "./build.ts";
import { checkRegistry } from "./check.ts";
import { sha256Hex } from "./download.ts";
import { validateRegistry } from "./schema.ts";
import { fixtureArchive, fixturePin, fixtureText, type Layout } from "./test-support/fixtures.ts";
import type { Registry } from "./types.ts";

const OPTIONS = {
  generator: { name: "@libredi/registry", version: "1.2.3" },
  generatedAt: "2030-01-01T00:00:00Z",
};

describe.each<Layout>(["d01b", "d96a"])("buildRegistryFromArchive, %s layout", (layout) => {
  const pin = fixturePin(layout);
  const archive = fixtureArchive(layout);
  const { registry, warnings } = buildRegistryFromArchive(archive, pin, OPTIONS);
  const d01b = layout === "d01b";

  it("builds a registry that follows the schema and whose references resolve", () => {
    expect(validateRegistry(registry)).toEqual([]);
    expect(checkRegistry(registry)).toEqual([]);
  });

  it("states which directory it describes and where it comes from", () => {
    expect(registry.directory).toEqual({ agency: "UN", version: "Z", release: pin.release });
    expect(registry.syntaxVersions).toEqual(pin.syntaxVersions);
    expect(registry.source).toEqual({
      kind: "unece-directory",
      archives: [{ name: pin.fileName, sha256: sha256Hex(archive) }],
      generator: OPTIONS.generator,
      generatedAt: OPTIONS.generatedAt,
    });
  });

  it("holds the definitions of the directory", () => {
    expect(Object.keys(registry.dataElements)).toEqual(
      expect.arrayContaining(["9001", "9002", "9004", "9008", "9010"]),
    );
    expect(Object.keys(registry.composites)).toEqual(["C901", "C902", "C904"]);
    expect(Object.keys(registry.segments)).toEqual([
      "UNS",
      "XDT",
      "XHD",
      "XLN",
      "XPT",
      "XQT",
      "XTT",
    ]);
    expect(registry.dataElements["9004"]).toMatchObject({ type: "n", minLength: 8, maxLength: 8 });
  });

  it("gives a data element the code list of its tag, when the list has codes", () => {
    expect(registry.dataElements["9001"]?.codeList).toBe("9001");
    expect(registry.codeLists["9001"]).toMatchObject({ closed: true });
    expect(registry.codeLists["9005"]?.codes["BU"]).toEqual({ name: "Buying party" });
    expect(registry.dataElements["9002"]).not.toHaveProperty("codeList");
    if (d01b) {
      // A list that is declared but empty (the values are agreed elsewhere) is not a code list.
      expect(registry.dataElements["9011"]).not.toHaveProperty("codeList");
      expect(registry.codeLists).not.toHaveProperty("9011");
    }
  });

  it("writes maxOccurs only when an element can repeat", () => {
    const party = registry.segments["XPT"]?.elements ?? [];
    expect(party[0]).toEqual({ ref: "9005", status: "M" });
    expect(party[2]).toEqual(
      d01b ? { ref: "9007", status: "C", maxOccurs: 3 } : { ref: "9007", status: "C" },
    );
  });

  it("describes the message and defines the section separator it uses", () => {
    expect(registry.messages["SAMPLE"]).toMatchObject({ name: "Fictitious sample message" });
    expect(registry.segments["UNS"]).toMatchObject({ elements: [{ ref: "0081", status: "M" }] });
    expect(registry.codeLists["0081"]?.codes).toHaveProperty("D");
  });

  it("is the same every time, with the keys of each map in order", () => {
    const again = buildRegistryFromArchive(fixtureArchive(layout), pin, OPTIONS).registry;
    expect(JSON.stringify(again)).toBe(JSON.stringify(registry));
    for (const map of [registry.composites, registry.segments, registry.messages]) {
      expect(Object.keys(map)).toEqual(Object.keys(map).sort());
    }
  });

  it(d01b ? "leaves out a message that uses a segment no file defines" : "reports nothing", () => {
    if (d01b) {
      expect(registry.messages).not.toHaveProperty("ODDITY");
      expect(warnings).toEqual([
        "ODDITY is left out: it uses XZZ, which the directory does not define",
      ]);
    } else {
      expect(warnings).toEqual([]);
    }
  });

  it("ignores the files that are not parts of the directory", () => {
    expect(Object.keys(registry.messages)).toEqual(["SAMPLE"]);
  });
});

describe("buildRegistry", () => {
  it("warns about a message of another version or release than the directory", () => {
    const pin = fixturePin("d01b");
    const texts = readDirectoryArchive(fixtureArchive("d01b"), pin);
    const warnings: string[] = [];
    buildRegistry(texts, { ...pin, version: "Y" }, { kind: "handwritten" }, (message) =>
      warnings.push(message),
    );
    expect(warnings).toContain("SAMPLE is Z 01B, not Y 01B");
  });

  it("warns about a code list of a data element that does not exist", () => {
    const pin = fixturePin("d01b");
    const texts = readDirectoryArchive(fixtureArchive("d01b"), pin);
    texts.codes.push(
      `Ä`.repeat(20) +
        "\n     9999  Unknown element  [C]\n\n     Repr: an..3\n\n     A     Some code\n",
    );
    const warnings: string[] = [];
    const registry = buildRegistry(texts, pin, { kind: "handwritten" }, (message) =>
      warnings.push(message),
    );
    expect(warnings).toContain("code list 9999 belongs to no data element");
    expect(registry.codeLists).not.toHaveProperty("9999");
  });
});

describe("readDirectoryArchive", () => {
  const pin = fixturePin("d96a");

  it("refuses an archive without one of the parts, naming it", () => {
    const wrong = { ...pin, parts: { ...pin.parts, elements: "NOPE" } };
    expect(() => readDirectoryArchive(fixtureArchive("d96a"), wrong)).toThrow(
      new RegistryBuildError("z96a.zip contains no NOPE.ZIP"),
    );
  });

  it("refuses a part without its file", () => {
    expect(() => readDirectoryArchive(fixtureArchive("d96a"), { ...pin, release: "99X" })).toThrow(
      /TRED.ZIP contains no TRED.99X/,
    );
  });

  it("refuses bytes that are not an archive", () => {
    expect(() => readDirectoryArchive(Buffer.from("<html>Forbidden</html>"), pin)).toThrow(/ZIP/);
  });
});

describe("buildRegistryFromArchive on a directory that does not hold together", () => {
  it("refuses it and lists what is wrong", () => {
    // The segments mention the composite C902, which this composite file no longer defines.
    const composites = fixtureText("d96a", "composites.txt");
    const cut = composites.slice(0, composites.indexOf("    * C902"));
    const rule = "Ä".repeat(36);
    const archive = fixtureArchive("d96a", {
      "composites.txt": `${cut}${composites.slice(composites.indexOf(`${rule}¿`, cut.length))}`
        .replace(/Ä/g, "─")
        .replace(/¿/g, "┐"),
    });
    const failure = () =>
      buildRegistryFromArchive(archive, fixturePin("d96a"), {
        ...OPTIONS,
        expectedSha256: sha256Hex(archive),
      });
    expect(failure).toThrow(RegistryBuildError);
    expect(failure).toThrow(
      /is not valid \(\d+ problems\)[\s\S]*\/segments\/XHD\/elements\/1\/ref: composite "C902" does not exist/,
    );
  });
});

describe("buildRegistryFromArchive on bytes it should not trust", () => {
  it("refuses an archive whose checksum is not the pinned one, before reading it", () => {
    const pin = fixturePin("d96a");
    expect(() => buildRegistryFromArchive(fixtureArchive("d01b"), pin, OPTIONS)).toThrow(
      new RegExp(`has SHA-256 [0-9a-f]{64}, not ${pin.sha256}`),
    );
  });

  it("keeps a bounded number of warnings, however many lines are unreadable", () => {
    const rule = "\u00c4".repeat(30);
    const junk = Array.from({ length: 1000 }, (_, index) => `0${index} what is this`).join("\n");
    const message = `${fixtureText("d96a", "message-sample.txt").split("Pos    Tag")[0]}Pos    Tag Name\n\n0010   XHD Example header   M   1\n${junk}\n${rule}`;
    const archive = fixtureArchive("d96a", {
      "message-sample.txt": message.replace(/\u00c4/g, "─"),
    });
    const { warnings } = buildRegistryFromArchive(archive, fixturePin("d96a"), {
      ...OPTIONS,
      expectedSha256: sha256Hex(archive),
    });
    expect(warnings).toHaveLength(201);
    expect(warnings[200]).toMatch(/^… and 8\d\d more warnings$/);
    expect(Math.max(...warnings.map((warning) => warning.length))).toBeLessThanOrEqual(300);
  });
});

describe("the registry built from the fixtures", () => {
  it("is accepted as the registry type", () => {
    const { registry } = buildRegistryFromArchive(
      fixtureArchive("d01b"),
      fixturePin("d01b"),
      OPTIONS,
    );
    const typed: Registry = registry;
    expect(typed.schemaVersion).toBe(1);
  });
});
