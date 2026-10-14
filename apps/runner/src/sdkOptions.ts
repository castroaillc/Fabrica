// Maps an agent call to Claude Agent SDK query options. Pure, so it can be tested without the SDK running.
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { PROVIDER_ENV_KEYS, providerEnv } from "@fabrica/core";
import type { AgentCall } from "./executor.js";

export function sdkQueryOptions(call: AgentCall, baseEnv: Record<string, string | undefined>): Options {
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
  const model = call.model ?? call.agent.model;
  if (model !== undefined) options.model = model;
  if (call.resume !== undefined) options.resume = call.resume;
  // env replaces the subprocess environment, so it starts from baseEnv. Without a provider the SDK inherits process.env.
  if (call.provider !== undefined) {
    const env = { ...baseEnv };
    for (const key of PROVIDER_ENV_KEYS) delete env[key];
    options.env = { ...env, ...providerEnv(call.provider) };
  }
  return options;
}
