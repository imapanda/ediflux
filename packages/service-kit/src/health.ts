import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HealthServerOptions {
  /** Name reported in the response, for example "api". */
  readonly service: string;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
  includeBody = true,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(includeBody ? body : undefined);
}

function sendProblem(response: ServerResponse, status: number, title: string): void {
  const body = JSON.stringify({ type: "about:blank", title, status });
  send(response, status, "application/problem+json; charset=utf-8", body);
}

/**
 * A server that only answers `GET /healthz`: liveness of the process.
 * Services replace or extend it with their own routes later.
 */
export function createHealthServer(options: HealthServerOptions): Server {
  const body = JSON.stringify({ status: "ok", service: options.service });

  const server = createServer(
    // Check timeouts every second: the default interval is 30 s.
    { connectionsCheckingInterval: 1_000 },
    (request: IncomingMessage, response: ServerResponse) => {
      const path = (request.url ?? "").split("?", 1)[0];
      if (path !== "/healthz") {
        sendProblem(response, 404, "Not Found");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        sendProblem(response, 405, "Method Not Allowed");
        return;
      }
      send(response, 200, "application/json; charset=utf-8", body, {}, request.method === "GET");
    },
  );

  // Health probes are tiny: drop slow or idle clients quickly.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
