// The port the runner reaches agents through. sdkExecutor is the real one; tests pass a fake.
import type { AgentDefinition, ProviderConfig } from "@fabrica/core";

export interface AgentCall {
  agent: AgentDefinition;
  prompt: string;
  cwd: string;
  // The job this call belongs to and its folder, <repo>/factory/jobs/<id>/. sdkQueryOptions ignores both.
  jobId: string;
  jobFolder: string;
  resume?: string;
  // Set from the agent's role in fabrica.yaml; left out for roles it doesn't list.
  provider?: ProviderConfig;
  model?: string;
}

export type AgentExecutor = (call: AgentCall) => Promise<{ sessionId: string }>;
