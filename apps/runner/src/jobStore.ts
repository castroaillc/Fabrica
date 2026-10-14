// The port the runner persists job state through, so a restarted runner can drive a job on. store.ts is the Postgres one.
import type { Action, OrchestratorState } from "@fabrica/core";

export interface SavedJob {
  feature: string;
  state: OrchestratorState;
  // The event-producing actions whose events have not been applied yet.
  inFlight: Action[];
  // Builder SDK session ids by spawnAgent name.
  sessions: Record<string, string>;
}

export interface JobStore {
  load(repo: string, id: string): Promise<SavedJob | null>;
  // Inserts or updates the row's feature, state and in-flight actions. Sessions are left as they are.
  save(repo: string, id: string, saved: Omit<SavedJob, "sessions">): Promise<void>;
  saveSession(repo: string, id: string, name: string, sessionId: string): Promise<void>;
}
