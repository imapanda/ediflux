import type { Server } from "node:http";
import { createHealthServer } from "@libredi/service-kit";

export const SERVICE = "worker";

export function createServer(): Server {
  return createHealthServer({ service: SERVICE });
}
