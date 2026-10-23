import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkHealth } from "./run.ts";

const fixture = fileURLToPath(new URL("./fixtures/run-service.ts", import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (typeof address !== "object" || address === null) {
    throw new Error("no port");
  }
  return address.port;
}

function run(env: Record<string, string>, args: string[] = []) {
  const child = spawn(process.execPath, [fixture, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const listening = async (): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (!stdout.includes('"msg":"listening"')) {
      if (Date.now() > deadline) {
        throw new Error(`service did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { child, exit, listening, stderr: () => stderr };
}

describe("the service process", () => {
  it("serves /healthz, and stops with exit code 0 on SIGTERM", async () => {
    const port = await freePort();
    const service = run({ PORT: String(port) });
    await service.listening();
    expect(await checkHealth(port)).toBe(true);

    service.child.kill("SIGTERM");
    expect(await service.exit).toEqual({ code: 0, signal: null });
    expect(await checkHealth(port, "127.0.0.1", 500)).toBe(false);
  });

  it("ignores a second SIGTERM while it drains", async () => {
    const port = await freePort();
    const service = run({ PORT: String(port) });
    await service.listening();

    service.child.kill("SIGTERM");
    service.child.kill("SIGTERM");
    expect(await service.exit).toEqual({ code: 0, signal: null });
  });

  it("`healthcheck` exits 0 when the service answers and 1 when it does not", async () => {
    const port = await freePort();

    const down = run({ PORT: String(port) }, ["healthcheck"]);
    expect((await down.exit).code).toBe(1);

    const service = run({ PORT: String(port) });
    await service.listening();
    const up = run({ PORT: String(port) }, ["healthcheck"]);
    expect((await up.exit).code).toBe(0);
  });

  it("refuses to start with an invalid PORT", async () => {
    const service = run({ PORT: "not-a-port" });
    const { code } = await service.exit;
    expect(code).not.toBe(0);
    expect(service.stderr()).toMatch(/PORT must be an integer/);
  });
});
