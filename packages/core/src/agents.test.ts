import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAgentDirectory, parseAgentFile } from "./index.js";
import type { AgentDefinition } from "./index.js";

const agentsDir = new URL("../../../.claude/agents/", import.meta.url);

function readAgents(): { fileName: string; content: string }[] {
  return readdirSync(agentsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => ({ fileName, content: readFileSync(new URL(fileName, agentsDir), "utf8") }));
}

describe("parseAgentFile", () => {
  it("parses frontmatter and prompt body", () => {
    const agent = parseAgentFile(
      "---\nname: demo\ndescription: A demo: with a colon.\n\ntools: Read, , Bash ,\nmodel: sonnet\ncolor: blue\n---\n\n\nLine one.\n\n  Line two.\n",
    );
    expect(agent).toEqual<AgentDefinition>({
      name: "demo",
      description: "A demo: with a colon.",
      tools: ["Read", "Bash"],
      model: "sonnet",
      prompt: "Line one.\n\n  Line two.\n",
    });
  });

  it("leaves tools and model unset when absent", () => {
    const agent = parseAgentFile("---\nname: demo\ndescription: d\n---\nBody");
    expect(agent).toEqual({ name: "demo", description: "d", prompt: "Body" });
    expect("tools" in agent).toBe(false);
    expect("model" in agent).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const agent = parseAgentFile("---\r\nname: demo\r\ndescription: d\r\ntools: Read, Write\r\nmodel: opus\r\n---\r\n\r\nBody\r\n");
    expect(agent).toEqual({
      name: "demo",
      description: "d",
      tools: ["Read", "Write"],
      model: "opus",
      prompt: "Body\r\n",
    });
  });

  it("throws when the opening --- is missing", () => {
    expect(() => parseAgentFile("name: demo\ndescription: d\n---\nBody")).toThrow(/start with a ---/);
    expect(() => parseAgentFile("")).toThrow(/start with a ---/);
  });

  it("throws when the closing --- is missing", () => {
    expect(() => parseAgentFile("---\nname: demo\ndescription: d\nBody")).toThrow(/closing ---/);
  });

  it("throws when name is missing or empty", () => {
    expect(() => parseAgentFile("---\ndescription: d\n---\nBody")).toThrow(/missing name/);
    expect(() => parseAgentFile("---\nname:  \ndescription: d\n---\nBody")).toThrow(/missing name/);
  });

  it("throws when description is missing or empty", () => {
    expect(() => parseAgentFile("---\nname: demo\n---\nBody")).toThrow(/missing description/);
    expect(() => parseAgentFile("---\nname: demo\ndescription:\n---\nBody")).toThrow(/missing description/);
  });

  it("throws when a frontmatter line has no colon", () => {
    expect(() => parseAgentFile("---\nname: demo\ndescription: d\njunk\n---\nBody")).toThrow(/no ":": junk/);
  });

  it("parses the real builder agent", () => {
    const agent = parseAgentFile(readFileSync(new URL("builder.md", agentsDir), "utf8"));
    expect(agent.name).toBe("builder");
    expect(agent.model).toBe("opus");
    expect(agent.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);
    expect(agent.description.startsWith("Factory step 2.")).toBe(true);
    expect(agent.prompt.startsWith("You build one factory job.")).toBe(true);
    expect(agent.prompt.split("\n")).not.toContain("---");
    expect(agent.prompt).not.toMatch(/^(name|description|tools|model):/m);
  });
});

describe("parseAgentDirectory", () => {
  it("parses the 7 real agents keyed by name and ignores non-.md files", () => {
    const agents = parseAgentDirectory([...readAgents(), { fileName: "README.txt", content: "not an agent" }]);
    expect(Object.keys(agents).sort()).toEqual([
      "approver",
      "builder",
      "reviewer-code",
      "reviewer-security",
      "reviewer-ui",
      "reviewer-ux",
      "spec-writer",
    ]);
    const models = Object.fromEntries(Object.values(agents).map((agent) => [agent.name, agent.model]));
    expect(models).toEqual({
      approver: "opus",
      builder: "opus",
      "reviewer-code": "sonnet",
      "reviewer-security": "opus",
      "reviewer-ui": "sonnet",
      "reviewer-ux": "sonnet",
      "spec-writer": "opus",
    });
    const reviewTools = ["Read", "Grep", "Glob", "Bash", "Write"];
    for (const name of ["approver", "reviewer-code", "reviewer-security", "reviewer-ui", "reviewer-ux", "spec-writer"]) {
      expect(agents[name]?.tools).toEqual(reviewTools);
    }
    expect(agents.builder?.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);
  });

  it("keys by frontmatter name, not file name", () => {
    const agents = parseAgentDirectory([{ fileName: "x.md", content: "---\nname: y\ndescription: d\n---\nBody" }]);
    expect(Object.keys(agents)).toEqual(["y"]);
  });

  it("rejects duplicate names with the file name", () => {
    const content = "---\nname: dup\ndescription: d\n---\nBody";
    expect(() =>
      parseAgentDirectory([
        { fileName: "a.md", content },
        { fileName: "b.md", content },
      ]),
    ).toThrow(/b\.md.*"dup".*a\.md/);
  });

  it("includes the file name when a file fails to parse", () => {
    expect(() => parseAgentDirectory([{ fileName: "broken.md", content: "no frontmatter" }])).toThrow(
      /broken\.md: .*start with a ---/,
    );
  });
});
