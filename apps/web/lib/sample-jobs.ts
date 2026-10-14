export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  name: string;
  status: JobStatus;
  createdAt: string;
}

export const DEFAULT_RUNNER_URL = "http://localhost:4000";

// Placeholder data until the dashboard is wired to the runner service.
export const SAMPLE_JOBS: Job[] = [
  { id: "job-1042", name: "Build web bundle", status: "running", createdAt: "2026-10-14T09:42:00Z" },
  { id: "job-1041", name: "Run database migrations", status: "succeeded", createdAt: "2026-10-14T09:30:00Z" },
  { id: "job-1040", name: "Generate nightly report", status: "queued", createdAt: "2026-10-14T09:12:00Z" },
  { id: "job-1039", name: "Sync product catalog", status: "failed", createdAt: "2026-10-14T08:55:00Z" },
  { id: "job-1038", name: "Rebuild search index", status: "succeeded", createdAt: "2026-10-14T08:20:00Z" },
  { id: "job-1037", name: "Send weekly digest", status: "succeeded", createdAt: "2026-10-13T17:00:00Z" },
];
