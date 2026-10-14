import { describe, expect, it } from "vitest";
import { REVIEWERS, STAGES } from "./index.js";
import type { JobState, Reviewer, Reviews, ReviewStatus, Stage } from "./index.js";

describe("job state", () => {
  it("lists stages and reviewers in SKILL.md order", () => {
    expect(STAGES).toEqual(["spec", "build", "review", "approve", "merged", "needs-human"]);
    expect(REVIEWERS).toEqual(["security", "ux", "ui", "code"]);
  });

  it("types the SKILL.md job.json example as a JobState", () => {
    // Copied from the "### job.json" section of .claude/skills/factory/SKILL.md.
    const json = `{ "id": "003-rate-limiting", "feature": "Rate limit the signup form",
  "branch": "factory/003-rate-limiting",
  "worktree": "/Users/you/code/my-app-factory/003-rate-limiting",
  "stage": "review", "round": 2,
  "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "pending", "code": "PASS" } }`;
    const job: JobState = JSON.parse(json) as JobState;
    expect(job.stage).toBe("review");
    expect(job.round).toBe(2);
    expect(job.reviews).toEqual({ security: "CHANGES", ux: "PASS", ui: "pending", code: "PASS" });
    expect(JSON.parse(JSON.stringify(job))).toEqual(JSON.parse(json));
  });

  it("accepts every stage and review status in a typed literal", () => {
    const status: ReviewStatus[] = ["pending", "PASS", "CHANGES"];
    const reviewer: Reviewer = "code";
    const reviews: Reviews = { security: "pending", ux: "pending", ui: "pending", code: "pending" };
    const stages: Stage[] = [...STAGES];
    const job: JobState = {
      id: "001-core-job-model",
      feature: "Core job model",
      branch: "factory/001-core-job-model",
      worktree: "/tmp/001-core-job-model",
      stage: "spec",
      round: 0,
      reviews,
    };
    expect(status).toHaveLength(3);
    expect(job.reviews[reviewer]).toBe("pending");
    expect(stages).toContain(job.stage);
  });
});
