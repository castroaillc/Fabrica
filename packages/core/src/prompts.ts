// Agent names, per-job ports, job and rework numbering, and the agent prompts of SKILL.md "Prompts".
// Every prompt text here must match SKILL.md character for character.
import type { JobState, Reviewer } from "./job.js";

export type AgentName = "spec-writer" | "builder" | `reviewer-${Reviewer}` | "approver";

export interface JobPorts {
  builder: number;
  ux: number;
  ui: number;
}

// With n the job number ("003" → 3): builder 5100 + 10n, reviewer-ux 5101 + 10n, reviewer-ui 5102 + 10n.
export function jobPorts(jobId: string): JobPorts {
  const match = /^(\d{3})/.exec(jobId);
  if (!match?.[1]) {
    throw new Error(`Job id has no leading 3-digit number: ${jobId}`);
  }
  const n = Number.parseInt(match[1], 10);
  return { builder: 5100 + 10 * n, ux: 5101 + 10 * n, ui: 5102 + 10 * n };
}

// The next 3-digit number after the highest NNN- prefixed folder name, or "001" when there is none.
export function nextJobNumber(folderNames: readonly string[]): string {
  let highest = 0;
  for (const name of folderNames) {
    const match = /^(\d{3})-/.exec(name);
    if (match?.[1]) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return String(highest + 1).padStart(3, "0");
}

// 1 plus the highest k among rework-<k>.md names, or 1 when there are none.
export function nextReworkNumber(fileNames: readonly string[]): number {
  let highest = 0;
  for (const name of fileNames) {
    const match = /^rework-(\d+)\.md$/.exec(name);
    if (match?.[1]) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return highest + 1;
}

export function builderName(jobId: string): string {
  return `builder-${jobId}`;
}

// The <paths> sentence every agent prompt starts with.
export function pathsSentence(repo: string, job: JobState): string {
  return `Job folder: ${repo}/factory/jobs/${job.id}/. Worktree: ${job.worktree}. Branch: factory/${job.id}.`;
}

export function specWriterPrompt(repo: string, job: JobState): string {
  return `${pathsSentence(repo, job)} Feature: ${job.feature}`;
}

export function buildPrompt(repo: string, job: JobState): string {
  return `${pathsSentence(repo, job)} Build round 1. Port: ${jobPorts(job.id).builder}.`;
}

export function reviewerPrompt(repo: string, job: JobState, reviewer: Reviewer, round: number): string {
  const prompt = `${pathsSentence(repo, job)} Review round ${round}.`;
  const ports = jobPorts(job.id);
  if (reviewer === "ux") return `${prompt} Port: ${ports.ux}.`;
  if (reviewer === "ui") return `${prompt} Port: ${ports.ui}.`;
  return prompt;
}

export function approverPrompt(repo: string, job: JobState, round: number): string {
  return `${pathsSentence(repo, job)} Final round: ${round}.`;
}

export function resumeMessage(jobId: string, round: number): string {
  return `Round ${round} reviews are in factory/jobs/${jobId}/round-${round}/. Address every review with VERDICT: CHANGES, commit, and update build.md for round ${round + 1}.`;
}

// N is the job's last round.
export function reworkPrompt(repo: string, job: JobState, k: number): string {
  return `${pathsSentence(repo, job)} Rework: read rework-${k}.md and address it, then update build.md for round ${job.round + 1}. Port: ${jobPorts(job.id).builder}.`;
}
