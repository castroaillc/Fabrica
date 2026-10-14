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
    expect(sdkQueryOptions({ agent, prompt: "Go.", cwd: "/r/app-factory/003-x", resume: "s1" })).toEqual({
      systemPrompt: "You build one factory job.\n",
      tools,
      allowedTools: tools,
      model: "opus",
      cwd: "/r/app-factory/003-x",
      resume: "s1",
      permissionMode: "dontAsk",
      settingSources: ["project"],
    });
  });

  it("leaves out tools, allowedTools, model and resume when not given", () => {
    const agent = parseAgentFile("---\nname: plain\ndescription: Plain.\n---\nBody\n");
    const options = sdkQueryOptions({ agent, prompt: "Go.", cwd: "/w" });
    expect(options).toEqual({
      systemPrompt: "Body\n",
      cwd: "/w",
      permissionMode: "dontAsk",
      settingSources: ["project"],
    });
    for (const key of ["tools", "allowedTools", "model", "resume"]) expect(key in options, key).toBe(false);
  });
});
