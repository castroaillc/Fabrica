// The process entry that bin/fabrica.js imports once tsx is registered.
import { sdkExecutor } from "@fabrica/runner";
import { main } from "./main.js";

// The first SIGINT or SIGTERM stops fabrica worker gracefully; a second one exits as usual.
// Other commands keep Node's default handling, so Ctrl-C still ends them at once.
const stop = new AbortController();
if (process.argv[2] === "worker") {
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
}

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  executor: sdkExecutor,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  databaseUrl: process.env.DATABASE_URL || undefined,
  signal: stop.signal,
});
