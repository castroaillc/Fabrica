// Job state as stored in factory/jobs/<job-id>/job.json (see SKILL.md "job.json").
import type { Verdict } from "./contracts.js";

export const STAGES = ["spec", "build", "review", "approve", "merged", "pushed", "needs-human"] as const;
export type Stage = (typeof STAGES)[number];

export const REVIEWERS = ["security", "ux", "ui", "code"] as const;
export type Reviewer = (typeof REVIEWERS)[number];

export type ReviewStatus = "pending" | Verdict;
export type Reviews = Record<Reviewer, ReviewStatus>;

export interface JobState {
  id: string;
  feature: string;
  branch: string;
  worktree: string;
  stage: Stage;
  round: number;
  reviews: Reviews;
  // The git remote name to push the branch to instead of merging, for jobs run with --push.
  push?: string;
}
