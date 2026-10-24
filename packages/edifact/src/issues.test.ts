import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatIssue, ISSUE_CATALOGUE, ISSUE_CODES, isIssueCode, validate } from "./index.ts";
import { makeIssue } from "./issues.ts";
import { catalogueMarkdown } from "./testing/catalogue-doc.ts";
import { type ExpectedInvalid, expectedOf, samples } from "./testing/corpus.ts";

const DOC = fileURLToPath(new URL("../../../docs/validation-errors.md", import.meta.url));

describe("the catalogue", () => {
  it("has a code in capitals and underscores, a layer, a severity, and text for every entry", () => {
    expect(ISSUE_CODES.length).toBeGreaterThan(10);
    for (const code of ISSUE_CODES) {
      const info = ISSUE_CATALOGUE[code];
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
      expect(["tokenizer", "envelope", "structure", "element", "code"]).toContain(info.layer);
      expect(["error", "warning"]).toContain(info.severity);
      for (const text of [info.title, info.meaning, info.message, info.hint]) {
        expect(text.length).toBeGreaterThan(15);
        expect(text).toBe(text.trim());
      }
      expect(info.title).not.toMatch(/\.$/);
      expect(info.message).toMatch(/^[A-Z0-9{]/);
      expect(info.message).toMatch(/\.$/);
      expect(info.hint).toMatch(/^[A-Z]/);
      expect(info.hint).toMatch(/\.$/);
      expect(info.message.match(/\{[a-z]+\}/g) ?? []).toSatisfy((names: string[]) =>
        names.every((name) =>
          ["{expected}", "{found}", "{tag}", "{unit}", "{name}"].includes(name),
        ),
      );
    }
  });

  it("covers every code of the sample corpus", () => {
    const wanted = new Set<string>();
    for (const name of samples("invalid")) {
      for (const error of expectedOf<ExpectedInvalid>("invalid", name).expectedErrors) {
        wanted.add(error.code);
      }
    }
    expect(wanted.size).toBeGreaterThanOrEqual(16);
    for (const code of wanted) {
      expect(isIssueCode(code), code).toBe(true);
    }
  });

  it("is the page docs/validation-errors.md, which is written from it", () => {
    const written = catalogueMarkdown();
    if (process.env["LIBREDI_UPDATE_DOCS"] === "1") {
      writeFileSync(DOC, written);
    }
    expect(readFileSync(DOC, "utf8")).toBe(written);
  });
});

describe("an issue", () => {
  const at = () => ({ line: 3, column: 7 });

  it("fills the message of the catalogue with what the finder knows", () => {
    const issue = makeIssue(
      {
        code: "UNT_REFERENCE_MISMATCH",
        segment: 4,
        tag: "UNT",
        element: 2,
        expected: "1",
        found: "2",
        offset: 40,
      },
      at,
    );
    expect(issue.message).toBe("UNT closes message 2, but UNH opened message 1.");
    expect(issue).toMatchObject({
      severity: "error",
      layer: "envelope",
      line: 3,
      column: 7,
      offset: 40,
    });
    expect(issue.position).toEqual({
      segment: 4,
      tag: "UNT",
      element: 2,
      component: null,
      repetition: null,
    });
  });

  it("takes the message of the finder when it has a better one, and a layer or severity of its own", () => {
    const issue = makeIssue(
      {
        code: "MISSING_MANDATORY_ELEMENT",
        segment: 1,
        tag: "UNB",
        message: "Custom.",
        layer: "envelope",
        severity: "warning",
        offset: 0,
      },
      at,
    );
    expect(issue).toMatchObject({ message: "Custom.", layer: "envelope", severity: "warning" });
  });

  it("names the repetition and the component when there are some", () => {
    const issue = makeIssue(
      {
        code: "INVALID_DATA_TYPE",
        segment: 5,
        tag: "FTX",
        element: 4,
        repetition: 2,
        component: 1,
        offset: 0,
      },
      at,
    );
    expect(formatIssue(issue).split("\n")[0]).toBe(
      "error INVALID_DATA_TYPE at line 3, column 7 (segment 5 FTX, element 4, repetition 2, component 1)",
    );
  });

  it("never shows a placeholder, even when the finder knows nothing", () => {
    for (const code of ISSUE_CODES) {
      const issue = makeIssue({ code, segment: 1, tag: null, offset: 0 }, at);
      expect(issue.message, code).not.toMatch(/[{}]/);
      expect(issue.hint, code).not.toMatch(/[{}]/);
    }
  });

  it("is a block of three lines: where, what, what to do", () => {
    const [issue] = validate(new TextEncoder().encode("UNB+UNOA:9+A:1+B:1+1:1+R'")).issues;
    const lines = formatIssue(issue as NonNullable<typeof issue>).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "error UNSUPPORTED_SYNTAX_VERSION at line 1, column 10 (segment 1 UNB, element 1, component 2)",
    );
    expect(lines[1]).toBe("  UNB declares syntax version 9, which is not supported.");
    expect(lines[2]).toMatch(/^ {2}Hint: Use syntax version 3 or 4/);
  });
});
