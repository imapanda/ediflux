import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { checkHealth, startService } from "./run.ts";

describe("startService", () => {
  it("listens, passes its own health check, then refuses connections once closed", async () => {
    const running = await startService({ service: "demo", port: 0, host: "127.0.0.1" });
    expect(running.port).toBeGreaterThan(0);
    expect(await checkHealth(running.port)).toBe(true);

    await running.close();
    expect(await checkHealth(running.port)).toBe(false);
  });

  it("serves the server it is given, not the default one", async () => {
    const custom = () =>
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("custom");
      });
    const running = await startService({
      service: "demo",
      createServer: custom,
      port: 0,
      host: "127.0.0.1",
    });
    const response = await fetch(`http://127.0.0.1:${running.port}/anything`);
    expect(await response.text()).toBe("custom");
    await running.close();
  });

  it("can be closed twice", async () => {
    const running = await startService({ service: "demo", port: 0, host: "127.0.0.1" });
    await running.close();
    await expect(running.close()).resolves.toBeUndefined();
  });
});

describe("checkHealth", () => {
  it("is false when nothing listens on the port", async () => {
    const running = await startService({ service: "demo", port: 0, host: "127.0.0.1" });
    const { port } = running;
    await running.close();
    expect(await checkHealth(port, "127.0.0.1", 500)).toBe(false);
  });
});
