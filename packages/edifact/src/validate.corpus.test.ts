import { describe, expect, it } from "vitest";
import { type ValidationIssue, validate } from "./index.ts";
import { type ExpectedInvalid, expectedOf, readSample, samples } from "./testing/corpus.ts";

/** The layers that need no registry. */
const WITHOUT_REGISTRY = new Set(["tokenizer", "envelope"]);

const where = (issue: ValidationIssue) => ({
  segment: issue.position.segment,
  tag: issue.position.tag,
  element: issue.position.element,
  component: issue.position.component,
});

describe("valid samples", () => {
  it.each(samples("valid"))("%s has no issue", (name) => {
    const report = validate(readSample("valid", name));
    expect(report.issues).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.issueCount).toBe(0);
    expect(report.interchangeCount).toBe(1);
    expect(report.messageCount).toBeGreaterThan(0);
  });
});

describe("invalid samples that need no registry", () => {
  const names = samples("invalid").filter((name) =>
    WITHOUT_REGISTRY.has(expectedOf<ExpectedInvalid>("invalid", name).layer),
  );

  it("are all there", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it.each(names)("%s gives its expected error, with its position, and nothing else", (name) => {
    const { expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
    const report = validate(readSample("invalid", name));
    expect(report.issues.map((issue) => issue.code)).toEqual(expectedErrors.map((e) => e.code));
    expect(report.issues.map(where)).toEqual(expectedErrors.map((e) => e.position));
    expect(report.valid).toBe(false);
    for (const issue of report.issues) {
      expect(issue.severity).toBe("error");
      expect(issue.message.length).toBeGreaterThan(10);
      expect(issue.hint.length).toBeGreaterThan(10);
      expect(issue.message).toMatch(/[.!?]$/);
      expect(issue.line).toBeGreaterThanOrEqual(1);
      expect(issue.column).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("invalid samples that need a registry", () => {
  it.each(
    samples("invalid").filter(
      (name) => !WITHOUT_REGISTRY.has(expectedOf<ExpectedInvalid>("invalid", name).layer),
    ),
  )("%s is well formed as far as the envelope goes", (name) => {
    expect(validate(readSample("invalid", name)).issues).toEqual([]);
  });
});
