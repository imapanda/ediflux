import { describe, expect, it } from "vitest";
import { type ValidationIssue, validate } from "./index.ts";
import { type ExpectedInvalid, expectedOf, readSample, samples } from "./testing/corpus.ts";
import { corpusRegistries } from "./testing/corpus-registry.ts";

const where = (issue: ValidationIssue) => ({
  segment: issue.position.segment,
  tag: issue.position.tag,
  element: issue.position.element,
  component: issue.position.component,
});

describe("valid samples, with the registries of the corpus", () => {
  it.each(samples("valid"))("%s has no error", (name) => {
    const report = validate(readSample("valid", name), { registries: corpusRegistries });
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // CONTRL is out of scope: it has no registry, and says so.
    const warnings = report.issues.map((issue) => issue.code);
    expect(warnings).toEqual(name.startsWith("contrl") ? ["MESSAGE_NOT_CHECKED"] : []);
  });
});

describe("invalid samples, with the registries of the corpus", () => {
  it.each(samples("invalid"))(
    "%s gives its expected error, with its position, and nothing else",
    (name) => {
      const { expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
      const report = validate(readSample("invalid", name), { registries: corpusRegistries });
      expect(report.issues.map((issue) => issue.code)).toEqual(expectedErrors.map((e) => e.code));
      expect(report.issues.map(where)).toEqual(expectedErrors.map((e) => e.position));
    },
  );
});
