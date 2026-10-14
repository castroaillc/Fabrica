import { describe, expect, it } from "vitest";
import { parseAgentFile } from "@fabrica/core";
import { sdkQueryOptions } from "./sdkOptions.js";

const BUILDER = `---
name: builder
description: Builds.
tools: Read, Grep, Glob, Bash, Edit, Write
model: opus
---

You build one factory job.
`;

describe("sdkQueryOptions", () => {
  it("maps an agent definition and resume to SDK options", () => {
    const agent = parseAgentFile(BUILDER);
    const tools = ["Read", "Grep", "Glob", "Bash", "Edit", "Write"];
    expect(sdkQueryOptions({ agent, prompt: "Go.", cwd: "/r/app-factory/003-x", resume: "s1" }, {})).toEqual({
      systemPrompt: "You build one factory job.\n",
      tools,
      allowedTools: tools,
      model: "opus",
      cwd: "/r/app-factory/003-x",
      resume: "s1",
      permissionMode: "dontAsk",
      settingSources: [],
    });
  });

  it("loads no filesystem settings, so the worktree's CLAUDE.md, settings and hooks never apply", () => {
    const agent = parseAgentFile(BUILDER);
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/r/app-factory/003-x" }, {});
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe("/r/app-factory/003-x");
    for (const key of ["settings", "additionalDirectories", "hooks"]) expect(key in options, key).toBe(false);
  });

  it("leaves out tools, allowedTools, model and resume when not given", () => {
    const agent = parseAgentFile("---\nname: plain\ndescription: Plain.\n---\nBody\n");
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w" }, {});
    expect(options).toEqual({
      systemPrompt: "Body\n",
      cwd: "/w",
      permissionMode: "dontAsk",
      settingSources: [],
    });
    for (const key of ["tools", "allowedTools", "model", "resume"]) expect(key in options, key).toBe(false);
  });

  it("replaces provider-selection variables in a copy of baseEnv with the provider's", () => {
    const agent = parseAgentFile(BUILDER);
    const baseEnv = { PATH: "/bin", ANTHROPIC_BASE_URL: "http://old", CLAUDE_CODE_USE_VERTEX: "1" };
    const before = { ...baseEnv };
    const provider = { type: "bedrock", region: "us-east-1" } as const;
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w", provider }, baseEnv);
    expect(options.env).toEqual({ PATH: "/bin", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" });
    expect(baseEnv).toEqual(before);
  });

  it("clears host Bedrock and Vertex routing and auth-skip variables for a configured role", () => {
    const agent = parseAgentFile(BUILDER);
    const baseEnv = {
      PATH: "/bin",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-proxy",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex-proxy",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
      CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
    };
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w", provider: { type: "anthropic" } }, baseEnv);
    expect(options.env).toEqual({ PATH: "/bin" });
  });

  it("points an anthropic-compatible provider at its base URL", () => {
    const agent = parseAgentFile(BUILDER);
    const provider = { type: "anthropic-compatible", base_url: "https://litellm:4000" } as const;
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w", provider }, { PATH: "/bin" });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe("https://litellm:4000");
  });

  it("uses the call's model over the agent's, and the agent's without one", () => {
    const agent = parseAgentFile(BUILDER);
    expect(sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w", model: "claude-opus-5-5" }, {}).model).toBe(
      "claude-opus-5-5",
    );
    expect(sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w" }, {}).model).toBe("opus");
  });

  it("leaves out env without a provider, so the SDK inherits process.env", () => {
    const agent = parseAgentFile(BUILDER);
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w", model: "m" }, { PATH: "/bin" });
    expect("env" in options).toBe(false);
  });
});
