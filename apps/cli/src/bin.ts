// The process entry that bin/fabrica.js imports once tsx is registered.
import { dockerExecutor, dockerLauncher, sdkExecutor } from "@fabrica/runner";
import type { CliDeps } from "./main.js";
import { main } from "./main.js";

// FABRICA_RUNNER_MODE picks where agents run: on the host (the default) or in one Docker container per job.
function runnerMode(mode: string | undefined): Pick<CliDeps, "executor" | "teardown"> | null {
  if (mode === undefined || mode === "" || mode === "host") return { executor: sdkExecutor };
  if (mode !== "docker") return null;
  return dockerExecutor({ launcher: dockerLauncher(process.env), env: process.env });
}

// The first SIGINT or SIGTERM stops fabrica worker gracefully; a second one exits as usual.
// Other commands keep Node's default handling, so Ctrl-C still ends them at once.
const stop = new AbortController();
const mode = runnerMode(process.env.FABRICA_RUNNER_MODE);
if (mode === null) {
  process.stderr.write("fabrica: FABRICA_RUNNER_MODE must be host or docker\n");
  process.exitCode = 1;
} else {
  if (process.argv[2] === "worker") {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
  }
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    ...mode,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    databaseUrl: process.env.DATABASE_URL || undefined,
    signal: stop.signal,
  });
}
