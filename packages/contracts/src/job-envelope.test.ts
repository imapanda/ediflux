import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadJson } from "./load.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const schema = loadJson("jsonschema/job-envelope.schema.json") as Record<string, unknown>;
const example = loadJson("jsonschema/examples/job-envelope.json") as Record<string, unknown>;
const validate = ajv.compile(schema);

const REQUIRED = ["schemaVersion", "type", "messageId", "environment", "enqueuedAt", "payload"];

describe("contracts/jsonschema/job-envelope.schema.json", () => {
  it("accepts the documented example", () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts any job type of the form domain.action with any object payload", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 2, maxLength: 4 }),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (segments, payload) => {
          expect(validate({ ...example, type: segments.join("."), payload })).toBe(true);
        },
      ),
    );
  });

  it.each(REQUIRED)("rejects an envelope without %s", (field) => {
    const { [field]: _removed, ...rest } = example;
    expect(validate(rest)).toBe(false);
  });

  it.each([
    ["an unknown schema version", { schemaVersion: 2 }],
    ["a job type without a dot", { type: "parse" }],
    ["a job type in upper case", { type: "Message.Parse" }],
    ["a message id that is not a UUID", { messageId: "123" }],
    ["an unknown environment", { environment: "staging" }],
    ["a timestamp that is not a date-time", { enqueuedAt: "yesterday" }],
    ["a payload that is not an object", { payload: "inline bytes" }],
  ])("rejects %s", (_label, override) => {
    expect(validate({ ...example, ...override })).toBe(false);
  });
});
