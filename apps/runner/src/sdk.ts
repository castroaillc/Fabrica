// The real AgentExecutor: one Claude Agent SDK query() per agent call.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExecutor } from "./executor.js";
import { sdkQueryOptions } from "./sdkOptions.js";

export const sdkExecutor: AgentExecutor = async (call) => {
  let sessionId = "";
  let failure: string | undefined;
  for await (const message of query({ prompt: call.prompt, options: sdkQueryOptions(call) })) {
    if (message.session_id) sessionId = message.session_id;
    if (message.type === "result") {
      if (message.subtype !== "success") failure = message.errors.join("\n") || message.subtype;
      else failure = message.is_error ? message.result : undefined;
    }
  }
  if (failure !== undefined) throw new Error(`${call.agent.name} ended with an error: ${failure}`);
  if (sessionId === "") throw new Error(`${call.agent.name} returned no session id`);
  return { sessionId };
};
