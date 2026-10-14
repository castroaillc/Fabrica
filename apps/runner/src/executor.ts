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

// The port the runner runs fabrica.yaml's setup command through, once in each new worktree. hostSetup is the default;
// Docker mode runs it in the job's container.
export interface SetupRequest {
  command: readonly string[];
  cwd: string;
  jobId: string;
  jobFolder: string;
}

export interface SetupResult {
  ok: boolean;
  // stdout and stderr, each trimmed, joined by a newline when both are non-empty; the error when it could not start.
  output: string;
}

export type SetupRunner = (request: SetupRequest) => Promise<SetupResult>;

// Joins a finished process's output the way SetupResult.output says.
export function setupOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter((text) => text !== "").join("\n");
}
