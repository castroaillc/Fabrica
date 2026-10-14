// Parses agent definition files (.claude/agents/*.md): flat `key: value` frontmatter plus a prompt body.
// Takes file contents only; reading them from disk is the caller's job.

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  prompt: string;
}

export function parseAgentFile(content: string): AgentDefinition {
  const lines = content.split("\n");
  const isDelimiter = (line: string) => line.replace(/\r$/, "") === "---";
  if (!isDelimiter(lines[0] ?? "")) {
    throw new Error("Agent file must start with a --- frontmatter line");
  }
  const close = lines.findIndex((line, i) => i > 0 && isDelimiter(line));
  if (close === -1) {
    throw new Error("Agent file frontmatter has no closing --- line");
  }

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`Agent frontmatter line has no ":": ${line.trim()}`);
    }
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  const { name, description, tools, model } = fields;
  if (!name) throw new Error("Agent frontmatter is missing name");
  if (!description) throw new Error("Agent frontmatter is missing description");

  const agent: AgentDefinition = {
    name,
    description,
    prompt: lines
      .slice(close + 1)
      .join("\n")
      .replace(/^(?:[ \t]*\r?\n)+/, ""),
  };
  if (tools !== undefined) {
    agent.tools = tools
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool !== "");
  }
  if (model !== undefined) agent.model = model;
  return agent;
}

export function parseAgentDirectory(
  files: ReadonlyArray<{ fileName: string; content: string }>,
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  const sources: Record<string, string> = {};
  for (const { fileName, content } of files) {
    if (!fileName.endsWith(".md")) continue;
    let agent: AgentDefinition;
    try {
      agent = parseAgentFile(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${fileName}: ${message}`);
    }
    const existing = sources[agent.name];
    if (existing !== undefined) {
      throw new Error(`${fileName}: agent name "${agent.name}" is already declared by ${existing}`);
    }
    sources[agent.name] = fileName;
    agents[agent.name] = agent;
  }
  return agents;
}
