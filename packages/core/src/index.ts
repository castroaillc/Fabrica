// Shared types and pure logic for the Fabrica orchestrator. See docs/ROADMAP.md.
export { STAGES, REVIEWERS } from "./job.js";
export type { Stage, Reviewer, ReviewStatus, Reviews, JobState } from "./job.js";
export { parseVerdict, parseDecision, parseBuildStatus } from "./contracts.js";
export type { Verdict, Decision, BuildStatus } from "./contracts.js";
export { KNOWN_TOOLS, parseAgentFile, parseAgentDirectory } from "./agents.js";
export type { AgentDefinition } from "./agents.js";
export { PROVIDER_ENV_KEYS, parseFabricaConfig, providerEnv } from "./config.js";
export type { ProviderConfig, RoleConfig, FabricaConfig } from "./config.js";
export {
  jobPorts,
  nextJobNumber,
  nextReworkNumber,
  builderName,
  pathsSentence,
  specWriterPrompt,
  buildPrompt,
  reviewerPrompt,
  approverPrompt,
  resumeMessage,
  reworkPrompt,
} from "./prompts.js";
export type { AgentName, JobPorts } from "./prompts.js";
export { MAX_RESUMES, startJob, stateFromJob, transition } from "./orchestrator.js";
export type { Awaiting, OrchestratorState, Action, OrchestratorEvent, Transition } from "./orchestrator.js";
