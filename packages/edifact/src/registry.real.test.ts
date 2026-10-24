import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RegistryView, validate } from "./index.ts";
import { expectedOf, readSample, samples } from "./testing/corpus.ts";

/*
 * The valid samples against registries generated from the real UN/EDIFACT directories. These are
 * generated on the operator's machine and never committed (ADR 7), so the test runs only when the
 * paths are given:
 *
 *   LIBREDI_REGISTRIES=/path/to/d96a.json,/path/to/d01b.json pnpm --filter @libredi/edifact test
 *
 * (see docs/registry-generator.md for how to make them). The samples were written by hand from the
 * public structure of the messages and have never been checked against the directories: a sample
 * that fails here is a finding about the sample or about the registry, and the sample is the one
 * to fix.
 */

const paths = (process.env["LIBREDI_REGISTRIES"] ?? "").split(",").filter((path) => path !== "");

describe.skipIf(paths.length === 0)(
  "valid samples, with registries generated from the directories",
  () => {
    const registries = paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as RegistryView);

    it.each(samples("valid"))("%s has no error", (name) => {
      const { interchange } = expectedOf<{
        interchange: {
          messages: { type: string; version: string; release: string; agency: string }[];
        };
      }>("valid", name);
      const known = interchange.messages.every((message) =>
        registries.some(
          ({ directory, messages }) =>
            directory.agency === message.agency &&
            directory.version === message.version &&
            directory.release === message.release &&
            Object.hasOwn(messages, message.type),
        ),
      );
      const report = validate(readSample("valid", name), { registries });
      expect(
        report.issues.filter((issue) => issue.severity === "error"),
        known ? "checked" : "not checked",
      ).toEqual([]);
      if (!known) {
        expect(report.issues.map((issue) => issue.code)).toContain("MESSAGE_NOT_CHECKED");
      }
    });
  },
);
