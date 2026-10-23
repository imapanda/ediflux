// Runs the shared entry point as a real process: used by run.process.test.ts.
import { runService } from "../run.ts";

await runService({ service: "fixture" });
