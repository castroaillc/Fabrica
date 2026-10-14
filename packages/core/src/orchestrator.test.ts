import { describe, expect, it } from "vitest";
import {
  MAX_RESUMES,
  REVIEWERS,
  jobPorts,
  nextJobNumber,
  nextReworkNumber,
  startJob,
  stateFromJob,
  transition,
} from "./index.js";
import type { Action, AgentName, JobState, OrchestratorEvent, OrchestratorState, Reviewer, Verdict } from "./index.js";

type Step = { state: OrchestratorState; actions: Action[] };

const REPO = "/r/app";
const PATHS = "Job folder: /r/app/factory/jobs/002-x/. Worktree: /r/app-factory/002-x. Branch: factory/002-x.";
const ALL_PASS: Record<Reviewer, Verdict> = { security: "PASS", ux: "PASS", ui: "PASS", code: "PASS" };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Runs one transition on a frozen input and checks the job.json discipline on every step.
function step(from: Step, event: OrchestratorEvent): Step {
  const before = structuredClone(from.state);
  const result = transition(deepFreeze(from.state), event);
  expect(from.state).toEqual(before);
  const writes = result.actions.filter((a) => a.type === "writeJob");
  if (JSON.stringify(result.state.job) !== JSON.stringify(from.state.job)) {
    expect(writes.length).toBeGreaterThan(0);
  }
  const last = writes.at(-1);
  if (last) expect(last.job).toEqual(result.state.job);
  return result;
}

function done(agent: AgentName, content: string | null): OrchestratorEvent {
  return { type: "agentDone", agent, content };
}

function review(reviewer: Reviewer, verdict: Verdict): OrchestratorEvent {
  return done(`reviewer-${reviewer}`, `VERDICT: ${verdict}\n\n## Findings`);
}

function types(actions: Action[]): string[] {
  return actions.map((a) => a.type);
}

function notes(actions: Action[]): string[] {
  return actions.flatMap((a) => (a.type === "notify" ? [a.message] : []));
}

function start(): Step {
  return startJob({ id: "002-x", feature: "Do X", repo: REPO });
}

function building(): Step {
  let t = step(start(), { type: "worktreeCreated", ok: true });
  t = step(t, done("spec-writer", "# Spec"));
  return t;
}

function reviewing(): Step {
  return step(building(), done("builder", "STATUS: READY\n\n# Build"));
}

function runRound(t: Step, verdicts: Record<Reviewer, Verdict>): Step {
  for (const reviewer of REVIEWERS) t = step(t, review(reviewer, verdicts[reviewer]));
  return t;
}

function approving(): Step {
  return runRound(reviewing(), ALL_PASS);
}

function merging(): Step {
  return step(approving(), done("approver", "APPROVE\n\nShip it."));
}

function needsHumanJob(round: number): OrchestratorState {
  const job: JobState = {
    id: "002-x",
    feature: "Do X",
    branch: "factory/002-x",
    worktree: "/r/app-factory/002-x",
    stage: "needs-human",
    round,
    reviews: { security: "CHANGES", ux: "PASS", ui: "PASS", code: "CHANGES" },
  };
  return stateFromJob(job, REPO);
}

function expectStopped(from: Step, t: Step): void {
  expect(t.state.awaiting).toBe("nothing");
  expect(t.state.job).toEqual(from.state.job);
  expect(types(t.actions)).toEqual(["notify"]);
  expect(notes(t.actions)[0]).toContain("002-x");
}

describe("jobPorts, nextJobNumber, nextReworkNumber", () => {
  it("computes per-job ports from the job number", () => {
    expect(jobPorts("003-rate-limiting")).toEqual({ builder: 5130, ux: 5131, ui: 5132 });
    expect(jobPorts("002-orchestrator-state-machine")).toEqual({ builder: 5120, ux: 5121, ui: 5122 });
    expect(jobPorts("010-y")).toEqual({ builder: 5200, ux: 5201, ui: 5202 });
  });

  it("picks the next job number", () => {
    expect(nextJobNumber([])).toBe("001");
    expect(nextJobNumber(["001-a", "004-b", "notes"])).toBe("005");
    expect(nextJobNumber(["notes", "12-a", "abc-d"])).toBe("001");
    expect(nextJobNumber(["009-a"])).toBe("010");
  });

  it("picks the next rework number", () => {
    expect(nextReworkNumber(["rework-1.md", "rework-2.md", "spec.md"])).toBe(3);
    expect(nextReworkNumber([])).toBe(1);
    expect(nextReworkNumber(["rework-10.md", "rework-3.md", "rework-x.md"])).toBe(11);
  });

  it("exports MAX_RESUMES from SKILL.md", () => {
    expect(MAX_RESUMES).toBe(2);
  });
});

describe("happy path", () => {
  it("starts a job with job.json then the worktree", () => {
    const t = start();
    expect(t.state).toEqual({
      repo: REPO,
      resumes: 0,
      awaiting: "worktree",
      job: {
        id: "002-x",
        feature: "Do X",
        branch: "factory/002-x",
        worktree: "/r/app-factory/002-x",
        stage: "spec",
        round: 0,
        reviews: { security: "pending", ux: "pending", ui: "pending", code: "pending" },
      },
    });
    expect(t.actions).toEqual([
      { type: "writeJob", job: t.state.job },
      { type: "createWorktree", branch: "factory/002-x", worktree: "/r/app-factory/002-x" },
    ]);
  });

  it("runs start → merged with the exact prompts, ports and action order", () => {
    let t = step(start(), { type: "worktreeCreated", ok: true });
    expect(t.state.awaiting).toBe("spec-writer");
    expect(t.actions[0]).toEqual({ type: "spawnAgent", agent: "spec-writer", prompt: `${PATHS} Feature: Do X` });
    expect(t.actions[0]).toEqual({
      type: "spawnAgent",
      agent: "spec-writer",
      prompt: "Job folder: /r/app/factory/jobs/002-x/. Worktree: /r/app-factory/002-x. Branch: factory/002-x. Feature: Do X",
    });

    t = step(t, done("spec-writer", "# Spec"));
    expect(t.state.awaiting).toBe("builder");
    expect(t.state.job.stage).toBe("build");
    expect(types(t.actions)).toEqual(["writeJob", "spawnAgent", "notify"]);
    expect(t.actions[1]).toEqual({
      type: "spawnAgent",
      agent: "builder",
      name: "builder-002-x",
      prompt: `${PATHS} Build round 1. Port: 5120.`,
    });

    t = step(t, done("builder", "STATUS: READY\n\n# Build"));
    expect(t.state.awaiting).toBe("reviewers");
    expect(t.state.job).toMatchObject({
      stage: "review",
      round: 1,
      reviews: { security: "pending", ux: "pending", ui: "pending", code: "pending" },
    });
    expect(t.actions).toEqual([
      { type: "writeJob", job: t.state.job },
      { type: "createDir", path: "/r/app/factory/jobs/002-x/round-1/" },
      { type: "spawnAgent", agent: "reviewer-security", prompt: `${PATHS} Review round 1.` },
      { type: "spawnAgent", agent: "reviewer-ux", prompt: `${PATHS} Review round 1. Port: 5121.` },
      { type: "spawnAgent", agent: "reviewer-ui", prompt: `${PATHS} Review round 1. Port: 5122.` },
      { type: "spawnAgent", agent: "reviewer-code", prompt: `${PATHS} Review round 1.` },
      { type: "notify", message: expect.stringContaining("002-x") },
    ]);

    t = runRound(t, ALL_PASS);
    expect(t.state.awaiting).toBe("approver");
    expect(t.state.job.stage).toBe("approve");
    expect(types(t.actions)).toEqual(["writeJob", "notify", "writeJob", "spawnAgent", "notify"]);
    expect(t.actions[3]).toEqual({ type: "spawnAgent", agent: "approver", prompt: `${PATHS} Final round: 1.` });

    t = step(t, done("approver", "APPROVE\n\nShip it."));
    expect(t.state.awaiting).toBe("main-checkout");
    expect(t.state.job.stage).toBe("approve");
    expect(t.actions.at(-1)).toEqual({ type: "checkMainCheckout" });

    t = step(t, { type: "mainCheckout", porcelain: "", branch: "main" });
    expect(t.state.awaiting).toBe("merge");
    expect(t.actions).toEqual([{ type: "merge", branch: "factory/002-x", message: "Merge factory/002-x" }]);

    t = step(t, { type: "mergeDone", ok: true });
    expect(t.state.awaiting).toBe("worktree-remove");
    expect(t.state.job.stage).toBe("approve");
    expect(t.actions).toEqual([{ type: "removeWorktree", worktree: "/r/app-factory/002-x" }]);

    t = step(t, { type: "worktreeRemoved", ok: true, output: "" });
    expect(t.state.awaiting).toBe("nothing");
    expect(t.state.job.stage).toBe("merged");
    expect(types(t.actions)).toEqual(["deleteBranch", "writeJob", "notify"]);
    expect(t.actions[0]).toEqual({ type: "deleteBranch", branch: "factory/002-x" });
    expect(notes(t.actions)[0]).toContain("002-x");
    expect(notes(t.actions)[0]).toContain("merged");
  });

  it("never pushes", () => {
    const all = [start(), building(), reviewing(), approving(), merging()].flatMap((t) => types(t.actions));
    expect(all.some((type) => type.toLowerCase().includes("push"))).toBe(false);
  });
});

describe("build check and file errors", () => {
  it("sends a BLOCKED first build to a human, quoting build.md", () => {
    const blocked = "STATUS: BLOCKED\n\n## Blocked\nThe spec contradicts itself.";
    const t = step(building(), done("builder", blocked));
    expect(t.state.awaiting).toBe("nothing");
    expect(t.state.job.stage).toBe("needs-human");
    expect(types(t.actions)).toEqual(["writeJob", "notify"]);
    const note = notes(t.actions)[0];
    expect(note).toContain("002-x");
    expect(note).toContain("/r/app-factory/002-x");
    expect(note).toContain(blocked);
  });

  it("stops on a failed worktree setup", () => {
    const from = start();
    const t = step(from, { type: "worktreeCreated", ok: false, error: "pnpm install failed" });
    expectStopped(from, t);
    expect(t.state.job.stage).toBe("spec");
    expect(notes(t.actions)[0]).toContain("pnpm install failed");
  });

  it("stops on a missing spec.md", () => {
    const from = step(start(), { type: "worktreeCreated", ok: true });
    expectStopped(from, step(from, done("spec-writer", null)));
  });

  it("stops on a missing or invalid build.md", () => {
    const from = building();
    expectStopped(from, step(from, done("builder", null)));
    expectStopped(from, step(from, done("builder", "oops")));
  });

  it("stops on a missing or invalid review file", () => {
    const from = reviewing();
    expectStopped(from, step(from, done("reviewer-ux", null)));
    expectStopped(from, step(from, done("reviewer-ux", "LGTM")));
  });

  it("stops on a missing or invalid decision.md", () => {
    const from = approving();
    expectStopped(from, step(from, done("approver", null)));
    expectStopped(from, step(from, done("approver", "Approve")));
  });

  it("decides nothing after a reviewer error stops the round", () => {
    let t = step(reviewing(), review("security", "PASS"));
    t = step(t, done("reviewer-ui", "LGTM"));
    expect(t.state.awaiting).toBe("nothing");
    expect(() => transition(t.state, review("ux", "PASS"))).toThrow();
  });
});

describe("WAIT FOR ALL", () => {
  it("records verdicts as they land and decides only after the fourth", () => {
    let t = reviewing();
    const order: [Reviewer, Verdict][] = [
      ["code", "PASS"],
      ["ui", "CHANGES"],
      ["security", "PASS"],
    ];
    for (const [reviewer, verdict] of order) {
      t = step(t, review(reviewer, verdict));
      expect(t.state.awaiting).toBe("reviewers");
      expect(t.state.job.reviews[reviewer]).toBe(verdict);
      expect(types(t.actions)).toEqual(["writeJob", "notify"]);
      expect(notes(t.actions)[0]).toContain("002-x");
    }
    expect(t.state.job.reviews).toEqual({ security: "PASS", ux: "pending", ui: "CHANGES", code: "PASS" });
    expect(() => transition(t.state, review("ui", "PASS"))).toThrow(/already reported/);
    expect(() => transition(t.state, review("code", "PASS"))).toThrow(/already reported/);

    t = step(t, review("ux", "PASS"));
    expect(types(t.actions)).toEqual(["writeJob", "notify", "writeJob", "resumeBuilder", "notify"]);
    expect(t.state.awaiting).toBe("builder");
  });
});

describe("review decisions", () => {
  it("resumes the builder on CHANGES, then approves after a PASS round", () => {
    let t = runRound(reviewing(), { security: "PASS", ux: "CHANGES", ui: "PASS", code: "PASS" });
    expect(t.state.job.stage).toBe("build");
    expect(t.state.resumes).toBe(1);
    expect(t.state.awaiting).toBe("builder");
    const decision = t.actions.slice(2);
    expect(decision).toEqual([
      { type: "writeJob", job: t.state.job },
      {
        type: "resumeBuilder",
        name: "builder-002-x",
        message:
          "Round 1 reviews are in factory/jobs/002-x/round-1/. Address every review with VERDICT: CHANGES, commit, and update build.md for round 2.",
      },
      { type: "notify", message: expect.stringContaining("002-x") },
    ]);
    expect(notes(decision)[0]).toContain("ux CHANGES");

    t = step(t, done("builder", "STATUS: READY\n\n# Build"));
    expect(t.state.job.round).toBe(2);
    expect(t.state.job.reviews).toEqual({ security: "pending", ux: "pending", ui: "pending", code: "pending" });
    expect(t.actions[1]).toEqual({ type: "createDir", path: "/r/app/factory/jobs/002-x/round-2/" });
    expect(t.actions[3]).toEqual({ type: "spawnAgent", agent: "reviewer-ux", prompt: `${PATHS} Review round 2. Port: 5121.` });

    t = runRound(t, ALL_PASS);
    expect(t.state.awaiting).toBe("approver");
    expect(t.actions[3]).toEqual({ type: "spawnAgent", agent: "approver", prompt: `${PATHS} Final round: 2.` });
  });

  it("escalates after round 3 with the exact decision.md", () => {
    let t = runRound(reviewing(), { security: "CHANGES", ux: "PASS", ui: "PASS", code: "PASS" });
    expect(t.state.resumes).toBe(1);
    t = step(t, done("builder", "STATUS: READY"));
    t = runRound(t, { security: "PASS", ux: "PASS", ui: "CHANGES", code: "PASS" });
    expect(t.state.resumes).toBe(2);
    expect(t.actions.find((a) => a.type === "resumeBuilder")).toMatchObject({
      message: expect.stringContaining("Round 2 reviews are in factory/jobs/002-x/round-2/"),
    });
    t = step(t, done("builder", "STATUS: READY"));
    expect(t.state.job.round).toBe(3);
    t = runRound(t, { security: "CHANGES", ux: "PASS", ui: "PASS", code: "CHANGES" });

    const content = "ESCALATE\n\nReview rounds exhausted. Outstanding CHANGES in round-3/ from: security, code.\n";
    expect(t.actions.slice(2)).toEqual([
      { type: "writeFile", path: "/r/app/factory/jobs/002-x/decision.md", content },
      { type: "writeJob", job: t.state.job },
      { type: "notify", message: expect.stringContaining(content) },
    ]);
    expect(types(t.actions)).not.toContain("resumeBuilder");
    expect(t.state.job.stage).toBe("needs-human");
    expect(t.state.awaiting).toBe("nothing");
    expect(notes(t.actions).at(-1)).toContain("/r/app-factory/002-x");
    expect(() => transition(t.state, done("builder", "STATUS: READY"))).toThrow();
  });

  it("sends an approver ESCALATE to a human, quoting decision.md", () => {
    const t = step(approving(), done("approver", "ESCALATE\n\nreason"));
    expect(t.state.job.stage).toBe("needs-human");
    expect(t.state.awaiting).toBe("nothing");
    expect(types(t.actions)).toEqual(["writeJob", "notify"]);
    const note = notes(t.actions)[0];
    expect(note).toContain("002-x");
    expect(note).toContain("/r/app-factory/002-x");
    expect(note).toContain("reason");
  });
});

describe("merge", () => {
  it("hands a busy main checkout to a human", () => {
    for (const checkout of [
      { porcelain: " M src/a.ts", branch: "main" },
      { porcelain: "", branch: "dev" },
    ]) {
      const t = step(merging(), { type: "mainCheckout", ...checkout });
      expect(t.state.job.stage).toBe("needs-human");
      expect(t.state.awaiting).toBe("nothing");
      expect(types(t.actions)).toEqual(["writeJob", "notify"]);
      expect(notes(t.actions)[0]).toContain("/factory approve 002-x");
    }
  });

  it("treats a whitespace-only porcelain as clean", () => {
    const t = step(merging(), { type: "mainCheckout", porcelain: "\n", branch: "main" });
    expect(types(t.actions)).toEqual(["merge"]);
  });

  it("aborts a failed merge only when one is in progress", () => {
    const from = step(merging(), { type: "mainCheckout", porcelain: "", branch: "main" });
    let t = step(from, { type: "mergeDone", ok: false, error: "CONFLICT in src/a.ts", inProgress: true });
    expect(types(t.actions)).toEqual(["abortMerge", "writeJob", "notify"]);
    expect(t.state.job.stage).toBe("needs-human");
    expect(t.state.awaiting).toBe("nothing");
    expect(notes(t.actions)[0]).toContain("CONFLICT in src/a.ts");

    t = step(from, { type: "mergeDone", ok: false, error: "not something we can merge", inProgress: false });
    expect(types(t.actions)).toEqual(["writeJob", "notify"]);
    expect(t.state.job.stage).toBe("needs-human");
    expect(notes(t.actions)[0]).toContain("not something we can merge");
  });

  it("still marks the job merged when the worktree remove fails", () => {
    let t = step(merging(), { type: "mainCheckout", porcelain: "", branch: "main" });
    t = step(t, { type: "mergeDone", ok: true });
    t = step(t, { type: "worktreeRemoved", ok: false, output: "fatal: contains modified files" });
    expect(t.state.job.stage).toBe("merged");
    expect(t.state.awaiting).toBe("nothing");
    expect(types(t.actions)).toEqual(["writeJob", "notify"]);
    expect(notes(t.actions)[0]).toContain("fatal: contains modified files");
  });
});

describe("commands", () => {
  it("/factory approve merges a needs-human job", () => {
    let t = step({ state: needsHumanJob(2), actions: [] }, { type: "approve" });
    expect(t.state.awaiting).toBe("main-checkout");
    expect(t.state.job.stage).toBe("needs-human");
    expect(t.actions.at(-1)).toEqual({ type: "checkMainCheckout" });
    t = step(t, { type: "mainCheckout", porcelain: "", branch: "main" });
    t = step(t, { type: "mergeDone", ok: true });
    t = step(t, { type: "worktreeRemoved", ok: true, output: "" });
    expect(t.state.job.stage).toBe("merged");
  });

  it("stateFromJob starts with no resumes and nothing awaited", () => {
    const state = needsHumanJob(1);
    expect(state.resumes).toBe(0);
    expect(state.awaiting).toBe("nothing");
    expect(state.repo).toBe(REPO);
  });

  it("/factory approve or rework on a job outside needs-human only notifies", () => {
    const from = reviewing();
    for (const event of [{ type: "approve" }, { type: "rework", note: "fix copy", k: 1 }] as OrchestratorEvent[]) {
      const t = transition(from.state, event);
      expect(t.state).toEqual(from.state);
      expect(types(t.actions)).toEqual(["notify"]);
      expect(notes(t.actions)[0]).toContain("needs-human");
    }
  });

  it("/factory rework spawns a fresh builder with a fresh MAX_RESUMES and continues the round numbering", () => {
    let t = step({ state: needsHumanJob(3), actions: [] }, { type: "rework", note: "fix copy", k: 2 });
    expect(t.state.job.stage).toBe("build");
    expect(t.state.resumes).toBe(0);
    expect(t.state.awaiting).toBe("builder");
    expect(t.actions.slice(0, 3)).toEqual([
      { type: "writeFile", path: "/r/app/factory/jobs/002-x/rework-2.md", content: "fix copy" },
      { type: "writeJob", job: t.state.job },
      {
        type: "spawnAgent",
        agent: "builder",
        name: "builder-002-x",
        prompt: `${PATHS} Rework: read rework-2.md and address it, then update build.md for round 4. Port: 5120.`,
      },
    ]);

    t = step(t, done("builder", "STATUS: READY"));
    expect(t.state.job.round).toBe(4);
    expect(t.actions[1]).toEqual({ type: "createDir", path: "/r/app/factory/jobs/002-x/round-4/" });
    const changes: Record<Reviewer, Verdict> = { security: "PASS", ux: "PASS", ui: "PASS", code: "CHANGES" };
    t = runRound(t, changes);
    expect(types(t.actions)).toContain("resumeBuilder");
    t = step(t, done("builder", "STATUS: READY"));
    expect(t.state.job.round).toBe(5);
    t = runRound(t, changes);
    expect(types(t.actions)).toContain("resumeBuilder");
    t = step(t, done("builder", "STATUS: READY"));
    expect(t.state.job.round).toBe(6);
    t = runRound(t, changes);
    expect(types(t.actions)).not.toContain("resumeBuilder");
    expect(t.actions.find((a) => a.type === "writeFile")).toEqual({
      type: "writeFile",
      path: "/r/app/factory/jobs/002-x/decision.md",
      content: "ESCALATE\n\nReview rounds exhausted. Outstanding CHANGES in round-6/ from: code.\n",
    });
    expect(t.state.job.stage).toBe("needs-human");
  });
});

describe("unexpected events", () => {
  it("throws for events that do not match what the machine awaits", () => {
    expect(() => transition(reviewing().state, done("approver", "APPROVE"))).toThrow(/awaiting reviewers/);
    expect(() => transition(reviewing().state, done("builder", "STATUS: READY"))).toThrow();
    expect(() => transition(building().state, review("security", "PASS"))).toThrow();
    expect(() => transition(start().state, done("spec-writer", "# Spec"))).toThrow();
    expect(() => transition(needsHumanJob(1), { type: "mergeDone", ok: true })).toThrow(/awaiting nothing/);
    expect(() => transition(needsHumanJob(1), { type: "worktreeCreated", ok: true })).toThrow();
  });

  it("does not mutate its input", () => {
    const state = deepFreeze(reviewing().state);
    const clone = structuredClone(state);
    transition(state, review("ux", "CHANGES"));
    expect(state).toEqual(clone);
  });
});
