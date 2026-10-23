import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readPort } from "./config.ts";
import { createHealthServer } from "./health.ts";

export interface ServiceOptions {
  /** Name reported by /healthz and in logs, for example "api". */
  readonly service: string;
  /** Builds the HTTP server. Defaults to a server that only answers /healthz. */
  readonly createServer?: () => Server;
  /** Port to listen on; 0 picks a free one. Defaults to the PORT variable, then 8080. */
  readonly port?: number;
  /** Interface to listen on. Defaults to every interface (needed inside a container). */
  readonly host?: string;
}

export interface RunningService {
  readonly port: number;
  /** Stops accepting connections, lets requests in flight finish, then resolves. */
  close(): Promise<void>;
}

// Both stay below the 20 s stop grace period of compose.yaml, so a replica always gets to exit.
const FORCE_CLOSE_AFTER_MS = 8_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function listeningPort(server: Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the server is not listening on a TCP port");
  }
  return (address as AddressInfo).port;
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const server = options.createServer?.() ?? createHealthServer({ service: options.service });
  const port = options.port ?? readPort();
  const host = options.host ?? "0.0.0.0";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  return {
    port: listeningPort(server),
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS).unref();
      });
      return closing;
    },
  };
}

/** True when `GET /healthz` answers 200 in time. Used by the container HEALTHCHECK. */
export async function checkHealth(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function log(fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

/**
 * Entry point shared by every TypeScript service.
 *
 * - `main healthcheck` probes the local /healthz and exits 0 or 1 (container HEALTHCHECK).
 * - otherwise it serves until SIGTERM or SIGINT, then drains and exits 0.
 */
export async function runService(
  options: ServiceOptions,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv[0] === "healthcheck") {
    process.exitCode = (await checkHealth(options.port ?? readPort())) ? 0 : 1;
    return;
  }

  const running = await startService(options);
  log({ level: "info", msg: "listening", service: options.service, port: running.port });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    // `on`, not `once`: a repeated signal is ignored instead of killing the drain.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log({ level: "info", msg: "shutting down", service: options.service, signal });
    setTimeout(() => {
      log({ level: "error", msg: "shutdown timed out", service: options.service });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log({
          level: "error",
          msg: "shutdown failed",
          service: options.service,
          error: String(error),
        });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
