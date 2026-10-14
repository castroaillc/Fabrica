// The orchestrator loop of SKILL.md as a pure state machine: transition(state, event) → { state, actions }.
// It never touches files or git. A runner executes the actions in order and reports outcomes back as events.
import { parseBuildStatus, parseDecision, parseVerdict } from "./contracts.js";
import { REVIEWERS } from "./job.js";
import type { JobState, Reviewer, Reviews } from "./job.js";
import {
  approverPrompt,
  buildPrompt,
  builderName,
  resumeMessage,
  reviewerPrompt,
  reworkPrompt,
  specWriterPrompt,
} from "./prompts.js";
import type { AgentName } from "./prompts.js";

// After round 1 the builder can be resumed at most twice, so a run has at most 3 review rounds.
export const MAX_RESUMES = 2;

export type Awaiting =
  | "worktree"
  | "spec-writer"
  | "builder"
  | "reviewers"
  | "approver"
  | "main-checkout"
  | "merge"
  | "worktree-remove"
  | "push"
  | "handoff-push"
  | "nothing";

export interface OrchestratorState {
  repo: string;
  job: JobState;
  resumes: number;
  awaiting: Awaiting;
}

export type Action =
  | { type: "writeJob"; job: JobState }
  | { type: "createWorktree"; branch: string; worktree: string }
  | { type: "spawnAgent"; agent: AgentName; name?: string; prompt: string }
  | { type: "resumeBuilder"; name: string; message: string }
  | { type: "createDir"; path: string }
  | { type: "writeFile"; path: string; content: string }
  | { type: "checkMainCheckout" }
  | { type: "merge"; branch: string; message: string }
  | { type: "abortMerge" }
  | { type: "removeWorktree"; worktree: string }
  | { type: "deleteBranch"; branch: string }
  | { type: "pushBranch"; remote: string; branch: string }
  | { type: "notify"; message: string };

export type OrchestratorEvent =
  // step tells a failed git worktree add from a failed setup command (fabrica.yaml setup).
  | ({ type: "worktreeCreated" } & ({ ok: true } | { ok: false; step: "add" | "setup"; error: string }))
  | { type: "agentDone"; agent: AgentName; content: string | null }
  | { type: "mainCheckout"; porcelain: string; branch: string }
  | ({ type: "mergeDone" } & ({ ok: true } | { ok: false; error: string; inProgress: boolean }))
  | { type: "worktreeRemoved"; ok: boolean; output: string }
  | ({ type: "pushDone" } & ({ ok: true } | { ok: false; error: string }))
  | { type: "approve" }
  | { type: "rework"; note: string; k: number };

export interface Transition {
  state: OrchestratorState;
  actions: Action[];
}

export function startJob(input: { id: string; feature: string; repo: string; push?: string }): Transition {
  const slash = input.repo.lastIndexOf("/");
  const parent = input.repo.slice(0, slash);
  const name = input.repo.slice(slash + 1);
  const job: JobState = {
    id: input.id,
    feature: input.feature,
    branch: `factory/${input.id}`,
    worktree: `${parent}/${name}-factory/${input.id}`,
    stage: "spec",
    round: 0,
    reviews: pendingReviews(),
  };
  if (input.push !== undefined) job.push = input.push;
  return {
    state: { repo: input.repo, job, resumes: 0, awaiting: "worktree" },
    actions: [
      { type: "writeJob", job },
      { type: "createWorktree", branch: job.branch, worktree: job.worktree },
    ],
  };
}

// Rebuilds a state from job.json for a later /factory approve or /factory rework.
export function stateFromJob(job: JobState, repo: string): OrchestratorState {
  return { repo, job, resumes: 0, awaiting: "nothing" };
}

export function transition(state: OrchestratorState, event: OrchestratorEvent): Transition {
  if (event.type === "approve") return onApprove(state);
  if (event.type === "rework") return onRework(state, event.note, event.k);

  switch (state.awaiting) {
    case "worktree":
      if (event.type === "worktreeCreated") {
        if (event.ok) return onWorktreeCreated(state);
        if (event.step === "setup") return needsHuman(state, "the worktree setup command failed", event.error);
        return stop(state, `worktree setup failed: ${event.error}`);
      }
      break;
    case "spec-writer":
      if (event.type === "agentDone" && event.agent === "spec-writer") return onSpec(state, event.content);
      break;
    case "builder":
      if (event.type === "agentDone" && event.agent === "builder") return buildCheck(state, event.content);
      break;
    case "reviewers":
      if (event.type === "agentDone") {
        const reviewer = reviewerOf(event.agent);
        if (reviewer) return onReview(state, reviewer, event.content);
      }
      break;
    case "approver":
      if (event.type === "agentDone" && event.agent === "approver") return onDecision(state, event.content);
      break;
    case "main-checkout":
      if (event.type === "mainCheckout") return onMainCheckout(state, event.porcelain, event.branch);
      break;
    case "merge":
      if (event.type === "mergeDone") return onMergeDone(state, event);
      break;
    case "worktree-remove":
      if (event.type === "worktreeRemoved") return onWorktreeRemoved(state, event.ok, event.output);
      break;
    case "push":
      if (event.type === "pushDone") return onPushDone(state, event);
      break;
    case "handoff-push":
      if (event.type === "pushDone") return onHandoffPushDone(state, event);
      break;
    case "nothing":
      break;
  }
  const what = event.type === "agentDone" ? `agentDone ${event.agent}` : event.type;
  throw new Error(`${state.job.id}: unexpected ${what} while awaiting ${state.awaiting}`);
}

function pendingReviews(): Reviews {
  return Object.fromEntries(REVIEWERS.map((reviewer) => [reviewer, "pending"])) as Reviews;
}

function reviewerOf(agent: AgentName): Reviewer | undefined {
  return REVIEWERS.find((reviewer) => `reviewer-${reviewer}` === agent);
}

function jobFolder(state: OrchestratorState): string {
  return `${state.repo}/factory/jobs/${state.job.id}/`;
}

function notify(state: OrchestratorState, message: string): Action {
  return { type: "notify", message: `${state.job.id}: ${message}` };
}

function withJob(state: OrchestratorState, changes: Partial<JobState>): OrchestratorState {
  return { ...state, job: { ...state.job, ...changes } };
}

// "Stop and tell the user": the stage stays as it is and job.json is not rewritten.
function stop(state: OrchestratorState, reason: string): Transition {
  return { state: { ...state, awaiting: "nothing" }, actions: [notify(state, `stopped, ${reason}`)] };
}

// SKILL.md "Needs human": quote decision.md, or build.md for BLOCKED.
// With a push remote, the branch is pushed after the handoff, so the human gets it on the remote too.
function needsHuman(state: OrchestratorState, reason: string, quote: string, before: Action[] = []): Transition {
  const next = { ...withJob(state, { stage: "needs-human" }), awaiting: "nothing" as const };
  const actions: Action[] = [
    ...before,
    { type: "writeJob", job: next.job },
    notify(next, `needs a human, ${reason}. Worktree: ${next.job.worktree}\n\n${quote}`),
  ];
  const { push } = next.job;
  if (push === undefined) return { state: next, actions };
  return {
    state: { ...next, awaiting: "handoff-push" },
    actions: [...actions, { type: "pushBranch", remote: push, branch: next.job.branch }],
  };
}

function onWorktreeCreated(state: OrchestratorState): Transition {
  return {
    state: { ...state, awaiting: "spec-writer" },
    actions: [
      { type: "spawnAgent", agent: "spec-writer", prompt: specWriterPrompt(state.repo, state.job) },
      notify(state, "worktree ready → writing spec"),
    ],
  };
}

function onSpec(state: OrchestratorState, content: string | null): Transition {
  if (content === null) return stop(state, "spec-writer finished without writing spec.md");
  const next = { ...withJob(state, { stage: "build" }), awaiting: "builder" as const };
  return {
    state: next,
    actions: [
      { type: "writeJob", job: next.job },
      { type: "spawnAgent", agent: "builder", name: builderName(next.job.id), prompt: buildPrompt(next.repo, next.job) },
      notify(next, "spec written → building"),
    ],
  };
}

// SKILL.md "Build check".
function buildCheck(state: OrchestratorState, content: string | null): Transition {
  if (content === null) return stop(state, "builder finished without writing build.md");
  switch (parseBuildStatus(content)) {
    case "READY":
      return startRound(state, state.job.round + 1);
    case "BLOCKED":
      return needsHuman(state, "the builder is BLOCKED", content);
    case null:
      return stop(state, "the first line of build.md is not STATUS: READY or STATUS: BLOCKED");
  }
}

// SKILL.md "Review round N", steps 1 and 2.
function startRound(state: OrchestratorState, round: number): Transition {
  const next = {
    ...withJob(state, { stage: "review", round, reviews: pendingReviews() }),
    awaiting: "reviewers" as const,
  };
  return {
    state: next,
    actions: [
      { type: "writeJob", job: next.job },
      { type: "createDir", path: `${jobFolder(next)}round-${round}/` },
      ...REVIEWERS.map((reviewer): Action => ({
        type: "spawnAgent",
        agent: `reviewer-${reviewer}`,
        prompt: reviewerPrompt(next.repo, next.job, reviewer, round),
      })),
      notify(next, `round ${round} → reviewing`),
    ],
  };
}

// SKILL.md "Review round N", step 3: WAIT FOR ALL.
function onReview(state: OrchestratorState, reviewer: Reviewer, content: string | null): Transition {
  if (state.job.reviews[reviewer] !== "pending") {
    throw new Error(`${state.job.id}: ${reviewer} already reported in round ${state.job.round}`);
  }
  const round = state.job.round;
  if (content === null) return stop(state, `reviewer-${reviewer} finished without writing round-${round}/review-${reviewer}.md`);
  const verdict = parseVerdict(content);
  if (verdict === null) return stop(state, `the first line of round-${round}/review-${reviewer}.md is not a verdict`);

  const next = withJob(state, { reviews: { ...state.job.reviews, [reviewer]: verdict } });
  const landed: Action[] = [
    { type: "writeJob", job: next.job },
    notify(next, `round ${round}, ${reviewer} ${verdict}`),
  ];
  if (REVIEWERS.some((r) => next.job.reviews[r] === "pending")) return { state: next, actions: landed };

  const decided = decide(next);
  return { state: decided.state, actions: [...landed, ...decided.actions] };
}

// SKILL.md "Review round N", step 4.
function decide(state: OrchestratorState): Transition {
  const { id, round, reviews } = state.job;
  const changes = REVIEWERS.filter((reviewer) => reviews[reviewer] === "CHANGES");
  if (changes.length === 0) return startApprove(state);

  const passes = REVIEWERS.filter((reviewer) => reviews[reviewer] === "PASS");
  const summary = `round ${round}, ${changes.join("/")} CHANGES${passes.length ? `, ${passes.join("/")} PASS` : ""}`;
  if (state.resumes < MAX_RESUMES) {
    const next = { ...withJob(state, { stage: "build" }), resumes: state.resumes + 1, awaiting: "builder" as const };
    return {
      state: next,
      actions: [
        { type: "writeJob", job: next.job },
        { type: "resumeBuilder", name: builderName(id), message: resumeMessage(id, round) },
        notify(next, `${summary} → resuming builder`),
      ],
    };
  }

  const decision = `ESCALATE\n\nReview rounds exhausted. Outstanding CHANGES in round-${round}/ from: ${changes.join(", ")}.\n`;
  return needsHuman(state, `${summary}, review rounds exhausted`, decision, [
    { type: "writeFile", path: `${jobFolder(state)}decision.md`, content: decision },
  ]);
}

// SKILL.md "Approve".
function startApprove(state: OrchestratorState): Transition {
  const next = { ...withJob(state, { stage: "approve" }), awaiting: "approver" as const };
  return {
    state: next,
    actions: [
      { type: "writeJob", job: next.job },
      { type: "spawnAgent", agent: "approver", prompt: approverPrompt(next.repo, next.job, next.job.round) },
      notify(next, `round ${next.job.round}, all PASS → approver`),
    ],
  };
}

function onDecision(state: OrchestratorState, content: string | null): Transition {
  if (content === null) return stop(state, "approver finished without writing decision.md");
  switch (parseDecision(content)) {
    case "APPROVE":
      return startMerge(state);
    case "ESCALATE":
      return needsHuman(state, "the approver escalated", content);
    case null:
      return stop(state, "the first line of decision.md is not APPROVE or ESCALATE");
  }
}

// SKILL.md "Merge": the main checkout must be clean (backlog.md exempt) and on main first.
// A job with a push remote pushes its branch instead and is not merged locally.
function startMerge(state: OrchestratorState): Transition {
  const { push, branch } = state.job;
  if (push !== undefined) {
    return {
      state: { ...state, awaiting: "push" },
      actions: [notify(state, `approved → pushing ${branch} to ${push}`), { type: "pushBranch", remote: push, branch }],
    };
  }
  return {
    state: { ...state, awaiting: "main-checkout" },
    actions: [notify(state, "approved → merging into main"), { type: "checkMainCheckout" }],
  };
}

function onMainCheckout(state: OrchestratorState, porcelain: string, branch: string): Transition {
  if (porcelain.trim() !== "" || branch !== "main") {
    const busy = branch !== "main" ? `on branch ${branch}` : "uncommitted changes";
    const next = { ...withJob(state, { stage: "needs-human" }), awaiting: "nothing" as const };
    return {
      state: next,
      actions: [
        { type: "writeJob", job: next.job },
        notify(next, `approved, but the main checkout is busy (${busy}). Run /factory approve ${next.job.id} once it is clean.`),
      ],
    };
  }
  return {
    state: { ...state, awaiting: "merge" },
    actions: [{ type: "merge", branch: state.job.branch, message: `Merge factory/${state.job.id}` }],
  };
}

function onMergeDone(
  state: OrchestratorState,
  result: { ok: true } | { ok: false; error: string; inProgress: boolean },
): Transition {
  if (result.ok) {
    return {
      state: { ...state, awaiting: "worktree-remove" },
      actions: [{ type: "removeWorktree", worktree: state.job.worktree }],
    };
  }
  const next = { ...withJob(state, { stage: "needs-human" }), awaiting: "nothing" as const };
  return {
    state: next,
    actions: [
      ...(result.inProgress ? [{ type: "abortMerge" } as const] : []),
      { type: "writeJob", job: next.job },
      notify(next, `needs a human, merge failed: ${result.error}`),
    ],
  };
}

function onWorktreeRemoved(state: OrchestratorState, ok: boolean, output: string): Transition {
  const next = { ...withJob(state, { stage: "merged" }), awaiting: "nothing" as const };
  if (ok) {
    return {
      state: next,
      actions: [
        { type: "deleteBranch", branch: next.job.branch },
        { type: "writeJob", job: next.job },
        notify(next, "merged into main"),
      ],
    };
  }
  return {
    state: next,
    actions: [
      { type: "writeJob", job: next.job },
      notify(next, `merged into main, but git worktree remove failed: ${output}`),
    ],
  };
}

// An approved job's push: pushed is terminal, and the worktree and local branch are kept.
function onPushDone(state: OrchestratorState, result: { ok: true } | { ok: false; error: string }): Transition {
  if (result.ok) {
    const next = { ...withJob(state, { stage: "pushed" }), awaiting: "nothing" as const };
    return {
      state: next,
      actions: [{ type: "writeJob", job: next.job }, notify(next, `pushed ${next.job.branch} to ${next.job.push}`)],
    };
  }
  const next = { ...withJob(state, { stage: "needs-human" }), awaiting: "nothing" as const };
  return {
    state: next,
    actions: [{ type: "writeJob", job: next.job }, notify(next, `needs a human, push failed: ${result.error}`)],
  };
}

// The push after a needs-human handoff only notifies: the job stays in needs-human either way.
function onHandoffPushDone(state: OrchestratorState, result: { ok: true } | { ok: false; error: string }): Transition {
  const message = result.ok ? `pushed ${state.job.branch} to ${state.job.push}` : `push failed: ${result.error}`;
  return { state: { ...state, awaiting: "nothing" }, actions: [notify(state, message)] };
}

function isHandedToHuman(state: OrchestratorState): boolean {
  return state.job.stage === "needs-human" && state.awaiting === "nothing";
}

// /factory approve <job-id>.
function onApprove(state: OrchestratorState): Transition {
  if (!isHandedToHuman(state)) {
    return { state, actions: [notify(state, `/factory approve needs the job in needs-human (stage: ${state.job.stage})`)] };
  }
  return startMerge(state);
}

// /factory rework <job-id> <note>: a fresh builder with a fresh MAX_RESUMES.
function onRework(state: OrchestratorState, note: string, k: number): Transition {
  if (!isHandedToHuman(state)) {
    return { state, actions: [notify(state, `/factory rework needs the job in needs-human (stage: ${state.job.stage})`)] };
  }
  const next = { ...withJob(state, { stage: "build" }), resumes: 0, awaiting: "builder" as const };
  return {
    state: next,
    actions: [
      { type: "writeFile", path: `${jobFolder(next)}rework-${k}.md`, content: note },
      { type: "writeJob", job: next.job },
      { type: "spawnAgent", agent: "builder", name: builderName(next.job.id), prompt: reworkPrompt(next.repo, next.job, k) },
      notify(next, `rework-${k}.md → building`),
    ],
  };
}
