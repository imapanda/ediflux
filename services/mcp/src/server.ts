import type { Server } from "node:http";
import { createHealthServer } from "@libredi/service-kit";

export const SERVICE = "mcp";

export function createServer(): Server {
  return createHealthServer({ service: SERVICE });
}
