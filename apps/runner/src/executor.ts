// The port the runner reaches agents through. sdkExecutor is the real one; tests pass a fake.
import type { AgentDefinition } from "@fabrica/core";

export interface AgentCall {
  agent: AgentDefinition;
  prompt: string;
  cwd: string;
  resume?: string;
}

export type AgentExecutor = (call: AgentCall) => Promise<{ sessionId: string }>;
