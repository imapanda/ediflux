import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, readPort } from "./config.ts";

describe("readPort", () => {
  it("defaults to 8080 when PORT is missing or empty", () => {
    expect(DEFAULT_PORT).toBe(8080);
    expect(readPort({})).toBe(8080);
    expect(readPort({ PORT: "" })).toBe(8080);
  });

  it("reads any valid TCP port", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
        expect(readPort({ PORT: String(port) })).toBe(port);
      }),
    );
  });

  it("rejects ports outside 1..65535", () => {
    for (const bad of ["0", "65536", "99999"]) {
      expect(() => readPort({ PORT: bad })).toThrow(/PORT/);
    }
  });

  it("rejects near misses of a port number", () => {
    for (const bad of ["1e3", "0x50", "80.0", " 80", "80 ", "+80", "-80", "8080\n", "123456"]) {
      expect(() => readPort({ PORT: bad }), JSON.stringify(bad)).toThrow(/PORT/);
    }
  });

  it("rejects values that are not plain integers", () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => value !== "" && !/^\d{1,5}$/.test(value)),
        (value) => {
          expect(() => readPort({ PORT: value })).toThrow(/PORT/);
        },
      ),
    );
  });
});
