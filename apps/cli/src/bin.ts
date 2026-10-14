// The process entry that bin/fabrica.js imports once tsx is registered.
import { sdkExecutor } from "@fabrica/runner";
import { main } from "./main.js";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  executor: sdkExecutor,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
