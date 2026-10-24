import { runCli } from "./cli.ts";

// Run with `node src/main.ts registry build [options]`. A future `libredi` program will hand the
// arguments that follow its name to `runCli` in the same way.
process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => console.info(line),
  stderr: (line) => console.error(line),
});
