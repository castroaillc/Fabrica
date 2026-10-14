// Maps an agent call to Claude Agent SDK query options. Pure, so it can be tested without the SDK running.
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCall } from "./executor.js";

export function sdkQueryOptions(call: AgentCall): Options {
  const options: Options = {
    systemPrompt: call.agent.prompt,
    cwd: call.cwd,
    permissionMode: "dontAsk",
    settingSources: ["project"],
  };
  if (call.agent.tools !== undefined) {
    options.tools = [...call.agent.tools];
    options.allowedTools = [...call.agent.tools];
  }
  if (call.agent.model !== undefined) options.model = call.agent.model;
  if (call.resume !== undefined) options.resume = call.resume;
  return options;
}
