import type { AddressInfo } from "node:net";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHealthServer } from "./health.ts";

const server = createHealthServer({ service: "demo" });
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

describe("GET /healthz", () => {
  it("answers 200 with the service name, uncached", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", service: "demo" });
  });

  it("ignores the query string", async () => {
    const response = await fetch(`${base}/healthz?probe=1`);
    expect(response.status).toBe(200);
  });

  it("answers HEAD with the headers of GET and no body", async () => {
    const get = await fetch(`${base}/healthz`);
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
  });

  it("rejects other methods with 405 and an Allow header", async () => {
    const response = await fetch(`${base}/healthz`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("any other path", () => {
  it("answers 404 as a problem document", async () => {
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
    });
  });

  it("answers 404 for every path except /healthz", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.webPath().filter((path) => path !== "/healthz" && path !== "/healthz/"),
        async (path) => {
          const response = await fetch(`${base}${path}`);
          expect(response.status).toBe(404);
        },
      ),
      { numRuns: 25 },
    );
  });
});
