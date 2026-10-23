import { runService } from "@libredi/service-kit";
import { createServer, SERVICE } from "./server.ts";

await runService({ service: SERVICE, createServer });
