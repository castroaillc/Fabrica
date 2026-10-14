// Maps an agent call to Claude Agent SDK query options. Pure, so it can be tested without the SDK running.
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCall } from "./executor.js";

export function sdkQueryOptions(call: AgentCall): Options {
  const options: Options = {
    systemPrompt: call.agent.prompt,
    cwd: call.cwd,
    permissionMode: "dontAsk",
    // No filesystem settings: project settings resolve against cwd, which is the job branch's worktree, so its
    // CLAUDE.md, .claude/settings.json and hooks would let a job change its own reviewers. The agent file is the prompt.
    settingSources: [],
  };
  if (call.agent.tools !== undefined) {
    options.tools = [...call.agent.tools];
    options.allowedTools = [...call.agent.tools];
  }
  if (call.agent.model !== undefined) options.model = call.agent.model;
  if (call.resume !== undefined) options.resume = call.resume;
  return options;
}
