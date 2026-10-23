import type { Server } from "node:http";
import { createHealthServer } from "@libredi/service-kit";

export const SERVICE = "translator";

export function createServer(): Server {
  return createHealthServer({ service: SERVICE });
}
