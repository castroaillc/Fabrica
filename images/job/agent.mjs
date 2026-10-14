// Runs one agent call inside a job container: reads {"prompt", "options"} from stdin and runs query() from the
// Agent SDK with the same rules as sdkExecutor in apps/runner/src/sdk.ts. The last stdout line is the result:
// {"sessionId":"..."} on success, or {"error":"..."} with a non-zero exit on failure.
import { query } from "@anthropic-ai/claude-agent-sdk";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function run() {
  const { prompt, options } = JSON.parse(await readStdin());
  let sessionId = "";
  let failure;
  for await (const message of query({ prompt, options })) {
    if (message.session_id) sessionId = message.session_id;
    if (message.type === "result") {
      if (message.subtype !== "success") failure = message.errors.join("\n") || message.subtype;
      else failure = message.is_error ? message.result : undefined;
    }
  }
  if (failure !== undefined) throw new Error(failure);
  if (sessionId === "") throw new Error("returned no session id");
  return sessionId;
}

try {
  const sessionId = await run();
  process.stdout.write(`\n${JSON.stringify({ sessionId })}\n`);
} catch (error) {
  process.stdout.write(`\n${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
